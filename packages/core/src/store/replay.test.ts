import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentId, HarnessEvent, HarnessEventBody } from '@awos/protocol';
import { buildReplay, applyReplay, stripReplay, hasReplay, groupIntoTurns } from './replay.js';

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

const OPTIONS = { maxChars: 24_000, maxToolOutput: 800 };

describe('buildReplay', () => {
  test('returns nothing when every event already came from this agent', () => {
    const events = [
      ev('claude', 'a', { kind: 'message.completed', itemId: 'm', text: 'hi' }),
    ];
    const result = buildReplay(events, 'claude', OPTIONS);
    assert.equal(result.preamble, null);
    assert.equal(result.turnCount, 0);
  });

  test('renders foreign turns for the incoming agent', () => {
    const events = [
      ev(null, null, { kind: 'user.message', text: 'refactor auth', hadReplay: false }),
      ev('codex', 'c1', { kind: 'tool.started', itemId: 't', name: 'exec', toolKind: 'command', title: 'cargo test', input: {} }),
      ev('codex', 'c1', { kind: 'tool.completed', itemId: 't', status: 'ok', output: 'ok', exitCode: 0 }),
      ev('codex', 'c1', { kind: 'message.completed', itemId: 'm', text: 'Split the middleware.' }),
    ];

    const result = buildReplay(events, 'claude', OPTIONS);
    assert.ok(result.preamble);
    const text = result.preamble as string;

    assert.match(text, /<harness-replay>/);
    assert.match(text, /<\/harness-replay>/);
    assert.match(text, /cargo test/);
    assert.match(text, /Split the middleware\./);
    assert.match(text, /refactor auth/);
    // The incoming agent must not think it still has to do this work.
    assert.match(text, /do not redo it/);
  });

  test('omits deltas, usage, and status noise', () => {
    const events = [
      ev('codex', 'c1', { kind: 'message.delta', itemId: 'm', text: 'partial' }),
      ev('codex', 'c1', { kind: 'usage', inputTokens: 10, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null }),
      ev('codex', 'c1', { kind: 'agent.status', status: 'busy', model: 'gpt', detail: null }),
      ev('codex', 'c1', { kind: 'message.completed', itemId: 'm', text: 'final' }),
    ];

    const text = buildReplay(events, 'claude', OPTIONS).preamble as string;
    assert.match(text, /final/);
    assert.doesNotMatch(text, /partial/);
    assert.doesNotMatch(text, /busy/);
  });

  test('truncates long tool output but keeps the fact it ran', () => {
    const events = [
      ev('codex', 'c1', { kind: 'tool.started', itemId: 't', name: 'exec', toolKind: 'command', title: 'build', input: {} }),
      ev('codex', 'c1', {
        kind: 'tool.completed',
        itemId: 't',
        status: 'ok',
        output: `${'x'.repeat(50)}\n`.repeat(100),
        exitCode: 0,
      }),
    ];

    const text = buildReplay(events, 'claude', { maxChars: 24_000, maxToolOutput: 100 })
      .preamble as string;
    assert.match(text, /build/);
    assert.match(text, /more lines elided/);
    assert.ok(text.length < 2_000, `expected a truncated block, got ${text.length} chars`);
  });

  test('drops the oldest turns when over budget and says so', () => {
    const events: HarnessEvent[] = [];
    for (let i = 0; i < 20; i++) {
      events.push(
        ev('codex', `c${i}`, {
          kind: 'message.completed',
          itemId: `m${i}`,
          text: `turn ${i} ${'y'.repeat(200)}`,
        }),
      );
    }

    const result = buildReplay(events, 'claude', { maxChars: 1_000, maxToolOutput: 100 });
    const text = result.preamble as string;

    assert.ok(result.elidedTurns > 0, 'expected some turns to be elided');
    assert.match(text, /earlier turns? elided/);
    // Newest-first: the most recent turn is what makes the new message intelligible.
    assert.match(text, /turn 19/);
    assert.doesNotMatch(text, /turn 0 /);
  });

  test('always keeps at least one turn even if it blows the budget', () => {
    const events = [
      ev('codex', 'c1', { kind: 'message.completed', itemId: 'm', text: 'z'.repeat(5_000) }),
    ];
    const result = buildReplay(events, 'claude', { maxChars: 100, maxToolOutput: 100 });
    assert.ok(result.preamble, 'a single oversized turn must still be replayed');
    assert.equal(result.turnCount, 1);
  });

  test('notes an interrupted turn so the agent does not assume it finished', () => {
    const events = [
      ev('codex', 'c1', { kind: 'message.completed', itemId: 'm', text: 'starting' }),
      ev('codex', 'c1', { kind: 'turn.completed', reason: 'interrupted', error: null, durationMs: 10 }),
    ];
    const text = buildReplay(events, 'claude', OPTIONS).preamble as string;
    assert.match(text, /interrupted by the user/);
  });
});

describe('applyReplay / stripReplay', () => {
  test('applyReplay is a no-op without a preamble', () => {
    assert.equal(applyReplay(null, 'hello'), 'hello');
  });

  test('round-trips: what the user typed survives the wrapper', () => {
    const events = [
      ev('codex', 'c1', { kind: 'message.completed', itemId: 'm', text: 'did a thing' }),
    ];
    const preamble = buildReplay(events, 'claude', OPTIONS).preamble;
    const wire = applyReplay(preamble, 'now add rate limiting');

    assert.ok(hasReplay(wire));
    assert.equal(stripReplay(wire), 'now add rate limiting');
  });

  test('stripReplay leaves an unwrapped message alone', () => {
    assert.equal(stripReplay('just a message'), 'just a message');
    assert.equal(hasReplay('just a message'), false);
  });

  test('a user message that merely mentions the tag is not mistaken for a wrapper', () => {
    const text = 'what does </harness-replay> mean?';
    assert.equal(hasReplay(text), false);
    assert.equal(stripReplay(text), text);
  });
});

describe('groupIntoTurns', () => {
  test('groups by turn id and keeps order', () => {
    const events = [
      ev('claude', 'a', { kind: 'message.completed', itemId: '1', text: 'one' }),
      ev('claude', 'a', { kind: 'message.completed', itemId: '2', text: 'two' }),
      ev('codex', 'b', { kind: 'message.completed', itemId: '3', text: 'three' }),
    ];
    const groups = groupIntoTurns(events);
    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.events.length, 2);
    assert.equal(groups[1]?.agent, 'codex');
  });

  test('ignores events outside any turn', () => {
    const events = [
      ev('claude', null, { kind: 'agent.status', status: 'ready', model: null, detail: null }),
    ];
    assert.equal(groupIntoTurns(events).length, 0);
  });
});
