import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type {
  CandidateIdentity,
  EvaluatorCapability,
  EvaluatorFact,
  EvaluatorFactState,
  EvidenceItem,
  ExpectationSet,
  HarnessEvent,
  ReferenceIdentity,
  RequirementEnforcement,
  RequirementResult,
  TransitionAttempt,
  TransitionEvaluation,
  TransitionNextAction,
  TransitionOverride,
  TransitionRefusal,
  TransitionVerdict,
  VerifyCommand,
  WorkspaceIntegration,
  WorkspaceGuardrail,
} from '@awos/protocol';
import {
  createExpectationSet,
  createTransitionEvaluation,
  isCurrentPinnedEvaluatorFact,
  isUserFinalAuthority,
} from '@awos/protocol';
import { coreExpectationManifestEntry } from '../workspace/manifest.js';
import {
  evaluateOwnedGuardrails,
  evaluateGuardrails,
  evaluateVerificationChecks,
} from './evaluators.js';

/**
 * The existing integration input. It remains small and is still useful to callers that only
 * want to render the current gate without creating an event.
 */
export interface GateInput {
  integration: WorkspaceIntegration;
  /** The project's named commands, for reporting what a requirement actually runs. */
  verify: readonly VerifyCommand[];
  /** Every evidence item this thread has recorded. */
  evidence: readonly EvidenceItem[];
  /** The tree being integrated, or null when it could not be established. */
  candidateTree: string | null;
}

export interface GateDecision {
  allowed: boolean;
  requirements: RequirementResult[];
}

/** Input for the shared transition evaluator. */
export interface TransitionInput {
  attempt: TransitionAttempt;
  expectationSet: ExpectationSet;
  facts: readonly EvaluatorFact[];
  /** A caller supplies the timestamp so this function stays deterministic. */
  timestamp: number;
  override?: TransitionOverride | null;
  enforcement?: readonly RequirementEnforcement[];
  previous?: TransitionEvaluation;
}

/** Integration is the reserved verification transition in the shared contract. */
export interface IntegrationTransitionInput extends GateInput {
  attempt: TransitionAttempt;
  expectationSet: ExpectationSet;
  timestamp: number;
  override?: TransitionOverride | null;
  /** Set when a caller attempted an illegal override; the attempt is still recorded. */
  invalidOverrideReason?: string;
  /** Set when replay or another boundary found an invalid transition input. */
  invalidAttemptReason?: string;
  /** Effective schema-v3 guardrails attached to lane -> workspace, including the reserved check. */
  guardrails?: readonly WorkspaceGuardrail[];
  /** Append-only records used by human and evidence evaluators. */
  events?: readonly HarnessEvent[];
  /** Independent semantic capabilities supplied by the host, never by workspace config. */
  evaluatorCapabilities?: readonly EvaluatorCapability[];
  producingWorkerProfileId?: string | null;
  producingWorkerInstanceId?: string | null;
  evaluatorInstanceId?: string | null;
}

export interface GuardrailExpectationSetResult {
  expectationSet: ExpectationSet;
  conflicts: readonly string[];
}

/** Full decision returned by the generalized gate for a guarded transition. */
export interface TransitionDecision extends GateDecision {
  evaluation: TransitionEvaluation;
  verdict: TransitionVerdict;
  refusal: TransitionRefusal | null;
}

/** Inputs for a transition whose facts come from the closed core evaluator registry. */
export interface GuardedTransitionInput extends Omit<TransitionInput, 'facts'> {
  guardrails: readonly WorkspaceGuardrail[];
  verify: readonly VerifyCommand[];
  evidence: readonly EvidenceItem[];
  events: readonly HarnessEvent[];
  evaluatorCapabilities?: readonly EvaluatorCapability[];
  producingWorkerProfileId?: string | null;
  producingWorkerInstanceId?: string | null;
  evaluatorInstanceId?: string | null;
}

/**
 * Evaluate one transition from evaluator facts.
 *
 * Evaluators only report facts. This function is the authority that maps those facts and the
 * pinned enforcement levels to a workflow verdict. A fact whose source is stale, unpinned,
 * unavailable, or uncertain is normalized to `unknown`, even if an adapter claimed it was
 * satisfied.
 */
