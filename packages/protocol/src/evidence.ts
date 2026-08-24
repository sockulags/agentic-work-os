/**
 * What a run produced, what supports that claim, and what is worth keeping.
 *
 * A `turn.completed` with reason `completed` means an agent stopped without a protocol
 * error. It does not mean the work is right, and nothing in the log distinguishes the two.
 * These three records close that gap without pretending to judge anything:
 *
 *   - an **outcome**, stated by whoever is in a position to state it;
 *   - **evidence**, pointing at facts already in the log, or at something outside it;
 *   - **retained context** — what was learned, decided, ruled out or left open.
 *
 * None of it is scored, ranked or inferred. A passing test is a passing test; whether it
 * shows the work was done is a claim a person or an agent makes, attributed to them.
 *
 * All three are append-only. A correction is a new record carrying the same id, and the
 * fold takes the last one — so the current answer is cheap to read and every earlier claim
 * is still in the log, in order, with its author and its time.
 */

import type { AgentId } from './events.js';

/** What a run claims to have achieved. Distinct from how the turn ended. */
export type RunClaim = 'delivered' | 'partial' | 'blocked' | 'abandoned';

/** Where an evidence item points. */
export type EvidenceKind = 'command' | 'diff' | 'artifact' | 'approval' | 'link' | 'note';

export type RetainedKind = 'discovery' | 'decision' | 'constraint' | 'question';

/** Who made a claim. `user` is the person at the keyboard; the rest are the agents. */
export type ClaimSource = 'user' | AgentId;

/**
 * What the evidence points at.
 *
 * `eventId` refers to a fact already in this thread's log — a command that ran, a diff, an
 * artifact, an approval — which is what keeps evidence from being a retelling. `url` is
 * for the things that are true outside the harness, and a person has to supply those.
 */
export interface EvidenceRef {
  eventId: string | null;
  url: string | null;
  /** What to show when the referenced fact is not on screen. */
  label: string;
}

/**
 * The code the evidence is about.
 *
 * Both halves matter: `commit` says which revision, `tree` is the hash of the working tree
 * as it actually stood, including anything uncommitted. `dirty` is the comparison already
 * made, because "the tests passed" means something different when the tree did not match
 * any commit. All null outside a git repository, where none of this can be established.
 */
export interface WorkingState {
  commit: string | null;
  tree: string | null;
  dirty: boolean;
}

/**
 * The result of a check the project named.
 *
 * Present only on evidence produced by running one, which is what lets a gate tell "this
 * is the `test` check, and it passed" from "somebody attached a command that mentions
 * tests". Everything else — what ran, against which tree — is on the evidence itself.
 */
export interface CheckResult {
  /** A `verify` entry's name. */
  name: string;
  passed: boolean;
  exitCode: number | null;
}

export interface EvidenceItem {
  id: string;
  /** The run it came out of, or null for a check run outside one. */
  runId: string | null;
  /** The work item it is about, or null when the thread has none. */
  workItemId: string | null;
  threadId: string;
  kind: EvidenceKind;
  ref: EvidenceRef;
  summary: string;
  state: WorkingState;
  check: CheckResult | null;
  source: ClaimSource;
  at: number;
}

export interface RetainedItem {
  id: string;
  workItemId: string;
  kind: RetainedKind;
  text: string;
  /** The run it came out of, or null when it was written down outside one. */
  runId: string | null;
  threadId: string;
  source: ClaimSource;
  at: number;
  /** Whether later runs on this work item are given it. */
  selected: boolean;
  /** Kept, but no longer true or no longer useful. Never deleted. */
  retired: boolean;
}

export interface RunOutcome {
  runId: string;
  claim: RunClaim;
  statement: string;
  source: ClaimSource;
  at: number;
}

/**
 * Why an integration was allowed or refused, requirement by requirement.
 *
 * `missing` — nothing has run it. `failed` — the last result for it was a failure.
 * `stale` — it passed, but against a tree that is not the one being integrated, which is
 * the case text instructions cannot catch and the reason evidence is bound to a tree at
 * all. `satisfied` — it passed against exactly this candidate.
 */
