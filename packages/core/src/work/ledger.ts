import type {
  ClaimSource,
  EvidenceItem,
  HarnessEvent,
  RetainedItem,
  RunOutcome,
} from '@awos/protocol';

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
