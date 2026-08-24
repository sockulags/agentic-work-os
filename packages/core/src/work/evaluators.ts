import type {
  CandidateIdentity,
  EvaluatorCapability,
  EvidenceItem,
  EvaluatorFact,
  EvaluatorObservationState,
  ExpectationSet,
  HarnessEvent,
  ModelRubricEvidence,
  ModelRubricOutcome,
  PixelCaptureContract,
  ReferenceIdentity,
  RequirementResult,
  VerifyCommand,
  VisualArtifactIdentity,
  VisualEvidence,
  WorkspaceGuardrail,
  WorkspaceGuardrailKind,
} from '@awos/protocol';
import { EVALUATOR_DIAGNOSTIC_MAX_CHARS } from '@awos/protocol';
import {
  isCurrentEventLogSnapshot,
  trustedSnapshotForActiveThreadContext,
  type EventLogSnapshot,
} from '../store/thread-store.js';
import {
  foldAttestations,
  foldAnswers,
  foldEvidence,
  foldHumanAttestationConflicts,
  foldTypedAnswerConflicts,
  foldExpectationSets,
  foldExpectationSetSupersessions,
  foldVisualSourceEvents,
} from './ledger.js';

export { EVALUATOR_DIAGNOSTIC_MAX_CHARS } from '@awos/protocol';

/** The built-ins consume bounded evidence; adapters never choose transition verdicts. */
export type CoreEvaluatorKind =
  | 'verification'
  | 'evidence-present'
  | 'mandatory-answer'
  | 'human-attestation'
  | 'pixel-diff'
  | 'model-rubric';

export const CORE_EVALUATOR_VERSION = '1';

export interface VerificationEvaluatorInput {
  checkNames: readonly string[];
  verify: readonly VerifyCommand[];
  evidence: readonly EvidenceItem[];
  candidate: CandidateIdentity;
  expectationSetId: string;
}

export interface VerificationEvaluation {
  requirements: RequirementResult[];
  facts: EvaluatorFact[];
}

/** Inputs shared by all core-registered guardrails. */
export interface GuardrailEvaluatorInput {
  guardrail: WorkspaceGuardrail;
  expectationSet: ExpectationSet;
  candidate: CandidateIdentity;
  verify: readonly VerifyCommand[];
  evidence: readonly EvidenceItem[];
  events: readonly HarnessEvent[];
  /** Capabilities are supplied by the host; core has no provider/model registry. */
  evaluatorCapabilities?: readonly EvaluatorCapability[];
  /** Optional execution identities used to reject self-evaluation at the adapter boundary. */
  producingWorkerProfileId?: string | null;
  producingWorkerInstanceId?: string | null;
  evaluatorInstanceId?: string | null;
}

/**
 * Validate and freeze adapter output against immutable source events in the core log.
 *
 * This is deliberately not wired to the ordinary evidence RPC. With no capture/model
 * runtime, the production log has no trusted visual source events and evaluators return
 * unknown rather than trusting a payload that merely resembles a pixel or model result.
 */
function createTrustedVisualEvidence(visual: VisualEvidence, snapshot: EventLogSnapshot): VisualEvidence | null {
  if (
    !isCurrentEventLogSnapshot(snapshot) ||
    !validVisualEvidenceShape(visual)
  ) return null;
  const index = foldVisualSourceEvents(snapshot.events, snapshot.threadId);
  const reference = index.artifacts.get(visual.reference.eventId ?? '');
  const candidate = index.artifacts.get(visual.candidate.eventId ?? '');
  if (
    reference === undefined ||
    candidate === undefined ||
    index.conflicts.has(reference.eventId) ||
    index.conflicts.has(candidate.eventId) ||
    reference.role !== 'reference' ||
    candidate.role !== 'candidate' ||
    !sameVisualArtifactIdentity(reference.identity, visual.reference) ||
    !sameVisualArtifactIdentity(candidate.identity, visual.candidate)
  ) return null;

  if (visual.kind === 'pixel-diff') {
    const capture = pixelCapture(visual.capture);
    if (
      capture === null ||
      reference.capture === null ||
      candidate.capture === null ||
      !validPixelCapture(reference.capture) ||
      !validPixelCapture(candidate.capture) ||
      !samePixelCapture(capture, reference.capture) ||
      !samePixelCapture(capture, candidate.capture) ||
      !validPixelMeasurement(visual.measurement)
    ) return null;
  } else {
    if (
      !validRubricIdentity(visual.rubric) ||
      !validEvaluatorIdentity(visual.evaluator) ||
      !isModelRubricOutcome(visual.outcome)
    ) return null;
    const rubric = index.rubrics.get(visual.rubric.eventId ?? '');
    const capability = index.capabilities.get(visual.evaluator.eventId ?? '');
    if (
      rubric === undefined ||
      capability === undefined ||
      index.conflicts.has(rubric.eventId) ||
      index.conflicts.has(capability.eventId) ||
      !sameRubricIdentity(rubric, visual.rubric) ||
      !sameEvaluatorIdentity(capability, visual.evaluator) ||
      capability.independent !== true
    ) return null;
  }

  return freezeVisualEvidence(visual);
}

export interface CoreEvaluatorDefinition {
  readonly kind: CoreEvaluatorKind;
  readonly version: string;
  evaluate(input: GuardrailEvaluatorInput): EvaluatorFact[];
}

/**
 * The registry is intentionally static and closed. There is no registration API, provider
 * lookup, model selector, command runner or evaluator supplied by workspace configuration.
 */
export const CORE_EVALUATOR_REGISTRY: Readonly<Record<CoreEvaluatorKind, CoreEvaluatorDefinition>> = Object.freeze({
  verification: Object.freeze({
    kind: 'verification',
    version: CORE_EVALUATOR_VERSION,
    evaluate: evaluateVerificationGuardrail,
  }),
  'evidence-present': Object.freeze({
    kind: 'evidence-present',
    version: CORE_EVALUATOR_VERSION,
    evaluate: evaluateEvidencePresentGuardrail,
  }),
  'mandatory-answer': Object.freeze({
    kind: 'mandatory-answer',
    version: CORE_EVALUATOR_VERSION,
    evaluate: evaluateMandatoryAnswerGuardrail,
  }),
  'human-attestation': Object.freeze({
    kind: 'human-attestation',
    version: CORE_EVALUATOR_VERSION,
    evaluate: evaluateHumanAttestationGuardrail,
  }),
  'pixel-diff': Object.freeze({
    kind: 'pixel-diff',
    version: CORE_EVALUATOR_VERSION,
    evaluate: evaluatePixelDiffGuardrail,
  }),
  'model-rubric': Object.freeze({
    kind: 'model-rubric',
    version: CORE_EVALUATOR_VERSION,
    evaluate: evaluateModelRubricGuardrail,
  }),
});

