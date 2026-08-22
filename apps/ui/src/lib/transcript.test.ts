import { describe, test, expect } from 'vitest';
import type { AgentId, HarnessEvent, HarnessEventBody } from '@awos/protocol';
import { foldTranscript, TranscriptFolder, type TranscriptItem } from './transcript';

/**
 * The event log is fine-grained and append-only; the UI wants a handful of stable
 * blocks. This fold is where that translation happens, and a regression in it is close
 * to invisible by eye — text quietly duplicates, or a tool row never closes. Hence tests.
 */

let seq = 0;

function ev(agent: AgentId | null, turnId: string | null, body: HarnessEventBody): HarnessEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    seq,
    threadId: 't1',
    agent,
    turnId,
    ts: 1_700_000_000_000 + seq,
    ...body,
  } as HarnessEvent;
}

function kinds(items: TranscriptItem[]): string[] {
  return items.map((item) => item.kind);
}

describe('foldTranscript — streaming text', () => {
  test('deltas produce a single streaming message', () => {
    const { items } = foldTranscript([
      ev('claude', 't', { kind: 'turn.started', nativeSessionId: null }),
      ev('claude', 't', { kind: 'message.delta', itemId: 'm1', text: 'Hel' }),
      ev('claude', 't', { kind: 'message.delta', itemId: 'm1', text: 'lo' }),
    ]);

    const messages = items.filter((i) => i.kind === 'message');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ text: 'Hello', streaming: true });
  });

  test('the completed message replaces accumulated deltas rather than appending', () => {
    const { items } = foldTranscript([
      ev('claude', 't', { kind: 'message.delta', itemId: 'm1', text: 'Hel' }),
      ev('claude', 't', { kind: 'message.delta', itemId: 'm1', text: 'lo' }),
      ev('claude', 't', { kind: 'message.completed', itemId: 'm1', text: 'Hello' }),
    ]);

    const messages = items.filter((i) => i.kind === 'message');
    expect(messages).toHaveLength(1);
    // Appending here would render "HelloHello" — the classic streaming bug.
    expect(messages[0]).toMatchObject({ text: 'Hello', streaming: false });
  });

  test('a dropped delta self-corrects at completion', () => {
    const { items } = foldTranscript([
      ev('claude', 't', { kind: 'message.delta', itemId: 'm1', text: 'Hel' }),
      // 'lo' never arrived.
      ev('claude', 't', { kind: 'message.completed', itemId: 'm1', text: 'Hello world' }),
    ]);
    expect(items.find((i) => i.kind === 'message')).toMatchObject({ text: 'Hello world' });
  });

  test('a completed message with no preceding deltas still renders', () => {
    const { items } = foldTranscript([
      ev('codex', 't', { kind: 'message.completed', itemId: 'm1', text: 'Done.' }),
    ]);
    expect(items.find((i) => i.kind === 'message')).toMatchObject({
      text: 'Done.',
      streaming: false,
    });
  });

  test('two separate messages stay separate blocks', () => {
    const { items } = foldTranscript([
      ev('claude', 't', { kind: 'message.completed', itemId: 'm1', text: 'first' }),
      ev('claude', 't', { kind: 'message.completed', itemId: 'm2', text: 'second' }),
    ]);
    expect(items.filter((i) => i.kind === 'message')).toHaveLength(2);
  });
});