export function evaluateTransition(input: TransitionInput): TransitionEvaluation {
  const enforcement = input.enforcement
    ? [...input.enforcement]
    : input.expectationSet.items.map((item) => ({
        requirementId: item.id,
        enforcement: item.enforcement,
        allowOverride: item.allowOverride,
        ...(item.authority === undefined ? {} : { authority: item.authority }),
      }));
  const facts = normalizeFacts(input);
  const provenance = facts.map((fact) => fact.provenance);
  const base = {
    ...input.attempt,
    facts,
    provenance,
    enforcement,
    timestamp: input.timestamp,
    supersedesTransitionId: input.attempt.supersedesTransitionId ?? null,
  };

  const invalid = validateTransitionInput(input, enforcement);
  if (invalid !== null) {
    return refused(base, 'failed', invalid);
  }

  const states = input.expectationSet.items.map((item) => {
    const fact = facts.find((candidate) => candidate.requirementId === item.id);
    return { item, fact: fact as EvaluatorFact };
  });
  const unmet = states.filter(({ item, fact }) => {
    const state = factState(fact);
    return item.enforcement !== 'advisory' && state !== 'satisfied';
  });
  const unknown = states.filter(({ fact }) => factState(fact) === 'unknown');
  const absoluteUnmet = unmet.filter(({ item }) => item.enforcement === 'absolute' || isUserFinalAuthority(item));
  const hasAbsoluteUncertainty = absoluteUnmet.some(({ fact }) => factState(fact) === 'unknown');
  const requiredUnmet = unmet.filter(({ item }) => item.enforcement === 'required');
  const nonOverridableRequired = requiredUnmet.filter(({ item }) => item.allowOverride !== true || isUserFinalAuthority(item));
  const advisoryUncertainty = unknown.some(({ item }) => item.enforcement === 'advisory');
  const forbiddenAbsoluteModel = states.filter(({ item, fact }) =>
    item.enforcement === 'absolute' &&
    (fact.provenance.evaluatorClass === 'model' || fact.provenance.evaluatorKind === 'model-rubric'),
  );

  if (forbiddenAbsoluteModel.length > 0) {
    return refused(base, 'blocked', {
      unmetRequirementIds: forbiddenAbsoluteModel.map(({ item }) => item.id),
      reason: 'Model-rubric evaluations cannot use absolute enforcement.',
      required: evidenceRequirement(
        forbiddenAbsoluteModel.map(({ item }) => item.id),
        'Change the semantic guardrail to advisory or required enforcement.',
      ),
      responsibleActor: input.attempt.actor,
      nextAction: 'escalate',
      retryable: false,
    });
  }

  // An override is a legal escape only for a current, pinned, known required failure. It
  // cannot turn an absolute refusal, an invalid attempt, or an unresolved evaluator into a
  // silent pass. Advisory facts still need trustworthy provenance because the override does
  // not cover them.
  if (input.override !== null && input.override !== undefined) {
    const hasRequiredItem = input.expectationSet.items.some((item) => item.enforcement === 'required');
    const allFactsCurrentPinned = states.every(({ fact }) =>
      factState(fact) !== 'unknown' && isCurrentPinnedEvaluatorFact(fact, input.attempt),
    );
    const eligibleRequiredFailure =
      requiredUnmet.length > 0 &&
      requiredUnmet.every(({ fact }) =>
        factState(fact) === 'failed' && isCurrentPinnedEvaluatorFact(fact, input.attempt),
      ) &&
      requiredUnmet.every(({ item }) => item.allowOverride === true && !isUserFinalAuthority(item));
    if (
      hasRequiredItem &&
      absoluteUnmet.length === 0 &&
      eligibleRequiredFailure &&
      allFactsCurrentPinned
    ) {
      return createTransitionEvaluation({
        ...base,
        verdict: 'passed',
        refusal: null,
        override: input.override,
      });
    }
    if (!hasRequiredItem || absoluteUnmet.length > 0 || nonOverridableRequired.length > 0) {
      return refused(base, 'blocked', {
        unmetRequirementIds: [...new Set(unmet.map(({ item }) => item.id))],
        reason: absoluteUnmet.length > 0 || nonOverridableRequired.length > 0
          ? absoluteUnmet.length > 0
            ? 'An absolute expectation cannot be overridden.'
            : 'A required expectation does not permit an explicit override.'
          : 'An override is only valid for a required expectation.',
        required: evidenceRequirement(unmet.map(({ item }) => item.id), 'Provide evidence for the unmet expectation before requesting an override.'),
        responsibleActor: input.attempt.actor,
        nextAction: 'escalate',
        retryable: false,
      });
    }
    if (requiredUnmet.length === 0 && allFactsCurrentPinned && !advisoryUncertainty) {
      return refused(base, 'blocked', {
        unmetRequirementIds: [],
        reason: 'An override must cover a current failed required expectation.',
        required: evidenceRequirement([], 'Request an override only after a required expectation fails with current evidence.'),
        responsibleActor: input.attempt.actor,
        nextAction: 'escalate',
        retryable: false,
      });
    }
  }

  const humanAnswer = requiredUnmet.find(({ item, fact }) =>
    (item.kind === 'mandatory-question' || item.kind === 'human-attestation' || isUserFinalAuthority(item)) &&
    factState(fact) === 'unknown',
  );
  // A user-owned answer is non-overridable, but its absence is still a request for the
  // user rather than a terminal policy failure. An attempted override was handled above.
  if (humanAnswer) {
    return refused(base, 'waiting-for-human', refusalFor(
      requiredUnmet,
      'A required planning answer is missing or not pinned as authorized evidence.',
      'provide-answer',
      true,
      'user',
      humanAnswer.item.id,
    ));
  }

  const visualUncertainty = unknown.filter(({ item, fact }) =>
    item.enforcement === 'required' &&
    fact.provenance.validity === 'uncertain' &&
    (
      fact.provenance.evaluatorClass === 'pixel' ||
      fact.provenance.evaluatorClass === 'model' ||
      fact.provenance.evaluatorKind === 'pixel-diff' ||
      fact.provenance.evaluatorKind === 'model-rubric'
    ),
  );
  if (visualUncertainty.length > 0) {
    return refused(base, 'waiting-for-human', refusalFor(
      visualUncertainty,
      'Visual evaluator evidence is uncertain, conflicting, or invalid and needs human review.',
      'provide-evidence',
      true,
      'user',
    ));
  }

  if (absoluteUnmet.length > 0) {
    return refused(base, 'blocked', refusalFor(
      absoluteUnmet,
      hasAbsoluteUncertainty ? 'An absolute expectation is not supported by current evidence.' : 'An absolute expectation failed.',
      'escalate',
      false,
      input.attempt.actor,
    ));
  }

  if (requiredUnmet.length > 0) {
    return refused(base, 'retry', refusalFor(
      requiredUnmet,
      requiredUnmet.some(({ fact }) => factState(fact) === 'unknown')
        ? 'Required expectations need current evidence before this transition can proceed.'
        : 'A required expectation failed for this candidate.',
      requiredUnmet.some(({ fact }) => factState(fact) === 'unknown') ? 'provide-evidence' : 'correct-candidate',
      true,
      input.attempt.actor,
    ));
  }

  // Advisory failures remain visible in the facts but do not block a transition. Unknown
  // advisory facts still refuse: passing without a trustworthy observation would be silent.
  if (advisoryUncertainty) {
    return refused(base, 'retry', refusalFor(
      unknown.filter(({ item }) => item.enforcement === 'advisory'),
      'An advisory expectation has no current, pinned evaluation evidence.',
      'provide-evidence',
      true,
      input.attempt.actor,
    ));
  }

  return createTransitionEvaluation({
    ...base,
    verdict: 'passed',
    refusal: null,
    override: null,
  });
}