/** Stable list used by callers that need to report which capabilities the core has. */
export const CORE_EVALUATOR_KINDS: readonly CoreEvaluatorKind[] = Object.freeze([
  'verification',
  'evidence-present',
  'mandatory-answer',
  'human-attestation',
  'pixel-diff',
  'model-rubric',
]);

/** Look up only a built-in evaluator; unsupported guardrail kinds return null. */
export function coreEvaluator(kind: WorkspaceGuardrailKind): CoreEvaluatorDefinition | null {
  return Object.prototype.hasOwnProperty.call(CORE_EVALUATOR_REGISTRY, kind)
    ? CORE_EVALUATOR_REGISTRY[kind as CoreEvaluatorKind] ?? null
    : null;
}

/**
 * Evaluate one configured guardrail into facts. A malformed or unavailable input becomes
 * an unknown fact rather than escaping as an exception or a silent pass.
 */
export function evaluateGuardrail(input: GuardrailEvaluatorInput): EvaluatorFact[] {
  return evaluateGuardrailInternal(input, null);
}

/** Internal owner-bound entry point; the opaque context is resolved by ThreadStore. */
export function evaluateOwnedGuardrails(
  input: Omit<GuardrailEvaluatorInput, 'guardrail'> & { guardrails: readonly WorkspaceGuardrail[] },
): EvaluatorFact[] {
  const snapshot = trustedSnapshotForActiveThreadContext();
  if (!Array.isArray(input.guardrails)) {
    return [unknownFact('unknown-expectation', input, 'unavailable', 'Guardrail configuration is unavailable.', 'core')];
  }
  return input.guardrails.flatMap((guardrail) => evaluateGuardrailInternal({ ...input, guardrail }, snapshot));
}

function evaluateGuardrailInternal(input: GuardrailEvaluatorInput, snapshot: EventLogSnapshot | null): EvaluatorFact[] {
  const kind = input.guardrail?.kind;
  const evaluator = typeof kind === 'string' ? coreEvaluator(kind) : null;
  if (evaluator === null) {
    return [unknownFact(
      expectationId(input),
      input,
      'unavailable',
      `No core evaluator is registered for guardrail kind "${String(kind)}".`,
      'core',
    )];
  }

  try {
    const facts = kind === 'pixel-diff'
      ? evaluatePixelDiffGuardrail(input, snapshot)
      : kind === 'model-rubric'
        ? evaluateModelRubricGuardrail(input, snapshot)
        : evaluator.evaluate(input);
    return facts.map((fact) => normalizeFact(fact));
  } catch (error) {
    return [unknownFact(
      expectationId(input),
      input,
      'uncertain',
      `Evaluator was unavailable: ${error instanceof Error ? error.message : 'unknown failure'}.`,
      evaluator.kind,
    )];
  }
}

/** Evaluate guardrails in declaration order; no verdict is chosen here. */
export function evaluateGuardrails(
  input: Omit<GuardrailEvaluatorInput, 'guardrail'> & { guardrails: readonly WorkspaceGuardrail[] },
): EvaluatorFact[] {
  if (!Array.isArray(input.guardrails)) {
    return [unknownFact('unknown-expectation', input, 'unavailable', 'Guardrail configuration is unavailable.', 'core')];
  }
  return input.guardrails.flatMap((guardrail) => evaluateGuardrail({ ...input, guardrail }));
}

/**
 * Shared verification implementation used by both the v3 evaluator and the legacy
 * lane-integration gate. It never executes the declared command; `runCheck` owns that.
 */
export function evaluateVerificationChecks(input: VerificationEvaluatorInput): VerificationEvaluation {
  const results = input.checkNames.map((checkName) => evaluateVerificationCheck(input, checkName));
  return {
    requirements: results.map((result) => result.requirement),
    facts: results.map((result) => result.fact),
  };
}

function evaluateVerificationGuardrail(input: GuardrailEvaluatorInput): EvaluatorFact[] {
  const parameters = input.guardrail.parameters;
  if (!isRecord(parameters) || !Array.isArray(parameters.checks)) {
    return [unknownFact(expectationId(input), input, 'unavailable', 'Verification guardrail has no declared named checks.', 'verification')];
  }
  return evaluateVerificationChecks({
    checkNames: parameters.checks,
    verify: input.verify,
    evidence: input.evidence,
    candidate: input.candidate,
    expectationSetId: input.expectationSet.expectationSetId,
  }).facts;
}

function evaluateVerificationCheck(
  input: VerificationEvaluatorInput,
  checkName: string,
): { requirement: RequirementResult; fact: EvaluatorFact } {
  const command = input.verify.find((entry) => entry.name === checkName)?.command ?? '';
  const base = { name: checkName, command };
  if (command === '') {
    return {
      requirement: { ...base, state: 'missing', evidenceId: null, evidenceTree: null },
      fact: unknownFact(checkName, input, 'unavailable', `No declared verification command for "${checkName}".`, 'verification', 'missing'),
    };
  }

  const latest = [...input.evidence]
    .filter((item) => item.kind === 'command' && item.check?.name === checkName)
    .filter((item) => evidenceMatchesExpectation(item, input.expectationSetId, checkName))
    .sort(compareEvidence)
    .at(-1);
  if (latest === undefined || latest.check === null) {
    return {
      requirement: { ...base, state: 'missing', evidenceId: null, evidenceTree: null },
      fact: unknownFact(checkName, input, 'unavailable', `Verification "${checkName}" has not produced command evidence.`, 'verification', 'missing'),
    };
  }

  const evidenceTree = latest.state.tree;
  const evidenceCandidate = candidateFromEvidence(latest);
  if (!latest.check.passed) {
    return {
      requirement: { ...base, state: 'failed', evidenceId: latest.id, evidenceTree },
      fact: makeFact({
        evaluatorKind: 'verification',
        evaluatorClass: 'deterministic',
        requirementId: checkName,
        state: 'failed',
        observation: 'failed',
        validity: evidenceCandidate.pinned ? 'current' : 'unpinned',
        evidenceIds: [latest.id],
        candidate: evidenceCandidate,
        expectationSetId: input.expectationSetId,
        detail: `Declared verification "${checkName}" failed.`,
      }),
    };
  }

  if (!sameCandidateContent(input.candidate, evidenceCandidate)) {
    return {
      requirement: { ...base, state: 'stale', evidenceId: latest.id, evidenceTree },
      fact: makeFact({
        evaluatorKind: 'verification',
        evaluatorClass: 'deterministic',
        requirementId: checkName,
        state: 'unknown',
        observation: 'stale',
        validity: evidenceCandidate.pinned ? 'stale' : 'unpinned',
        evidenceIds: [latest.id],
        candidate: evidenceCandidate,
        expectationSetId: input.expectationSetId,
        detail: `Declared verification "${checkName}" passed against a different candidate.`,
      }),
    };
  }

  return {
    requirement: { ...base, state: 'satisfied', evidenceId: latest.id, evidenceTree },
    fact: makeFact({
      evaluatorKind: 'verification',
      evaluatorClass: 'deterministic',
      requirementId: checkName,
      state: 'satisfied',
      observation: 'satisfied',
      validity: 'current',
      evidenceIds: [latest.id],
      candidate: input.candidate,
      expectationSetId: input.expectationSetId,
      detail: `Declared verification "${checkName}" passed for this candidate.`,
    }),
  };
}