export type RequirementState = 'satisfied' | 'missing' | 'failed' | 'stale';

export interface RequirementResult {
  name: string;
  command: string;
  state: RequirementState;
  /** The evidence that decided it, when there was any. */
  evidenceId: string | null;
  /** The tree that evidence was recorded against, for comparison with the candidate. */
  evidenceTree: string | null;
}

/** A recorded decision to integrate anyway, where the project permits one. */
export interface GateOverride {
  actor: ClaimSource;
  reason: string;
}

/** The authority level of one pinned expectation. */
export type Enforcement = 'advisory' | 'required' | 'absolute';

/** The closed set of expectation kinds supported by the core contract. */
export type ExpectationItemKind =
  | 'requirement'
  | 'plan'
  | 'constraint'
  | 'policy'
  | 'prototype'
  | 'visual-reference'
  | 'mandatory-question';

/** Canonical source classes for immutable expectation references. */
export type ExpectationSourceKind =
  | 'github-snapshot'
  | 'repository-file'
  | 'workspace-declaration'
  | 'artifact-snapshot'
  | 'provider-revision'
  | 'external-digest'
  | 'human-answer';

/** Content identity for one source selected into an expectation set. */
export interface ReferenceIdentity {
  sourceKind: ExpectationSourceKind;
  /** Canonical locator, never a display label or an unresolved relative path. */
  locator: string;
  /** The source-native revision captured when the expectation was pinned. */
  nativeRevision: string;
  /** Digest of the selected source content. */
  contentDigest: string;
  /** Optional approved fragment within the source. */
  selector?: string | null;
}

/** One typed, immutable expectation in a set. */
export interface ExpectationItem {
  id: string;
  kind: ExpectationItemKind;
  name: string;
  enforcement: Enforcement;
  reference: ReferenceIdentity;
}

/** Who owns the source and who authorized pinning it. */
export interface ExpectationAuthority {
  sourceOwner: string;
  pinnedBy: string;
}

/** Optional workflow scope carried by an expectation set. */
export interface ExpectationScope {
  workItemId: string | null;
  sourceStepId: string;
  targetStepId: string;
}

/** Immutable intent against which a transition is evaluated. */
export interface ExpectationSet {
  expectationSetId: string;
  manifestDigest: string;
  items: readonly ExpectationItem[];
  authority: ExpectationAuthority;
  scope?: ExpectationScope;
  /** The prior set, when this set is an authorized replacement. */
  supersedes?: string | null;
}

/** Candidate identity that remains stable across evaluation and replay. */
export type CandidateKind = 'working-tree' | 'commit' | 'artifact' | 'answer' | 'revision';

export interface CandidateIdentity {
  kind: CandidateKind;
  id: string;
  revision: string | null;
  digest: string | null;
  /** False means the candidate could not be pinned to a stable revision. */
  pinned: boolean;
}

export type TransitionActor = ClaimSource;

/** One attempted move between two workflow steps. */
export interface TransitionAttempt {
  transitionId: string;
  /** Starts at one and increases for every re-evaluation of this transition. */
  attempt: number;
  runId: string | null;
  actor: TransitionActor;
  sourceStepId: string;
  targetStepId: string;
  expectationSetId: string;
  candidate: CandidateIdentity;
  evidenceIds: readonly string[];
  /** A new transition may explicitly replace an earlier one. */
  supersedesTransitionId?: string | null;
}

export type EvaluatorFactState = 'satisfied' | 'failed' | 'unknown';

/** Why a fact cannot be treated as current, even when an adapter returned a result. */
export type EvaluatorFactValidity =
  | 'current'
  | 'stale'
  | 'unpinned'
  | 'unavailable'
  | 'uncertain';

