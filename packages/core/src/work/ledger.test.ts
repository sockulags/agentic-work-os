import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createExpectationSet,
  createRequiredTransitionOverride,
  createTransitionEvaluation,
  type HarnessEvent,
  type TransitionEvaluation,
} from '@awos/protocol';
import {
  foldEvidence,
  foldAnswers,
  foldAttestations,
  foldTypedAnswerConflicts,
  foldHumanAttestationConflicts,
  foldExpectationSetConflicts,
  foldExpectationSets,
  foldExpectationSetHistory,
  foldExpectationSetSupersessions,
  foldOutcomes,
  foldRetained,
  foldTransitionEvaluations,
  foldTransitionEvaluationConflicts,
  foldTransitionEvaluationHistory,
  foldVisualSourceEvents,
  selectedForContext,
} from './ledger.js';

let seq = 0;

function event(body: Record<string, unknown> & { kind: string }): HarnessEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    seq,
    threadId: 't1',
    agent: null,
    turnId: null,
    ts: 1_000 + seq,
    ...body,
  } as unknown as HarnessEvent;
}

function evidence(id: string, overrides: Record<string, unknown> = {}): HarnessEvent {
  return event({
    kind: 'evidence.recorded',
    evidenceId: id,
    runId: 'r1',
    workItemId: 'w1',
    evidenceKind: 'command',
    ref: { eventId: 'e-cmd', url: null, label: 'npm test' },
    summary: '269 passed',
    state: { commit: 'abc123', tree: 'tree1', dirty: false },
    ...overrides,
  });
}

function retained(id: string, overrides: Record<string, unknown> = {}): HarnessEvent {
  return event({
    kind: 'context.retained',
    retainedId: id,
    workItemId: 'w1',
    retainedKind: 'decision',
    text: 'gh, not an API token',
    runId: 'r1',
    selected: true,
    retired: false,
    ...overrides,
  });
}

describe('foldOutcomes', () => {
  test('a run with no claim has no outcome, whatever its turn did', () => {
    assert.equal(foldOutcomes([event({ kind: 'turn.completed', reason: 'completed', error: null, durationMs: 1 })]).size, 0);
  });

  test('keeps the claim and who made it', () => {
    const outcomes = foldOutcomes([
      event({ kind: 'run.closed', runId: 'r1', claim: 'partial', statement: 'the parser is done' }),
    ]);

    assert.equal(outcomes.get('r1')?.claim, 'partial');
    assert.equal(outcomes.get('r1')?.statement, 'the parser is done');
    assert.equal(outcomes.get('r1')?.source, 'user');
  });

  test('an agent claim is attributed to the agent', () => {
    const outcomes = foldOutcomes([
      event({ kind: 'run.closed', runId: 'r1', claim: 'delivered', statement: 'done', agent: 'codex' }),
    ]);

    assert.equal(outcomes.get('r1')?.source, 'codex');
  });

  test('a correction wins without erasing the claim it corrects', () => {
    const events = [
      event({ kind: 'run.closed', runId: 'r1', claim: 'delivered', statement: 'done' }),
      event({ kind: 'run.closed', runId: 'r1', claim: 'partial', statement: 'the tests were wrong' }),
    ];

    assert.equal(foldOutcomes(events).get('r1')?.claim, 'partial');
    // The earlier claim is still in the log, which is the whole point of appending.
    assert.equal(events.filter((e) => e.kind === 'run.closed').length, 2);
  });
});

