import { useMemo, useState } from 'react';
import {
  createTransitionEvaluation,
  type AgentId,
  type CandidateIdentity,
  type EvidenceItem,
  type RecoveryActionRequest,
  type RecoveryCorrectionRun,
  type RecoveryCycle,
  type RecoveryWorkerContext,
  type ThreadRuntimeState,
  type ThreadSummary,
  type TransitionEvaluation,
  type TransitionRefusal,
  type WorkItem,
} from '@awos/protocol';
import type { Harness, WorkView } from '@/hooks/useHarness';
import { HarnessValueProvider } from '@/state/HarnessContext';
import { WorkPanel } from '@/components/dock/tabs/WorkPanel';
import type { RunView } from '@/lib/runs';
import { cn } from '@/lib/utils';

const THREAD_ID = 'recovery-fixture-thread';
const FIXTURE_TIME = 1_756_000_000_000;

const FIXTURE_STATES = [
  'visual',
  'planning-answer',
  'override',
  'absolute-blocked',
  'stale-repin',
  'restart-interrupted',
  'active-worker',
  'worker-unavailable',
  'unchanged',
  'exhausted',
  'passed',
] as const;

type FixtureState = (typeof FIXTURE_STATES)[number];

const STATE_LABELS: Record<FixtureState, string> = {
  visual: 'Visual refusal',
  'planning-answer': 'Planning answer',
  override: 'Legal override',
  'absolute-blocked': 'Absolute blocked',
  'stale-repin': 'Stale and superseded',
  'restart-interrupted': 'Restarted recovery',
  'active-worker': 'Active worker',
  'worker-unavailable': 'Worker unavailable',
  unchanged: 'Unchanged candidate',
  exhausted: 'Exhausted budget',
  passed: 'Passed',
};

const candidate: CandidateIdentity = {
  kind: 'working-tree',
  id: 'dashboard-candidate',
  revision: 'candidate-revision-2',
  digest: 'candidate-digest-2',
  pinned: true,
};

const visualReference = {
  eventId: 'reference-event',
  artifactId: 'dashboard-reference',
  locator: 'artifact://dashboard/reference',
  revision: 'reference-revision-7',
  digest: 'reference-digest-7',
  selector: '#dashboard',
};

const visualCandidate = {
  eventId: 'candidate-event',
  artifactId: 'dashboard-candidate',
  locator: 'artifact://dashboard/candidate',
  revision: 'candidate-revision-2',
  digest: 'candidate-digest-2',
  selector: '#dashboard',
};

const visualEvidence: EvidenceItem = {
  id: 'visual-evidence',
  runId: 'correction-run',
  workItemId: 'fixture-work-item',
  threadId: THREAD_ID,
  kind: 'artifact',
  ref: { eventId: 'visual-event', url: null, label: 'visual comparison' },
  summary: 'Reference and candidate were compared.',
  state: { commit: 'candidate-revision-2', tree: 'dashboard-candidate', dirty: false },
  check: null,
  visual: {
    kind: 'pixel-diff',
    reference: visualReference,
    candidate: visualCandidate,
    capture: {
      browser: 'Chromium 140',
      runtime: 'Vite',
      viewport: '1440x900',
      dpr: 1,
      fonts: 'fixture-fonts',
      data: 'fixture-data',
      animation: 'disabled',
      region: 'dashboard',
      selector: '#dashboard',
    },
    measurement: { comparedPixels: 1000, differentPixels: 23, equal: false, exact: true },
  },
  source: 'user',
  at: FIXTURE_TIME,
};

const visualProvenance = {
  evaluatorId: 'visual-evaluator',
  evaluatorVersion: '2026.08',
  evaluatorKind: 'pixel-diff',
  evaluatorClass: 'pixel' as const,
  expectationSetId: 'set-recovery',
  candidate,
  evidenceIds: ['visual-evidence'],
  validity: 'current' as const,
  detail: 'reference and candidate were compared',
};

