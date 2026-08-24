import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createExpectationSet,
  type CandidateIdentity,
  type EvidenceItem,
  type ExpectationItem,
  type ExpectationSet,
  type HarnessEvent,
  type WorkspaceGuardrail,
} from '@awos/protocol';
import {
  CORE_EVALUATOR_KINDS,
  CORE_EVALUATOR_REGISTRY,
  CORE_EVALUATOR_VERSION,
  EVALUATOR_DIAGNOSTIC_MAX_CHARS,
  coreExpectationManifestEntry,
  coreEvaluator,
  evaluateGuardrail,
  evaluateIntegrationTransition,
  evaluateTransition,
  evaluateVerificationChecks,
} from '../index.js';

const candidate: CandidateIdentity = {
  kind: 'working-tree',
  id: 'tree-a',
  revision: 'commit-a',
  digest: 'tree-a',
  pinned: true,
};

const verify = [{ name: 'test', command: 'npm test' }];

let sequence = 0;

function expectation(
  id: string,
  kind: ExpectationItem['kind'] = 'requirement',
  enforcement: ExpectationItem['enforcement'] = 'required',
  authority?: ExpectationItem['authority'],
): ExpectationSet {
  const item: ExpectationItem = {
    id,
    kind,
    name: id,
    enforcement,
    allowOverride: enforcement === 'required',
    reference: {
      sourceKind: kind === 'mandatory-question' || kind === 'human-attestation' ? 'human-answer' : 'repository-file',
      locator: `identity://${id}`,
      nativeRevision: 'revision-a',
      contentDigest: `digest-${id}`,
      selector: null,
    },
    ...(authority === undefined ? {} : { authority }),
  };
  return createExpectationSet({
    expectationSetId: 'set-a',
    manifestDigest: 'manifest-a',
    items: [item],
    authority: { sourceOwner: 'project', pinnedBy: 'user' },
    supersedes: null,
  });
}

function guardrail(
  kind: WorkspaceGuardrail['kind'],
  parameters: WorkspaceGuardrail['parameters'],
): WorkspaceGuardrail {
  return {
    id: `guardrail-${kind}`,
    kind,
    attach: { step: 'review' },
    enforcement: 'required',
    allowOverride: false,
    parameters,
    correction: { maxRuns: 2, onExhausted: 'waiting-for-human' },
  };
}

function evidence(
  id: string,
  overrides: Partial<EvidenceItem> = {},
): EvidenceItem {
  return {
    id,
    runId: null,
    workItemId: null,
    threadId: 'thread-a',
    kind: 'command',
    ref: { eventId: null, url: null, label: 'npm test' },
    summary: 'ignored claim text',
    state: { commit: 'commit-a', tree: 'tree-a', dirty: false },
    check: { name: 'test', passed: true, exitCode: 0 },
    source: 'codex',
    at: ++sequence,
    ...overrides,
  };
}

function event(body: Record<string, unknown>): HarnessEvent {
  return {
    id: `event-${++sequence}`,
    seq: sequence,
    threadId: 'thread-a',
    agent: null,
    turnId: null,
    ts: 1_000 + sequence,
    ...body,
  } as unknown as HarnessEvent;
}

function answerEvent(overrides: Record<string, unknown> = {}): HarnessEvent {
  return event({
    kind: 'answer.recorded',
    answerId: 'answer-a',
    expectationItemId: 'question-a',
    expectationSetId: 'set-a',
    actor: 'user',
    authority: 'user',
    answer: { type: 'choice', value: 'keep' },
    candidate,
    evidenceIds: [],
    recordedAt: 1_010,
    ...overrides,
  });
}

function attestationEvent(overrides: Record<string, unknown> = {}): HarnessEvent {
  return event({
    kind: 'human.attestation.recorded',
    attestationId: 'attestation-a',
    expectationItemId: 'attestation-a',
    expectationSetId: 'set-a',
    actor: 'user',
    authority: 'user',
    statement: 'I reviewed the current candidate.',
    candidate,
    evidenceIds: ['evidence-a'],
    recordedAt: 1_011,
    ...overrides,
  });
}