describe('foldEvidence', () => {
  test('keeps what it points at and the tree it applies to', () => {
    const [item] = foldEvidence([evidence('ev1')]);

    assert.equal(item?.kind, 'command');
    assert.equal(item?.ref.label, 'npm test');
    assert.equal(item?.ref.eventId, 'e-cmd');
    assert.equal(item?.state.commit, 'abc123');
    assert.equal(item?.runId, 'r1');
    assert.equal(item?.workItemId, 'w1');
  });

  test('a corrected item replaces its earlier version', () => {
    const items = foldEvidence([
      evidence('ev1', { summary: '269 passed' }),
      evidence('ev1', { summary: 'actually 3 were skipped' }),
    ]);

    assert.equal(items.length, 1);
    assert.equal(items[0]?.summary, 'actually 3 were skipped');
  });

  test('visual evidence identity cannot be corrected in place', () => {
    const visual = {
      kind: 'pixel-diff',
      reference: { eventId: 'reference-event', artifactId: 'reference-v1', locator: 'artifact://reference', revision: 'r1', digest: 'ref-digest' },
      candidate: { eventId: 'candidate-event', artifactId: 'candidate-v1', locator: 'artifact://candidate', revision: 'c1', digest: 'candidate-digest' },
      capture: { browser: 'chromium/128', runtime: 'node/22', viewport: '10x10', dpr: 1, fonts: 'fonts', data: 'fixture', animation: 'disabled', region: 'main' },
      measurement: { comparedPixels: 100, differentPixels: 0, equal: true, exact: true },
    };
    const changed = { ...visual, candidate: { ...visual.candidate, digest: 'changed-digest' } };
    const items = foldEvidence([
      evidence('visual', { evidenceKind: 'artifact', visual }),
      evidence('visual', { evidenceKind: 'artifact', visual: changed }),
    ]);

    assert.equal(items.length, 1);
    assert.equal(items[0]?.visual?.kind, 'pixel-diff');
    assert.equal(items[0]?.visual?.kind === 'pixel-diff' ? items[0].visual.candidate.digest : null, 'candidate-digest');
  });

  test('separate items stay separate', () => {
    assert.equal(foldEvidence([evidence('ev1'), evidence('ev2')]).length, 2);
  });

  test('an external link needs no event to point at', () => {
    const [item] = foldEvidence([
      evidence('ev1', {
        evidenceKind: 'link',
        ref: { eventId: null, url: 'https://example.com/run/9', label: 'staging deploy' },
      }),
    ]);

    assert.equal(item?.ref.url, 'https://example.com/run/9');
    assert.equal(item?.ref.eventId, null);
  });
});

describe('foldVisualSourceEvents', () => {
  test('keeps the first immutable source and marks a later redefinition as unusable', () => {
    const first = event({
      kind: 'visual.artifact.recorded',
      role: 'reference',
      artifactId: 'reference-v1',
      locator: 'artifact://reference-v1',
      revision: 'r1',
      digest: 'digest-v1',
      capture: null,
    });
    const redefined = { ...first, digest: 'digest-v2' } as HarnessEvent;
    const folded = foldVisualSourceEvents([first, redefined]);

    assert.equal(folded.artifacts.get(first.id)?.identity.digest, 'digest-v1');
    assert.equal(folded.conflicts.has(first.id), true);
  });
});