const visualRefusal: TransitionRefusal = {
  unmetRequirementIds: ['prototype.dashboard'],
  reason: 'The candidate differs from the pinned visual reference.',
  required: {
    kind: 'evidence',
    evidence: {
      requirementIds: ['prototype.dashboard'],
      description: 'Provide a current pixel comparison for the pinned dashboard reference.',
    },
  },
  responsibleActor: 'codex',
  nextAction: 'correct-candidate',
  retryable: true,
};

const planningRefusal: TransitionRefusal = {
  unmetRequirementIds: ['question.scope'],
  reason: 'A planning answer is missing.',
  required: {
    kind: 'structured-answer',
    answer: {
      questionId: 'question.scope',
      description: 'Which user-visible scope is approved for this transition?',
      schema: 'choice',
    },
  },
  responsibleActor: 'user',
  nextAction: 'provide-answer',
  retryable: false,
};

const overrideRefusal: TransitionRefusal = {
  ...visualRefusal,
  reason: 'A required check failed, and the core permits an explicit override.',
  nextAction: 'request-override',
};

const absoluteRefusal: TransitionRefusal = {
  ...visualRefusal,
  reason: 'Absolute intent cannot be bypassed.',
  nextAction: 'escalate',
  retryable: false,
};

function makeEvaluation({
  transitionId = 'transition-visual',
  attempt = 1,
  runId = 'initial-run',
  verdict = 'retry',
  refusal = visualRefusal,
  evidenceIds = ['visual-evidence'],
  facts = [
    {
      requirementId: 'prototype.dashboard',
      state: 'failed' as const,
      observation: 'failed' as const,
      evidenceIds: ['visual-evidence'],
      provenance: visualProvenance,
      detail: 'different pixels',
      diagnostics: ['different pixels'],
    },
  ],
}: {
  transitionId?: string;
  attempt?: number;
  runId?: string | null;
  verdict?: 'retry' | 'waiting-for-human' | 'blocked' | 'failed';
  refusal?: TransitionRefusal;
  evidenceIds?: string[];
  facts?: readonly unknown[];
}): TransitionEvaluation {
  return createTransitionEvaluation({
    transitionId,
    attempt,
    runId,
    actor: refusal.responsibleActor === 'user' ? 'user' : refusal.responsibleActor,
    sourceStepId: 'implement',
    targetStepId: 'review',
    expectationSetId: 'set-recovery',
    candidate,
    evidenceIds,
    facts,
    provenance: facts.length === 0 ? [] : [visualProvenance],
    enforcement: [{
      requirementId: refusal.unmetRequirementIds[0] ?? 'prototype.dashboard',
      enforcement: 'required',
      allowOverride: refusal.nextAction === 'request-override',
      ...(refusal.required.kind === 'structured-answer' ? { authority: 'user' as const } : {}),
    }],
    timestamp: FIXTURE_TIME,
    verdict,
    refusal,
    override: null,
  } as Parameters<typeof createTransitionEvaluation>[0]);
}

function makePassedEvaluation(): TransitionEvaluation {
  return createTransitionEvaluation({
    transitionId: 'transition-passed',
    attempt: 2,
    runId: 'verification-run',
    actor: 'codex',
    sourceStepId: 'implement',
    targetStepId: 'review',
    expectationSetId: 'set-recovery',
    candidate,
    evidenceIds: ['visual-evidence'],
    facts: [{
      requirementId: 'prototype.dashboard',
      state: 'satisfied',
      observation: 'satisfied',
      evidenceIds: ['visual-evidence'],
      provenance: visualProvenance,
      detail: 'reference and candidate match',
    }],
    provenance: [visualProvenance],
    enforcement: [{ requirementId: 'prototype.dashboard', enforcement: 'required', allowOverride: true }],
    timestamp: FIXTURE_TIME + 1,
    verdict: 'passed',
    refusal: null,
    override: null,
  });
}

function makeWorkerContext(evaluation: TransitionEvaluation, refusal: TransitionRefusal): RecoveryWorkerContext {
  return {
    schema: 'awos.recovery.v1',
    cycleId: 'cycle-recovery',
    transitionId: evaluation.transitionId,
    refusalAttempt: evaluation.attempt,
    correctionIndex: 1,
    sourceStepId: evaluation.sourceStepId,
    targetStepId: evaluation.targetStepId,
    expectationSetId: evaluation.expectationSetId,
    fingerprint: { candidate, evidenceIds: ['visual-evidence'], digest: 'fingerprint-1' },
    blocker: refusal,
    evaluation,
    attempts: [evaluation],
    actions: [],
  };
}

