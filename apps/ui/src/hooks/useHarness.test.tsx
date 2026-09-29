import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  CatalogRunEvidence,
  HarnessEvent,
  ProjectOverview,
  ServerResponseBody,
  ServerPush,
  ThreadRuntimeState,
  ThreadSummary,
} from '@awos/protocol';
import { useHarness } from './useHarness';

type FakeConnectionStatus = 'connecting' | 'open' | 'closed' | 'unauthorized';

const fakeClient = vi.hoisted(() => {
  let statusListener: ((status: FakeConnectionStatus) => void) | null = null;
  let pushListener: ((push: ServerPush) => void) | null = null;
  let threadOpenResponse: ServerResponseBody | null = null;
  let requestHandler: ((request: { type: string; cwd?: string }) => Promise<ServerResponseBody>) | null = null;

  const request = vi.fn(async (request: { type: string; cwd?: string }): Promise<ServerResponseBody> => {
    if (requestHandler !== null) return requestHandler(request);
    if (request.type === 'thread.open') {
      return threadOpenResponse ?? { type: 'error', message: 'thread.open was not configured' };
    }
    if (request.type === 'thread.list') return { type: 'thread.list', threads: [] };
    if (request.type === 'agents.probe') return { type: 'agents.probe', agents: [] };
    if (request.type === 'workspace.get') {
      return { type: 'workspace', cwd: 'C:/repo', resolution: { status: 'none', searchedFrom: 'C:/repo' } };
    }
    if (request.type === 'workspace.role.get') {
      return {
        type: 'workspace.role',
        cwd: 'C:/repo',
        selection: { status: 'unconfigured', roleId: null, role: null },
      };
    }
    if (request.type === 'work.get') {
      return { type: 'work', threadId: 't1', item: null, error: null, retained: [] };
    }
    if (request.type === 'context.get') return { type: 'context', threadId: 't1', text: '' };
    return { type: 'ok' };
  });

  const client = {
    onStatus(listener: (status: FakeConnectionStatus) => void): () => void {
      statusListener = listener;
      listener('closed');
      return () => {
        if (statusListener === listener) statusListener = null;
      };
    },
    onPush: vi.fn((listener: (push: ServerPush) => void) => {
      pushListener = listener;
      return () => {
        if (pushListener === listener) pushListener = null;
      };
    }),
    connect: vi.fn(),
    request,
  };

  return {
    client,
    emitStatus(status: FakeConnectionStatus): void {
      statusListener?.(status);
    },
    reset(): void {
      statusListener = null;
      pushListener = null;
      threadOpenResponse = null;
      requestHandler = null;
      request.mockClear();
      client.connect.mockClear();
    },
    emitPush(push: ServerPush): void {
      pushListener?.(push);
    },
    setRequestHandler(handler: (request: { type: string; cwd?: string }) => Promise<ServerResponseBody>): void {
      requestHandler = handler;
    },
    setThreadOpenResponse(response: ServerResponseBody): void {
      threadOpenResponse = response;
    },
  };
});

vi.mock('@/lib/client', () => ({
  HarnessClient: vi.fn(() => fakeClient.client),
  resolveClientOptions: vi.fn(() => ({ host: '127.0.0.1', port: 4319, token: 'test-token' })),
}));

const thread: ThreadSummary = {
  id: 't1',
  title: 'Thread',
  cwd: 'C:/repo',
  createdAt: 1,
  updatedAt: 1,
  activeAgent: 'claude',
  nativeSessions: {},
  watermarks: { claude: 0, codex: 0, 'qwen-local': 0 },
  eventCount: 1,
  workItemId: 'w1',
  parallel: false,
};

const startedEvent = {
  id: 'event-1',
  seq: 1,
  threadId: 't1',
  agent: 'claude',
  turnId: 'turn-1',
  ts: 1_001,
  kind: 'run.started',
  runId: 'run-1',
  workItemId: 'w1',
  source: 'owner/repo#1',
  revision: 'revision-1',
  context: 'context',
  instruction: 'instruction',
} as unknown as HarnessEvent;

function runtime(run: CatalogRunEvidence): ThreadRuntimeState {
  return {
    threadId: 't1',
    busyWith: run.live ? 'claude' : null,
    busy: run.live ? ['claude'] : [],
    runStates: [run],
    recovery: [],
    lanes: {},
    currentTurnId: run.live ? 'turn-1' : null,
    lastTurnAgent: 'claude',
    plan: [],
    diff: null,
    pendingApprovals: [],
    agents: {
      claude: { status: run.live ? 'running' : 'idle', model: null },
      codex: { status: 'idle', model: null },
      'qwen-local': { status: 'idle', model: null },
    },
  };
}