function verificationFact(overrides: Partial<EvidenceItem> = {}, requirementId = 'test') {
  const fact = evaluateVerificationChecks({
    checkNames: ['test'],
    verify,
    evidence: overrides === undefined ? [] : [evidence('evidence-a', overrides)],
    candidate,
    expectationSetId: 'set-a',
  }).facts[0]!;
  return { ...fact, requirementId };
}

describe('core evaluator registry', () => {
  test('pins human-attestation identities in the core expectation manifest', () => {
    assert.equal(coreExpectationManifestEntry('review.semantic')?.kind, 'human-attestation');
  });

  test('is static, closed, and excludes model and pixel evaluators', () => {
    assert.deepEqual(CORE_EVALUATOR_KINDS, [
      'verification',
      'evidence-present',
      'mandatory-answer',
      'human-attestation',
    ]);
    assert.deepEqual(Object.keys(CORE_EVALUATOR_REGISTRY), [...CORE_EVALUATOR_KINDS]);
    assert.equal(coreEvaluator('pixel-diff'), null);
    assert.equal(coreEvaluator('model-rubric'), null);
  });

  test('unknown evaluator kinds become bounded unknown facts instead of throwing', () => {
    const result = evaluateGuardrail({
      guardrail: { ...guardrail('verification', { checks: ['test'] }), kind: 'pixel-diff' },
      expectationSet: expectation('scope'),
      candidate,
      verify,
      evidence: [],
      events: [],
    });

    assert.equal(result[0]?.state, 'unknown');
    assert.equal(result[0]?.provenance.validity, 'unavailable');
    assert.equal(result[0]?.provenance.evaluatorVersion, '1');
    assert.equal(result[0]?.provenance.evaluatorKind, 'core');
    assert.ok((result[0]?.detail?.length ?? 0) <= EVALUATOR_DIAGNOSTIC_MAX_CHARS);
  });
});

describe('verification evaluator', () => {
  test('keeps satisfied, missing, failed, and stale distinct', () => {
    const satisfied = evaluateVerificationChecks({
      checkNames: ['test'], verify, evidence: [evidence('satisfied')], candidate, expectationSetId: 'set-a',
    });
    assert.equal(satisfied.requirements[0]?.state, 'satisfied');
    assert.equal(satisfied.facts[0]?.state, 'satisfied');
    assert.equal(satisfied.facts[0]?.observation, 'satisfied');

    const missing = evaluateVerificationChecks({
      checkNames: ['test'], verify, evidence: [], candidate, expectationSetId: 'set-a',
    });
    assert.equal(missing.requirements[0]?.state, 'missing');
    assert.equal(missing.facts[0]?.observation, 'missing');
    assert.equal(missing.facts[0]?.provenance.validity, 'unavailable');

    const failed = evaluateVerificationChecks({
      checkNames: ['test'], verify,
      evidence: [evidence('failed', { check: { name: 'test', passed: false, exitCode: 1 } })],
      candidate,
      expectationSetId: 'set-a',
    });
    assert.equal(failed.requirements[0]?.state, 'failed');
    assert.equal(failed.facts[0]?.state, 'failed');
    assert.equal(failed.facts[0]?.observation, 'failed');

    const stale = evaluateVerificationChecks({
      checkNames: ['test'], verify,
      evidence: [evidence('stale', { state: { commit: 'commit-old', tree: 'tree-old', dirty: false } })],
      candidate,
      expectationSetId: 'set-a',
    });
    assert.equal(stale.requirements[0]?.state, 'stale');
    assert.equal(stale.facts[0]?.state, 'unknown');
    assert.equal(stale.facts[0]?.observation, 'stale');
    assert.equal(stale.facts[0]?.provenance.validity, 'stale');
  });

  test('requires the declared named command, not a similar check or summary', () => {
    const result = evaluateVerificationChecks({
      checkNames: ['test'], verify,
      evidence: [evidence('wrong', { check: { name: 'lint', passed: true, exitCode: 0 } })],
      candidate,
      expectationSetId: 'set-a',
    });
    assert.equal(result.requirements[0]?.state, 'missing');
    assert.equal(result.facts[0]?.observation, 'missing');
  });
});