/** Provenance supplied by an evaluator, not a verdict chosen by it. */
export interface EvaluatorProvenance {
  evaluatorId: string;
  evaluatorVersion: string;
  evaluatorClass: 'deterministic' | 'human' | 'model' | 'pixel' | 'other';
  expectationSetId: string;
  candidate: CandidateIdentity;
  evidenceIds: readonly string[];
  validity: EvaluatorFactValidity;
  detail: string | null;
}

/** A single evaluator observation. The core owns the transition verdict. */
export interface EvaluatorFact {
  requirementId: string;
  /** Existing gate terminology uses the same `state` vocabulary. */
  state: EvaluatorFactState;
  evidenceIds: readonly string[];
  provenance: EvaluatorProvenance;
  detail: string | null;
}

export interface RequirementEnforcement {
  requirementId: string;
  enforcement: Enforcement;
}

/** A required evidence item named by a structured refusal. */
export interface RequiredEvidence {
  requirementIds: readonly string[];
  description: string;
}

/** A structured answer that must be supplied by an authorized human. */
export interface RequiredStructuredAnswer {
  questionId: string;
  description: string;
  schema: string | null;
}

export type RefusalRequirement =
  | { kind: 'evidence'; evidence: RequiredEvidence }
  | { kind: 'structured-answer'; answer: RequiredStructuredAnswer };

export type TransitionNextAction =
  | 'correct-candidate'
  | 'provide-evidence'
  | 'provide-answer'
  | 'request-override'
  | 'escalate';

/** The complete actionable blocker contract shared by workers and people. */
export interface TransitionRefusal {
  unmetRequirementIds: readonly string[];
  reason: string;
  required: RefusalRequirement;
  responsibleActor: TransitionActor;
  /** One closed next action, not a list of suggestions. */
  nextAction: TransitionNextAction;
  retryable: boolean;
}

/** A legal override is always an explicit, authorized-user override of required intent. */
export interface RequiredTransitionOverride {
  enforcement: 'required';
  permission: 'explicit';
  permissionGranted: true;
  actor: 'user';
  authorizedUserId: string;
  reason: string;
}

export type TransitionOverride = RequiredTransitionOverride;

export type TransitionVerdict = 'passed' | 'retry' | 'waiting-for-human' | 'blocked' | 'failed';

export interface TransitionEvaluationBase extends TransitionAttempt {
  facts: readonly EvaluatorFact[];
  provenance: readonly EvaluatorProvenance[];
  enforcement: readonly RequirementEnforcement[];
  timestamp: number;
  supersedesTransitionId: string | null;
}

/** A passed evaluation cannot carry a refusal; refused verdicts cannot carry an override. */
export type TransitionEvaluation =
  | (TransitionEvaluationBase & {
      verdict: 'passed';
      refusal: null;
      override: TransitionOverride | null;
    })
  | (TransitionEvaluationBase & {
      verdict: Exclude<TransitionVerdict, 'passed'>;
      refusal: TransitionRefusal;
      override: null;
    });

export type TransitionEvaluationInput =
  | (Omit<TransitionEvaluationBase, 'supersedesTransitionId'> & {
      verdict: 'passed';
      refusal: null;
      override: TransitionOverride | null;
      supersedesTransitionId?: string | null;
      previous?: TransitionEvaluation;
    })
  | (Omit<TransitionEvaluationBase, 'supersedesTransitionId'> & {
      verdict: Exclude<TransitionVerdict, 'passed'>;
      refusal: TransitionRefusal;
      override: null;
      supersedesTransitionId?: string | null;
      previous?: TransitionEvaluation;
    });

