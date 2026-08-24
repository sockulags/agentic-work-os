import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createExpectationSet,
  createRequiredTransitionOverride,
  createTransitionEvaluation,
  type CandidateIdentity,
  type EvaluatorFact,
  type ExpectationSet,
  type TransitionAttempt,
  type TransitionRefusal,
} from './evidence.js';

const candidate: CandidateIdentity = {
  kind: 'working-tree',
  id: 'tree-a',
  revision: 'commit-a',
  digest: 'digest-a',
  pinned: true,
};

const expectationSet: ExpectationSet = createExpectationSet({
  expectationSetId: 'set-a',
  manifestDigest: 'manifest-a',
  items: [{
    id: 'test',
    kind: 'requirement',
    name: 'test',
    enforcement: 'required',
    allowOverride: true,
    reference: {
      sourceKind: 'repository-file',
      locator: 'checks/test.txt',
      nativeRevision: 'commit-a',
      contentDigest: 'digest-a',
      selector: null,
    },
  }],
  authority: { sourceOwner: 'project', pinnedBy: 'user' },
  supersedes: null,
});

const attempt: TransitionAttempt = {
  transitionId: 'transition-a',
  attempt: 1,
  runId: null,
  actor: 'user',
  sourceStepId: 'draft',
  targetStepId: 'approved',
  expectationSetId: expectationSet.expectationSetId,
  candidate,
  evidenceIds: [],
};

const provenance: EvaluatorFact['provenance'] = {
  evaluatorId: 'test',
  evaluatorVersion: '1',
  evaluatorClass: 'deterministic',
  expectationSetId: expectationSet.expectationSetId,
  candidate,
  evidenceIds: [],
  validity: 'current',
  detail: null,
};

const fact: EvaluatorFact = {
  requirementId: 'test',
  state: 'satisfied',
  evidenceIds: [],
  provenance,
  detail: null,
};

const failedFact: EvaluatorFact = {
  ...fact,
  state: 'failed',
};

const refusal: TransitionRefusal = {
  unmetRequirementIds: ['test'],
  reason: 'needs evidence',
  required: {
    kind: 'evidence',
    evidence: { requirementIds: ['test'], description: 'run the test' },
  },
  responsibleActor: 'user',
  nextAction: 'provide-evidence',
  retryable: true,
};

const common = {
  ...attempt,
  facts: [fact],
  provenance: [provenance],
  enforcement: [{ requirementId: 'test', enforcement: 'required' as const, allowOverride: true }],
  timestamp: 1,
};

test('constructors retain immutable identity and legal verdict combinations', () => {
  const passed = createTransitionEvaluation({
    ...common,
    verdict: 'passed',
    refusal: null,
    override: null,
  });
  assert.equal(passed.verdict, 'passed');
  assert.equal(passed.refusal, null);
  assert.equal(passed.supersedesTransitionId, null);

  const overridden = createTransitionEvaluation({
    ...common,
    facts: [failedFact],
    provenance: [failedFact.provenance],
    verdict: 'passed',
    refusal: null,
    override: createRequiredTransitionOverride({
      permissionGranted: true,
      authorizedUserId: 'user',
      reason: 'explicitly checked',
    }),
  });
  assert.equal(overridden.override?.authorizedUserId, 'user');

  const blocked = createTransitionEvaluation({
    ...common,
    verdict: 'blocked',
    refusal,
    override: null,
  });
  assert.equal(blocked.refusal?.nextAction, 'provide-evidence');
});

test('constructors reject fabricated passed evaluations without eligible evidence', () => {
  const unknown = { ...fact, state: 'unknown' as const };
  const unpinned = {
    ...fact,
    provenance: { ...fact.provenance, candidate: { ...candidate, pinned: false } },
  };

  for (const [label, facts, provenance] of [
    ['missing', [], []],
    ['missing provenance', [fact], []],
    ['unknown', [unknown], [unknown.provenance]],
    ['unpinned', [unpinned], [unpinned.provenance]],
  ] as const) {
    assert.throws(
      () => createTransitionEvaluation({
        ...common,
        facts,
        provenance,
        verdict: 'passed',
        refusal: null,
        override: null,
      }),
      /passed transition/,
      label,
    );
  }
});

