import type {
  ClaimSource,
  EvidenceItem,
  ExpectationSet,
  HarnessEvent,
  HumanAttestationRecord,
  RetainedItem,
  RunOutcome,
  TypedAnswerRecord,
  TransitionEvaluation,
} from '@awos/protocol';
import { validateTransitionEvaluation } from '@awos/protocol';

/**
 * Reading outcomes, evidence and retained context back out of the log.
 *
 * Folds over the same append-only record deliberately distinguish correction-capable
 * claims from immutable identities. Answers, attestations and expectation sets keep the
 * first definition authoritative; a conflicting duplicate is exposed separately instead
 * of silently changing the policy or human record used by an evaluator.
 *
 * Pure functions over events, so the answer after a restart is the answer the live socket
 * gave: replaying `events.jsonl` through these produces exactly the same result.
 */

/** `agent: null` on a harness-level event means the person at the keyboard. */
function sourceOf(event: HarnessEvent): ClaimSource {
  return event.agent ?? 'user';
}

function sameRecord(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The current outcome of each run, keyed by run id. */
export function foldOutcomes(events: readonly HarnessEvent[]): Map<string, RunOutcome> {
  const outcomes = new Map<string, RunOutcome>();
  for (const event of events) {
    if (event.kind !== 'run.closed') continue;
    outcomes.set(event.runId, {
      runId: event.runId,
      claim: event.claim,
      statement: event.statement,
      source: sourceOf(event),
      at: event.ts,
    });
  }
  return outcomes;
}

/** Every evidence item, oldest first, each at its latest version. */
export function foldEvidence(events: readonly HarnessEvent[]): EvidenceItem[] {
  const items = new Map<string, EvidenceItem>();
  for (const event of events) {
    if (event.kind !== 'evidence.recorded') continue;
    items.set(event.evidenceId, {
      id: event.evidenceId,
      runId: event.runId,
      workItemId: event.workItemId,
      threadId: event.threadId,
      kind: event.evidenceKind,
      ref: event.ref,
      summary: event.summary,
      state: event.state,
      check: event.check,
      ...(event.expectationSetId === undefined ? {} : { expectationSetId: event.expectationSetId }),
      ...(event.expectationItemId === undefined ? {} : { expectationItemId: event.expectationItemId }),
      source: sourceOf(event),
      at: event.ts,
    });
  }
  return [...items.values()];
}

/** Every typed answer, oldest first, with corrections folded by answer identity. */
export function foldTypedAnswers(events: readonly HarnessEvent[]): TypedAnswerRecord[] {
  const answers = new Map<string, TypedAnswerRecord>();
  for (const event of events) {
    if (event.kind !== 'answer.recorded') continue;
    const answer = {
      answerId: event.answerId,
      expectationItemId: event.expectationItemId,
      expectationSetId: event.expectationSetId,
      actor: event.actor,
      authority: event.authority,
      answer: event.answer,
      candidate: event.candidate,
      evidenceIds: [...event.evidenceIds],
      threadId: event.threadId,
      at: finiteRecordTime(event.recordedAt, event.ts),
    } satisfies TypedAnswerRecord;
    if (!answers.has(answer.answerId)) answers.set(answer.answerId, answer);
  }
  return [...answers.values()].sort((left, right) => left.at - right.at);
}

/** Conflicting answer definitions keyed by the immutable caller-selected answer id. */
export function foldTypedAnswerConflicts(events: readonly HarnessEvent[]): Map<string, TypedAnswerRecord[]> {
  const first = new Map<string, TypedAnswerRecord>();
  const conflicts = new Map<string, TypedAnswerRecord[]>();
  for (const event of events) {
    if (event.kind !== 'answer.recorded') continue;
    const answer = {
      answerId: event.answerId,
      expectationItemId: event.expectationItemId,
      expectationSetId: event.expectationSetId,
      actor: event.actor,
      authority: event.authority,
      answer: event.answer,
      candidate: event.candidate,
      evidenceIds: [...event.evidenceIds],
      threadId: event.threadId,
      at: finiteRecordTime(event.recordedAt, event.ts),
    } satisfies TypedAnswerRecord;
    const prior = first.get(answer.answerId);
    if (prior === undefined) {
      first.set(answer.answerId, answer);
    } else if (!sameAnswerDefinition(prior, answer)) {
      const entries = conflicts.get(answer.answerId) ?? [];
      entries.push(answer);
      conflicts.set(answer.answerId, entries);
    }
  }
  return conflicts;
}

/** Alias that keeps the read name short for evaluator callers. */
export const foldAnswers = foldTypedAnswers;

/** Every human attestation, oldest first, with corrections folded by attestation identity. */
export function foldHumanAttestations(events: readonly HarnessEvent[]): HumanAttestationRecord[] {
  const attestations = new Map<string, HumanAttestationRecord>();
  for (const event of events) {
    if (event.kind !== 'attestation.recorded' && event.kind !== 'human.attestation.recorded') continue;
    const attestation = {
      attestationId: event.attestationId,
      expectationItemId: event.expectationItemId,
      expectationSetId: event.expectationSetId,
      actor: event.actor,
      authority: event.authority,
      statement: event.statement,
      candidate: event.candidate,
      evidenceIds: [...event.evidenceIds],
      threadId: event.threadId,
      at: finiteRecordTime(event.recordedAt, event.ts),
    } satisfies HumanAttestationRecord;
    if (!attestations.has(attestation.attestationId)) attestations.set(attestation.attestationId, attestation);
  }
  return [...attestations.values()].sort((left, right) => left.at - right.at);
}

/** Conflicting attestation definitions keyed by the immutable caller-selected id. */
export function foldHumanAttestationConflicts(events: readonly HarnessEvent[]): Map<string, HumanAttestationRecord[]> {
  const first = new Map<string, HumanAttestationRecord>();
  const conflicts = new Map<string, HumanAttestationRecord[]>();
  for (const event of events) {
    if (event.kind !== 'attestation.recorded' && event.kind !== 'human.attestation.recorded') continue;
    const attestation = {
      attestationId: event.attestationId,
      expectationItemId: event.expectationItemId,
      expectationSetId: event.expectationSetId,
      actor: event.actor,
      authority: event.authority,
      statement: event.statement,
      candidate: event.candidate,
      evidenceIds: [...event.evidenceIds],
      threadId: event.threadId,
      at: finiteRecordTime(event.recordedAt, event.ts),
    } satisfies HumanAttestationRecord;
    const prior = first.get(attestation.attestationId);
    if (prior === undefined) {
      first.set(attestation.attestationId, attestation);
    } else if (!sameAttestationDefinition(prior, attestation)) {
      const entries = conflicts.get(attestation.attestationId) ?? [];
      entries.push(attestation);
      conflicts.set(attestation.attestationId, entries);
    }
  }
  return conflicts;
}

/** Alias that keeps the read name short for evaluator callers. */
export const foldAttestations = foldHumanAttestations;

function finiteRecordTime(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function sameAnswerDefinition(left: TypedAnswerRecord, right: TypedAnswerRecord): boolean {
  return sameRecord({
    expectationItemId: left.expectationItemId,
    expectationSetId: left.expectationSetId,
    actor: left.actor,
    authority: left.authority,
    answer: left.answer,
    candidate: left.candidate,
    evidenceIds: left.evidenceIds,
    threadId: left.threadId,
  }, {
    expectationItemId: right.expectationItemId,
    expectationSetId: right.expectationSetId,
    actor: right.actor,
    authority: right.authority,
    answer: right.answer,
    candidate: right.candidate,
    evidenceIds: right.evidenceIds,
    threadId: right.threadId,
  });
}

function sameAttestationDefinition(left: HumanAttestationRecord, right: HumanAttestationRecord): boolean {
  return sameRecord({
    expectationItemId: left.expectationItemId,
    expectationSetId: left.expectationSetId,
    actor: left.actor,
    authority: left.authority,
    statement: left.statement,
    candidate: left.candidate,
    evidenceIds: left.evidenceIds,
    threadId: left.threadId,
  }, {
    expectationItemId: right.expectationItemId,
    expectationSetId: right.expectationSetId,
    actor: right.actor,
    authority: right.authority,
    statement: right.statement,
    candidate: right.candidate,
    evidenceIds: right.evidenceIds,
    threadId: right.threadId,
  });
}

/** Every retained item, oldest first, each at its latest version. */
export function foldRetained(events: readonly HarnessEvent[]): RetainedItem[] {
  const items = new Map<string, RetainedItem>();
  for (const event of events) {
    if (event.kind !== 'context.retained') continue;
    items.set(event.retainedId, {
      id: event.retainedId,
      workItemId: event.workItemId,
      kind: event.retainedKind,
      text: event.text,
      runId: event.runId,
      threadId: event.threadId,
      source: sourceOf(event),
      at: event.ts,
      selected: event.selected,
      retired: event.retired,
    });
  }
  return [...items.values()];
}

/**
 * What a later run should be given: selected, still standing, most recent last.
 *
 * Retired items are kept in the ledger and left out of the prompt. Something that turned
 * out to be wrong is worth being able to read; it is not worth telling the next agent.
 */
export function selectedForContext(items: readonly RetainedItem[]): RetainedItem[] {
  return items.filter((item) => item.selected && !item.retired).sort((a, b) => a.at - b.at);
}

/**
 * Immutable expectation sets recorded in this event stream, keyed by stable identity.
 *
 * A supersession event only links two identities; it never replaces the old set. That is
 * what lets a replay explain which target an earlier transition actually used.
 */
export function foldExpectationSets(events: readonly HarnessEvent[]): Map<string, ExpectationSet> {
  const sets = new Map<string, ExpectationSet>();
  for (const event of events) {
    if (event.kind !== 'expectation.set.created') continue;
    // A set identity is immutable. Keep the first definition so a replayed or corrupted
    // duplicate cannot replace the source against which earlier transitions were judged.
    if (!sets.has(event.expectationSet.expectationSetId)) {
      sets.set(event.expectationSet.expectationSetId, event.expectationSet);
    }
  }
  return sets;
}

/** Conflicting redefinitions are visible to callers while the first set remains authoritative. */
export function foldExpectationSetConflicts(events: readonly HarnessEvent[]): Map<string, ExpectationSet[]> {
  const first = new Map<string, ExpectationSet>();
  const conflicts = new Map<string, ExpectationSet[]>();
  for (const event of events) {
    if (event.kind !== 'expectation.set.created') continue;
    const prior = first.get(event.expectationSet.expectationSetId);
    if (prior === undefined) {
      first.set(event.expectationSet.expectationSetId, event.expectationSet);
      continue;
    }
    if (sameRecord(prior, event.expectationSet)) continue;
    const entries = conflicts.get(event.expectationSet.expectationSetId) ?? [];
    entries.push(event.expectationSet);
    conflicts.set(event.expectationSet.expectationSetId, entries);
  }
  return conflicts;
}

/** Every accepted expectation set in first-definition order, including superseded sets. */
export function foldExpectationSetHistory(events: readonly HarnessEvent[]): ExpectationSet[] {
  return [...foldExpectationSets(events).values()];
}

/** Old expectation-set identity to its authorized replacement, without mutating either set. */
export function foldExpectationSetSupersessions(events: readonly HarnessEvent[]): Map<string, string> {
  const supersessions = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== 'expectation.set.superseded') continue;
    supersessions.set(event.expectationSetId, event.supersededByExpectationSetId);
  }
  return supersessions;
}

