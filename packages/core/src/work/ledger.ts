import type {
  ClaimSource,
  EvidenceItem,
  ExpectationSet,
  HarnessEvent,
  RetainedItem,
  RunOutcome,
  TransitionEvaluation,
} from '@awos/protocol';
import { validateTransitionEvaluation } from '@awos/protocol';

/**
 * Reading outcomes, evidence and retained context back out of the log.
 *
 * Three folds over the same append-only record, all with the same rule: a later record
 * with an id already seen replaces the earlier one. That is the whole correction
 * mechanism. Nothing is rewritten, nothing is deleted, and the log still holds every
 * version in the order it was claimed — which is what makes "who said what, and when did
 * they change their mind" answerable at all.
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
      source: sourceOf(event),
      at: event.ts,
    });
  }
  return [...items.values()];
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
  for (const evaluation of transitionEvaluations(events)) {
    const invalidReason = validateTransitionEvaluation(evaluation);
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