/** Evaluate configured guardrails, then let the core transition function choose the verdict. */
export function evaluateGuardedTransition(input: GuardedTransitionInput): TransitionEvaluation {
  return evaluateGuardedTransitionInternal(input, false);
}

/** Internal owner-bound transition entry point; callers cannot supply a snapshot. */
export function evaluateOwnedGuardedTransition(
  input: GuardedTransitionInput,
): TransitionEvaluation {
  return evaluateGuardedTransitionInternal(input, true);
}

function evaluateGuardedTransitionInternal(
  input: GuardedTransitionInput,
  ownerBound: boolean,
): TransitionEvaluation {
  const facts = ownerBound
    ? evaluateOwnedGuardrails({
        guardrails: input.guardrails,
        expectationSet: input.expectationSet,
        candidate: input.attempt.candidate,
        verify: input.verify,
        evidence: input.evidence,
        events: input.events,
        evaluatorCapabilities: input.evaluatorCapabilities,
        producingWorkerProfileId: input.producingWorkerProfileId,
        producingWorkerInstanceId: input.producingWorkerInstanceId,
        evaluatorInstanceId: input.evaluatorInstanceId,
      })
    : evaluateGuardrails({
        guardrails: input.guardrails,
        expectationSet: input.expectationSet,
        candidate: input.attempt.candidate,
        verify: input.verify,
        evidence: input.evidence,
        events: input.events,
        evaluatorCapabilities: input.evaluatorCapabilities,
        producingWorkerProfileId: input.producingWorkerProfileId,
        producingWorkerInstanceId: input.producingWorkerInstanceId,
        evaluatorInstanceId: input.evaluatorInstanceId,
      });
  return evaluateTransition({
    ...input,
    facts: uniqueFacts(facts),
  });
}