function runState(state: CatalogRunEvidence['state'], live: boolean, interruptedByRestart: boolean): CatalogRunEvidence {
  return {
    runId: 'run-1',
    threadId: 't1',
    agent: 'claude',
    startedAt: 1_001,
    state,
    live,
    interruptedByRestart,
    evidenceCount: 0,
  };
}

function opened(state: ThreadRuntimeState): ServerResponseBody {
  return { type: 'thread.opened', thread, events: [startedEvent], state };
}

function openedFor(openedThread: ThreadSummary, state: ThreadRuntimeState): ServerResponseBody {
  return { type: 'thread.opened', thread: openedThread, events: [], state };
}

function gateResponse(
  agent: string = 'claude',
  threadId: string = 't1',
  allowed = true,
  tree = 'tree-1',
): ServerResponseBody {
  return {
    type: 'gate',
    threadId,
    agent,
    allowed,
    requirements: [],
    candidate: { commit: 'commit-1', tree, dirty: false },
  };
}

function gateTriggerEvent(kind: 'turn.completed' | 'lane.updated', seq: number): HarnessEvent {
  return {
    id: `event-${seq}`,
    seq,
    threadId: 't1',
    agent: 'claude',
    profileId: 'claude',
    turnId: 'turn-1',
    ts: seq,
    ...(kind === 'turn.completed'
      ? { kind, reason: 'completed', error: null, durationMs: 1 }
      : { kind, status: 'provisioned', path: 'C:/lane/claude', detail: null }),
  } as unknown as HarnessEvent;
}

describe('useHarness run runtime boundaries', () => {
  beforeEach(() => fakeClient.reset());

  test('clears a stale live overlay across reconnect until fresh thread state arrives', async () => {
    fakeClient.setThreadOpenResponse(opened(runtime(runState('running', true, false))));
    const { result } = renderHook(() => useHarness());

    await act(async () => {
      await result.current.openThread('t1');
    });
    expect(result.current.runs[0]?.state).toBe('running');

    fakeClient.setThreadOpenResponse(opened(runtime(runState('interrupted', false, true))));
    act(() => fakeClient.emitStatus('closed'));

    expect(result.current.runtime).toBeNull();
    expect(result.current.runs[0]?.state).toBe('interrupted');
    expect(result.current.runs[0]?.interruptedByRestart).toBe(true);

    act(() => fakeClient.emitStatus('open'));
    await waitFor(() => expect(result.current.runtime?.runStates[0]?.state).toBe('interrupted'));
    expect(result.current.runs[0]?.state).toBe('interrupted');
  });

  test('keeps an explicit catalog refresh ahead of push-triggered overview reads', async () => {
    let releaseCatalog!: () => void;
    let catalogStarted!: () => void;
    const catalogGate = new Promise<void>((resolve) => { releaseCatalog = resolve; });
    const catalogStartedGate = new Promise<void>((resolve) => { catalogStarted = resolve; });
    const cachedOverview = { source: { freshness: 'cached' } } as unknown as ProjectOverview;
    const refreshedOverview = { source: { freshness: 'current' } } as unknown as ProjectOverview;
    let overviewReads = 0;

    fakeClient.setRequestHandler(async (request) => {
      if (request.type === 'catalog.refresh') {
        catalogStarted();
        await catalogGate;
        return { type: 'catalog', cwd: 'C:/repo', catalog: null, error: null };
      }
      if (request.type === 'project.overview.get') {
        overviewReads += 1;
        return {
          type: 'project.overview',
          cwd: 'C:/repo',
          overview: overviewReads === 1 ? cachedOverview : refreshedOverview,
          error: null,
        };
      }
      return { type: 'ok' };
    });

    const { result } = renderHook(() => useHarness());
    await act(async () => { await result.current.openProjectOverview('C:/repo'); });
    expect(result.current.projectOverview?.overview).toBe(cachedOverview);

    let explicitRefresh!: Promise<void>;
    act(() => { explicitRefresh = result.current.refreshProjectCatalog('C:/repo'); });
    await catalogStartedGate;

    act(() => {
      fakeClient.emitPush({ type: 'state', state: runtime(runState('running', true, false)) });
      fakeClient.emitPush({ type: 'thread.updated', thread });
    });
    expect(overviewReads).toBe(1);

    act(() => releaseCatalog());
    await act(async () => { await explicitRefresh; });
    await waitFor(() => {
      expect(result.current.projectOverview?.overview).toBe(refreshedOverview);
      expect(result.current.projectOverview?.busy).toBe(false);
    });
    expect(overviewReads).toBeGreaterThanOrEqual(2);
  });

  test('normalizes a thread.updated push that arrives before thread.create returns', async () => {
    fakeClient.setRequestHandler(async (request) => {
      if (request.type === 'thread.create') {
        fakeClient.emitPush({ type: 'thread.updated', thread });
        return { type: 'thread.created', thread };
      }
      if (request.type === 'thread.open') return opened(runtime(runState('completed', false, false)));
      return { type: 'ok' };
    });

    const { result } = renderHook(() => useHarness());
    await act(async () => { await result.current.createThread('C:/repo', 'claude'); });

    expect(result.current.threads).toHaveLength(1);
    expect(result.current.threads[0]?.id).toBe(thread.id);
  });
});