function makeRun(evidence: EvidenceItem[] = []): RunView {
  return {
    runId: 'correction-run',
    agent: 'codex',
    instruction: 'Correct the refused candidate using the structured recovery context.',
    context: '<awos-recovery-context>fixture payload retained on the run</awos-recovery-context>',
    revision: 'issue-revision-60',
    state: 'completed',
    interruptedByRestart: false,
    detail: null,
    ts: FIXTURE_TIME,
    outcome: null,
    evidence,
    candidates: [],
  };
}

function makeCycle(state: FixtureState): { cycle: RecoveryCycle; runs: RunView[] } {
  const visual = makeEvaluation({});
  let latest = visual;
  let status: RecoveryCycle['status'] = 'waiting-human';
  let escalation: RecoveryCycle['escalation'] = null;
  let waiting: RecoveryCycle['waiting'] = null;
  let correctionRuns: RecoveryCorrectionRun[] = [];
  let activeCorrection: RecoveryCorrectionRun | null = null;
  let actions: RecoveryCycle['actions'] = [];
  let cycleId = 'cycle-recovery';
  let transitionId = visual.transitionId;
  let runs = state === 'visual' || state === 'active-worker' || state === 'restart-interrupted'
    ? [makeRun([visualEvidence])]
    : [];

  switch (state) {
    case 'planning-answer':
      latest = makeEvaluation({
        transitionId: 'transition-planning',
        verdict: 'waiting-for-human',
        refusal: planningRefusal,
        evidenceIds: [],
        facts: [],
      });
      waiting = {
        reason: 'human-action',
        required: planningRefusal.required,
        authority: 'user',
        detail: planningRefusal.reason,
      };
      break;
    case 'override':
      latest = makeEvaluation({
        transitionId: 'transition-override',
        refusal: overrideRefusal,
      });
      break;
    case 'absolute-blocked':
      latest = makeEvaluation({
        transitionId: 'transition-absolute',
        verdict: 'blocked',
        refusal: absoluteRefusal,
      });
      status = 'blocked';
      escalation = { reason: 'absolute', action: 'blocked', detail: absoluteRefusal.reason };
      break;
    case 'stale-repin':
      cycleId = 'cycle-stale';
      latest = makeEvaluation({
        transitionId: 'transition-stale',
        facts: [{
          requirementId: 'prototype.dashboard',
          state: 'unknown' as const,
          observation: 'stale' as const,
          authority: 'user' as const,
          evidenceIds: ['visual-evidence'],
          provenance: { ...visualProvenance, validity: 'stale' as const },
          detail: 'The comparison passed against reference revision reference-revision-6, not the pinned reference.',
        }],
      });
      transitionId = latest.transitionId;
      status = 'cancelled';
      actions = [{
        actionId: 'repin-action',
        cycleId,
        transitionId,
        attempt: latest.attempt,
        expectedHead: 10,
        kind: 'repin',
        actor: 'user',
        authority: 'user',
        candidate: { ...candidate, id: 'dashboard-replacement', revision: 'replacement-revision' },
        evidenceIds: [],
        supersededByTransitionId: 'transition-replacement',
      }];
      break;
    case 'restart-interrupted': {
      const context = makeWorkerContext(visual, visualRefusal);
      const interruptedRun: RecoveryCorrectionRun = {
        runId: 'historical-correction',
        cycleId,
        transitionId,
        refusalAttempt: visual.attempt,
        correctionIndex: 1,
        workerProfileId: 'codex',
        fingerprint: context.fingerprint,
        startedAt: FIXTURE_TIME,
        state: 'interrupted',
        interruptedByRestart: true,
        context,
      };
      correctionRuns = [interruptedRun];
      status = 'interrupted';
      break;
    }
    case 'active-worker': {
      const context = makeWorkerContext(visual, visualRefusal);
      const running: RecoveryCorrectionRun = {
        runId: 'active-correction',
        cycleId,
        transitionId,
        refusalAttempt: visual.attempt,
        correctionIndex: 1,
        workerProfileId: 'codex',
        fingerprint: context.fingerprint,
        startedAt: FIXTURE_TIME,
        state: 'running',
        interruptedByRestart: false,
        context,
      };
      correctionRuns = [running];
      activeCorrection = running;
      status = 'correcting';
      runs = [makeRun([visualEvidence])];
      break;
    }
    case 'worker-unavailable':
      status = 'worker-unavailable';
      waiting = {
        reason: 'worker-unavailable',
        required: visualRefusal.required,
        authority: 'user',
        detail: 'The responsible correction worker is unavailable.',
      };
      break;
    case 'unchanged':
      status = 'waiting-human';
      escalation = {
        reason: 'unchanged-candidate',
        action: 'waiting-for-human',
        detail: 'The candidate fingerprint did not change.',
      };
      break;
    case 'exhausted':
      status = 'blocked';
      escalation = {
        reason: 'exhausted',
        action: 'blocked',
        detail: 'The bounded correction budget is exhausted.',
      };
      break;
    case 'passed':
      latest = makePassedEvaluation();
      status = 'passed';
      transitionId = latest.transitionId;
      runs = [makeRun([visualEvidence])];
      break;
    case 'visual':
      break;
  }

  return {
    cycle: {
      cycleId,
      head: 10,
      transitionId,
      refusalAttempt: latest.attempt,
      expectationSetId: latest.expectationSetId,
      sourceStepId: latest.sourceStepId,
      targetStepId: latest.targetStepId,
      maxRuns: 2,
      maxEvaluations: 3,
      onExhausted: 'waiting-for-human',
      status,
      correctionRuns,
      activeCorrection,
      correctionsUsed: correctionRuns.length,
      evaluationsUsed: latest.verdict === 'passed' ? 2 : 1,
      transientEvaluatorRetries: 0,
      latestEvaluation: latest,
      attempts: [latest],
      actions,
      waiting,
      escalation,
      cancelled: status === 'cancelled',
      worker: {
        profileId: state === 'worker-unavailable' ? null : 'codex',
        available: state === 'worker-unavailable' ? false : true,
        detail: state === 'worker-unavailable' ? 'No codex worker is available.' : null,
      },
    },
    runs,
  };
}