/**
 * The legacy pure integration gate, now used as the evaluator adapter for the reserved
 * verification transition. Its observable result remains unchanged for existing callers.
 */
export function evaluateGate(input: GateInput): GateDecision {
  const verification = evaluateVerificationChecks({
    checkNames: input.integration.requires,
    verify: input.verify,
    evidence: input.evidence,
    candidate: candidateIdentity(input.candidateTree),
    expectationSetId: 'legacy-integration-gate',
  });
  const requirements = verification.requirements;
  return {
    allowed: requirements.every((requirement) => requirement.state === 'satisfied'),
    requirements,
  };
}

/** Evaluate the shared transition contract while retaining the old requirement projection. */
export function evaluateIntegrationTransition(input: IntegrationTransitionInput): TransitionDecision {
  return evaluateIntegrationTransitionInternal(input, false);
}

/** Internal owner-bound integration entry point; the store context is supplied by Thread. */
export function evaluateOwnedIntegrationTransition(
  input: IntegrationTransitionInput,
): TransitionDecision {
  return evaluateIntegrationTransitionInternal(input, true);
}

function evaluateIntegrationTransitionInternal(
  input: IntegrationTransitionInput,
  ownerBound: boolean,
): TransitionDecision {
  const verification = evaluateVerificationChecks({
    checkNames: input.integration.requires,
    verify: input.verify,
    evidence: input.evidence,
    candidate: input.attempt.candidate,
    expectationSetId: input.expectationSet.expectationSetId,
  });
  const decision: GateDecision = {
    allowed: verification.requirements.every((requirement) => requirement.state === 'satisfied'),
    requirements: verification.requirements,
  };
  const evaluation = input.guardrails === undefined
    ? evaluateTransition({
        attempt: input.attempt,
        expectationSet: input.expectationSet,
        facts: verification.facts,
        timestamp: input.timestamp,
        ...(input.override === undefined ? {} : { override: input.override }),
      })
    : evaluateGuardedTransitionInternal({
        attempt: input.attempt,
        expectationSet: input.expectationSet,
        timestamp: input.timestamp,
        ...(input.override === undefined ? {} : { override: input.override }),
        guardrails: input.guardrails,
        verify: input.verify,
        evidence: input.evidence,
        events: input.events ?? [],
        evaluatorCapabilities: input.evaluatorCapabilities,
        producingWorkerProfileId: input.producingWorkerProfileId,
        producingWorkerInstanceId: input.producingWorkerInstanceId,
        evaluatorInstanceId: input.evaluatorInstanceId,
      }, ownerBound);
  const invalidReason = input.invalidAttemptReason ?? input.invalidOverrideReason;
  const finalEvaluation = invalidReason === undefined
    ? evaluation
    : createTransitionEvaluation({
        ...evaluation,
        verdict: 'failed',
        refusal: {
          unmetRequirementIds: decision.requirements
            .filter((requirement) => requirement.state !== 'satisfied')
            .map((requirement) => requirement.name),
          reason: invalidReason,
          required: evidenceRequirement(
            decision.requirements
              .filter((requirement) => requirement.state !== 'satisfied')
              .map((requirement) => requirement.name),
            'Provide a valid explicit permission, authorized user, and non-empty reason for the override.',
          ),
          responsibleActor: 'user',
          nextAction: 'escalate',
          retryable: true,
        },
        override: null,
      });
  return {
    allowed: finalEvaluation.verdict === 'passed',
    requirements: decision.requirements,
    evaluation: finalEvaluation,
    verdict: finalEvaluation.verdict,
    refusal: finalEvaluation.refusal,
  };
}