function evaluateEvidencePresentGuardrail(input: GuardrailEvaluatorInput): EvaluatorFact[] {
  const parameters = input.guardrail.parameters;
  if (!isRecord(parameters) || typeof parameters.expectationItem !== 'string') {
    return [unknownFact(expectationId(input), input, 'unavailable', 'Evidence-present guardrail has no expectation item.', 'evidence-present')];
  }

  const requirementId = parameters.expectationItem;
  if (!input.expectationSet.items.some((item) => item.id === requirementId)) {
    return [unknownFact(requirementId, input, 'unavailable', `Expectation "${requirementId}" is not in the pinned expectation set.`, 'evidence-present')];
  }
  if (!input.candidate.pinned) {
    return [unknownFact(requirementId, input, 'unpinned', 'The transition candidate has no pinned identity.', 'evidence-present')];
  }

  const requestedKind = typeof parameters.evidenceKind === 'string' ? parameters.evidenceKind : null;
  const candidates = input.evidence
    .filter((item) => requestedKind === null || item.kind === requestedKind)
    .filter((item) => evidenceMatchesExpectation(item, input.expectationSet.expectationSetId, requirementId))
    .filter((item) => isConcreteEvidence(item, input.events))
    .sort(compareEvidence);
  const current = candidates.find((item) => sameCandidateContent(input.candidate, candidateFromEvidence(item)));
  if (current !== undefined) {
    return [makeFact({
      evaluatorKind: 'evidence-present',
      evaluatorClass: 'deterministic',
      requirementId,
      state: 'satisfied',
      observation: 'satisfied',
      validity: 'current',
      evidenceIds: [current.id],
      candidate: input.candidate,
      expectationSetId: input.expectationSet.expectationSetId,
      detail: `Concrete ${current.kind} evidence is pinned to this candidate.`,
    })];
  }

  const stale = candidates.find((item) => item.state.tree !== null || item.state.commit !== null);
  return [unknownFact(
    requirementId,
    input,
    stale === undefined ? 'unavailable' : 'stale',
    stale === undefined
      ? `No concrete ${requestedKind ?? 'evidence'} is pinned to this candidate.`
      : `The available ${stale.kind} evidence is pinned to a different candidate or record.`,
    'evidence-present',
    stale === undefined ? 'missing' : 'stale',
    stale === undefined ? [] : [stale.id],
  )];
}

function evaluateMandatoryAnswerGuardrail(input: GuardrailEvaluatorInput): EvaluatorFact[] {
  const parameters = input.guardrail.parameters;
  if (
    !isRecord(parameters) ||
    (parameters.authority !== undefined && parameters.authority !== 'user') ||
    typeof parameters.expectationItem !== 'string'
  ) {
    return [unknownFact(expectationId(input), input, 'unavailable', 'Mandatory-answer guardrail has no expectation item.', 'mandatory-answer')];
  }
  const requirementId = parameters.expectationItem;
  const expectation = input.expectationSet.items.find((item) => item.id === requirementId);
  if (expectation === undefined) {
    return [unknownFact(requirementId, input, 'unavailable', `Expectation "${requirementId}" is not in the pinned expectation set.`, 'mandatory-answer')];
  }
  if (expectation.kind !== 'mandatory-question') {
    return [unknownFact(requirementId, input, 'unavailable', 'Mandatory-answer guardrails require a mandatory-question expectation.', 'mandatory-answer')];
  }
  if (isSuperseded(input.expectationSet.expectationSetId, input.events)) {
    return [unknownFact(requirementId, input, 'stale', 'The expectation set has been superseded; the earlier answer cannot carry forward.', 'mandatory-answer', 'stale')];
  }

  const activeAnswers = foldAnswers(input.events)
    .filter((answer) => answer.expectationSetId === input.expectationSet.expectationSetId && answer.expectationItemId === requirementId)
    .sort((left, right) => left.at - right.at);
  if (hasAnswerConflict(input.events, input.expectationSet.expectationSetId, requirementId)) {
    return [unknownFact(requirementId, input, 'uncertain', 'Conflicting definitions share the typed answer identity.', 'mandatory-answer', 'unknown')];
  }
  const latest = activeAnswers.at(-1);
  if (latest === undefined) {
    return [unknownFact(requirementId, input, 'unavailable', 'No typed answer was recorded for the mandatory question.', 'mandatory-answer', 'missing')];
  }
  if (latest.authority !== 'user' || latest.actor !== 'user') {
    return [unknownFact(requirementId, input, 'uncertain', 'Only an answer recorded by the authorized user can satisfy this question.', 'mandatory-answer', 'unknown', latest.evidenceIds)];
  }
  if (!validTypedAnswer(latest.answer)) {
    return [unknownFact(requirementId, input, 'uncertain', 'The recorded answer is not a valid typed value.', 'mandatory-answer', 'unknown', latest.evidenceIds)];
  }
  if (!sameCandidate(input.candidate, latest.candidate)) {
    return [unknownFact(requirementId, input, latest.candidate.pinned ? 'stale' : 'unpinned', 'The typed answer belongs to a different candidate.', 'mandatory-answer', 'stale', latest.evidenceIds, latest.candidate)];
  }

  return [makeFact({
    evaluatorKind: 'mandatory-answer',
    evaluatorClass: 'human',
    requirementId,
    authority: 'user',
    state: 'satisfied',
    observation: 'satisfied',
    validity: 'current',
    evidenceIds: latest.evidenceIds,
    candidate: input.candidate,
    expectationSetId: input.expectationSet.expectationSetId,
    detail: 'An authorized typed answer is recorded for this candidate.',
  })];
}