describe('immutable human records', () => {
  test('replay keeps the first answer definition and exposes conflicting identity reuse', () => {
    const first = event({
      kind: 'answer.recorded', answerId: 'answer-1', expectationItemId: 'question-a', expectationSetId: 'set-a',
      actor: 'user', authority: 'user', answer: { type: 'choice', value: 'keep' },
      candidate: { kind: 'working-tree', id: 'tree-a', revision: 'commit-a', digest: 'tree-a', pinned: true },
      evidenceIds: [], recordedAt: 10,
    });
    const identical = event({ ...first, id: 'replayed-answer', seq: 99, ts: 99, recordedAt: 99 });
    const conflict = event({
      ...first,
      id: 'conflicting-answer', seq: 100, ts: 100, recordedAt: 100,
      expectationItemId: 'question-b', expectationSetId: 'set-b', actor: 'codex',
      answer: { type: 'choice', value: 'change' },
      candidate: { kind: 'working-tree', id: 'tree-b', revision: 'commit-b', digest: 'tree-b', pinned: true },
    });
    const events = [first, identical, conflict];
    assert.equal(foldAnswers(events)[0]?.expectationItemId, 'question-a');
    assert.equal(foldAnswers(events)[0]?.answer.value, 'keep');
    assert.equal(foldTypedAnswerConflicts(events).get('answer-1')?.length, 1);
    assert.equal(foldAnswers([...events])[0]?.candidate.id, 'tree-a', 'restart replay has the same authority');
  });

  test('replay keeps the first attestation and exposes actor, authority, expectation, and candidate conflicts', () => {
    const first = event({
      kind: 'human.attestation.recorded', attestationId: 'attestation-1', expectationItemId: 'review-a', expectationSetId: 'set-a',
      actor: 'user', authority: 'user', statement: 'reviewed',
      candidate: { kind: 'working-tree', id: 'tree-a', revision: 'commit-a', digest: 'tree-a', pinned: true },
      evidenceIds: ['evidence-a'], recordedAt: 10,
    });
    const conflict = event({
      ...first,
      id: 'conflicting-attestation', seq: 101, ts: 101, recordedAt: 101,
      expectationItemId: 'review-b', expectationSetId: 'set-b', actor: 'codex', authority: 'user',
      statement: 'different',
      candidate: { kind: 'working-tree', id: 'tree-b', revision: 'commit-b', digest: 'tree-b', pinned: true },
      evidenceIds: ['evidence-b'],
    });
    const events = [first, conflict];
    assert.equal(foldAttestations(events)[0]?.expectationItemId, 'review-a');
    assert.equal(foldHumanAttestationConflicts(events).get('attestation-1')?.[0]?.actor, 'codex');
    assert.equal(foldAttestations([...events])[0]?.candidate.id, 'tree-a');
  });
});

describe('foldRetained', () => {
  test('keeps the claim, its kind, and where it came from', () => {
    const [item] = foldRetained([retained('k1')]);

    assert.equal(item?.kind, 'decision');
    assert.equal(item?.text, 'gh, not an API token');
    assert.equal(item?.runId, 'r1');
    assert.equal(item?.selected, true);
  });

  test('an amendment changes the flags without changing the words', () => {
    const items = foldRetained([
      retained('k1'),
      retained('k1', { selected: false, retired: true }),
    ]);

    assert.equal(items.length, 1);
    assert.equal(items[0]?.text, 'gh, not an API token');
    assert.equal(items[0]?.selected, false);
    assert.equal(items[0]?.retired, true);
  });
});

describe('selectedForContext', () => {
  test('carries forward only what was selected and still stands', () => {
    const items = foldRetained([
      retained('k1', { text: 'carried' }),
      retained('k2', { text: 'not selected', selected: false }),
      retained('k3', { text: 'retired', retired: true }),
    ]);

    assert.deepEqual(
      selectedForContext(items).map((entry) => entry.text),
      ['carried'],
    );
  });

  test('oldest first, so a later decision reads as the later one', () => {
    const items = foldRetained([retained('k1', { text: 'first' }), retained('k2', { text: 'second' })]);

    assert.deepEqual(
      selectedForContext(items).map((entry) => entry.text),
      ['first', 'second'],
    );
  });
});

function evaluation(
  attempt: number,
  verdict: 'passed' | 'retry',
  supersedesTransitionId: string | null = null,
  transitionId = 'transition-a',
): TransitionEvaluation {
  const common = {
    transitionId,
    attempt,
    runId: 'run-a',
    actor: 'user' as const,
    sourceStepId: 'draft',
    targetStepId: 'approved',
    expectationSetId: 'set-a',
    candidate: { kind: 'working-tree' as const, id: `tree-${attempt}`, revision: `commit-${attempt}`, digest: `digest-${attempt}`, pinned: true },
    evidenceIds: [],
    facts: [],
    provenance: [],
    enforcement: [],
    timestamp: 1_000 + attempt,
    supersedesTransitionId,
  };
  if (verdict === 'passed') {
    return createTransitionEvaluation({ ...common, verdict, refusal: null, override: null });
  }
  return createTransitionEvaluation({
    ...common,
    verdict,
    refusal: {
      unmetRequirementIds: ['test'],
      reason: 'needs evidence',
      required: { kind: 'evidence', evidence: { requirementIds: ['test'], description: 'run test' } },
      responsibleActor: 'user',
      nextAction: 'provide-evidence',
      retryable: true,
    },
    override: null,
  });
}