test('legacy named integration checks use the shared verification evaluator and candidate identity', () => {
  const set = expectation('test');
  const decision = evaluateIntegrationTransition({
    integration: { requires: ['test'], allowOverride: false },
    verify,
    evidence: [evidence('integration-evidence')],
    candidateTree: candidate.digest,
    attempt: {
      transitionId: 'integration-a',
      attempt: 1,
      runId: null,
      actor: 'user',
      sourceStepId: 'lane',
      targetStepId: 'workspace',
      expectationSetId: set.expectationSetId,
      candidate,
      evidenceIds: [],
    },
    expectationSet: set,
    timestamp: 40,
  });

  assert.equal(decision.requirements[0]?.state, 'satisfied');
  assert.equal(decision.evaluation.facts[0]?.provenance.evaluatorId, 'verification');
  assert.equal(decision.evaluation.facts[0]?.provenance.evaluatorVersion, CORE_EVALUATOR_VERSION);

  const stale = evaluateIntegrationTransition({
    integration: { requires: ['test'], allowOverride: false },
    verify,
    evidence: [evidence('integration-stale', { state: { commit: 'commit-old', tree: 'tree-old', dirty: false } })],
    candidateTree: 'tree-new',
    attempt: {
      transitionId: 'integration-b',
      attempt: 1,
      runId: null,
      actor: 'user',
      sourceStepId: 'lane',
      targetStepId: 'workspace',
      expectationSetId: set.expectationSetId,
      candidate: { ...candidate, id: 'tree-new', digest: 'tree-new' },
      evidenceIds: [],
    },
    expectationSet: set,
    timestamp: 41,
  });
  assert.equal(stale.requirements[0]?.state, 'stale');
  assert.equal(stale.evaluation.facts[0]?.observation, 'stale');
});

describe('evidence-present evaluator', () => {
  test('requires a concrete evidence kind and a pinned candidate identity', () => {
    const set = expectation('scope');
    const valid = evaluateGuardrail({
      guardrail: guardrail('evidence-present', { expectationItem: 'scope', evidenceKind: 'command' }),
      expectationSet: set,
      candidate,
      verify,
      evidence: [evidence('evidence-a')],
      events: [],
    });
    assert.equal(valid[0]?.state, 'satisfied');

    const summaryOnly = evaluateGuardrail({
      guardrail: guardrail('evidence-present', { expectationItem: 'scope' }),
      expectationSet: set,
      candidate,
      verify,
      evidence: [evidence('note', {
        kind: 'note',
        check: null,
        ref: { eventId: null, url: null, label: 'claim' },
      })],
      events: [],
    });
    assert.equal(summaryOnly[0]?.state, 'unknown');
    assert.equal(summaryOnly[0]?.observation, 'missing');

    const unpinned = evaluateGuardrail({
      guardrail: guardrail('evidence-present', { expectationItem: 'scope' }),
      expectationSet: set,
      candidate: { ...candidate, pinned: false, digest: null },
      verify,
      evidence: [evidence('evidence-b')],
      events: [],
    });
    assert.equal(unpinned[0]?.state, 'unknown');
    assert.equal(unpinned[0]?.provenance.validity, 'unpinned');
  });
});