function evaluateHumanAttestationGuardrail(input: GuardrailEvaluatorInput): EvaluatorFact[] {
  const parameters = input.guardrail.parameters;
  if (!isRecord(parameters) || parameters.authority !== 'user' || typeof parameters.expectationItem !== 'string') {
    return [unknownFact(expectationId(input), input, 'unavailable', 'Human attestation must name the user authority and an expectation item.', 'human-attestation')];
  }
  const requirementId = parameters.expectationItem;
  const expectation = input.expectationSet.items.find((item) => item.id === requirementId);
  if (expectation === undefined) {
    return [unknownFact(requirementId, input, 'unavailable', `Expectation "${requirementId}" is not in the pinned expectation set.`, 'human-attestation')];
  }
  if (expectation.kind !== 'human-attestation') {
    return [unknownFact(requirementId, input, 'unavailable', 'Human-attestation guardrails require a human-attestation expectation.', 'human-attestation')];
  }
  if (isSuperseded(input.expectationSet.expectationSetId, input.events)) {
    return [unknownFact(requirementId, input, 'stale', 'The expectation set has been superseded; the earlier attestation cannot carry forward.', 'human-attestation', 'stale')];
  }

  const activeAttestations = foldAttestations(input.events)
    .filter((attestation) =>
      attestation.expectationSetId === input.expectationSet.expectationSetId &&
      attestation.expectationItemId === requirementId,
    )
    .sort((left, right) => left.at - right.at);
  if (hasAttestationConflict(input.events, input.expectationSet.expectationSetId, requirementId)) {
    return [unknownFact(requirementId, input, 'uncertain', 'Conflicting definitions share the human attestation identity.', 'human-attestation', 'unknown')];
  }
  const latest = activeAttestations.at(-1);
  if (latest === undefined) {
    return [unknownFact(requirementId, input, 'unavailable', 'No attestation is recorded for this expectation set and item.', 'human-attestation', 'missing')];
  }
  if (latest.actor !== 'user' || latest.authority !== 'user') {
    return [unknownFact(requirementId, input, 'uncertain', 'Only the authorized user may attest.', 'human-attestation', 'unknown', latest.evidenceIds)];
  }
  if (latest.statement.trim() === '') {
    return [unknownFact(requirementId, input, 'uncertain', 'A human attestation needs a non-empty statement.', 'human-attestation', 'unknown', latest.evidenceIds)];
  }
  if (!sameCandidate(input.candidate, latest.candidate)) {
    return [unknownFact(requirementId, input, latest.candidate.pinned ? 'stale' : 'unpinned', 'The attestation belongs to a different candidate.', 'human-attestation', 'stale', latest.evidenceIds, latest.candidate)];
  }

  const supporting = latest.evidenceIds.map((id) => input.evidence.find((item) => item.id === id));
  if (latest.evidenceIds.length === 0 || supporting.some((item) => item === undefined || !evidenceMatchesExpectation(item, input.expectationSet.expectationSetId, requirementId) || !isConcreteEvidence(item, input.events) || !sameCandidateContent(input.candidate, candidateFromEvidence(item)))) {
    return [unknownFact(requirementId, input, 'unavailable', 'The attestation does not reference current concrete evidence for this candidate.', 'human-attestation', 'unknown', latest.evidenceIds)];
  }

  return [makeFact({
    evaluatorKind: 'human-attestation',
    evaluatorClass: 'human',
    requirementId,
    authority: 'user',
    state: 'satisfied',
    observation: 'satisfied',
    validity: 'current',
    evidenceIds: latest.evidenceIds,
    candidate: input.candidate,
    expectationSetId: input.expectationSet.expectationSetId,
    detail: 'An authorized human attestation is recorded with current supporting evidence.',
  })];
}

function evaluatePixelDiffGuardrail(input: GuardrailEvaluatorInput, snapshot: EventLogSnapshot | null = null): EvaluatorFact[] {
  const parameters = input.guardrail.parameters;
  if (!isRecord(parameters) || typeof parameters.expectationItem !== 'string') {
    return [unknownFact(expectationId(input), input, 'unavailable', 'Pixel-diff guardrail has no expectation item.', 'pixel-diff', 'missing')];
  }

  const requirementId = parameters.expectationItem;
  const expectation = input.expectationSet.items.find((item) => item.id === requirementId);
  if (expectation === undefined) {
    return [unknownFact(requirementId, input, 'unavailable', `Expectation "${requirementId}" is not in the pinned expectation set.`, 'pixel-diff')];
  }
  if (expectation.kind !== 'visual-reference' && expectation.kind !== 'prototype') {
    return [unknownFact(requirementId, input, 'unavailable', 'Pixel-diff guardrails require a visual-reference expectation.', 'pixel-diff')];
  }
  if (snapshot === null) {
    return [unknownFact(requirementId, input, 'unavailable', 'A current store-owned visual event snapshot is unavailable.', 'pixel-diff', 'missing')];
  }
  if (isSuperseded(input.expectationSet.expectationSetId, snapshot.events)) {
    return [unknownFact(requirementId, input, 'stale', 'The visual reference expectation set was superseded; earlier pixel evidence is stale.', 'pixel-diff', 'stale')];
  }
  if (!input.candidate.pinned) {
    return [unknownFact(requirementId, input, 'unpinned', 'The transition candidate has no pinned identity.', 'pixel-diff')];
  }

  const candidates = visualEvidenceCandidates(input, snapshot, requirementId, 'pixel-diff');
  if (candidates.length === 0) {
    return [unknownFact(requirementId, input, 'unavailable', 'No structured pixel-diff evidence is recorded for this visual reference.', 'pixel-diff', 'missing')];
  }
  const current = candidates.filter((item) => sameCandidateContent(input.candidate, candidateFromEvidence(item))).at(-1);
  if (current === undefined || current.visual?.kind !== 'pixel-diff') {
    const latest = candidates.at(-1)!;
    const observed = candidateFromEvidence(latest);
    return [unknownFact(
      requirementId,
      input,
      observed.pinned ? 'stale' : 'unpinned',
      'The pixel evidence belongs to a different candidate.',
      'pixel-diff',
      'stale',
      [latest.id],
      observed,
    )];
  }

  if (!validPixelCapture(current.visual.capture)) {
    return [unknownFact(requirementId, input, 'uncertain', 'Pixel evidence contains an incomplete or invalid pinned capture contract.', 'pixel-diff', 'unknown', [current.id])];
  }
  if (!validPixelMeasurement(current.visual.measurement)) {
    return [unknownFact(requirementId, input, 'uncertain', 'Pixel evidence contains an invalid or contradictory measurement.', 'pixel-diff', 'unknown', [current.id])];
  }
  const visual = createTrustedVisualEvidence(current.visual, snapshot);
  if (visual === null || visual.kind !== 'pixel-diff') {
    const available = hasReferencedVisualSourceEvent(current.visual, snapshot);
    return [unknownFact(
      requirementId,
      input,
      available ? 'uncertain' : 'unavailable',
      available
        ? 'Pixel evidence does not match immutable source events or its capture contract.'
        : 'No immutable visual source events exist for the pixel evidence.',
      'pixel-diff',
      available ? 'unknown' : 'missing',
      [current.id],
    )];
  }
  if (!validVisualArtifact(visual.reference) || !validVisualArtifact(visual.candidate)) {
    return [unknownFact(requirementId, input, 'unavailable', 'Pixel evidence needs bounded, addressable reference and candidate image identities.', 'pixel-diff', 'unknown', [current.id])];
  }
  if (!sameVisualReference(expectation.reference, visual.reference)) {
    return [unknownFact(requirementId, input, 'stale', 'Pixel evidence names a different pinned visual reference.', 'pixel-diff', 'stale', [current.id])];
  }

  const configuredCapture = pixelCapture(parameters.capture);
  const exactRequired = parameters.exact === true || input.guardrail.enforcement === 'absolute' || expectation.enforcement === 'absolute';
  if (
    (input.guardrail.enforcement === 'absolute' || expectation.enforcement === 'absolute') &&
    (parameters.exact !== true || configuredCapture === null)
  ) {
    return [unknownFact(requirementId, input, 'uncertain', 'Absolute pixel enforcement needs a complete capture contract and an explicit exact-pixel requirement.', 'pixel-diff', 'unknown', [current.id])];
  }
  if (!validPixelCapture(visual.capture)) {
    return [unknownFact(requirementId, input, 'uncertain', 'Pixel evidence contains an incomplete or invalid pinned capture contract.', 'pixel-diff', 'unknown', [current.id])];
  }
  if (parameters.capture !== undefined && configuredCapture === null) {
    return [unknownFact(requirementId, input, 'uncertain', 'The pinned pixel capture configuration is invalid or incomplete.', 'pixel-diff', 'unknown', [current.id])];
  }
  if (configuredCapture !== null && !samePixelCapture(configuredCapture, visual.capture)) {
    return [unknownFact(requirementId, input, 'stale', 'Pixel evidence was captured with inputs different from the pinned capture contract.', 'pixel-diff', 'stale', [current.id])];
  }
  if (!validPixelMeasurement(visual.measurement)) {
    return [unknownFact(requirementId, input, 'uncertain', 'Pixel evidence contains an invalid or contradictory measurement.', 'pixel-diff', 'unknown', [current.id])];
  }
  if (exactRequired && !visual.measurement.exact) {
    return [unknownFact(requirementId, input, 'uncertain', 'The pinned pixel expectation requires an exact-pixel measurement.', 'pixel-diff', 'unknown', [current.id])];
  }

  const equal = visual.measurement.differentPixels === 0;
  return [makeFact({
    evaluatorKind: 'pixel-diff',
    evaluatorClass: 'pixel',
    requirementId,
    state: equal ? 'satisfied' : 'failed',
    observation: equal ? 'satisfied' : 'failed',
    validity: 'current',
    evidenceIds: [current.id],
    candidate: input.candidate,
    expectationSetId: input.expectationSet.expectationSetId,
    detail: equal
      ? `Measured pixel equality across ${visual.measurement.comparedPixels} pixels.`
      : `Measured ${visual.measurement.differentPixels} differing pixels of ${visual.measurement.comparedPixels}.`,
  })];
}

