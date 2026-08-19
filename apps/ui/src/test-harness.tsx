import { render, type RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import type { ThreadRuntimeState } from '@awos/protocol';
import type { Harness } from '@/hooks/useHarness';
import { HarnessValueProvider } from '@/state/HarnessContext';

/**
 * Renders a panel against a stand-in harness.
 *
 * Components read the harness from context now, so rendering one in isolation means
 * supplying that context. The stub is deliberately inert — every verb is a spy and every
 * collection is empty — so a test that cares about a field has to name it in `harness`,
 * and the value it asserts on is visible in the test rather than buried in this file.
 */
export function renderWithHarness(
  ui: React.ReactElement,
  harness: Partial<Harness> = {},
): RenderResult {
  return render(<HarnessValueProvider value={stubHarness(harness)}>{ui}</HarnessValueProvider>);
}

/** A runtime state with nothing going on, for tests that need to override one field of it. */
export function idleRuntime(overrides: Partial<ThreadRuntimeState> = {}): ThreadRuntimeState {
  return {
    threadId: 't1',
    busyWith: null,
    currentTurnId: null,
    lastTurnAgent: null,
    plan: [],
    diff: null,
    pendingApprovals: [],
    agents: {
      claude: { status: 'idle', model: null },
      codex: { status: 'idle', model: null },
    },
    ...overrides,
  };
}

function stubHarness(overrides: Partial<Harness>): Harness {
  return {
    status: 'open',
    threads: [],
    activeThread: null,
    activeThreadId: null,
    transcript: { items: [], totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 } },
    runtime: null,
    availability: [],
    notice: null,
    dismissNotice: vi.fn(),
    openThread: vi.fn(),
    createThread: vi.fn(),
    deleteThread: vi.fn(),
    send: vi.fn(),
    interrupt: vi.fn(),
    resolveApproval: vi.fn(),
    setAgent: vi.fn(),
    setPermissionMode: vi.fn(),
    ...overrides,
  } as Harness;
}