/** Runtime boundary for the two illegal combinations the type union forbids. */
export function createTransitionEvaluation(input: TransitionEvaluationInput): TransitionEvaluation {
  const { previous, ...record } = input;
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    throw new Error('Transition attempts must be positive integers.');
  }
  if (
    previous !== undefined &&
    previous.transitionId === input.transitionId &&
    input.attempt <= previous.attempt
  ) {
    throw new Error('Transition attempts must increase for the same transition identity.');
  }
  const override = input.override ?? null;
  const refusal = input.refusal ?? null;
  if (input.verdict === 'passed' && refusal !== null) {
    throw new Error('A passed transition cannot carry a refusal.');
  }
  if (input.verdict !== 'passed' && (refusal === null || override !== null)) {
    throw new Error('A refused transition needs a refusal and cannot carry an override.');
  }
  const evaluation = {
    ...record,
    evidenceIds: [...input.evidenceIds],
    facts: [...input.facts],
    provenance: [...input.provenance],
    enforcement: [...input.enforcement],
    supersedesTransitionId: input.supersedesTransitionId ?? null,
    refusal,
    override,
  } as TransitionEvaluation;

  const invalidReason = validateTransitionEvaluation(evaluation);
  if (invalidReason !== null) throw new Error(invalidReason);
  return evaluation;
}

/**
 * Whether an evaluator fact is bound to this exact, pinned transition candidate.
 *
 * This checks provenance only. Callers still decide whether the fact's state is suitable
 * for the enforcement level they are evaluating.
 */
export function isCurrentPinnedEvaluatorFact(
  fact: EvaluatorFact,
  attempt: Pick<TransitionAttempt, 'expectationSetId' | 'candidate'>,
): boolean {
  return isCurrentPinnedEvaluatorProvenance(fact.provenance, attempt);
}

function isCurrentPinnedEvaluatorProvenance(
  provenance: EvaluatorProvenance,
  attempt: Pick<TransitionAttempt, 'expectationSetId' | 'candidate'>,
): boolean {
  return (
    provenance.validity === 'current' &&
    provenance.expectationSetId === attempt.expectationSetId &&
    provenance.candidate.pinned &&
    attempt.candidate.pinned &&
    provenance.candidate.kind === attempt.candidate.kind &&
    provenance.candidate.id === attempt.candidate.id &&
    provenance.candidate.revision === attempt.candidate.revision &&
    provenance.candidate.digest === attempt.candidate.digest
  );
}

/**
 * Validate the persisted shape that is allowed to carry a passed verdict.
 *
 * This is shared by the constructor and replay folds. A passed evaluation must have one
 * fact for every enforcement entry, no extra or duplicate facts, and every fact must be
 * current and pinned to the exact candidate. Required failures are only legal with an
 * auditable explicit override; absolute failures are never legal in a passed record.
 * Advisory failures remain visible without blocking, matching the core evaluator.
 */
export function validateTransitionEvaluation(evaluation: TransitionEvaluation): string | null {
  const factIds = new Set<string>();
  for (const fact of evaluation.facts) {
    if (factIds.has(fact.requirementId)) {
      return 'Each requirement may have only one evaluator fact per attempt.';
    }
    factIds.add(fact.requirementId);
  }

  const enforcementById = new Map<string, RequirementEnforcement['enforcement']>();
  for (const entry of evaluation.enforcement) {
    if (enforcementById.has(entry.requirementId)) {
      return 'Each requirement may have only one enforcement entry per attempt.';
    }
    enforcementById.set(entry.requirementId, entry.enforcement);
  }

  if (evaluation.override !== null) {
    const override = evaluation.override;
    if (
      override.enforcement !== 'required' ||
      override.permission !== 'explicit' ||
      override.permissionGranted !== true ||
      override.actor !== 'user' ||
      override.authorizedUserId.trim() === '' ||
      override.reason.trim() === ''
    ) {
      return 'A transition override needs explicit permission, an authorized user, and a reason.';
    }
  }

  if (evaluation.verdict !== 'passed') {
    return null;
  }

  if (
    evaluation.provenance.length !== evaluation.facts.length ||
    evaluation.provenance.some((provenance) => !isCurrentPinnedEvaluatorProvenance(provenance, evaluation))
  ) {
    return 'A passed transition requires current, pinned evaluator provenance for every fact.';
  }

  const factsById = new Map(evaluation.facts.map((fact) => [fact.requirementId, fact]));
  if (factsById.size !== enforcementById.size) {
    return 'A passed transition needs exactly one evaluator fact for every enforcement entry.';
  }

  for (const [requirementId, enforcement] of enforcementById) {
    const fact = factsById.get(requirementId);
    if (fact === undefined) {
      return 'A passed transition cannot omit an enforced evaluator fact.';
    }
    if (!isCurrentPinnedEvaluatorFact(fact, evaluation)) {
      return 'A passed transition requires current, pinned evaluator facts for its candidate.';
    }
    if (fact.state === 'unknown') {
      return 'A passed transition cannot contain an unknown evaluator fact.';
    }
    if (enforcement === 'absolute' && fact.state !== 'satisfied') {
      return 'Absolute expectations cannot be overridden.';
    }
    if (evaluation.override === null && enforcement === 'required' && fact.state !== 'satisfied') {
      return 'A required failed expectation needs an eligible explicit override.';
    }
  }

  if (evaluation.override !== null) {
    const requiredFailures = [...enforcementById].filter(([requirementId, enforcement]) =>
      enforcement === 'required' && factsById.get(requirementId)?.state === 'failed',
    );
    if (requiredFailures.length === 0) {
      return 'An explicit override must cover a current failed required expectation.';
    }
  }

  return null;
}