function evaluateModelRubricGuardrail(input: GuardrailEvaluatorInput, snapshot: EventLogSnapshot | null = null): EvaluatorFact[] {
  const parameters = input.guardrail.parameters;
  if (!isRecord(parameters) || typeof parameters.expectationItem !== 'string' || typeof parameters.evaluatorProfile !== 'string') {
    return [unknownFact(expectationId(input), input, 'unavailable', 'Model-rubric guardrail needs an expectation item and evaluator capability.', 'model-rubric', 'missing')];
  }

  const requirementId = parameters.expectationItem;
  const expectation = input.expectationSet.items.find((item) => item.id === requirementId);
  if (expectation === undefined) {
    return [unknownFact(requirementId, input, 'unavailable', `Expectation "${requirementId}" is not in the pinned expectation set.`, 'model-rubric')];
  }
  if (expectation.kind !== 'visual-reference' && expectation.kind !== 'prototype') {
    return [unknownFact(requirementId, input, 'unavailable', 'Model-rubric guardrails require a visual-reference expectation.', 'model-rubric')];
  }
  if (input.guardrail.enforcement === 'absolute' || expectation.enforcement === 'absolute') {
    return [unknownFact(requirementId, input, 'uncertain', 'Model-rubric evaluations cannot use absolute enforcement.', 'model-rubric')];
  }
  if (snapshot === null) {
    return [unknownFact(requirementId, input, 'unavailable', 'A current store-owned visual event snapshot is unavailable.', 'model-rubric', 'missing')];
  }
  if (isSuperseded(input.expectationSet.expectationSetId, snapshot.events)) {
    return [unknownFact(requirementId, input, 'stale', 'The visual reference expectation set was superseded; earlier semantic evidence is stale.', 'model-rubric', 'stale')];
  }

  const capability = input.evaluatorCapabilities?.find((entry) => entry.id === parameters.evaluatorProfile) ?? null;
  if (capability === null) {
    return [unknownFact(requirementId, input, 'unavailable', `Evaluator capability "${parameters.evaluatorProfile}" is unavailable.`, 'model-rubric')];
  }
  if (
    capability.kind !== 'model-rubric' ||
    capability.id.trim() === '' ||
    capability.version.trim() === '' ||
    capability.independent !== true ||
    isWorkerProfileId(capability.id) ||
    capability.id === input.producingWorkerProfileId ||
    capability.id === input.producingWorkerInstanceId ||
    (input.evaluatorInstanceId !== null && input.evaluatorInstanceId !== undefined && input.evaluatorInstanceId === input.producingWorkerInstanceId)
  ) {
    return [unknownFact(requirementId, input, 'uncertain', 'The model-rubric capability is not independent from the producing worker.', 'model-rubric')];
  }
  if (!input.candidate.pinned) {
    return [unknownFact(requirementId, input, 'unpinned', 'The transition candidate has no pinned identity.', 'model-rubric')];
  }

  const candidates = visualEvidenceCandidates(input, snapshot, requirementId, 'model-rubric');
  if (candidates.length === 0) {
    return [unknownFact(requirementId, input, 'unavailable', 'No structured model-rubric evidence is recorded for this visual reference.', 'model-rubric', 'missing')];
  }
  const currentCandidates = candidates.filter((item) => sameCandidateContent(input.candidate, candidateFromEvidence(item)));
  if (currentCandidates.length > 0 && !hasReferencedVisualSourceEvent(currentCandidates.at(-1)!.visual, snapshot)) {
    return [unknownFact(requirementId, input, 'unavailable', 'No immutable visual source events exist for the model evidence.', 'model-rubric', 'missing', currentCandidates.map((item) => item.id))];
  }
  const matchingCandidateItems = currentCandidates.filter((item) => {
    if (item.visual?.kind !== 'model-rubric') return false;
    return sameVisualReference(expectation.reference, item.visual.reference) &&
      sameRubricReference(requirementId, expectation.reference, item.visual.rubric) &&
      item.visual.evaluator.id === capability.id &&
      item.visual.evaluator.version === capability.version;
  });
  const matchingCandidates = matchingCandidateItems.flatMap((item) => {
    const visual = item.visual === undefined
      ? null
      : createTrustedVisualEvidence(item.visual, snapshot);
    return visual?.kind === 'model-rubric' ? [{ ...item, visual }] : [];
  });
  if (matchingCandidates.length !== matchingCandidateItems.length) {
    return [unknownFact(requirementId, input, 'uncertain', 'Model evidence does not match immutable source records.', 'model-rubric', 'unknown', matchingCandidateItems.map((item) => item.id))];
  }
  const observedOutcomes = new Set(matchingCandidates.map((item) => item.visual.outcome));
  if (observedOutcomes.size > 1) {
    return [unknownFact(
      requirementId,
      input,
      'uncertain',
      'Conflicting semantic facts share the current visual reference and candidate.',
      'model-rubric',
      'unknown',
      matchingCandidates.map((item) => item.id),
    )];
  }
  const current = matchingCandidates.at(-1) ?? currentCandidates.at(-1);
  if (current === undefined || current.visual?.kind !== 'model-rubric') {
    const latest = candidates.at(-1)!;
    const observed = candidateFromEvidence(latest);
    return [unknownFact(
      requirementId,
      input,
      observed.pinned ? 'stale' : 'unpinned',
      'The model-rubric evidence belongs to a different candidate.',
      'model-rubric',
      'stale',
      [latest.id],
      observed,
    )];
  }

  if (current.visual.kind !== 'model-rubric') {
    return [unknownFact(requirementId, input, 'uncertain', 'Model evidence is not a trusted model-rubric record.', 'model-rubric', 'unknown', [current.id])];
  }
  const trustedVisual = createTrustedVisualEvidence(current.visual, snapshot);
  if (trustedVisual === null || trustedVisual.kind !== 'model-rubric') {
    return [unknownFact(requirementId, input, 'uncertain', 'Model evidence does not match immutable source records.', 'model-rubric', 'unknown', [current.id])];
  }
  const visual = trustedVisual;
  if (!validVisualArtifact(visual.reference) || !validVisualArtifact(visual.candidate)) {
    return [unknownFact(requirementId, input, 'unavailable', 'Model evidence needs bounded, addressable reference and candidate image identities.', 'model-rubric', 'unknown', [current.id])];
  }
  if (!sameVisualReference(expectation.reference, visual.reference) || !sameRubricReference(requirementId, expectation.reference, visual.rubric)) {
    return [unknownFact(requirementId, input, 'stale', 'Model evidence names a different pinned visual reference or rubric.', 'model-rubric', 'stale', [current.id])];
  }
  if (visual.evaluator.id !== capability.id || visual.evaluator.version !== capability.version) {
    return [unknownFact(requirementId, input, 'uncertain', 'Model evidence was produced by a different evaluator capability identity.', 'model-rubric', 'unknown', [current.id])];
  }

  let outcome = visual.outcome;
  let detail = visual.detail ?? modelOutcomeDetail(outcome);
  if (capability.evaluate !== undefined) {
    try {
      const result = capability.evaluate(frozenModelRequest(visual));
      if (!isModelRubricOutcome(result.outcome)) {
        return [unknownFact(requirementId, input, 'uncertain', 'The evaluator capability returned an unsupported semantic outcome.', 'model-rubric', 'unknown', [current.id])];
      }
      outcome = result.outcome;
      detail = result.detail ?? modelOutcomeDetail(outcome);
    } catch (error) {
      return [unknownFact(requirementId, input, 'uncertain', `The evaluator capability was uncertain: ${error instanceof Error ? error.message : 'unknown failure'}.`, 'model-rubric', 'unknown', [current.id])];
    }
  }

  if (outcome === 'uncertain' || outcome === 'conflicting') {
    return [unknownFact(requirementId, input, 'uncertain', detail, 'model-rubric', 'unknown', [current.id])];
  }
  return [makeFact({
    evaluatorKind: 'model-rubric',
    evaluatorClass: 'model',
    requirementId,
    state: outcome,
    observation: outcome,
    validity: 'current',
    evidenceIds: [current.id],
    candidate: input.candidate,
    expectationSetId: input.expectationSet.expectationSetId,
    detail,
  })];
}

