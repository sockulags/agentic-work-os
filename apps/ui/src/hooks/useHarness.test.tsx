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
