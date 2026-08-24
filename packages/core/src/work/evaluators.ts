import type {
  CandidateIdentity,
  EvidenceItem,
  EvaluatorFact,
  EvaluatorObservationState,
  ExpectationSet,
  HarnessEvent,
  RequirementResult,
  VerifyCommand,
  WorkspaceGuardrail,
  WorkspaceGuardrailKind,
} from '@awos/protocol';
import { EVALUATOR_DIAGNOSTIC_MAX_CHARS } from '@awos/protocol';
import {
  foldAttestations,
  foldAnswers,
  foldHumanAttestationConflicts,
  foldTypedAnswerConflicts,
  foldExpectationSets,
  foldExpectationSetSupersessions,
} from './ledger.js';

export { EVALUATOR_DIAGNOSTIC_MAX_CHARS } from '@awos/protocol';

/** The built-ins deliberately stop at deterministic evidence and explicit human input. */
export type CoreEvaluatorKind =
  | 'verification'
  | 'evidence-present'
  | 'mandatory-answer'
  | 'human-attestation';

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
});

/** Stable list used by callers that need to report which capabilities the core has. */
export const CORE_EVALUATOR_KINDS: readonly CoreEvaluatorKind[] = Object.freeze([
  'verification',
  'evidence-present',
  'mandatory-answer',
  'human-attestation',
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
    return evaluator.evaluate(input).map((fact) => normalizeFact(fact));
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
    evaluatorClass: evaluatorKind === 'mandatory-answer' || evaluatorKind === 'human-attestation' ? 'human' : 'deterministic',
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