interface FactInput {
  evaluatorKind: string;
  evaluatorClass: EvaluatorFact['provenance']['evaluatorClass'];
  requirementId: string;
  authority?: 'user';
  state: EvaluatorFact['state'];
  observation: EvaluatorObservationState;
  validity: EvaluatorFact['provenance']['validity'];
  evidenceIds: readonly string[];
  candidate: CandidateIdentity;
  expectationSetId: string;
  detail: string;
}

function makeFact(input: FactInput): EvaluatorFact {
  const detail = boundDiagnostic(input.detail);
  return {
    requirementId: input.requirementId,
    state: input.state,
    observation: input.observation,
    ...(input.authority === undefined ? {} : { authority: input.authority }),
    evidenceIds: [...input.evidenceIds],
    provenance: {
      evaluatorId: input.evaluatorKind,
      evaluatorKind: input.evaluatorKind,
      evaluatorVersion: CORE_EVALUATOR_VERSION,
      evaluatorClass: input.evaluatorClass,
      expectationSetId: input.expectationSetId,
      candidate: cloneCandidate(input.candidate),
      evidenceIds: [...input.evidenceIds],
      validity: input.validity,
      detail,
    },
    detail,
    diagnostics: detail === null ? [] : [detail],
  };
}

function unknownFact(
  requirementId: string,
  input: Partial<GuardrailEvaluatorInput> & { expectationSet?: ExpectationSet },
  validity: EvaluatorFact['provenance']['validity'],
  detail: string,
  evaluatorKind: string,
  observation: EvaluatorObservationState = 'unknown',
  evidenceIds: readonly string[] = [],
  observedCandidate?: CandidateIdentity,
): EvaluatorFact {
  const candidate = observedCandidate ?? input.candidate ?? unidentifiedCandidate();
  return makeFact({
    evaluatorKind,
    evaluatorClass: evaluatorKind === 'mandatory-answer' || evaluatorKind === 'human-attestation'
      ? 'human'
      : evaluatorKind === 'pixel-diff'
        ? 'pixel'
        : evaluatorKind === 'model-rubric'
          ? 'model'
          : 'deterministic',
    requirementId,
    ...(evaluatorKind === 'mandatory-answer' || evaluatorKind === 'human-attestation' ? { authority: 'user' as const } : {}),
    state: 'unknown',
    observation,
    validity,
    evidenceIds,
    candidate,
    expectationSetId: input.expectationSet?.expectationSetId ?? 'unidentified-expectation-set',
    detail,
  });
}

function normalizeFact(fact: EvaluatorFact): EvaluatorFact {
  const detail = fact.detail === null ? null : boundDiagnostic(fact.detail);
  const diagnostics = (fact.diagnostics ?? []).map(boundDiagnostic).filter((entry): entry is string => entry !== null);
  return {
    ...fact,
    evidenceIds: [...fact.evidenceIds],
    provenance: {
      ...fact.provenance,
      evaluatorKind: fact.provenance.evaluatorKind ?? fact.provenance.evaluatorId,
      evidenceIds: [...fact.provenance.evidenceIds],
      detail,
      candidate: cloneCandidate(fact.provenance.candidate),
    },
    detail,
    diagnostics,
  };
}