test('constructors reject missing override authority and reasons', () => {
  assert.throws(
    () => createRequiredTransitionOverride({ permissionGranted: false, authorizedUserId: 'user', reason: 'x' }),
    /permission/,
  );
  assert.throws(
    () => createRequiredTransitionOverride({ permissionGranted: true, authorizedUserId: ' ', reason: 'x' }),
    /authorized user/,
  );
  assert.throws(
    () => createRequiredTransitionOverride({ permissionGranted: true, authorizedUserId: 'user', reason: ' ' }),
    /reason/,
  );
});

test('constructors reject an override that bypasses an explicit non-overridable policy', () => {
  assert.throws(
    () => createTransitionEvaluation({
      ...common,
      facts: [failedFact],
      provenance: [failedFact.provenance],
      enforcement: [{ requirementId: 'test', enforcement: 'required', allowOverride: false }],
      verdict: 'passed',
      refusal: null,
      override: createRequiredTransitionOverride({
        permissionGranted: true,
        authorizedUserId: 'user',
        reason: 'explicitly reviewed',
      }),
    }),
    /does not permit/,
  );
});

test('expectation sets reject override permission on advisory and absolute items', () => {
  for (const enforcement of ['advisory', 'absolute'] as const) {
    assert.throws(
      () => createExpectationSet({
        ...expectationSet,
        expectationSetId: `set-${enforcement}`,
        items: [{ ...expectationSet.items[0]!, enforcement, allowOverride: true }],
      }),
      /Only required expectation items/,
      enforcement,
    );
  }
});

test('constructors reject invalid attempts relative to the previous evaluation', () => {
  const previous = createTransitionEvaluation({
    ...common,
    verdict: 'passed',
    refusal: null,
    override: null,
  });

  assert.throws(
    () => createTransitionEvaluation({
      ...common,
      attempt: 0,
      verdict: 'passed',
      refusal: null,
      override: null,
    }),
    /positive integers/,
  );
  assert.throws(
    () => createTransitionEvaluation({
      ...common,
      verdict: 'passed',
      refusal: null,
      override: null,
      previous,
    }),
    /must increase/,
  );
});

test('an absolute override cannot hide duplicate satisfied and failed facts', () => {
  const absoluteSet = createExpectationSet({
    ...expectationSet,
    expectationSetId: 'set-absolute',
    items: [{ ...expectationSet.items[0]!, enforcement: 'absolute', allowOverride: false }],
  });
  const absoluteAttempt = { ...attempt, expectationSetId: absoluteSet.expectationSetId };
  const absoluteProvenance = {
    ...provenance,
    expectationSetId: absoluteSet.expectationSetId,
  };
  const satisfied: EvaluatorFact = {
    ...fact,
    provenance: absoluteProvenance,
  };
  const failed: EvaluatorFact = {
    ...satisfied,
    state: 'failed',
  };
  const override = createRequiredTransitionOverride({
    permissionGranted: true,
    authorizedUserId: 'user',
    reason: 'explicitly reviewed',
  });

  assert.throws(
    () => createTransitionEvaluation({
      ...absoluteAttempt,
      facts: [satisfied, failed],
      provenance: [satisfied.provenance, failed.provenance],
    enforcement: [{ requirementId: 'test', enforcement: 'absolute', allowOverride: false }],
      timestamp: 1,
      verdict: 'passed',
      refusal: null,
      override,
    }),
    /only one evaluator fact/,
  );
});

// These checks are intentional compile-time contract tests. The discriminated constructor
// input must not let a refused result carry an override or a passed result carry a refusal.
if (false) {
  // @ts-expect-error A passed evaluation cannot carry a refusal.
  createTransitionEvaluation({ ...common, verdict: 'passed', refusal, override: null });
  // @ts-expect-error A refused evaluation cannot carry an override.
  createTransitionEvaluation({ ...common, verdict: 'blocked', refusal, override: createRequiredTransitionOverride({ permissionGranted: true, authorizedUserId: 'user', reason: 'no' }) });
  // @ts-expect-error The required-override constructor has no absolute-enforcement form.
  createRequiredTransitionOverride({ permissionGranted: true, authorizedUserId: 'user', reason: 'no', enforcement: 'absolute' });
}
