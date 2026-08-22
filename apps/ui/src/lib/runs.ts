import type { AgentId, HarnessEvent, RunState } from '@awos/protocol';

/**
 * Folds `run.started` and `run.completed` into the runs a thread has made.
 *
 * The core never sends a list of runs, for the same reason it never sends a list of
 * artifacts: the log is the record, and everything else is derived from it. Doing that
 * derivation here as a pure fold is what makes a run survive a reload and a restart
 * without anything storing it twice — replaying `events.jsonl` produces exactly what the
 * live socket did.
 */

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
}

export function foldRuns(events: readonly HarnessEvent[]): RunView[] {
  const runs = new Map<string, RunView>();

  for (const event of events) {
    if (event.kind === 'run.started') {
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
      });
    } else if (event.kind === 'run.completed') {
      const run = runs.get(event.runId);
      if (run) runs.set(event.runId, { ...run, state: event.state, detail: event.detail });
    }
  }

  // Newest first: the run you are looking for is almost always the last one.
  return [...runs.values()].reverse();
}
