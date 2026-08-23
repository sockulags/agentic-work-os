import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  CatalogRunEvidence,
  HarnessEvent,
  ServerResponseBody,
  ThreadRuntimeState,
  ThreadSummary,
} from '@awos/protocol';
import { useHarness } from './useHarness';

type FakeConnectionStatus = 'connecting' | 'open' | 'closed' | 'unauthorized';

const fakeClient = vi.hoisted(() => {
  let statusListener: ((status: FakeConnectionStatus) => void) | null = null;
  let threadOpenResponse: ServerResponseBody | null = null;

  const request = vi.fn(async (request: { type: string }): Promise<ServerResponseBody> => {
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
    onPush: vi.fn(() => () => undefined),
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
      threadOpenResponse = null;
      request.mockClear();
      client.connect.mockClear();
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
});
