import { render, type RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import type { ThreadRuntimeState } from '@awos/protocol';
import type { Harness } from '@/hooks/useHarness';
import { HarnessValueProvider } from '@/state/HarnessContext';
import { DisplaySettingsProvider } from '@/state/DisplaySettingsContext';

/**
 * Renders a panel against a stand-in harness.
 *
 * Components read the harness from context now, so rendering one in isolation means
 * supplying that context. Display settings come along too, because blocks nested inside
 * the transcript read density, and a test should not have to know which ones do.
 *
 * The stub is deliberately inert — every verb is a spy and every collection is empty — so
 * a test that cares about a field has to name it in `harness`, and the value it asserts on
 * is visible in the test rather than buried in this file.
 */
export function renderWithHarness(
  ui: React.ReactElement,
  harness: Partial<Harness> = {},
): RenderResult {
  const value = stubHarness(harness);
  function TestProviders({ children }: { children: React.ReactNode }): React.JSX.Element {
    return (
      <HarnessValueProvider value={value}>
        <DisplaySettingsProvider>{children}</DisplaySettingsProvider>
      </HarnessValueProvider>
    );
  }

  return render(ui, { wrapper: TestProviders });
}

/**
 * Renders a component that reads display settings but not the harness.
 *
 * Kept separate from `renderWithHarness` so a test does not imply a dependency the
 * component does not have — `ToolBlock` takes its item as a prop and only reaches out
 * for density.
 */
export function renderWithDisplaySettings(ui: React.ReactElement): RenderResult {
  return render(<DisplaySettingsProvider>{ui}</DisplaySettingsProvider>);
}

/** A runtime state with nothing going on, for tests that need to override one field of it. */
export function idleRuntime(overrides: Partial<ThreadRuntimeState> = {}): ThreadRuntimeState {
  return {
    threadId: 't1',
    busyWith: null,
    busy: [],
    runStates: [],
    recovery: [],
    lanes: {},
    currentTurnId: null,
    lastTurnAgent: null,
    plan: [],
    diff: null,
    pendingApprovals: [],
    agents: {
      claude: { status: 'idle', model: null },
      codex: { status: 'idle', model: null },
      'qwen-local': { status: 'idle', model: null },
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
    setThreadAgent: vi.fn(),
    setPermissionMode: vi.fn(),
    setParallel: vi.fn(),
    integrateLane: vi.fn(),
    workspace: null,
    refreshWorkspace: vi.fn(),
    roleSelection: null,
    roleSelectionSave: 'saved',
    roleSelectionError: null,
    setWorkspaceRole: vi.fn(),
    work: null,
    runs: [],
    attachWorkItem: vi.fn(),
    refreshWorkItem: vi.fn(),
    detachWorkItem: vi.fn(),
    startRun: vi.fn(),
    closeRun: vi.fn(),
    gates: {},
    readGate: vi.fn(),
    runCheck: vi.fn(),
    recordEvidence: vi.fn(),
    retainContext: vi.fn(),
    amendRetained: vi.fn(),
    projectOverview: null,
    openProjectOverview: vi.fn(),
    closeProjectOverview: vi.fn(),
    refreshProjectOverview: vi.fn(),
    refreshProjectCatalog: vi.fn(),
    setProjectOverviewRole: vi.fn(),
    openIssue: vi.fn(),
    openProjectIssueDetail: vi.fn(),
    ...overrides,
  } as Harness;
}
