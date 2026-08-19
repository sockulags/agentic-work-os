import { describe, test, expect } from 'vitest';
import type { AgentId } from '@awos/protocol';
import { groupTranscriptItems, shouldExpandGroup, summarizeToolGroup } from './group-items';
import type { ToolItem } from './tool-summary';
import type { TranscriptItem } from './transcript';

/**
 * Grouping decides how much of a turn the reader has to scroll past, so the boundaries
 * are the whole point: a run must not swallow the message that follows it, and it must
 * not span two agents just because no divider happened to sit between them.
 */

let n = 0;

function toolItem(overrides: Partial<ToolItem> = {}): ToolItem {
  n += 1;
  return {
    kind: 'tool',
    id: `t${n}`,
    seq: n,
    agent: 'claude',
    name: 'Bash',
    toolKind: 'command',
    title: 'ls',
    input: { command: 'ls' },
    output: '',
    status: 'ok',
    exitCode: null,
    ts: 1000,
    ...overrides,
  };
}

function message(agent: AgentId = 'claude'): TranscriptItem {
  n += 1;
  return { kind: 'message', id: `m${n}`, seq: n, agent, text: 'hi', streaming: false, ts: 1000 };
}

describe('groupTranscriptItems', () => {
  test('collapses a run of tool calls into one row', () => {
    const tools = [toolItem(), toolItem(), toolItem()];
    const rows = groupTranscriptItems([message(), ...tools, message()]);

    expect(rows.map((row) => row.type)).toEqual(['item', 'tool-group', 'item']);
    const group = rows[1];
    if (group?.type !== 'tool-group') throw new Error('expected a group');
    expect(group.items).toEqual(tools);
    expect(group.key).toBe(`group:${tools[0]?.id}`);
  });

  test('leaves a lone tool call as itself', () => {
    const rows = groupTranscriptItems([message(), toolItem(), message()]);
    expect(rows.map((row) => row.type)).toEqual(['item', 'item', 'item']);
  });

  test('breaks a run when anything else interrupts it', () => {
    const rows = groupTranscriptItems([
      toolItem(),
      toolItem(),
      message(),
      toolItem(),
      toolItem(),
    ]);
    expect(rows.map((row) => row.type)).toEqual(['tool-group', 'item', 'tool-group']);
  });

  test('never groups calls made by different agents', () => {
    const rows = groupTranscriptItems([
      toolItem({ agent: 'claude' }),
      toolItem({ agent: 'claude' }),
      toolItem({ agent: 'codex' }),
    ]);
    expect(rows.map((row) => row.type)).toEqual(['tool-group', 'item']);
  });

  test('keeps every item and its order', () => {
    const items = [message(), toolItem(), toolItem(), message(), toolItem()];
    const flattened = groupTranscriptItems(items).flatMap((row) =>
      row.type === 'tool-group' ? row.items : [row.item],
    );
    expect(flattened).toEqual(items);
  });

  test('gives every row a distinct key', () => {
    const rows = groupTranscriptItems([message(), toolItem(), toolItem(), message(), toolItem()]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  test('handles an empty transcript', () => {
    expect(groupTranscriptItems([])).toEqual([]);
  });
});

describe('summarizeToolGroup', () => {
  test('counts steps and the span they covered', () => {
    const summary = summarizeToolGroup([
      toolItem({ ts: 1000 }),
      toolItem({ ts: 7000 }),
      toolItem({ ts: 13_000 }),
    ]);
    expect(summary.steps).toBe(3);
    expect(summary.durationMs).toBe(12_000);
    expect(summary.failed).toBe(0);
    expect(summary.running).toBe(false);
  });

  test('omits a duration nobody would believe', () => {
    expect(summarizeToolGroup([toolItem({ ts: 1000 }), toolItem({ ts: 1000 })]).durationMs).toBe(null);
  });

  test('counts failures and notices work still in flight', () => {
    const summary = summarizeToolGroup([
      toolItem({ status: 'error' }),
      toolItem({ status: 'aborted' }),
      toolItem({ status: 'running' }),
    ]);
    expect(summary.failed).toBe(2);
    expect(summary.running).toBe(true);
  });
});

describe('shouldExpandGroup', () => {
  const done = [toolItem(), toolItem()];

  test('collapses a run that worked', () => {
    expect(shouldExpandGroup(done, 'normal')).toBe(false);
  });

  test('opens a run containing a failure at every density', () => {
    const failed = [toolItem(), toolItem({ status: 'error' })];
    expect(shouldExpandGroup(failed, 'normal')).toBe(true);
    expect(shouldExpandGroup(failed, 'compact')).toBe(true);
  });

  test('follows a run still in progress, unless the reader asked for compact', () => {
    const running = [toolItem(), toolItem({ status: 'running' })];
    expect(shouldExpandGroup(running, 'normal')).toBe(true);
    expect(shouldExpandGroup(running, 'compact')).toBe(false);
  });

  test('opens everything in verbose', () => {
    expect(shouldExpandGroup(done, 'verbose')).toBe(true);
  });
});
