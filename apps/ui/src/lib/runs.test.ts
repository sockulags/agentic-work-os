import { describe, expect, test } from 'vitest';
import type { HarnessEvent } from '@awos/protocol';
import { foldRuns } from './runs';

let seq = 0;

/**
 * An event with the envelope filled in.
 *
 * Loosely typed on purpose: these fixtures name one body at a time, and a union of every
 * body would make each call site declare fields the fold does not read.
 */
function event(body: Record<string, unknown> & { kind: string }): HarnessEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    seq,
    threadId: 't1',
    agent: 'claude',
    turnId: null,
    ts: 1_000 + seq,
    ...body,
  } as unknown as HarnessEvent;
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

describe('foldRuns · outcomes and evidence', () => {
  test('attaches the claim to the run it is about', () => {
    const runs = foldRuns([
      started('r1'),
      event({ kind: 'run.completed', runId: 'r1', state: 'completed', detail: null }),
      // agent null is the person at the keyboard, which is who closed this one.
      event({ kind: 'run.closed', runId: 'r1', claim: 'partial', statement: 'half of it', agent: null }),
    ]);

    // The process ended cleanly and the work is half done; both are kept.
    expect(runs[0]?.state).toBe('completed');
    expect(runs[0]?.outcome?.claim).toBe('partial');
    expect(runs[0]?.outcome?.source).toBe('user');
  });

  test('a later claim replaces an earlier one', () => {
    const runs = foldRuns([
      started('r1'),
      event({ kind: 'run.closed', runId: 'r1', claim: 'delivered', statement: 'done' }),
      event({ kind: 'run.closed', runId: 'r1', claim: 'blocked', statement: 'actually not' }),
    ]);

    expect(runs[0]?.outcome?.statement).toBe('actually not');
  });

  test('groups evidence under the run that offered it', () => {
    const runs = foldRuns([
      started('r1'),
      event({ kind: 'run.completed', runId: 'r1', state: 'completed', detail: null }),
      started('r2'),
      event({
        kind: 'evidence.recorded',
        evidenceId: 'ev1',
        runId: 'r1',
        workItemId: 'w1',
        evidenceKind: 'command',
        ref: { eventId: 'e-cmd', url: null, label: 'npm test' },
        summary: 'green',
        state: { commit: null, tree: null, dirty: false },
      }),
    ]);

    const byId = new Map(runs.map((run) => [run.runId, run]));
    expect(byId.get('r1')?.evidence.map((item) => item.summary)).toEqual(['green']);
    expect(byId.get('r2')?.evidence).toEqual([]);
  });

  test('a corrected evidence item does not become a second one', () => {
    const record = (summary: string) =>
      event({
        kind: 'evidence.recorded',
        evidenceId: 'ev1',
        runId: 'r1',
        workItemId: 'w1',
        evidenceKind: 'note',
        ref: { eventId: null, url: null, label: 'by hand' },
        summary,
        state: { commit: null, tree: null, dirty: false },
      });

    const runs = foldRuns([started('r1'), record('green'), record('three were skipped')]);

    expect(runs[0]?.evidence).toHaveLength(1);
    expect(runs[0]?.evidence[0]?.summary).toBe('three were skipped');
  });
});

describe('foldRuns · what a run can point at', () => {
  test('offers the commands the run ran, with how they ended', () => {
    const runs = foldRuns([
      started('r1'),
      event({ kind: 'tool.started', itemId: 'i1', name: 'Bash', toolKind: 'command', title: 'npm test', input: {} }),
      event({ kind: 'tool.completed', itemId: 'i1', status: 'ok', output: '', exitCode: 0 }),
    ]);

    expect(runs[0]?.candidates).toEqual([
      { eventId: expect.any(String), kind: 'command', label: 'npm test', detail: 'ok (exit 0)' },
    ]);
  });

  test('offers the diff, the artifacts and the approvals too', () => {
    const runs = foldRuns([
      started('r1'),
      event({ kind: 'diff.updated', patch: 'diff --git a/x b/x\n@@\n' }),
      event({
        kind: 'artifact.updated',
        artifactId: 'plan.md',
        title: 'The plan',
        artifactKind: 'markdown',
        content: '# Plan',
        path: '/repo/.awos/artifacts/plan.md',
      }),
      event({
        kind: 'approval.requested',
        approvalId: 'a1',
        title: 'Run a shell command',
        detail: null,
        options: [],
        toolName: 'Bash',
        input: {},
      }),
      event({ kind: 'approval.resolved', approvalId: 'a1', optionId: 'allow', behavior: 'allow', auto: false }),
    ]);

    expect(runs[0]?.candidates.map((c) => [c.kind, c.label])).toEqual([
      ['diff', 'the diff this run produced'],
      ['artifact', 'The plan'],
      ['approval', 'Run a shell command'],
    ]);
  });

  test('a deleted artifact is nothing to point at', () => {
    const runs = foldRuns([
      started('r1'),
      event({
        kind: 'artifact.updated',
        artifactId: 'plan.md',
        title: 'The plan',
        artifactKind: 'markdown',
        content: '',
        path: '/repo/.awos/artifacts/plan.md',
      }),
    ]);

    expect(runs[0]?.candidates).toEqual([]);
  });

  test('facts from outside a run belong to no run', () => {
    const runs = foldRuns([
      started('r1'),
      event({ kind: 'run.completed', runId: 'r1', state: 'completed', detail: null }),
      event({ kind: 'tool.started', itemId: 'i1', name: 'Bash', toolKind: 'command', title: 'a later chat', input: {} }),
      event({ kind: 'tool.completed', itemId: 'i1', status: 'ok', output: '', exitCode: 0 }),
    ]);

    expect(runs[0]?.candidates).toEqual([]);
  });
});