/**
 * Latest evaluation for each transition identity. Attempt numbers, rather than mutable
 * process state, decide which record is current after a restart.
 */
export function foldTransitionEvaluations(events: readonly HarnessEvent[]): Map<string, TransitionEvaluation> {
  return foldTransitionRecords(events).latest;
}

/** Accepted transition history; duplicate, out-of-order, and invalid attempts are excluded. */
export function foldTransitionEvaluationHistory(events: readonly HarnessEvent[]): Map<string, TransitionEvaluation[]> {
  return foldTransitionRecords(events).history;
}

/** Rejected replay records, retained separately so callers can fail closed without rewriting history. */
export function foldTransitionEvaluationConflicts(
  events: readonly HarnessEvent[],
): Map<string, TransitionEvaluation[]> {
  return foldTransitionRecords(events).conflicts;
}

interface TransitionFold {
  latest: Map<string, TransitionEvaluation>;
  history: Map<string, TransitionEvaluation[]>;
  conflicts: Map<string, TransitionEvaluation[]>;
}

function foldTransitionRecords(events: readonly HarnessEvent[]): TransitionFold {
  const latest = new Map<string, TransitionEvaluation>();
  const history = new Map<string, TransitionEvaluation[]>();
  const conflicts = new Map<string, TransitionEvaluation[]>();
  const expectationSets = foldExpectationSets(events);
  const expectationSetConflicts = foldExpectationSetConflicts(events);
  for (const evaluation of transitionEvaluations(events)) {
    const pinnedExpectationSet = expectationSets.get(evaluation.expectationSetId);
    const invalidReason = expectationSetConflicts.has(evaluation.expectationSetId)
      ? 'The evaluation references a conflicting immutable expectation set.'
      : pinnedExpectationSet === undefined && evaluation.verdict === 'passed' && evaluation.enforcement.length > 0
        ? 'A passed evaluation with enforced expectations needs its pinned expectation set.'
        : validateTransitionEvaluation(evaluation, pinnedExpectationSet);
    if (invalidReason !== null) {
      const entries = conflicts.get(evaluation.transitionId) ?? [];
      entries.push(evaluation);
      conflicts.set(evaluation.transitionId, entries);
      continue;
    }
    const previous = latest.get(evaluation.transitionId);
    if (previous === undefined && evaluation.attempt === 1) {
      latest.set(evaluation.transitionId, evaluation);
      history.set(evaluation.transitionId, [evaluation]);
      continue;
    }
    if (previous !== undefined && evaluation.attempt > previous.attempt) {
      latest.set(evaluation.transitionId, evaluation);
      const entries = history.get(evaluation.transitionId) ?? [];
      entries.push(evaluation);
      history.set(evaluation.transitionId, entries);
      continue;
    }

    const entries = conflicts.get(evaluation.transitionId) ?? [];
    entries.push(evaluation);
    conflicts.set(evaluation.transitionId, entries);
  }
  return { latest, history, conflicts };
}

function transitionEvaluations(events: readonly HarnessEvent[]): TransitionEvaluation[] {
  const evaluations: TransitionEvaluation[] = [];
  for (const event of events) {
    if (event.kind === 'transition.evaluated') {
      evaluations.push(event.evaluation);
    } else if (event.kind === 'gate.evaluated' && event.evaluation !== undefined) {
      evaluations.push(event.evaluation);
    }
  }
  return evaluations;
}
