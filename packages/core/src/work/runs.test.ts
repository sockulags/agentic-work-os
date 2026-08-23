import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { HarnessEvent } from '@awos/protocol';
import { projectRunEvidence } from './runs.js';

let seq = 0;

function event(body: Record<string, unknown> & { kind: string }): HarnessEvent {
  seq += 1;
  return {
    id: `event-${seq}`,
    seq,
    threadId: 'thread-1',
    agent: 'claude',
    turnId: null,
    ts: 1_000 + seq,
    ...body,
  } as unknown as HarnessEvent;
}

function started(runId: string, workItemId = 'work-1'): HarnessEvent {
  return event({
    kind: 'run.started',
    runId,
    workItemId,
    source: 'owner/repo#14',
    revision: 'revision-1',
    context: 'context',
    instruction: 'work',
  });
}

describe('projectRunEvidence', () => {
  test('marks an unfinished start as interrupted by restart without changing the log', () => {
    const events = [started('crashed')];

    const [run] = projectRunEvidence(events);

    assert.equal(run?.state, 'interrupted');
    assert.equal(run?.live, false);
    assert.equal(run?.interruptedByRestart, true);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'run.started');
  });

  test('requires the exact live run rather than any busy runtime', () => {
    const projected = projectRunEvidence(
      [started('live'), started('stale')],
      (runId) => runId === 'live',
    );

    assert.deepEqual(
      projected.map((run) => [run.runId, run.state, run.live, run.interruptedByRestart]),
      [
        ['live', 'running', true, false],
        ['stale', 'interrupted', false, true],
      ],
    );
  });

  test('preserves ordinary completed, interrupted, and error states', () => {
    for (const state of ['completed', 'interrupted', 'error'] as const) {
      const [run] = projectRunEvidence([
        started(state),
        event({ kind: 'run.completed', runId: state, state, detail: null }),
      ]);

      assert.equal(run?.state, state);
      assert.equal(run?.live, false);
      assert.equal(run?.interruptedByRestart, false);
    }
  });

  test('keeps evidence counts scoped to the selected work item', () => {
    const projected = projectRunEvidence(
      [
        started('selected'),
        started('other', 'work-2'),
        event({
          kind: 'evidence.recorded',
          evidenceId: 'evidence-1',
          runId: 'selected',
          workItemId: 'work-1',
          evidenceKind: 'note',
          ref: { eventId: null, url: null, label: 'note' },
          summary: 'kept',
          state: { commit: null, tree: null, dirty: false },
          check: null,
        }),
      ],
      () => false,
      'work-1',
    );

    assert.equal(projected.length, 1);
    assert.equal(projected[0]?.runId, 'selected');
    assert.equal(projected[0]?.evidenceCount, 1);
  });
});