/** Build the immutable set used by the reserved integration transition. */
export function buildIntegrationExpectationSet(
  integration: WorkspaceIntegration,
  verify: readonly VerifyCommand[],
  source: ReferenceIdentity,
  guardrails?: readonly WorkspaceGuardrail[],
): ExpectationSet {
  if (guardrails !== undefined) {
    return buildGuardrailExpectationSet(integration, verify, source, guardrails).expectationSet;
  }
  assertCanonicalIntegrationSource(source);
  const sourceReference = { ...source };
  const manifest = JSON.stringify({
    requires: integration.requires,
    allowOverride: integration.allowOverride,
    verify: verify.map(({ name, command }) => ({ name, command })),
    source: sourceReference,
  });
  const digest = createHash('sha256').update(manifest).digest('hex');
  return createExpectationSet({
    expectationSetId: `workspace-integration:${digest}`,
    manifestDigest: digest,
    items: integration.requires.map((name) => ({
      id: name,
      kind: 'requirement',
      name,
      enforcement: 'required',
      allowOverride: integration.allowOverride,
      reference: { ...sourceReference, selector: `integration.requires:${name}` },
    })),
    authority: { sourceOwner: 'workspace', pinnedBy: 'user' },
    scope: { workItemId: null, sourceStepId: 'lane', targetStepId: 'workspace' },
    supersedes: null,
  });
}

function assertCanonicalIntegrationSource(source: ReferenceIdentity): void {
  if (
    source === null ||
    typeof source !== 'object' ||
    source.sourceKind === undefined ||
    source.locator === undefined ||
    source.nativeRevision === undefined ||
    source.contentDigest === undefined
  ) {
    throw new Error('An integration expectation set requires a canonical source identity.');
  }
  const locators = source.locator.split('|').map((locator) => locator.trim());
  if (
    locators.length === 0 ||
    locators.some((locator) => locator === '' || !isAbsolute(locator)) ||
    source.nativeRevision.trim() === '' ||
    source.contentDigest.trim() === '' ||
    source.locator.includes('unbound-source') ||
    source.nativeRevision.includes('unbound-source') ||
    source.contentDigest.includes('unbound-source')
  ) {
    throw new Error('Integration expectation source must have absolute locators, a revision, and a content digest.');
  }
}

/** Build a stable candidate identity from the existing working-tree state. */
export function candidateIdentity(tree: string | null, commit: string | null = null): CandidateIdentity {
  return {
    kind: 'working-tree',
    id: tree ?? commit ?? 'unidentified-working-tree',
    revision: commit,
    digest: tree,
    pinned: tree !== null,
  };
}

function normalizeFacts(input: TransitionInput): EvaluatorFact[] {
  const supplied = new Map<string, EvaluatorFact>();
  for (const fact of input.facts) {
    if (supplied.has(fact.requirementId)) continue;
    supplied.set(fact.requirementId, normalizeFact(fact, input));
  }

  return input.expectationSet.items.map((item) => supplied.get(item.id) ?? unknownFact(item.id, input));
}

function normalizeFact(fact: EvaluatorFact, input: TransitionInput): EvaluatorFact {
  const state = factState(fact);
  const provenance = fact.provenance;
  const matchesExpectation = provenance.expectationSetId === input.expectationSet.expectationSetId;
  const matchesCandidate = sameCandidate(provenance.candidate, input.attempt.candidate);
  const valid =
    provenance.validity === 'current' &&
    matchesExpectation &&
    matchesCandidate &&
    input.attempt.candidate.pinned &&
    provenance.candidate.pinned;
  return {
    ...fact,
    state: valid ? state : 'unknown',
    evidenceIds: [...fact.evidenceIds],
    provenance: {
      ...provenance,
      evidenceIds: [...provenance.evidenceIds],
      validity: valid ? provenance.validity : provenance.validity === 'current' ? 'uncertain' : provenance.validity,
    },
  };
}