const fixtureThread: ThreadSummary = {
  id: THREAD_ID,
  title: 'Recovery fixture',
  cwd: 'C:/Users/lucas/Code/agentic-work-os',
  createdAt: FIXTURE_TIME,
  updatedAt: FIXTURE_TIME,
  activeAgent: 'codex',
  nativeSessions: {},
  watermarks: { claude: 0, codex: 0, 'qwen-local': 0 },
  eventCount: 0,
  workItemId: 'fixture-work-item',
  parallel: false,
};

const fixtureWorkItem: WorkItem = {
  id: 'fixture-work-item',
  workspaceRoot: 'C:/Users/lucas/Code/agentic-work-os',
  source: {
    repo: 'example/agentic-work-os',
    number: 60,
    url: 'https://github.com/example/agentic-work-os/issues/60',
  },
  snapshot: {
    title: 'Guardrail recovery review surface',
    body: 'Fixture for the core-owned recovery states and typed actions.',
    state: 'open',
    labels: ['recovery', 'fixture'],
    author: 'fixture',
    revision: 'issue-revision-60',
  },
  attachedAt: FIXTURE_TIME,
  fetchedAt: FIXTURE_TIME,
  lastRefreshedAt: FIXTURE_TIME,
};

function makeRuntime(cycle: RecoveryCycle): ThreadRuntimeState {
  return {
    threadId: THREAD_ID,
    busyWith: null,
    busy: [],
    runStates: [],
    recovery: [cycle],
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
  };
}

