import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createExpectationSet,
  createTransitionEvaluation,
  type CandidateIdentity,
  type HarnessEvent,
  type RecoveryWorkerContext,
  type TransitionEvaluation,
} from '@awos/protocol';
import {
  buildRecoveryWorkerContext,
  foldRecoveryCycles,
  hasValidHumanRecoveryAction,
  recoveryWorkerPrompt,
  serializeRecoveryContext,
  transitionFingerprint,
} from './recovery.js';
import { ThreadStore } from '../store/thread-store.js';

const candidate: CandidateIdentity = {
  kind: 'working-tree',
  id: 'tree-1',
  revision: 'commit-1',
  digest: 'tree-1',
  pinned: true,
};

const expectationSet = createExpectationSet({
  expectationSetId: 'set-recovery',
  manifestDigest: 'manifest-recovery',
  items: [{
    id: 'prototype.dashboard',
    kind: 'prototype',
    name: 'Dashboard prototype',
    enforcement: 'required',
    allowOverride: true,
    reference: {
      sourceKind: 'repository-file',
      locator: 'identity://prototype.dashboard',
      nativeRevision: 'source-1',
      contentDigest: 'source-digest-1',
      selector: null,
    },
  }],
  authority: { sourceOwner: 'project', pinnedBy: 'user' },
  scope: { workItemId: 'work-1', sourceStepId: 'implement', targetStepId: 'review' },
  supersedes: null,
});

const provenance = {
  evaluatorId: 'visual-evaluator',
  evaluatorVersion: '2026.08',
  evaluatorKind: 'pixel-diff',
  evaluatorClass: 'pixel' as const,
  expectationSetId: expectationSet.expectationSetId,
  candidate,
  evidenceIds: ['visual-evidence-1'],
  validity: 'current' as const,
  detail: 'pixel comparison complete',
};

function refusal(reason = 'The candidate differs from the pinned visual reference.') {
  return {
    unmetRequirementIds: ['prototype.dashboard'],
    reason,
    required: {
      kind: 'evidence' as const,
      evidence: {
        requirementIds: ['prototype.dashboard'],
        description: 'Provide a current pixel comparison for retrieval visual-evidence-1.',
      },
    },
    responsibleActor: 'codex' as const,
    nextAction: 'correct-candidate' as const,
    retryable: true,
  };
}