describe('foldTranscript — tools', () => {
  test('a tool row opens running and closes with its status', () => {
    const { items } = foldTranscript([
      ev('claude', 't', {
        kind: 'tool.started',
        itemId: 'tool1',
        name: 'Bash',
        toolKind: 'command',
        title: 'npm test',
        input: { command: 'npm test' },
      }),
      ev('claude', 't', {
        kind: 'tool.completed',
        itemId: 'tool1',
        status: 'ok',
        output: 'passed',
        exitCode: 0,
      }),
    ]);

    const tools = items.filter((i) => i.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ title: 'npm test', status: 'ok', output: 'passed' });
  });

  test('streamed output accumulates in order', () => {
    const { items } = foldTranscript([
      ev('codex', 't', {
        kind: 'tool.started',
        itemId: 'tool1',
        name: 'exec',
        toolKind: 'command',
        title: 'build',
        input: {},
      }),
      ev('codex', 't', { kind: 'tool.output', itemId: 'tool1', stream: 'stdout', chunk: 'a\n' }),
      ev('codex', 't', { kind: 'tool.output', itemId: 'tool1', stream: 'stderr', chunk: 'b\n' }),
    ]);
    expect(items.find((i) => i.kind === 'tool')).toMatchObject({ output: 'a\nb\n' });
  });

  test('a final payload does not duplicate already-streamed output', () => {
    const { items } = foldTranscript([
      ev('codex', 't', {
        kind: 'tool.started',
        itemId: 'tool1',
        name: 'exec',
        toolKind: 'command',
        title: 'build',
        input: {},
      }),
      ev('codex', 't', { kind: 'tool.output', itemId: 'tool1', stream: 'stdout', chunk: 'hi\n' }),
      ev('codex', 't', {
        kind: 'tool.completed',
        itemId: 'tool1',
        status: 'ok',
        output: 'hi\n',
        exitCode: 0,
      }),
    ]);
    // Codex sends both the deltas and an aggregate; taking both would double the output.
    expect(items.find((i) => i.kind === 'tool')).toMatchObject({ output: 'hi\n' });
  });

  test('a completion with no matching start still produces a row', () => {
    const { items } = foldTranscript([
      ev('claude', 't', {
        kind: 'tool.completed',
        itemId: 'orphan',
        status: 'error',
        output: 'boom',
        exitCode: 1,
      }),
    ]);
    expect(items.find((i) => i.kind === 'tool')).toMatchObject({ status: 'error', exitCode: 1 });
  });

  test('an unfinished tool stays running', () => {
    const { items } = foldTranscript([
      ev('claude', 't', {
        kind: 'tool.started',
        itemId: 'tool1',
        name: 'Bash',
        toolKind: 'command',
        title: 'sleep 100',
        input: {},
      }),
    ]);
    expect(items.find((i) => i.kind === 'tool')).toMatchObject({ status: 'running' });
  });
});

describe('foldTranscript — turn structure', () => {
  test('a divider appears when the agent changes', () => {
    const { items } = foldTranscript([
      ev(null, null, { kind: 'user.message', text: 'hi', hadReplay: false }),
      ev('claude', 't1', { kind: 'turn.started', nativeSessionId: null }),
      ev('claude', 't1', { kind: 'message.completed', itemId: 'm1', text: 'a' }),
      ev(null, null, { kind: 'user.message', text: 'now codex', hadReplay: false }),
      ev('codex', 't2', { kind: 'turn.started', nativeSessionId: null }),
      ev('codex', 't2', { kind: 'message.completed', itemId: 'm2', text: 'b' }),
    ]);

    expect(kinds(items)).toEqual([
      'user',
      'divider',
      'message',
      'user',
      'divider',
      'message',
    ]);
  });

  test('consecutive turns from the same agent get one divider per user message', () => {
    const { items } = foldTranscript([
      ev(null, null, { kind: 'user.message', text: 'one', hadReplay: false }),
      ev('claude', 't1', { kind: 'turn.started', nativeSessionId: null }),
      ev('claude', 't1', { kind: 'turn.started', nativeSessionId: null }),
      ev('claude', 't1', { kind: 'message.completed', itemId: 'm', text: 'a' }),
    ]);
    // A repeated turn.started for the same agent must not stack dividers.
    expect(items.filter((i) => i.kind === 'divider')).toHaveLength(1);
  });

  test('an errored turn produces a notice', () => {
    const { items } = foldTranscript([
      ev('claude', 't', {
        kind: 'turn.completed',
        reason: 'error',
        error: 'context limit',
        durationMs: 10,
      }),
    ]);
    expect(items.find((i) => i.kind === 'notice')).toMatchObject({
      level: 'error',
      text: 'context limit',
    });
  });

  test('an interruption is noted without being an error', () => {
    const { items } = foldTranscript([
      ev('claude', 't', {
        kind: 'turn.completed',
        reason: 'interrupted',
        error: null,
        durationMs: 10,
      }),
    ]);
    expect(items.find((i) => i.kind === 'notice')).toMatchObject({ level: 'info' });
  });

  test('a clean turn adds no notice', () => {
    const { items } = foldTranscript([
      ev('claude', 't', {
        kind: 'turn.completed',
        reason: 'completed',
        error: null,
        durationMs: 10,
      }),
    ]);
    expect(items.filter((i) => i.kind === 'notice')).toHaveLength(0);
  });
});