function makeHarness(state: FixtureState, recordAction: (message: string) => void): Harness {
  const { cycle, runs } = makeCycle(state);
  const work: WorkView = {
    threadId: THREAD_ID,
    item: fixtureWorkItem,
    error: null,
    retained: [],
    busy: false,
  };
  return {
    status: 'open',
    threads: [fixtureThread],
    activeThread: fixtureThread,
    activeThreadId: THREAD_ID,
    transcript: { items: [], totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 } },
    artifacts: [],
    runtime: makeRuntime(cycle),
    availability: [],
    notice: null,
    dismissNotice: () => undefined,
    openThread: async () => undefined,
    createThread: async () => undefined,
    deleteThread: async () => undefined,
    send: async () => undefined,
    interrupt: async () => undefined,
    resolveApproval: async () => undefined,
    setAgent: async () => undefined,
    setThreadAgent: async () => undefined,
    setPermissionMode: async () => undefined,
    setParallel: async () => undefined,
    integrateLane: async () => undefined,
    pinnedContext: null,
    editPinnedContext: async () => undefined,
    workspace: null,
    refreshWorkspace: async () => undefined,
    roleSelection: null,
    roleSelectionSave: 'saved',
    roleSelectionError: null,
    setWorkspaceRole: async () => undefined,
    work,
    runs,
    attachWorkItem: async () => undefined,
    refreshWorkItem: async () => undefined,
    detachWorkItem: async () => undefined,
    startRun: async () => undefined,
    closeRun: async () => undefined,
    gates: {},
    readGate: async () => undefined,
    runCheck: async () => undefined,
    recordEvidence: async () => undefined,
    retainContext: async () => undefined,
    amendRetained: async () => undefined,
    startRecovery: async (input: { agent: AgentId }) => {
      recordAction(`Start correction with ${input.agent}`);
    },
    applyRecoveryAction: async (action: RecoveryActionRequest) => {
      recordAction(`Submit ${action.kind} action`);
    },
    projectOverview: null,
    openProjectOverview: async () => undefined,
    closeProjectOverview: () => undefined,
    refreshProjectOverview: async () => undefined,
    refreshProjectCatalog: async () => undefined,
    setProjectOverviewRole: async () => undefined,
    openIssue: async () => undefined,
    openProjectIssueDetail: async () => undefined,
  } as unknown as Harness;
}

function fixtureState(value: string | null): FixtureState {
  return FIXTURE_STATES.includes(value as FixtureState) ? value as FixtureState : 'visual';
}

export function RecoveryFixture(): React.JSX.Element {
  const [state, setState] = useState<FixtureState>(() => fixtureState(new URLSearchParams(window.location.search).get('state')));
  const [lastAction, setLastAction] = useState<string | null>(null);
  const harness = useMemo(() => makeHarness(state, setLastAction), [state]);

  return (
    <HarnessValueProvider value={harness}>
      <div className="flex h-full min-w-0 flex-col bg-surface-canvas text-foreground">
        <header className="shrink-0 border-b border-border bg-surface-raised px-4 py-3">
          <div className="mx-auto min-w-0 max-w-3xl space-y-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Browser fixture</p>
            <h1 className="text-base font-semibold">Core recovery states</h1>
            <p className="max-w-2xl text-xs text-muted-foreground">
              Deterministic views over the same Work and review surface. Each action is sent to the fixture harness; the live product sends it to core.
            </p>
            <nav aria-label="Recovery fixture states" className="awos-scroll min-w-0 overflow-x-auto pb-1">
              <div className="flex min-w-max gap-1.5">
                {FIXTURE_STATES.map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={state === option}
                    onClick={() => {
                      setState(option);
                      setLastAction(null);
                    }}
                    className={cn(
                      'awos-focus-ring shrink-0 rounded-md border px-2 py-1 text-[10px] transition-colors',
                      state === option ? 'border-state-busy-border bg-state-busy-surface text-state-busy' : 'border-input text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    {STATE_LABELS[option]}
                  </button>
                ))}
              </div>
            </nav>
            {lastAction && (
              <p role="status" aria-live="polite" className="text-[10px] text-muted-foreground">
                Fixture request: {lastAction}
              </p>
            )}
          </div>
        </header>
        <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className="mx-auto h-full min-w-0 max-w-3xl">
            <WorkPanel />
          </div>
        </main>
      </div>
    </HarnessValueProvider>
  );
}