function evaluation(overrides: Partial<TransitionEvaluation> = {}): TransitionEvaluation {
  return createTransitionEvaluation({
    transitionId: 'transition-1',
    attempt: 1,
    runId: 'initial-run',
    actor: 'codex',
    sourceStepId: 'implement',
    targetStepId: 'review',
    expectationSetId: expectationSet.expectationSetId,
    candidate,
    evidenceIds: ['visual-evidence-1'],
    facts: [{
      requirementId: 'prototype.dashboard',
      state: 'failed',
      observation: 'failed',
      evidenceIds: ['visual-evidence-1'],
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

let sequence = 0;
function event(body: Record<string, unknown>, agent: HarnessEvent['agent'] = null): HarnessEvent {
  sequence += 1;
  return {
    id: `event-${sequence}`,
    seq: sequence,
    threadId: 'thread-recovery',
    agent,
    turnId: null,
    ts: 1_000 + sequence,
    ...body,
  } as HarnessEvent;
}

function cycleStarted(initial: TransitionEvaluation = evaluation(), maxRuns = 2): HarnessEvent {
  return event({
    kind: 'recovery.cycle.started',
    cycleId: 'cycle-1',
    transitionId: initial.transitionId,
    refusalAttempt: initial.attempt,
    expectationSetId: initial.expectationSetId,
    sourceStepId: initial.sourceStepId,
    targetStepId: initial.targetStepId,
    maxRuns,
    maxEvaluations: maxRuns + 1,
    onExhausted: 'waiting-for-human',
    guardrailIds: ['visual-guardrail'],
    initialFingerprint: transitionFingerprint(initial),
  });
}

function correctionContext(): RecoveryWorkerContext {
  const initial = evaluation();
  return buildRecoveryWorkerContext({
    cycleId: 'cycle-1',
    correctionIndex: 1,
    refusalAttempt: initial.attempt,
    evaluation: initial,
    attempts: [initial],
    actions: [],
    fingerprint: transitionFingerprint(initial),
  });
}

describe('recovery projection', () => {
  test('keeps the full structured blocker, evaluator provenance, retrieval ids, and active run link', () => {
    const initial = evaluation();
    const context = correctionContext();
    const events = [
      event({ kind: 'transition.evaluated', evaluation: initial }),
      cycleStarted(initial),
      event({
        kind: 'recovery.correction.started',
        cycleId: 'cycle-1',
        transitionId: initial.transitionId,
        refusalAttempt: initial.attempt,
        correctionIndex: 1,
        runId: 'correction-run-1',
        workerProfileId: 'codex',
        fingerprint: context.fingerprint,
        context,
      }, 'codex'),
      event({
        kind: 'run.started',
        runId: 'correction-run-1',
        workItemId: 'work-1',
        source: 'owner/repo#59',
        revision: 'issue-revision-1',
        context: recoveryWorkerPrompt(context),
        instruction: 'correct the candidate',
        transitionId: initial.transitionId,
        recoveryContext: context,
      }, 'codex'),
    ];

    const cycle = foldRecoveryCycles(events, (runId) => runId === 'correction-run-1')[0];
    assert.ok(cycle);
    assert.equal(cycle.status, 'correcting');
    assert.equal(cycle.activeCorrection?.runId, 'correction-run-1');
    assert.equal(cycle.latestEvaluation?.refusal?.required.kind, 'evidence');
    assert.deepEqual(cycle.latestEvaluation?.refusal?.required.kind === 'evidence'
      ? cycle.latestEvaluation.refusal.required.evidence.requirementIds
      : [], ['prototype.dashboard']);
    assert.equal(cycle.latestEvaluation?.provenance[0]?.evaluatorId, 'visual-evaluator');
    assert.equal(cycle.activeCorrection?.context.evaluation.provenance[0]?.evaluatorVersion, '2026.08');
    assert.match(cycle.activeCorrection?.context.blocker.required.kind === 'evidence'
      ? cycle.activeCorrection.context.blocker.required.evidence.description
      : '', /visual-evidence-1/);
    assert.match(cycle.activeCorrection?.context ? recoveryWorkerPrompt(cycle.activeCorrection.context) : '', /visual-evidence-1/);
  });

  test('marks an unfinished correction non-live after restart and never revives it', () => {
    const initial = evaluation();
    const context = correctionContext();
    const events = [
      event({ kind: 'transition.evaluated', evaluation: initial }),
      cycleStarted(initial),
      event({
        kind: 'recovery.correction.started',
        cycleId: 'cycle-1', transitionId: initial.transitionId, refusalAttempt: 1,
        correctionIndex: 1, runId: 'correction-run-1', workerProfileId: 'codex',
        fingerprint: context.fingerprint, context,
      }),
      event({
        kind: 'run.started', runId: 'correction-run-1', workItemId: 'work-1', source: 'owner/repo#59',
        revision: 'issue-revision-1', context: 'structured', instruction: 'correct',
        transitionId: initial.transitionId, recoveryContext: context,
      }, 'codex'),
    ];

    const cycle = foldRecoveryCycles(events)[0];
    assert.equal(cycle?.status, 'interrupted');
    assert.equal(cycle?.activeCorrection, null);
    assert.equal(cycle?.correctionRuns[0]?.interruptedByRestart, true);
  });

  test('does not consume a run for an unchanged candidate/evidence fingerprint', () => {
    const initial = evaluation();
    const context = correctionContext();
    const events = [
      event({ kind: 'transition.evaluated', evaluation: initial }),
      cycleStarted(initial),
      event({ kind: 'recovery.correction.started', cycleId: 'cycle-1', transitionId: initial.transitionId, refusalAttempt: 1, correctionIndex: 1, runId: 'run-1', workerProfileId: 'codex', fingerprint: context.fingerprint, context }),
      event({ kind: 'run.completed', runId: 'run-1', state: 'completed', detail: null }, 'codex'),
      event({ kind: 'transition.evaluated', evaluation: createTransitionEvaluation({ ...initial, attempt: 2, runId: 'run-1', previous: initial }) }),
      event({ kind: 'recovery.cycle.escalated', cycleId: 'cycle-1', transitionId: initial.transitionId, refusalAttempt: 1, reason: 'unchanged-candidate', action: 'waiting-for-human', detail: 'unchanged' }),
    ];

    const cycle = foldRecoveryCycles(events)[0];
    assert.equal(cycle?.correctionsUsed, 1);
    assert.equal(cycle?.status, 'waiting-human');
    assert.equal(cycle?.escalation?.reason, 'unchanged-candidate');
  });

  test('keeps transient evaluator retries outside the correction budget', () => {
    const initial = evaluation();
    const retryEvaluation = createTransitionEvaluation({
      ...initial,
      attempt: 2,
      runId: null,
      previous: initial,
    });
    const context = correctionContext();
    const events = [
      event({ kind: 'transition.evaluated', evaluation: initial }),
      cycleStarted(initial),
      event({ kind: 'recovery.action.recorded', action: {
        actionId: 'retry-action', cycleId: 'cycle-1', transitionId: initial.transitionId, attempt: 1,
        expectedHead: 2, kind: 'retry-evaluator', actor: 'user', authority: 'user', candidate,
        evidenceIds: [],
      } }),
      event({ kind: 'transition.evaluated', evaluation: retryEvaluation }),
    ];
    let cycle = foldRecoveryCycles(events)[0];
    assert.equal(cycle?.transientEvaluatorRetries, 1);
    assert.equal(cycle?.correctionsUsed, 0);
    assert.equal(cycle?.evaluationsUsed, 1);

    const correctionEvaluation = createTransitionEvaluation({
      ...retryEvaluation,
      attempt: 3,
      runId: 'run-after-retry',
      previous: retryEvaluation,
    });
    events.push(
      event({
        kind: 'recovery.correction.started', cycleId: 'cycle-1', transitionId: initial.transitionId,
        refusalAttempt: 1, correctionIndex: 1, runId: 'run-after-retry', workerProfileId: 'codex',
        fingerprint: context.fingerprint, context,
      }, 'codex'),
      event({ kind: 'run.started', runId: 'run-after-retry', workItemId: 'work-1', source: 'owner/repo#59', revision: 'issue-1', context: 'structured', instruction: 'correct', transitionId: initial.transitionId, recoveryContext: context }, 'codex'),
      event({ kind: 'run.completed', runId: 'run-after-retry', state: 'completed', detail: null }, 'codex'),
      event({ kind: 'transition.evaluated', evaluation: correctionEvaluation }),
    );
    cycle = foldRecoveryCycles(events)[0];
    assert.equal(cycle?.transientEvaluatorRetries, 1);
    assert.equal(cycle?.correctionsUsed, 1);
    assert.equal(cycle?.evaluationsUsed, 2);
  });

  test('maxRuns five permits the initial evaluation plus five correction evaluations', () => {
    const initial = evaluation();
    const events: HarnessEvent[] = [
      event({ kind: 'transition.evaluated', evaluation: initial }),
      cycleStarted(initial, 5),
    ];
    let previous = initial;
    for (let index = 1; index <= 5; index += 1) {
      const runId = `run-${index}`;
      const context = buildRecoveryWorkerContext({
        cycleId: 'cycle-1',
        correctionIndex: index,
        refusalAttempt: 1,
        evaluation: previous,
        attempts: [initial, ...events
          .filter((item): item is Extract<HarnessEvent, { kind: 'transition.evaluated' }> => item.kind === 'transition.evaluated')
          .map((item) => item.evaluation)],
        actions: [],
        fingerprint: transitionFingerprint(previous),
      });
      const next = createTransitionEvaluation({
        ...initial,
        attempt: index + 1,
        runId,
        previous,
      });
      events.push(
        event({ kind: 'recovery.correction.started', cycleId: 'cycle-1', transitionId: initial.transitionId, refusalAttempt: 1, correctionIndex: index, runId, workerProfileId: 'codex', fingerprint: context.fingerprint, context }, 'codex'),
        event({ kind: 'run.started', runId, workItemId: 'work-1', source: 'owner/repo#59', revision: 'issue-1', context: 'structured', instruction: 'correct', transitionId: initial.transitionId, recoveryContext: context }, 'codex'),
        event({ kind: 'run.completed', runId, state: 'completed', detail: null }, 'codex'),
        event({ kind: 'transition.evaluated', evaluation: next }),
      );
      previous = next;
    }
    const cycle = foldRecoveryCycles(events)[0];
    assert.equal(cycle?.maxRuns, 5);
    assert.equal(cycle?.maxEvaluations, 6);
    assert.equal(cycle?.correctionsUsed, 5);
    assert.equal(cycle?.evaluationsUsed, 6);
  });

  test('exhaustion waits only for a valid required human action and absolute refusal blocks', () => {
    const initial = evaluation();
    const waitingEvents = [
      event({ kind: 'transition.evaluated', evaluation: initial }),
      cycleStarted(initial),
      event({ kind: 'recovery.cycle.escalated', cycleId: 'cycle-1', transitionId: initial.transitionId, refusalAttempt: 1, reason: 'exhausted', action: 'waiting-for-human', detail: 'budget' }),
    ];
    const waiting = foldRecoveryCycles(waitingEvents)[0];
    assert.equal(waiting?.status, 'waiting-human');
    assert.equal(hasValidHumanRecoveryAction(initial), true);

    const absolute = createTransitionEvaluation({
      ...initial,
      attempt: 2,
      enforcement: [{ requirementId: 'prototype.dashboard', enforcement: 'absolute', allowOverride: false }],
      verdict: 'blocked',
      refusal: { ...refusal(), nextAction: 'escalate', retryable: false },
      override: null,
      previous: initial,
    });
    const blockedEvents = [
      event({ kind: 'transition.evaluated', evaluation: absolute }),
      event({
        kind: 'recovery.cycle.started', cycleId: 'cycle-absolute', transitionId: absolute.transitionId,
        refusalAttempt: absolute.attempt, expectationSetId: absolute.expectationSetId,
        sourceStepId: absolute.sourceStepId, targetStepId: absolute.targetStepId, maxRuns: 2,
        maxEvaluations: 3, onExhausted: 'waiting-for-human', guardrailIds: ['absolute'],
        initialFingerprint: transitionFingerprint(absolute),
      }),
      event({ kind: 'recovery.cycle.escalated', cycleId: 'cycle-absolute', transitionId: absolute.transitionId, refusalAttempt: 2, reason: 'absolute', action: 'blocked', detail: 'absolute' }),
    ];
    assert.equal(foldRecoveryCycles(blockedEvents).find((cycle) => cycle.cycleId === 'cycle-absolute')?.status, 'blocked');
    assert.equal(hasValidHumanRecoveryAction(absolute), false);
  });

  test('keeps worker unavailable and typed actions durable without substitution', () => {
    const initial = evaluation();
    const context = correctionContext();
    const events = [
      event({ kind: 'transition.evaluated', evaluation: initial }),
      cycleStarted(initial),
      event({
        kind: 'recovery.cycle.waiting', cycleId: 'cycle-1', transitionId: initial.transitionId,
        refusalAttempt: 1, reason: 'worker-unavailable', required: initial.refusal!, authority: 'user',
        detail: 'codex unavailable', workerProfileId: 'codex',
      }),
      event({
        kind: 'recovery.action.recorded', action: {
        actionId: 'action-1', cycleId: 'cycle-1', transitionId: initial.transitionId, attempt: 1,
          expectedHead: 3,
          kind: 'evidence', actor: 'user', authority: 'user', candidate, evidenceIds: ['visual-evidence-2'],
        },
      }),
    ];
    const cycle = foldRecoveryCycles(events)[0];
    assert.equal(cycle?.status, 'worker-unavailable');
    assert.equal(cycle?.worker.profileId, 'codex');
    assert.equal(cycle?.worker.available, false);
    assert.equal(cycle?.actions[0]?.evidenceIds[0], 'visual-evidence-2');
    assert.equal(cycle?.correctionRuns.length, 0);
    assert.equal(serializeRecoveryContext(context).includes('visual-evidence-1'), true);
  });

  test('repin cancellation leaves the old cycle and new transition identities explicit', () => {
    const initial = evaluation();
    const context = correctionContext();
    const events = [
      event({ kind: 'transition.evaluated', evaluation: initial }),
      cycleStarted(initial),
      event({ kind: 'recovery.action.recorded', action: {
        actionId: 'repin-action', cycleId: 'cycle-1', transitionId: initial.transitionId, attempt: 1,
        expectedHead: 3,
        kind: 'repin', actor: 'user', authority: 'user', candidate, evidenceIds: [],
        supersededByTransitionId: 'transition-2',
      } }),
      event({ kind: 'recovery.cycle.cancelled', cycleId: 'cycle-1', transitionId: initial.transitionId, reason: 'repinned', supersededByTransitionId: 'transition-2' }),
      event({ kind: 'transition.evaluated', evaluation: createTransitionEvaluation({
        ...initial, transitionId: 'transition-2', attempt: 1, runId: null,
        supersedesTransitionId: initial.transitionId, previous: undefined,
      }) }),
    ];
    const cycle = foldRecoveryCycles(events)[0];
    assert.equal(cycle?.status, 'cancelled');
    assert.equal(cycle?.actions[0]?.supersededByTransitionId, 'transition-2');
    assert.equal(cycle?.attempts[0]?.transitionId, initial.transitionId);
    assert.equal(context.refusalAttempt, 1);
  });

  test('cancel is a durable typed action and stops the cycle', () => {
    const initial = evaluation();
    const context = correctionContext();
    const events = [
      event({ kind: 'transition.evaluated', evaluation: initial }),
      cycleStarted(initial),
      event({ kind: 'recovery.action.recorded', action: {
        actionId: 'cancel-action', cycleId: 'cycle-1', transitionId: initial.transitionId, attempt: 1,
        expectedHead: 3,
        kind: 'cancel', actor: 'user', authority: 'user', candidate, evidenceIds: [], reason: 'stop',
      } }),
      event({ kind: 'recovery.cycle.cancelled', cycleId: 'cycle-1', transitionId: initial.transitionId,
        refusalAttempt: 1, reason: 'user', supersededByTransitionId: null }),
    ];
    const cycle = foldRecoveryCycles(events)[0];
    assert.equal(cycle?.status, 'cancelled');
    assert.equal(cycle?.actions[0]?.kind, 'cancel');
    assert.equal(cycle?.cancelled, true);
    assert.equal(context.schema, 'awos.recovery.v1');
  });
});

test('ThreadStore compare-and-append allows only one concurrent recovery reservation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awos-recovery-store-'));
  try {
    const store = new ThreadStore(dir);
    const thread = store.create({ cwd: '/repo' });
    const first = store.compareAndAppend(thread.id, 0, null, {
      kind: 'recovery.cycle.started', cycleId: 'cycle-1', transitionId: 'transition-1', refusalAttempt: 1,
      expectationSetId: 'set', sourceStepId: 'a', targetStepId: 'b', maxRuns: 2, maxEvaluations: 3,
      onExhausted: 'waiting-for-human', guardrailIds: [], initialFingerprint: {
        candidate, evidenceIds: [], digest: 'fingerprint',
      },
    });
    const loser = store.compareAndAppend(thread.id, 0, null, {
      kind: 'recovery.cycle.started', cycleId: 'cycle-2', transitionId: 'transition-1', refusalAttempt: 1,
      expectationSetId: 'set', sourceStepId: 'a', targetStepId: 'b', maxRuns: 2, maxEvaluations: 3,
      onExhausted: 'waiting-for-human', guardrailIds: [], initialFingerprint: {
        candidate, evidenceIds: [], digest: 'fingerprint',
      },
    });
    assert.ok(first);
    assert.equal(loser, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('independent ThreadStore instances serialize cycle and correction races and replay after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'awos-recovery-cross-process-'));
  try {
    const firstStore = new ThreadStore(dir);
    const thread = firstStore.create({ cwd: '/repo' });
    const secondStore = new ThreadStore(dir);
    const initial = evaluation();
    firstStore.append(thread.id, null, { kind: 'transition.evaluated', evaluation: initial });

    const cycleBody = (cycleId: string) => ({
      kind: 'recovery.cycle.started' as const,
      cycleId,
      transitionId: initial.transitionId,
      refusalAttempt: initial.attempt,
      expectationSetId: initial.expectationSetId,
      sourceStepId: initial.sourceStepId,
      targetStepId: initial.targetStepId,
      maxRuns: 2,
      maxEvaluations: 3,
      onExhausted: 'waiting-for-human' as const,
      guardrailIds: ['visual-guardrail'],
      initialFingerprint: transitionFingerprint(initial),
    });
    const cycleResults = await Promise.all([
      Promise.resolve().then(() => firstStore.compareAndAppend(
        thread.id,
        1,
        null,
        cycleBody('cycle-first'),
        { transitionId: initial.transitionId, attempt: initial.attempt },
      )),
      Promise.resolve().then(() => secondStore.compareAndAppend(
        thread.id,
        1,
        null,
        cycleBody('cycle-second'),
        { transitionId: initial.transitionId, attempt: initial.attempt },
      )),
    ]);
    assert.equal(cycleResults.filter((result) => result !== null).length, 1);

    const cycle = firstStore.events(thread.id).find((event) => event.kind === 'recovery.cycle.started');
    assert.equal(cycle?.kind, 'recovery.cycle.started');
    const context = correctionContext();
    const correctionBody = (runId: string) => ({
      kind: 'recovery.correction.started' as const,
      cycleId: cycle?.kind === 'recovery.cycle.started' ? cycle.cycleId : 'missing-cycle',
      transitionId: initial.transitionId,
      refusalAttempt: initial.attempt,
      correctionIndex: 1,
      runId,
      workerProfileId: 'codex' as const,
      fingerprint: context.fingerprint,
      context,
    });
    const correctionResults = await Promise.all([
      Promise.resolve().then(() => firstStore.compareAndAppend(
        thread.id,
        2,
        'codex',
        correctionBody('run-first'),
        { transitionId: initial.transitionId, attempt: initial.attempt },
      )),
      Promise.resolve().then(() => secondStore.compareAndAppend(
        thread.id,
        2,
        'codex',
        correctionBody('run-second'),
        { transitionId: initial.transitionId, attempt: initial.attempt },
      )),
    ]);
    assert.equal(correctionResults.filter((result) => result !== null).length, 1);

    const events = firstStore.events(thread.id);
    assert.equal(events.filter((event) => event.kind === 'recovery.cycle.started').length, 1);
    assert.equal(events.filter((event) => event.kind === 'recovery.correction.started').length, 1);
    assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]);
    assert.equal(new Set(events.map((event) => event.seq)).size, events.length);

    const lockPath = join(dir, 'threads', thread.id, '.events.lock');
    mkdirSync(lockPath);
    try {
      assert.throws(
        () => firstStore.compareAndAppend(thread.id, 3, null, cycleBody('stale-lock')),
        /append lock.*refused/,
      );
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }

    const restarted = new ThreadStore(dir);
    assert.deepEqual(restarted.events(thread.id).map((event) => event.seq), [1, 2, 3]);
    assert.equal(restarted.events(thread.id).filter((event) => event.kind === 'recovery.correction.started').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