describe('foldTranscript — panels and totals', () => {
  test('usage accumulates across turns', () => {
    const { totals } = foldTranscript([
      ev('claude', 't1', {
        kind: 'usage',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheWriteTokens: null,
        costUsd: 0.001,
      }),
      ev('codex', 't2', {
        kind: 'usage',
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUsd: null,
      }),
    ]);

    expect(totals.inputTokens).toBe(150);
    expect(totals.outputTokens).toBe(30);
    expect(totals.costUsd).toBeCloseTo(0.001);
  });

  test('panel-level events produce no transcript items', () => {
    const { items } = foldTranscript([
      ev('claude', 't', { kind: 'plan.updated', items: [{ text: 'x', status: 'pending' }] }),
      ev('codex', 't', { kind: 'diff.updated', patch: 'diff --git a/x b/x' }),
      ev('claude', 't', { kind: 'agent.status', status: 'busy', model: 'm', detail: null }),
      ev('claude', 't', { kind: 'raw', label: 'whatever', payload: {} }),
    ]);
    expect(items).toHaveLength(0);
  });

  test('lane events land in the transcript, because where the files went is conversation', () => {
    const { items } = foldTranscript([
      ev('codex', 't', {
        kind: 'lane.updated',
        status: 'provisioned',
        path: '/lanes/codex',
        detail: null,
      }),
      ev('codex', 't', {
        kind: 'lane.updated',
        status: 'refused',
        path: '/lanes/codex',
        detail: 'patch does not apply',
      }),
      ev('codex', 't', {
        kind: 'lane.updated',
        status: 'integrated',
        path: '/lanes/codex',
        detail: '2 file(s) applied',
      }),
    ]);

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ kind: 'notice', level: 'info' });
    // A refusal is the one the user has to act on, so it reads as an error, not a note.
    expect(items[1]).toMatchObject({ kind: 'notice', level: 'error' });
    expect(items[1]).toHaveProperty('text', expect.stringContaining('patch does not apply'));
    expect(items[2]).toHaveProperty('text', expect.stringContaining('2 file(s) applied'));
  });

  test('an empty log yields empty output rather than throwing', () => {
    const { items, totals } = foldTranscript([]);
    expect(items).toEqual([]);
    expect(totals).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });
});

/**
 * The incremental folder exists only to be faster; it earns that by being
 * indistinguishable from the one-pass fold at every prefix of the log, including the
 * awkward ones — a completion that replaces accumulated text, duplicated deltas, a
 * handover between agents. So the equivalence checks compare whole snapshots step by
 * step rather than probing individual fields.
 */

/** A log that exercises every branch the fold has, in the order a real turn produces. */
function busyLog(): HarnessEvent[] {
  return [
    ev(null, null, { kind: 'user.message', text: 'run the build', hadReplay: false }),
    ev('claude', 't1', { kind: 'turn.started', nativeSessionId: null }),
    ev('claude', 't1', { kind: 'agent.status', status: 'busy', model: 'sonnet', detail: null }),
    ev('claude', 't1', { kind: 'reasoning.delta', itemId: 'r1', text: 'think' }),
    ev('claude', 't1', { kind: 'reasoning.delta', itemId: 'r1', text: 'ing' }),
    ev('claude', 't1', { kind: 'reasoning.completed', itemId: 'r1', text: 'thought it over' }),
    ev('claude', 't1', { kind: 'message.delta', itemId: 'm1', text: 'On ' }),
    // The same delta arriving twice must not survive the completion below.
    ev('claude', 't1', { kind: 'message.delta', itemId: 'm1', text: 'it' }),
    ev('claude', 't1', { kind: 'message.delta', itemId: 'm1', text: 'it' }),
    ev('claude', 't1', {
      kind: 'tool.started',
      itemId: 'tool1',
      name: 'Bash',
      toolKind: 'command',
      title: 'npm run build',
      input: { command: 'npm run build' },
    }),
    ev('claude', 't1', { kind: 'tool.output', itemId: 'tool1', stream: 'stdout', chunk: 'step 1\n' }),
    ev('claude', 't1', { kind: 'tool.output', itemId: 'tool1', stream: 'stderr', chunk: 'warn\n' }),
    ev('claude', 't1', {
      kind: 'tool.completed',
      itemId: 'tool1',
      status: 'ok',
      output: 'step 1\nwarn\n',
      exitCode: 0,
    }),
    // A chunk after the completion still belongs to the same row.
    ev('claude', 't1', { kind: 'tool.output', itemId: 'tool1', stream: 'stdout', chunk: 'late\n' }),
    ev('claude', 't1', { kind: 'message.completed', itemId: 'm1', text: 'On it — built.' }),
    ev('claude', 't1', {
      kind: 'usage',
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: 0.002,
    }),
    ev('claude', 't1', { kind: 'turn.completed', reason: 'completed', error: null, durationMs: 9 }),
    ev(null, null, { kind: 'user.message', text: 'now codex', hadReplay: false }),
    ev('codex', 't2', { kind: 'turn.started', nativeSessionId: null }),
    ev('codex', 't2', { kind: 'turn.started', nativeSessionId: null }),
    ev('codex', 't2', {
      kind: 'tool.completed',
      itemId: 'orphan',
      status: 'error',
      output: 'boom',
      exitCode: 1,
    }),
    ev('codex', 't2', { kind: 'message.completed', itemId: 'm2', text: 'Handed over.' }),
    ev('codex', 't2', { kind: 'error', message: 'stream closed', severity: 'turn' }),
    ev('codex', 't2', {
      kind: 'turn.completed',
      reason: 'interrupted',
      error: null,
      durationMs: 3,
    }),
  ];
}