function unknownFact(requirementId: string, input: TransitionInput): EvaluatorFact {
  return {
    requirementId,
    state: 'unknown',
    observation: 'unknown',
    evidenceIds: [],
    provenance: {
      evaluatorId: 'core',
      evaluatorKind: 'core',
      evaluatorVersion: '1',
      evaluatorClass: 'deterministic',
      expectationSetId: input.expectationSet.expectationSetId,
      candidate: input.attempt.candidate,
      evidenceIds: [],
      validity: input.attempt.candidate.pinned ? 'unavailable' : 'unpinned',
      detail: 'No current evaluator fact was supplied.',
    },
    detail: 'unknown',
    diagnostics: ['No current evaluator fact was supplied.'],
  };
}

/** Build the pinned expectation set used by the real schema-v3 integration transition. */
export function buildGuardrailExpectationSet(
  integration: WorkspaceIntegration,
  verify: readonly VerifyCommand[],
  source: ReferenceIdentity,
  guardrails: readonly WorkspaceGuardrail[],
  scope: { workItemId: string | null; sourceStepId: string; targetStepId: string } = {
    workItemId: null,
    sourceStepId: 'lane',
    targetStepId: 'workspace',
  },
): GuardrailExpectationSetResult {
  assertCanonicalIntegrationSource(source);
  const effective = [...guardrails];
  if (
    integration.requires.length > 0 &&
    !effective.some((guardrail) => guardrail.id === 'workspace-integration')
  ) {
    effective.push({
      id: 'workspace-integration',
      kind: 'verification',
      attach: { from: 'lane', to: 'workspace' },
      enforcement: 'required',
      allowOverride: integration.allowOverride,
      parameters: { checks: [...integration.requires] },
      correction: { maxRuns: 2, onExhausted: 'waiting-for-human' },
    });
  }

  const attached = effective.filter((guardrail) =>
    'step' in guardrail.attach
      ? guardrail.attach.step === scope.targetStepId
      : guardrail.attach.from === scope.sourceStepId && guardrail.attach.to === scope.targetStepId,
  );
  const items = new Map<string, ExpectationSet['items'][number]>();
  const conflicts = new Set<string>();
  for (const guardrail of attached) {
    if (guardrail.kind === 'model-rubric' && guardrail.enforcement === 'absolute') {
      conflicts.add(guardrail.id);
    }
    if (
      guardrail.kind === 'pixel-diff' &&
      guardrail.enforcement === 'absolute' &&
      (!isRecord(guardrail.parameters) || guardrail.parameters.exact !== true || !isRecord(guardrail.parameters.capture))
    ) {
      conflicts.add(guardrail.id);
    }
    const parameters = guardrail.parameters;
    const checks = guardrail.kind === 'verification' && isRecord(parameters) && Array.isArray(parameters.checks)
      ? parameters.checks.filter((check): check is string => typeof check === 'string')
      : [];
    const expectationIds = guardrail.kind === 'verification'
      ? checks
      : [isRecord(parameters) && typeof parameters.expectationItem === 'string'
          ? parameters.expectationItem
          : guardrail.id];
    for (const expectationId of expectationIds) {
      const manifestEntry = coreExpectationManifestEntry(expectationId);
      if (guardrail.kind === 'verification') {
        if (!verify.some((check) => check.name === expectationId)) {
          conflicts.add(expectationId);
          continue;
        }
      } else if (manifestEntry === null) {
        // Non-verification expectations must come from the immutable core manifest. Do
        // not create a placeholder item that could later be treated as real policy.
        conflicts.add(expectationId);
        continue;
      }
      const authority = guardrail.kind === 'human-attestation' ||
        (guardrail.kind === 'mandatory-answer' && isRecord(parameters) && parameters.authority === 'user')
        ? 'user' as const
        : undefined;
      const itemKind = guardrail.kind === 'verification' ? 'requirement' as const : manifestEntry?.kind;
      const itemName = guardrail.kind === 'verification' ? expectationId : manifestEntry?.name;
      if (itemKind === undefined || itemName === undefined) {
        conflicts.add(expectationId);
        continue;
      }
      const item = {
        id: expectationId,
        kind: itemKind,
        name: itemName,
        enforcement: guardrail.enforcement,
        allowOverride: guardrail.allowOverride,
        reference: {
          ...source,
          selector: guardrail.kind === 'verification'
            ? `verification:check:${expectationId}`
            : `guardrail:${guardrail.id}:expectation:${expectationId}`,
        },
        ...(authority === undefined ? {} : { authority }),
      } as ExpectationSet['items'][number];
      const prior = items.get(item.id);
      if (prior === undefined) items.set(item.id, item);
      else if (JSON.stringify(prior) !== JSON.stringify(item)) conflicts.add(item.id);
    }
    if (expectationIds.length === 0) {
      conflicts.add(guardrail.id);
    }
  }

  const manifest = JSON.stringify({
    integration,
    verify: verify.map(({ name, command }) => ({ name, command })),
    guardrails: attached,
    source,
    items: [...items.values()],
  });
  const digest = createHash('sha256').update(manifest).digest('hex');
  return {
    expectationSet: createExpectationSet({
      expectationSetId: `workspace-integration:${digest}`,
      manifestDigest: digest,
      items: [...items.values()],
      authority: { sourceOwner: 'workspace', pinnedBy: 'user' },
      scope,
      supersedes: null,
    }),
    conflicts: [...conflicts],
  };
}