/** Runtime boundary for required overrides; absolute intent has no constructor. */
export function createRequiredTransitionOverride(input: {
  permissionGranted: boolean;
  authorizedUserId: string;
  reason: string;
}): RequiredTransitionOverride {
  if (!input.permissionGranted) throw new Error('An explicit override permission is required.');
  if (input.authorizedUserId.trim() === '') throw new Error('An authorized user is required.');
  if (input.reason.trim() === '') throw new Error('An override reason is required.');
  return {
    enforcement: 'required',
    permission: 'explicit',
    permissionGranted: true,
    actor: 'user',
    authorizedUserId: input.authorizedUserId,
    reason: input.reason,
  };
}

/** Runtime boundary for immutable expectation-set records. */
export function createExpectationSet(input: ExpectationSet): ExpectationSet {
  if (input.expectationSetId.trim() === '') throw new Error('An expectation set id is required.');
  if (input.manifestDigest.trim() === '') throw new Error('An expectation manifest digest is required.');
  if (input.authority.sourceOwner.trim() === '' || input.authority.pinnedBy.trim() === '') {
    throw new Error('Expectation authority must identify the source owner and pinning actor.');
  }
  const ids = new Set<string>();
  for (const item of input.items) {
    if (item.id.trim() === '' || ids.has(item.id)) throw new Error('Expectation item ids must be unique and non-empty.');
    ids.add(item.id);
    if (item.name.trim() === '') throw new Error('Expectation item names must be non-empty.');
    if (item.reference.locator.trim() === '' || item.reference.nativeRevision.trim() === '' || item.reference.contentDigest.trim() === '') {
      throw new Error('Expectation references must be canonical, revision-pinned, and content-digested.');
    }
  }
  if (input.supersedes !== undefined && input.supersedes !== null && input.supersedes.trim() === '') {
    throw new Error('An expectation supersession identity must be non-empty when present.');
  }
  return {
    ...input,
    items: input.items.map((item) => ({
      ...item,
      reference: { ...item.reference },
    })),
  };
}

/** How much retained context a run's prompt will carry. */
export const RETAINED_CONTEXT_MAX_CHARS = 4_000;

/**
 * Where an agent writes what it wants kept, relative to its working directory.
 *
 * A file, for the same reason artifacts are a file: it is the one publishing mechanism
 * both CLIs already have, needs nothing registered with either of them, and leaves a real
 * artifact on disk. One JSON object per line, `{"kind":"decision","text":"…"}`.
 */
export const RETAINED_FILE = '.awos/retained.jsonl';