describe('TranscriptFolder — equivalence with the one-pass fold', () => {
  test('every prefix of a busy log folds identically event by event', () => {
    const events = busyLog();
    const folder = new TranscriptFolder();

    for (let i = 1; i <= events.length; i += 1) {
      const prefix = events.slice(0, i);
      expect(folder.fold(prefix)).toEqual(foldTranscript(prefix));
    }
  });

  test('a log arriving all at once folds the same as one arriving event by event', () => {
    const events = busyLog();
    const incremental = new TranscriptFolder();
    for (let i = 1; i <= events.length; i += 1) incremental.fold(events.slice(0, i));

    expect(incremental.fold(events.slice())).toEqual(new TranscriptFolder().fold(events));
  });

  test('the same array folded twice returns the same summary without re-folding', () => {
    const events = busyLog();
    const folder = new TranscriptFolder();
    const first = folder.fold(events);
    expect(folder.fold(events)).toBe(first);
  });

  test('an untouched item keeps its identity across a delta', () => {
    const opening = [
      ev('claude', 't', { kind: 'message.completed', itemId: 'm1', text: 'first' }),
      ev('claude', 't', { kind: 'message.delta', itemId: 'm2', text: 'sec' }),
    ];
    const folder = new TranscriptFolder();
    const before = folder.fold(opening);
    const after = folder.fold([
      ...opening,
      ev('claude', 't', { kind: 'message.delta', itemId: 'm2', text: 'ond' }),
    ]);

    // Rendering markdown for a block that did not change is the cost worth avoiding.
    expect(after.items[0]).toBe(before.items[0]);
    expect(after.items[1]).not.toBe(before.items[1]);
    expect(after.items[1]).toMatchObject({ text: 'second' });
  });

  test('an earlier snapshot is not rewritten by later events', () => {
    const opening = [ev('claude', 't', { kind: 'message.delta', itemId: 'm1', text: 'Hel' })];
    const folder = new TranscriptFolder();
    const before = folder.fold(opening);
    folder.fold([
      ...opening,
      ev('claude', 't', { kind: 'message.completed', itemId: 'm1', text: 'Hello' }),
    ]);

    expect(before.items[0]).toMatchObject({ text: 'Hel', streaming: true });
    expect(before.items).toHaveLength(1);
  });
});

describe('TranscriptFolder — replaced logs', () => {
  test('switching to another thread folds the new log rather than extending the old', () => {
    const first = busyLog();
    const second = [
      ev(null, null, { kind: 'user.message', text: 'other thread', hadReplay: false }),
      ev('codex', 'x1', { kind: 'turn.started', nativeSessionId: null }),
      ev('codex', 'x1', { kind: 'message.completed', itemId: 'm9', text: 'elsewhere' }),
    ];

    const folder = new TranscriptFolder();
    folder.fold(first);
    expect(folder.fold(second)).toEqual(foldTranscript(second));
  });

  test('a longer log from a different thread is not mistaken for an append', () => {
    const first = busyLog().slice(0, 3);
    const second = busyLog();

    const folder = new TranscriptFolder();
    folder.fold(first);
    expect(folder.fold(second)).toEqual(foldTranscript(second));
  });

  test('clearing the log empties the transcript', () => {
    const folder = new TranscriptFolder();
    folder.fold(busyLog());
    expect(folder.fold([])).toEqual({
      items: [],
      totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    });
  });

  test('a resync that re-delivers the same log plus more applies only the new events', () => {
    const events = busyLog();
    const folder = new TranscriptFolder();
    folder.fold(events.slice(0, 6));

    // `thread.open` hands back the whole log in a fresh array; the overlap is identical.
    const resynced = [
      ...events,
      ev('codex', 't2', { kind: 'message.completed', itemId: 'm3', text: 'after reconnect' }),
    ];
    expect(folder.fold(resynced)).toEqual(foldTranscript(resynced));
  });

  test('a log that lost its tail is folded from scratch', () => {
    const events = busyLog();
    const folder = new TranscriptFolder();
    folder.fold(events);
    const rewound = events.slice(0, 8);
    expect(folder.fold(rewound)).toEqual(foldTranscript(rewound));
  });
});

