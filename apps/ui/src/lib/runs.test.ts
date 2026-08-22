import { describe, expect, test } from 'vitest';
import type { HarnessEvent } from '@awos/protocol';
import { foldRuns } from './runs';

let seq = 0;

function event(body: Partial<HarnessEvent> & { kind: string }): HarnessEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    seq,
    threadId: 't1',
    agent: 'claude',
    turnId: null,
    ts: 1_000 + seq,
    ...body,
  } as HarnessEvent;
}

function started(runId: string, overrides: Record<string, unknown> = {}): HarnessEvent {
  return event({
    kind: 'run.started',
    runId,
    workItemId: 'w1',
    source: 'sockulags/agentic-work-os#14',
    revision: '2026-08-22T19:26:05Z',
    context: '<work-item>…</work-item>\n\nstart on this',
    instruction: 'start on this',
    ...overrides,
  });
}

describe('foldRuns', () => {
  test('a log with no runs has none', () => {
    expect(foldRuns([event({ kind: 'user.message', text: 'hi', hadReplay: false })])).toEqual([]);
  });

  test('keeps what the run was given, which is the reason it is recorded', () => {
    const runs = foldRuns([started('r1')]);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.instruction).toBe('start on this');
    expect(runs[0]?.context).toContain('<work-item>');
    expect(runs[0]?.revision).toBe('2026-08-22T19:26:05Z');
    expect(runs[0]?.agent).toBe('claude');
  });

  test('a run with no completion is still in flight rather than missing', () => {
    expect(foldRuns([started('r1')])[0]?.state).toBe('running');
  });

  test('pairs a completion with the run it belongs to', () => {
    const runs = foldRuns([
      started('r1'),
      started('r2'),
      event({ kind: 'run.completed', runId: 'r1', state: 'error', detail: 'the CLI died' }),
    ]);

    const byId = new Map(runs.map((run) => [run.runId, run]));
    expect(byId.get('r1')?.state).toBe('error');
    expect(byId.get('r1')?.detail).toBe('the CLI died');
    expect(byId.get('r2')?.state).toBe('running');
  });

  test('ignores a completion for a run this thread never started', () => {
    const runs = foldRuns([
      event({ kind: 'run.completed', runId: 'from-another-thread', state: 'completed', detail: null }),
    ]);

    expect(runs).toEqual([]);
  });

  test('newest first, because that is the one being looked for', () => {
    const runs = foldRuns([started('r1'), started('r2')]);

    expect(runs.map((run) => run.runId)).toEqual(['r2', 'r1']);
  });
});
