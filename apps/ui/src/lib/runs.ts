import type {
  AgentId,
  ClaimSource,
  EvidenceItem,
  EvidenceKind,
  HarnessEvent,
  RunOutcome,
  RunState,
} from '@awos/protocol';

/**
 * Folds the log into the runs a thread has made, with what each one claimed, what
 * supports it, and what it could point at.
 *
 * One pass, one shape. The core never sends a list of runs, for the same reason it never
 * sends a list of artifacts: the log is the record and everything else is derived from
 * it. Deriving here makes a run survive a reload and a restart without anything storing
 * it twice — replaying `events.jsonl` produces exactly what the live socket did.
 *
 * The correction rule matches the core's: a later record with an id already seen replaces
 * the earlier one, and every version stays in the log behind it.
 */

/** Something in the log a run could offer as evidence. */
export interface EvidenceCandidate {
  eventId: string;
  kind: EvidenceKind;
  /** What it was: a command line, a file count, an artifact title. */
  label: string;
  /** How it went, when that is a separate fact from what it was. */
  detail: string;
}

export interface RunView {
  runId: string;
  /** The agent that took it, from the event envelope. */
  agent: AgentId | null;
  instruction: string;
  /** The payload as sent, which is the whole point of recording a run. */
  context: string;
  /** The source revision this run read, frozen when it started. */
  revision: string;
  state: RunState | 'running';
  detail: string | null;
  ts: number;
  /** What the run claims to have achieved, once somebody has said. */
  outcome: RunOutcome | null;
  evidence: EvidenceItem[];
  /** Facts from this run's own turn, for attaching without retyping them. */
  candidates: EvidenceCandidate[];
}

export function foldRuns(events: readonly HarnessEvent[]): RunView[] {
  const runs = new Map<string, RunView>();
  const evidence = new Map<string, EvidenceItem>();
  /** Titles arrive on `tool.started`; the result arrives later on `tool.completed`. */
  const toolTitles = new Map<string, string>();
  const approvalTitles = new Map<string, string>();
  /** The run a fact belongs to: the one that was open when it happened. */
  let openRun: string | null = null;

  const candidate = (runId: string | null, item: EvidenceCandidate): void => {
    if (runId === null) return;
    runs.get(runId)?.candidates.push(item);
  };

  for (const event of events) {
    switch (event.kind) {
      case 'run.started':
        runs.set(event.runId, {
          runId: event.runId,
          agent: event.agent,
          instruction: event.instruction,
          context: event.context,
          revision: event.revision,
          // A run with no completion is still in flight — or was, when the core stopped.
          // Both read the same way, and neither is a reason to hide what was recorded.
          state: 'running',
          detail: null,
          ts: event.ts,
          outcome: null,
          evidence: [],
          candidates: [],
        });
        openRun = event.runId;
        break;

      case 'run.completed': {
        const run = runs.get(event.runId);
        if (run) runs.set(event.runId, { ...run, state: event.state, detail: event.detail });
        if (openRun === event.runId) openRun = null;
        break;
      }

      case 'run.closed': {
        const run = runs.get(event.runId);
        if (!run) break;
        runs.set(event.runId, {
          ...run,
          outcome: {
            runId: event.runId,
            claim: event.claim,
            statement: event.statement,
            source: sourceOf(event),
            at: event.ts,
          },
        });
        break;
      }

      case 'evidence.recorded':
        evidence.set(event.evidenceId, {
          id: event.evidenceId,
          runId: event.runId,
          workItemId: event.workItemId,
          threadId: event.threadId,
          kind: event.evidenceKind,
          ref: event.ref,
          summary: event.summary,
          state: event.state,
          source: sourceOf(event),
          at: event.ts,
        });
        break;

      case 'tool.started':
        toolTitles.set(event.itemId, event.title);
        break;

      case 'tool.completed':
        candidate(openRun, {
          eventId: event.id,
          kind: 'command',
          label: toolTitles.get(event.itemId) ?? 'a tool call',
          detail: event.exitCode === null ? event.status : `${event.status} (exit ${event.exitCode})`,
        });
        break;

      case 'diff.updated':
        candidate(openRun, {
          eventId: event.id,
          kind: 'diff',
          label: 'the diff this run produced',
          detail: `${countChangedFiles(event.patch)} file(s)`,
        });
        break;

      case 'artifact.updated':
        // An empty body is the tombstone the core writes when the file is gone; there is
        // nothing left to point at.
        if (event.content !== '') {
          candidate(openRun, {
            eventId: event.id,
            kind: 'artifact',
            label: event.title,
            detail: event.artifactKind,
          });
        }
        break;

      case 'approval.requested':
        approvalTitles.set(event.approvalId, event.title);
        break;

      case 'approval.resolved':
        candidate(openRun, {
          eventId: event.id,
          kind: 'approval',
          label: approvalTitles.get(event.approvalId) ?? 'an approval',
          detail: event.auto ? `${event.behavior} (timed out)` : event.behavior,
        });
        break;

      default:
        break;
    }
  }

  for (const item of evidence.values()) {
    runs.get(item.runId)?.evidence.push(item);
  }

  // Newest first: the run you are looking for is almost always the last one.
  return [...runs.values()].reverse();
}

/** `agent: null` on a harness-level event means the person at the keyboard. */
function sourceOf(event: HarnessEvent): ClaimSource {
  return event.agent ?? 'user';
}

function countChangedFiles(patch: string): number {
  return patch.split('\n').filter((line) => line.startsWith('diff --git ')).length;
}