function expectationId(input: Partial<GuardrailEvaluatorInput>): string {
  const parameters = input.guardrail?.parameters;
  return isRecord(parameters) && typeof parameters.expectationItem === 'string'
    ? parameters.expectationItem
    : input.guardrail?.id ?? 'unknown-expectation';
}

type VisualEvidenceItem = EvidenceItem & { visual: VisualEvidence };

function visualEvidenceCandidates(
  input: GuardrailEvaluatorInput,
  snapshot: EventLogSnapshot,
  requirementId: string,
  kind: VisualEvidence['kind'],
): VisualEvidenceItem[] {
  const recordedEvidence = foldEvidence(snapshot.events.filter((event) =>
    event.kind !== 'evidence.recorded' || event.agent === null,
  ));
  return recordedEvidence
    .filter((item): item is VisualEvidenceItem =>
      item.kind === 'artifact' && item.visual !== undefined && item.visual.kind === kind,
    )
    .filter((item) => visualEvidenceMatchesExpectation(item, input.expectationSet.expectationSetId, requirementId))
    .sort(compareEvidence);
}

function hasReferencedVisualSourceEvent(visual: VisualEvidence, snapshot: EventLogSnapshot): boolean {
  const index = foldVisualSourceEvents(snapshot.events, snapshot.threadId);
  const referenceId = visual.reference.eventId;
  const candidateId = visual.candidate.eventId;
  if (referenceId === null || candidateId === null ||
    !index.artifacts.has(referenceId) || !index.artifacts.has(candidateId)) return false;
  if (visual.kind === 'model-rubric') {
    return visual.rubric.eventId !== null &&
      visual.evaluator.eventId !== null &&
      index.rubrics.has(visual.rubric.eventId) &&
      index.capabilities.has(visual.evaluator.eventId);
  }
  return true;
}

function visualEvidenceMatchesExpectation(item: EvidenceItem, expectationSetId: string, expectationItemId: string): boolean {
  return item.expectationSetId === expectationSetId && item.expectationItemId === expectationItemId;
}

function validVisualEvidenceShape(value: unknown): value is VisualEvidence {
  if (!isRecord(value) || (value.kind !== 'pixel-diff' && value.kind !== 'model-rubric')) return false;
  if (!validVisualArtifact(value.reference) || !validVisualArtifact(value.candidate)) return false;
  if (value.kind === 'pixel-diff') return validPixelCapture(value.capture) && validPixelMeasurement(value.measurement);
  return validRubricIdentity(value.rubric) && validEvaluatorIdentity(value.evaluator) && isModelRubricOutcome(value.outcome);
}

function validVisualArtifact(value: unknown): value is VisualArtifactIdentity {
  if (!isRecord(value)) return false;
  const identityValid = [value.eventId, value.artifactId, value.locator, value.revision, value.digest]
    .every((value) => typeof value === 'string' && value.trim() !== '' && value.length <= 512);
  const selector = value.selector;
  return identityValid && (selector === undefined || selector === null ||
    (typeof selector === 'string' && selector.trim() !== '' && selector.length <= 512));
}

function validRubricIdentity(value: unknown): value is ModelRubricEvidence['rubric'] {
  return isRecord(value) && [value.eventId, value.id, value.revision, value.digest]
    .every((entry) => typeof entry === 'string' && entry.trim() !== '' && entry.length <= 512);
}

function validEvaluatorIdentity(value: unknown): value is ModelRubricEvidence['evaluator'] {
  return isRecord(value) && [value.eventId, value.id, value.version]
    .every((entry) => typeof entry === 'string' && entry.trim() !== '' && entry.length <= 512);
}

function sameVisualArtifactIdentity(left: VisualArtifactIdentity, right: VisualArtifactIdentity): boolean {
  return left.eventId === right.eventId &&
    left.artifactId === right.artifactId &&
    left.locator === right.locator &&
    left.revision === right.revision &&
    left.digest === right.digest &&
    (left.selector ?? null) === (right.selector ?? null);
}

function sameRubricIdentity(
  left: { eventId: string; id: string; revision: string; digest: string },
  right: ModelRubricEvidence['rubric'],
): boolean {
  return left.eventId === right.eventId &&
    left.id === right.id &&
    left.revision === right.revision &&
    left.digest === right.digest;
}

function sameEvaluatorIdentity(
  left: { eventId: string; id: string; version: string },
  right: ModelRubricEvidence['evaluator'],
): boolean {
  return left.eventId === right.eventId &&
    left.id === right.id &&
    left.version === right.version;
}

function sameVisualReference(
  expected: ReferenceIdentity,
  actual: VisualArtifactIdentity,
): boolean {
  return expected.locator === actual.locator &&
    expected.nativeRevision === actual.revision &&
    expected.contentDigest === actual.digest &&
    (expected.selector === undefined || expected.selector === null || actual.selector === expected.selector);
}

function sameRubricReference(
  requirementId: string,
  expected: ReferenceIdentity,
  actual: ModelRubricEvidence['rubric'],
): boolean {
  return actual.id === requirementId &&
    actual.revision === expected.nativeRevision &&
    actual.digest === expected.contentDigest;
}

function pixelCapture(value: unknown): PixelCaptureContract | null {
  return validPixelCapture(value) ? value : null;
}

function validPixelCapture(value: unknown): value is PixelCaptureContract {
  if (!isRecord(value)) return false;
  const textFields = ['browser', 'runtime', 'viewport', 'fonts', 'data', 'animation', 'region'] as const;
  if (textFields.some((field) => typeof value[field] !== 'string' || value[field].trim() === '' || value[field].length > 512)) return false;
  if (typeof value.viewport !== 'string' || !/^\d+x\d+$/.test(value.viewport)) return false;
  if (typeof value.dpr !== 'number' || !Number.isFinite(value.dpr) || value.dpr <= 0) return false;
  return value.selector === undefined || value.selector === null ||
    (typeof value.selector === 'string' && value.selector.trim() !== '' && value.selector.length <= 512);
}

function samePixelCapture(left: PixelCaptureContract, right: PixelCaptureContract): boolean {
  return left.browser === right.browser &&
    left.runtime === right.runtime &&
    left.viewport === right.viewport &&
    left.dpr === right.dpr &&
    left.fonts === right.fonts &&
    left.data === right.data &&
    left.animation === right.animation &&
    left.region === right.region &&
    (left.selector ?? null) === (right.selector ?? null);
}

