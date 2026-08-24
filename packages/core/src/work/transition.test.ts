import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolve as resolvePath } from 'node:path';
import {
  createExpectationSet,
  createRequiredTransitionOverride,
  type CandidateIdentity,
  type EvaluatorFact,
  type ExpectationItem,
  type ExpectationItemKind,
  type ExpectationSet,
  type TransitionAttempt,
  type WorkspaceGuardrail,
} from '@awos/protocol';
import { buildGuardrailExpectationSet, buildIntegrationExpectationSet, evaluateTransition } from './gate.js';

const candidate: CandidateIdentity = {
  kind: 'working-tree',
  id: 'tree-a',
  revision: 'commit-a',
  digest: 'tree-a',
  pinned: true,
};

function expectation(
  id = 'test',
  enforcement: ExpectationItem['enforcement'] = 'required',
  kind: ExpectationItemKind = 'requirement',
): ExpectationSet {
  return createExpectationSet({
    expectationSetId: 'set-a',
    manifestDigest: 'manifest-a',
    items: [{
      id,
      kind,
      name: id,
      enforcement,
      allowOverride: enforcement === 'required',
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
}

function attempt(set: ExpectationSet, overrides: Partial<TransitionAttempt> = {}): TransitionAttempt {
  return {
    transitionId: 'transition-a',
    attempt: 1,
    runId: 'run-a',
    actor: 'codex',
    sourceStepId: 'implementation',
    targetStepId: 'review',
    expectationSetId: set.expectationSetId,
    candidate,
    evidenceIds: ['evidence-a'],
    supersedesTransitionId: null,
    ...overrides,
  };
}

function fact(
  set: ExpectationSet,
  requirementId: string,
  state: EvaluatorFact['state'],
  overrides: Partial<EvaluatorFact['provenance']> = {},
): EvaluatorFact {
  return {
    requirementId,
    state,
    evidenceIds: ['evidence-a'],
    provenance: {
      evaluatorId: 'test-evaluator',
      evaluatorVersion: '1',
      evaluatorClass: 'deterministic',
      expectationSetId: set.expectationSetId,
      candidate,
      evidenceIds: ['evidence-a'],
      validity: 'current',
      detail: null,
      ...overrides,
    },
    detail: null,
  };
}

describe('evaluateTransition', () => {
  test('maps a required failed fact to a retry refusal', () => {
    const set = expectation();
    const result = evaluateTransition({
      attempt: attempt(set),
      expectationSet: set,
      facts: [fact(set, 'test', 'failed')],
      timestamp: 10,
    });

    assert.equal(result.verdict, 'retry');
    assert.equal(result.refusal?.nextAction, 'correct-candidate');
    assert.deepEqual(result.refusal?.unmetRequirementIds, ['test']);
    assert.equal(result.refusal?.required.kind, 'evidence');
    assert.equal(result.override, null);
  });

  test('a required override passes only a current pinned required failure', () => {
    const set = expectation();
    const override = createRequiredTransitionOverride({
      permissionGranted: true,
      authorizedUserId: 'user-1',
      reason: 'reviewed the failing check',
    });
    const result = evaluateTransition({
      attempt: attempt(set),
      expectationSet: set,
      facts: [fact(set, 'test', 'failed')],
      timestamp: 10,
      override,
    });

    assert.equal(result.verdict, 'passed');
    assert.deepEqual(result.override, override);
    assert.equal(result.facts[0]?.state, 'failed');
  });

  test('a required expectation with allowOverride false cannot be bypassed', () => {
    const set = createExpectationSet({
      ...expectation(),
      items: [{ ...expectation().items[0]!, allowOverride: false }],
    });
    const override = createRequiredTransitionOverride({
      permissionGranted: true,
      authorizedUserId: 'user-1',
      reason: 'reviewed the failing check',
    });
    const result = evaluateTransition({
      attempt: attempt(set),
      expectationSet: set,
      facts: [fact(set, 'test', 'failed')],
      timestamp: 10,
      override,
    });

    assert.equal(result.verdict, 'blocked');
    assert.match(result.refusal?.reason ?? '', /does not permit/);
    assert.equal(result.override, null);
  });

  test('an override must cover every unmet required item with current failed evidence and permission', () => {
    const base = expectation();
    const set = createExpectationSet({
      ...base,
      expectationSetId: 'set-multiple',
      items: [
        { ...base.items[0]!, id: 'allowed', name: 'allowed', allowOverride: true },
        { ...base.items[0]!, id: 'locked', name: 'locked', allowOverride: false },
      ],
    });
    const override = createRequiredTransitionOverride({
      permissionGranted: true,
      authorizedUserId: 'user-1',
      reason: 'reviewed the failing checks',
    });
    const result = evaluateTransition({
      attempt: attempt(set),
      expectationSet: set,
      facts: [fact(set, 'allowed', 'failed'), fact(set, 'locked', 'failed')],
      timestamp: 10,
      override,
    });

    assert.equal(result.verdict, 'blocked');
    assert.match(result.refusal?.reason ?? '', /does not permit/);
  });

  test('a required override cannot pass missing, unknown, stale, unpinned, uncertain, or mismatched facts', () => {
    const set = expectation();
    const override = createRequiredTransitionOverride({
      permissionGranted: true,
      authorizedUserId: 'user-1',
      reason: 'reviewed the failing check',
    });
    const cases: Array<[string, readonly EvaluatorFact[]]> = [
      ['missing', []],
      ['unknown', [fact(set, 'test', 'unknown')]],
      ['stale', [fact(set, 'test', 'failed', { validity: 'stale' })]],
      ['unpinned', [fact(set, 'test', 'failed', { candidate: { ...candidate, pinned: false } })]],
      ['uncertain', [fact(set, 'test', 'failed', { validity: 'uncertain' })]],
      ['candidate mismatch', [fact(set, 'test', 'failed', { candidate: { ...candidate, id: 'other-tree' } })]],
    ];

    for (const [label, facts] of cases) {
      const result = evaluateTransition({
        attempt: attempt(set),
        expectationSet: set,
        facts,
        timestamp: 10,
        override,
      });
      assert.equal(result.verdict, 'retry', label);
      assert.equal(result.refusal?.nextAction, 'provide-evidence', label);
      assert.match(result.refusal?.reason ?? '', /current evidence/, label);
      assert.equal(result.override, null, label);
    }
  });

  test('stale, uncertain, and unpinned facts do not pass', () => {
    const set = expectation();
    const stale = evaluateTransition({
      attempt: attempt(set),
      expectationSet: set,
      facts: [fact(set, 'test', 'satisfied', { validity: 'stale' })],
      timestamp: 10,
    });
    assert.equal(stale.verdict, 'retry');
    assert.equal(stale.refusal?.required.kind, 'evidence');

    const unpinnedCandidate = { ...candidate, pinned: false };
    const unpinned = evaluateTransition({
      attempt: attempt(set, { candidate: unpinnedCandidate }),
      expectationSet: set,
      facts: [fact(set, 'test', 'satisfied', { candidate: unpinnedCandidate })],
      timestamp: 10,
    });
    assert.equal(unpinned.verdict, 'retry');
    assert.equal(unpinned.facts[0]?.state, 'unknown');

    const unpinnedProvenance = evaluateTransition({
      attempt: attempt(set),
      expectationSet: set,
      facts: [fact(set, 'test', 'satisfied', { candidate: { ...candidate, pinned: false } })],
      timestamp: 10,
    });
    assert.equal(unpinnedProvenance.verdict, 'retry');
    assert.equal(unpinnedProvenance.facts[0]?.state, 'unknown');
    assert.equal(unpinnedProvenance.facts[0]?.provenance.validity, 'uncertain');
  });

  test('a missing mandatory answer waits for the user', () => {
    const set = expectation('question-1', 'required', 'mandatory-question');
    const result = evaluateTransition({
      attempt: attempt(set),
      expectationSet: set,
      facts: [],
      timestamp: 10,
    });

    assert.equal(result.verdict, 'waiting-for-human');
    assert.equal(result.refusal?.responsibleActor, 'user');
    assert.equal(result.refusal?.nextAction, 'provide-answer');
    assert.equal(result.refusal?.required.kind, 'structured-answer');
  });

  test('advisory failures pass but absolute failures remain non-overridable', () => {
    const advisory = expectation('style', 'advisory');
    const advisoryResult = evaluateTransition({
      attempt: attempt(advisory),
      expectationSet: advisory,
      facts: [fact(advisory, 'style', 'failed')],
      timestamp: 10,
    });
    assert.equal(advisoryResult.verdict, 'passed');

    const absolute = createExpectationSet({
      ...advisory,
      expectationSetId: 'set-absolute',
      items: [{ ...advisory.items[0]!, id: 'hard', name: 'hard', enforcement: 'absolute' }],
    });
    const override = createRequiredTransitionOverride({
      permissionGranted: true,
      authorizedUserId: 'user',
      reason: 'verified outside the suite',
    });
    const result = evaluateTransition({
      attempt: attempt(absolute, { expectationSetId: absolute.expectationSetId }),
      expectationSet: absolute,
      facts: [fact(absolute, 'hard', 'failed')],
      timestamp: 10,
      override,
    });
    assert.equal(result.verdict, 'blocked');
    assert.equal(result.override, null);
    assert.equal(result.refusal?.nextAction, 'escalate');
  });

  test('invalid identity and non-increasing attempts are recorded as failed evaluations', () => {
    const set = expectation();
    const invalidIdentity = evaluateTransition({
      attempt: attempt(set, { expectationSetId: 'other-set' }),
      expectationSet: set,
      facts: [fact(set, 'test', 'satisfied')],
      timestamp: 10,
    });
    assert.equal(invalidIdentity.verdict, 'failed');
    assert.match(invalidIdentity.refusal?.reason ?? '', /not pinned/);

    const previous = evaluateTransition({
      attempt: attempt(set),
      expectationSet: set,
      facts: [fact(set, 'test', 'failed')],
      timestamp: 10,
    });
    const repeated = evaluateTransition({
      attempt: attempt(set),
      expectationSet: set,
      facts: [fact(set, 'test', 'failed')],
      timestamp: 11,
      previous,
    });
    assert.equal(repeated.verdict, 'failed');
    assert.match(repeated.refusal?.reason ?? '', /must increase/);
  });
});

test('integration expectation sets require a canonical source identity', () => {
  const integration = { requires: ['test'], allowOverride: false };
  const verify = [{ name: 'test', command: 'npm test' }];
  const source = {
    sourceKind: 'workspace-declaration' as const,
    locator: resolvePath('workspace.json'),
    nativeRevision: 'git:head;content:source',
    contentDigest: 'source',
  };

  assert.throws(
    () => buildIntegrationExpectationSet(integration, verify, undefined as never),
    /canonical source identity/,
  );
  assert.throws(
    () => buildIntegrationExpectationSet(integration, verify, { ...source, locator: 'workspace.json' }),
    /absolute locators/,
  );
  const set = buildIntegrationExpectationSet(integration, verify, source);
  assert.match(set.expectationSetId, /^workspace-integration:/);
  assert.doesNotMatch(set.expectationSetId, /unbound-source/);
  assert.equal(set.items[0]?.allowOverride, false);
});

test('schema-v3 expectation items come only from the core manifest', () => {
  const source = {
    sourceKind: 'workspace-declaration' as const,
    locator: resolvePath('workspace.json'),
    nativeRevision: 'git:head;content:source',
    contentDigest: 'source',
  };
  const guardrail: WorkspaceGuardrail = {
    id: 'unknown-expectation',
    kind: 'evidence-present',
    attach: { step: 'review' },
    enforcement: 'required',
    allowOverride: false,
    parameters: { expectationItem: 'not-in-core-manifest' },
    correction: { maxRuns: 2, onExhausted: 'waiting-for-human' },
  };

  const result = buildGuardrailExpectationSet(
    { requires: [], allowOverride: false },
    [],
    source,
    [guardrail],
    { workItemId: null, sourceStepId: 'implementation', targetStepId: 'review' },
  );
  assert.deepEqual(result.expectationSet.items, []);
  assert.deepEqual(result.conflicts, ['not-in-core-manifest']);
});

if (false) {
  // @ts-expect-error A canonical source is required by the public builder boundary.
  buildIntegrationExpectationSet({ requires: [], allowOverride: false }, []);
}