describe('mandatory-answer evaluator', () => {
  test('accepts only a typed answer from the declared user authority', () => {
    const set = expectation('question-a', 'mandatory-question');
    const input = {
      guardrail: guardrail('mandatory-answer', { expectationItem: 'question-a', authority: 'user' }),
      expectationSet: set,
      candidate,
      verify,
      evidence: [],
    };
    const missing = evaluateGuardrail({ ...input, events: [] });
    assert.equal(missing[0]?.state, 'unknown');
    assert.equal(missing[0]?.observation, 'missing');

    const workerProseAndApproval = evaluateGuardrail({
      ...input,
      events: [
        event({ kind: 'message.completed', itemId: 'message-a', text: 'keep it' }),
        event({ kind: 'approval.resolved', approvalId: 'approval-a', optionId: 'allow', behavior: 'allow', auto: false }),
      ],
    });
    assert.equal(workerProseAndApproval[0]?.state, 'unknown');

    const answer = evaluateGuardrail({ ...input, events: [answerEvent({ expectationItemId: 'question-a' })] });
    assert.equal(answer[0]?.state, 'satisfied');
    assert.equal(answer[0]?.provenance.evaluatorKind, 'mandatory-answer');

    const conflictingAnswer = evaluateGuardrail({
      ...input,
      events: [
        answerEvent({ expectationItemId: 'question-a' }),
        answerEvent({ expectationItemId: 'question-a', answer: { type: 'choice', value: 'change' } }),
      ],
    });
    assert.equal(conflictingAnswer[0]?.state, 'unknown');
    assert.match(conflictingAnswer[0]?.detail ?? '', /Conflicting definitions/);

    const wrongActor = evaluateGuardrail({
      ...input,
      events: [answerEvent({ expectationItemId: 'question-a', actor: 'codex' })],
    });
    assert.equal(wrongActor[0]?.state, 'unknown');

    const wrongCandidate = evaluateGuardrail({
      ...input,
      events: [answerEvent({ expectationItemId: 'question-a', candidate: { ...candidate, id: 'tree-b', digest: 'tree-b' } })],
    });
    assert.equal(wrongCandidate[0]?.state, 'unknown');
    assert.equal(wrongCandidate[0]?.provenance.validity, 'stale');
  });

  test('selects the latest answer only within the active expectation and item', () => {
    const set = expectation('question-a', 'mandatory-question');
    const input = {
      guardrail: guardrail('mandatory-answer', { expectationItem: 'question-a', authority: 'user' }),
      expectationSet: set,
      candidate,
      verify,
      evidence: [],
    };
    const current = answerEvent({
      answerId: 'answer-current',
      recordedAt: 100,
      evidenceIds: ['answer-current-evidence'],
    });

    const currentWithLaterOldSet = evaluateGuardrail({
      ...input,
      events: [current, answerEvent({
        answerId: 'answer-old-set',
        expectationSetId: 'set-old',
        recordedAt: 200,
      })],
    });
    assert.equal(currentWithLaterOldSet[0]?.state, 'satisfied');
    assert.deepEqual(currentWithLaterOldSet[0]?.evidenceIds, ['answer-current-evidence']);

    const onlyOldSet = evaluateGuardrail({
      ...input,
      events: [answerEvent({ answerId: 'answer-old-only', expectationSetId: 'set-old', recordedAt: 200 })],
    });
    assert.equal(onlyOldSet[0]?.state, 'unknown');
    assert.equal(onlyOldSet[0]?.observation, 'missing');

    const laterCurrent = evaluateGuardrail({
      ...input,
      events: [current, answerEvent({
        answerId: 'answer-current-later',
        recordedAt: 300,
        evidenceIds: ['answer-current-later-evidence'],
      })],
    });
    assert.equal(laterCurrent[0]?.state, 'satisfied');
    assert.deepEqual(laterCurrent[0]?.evidenceIds, ['answer-current-later-evidence']);

    for (const [label, correction] of [
      ['actor', { actor: 'codex' }],
      ['candidate', { candidate: { ...candidate, id: 'tree-b', digest: 'tree-b' } }],
    ] as const) {
      const wrongCurrent = evaluateGuardrail({
        ...input,
        events: [current, answerEvent({
          answerId: `answer-wrong-${label}`,
          recordedAt: 400,
          ...correction,
        })],
      });
      assert.equal(wrongCurrent[0]?.state, 'unknown', `${label} correction must be evaluated as the latest active record`);
    }

    for (const [label, correction] of [
      ['actor', { actor: 'codex' }],
      ['candidate', { candidate: { ...candidate, id: 'tree-b', digest: 'tree-b' } }],
    ] as const) {
      const oldSetCorrection = evaluateGuardrail({
        ...input,
        events: [current, answerEvent({
          answerId: `answer-old-wrong-${label}`,
          expectationSetId: 'set-old',
          recordedAt: 500,
          ...correction,
        })],
      });
      assert.equal(oldSetCorrection[0]?.state, 'satisfied', `${label} old-set record must not shadow the active answer`);
    }
  });
});

