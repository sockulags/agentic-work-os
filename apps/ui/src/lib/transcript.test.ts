import { describe, test, expect } from 'vitest';
import type { AgentId, HarnessEvent, HarnessEventBody } from '@awos/protocol';
import { foldTranscript, type TranscriptItem } from './transcript';

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

  test('an empty log yields empty output rather than throwing', () => {
    const { items, totals } = foldTranscript([]);
    expect(items).toEqual([]);
    expect(totals).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });
});
