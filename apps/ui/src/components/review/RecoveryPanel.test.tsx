import { describe, expect, test, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  createTransitionEvaluation,
  type CandidateIdentity,
  type EvidenceItem,
  type RecoveryCycle,
  type RecoveryWorkerContext,
  type TransitionEvaluation,
} from '@awos/protocol';
import { renderWithHarness, idleRuntime } from '@/test-harness';
import type { RunView } from '@/lib/runs';
import { RecoveryPanel } from './RecoveryPanel';

const candidate: CandidateIdentity = {
  kind: 'working-tree',
  id: 'tree-current',
  revision: 'commit-current',
  digest: 'tree-current',
  pinned: true,
};

const provenance = {
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

function refusal(overrides: Record<string, unknown> = {}) {
  return {
    unmetRequirementIds: ['prototype.dashboard'],
    reason: 'The candidate differs from the pinned visual reference.',
    required: {
      kind: 'evidence' as const,
      evidence: {
        requirementIds: ['prototype.dashboard'],
        description: 'Provide a current pixel comparison for the pinned dashboard reference.',
      },
    },
    responsibleActor: 'codex' as const,
    nextAction: 'correct-candidate' as const,
    retryable: true,
    ...overrides,
  };
}

function evaluation(overrides: Record<string, unknown> = {}): TransitionEvaluation {
  return createTransitionEvaluation({
    transitionId: 'transition-visual',
    attempt: 1,
    runId: 'initial-run',
    actor: 'codex',
    sourceStepId: 'implement',
    targetStepId: 'review',
    expectationSetId: 'set-recovery',
    candidate,
    evidenceIds: ['visual-evidence'],
    facts: [{
      requirementId: 'prototype.dashboard',
      state: 'failed',
      observation: 'failed',
      evidenceIds: ['visual-evidence'],
      provenance,
      detail: 'different pixels',
      diagnostics: ['different pixels'],
    }],
    provenance: [provenance],
    enforcement: [{ requirementId: 'prototype.dashboard', enforcement: 'required', allowOverride: true }],
    timestamp: 1,
    verdict: 'retry',
    refusal: refusal(),
    override: null,
    ...overrides,
  } as Parameters<typeof createTransitionEvaluation>[0]);
}

function cycle(overrides: Partial<RecoveryCycle> = {}): RecoveryCycle {
  const latest = overrides.latestEvaluation ?? evaluation();
  return {
    cycleId: 'cycle-visual',
    head: 10,
    transitionId: latest.transitionId,
    refusalAttempt: latest.attempt,
    expectationSetId: latest.expectationSetId,
    sourceStepId: latest.sourceStepId,
    targetStepId: latest.targetStepId,
    maxRuns: 2,
    maxEvaluations: 3,
    onExhausted: 'waiting-for-human',
    status: 'waiting-human',
    correctionRuns: [],
    activeCorrection: null,
    correctionsUsed: 0,
    evaluationsUsed: 1,
    transientEvaluatorRetries: 0,
    latestEvaluation: latest,
    attempts: [latest],
    actions: [],
    waiting: null,
    escalation: null,
    cancelled: false,
    worker: { profileId: null, available: null, detail: null },
    ...overrides,
  };
}

function evidence(): EvidenceItem {
  return {
    id: 'visual-evidence',
    runId: 'correction-run',
    workItemId: 'work-1',
    threadId: 't1',
    kind: 'artifact',
    ref: { eventId: 'visual-event', url: null, label: 'visual comparison' },
    summary: 'Reference and candidate were compared.',
    state: { commit: 'commit-current', tree: 'tree-current', dirty: false },
    check: null,
    visual: {
      kind: 'pixel-diff',
      reference: {
        eventId: 'reference-event',
        artifactId: 'dashboard-reference',
        locator: 'artifact://dashboard/reference',
        revision: 'reference-revision-7',
        digest: 'reference-digest-7',
        selector: '#dashboard',
      },
      candidate: {
        eventId: 'candidate-event',
        artifactId: 'dashboard-candidate',
        locator: 'artifact://dashboard/candidate',
        revision: 'candidate-revision-2',
        digest: 'candidate-digest-2',
        selector: '#dashboard',
      },
      capture: {
        browser: 'Chromium 140',
        runtime: 'Vite',
        viewport: '1440x900',
        dpr: 1,
        fonts: 'fonts-1',
        data: 'fixture-1',
        animation: 'disabled',
        region: 'dashboard',
        selector: '#dashboard',
      },
      measurement: { comparedPixels: 1000, differentPixels: 23, equal: false, exact: true },
    },
    source: 'user',
    at: 2,
  };
}

function run(overrides: Partial<RunView> = {}): RunView {
  return {
    runId: 'correction-run',
    agent: 'codex',
    instruction: 'correct the refused candidate',
    context: '<awos-recovery-context>secret structured payload</awos-recovery-context>',
    revision: 'issue-revision-1',
    state: 'completed',
    interruptedByRestart: false,
    detail: null,
    ts: 1,
    outcome: null,
    evidence: [],
    candidates: [],
    ...overrides,
  };
}

function renderRecovery(overrides: {
  cycle?: Partial<RecoveryCycle>;
  runs?: RunView[];
  harness?: Record<string, unknown>;
} = {}) {
  const recovery = cycle(overrides.cycle);
  return renderWithHarness(<RecoveryPanel runs={overrides.runs ?? []} />, {
    activeThreadId: 't1',
    runtime: idleRuntime({ recovery: [recovery] }),
    runs: overrides.runs ?? [],
    ...overrides.harness,
  });
}

describe('RecoveryPanel', () => {
  test('shows the core visual refusal, reference/candidate identities, actor, action, and budget', () => {
    renderRecovery({ runs: [run({ evidence: [evidence()] })] });

    expect(screen.getByRole('heading', { name: 'Recovery' })).toBeTruthy();
    expect(screen.getByText('The candidate differs from the pinned visual reference.')).toBeTruthy();
    expect(screen.getByText('codex')).toBeTruthy();
    expect(screen.getByText('Correct the candidate')).toBeTruthy();
    expect(screen.getByText(/Corrections remaining/)).toBeTruthy();
    expect(screen.getByText(/dashboard-reference/)).toBeTruthy();
    expect(screen.getByText(/dashboard-candidate/)).toBeTruthy();
    expect(screen.getByText(/23 different of 1000 compared/)).toBeTruthy();
  });

  test('starts the explicitly responsible worker at the displayed core head', () => {
    const startRecovery = vi.fn();
    renderRecovery({ harness: { startRecovery } });

    fireEvent.click(screen.getByRole('button', { name: 'Start correction with codex' }));

    expect(startRecovery).toHaveBeenCalledWith({
      transitionId: 'transition-visual',
      expectedAttempt: 1,
      expectedHead: 10,
      agent: 'codex',
      cycleId: 'cycle-visual',
    });
  });

  test('shows the exact planning question and submits a typed answer action', () => {
    const applyRecoveryAction = vi.fn();
    const answerEvaluation = evaluation({
      verdict: 'waiting-for-human',
      refusal: refusal({
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
      }),
      enforcement: [{ requirementId: 'question.scope', enforcement: 'required', allowOverride: false, authority: 'user' }],
      evidenceIds: [],
      facts: [],
      provenance: [],
    });
    renderRecovery({ cycle: { latestEvaluation: answerEvaluation, attempts: [answerEvaluation] }, harness: { applyRecoveryAction } });

    expect(screen.getByText('Which user-visible scope is approved for this transition?')).toBeTruthy();
    expect(screen.getByText(/authority user/)).toBeTruthy();
    expect(screen.queryByText('Approval required')).toBeNull();
    expect(screen.queryByText('Send a message')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Provide typed answer' }));
    const input = screen.getByLabelText('Typed answer');
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: 'dashboard only' } });
    fireEvent.change(screen.getByLabelText('Human authority credential'), { target: { value: 'human-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit typed answer' }));

    expect(applyRecoveryAction).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'answer',
      cycleId: 'cycle-visual',
      expectedAttempt: 1,
      expectedHead: 10,
      questionId: 'question.scope',
      expectationItemId: 'question.scope',
      expectationSetId: 'set-recovery',
      answer: { type: 'choice', value: 'dashboard only' },
      humanCredential: 'human-secret',
    }));
  });

  test('submits recorded evidence through the typed core action with human authority', () => {
    const applyRecoveryAction = vi.fn();
    const evidenceEvaluation = evaluation({
      refusal: refusal({
        nextAction: 'provide-evidence',
        reason: 'The core requires evidence for the current candidate.',
      }),
    });
    renderRecovery({
      cycle: { latestEvaluation: evidenceEvaluation, attempts: [evidenceEvaluation] },
      runs: [run({ evidence: [evidence()] })],
      harness: { applyRecoveryAction },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Submit evidence' }));
    const checkbox = screen.getByRole('checkbox', { name: 'Evidence visual-evidence' });
    expect(checkbox).toHaveFocus();
    fireEvent.click(checkbox);
    fireEvent.change(screen.getByLabelText('Human authority credential'), { target: { value: 'human-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit evidence' }));

    expect(applyRecoveryAction).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'evidence',
      evidenceIds: ['visual-evidence'],
      humanCredential: 'human-secret',
    }));
  });

  test('requires the core-exposed transient evaluator action and human credential', () => {
    const applyRecoveryAction = vi.fn();
    const transientEvaluation = evaluation({
      verdict: 'waiting-for-human',
      refusal: refusal({
        reason: 'The evaluator is temporarily unavailable.',
        nextAction: 'escalate',
      }),
    });
    renderRecovery({
      cycle: {
        latestEvaluation: transientEvaluation,
        attempts: [transientEvaluation],
        waiting: {
          reason: 'transient-evaluator',
          required: transientEvaluation.refusal!.required,
          authority: 'user',
          detail: 'The evaluator is temporarily unavailable.',
        },
      },
      harness: { applyRecoveryAction },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry evaluator' }));
    const credential = screen.getByLabelText('Human authority credential');
    expect(credential).toHaveFocus();
    fireEvent.change(credential, { target: { value: 'human-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry evaluator' }));

    expect(applyRecoveryAction).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'retry-evaluator',
      expectedAttempt: 1,
      expectedHead: 10,
      humanCredential: 'human-secret',
    }));
  });

  test('offers an override only when the core next action is request-override', () => {
    const overrideEvaluation = evaluation({
      refusal: refusal({
        reason: 'A required check failed.',
        nextAction: 'request-override',
      }),
    });
    const applyRecoveryAction = vi.fn();
    renderRecovery({ cycle: { latestEvaluation: overrideEvaluation, attempts: [overrideEvaluation] }, harness: { applyRecoveryAction } });

    fireEvent.click(screen.getByRole('button', { name: 'Request core override' }));
    fireEvent.change(screen.getByLabelText('Authorized user id'), { target: { value: 'lucas' } });
    fireEvent.change(screen.getByLabelText('Override reason'), { target: { value: 'The core-approved exception is documented.' } });
    fireEvent.change(screen.getByLabelText('Human authority credential'), { target: { value: 'human-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit override request' }));

    expect(applyRecoveryAction).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'override',
      authorizedUserId: 'lucas',
      reason: 'The core-approved exception is documented.',
      humanCredential: 'human-secret',
    }));
  });

  test('never offers an override for an absolute blocked refusal', () => {
    const absoluteEvaluation = evaluation({
      verdict: 'blocked',
      refusal: refusal({ nextAction: 'escalate', retryable: false, reason: 'Absolute intent cannot be bypassed.' }),
      enforcement: [{ requirementId: 'prototype.dashboard', enforcement: 'absolute', allowOverride: false }],
    });
    renderRecovery({ cycle: { latestEvaluation: absoluteEvaluation, attempts: [absoluteEvaluation], status: 'blocked', escalation: { reason: 'absolute', action: 'blocked', detail: 'Absolute intent cannot be bypassed.' } } });

    expect(screen.getByText('Blocked; no human bypass is available')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request core override' })).toBeNull();
  });

  test('marks prior evidence stale in primary content and names who may replace the reference', () => {
    const staleEvaluation = evaluation({
      refusal: refusal({ reason: 'The pinned reference changed after this evidence was recorded.' }),
      facts: [{
        requirementId: 'prototype.dashboard',
        state: 'unknown',
        observation: 'stale',
        authority: 'user',
        evidenceIds: ['visual-evidence'],
        provenance: { ...provenance, validity: 'stale' },
        detail: 'The comparison passed against reference revision reference-revision-6, not the pinned reference.',
      }],
    });
    renderRecovery({ cycle: { latestEvaluation: staleEvaluation, attempts: [staleEvaluation] } });

    const notice = within(screen.getByRole('region', { name: 'Prior evidence is stale' }));
    expect(notice.getByText(/passed against reference revision reference-revision-6/)).toBeTruthy();
    expect(notice.getByText(/Only the user may pin a replacement reference/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replace reference' })).toBeTruthy();
  });

  test('keeps a repinned cycle historical and names the superseding transition', () => {
    renderRecovery({
      cycle: {
        status: 'cancelled',
        cancelled: true,
        actions: [{
          actionId: 'repin-action',
          cycleId: 'cycle-visual',
          transitionId: 'transition-visual',
          attempt: 1,
          expectedHead: 10,
          kind: 'repin',
          actor: 'user',
          authority: 'user',
          candidate: { ...candidate, id: 'replacement-candidate', revision: 'replacement-revision' },
          evidenceIds: [],
          supersededByTransitionId: 'transition-replacement',
        }],
      },
    });

    expect(screen.getByText(/Superseded by transition transition-replacement/)).toBeTruthy();
    expect(screen.getByText(/earlier cycle remains historical/)).toBeTruthy();
    expect(screen.getByText(/superseded by transition-replacement/)).toBeTruthy();
  });

  test('submits a new pinned reference as the core superseding action', () => {
    const applyRecoveryAction = vi.fn();
    renderRecovery({ harness: { applyRecoveryAction } });

    fireEvent.click(screen.getByRole('button', { name: 'Replace reference' }));
    expect(screen.getByLabelText('Replacement candidate id')).toHaveFocus();
    fireEvent.change(screen.getByLabelText('Replacement candidate id'), { target: { value: 'dashboard-replacement' } });
    fireEvent.change(screen.getByLabelText('Replacement revision'), { target: { value: 'replacement-revision' } });
    fireEvent.change(screen.getByLabelText('Human authority credential'), { target: { value: 'human-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace and re-evaluate' }));

    expect(applyRecoveryAction).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'repin',
      sourceStepId: 'implement',
      targetStepId: 'review',
      humanCredential: 'human-secret',
      candidate: expect.objectContaining({ id: 'dashboard-replacement', revision: 'replacement-revision', pinned: true }),
    }));
  });

  test('does not present an unfinished historical correction as live and requires Resume or Cancel', async () => {
    const context = {} as RecoveryWorkerContext;
    const interruptedRun = {
      runId: 'historical-correction',
      cycleId: 'cycle-visual',
      transitionId: 'transition-visual',
      refusalAttempt: 1,
      correctionIndex: 1,
      workerProfileId: 'codex' as const,
      fingerprint: { candidate, evidenceIds: ['visual-evidence'], digest: 'fingerprint-1' },
      startedAt: 1,
      state: 'interrupted' as const,
      interruptedByRestart: true,
      context,
    };
    const startRecovery = vi.fn();
    renderRecovery({
      cycle: {
        status: 'interrupted',
        correctionRuns: [interruptedRun],
        latestEvaluation: evaluation(),
        attempts: [evaluation()],
      },
      harness: { startRecovery },
    });

    expect(screen.getByText(/historical correction run is not live/)).toBeTruthy();
    expect(screen.queryByText('Correction in progress')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Resume correction with codex' }));
    expect(startRecovery).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex', cycleId: 'cycle-visual', expectedHead: 10 }));

    const cancel = screen.getByRole('button', { name: 'Cancel recovery' });
    cancel.focus();
    fireEvent.click(cancel);
    expect(screen.getByLabelText('Cancellation reason')).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(cancel).toHaveFocus());
  });

  test('names the structured recovery context on an active correction without copying its payload', () => {
    const context = { schema: 'awos.recovery.v1' } as RecoveryWorkerContext;
    const activeCorrection = {
      runId: 'active-correction',
      cycleId: 'cycle-visual',
      transitionId: 'transition-visual',
      refusalAttempt: 1,
      correctionIndex: 1,
      workerProfileId: 'codex' as const,
      fingerprint: { candidate, evidenceIds: ['visual-evidence'], digest: 'fingerprint-1' },
      startedAt: 1,
      state: 'running' as const,
      interruptedByRestart: false,
      context,
    };
    renderRecovery({ cycle: { status: 'correcting', correctionRuns: [activeCorrection], activeCorrection } });

    expect(screen.getByText(/Structured recovery context delivered to codex/)).toBeTruthy();
    expect(screen.getByText(/schema awos\.recovery\.v1/)).toBeTruthy();
    expect(screen.queryByText('secret structured payload')).toBeNull();
  });

  test('renders exact human versus blocked escalation actions for unchanged and exhausted cycles', () => {
    const unchanged = cycle({
      cycleId: 'cycle-unchanged',
      escalation: { reason: 'unchanged-candidate', action: 'waiting-for-human', detail: 'The candidate fingerprint did not change.' },
      status: 'waiting-human',
    });
    const exhausted = cycle({
      cycleId: 'cycle-exhausted',
      escalation: { reason: 'exhausted', action: 'blocked', detail: 'The bounded correction budget is exhausted.' },
      status: 'blocked',
    });
    renderWithHarness(<RecoveryPanel cycles={[unchanged, exhausted]} />, {
      activeThreadId: 't1',
      runtime: idleRuntime(),
      runs: [],
    });

    expect(screen.getByText('Wait for the human action named by the core')).toBeTruthy();
    expect(screen.getByText('Blocked; no human bypass is available')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Start correction/ })).toBeNull();
    expect(screen.getAllByText('The candidate fingerprint did not change.').length).toBeGreaterThan(0);
    expect(screen.getAllByText('The bounded correction budget is exhausted.').length).toBeGreaterThan(0);
  });

  test('carries every cycle status as a text label rather than colour alone', () => {
    const statuses: { status: RecoveryCycle['status']; label: string }[] = [
      { status: 'correcting', label: 'Correction in progress' },
      { status: 'waiting-human', label: 'Waiting for human action' },
      { status: 'worker-unavailable', label: 'Worker unavailable' },
      { status: 'interrupted', label: 'Interrupted after restart' },
      { status: 'exhausted', label: 'Correction budget exhausted' },
      { status: 'blocked', label: 'Blocked' },
      { status: 'passed', label: 'Passed' },
      { status: 'cancelled', label: 'Cancelled' },
    ];
    renderWithHarness(
      <RecoveryPanel cycles={statuses.map((entry, index) => cycle({ cycleId: `cycle-${index}`, status: entry.status }))} />,
      { activeThreadId: 't1', runtime: idleRuntime(), runs: [] },
    );

    for (const entry of statuses) {
      expect(screen.getByRole('status', { name: entry.label })).toBeTruthy();
    }
  });

  test('keeps the full recovery record behind progressive disclosure without duplicating worker payload', () => {
    renderRecovery({ runs: [run({ evidence: [evidence()] })] });

    expect(screen.queryByText('secret structured payload')).toBeNull();
    fireEvent.click(screen.getByText('Inspect ids, attempts, facts, provenance, and actions'));

    expect(screen.getByText('expectation set')).toBeTruthy();
    expect(screen.getAllByText(/visual-evaluator@2026.08/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/different pixels/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/provenance candidate/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/override none/).length).toBeGreaterThan(0);
  });
});
