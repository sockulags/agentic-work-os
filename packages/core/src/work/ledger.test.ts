import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createExpectationSet,
  createTransitionEvaluation,
  type HarnessEvent,
  type TransitionEvaluation,
} from '@awos/protocol';
import {
  foldEvidence,
  foldExpectationSetConflicts,
  foldExpectationSets,
  foldExpectationSetHistory,
  foldExpectationSetSupersessions,
  foldOutcomes,
  foldRetained,
  foldTransitionEvaluations,
  foldTransitionEvaluationConflicts,
  foldTransitionEvaluationHistory,
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
      enforcement: [{ requirementId: 'test', enforcement: 'required' as const }],
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