function uniqueFacts(facts: readonly EvaluatorFact[]): EvaluatorFact[] {
  const byId = new Map<string, EvaluatorFact>();
  for (const fact of facts) if (!byId.has(fact.requirementId)) byId.set(fact.requirementId, fact);
  return [...byId.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateTransitionInput(
  input: TransitionInput,
  enforcement: readonly RequirementEnforcement[],
): TransitionRefusal | null {
  const requiredIds = new Set(input.expectationSet.items.map((item) => item.id));
  if (
    input.expectationSet.expectationSetId.trim() === '' ||
    input.expectationSet.manifestDigest.trim() === '' ||
    input.expectationSet.authority.sourceOwner.trim() === '' ||
    input.expectationSet.authority.pinnedBy.trim() === ''
  ) {
    return invalidRefusal('The transition must use an immutable, authorized expectation set.', input.attempt.actor);
  }
  if (
    requiredIds.size !== input.expectationSet.items.length ||
    input.expectationSet.items.some((item) =>
      item.id.trim() === '' ||
      item.name.trim() === '' ||
      typeof item.allowOverride !== 'boolean' ||
      (item.allowOverride && item.enforcement !== 'required') ||
      item.reference.locator.trim() === '' ||
      item.reference.nativeRevision.trim() === '' ||
      item.reference.contentDigest.trim() === '',
    )
  ) {
    return invalidRefusal('Expectation items must have stable ids and pinned source identities.', input.attempt.actor);
  }
  if (input.attempt.attempt < 1 || !Number.isInteger(input.attempt.attempt)) {
    return invalidRefusal('Transition attempts must be positive integers.', input.attempt.actor);
  }
  if (input.attempt.expectationSetId !== input.expectationSet.expectationSetId) {
    return invalidRefusal('The attempt is not pinned to the expectation set being evaluated.', input.attempt.actor);
  }
  if (
    input.previous !== undefined &&
    input.previous.transitionId === input.attempt.transitionId &&
    input.attempt.attempt <= input.previous.attempt
  ) {
    return invalidRefusal('Transition attempts must increase for the same transition identity.', input.attempt.actor);
  }
  if (input.attempt.transitionId.trim() === '' || input.attempt.sourceStepId.trim() === '' || input.attempt.targetStepId.trim() === '') {
    return invalidRefusal('Transition identity and source/target steps are required.', input.attempt.actor);
  }
  if (!Number.isFinite(input.timestamp)) {
    return invalidRefusal('A finite evaluation timestamp is required.', input.attempt.actor);
  }
  if (input.facts.some((fact) => !requiredIds.has(fact.requirementId))) {
    return invalidRefusal('Evaluator facts may only name requirements in the pinned expectation set.', input.attempt.actor);
  }
  if (new Set(input.facts.map((fact) => fact.requirementId)).size !== input.facts.length) {
    return invalidRefusal('Each requirement may have only one evaluator fact per attempt.', input.attempt.actor);
  }
  const byId = new Map(enforcement.map((entry) => [entry.requirementId, entry]));
  if (enforcement.some((entry) => !requiredIds.has(entry.requirementId))) {
    return invalidRefusal('Enforcement may only name requirements in the pinned expectation set.', input.attempt.actor);
  }
  if (input.expectationSet.items.some((item) => {
    const entry = byId.get(item.id);
    return entry?.enforcement !== item.enforcement ||
      entry?.allowOverride !== item.allowOverride ||
      entry?.authority !== item.authority;
  })) {
    return invalidRefusal('Evaluator enforcement must match the immutable expectation set.', input.attempt.actor);
  }
  const override = input.override;
  if (
    override !== undefined &&
    override !== null &&
    (override.enforcement !== 'required' ||
      override.permission !== 'explicit' ||
      override.permissionGranted !== true ||
      override.actor !== 'user' ||
      override.authorizedUserId.trim() === '' ||
      override.reason.trim() === '')
  ) {
    return invalidRefusal('An override needs explicit permission, an authorized user, and a non-empty reason.', 'user');
  }
  return null;
}

function factState(fact: EvaluatorFact): EvaluatorFactState {
  return fact.state;
}

function sameCandidate(left: CandidateIdentity, right: CandidateIdentity): boolean {
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    left.revision === right.revision &&
    left.digest === right.digest &&
    left.pinned === right.pinned
  );
}

function refused(
  base: Omit<TransitionEvaluation, 'verdict' | 'refusal' | 'override'>,
  verdict: Exclude<TransitionVerdict, 'passed'>,
  refusal: TransitionRefusal,
): TransitionEvaluation {
  return createTransitionEvaluation({
    ...base,
    verdict,
    refusal,
    override: null,
  });
}

function refusalFor(
  unmet: readonly { item: { id: string; kind: string }; fact: EvaluatorFact }[],
  reason: string,
  nextAction: TransitionNextAction,
  retryable: boolean,
  responsibleActor: TransitionAttempt['actor'],
  answerId?: string,
): TransitionRefusal {
  const ids = unmet.map(({ item }) => item.id);
  if (nextAction === 'provide-answer') {
    return {
      unmetRequirementIds: ids,
      reason,
      required: {
        kind: 'structured-answer',
        answer: {
          questionId: answerId ?? ids[0] ?? 'unknown-question',
          description: 'Provide the authorized answer required by this transition.',
          schema: null,
        },
      },
      responsibleActor,
      nextAction,
      retryable,
    };
  }
  return {
    unmetRequirementIds: ids,
    reason,
    required: evidenceRequirement(ids, 'Provide current evidence for the unmet expectation.'),
    responsibleActor,
    nextAction,
    retryable,
  };
}

function evidenceRequirement(requirementIds: readonly string[], description: string): TransitionRefusal['required'] {
  return { kind: 'evidence', evidence: { requirementIds: [...requirementIds], description } };
}

function invalidRefusal(reason: string, responsibleActor: TransitionAttempt['actor']): TransitionRefusal {
  return {
    unmetRequirementIds: [],
    reason,
    required: evidenceRequirement([], 'Provide a valid, pinned transition evaluation input.'),
    responsibleActor,
    nextAction: 'escalate',
    retryable: true,
  };
}

/** One line a person can act on, naming what is unsatisfied and why. */
export function explainGate(decision: GateDecision): string {
  const unsatisfied = decision.requirements.filter((entry) => entry.state !== 'satisfied');
  if (unsatisfied.length === 0) return 'every required check passed against this candidate';

  return unsatisfied
    .map((entry) => {
      switch (entry.state) {
        case 'missing':
          return `${entry.name} has not been run`;
        case 'failed':
          return `${entry.name} failed`;
        default:
          return `${entry.name} passed against different content`;
      }
    })
    .join('; ');
}