describe('human-attestation evaluator', () => {
  test('requires an explicit user record and current concrete evidence', () => {
    const set = expectation('attestation-a', 'human-attestation', 'required', 'user');
    const input = {
      guardrail: guardrail('human-attestation', { expectationItem: 'attestation-a', authority: 'user' }),
      expectationSet: set,
      candidate,
      verify,
      evidence: [evidence('evidence-a')],
    };
    const valid = evaluateGuardrail({ ...input, events: [attestationEvent()] });
    assert.equal(valid[0]?.state, 'satisfied');

    const wrongActor = evaluateGuardrail({ ...input, events: [attestationEvent({ actor: 'codex' })] });
    assert.equal(wrongActor[0]?.state, 'unknown');

    const wrongExpectation = evaluateGuardrail({ ...input, events: [attestationEvent({ expectationSetId: 'other-set' })] });
    assert.equal(wrongExpectation[0]?.state, 'unknown');

    const staleCandidate = evaluateGuardrail({
      ...input,
      events: [attestationEvent({ candidate: { ...candidate, id: 'tree-b', digest: 'tree-b' } })],
    });
    assert.equal(staleCandidate[0]?.state, 'unknown');
    assert.equal(staleCandidate[0]?.provenance.validity, 'stale');

    const missingEvidence = evaluateGuardrail({
      ...input,
      evidence: [],
      events: [attestationEvent()],
    });
    assert.equal(missingEvidence[0]?.state, 'unknown');

    const conflictingAttestation = evaluateGuardrail({
      ...input,
      events: [
        attestationEvent(),
        attestationEvent({ statement: 'A different statement.' }),
      ],
    });
    assert.equal(conflictingAttestation[0]?.state, 'unknown');
    assert.match(conflictingAttestation[0]?.detail ?? '', /Conflicting definitions/);
  });

  test('does not carry an attestation across an expectation-set supersession', () => {
    const set = expectation('attestation-a', 'human-attestation', 'required', 'user');
    const input = {
      guardrail: guardrail('human-attestation', { expectationItem: 'attestation-a', authority: 'user' }),
      expectationSet: set,
      candidate,
      verify,
      evidence: [evidence('evidence-a')],
      events: [
        attestationEvent(),
        event({
          kind: 'expectation.set.superseded',
          expectationSetId: 'set-a',
          supersededByExpectationSetId: 'set-b',
          supersedesTransitionId: 'transition-a',
        }),
      ],
    };
    const result = evaluateGuardrail(input);
    assert.equal(result[0]?.state, 'unknown');
    assert.equal(result[0]?.provenance.validity, 'stale');
  });

  test('selects the latest attestation only within the active expectation and item', () => {
    const set = expectation('attestation-a', 'human-attestation', 'required', 'user');
    const input = {
      guardrail: guardrail('human-attestation', { expectationItem: 'attestation-a', authority: 'user' }),
      expectationSet: set,
      candidate,
      verify,
      evidence: [evidence('evidence-a'), evidence('evidence-b')],
    };
    const current = attestationEvent({
      attestationId: 'attestation-current',
      recordedAt: 100,
      evidenceIds: ['evidence-a'],
    });

    const currentWithLaterOldSet = evaluateGuardrail({
      ...input,
      events: [current, attestationEvent({
        attestationId: 'attestation-old-set',
        expectationSetId: 'set-old',
        recordedAt: 200,
      })],
    });
    assert.equal(currentWithLaterOldSet[0]?.state, 'satisfied');
    assert.deepEqual(currentWithLaterOldSet[0]?.evidenceIds, ['evidence-a']);

    const onlyOldSet = evaluateGuardrail({
      ...input,
      events: [attestationEvent({ attestationId: 'attestation-old-only', expectationSetId: 'set-old', recordedAt: 200 })],
    });
    assert.equal(onlyOldSet[0]?.state, 'unknown');
    assert.equal(onlyOldSet[0]?.observation, 'missing');

    const laterCurrent = evaluateGuardrail({
      ...input,
      events: [current, attestationEvent({
        attestationId: 'attestation-current-later',
        recordedAt: 300,
        evidenceIds: ['evidence-b'],
      })],
    });
    assert.equal(laterCurrent[0]?.state, 'satisfied');
    assert.deepEqual(laterCurrent[0]?.evidenceIds, ['evidence-b']);

    for (const [label, correction] of [
      ['actor', { actor: 'codex' }],
      ['candidate', { candidate: { ...candidate, id: 'tree-b', digest: 'tree-b' } }],
    ] as const) {
      const wrongCurrent = evaluateGuardrail({
        ...input,
        events: [current, attestationEvent({
          attestationId: `attestation-wrong-${label}`,
          recordedAt: 400,
          ...correction,
        })],
      });
      assert.equal(wrongCurrent[0]?.state, 'unknown', `${label} correction must be evaluated as the latest active record`);
    }

    for (const [label, correction] of [
      ['actor', { actor: 'codex' }],
      ['candidate', { candidate: { ...candidate, id: 'tree-b', digest: 'tree-b' } }],
    ] as const) {
      const oldSetCorrection = evaluateGuardrail({
        ...input,
        events: [current, attestationEvent({
          attestationId: `attestation-old-wrong-${label}`,
          expectationSetId: 'set-old',
          recordedAt: 500,
          ...correction,
        })],
      });
      assert.equal(oldSetCorrection[0]?.state, 'satisfied', `${label} old-set record must not shadow the active attestation`);
    }
  });
});