describe('useHarness gate freshness', () => {
  beforeEach(() => fakeClient.reset());

  test('re-reads after a turn completes, a verify request settles, and a lane update', async () => {
    fakeClient.setThreadOpenResponse(opened(runtime(runState('completed', false, false))));
    const { result } = renderHook(() => useHarness());

    await act(async () => { await result.current.openThread('t1'); });

    let gateReads = 0;
    fakeClient.setRequestHandler(async (request) => {
      if (request.type === 'gate.get') {
        gateReads += 1;
        return gateResponse();
      }
      return { type: 'ok' };
    });

    await act(async () => { await result.current.readGate('claude'); });
    expect(gateReads).toBe(1);

    act(() => { fakeClient.emitPush({ type: 'event', event: gateTriggerEvent('turn.completed', 2) }); });
    await waitFor(() => expect(gateReads).toBe(2));

    await act(async () => { await result.current.runCheck('claude', 'npm test'); });
    expect(gateReads).toBe(3);

    act(() => { fakeClient.emitPush({ type: 'event', event: gateTriggerEvent('lane.updated', 3) }); });
    await waitFor(() => expect(gateReads).toBe(4));
  });

  test('marks a cached verdict stale when the re-read fails', async () => {
    fakeClient.setThreadOpenResponse(opened(runtime(runState('completed', false, false))));
    const { result } = renderHook(() => useHarness());

    await act(async () => { await result.current.openThread('t1'); });
    fakeClient.setRequestHandler(async (request) => {
      if (request.type === 'gate.get') return gateResponse();
      return { type: 'ok' };
    });
    await act(async () => { await result.current.readGate('claude'); });
    expect(result.current.gates.claude?.stale).toBe(false);

    fakeClient.setRequestHandler(async (request) => {
      if (request.type === 'gate.get') throw new Error('gate unavailable');
      return { type: 'ok' };
    });
    await act(async () => { await result.current.readGate('claude'); });

    expect(result.current.gates.claude?.stale).toBe(true);
  });

  test('drops a deferred gate response across an A to B to A thread reopen', async () => {
    const threadB: ThreadSummary = { ...thread, id: 't2', title: 'Thread B' };
    const stateA = { ...runtime(runState('completed', false, false)), lanes: { claude: 'C:/lane/a' } };
    const stateB = { ...runtime(runState('completed', false, false)), threadId: 't2', lanes: { claude: 'C:/lane/b' } };

    fakeClient.setThreadOpenResponse(openedFor(thread, stateA));
    const { result } = renderHook(() => useHarness());
    await act(async () => { await result.current.openThread('t1'); });

    let releaseOldGate!: (response: ServerResponseBody) => void;
    const oldGate = new Promise<ServerResponseBody>((resolve) => { releaseOldGate = resolve; });
    let gateReads = 0;
    fakeClient.setRequestHandler(async (request) => {
      if (request.type === 'thread.open') return fakeClientResponseForCurrentThread();
      if (request.type === 'gate.get') {
        gateReads += 1;
        if (gateReads === 1) return oldGate;
        if (gateReads === 2) return gateResponse('claude', 't2', false, 'tree-b');
        return gateResponse('claude', 't1', false, 'tree-a-current');
      }
      return { type: 'ok' };
    });

    function fakeClientResponseForCurrentThread(): ServerResponseBody {
      return currentThreadResponse;
    }

    let currentThreadResponse = openedFor(threadB, stateB);
    const oldRead = result.current.readGate('claude');
    await waitFor(() => expect(gateReads).toBe(1));

    await act(async () => { await result.current.openThread('t2'); });
    currentThreadResponse = openedFor(thread, stateA);
    await act(async () => { await result.current.openThread('t1'); });
    await waitFor(() => {
      expect(result.current.gates.claude?.candidate.tree).toBe('tree-a-current');
    });

    await act(async () => {
      releaseOldGate(gateResponse('claude', 't1', true, 'tree-old'));
      await oldRead;
    });

    expect(result.current.gates.claude?.candidate.tree).toBe('tree-a-current');
    expect(result.current.gates.claude?.allowed).toBe(false);
  });
});