/**
 * Counts how many events the fold visits, by making `kind` — the property the switch
 * reads for every event — report itself. It measures the work that actually scales,
 * without the noise of a wall-clock timing in a test suite.
 */
function countingLog(events: HarnessEvent[], count: { visits: number }): HarnessEvent[] {
  return events.map((event) => {
    const kind = event.kind;
    const clone = { ...event };
    Object.defineProperty(clone, 'kind', {
      get: () => {
        count.visits += 1;
        return kind;
      },
      enumerable: true,
      configurable: true,
    });
    return clone as HarnessEvent;
  });
}

describe('TranscriptFolder — cost', () => {
  test('a streaming turn costs one visit per event instead of one per event per delta', () => {
    const raw: HarnessEvent[] = [
      ev(null, null, { kind: 'user.message', text: 'go', hadReplay: false }),
      ev('claude', 't1', { kind: 'turn.started', nativeSessionId: null }),
    ];
    for (let i = 0; i < 1998; i += 1) {
      raw.push(ev('claude', 't1', { kind: 'message.delta', itemId: 'm1', text: 'word ' }));
    }

    const incrementalCount = { visits: 0 };
    const incremental = countingLog(raw, incrementalCount);
    const folder = new TranscriptFolder();
    let last = folder.fold([]);
    for (let i = 1; i <= incremental.length; i += 1) last = folder.fold(incremental.slice(0, i));

    const fullCount = { visits: 0 };
    const full = countingLog(raw, fullCount);
    const grown: HarnessEvent[] = [];
    let reference = foldTranscript(grown);
    for (const event of full) {
      grown.push(event);
      reference = foldTranscript(grown);
    }

    expect(last).toEqual(reference);
    expect(incrementalCount.visits).toBe(raw.length);
    expect(fullCount.visits).toBe((raw.length * (raw.length + 1)) / 2);
    expect(fullCount.visits / incrementalCount.visits).toBeGreaterThan(100);
  });
});

describe('the integration gate in the transcript', () => {
  const blocked: HarnessEventBody = {
    kind: 'gate.evaluated',
    gate: 'lane.integration',
    allowed: false,
    candidate: { commit: 'c1', tree: 't1', dirty: false },
    requirements: [
      { name: 'test', command: 'npm test', state: 'stale', evidenceId: 'ev1', evidenceTree: 't0' },
      { name: 'lint', command: 'npm run lint', state: 'satisfied', evidenceId: 'ev2', evidenceTree: 't1' },
    ],
    override: null,
  };

  test('a refusal names what was unsatisfied', () => {
    const { items } = foldTranscript([ev('claude', null, blocked)]);

    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('notice');
    const notice = items[0] as Extract<TranscriptItem, { kind: 'notice' }>;
    expect(notice.level).toBe('error');
    expect(notice.text).toContain('test stale');
    expect(notice.text).not.toContain('lint');
  });

  test('an allowed integration is recorded too, so the yeses can be audited', () => {
    const { items } = foldTranscript([
      ev('claude', null, {
        ...blocked,
        allowed: true,
        requirements: [
          { name: 'test', command: 'npm test', state: 'satisfied', evidenceId: 'ev1', evidenceTree: 't1' },
        ],
      }),
    ]);

    const notice = items[0] as Extract<TranscriptItem, { kind: 'notice' }>;
    expect(notice.level).toBe('info');
    expect(notice.text).toContain('test passed');
  });

  test('an override says who, and what they went around', () => {
    const { items } = foldTranscript([
      ev('claude', null, {
        ...blocked,
        allowed: true,
        override: { actor: 'user', reason: 'the suite is broken on main' },
      }),
    ]);

    const notice = items[0] as Extract<TranscriptItem, { kind: 'notice' }>;
    expect(notice.text).toContain('user');
    expect(notice.text).toContain('test');
    expect(notice.text).toContain('the suite is broken on main');
  });
});