function validPixelMeasurement(value: unknown): value is {
  comparedPixels: number;
  differentPixels: number;
  equal: boolean;
  exact: boolean;
} {
  if (!isRecord(value)) return false;
  const comparedPixels = value.comparedPixels;
  const differentPixels = value.differentPixels;
  return typeof comparedPixels === 'number' && Number.isInteger(comparedPixels) && comparedPixels > 0 &&
    typeof differentPixels === 'number' && Number.isInteger(differentPixels) && differentPixels >= 0 && differentPixels <= comparedPixels &&
    typeof value.equal === 'boolean' && typeof value.exact === 'boolean' &&
    value.equal === (differentPixels === 0);
}

function frozenModelRequest(visual: ModelRubricEvidence): {
  reference: VisualArtifactIdentity;
  candidate: VisualArtifactIdentity;
  rubric: ModelRubricEvidence['rubric'];
} {
  return Object.freeze({
    reference: Object.freeze({ ...visual.reference }),
    candidate: Object.freeze({ ...visual.candidate }),
    rubric: Object.freeze({ ...visual.rubric }),
  });
}

function isModelRubricOutcome(value: unknown): value is ModelRubricOutcome {
  return value === 'satisfied' || value === 'failed' || value === 'uncertain' || value === 'conflicting';
}

function freezeVisualEvidence(visual: VisualEvidence): VisualEvidence {
  return deepFreeze(JSON.parse(JSON.stringify(visual)) as VisualEvidence);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function isWorkerProfileId(value: string): boolean {
  return value === 'claude' || value === 'codex' || value === 'qwen-local' ||
    /^(openai-compatible|openai|anthropic|google|claude|codex|qwen|llama|gemini|gpt|o[1-9])(?:[-.]|$)/i.test(value);
}

function modelOutcomeDetail(outcome: ModelRubricOutcome): string {
  switch (outcome) {
    case 'satisfied':
      return 'The independent model rubric returned a satisfied observation.';
    case 'failed':
      return 'The independent model rubric returned a failed observation.';
    case 'uncertain':
      return 'The independent model rubric returned an uncertain observation.';
    case 'conflicting':
      return 'The independent model rubric returned conflicting observations.';
  }
}

function candidateFromEvidence(item: EvidenceItem): CandidateIdentity {
  return {
    kind: 'working-tree',
    id: item.state.tree ?? item.state.commit ?? `evidence:${item.id}`,
    revision: item.state.commit,
    digest: item.state.tree,
    pinned: item.state.tree !== null,
  };
}

function sameCandidate(left: CandidateIdentity, right: CandidateIdentity): boolean {
  return left.kind === right.kind &&
    left.id === right.id &&
    left.revision === right.revision &&
    left.digest === right.digest &&
    left.pinned === right.pinned;
}

function sameCandidateContent(left: CandidateIdentity, right: CandidateIdentity): boolean {
  if (!left.pinned || !right.pinned) return false;
  if (left.kind !== right.kind && left.kind !== 'working-tree' && right.kind !== 'working-tree') return false;
  if (left.kind === 'working-tree' || right.kind === 'working-tree') {
    return left.digest !== null && right.digest !== null && left.digest === right.digest;
  }
  return left.id === right.id && left.revision === right.revision && left.digest === right.digest;
}

function isConcreteEvidence(item: EvidenceItem, events: readonly HarnessEvent[]): boolean {
  // Core command evidence is produced by runCheck and carries a typed check result even
  // when no separate tool event exists. A summary alone never enters this branch.
  if (item.kind === 'command' && item.check !== null) return true;
  if (item.ref.eventId === null) return false;
  const referenced = events.find((event) => event.id === item.ref.eventId);
  if (referenced === undefined) return false;
  switch (item.kind) {
    case 'command':
      return referenced.kind === 'tool.completed' || referenced.kind === 'tool.started';
    case 'diff':
      return referenced.kind === 'diff.updated';
    case 'artifact':
      return referenced.kind === 'artifact.updated';
    case 'approval':
      return referenced.kind === 'approval.resolved';
    default:
      return false;
  }
}

function evidenceMatchesExpectation(item: EvidenceItem, expectationSetId: string, expectationItemId: string): boolean {
  return (item.expectationSetId === undefined || item.expectationSetId === null || item.expectationSetId === expectationSetId) &&
    (item.expectationItemId === undefined || item.expectationItemId === null || item.expectationItemId === expectationItemId);
}

function isSuperseded(expectationSetId: string, events: readonly HarnessEvent[]): boolean {
  if (foldExpectationSetSupersessions(events).has(expectationSetId)) return true;
  return [...foldExpectationSets(events).values()].some((set) => set.supersedes === expectationSetId);
}

function validTypedAnswer(answer: unknown): boolean {
  if (!isRecord(answer) || typeof answer.type !== 'string') return false;
  switch (answer.type) {
    case 'string':
      return typeof answer.value === 'string' && answer.value.trim() !== '';
    case 'choice':
      return typeof answer.value === 'string' && answer.value.trim() !== '';
    case 'number':
      return typeof answer.value === 'number' && Number.isFinite(answer.value);
    case 'boolean':
      return typeof answer.value === 'boolean';
    default:
      return false;
  }
}

function hasAnswerConflict(events: readonly HarnessEvent[], expectationSetId: string, expectationItemId: string): boolean {
  const authoritative = new Map(foldAnswers(events).map((answer) => [answer.answerId, answer]));
  for (const [answerId, conflicting] of foldTypedAnswerConflicts(events)) {
    const first = authoritative.get(answerId);
    if (
      (first?.expectationSetId === expectationSetId && first.expectationItemId === expectationItemId) ||
      conflicting.some((answer) => answer.expectationSetId === expectationSetId && answer.expectationItemId === expectationItemId)
    ) return true;
  }
  return false;
}

function hasAttestationConflict(events: readonly HarnessEvent[], expectationSetId: string, expectationItemId: string): boolean {
  const authoritative = new Map(foldAttestations(events).map((attestation) => [attestation.attestationId, attestation]));
  for (const [attestationId, conflicting] of foldHumanAttestationConflicts(events)) {
    const first = authoritative.get(attestationId);
    if (
      (first?.expectationSetId === expectationSetId && first.expectationItemId === expectationItemId) ||
      conflicting.some((attestation) => attestation.expectationSetId === expectationSetId && attestation.expectationItemId === expectationItemId)
    ) return true;
  }
  return false;
}

function compareEvidence(left: EvidenceItem, right: EvidenceItem): number {
  return left.at - right.at || left.id.localeCompare(right.id);
}

function cloneCandidate(candidate: CandidateIdentity): CandidateIdentity {
  return { ...candidate };
}

function unidentifiedCandidate(): CandidateIdentity {
  return {
    kind: 'revision',
    id: 'unidentified-candidate',
    revision: null,
    digest: null,
    pinned: false,
  };
}

function boundDiagnostic(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length <= EVALUATOR_DIAGNOSTIC_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, EVALUATOR_DIAGNOSTIC_MAX_CHARS - 14)}…[truncated]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
