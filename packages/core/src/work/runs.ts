import type { CatalogRunEvidence, HarnessEvent } from '@awos/protocol';

/**
 * Project persisted run evidence with the live runtime overlay.
 *
 * A start without a terminal event is only live when the caller can identify the exact
 * run in memory. Otherwise the process that owned it is gone, so the honest derived state
 * is interrupted by restart. No event is appended: the ledger remains the record of what
 * was persisted, while this projection describes what that record means now.
 */
export function projectRunEvidence(
  events: readonly HarnessEvent[],
  isRunLive: (runId: string) => boolean = () => false,
  workItemId?: string,
): CatalogRunEvidence[] {
  const runs = new Map<string, CatalogRunEvidence>();

  for (const event of events) {
    if (event.kind === 'run.started') {
      if (workItemId !== undefined && event.workItemId !== workItemId) continue;
      const live = isRunLive(event.runId);
      runs.set(event.runId, {
        runId: event.runId,
        threadId: event.threadId,
        agent: event.agent,
        startedAt: event.ts,
        state: live ? 'running' : 'interrupted',
        live,
        interruptedByRestart: !live,
        evidenceCount: 0,
      });
      continue;
    }

    if (event.kind === 'run.completed') {
      const run = runs.get(event.runId);
      if (!run) continue;
      run.state = event.state;
      run.live = false;
      run.interruptedByRestart = false;
      continue;
    }

    if (event.kind === 'evidence.recorded' && event.runId !== null) {
      const run = runs.get(event.runId);
      if (run) run.evidenceCount += 1;
    }
  }

  return [...runs.values()];
}