function expectationSet(id: string, supersedes: string | null = null) {
  return createExpectationSet({
    expectationSetId: id,
    manifestDigest: `manifest-${id}`,
    items: [],
    authority: { sourceOwner: 'project', pinnedBy: 'user' },
    supersedes,
  });
}

describe('transition and expectation folds', () => {
  test('keeps latest attempt and all earlier attempts after replay', () => {
    const events = [
      event({ kind: 'transition.evaluated', evaluation: evaluation(1, 'retry') }),
      event({ kind: 'transition.evaluated', evaluation: evaluation(2, 'passed') }),
    ];

    assert.equal(foldTransitionEvaluations(events).get('transition-a')?.verdict, 'passed');
    assert.deepEqual(
      foldTransitionEvaluationHistory(events).get('transition-a')?.map((entry) => entry.attempt),
      [1, 2],
    );
    assert.equal(events.filter((entry) => entry.kind === 'transition.evaluated').length, 2);
  });

  test('does not let duplicate or out-of-order attempts redefine replay truth', () => {
    const attemptOne = event({ kind: 'transition.evaluated', evaluation: evaluation(1, 'retry') });
    const attemptTwo = event({ kind: 'transition.evaluated', evaluation: evaluation(2, 'passed') });
    const duplicateAttemptTwo = event({ kind: 'transition.evaluated', evaluation: evaluation(2, 'retry') });
    const lateAttemptOne = event({ kind: 'transition.evaluated', evaluation: evaluation(1, 'passed') });
    const events = [attemptOne, attemptTwo, duplicateAttemptTwo, lateAttemptOne];

    assert.equal(foldTransitionEvaluations(events).get('transition-a')?.verdict, 'passed');
    assert.deepEqual(
      foldTransitionEvaluationHistory(events).get('transition-a')?.map((entry) => entry.attempt),
      [1, 2],
    );
    assert.deepEqual(
      foldTransitionEvaluationConflicts(events).get('transition-a')?.map((entry) => entry.attempt),
      [2, 1],
    );
  });

  test('rejects a fabricated passed evaluation and preserves the prior accepted truth', () => {
    const first = evaluation(1, 'retry', null, 'transition-c');
    const fabricated = {
      ...evaluation(2, 'passed', null, 'transition-c'),
      facts: [],
      provenance: [],
      enforcement: [{ requirementId: 'test', enforcement: 'required' as const, allowOverride: true }],
    } as TransitionEvaluation;
    const events = [
      event({ kind: 'transition.evaluated', evaluation: first }),
      event({ kind: 'transition.evaluated', evaluation: fabricated }),
    ];

    assert.equal(foldTransitionEvaluations(events).get('transition-c')?.attempt, 1);
    assert.equal(foldTransitionEvaluations(events).get('transition-c')?.verdict, 'retry');
    assert.deepEqual(
      foldTransitionEvaluationHistory(events).get('transition-c')?.map((entry) => entry.attempt),
      [1],
    );
    assert.deepEqual(
      foldTransitionEvaluationConflicts(events).get('transition-c')?.map((entry) => entry.attempt),
      [2],
    );
  });

  test('replay rejects a passed evaluation whose override policy differs from the pinned set', () => {
    const set = createExpectationSet({
      expectationSetId: 'set-policy',
      manifestDigest: 'manifest-policy',
      items: [{
        id: 'test',
        kind: 'requirement',
        name: 'test',
        enforcement: 'required',
        allowOverride: false,
        reference: {
          sourceKind: 'repository-file',
          locator: 'C:/workspace/checks.txt',
          nativeRevision: 'commit-policy',
          contentDigest: 'digest-policy',
          selector: null,
        },
      }],
      authority: { sourceOwner: 'project', pinnedBy: 'user' },
      supersedes: null,
    });
    const candidate = {
      kind: 'working-tree' as const,
      id: 'tree-policy',
      revision: 'commit-policy',
      digest: 'tree-policy',
      pinned: true,
    };
    const provenance = {
      evaluatorId: 'test-evaluator',
      evaluatorVersion: '1',
      evaluatorClass: 'deterministic' as const,
      expectationSetId: set.expectationSetId,
      candidate,
      evidenceIds: ['evidence-policy'],
      validity: 'current' as const,
      detail: null,
    };
    const evaluation = createTransitionEvaluation({
      transitionId: 'policy-transition',
      attempt: 1,
      runId: null,
      actor: 'user',
      sourceStepId: 'draft',
      targetStepId: 'approved',
      expectationSetId: set.expectationSetId,
      candidate,
      evidenceIds: ['evidence-policy'],
      facts: [{
        requirementId: 'test',
        state: 'failed',
        evidenceIds: ['evidence-policy'],
        provenance,
        detail: null,
      }],
      provenance: [provenance],
      enforcement: [{ requirementId: 'test', enforcement: 'required', allowOverride: true }],
      timestamp: 10,
      supersedesTransitionId: null,
      verdict: 'passed',
      refusal: null,
      override: createRequiredTransitionOverride({
        permissionGranted: true,
        authorizedUserId: 'user',
        reason: 'reviewed',
      }),
    });
    const events = [
      event({ kind: 'expectation.set.created', expectationSet: set }),
      event({ kind: 'transition.evaluated', evaluation }),
    ];

    assert.equal(foldTransitionEvaluations(events).has('policy-transition'), false);
    assert.equal(foldTransitionEvaluationConflicts(events).get('policy-transition')?.length, 1);
  });

  test('rejects a replay that starts above the first attempt', () => {
    const events = [
      event({ kind: 'transition.evaluated', evaluation: evaluation(2, 'passed', null, 'transition-b') }),
      event({ kind: 'transition.evaluated', evaluation: evaluation(1, 'retry', null, 'transition-b') }),
    ];

    assert.equal(foldTransitionEvaluations(events).get('transition-b')?.attempt, 1);
    assert.deepEqual(
      foldTransitionEvaluationConflicts(events).get('transition-b')?.map((entry) => entry.attempt),
      [2],
    );
  });

  test('replacement sets are additive and retain their supersession link', () => {
    const first = expectationSet('set-a');
    const replacement = expectationSet('set-b', 'set-a');
    const events = [
      event({ kind: 'expectation.set.created', expectationSet: first }),
      event({ kind: 'expectation.set.created', expectationSet: replacement }),
      event({
        kind: 'expectation.set.superseded',
        expectationSetId: 'set-a',
        supersededByExpectationSetId: 'set-b',
        supersedesTransitionId: 'transition-a',
      }),
      event({
        kind: 'transition.evaluated',
        evaluation: evaluation(1, 'passed', 'transition-a', 'transition-b'),
      }),
    ];

    const sets = foldExpectationSets(events);
    assert.equal(sets.size, 2);
    assert.equal(sets.get('set-a')?.supersedes, null);
    assert.equal(sets.get('set-b')?.supersedes, 'set-a');
    assert.deepEqual(foldExpectationSetHistory(events).map((set) => set.expectationSetId), ['set-a', 'set-b']);
    assert.equal(foldExpectationSetSupersessions(events).get('set-a'), 'set-b');
    assert.equal(foldTransitionEvaluations(events).get('transition-b')?.supersedesTransitionId, 'transition-a');
  });

  test('keeps the first immutable set when a duplicate id is redefined', () => {
    const first = expectationSet('set-a');
    const conflicting = createExpectationSet({
      ...first,
      manifestDigest: 'manifest-conflict',
    });
    const events = [
      event({ kind: 'expectation.set.created', expectationSet: first }),
      event({ kind: 'expectation.set.created', expectationSet: conflicting }),
    ];

    assert.equal(foldExpectationSets(events).get('set-a')?.manifestDigest, 'manifest-set-a');
    assert.deepEqual(foldExpectationSetHistory(events).map((set) => set.manifestDigest), ['manifest-set-a']);
    assert.deepEqual(
      foldExpectationSetConflicts(events).get('set-a')?.map((set) => set.manifestDigest),
      ['manifest-conflict'],
    );
  });
});