describe('human authority and transition ownership', () => {
  test('a typed answer opens the planning transition while worker prose does not', () => {
    const set = expectation('question-a', 'mandatory-question', 'required', 'user');
    const base = {
      transitionId: 'planning-a',
      attempt: 1,
      runId: null,
      actor: 'user' as const,
      sourceStepId: 'plan',
      targetStepId: 'review',
      expectationSetId: set.expectationSetId,
      candidate,
      evidenceIds: [],
    };
    const guardrailInput = {
      guardrail: guardrail('mandatory-answer', { expectationItem: 'question-a', authority: 'user' }),
      expectationSet: set,
      candidate,
      verify,
      evidence: [],
    };
    const waiting = evaluateTransition({
      attempt: base,
      expectationSet: set,
      facts: evaluateGuardrail({ ...guardrailInput, events: [event({ kind: 'message.completed', itemId: 'm', text: 'answer' })] }),
      timestamp: 20,
    });
    assert.equal(waiting.verdict, 'waiting-for-human');

    const opened = evaluateTransition({
      attempt: base,
      expectationSet: set,
      facts: evaluateGuardrail({ ...guardrailInput, events: [answerEvent({ expectationItemId: 'question-a' })] }),
      timestamp: 21,
    });
    assert.equal(opened.verdict, 'passed');
  });

  test('required overrides remain core-owned and cannot bypass explicit user final authority', () => {
    const overridable = expectation('question-a', 'mandatory-question');
    const override = {
      enforcement: 'required' as const,
      permission: 'explicit' as const,
      permissionGranted: true as const,
      actor: 'user' as const,
      authorizedUserId: 'user-a',
      reason: 'reviewed',
    };
    const overridableResult = evaluateTransition({
      attempt: {
        transitionId: 'transition-a', attempt: 1, runId: null, actor: 'user', sourceStepId: 'plan', targetStepId: 'review',
        expectationSetId: overridable.expectationSetId, candidate, evidenceIds: [],
      },
      expectationSet: overridable,
      facts: [verificationFact({ check: { name: 'test', passed: false, exitCode: 1 } }, 'question-a')],
      timestamp: 30,
      override,
    });
    assert.equal(overridableResult.verdict, 'passed');

    const absoluteHuman = expectation('question-a', 'mandatory-question', 'required', 'user');
    const absoluteResult = evaluateTransition({
      attempt: {
        transitionId: 'transition-b', attempt: 1, runId: null, actor: 'user', sourceStepId: 'plan', targetStepId: 'review',
        expectationSetId: absoluteHuman.expectationSetId, candidate, evidenceIds: [],
      },
      expectationSet: absoluteHuman,
      facts: [verificationFact({ check: { name: 'test', passed: false, exitCode: 1 } }, 'question-a')],
      timestamp: 31,
      override,
    });
    assert.equal(absoluteResult.verdict, 'blocked');
    assert.match(absoluteResult.refusal?.reason ?? '', /cannot be overridden/i);
  });
});
