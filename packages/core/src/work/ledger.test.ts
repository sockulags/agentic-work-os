import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { HarnessEvent } from '@awos/protocol';
import { foldEvidence, foldOutcomes, foldRetained, selectedForContext } from './ledger.js';

let seq = 0;

function event(body: Record<string, unknown> & { kind: string }): HarnessEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    seq,
    threadId: 't1',
    agent: null,
    turnId: null,
    ts: 1_000 + seq,
    ...body,
  } as unknown as HarnessEvent;
}

function evidence(id: string, overrides: Record<string, unknown> = {}): HarnessEvent {
  return event({
    kind: 'evidence.recorded',
    evidenceId: id,
    runId: 'r1',
    workItemId: 'w1',
    evidenceKind: 'command',
    ref: { eventId: 'e-cmd', url: null, label: 'npm test' },
    summary: '269 passed',
    state: { commit: 'abc123', tree: 'tree1', dirty: false },
    ...overrides,
  });
}

function retained(id: string, overrides: Record<string, unknown> = {}): HarnessEvent {
  return event({
    kind: 'context.retained',
    retainedId: id,
    workItemId: 'w1',
    retainedKind: 'decision',
    text: 'gh, not an API token',
    runId: 'r1',
    selected: true,
    retired: false,
    ...overrides,
  });
}

describe('foldOutcomes', () => {
  test('a run with no claim has no outcome, whatever its turn did', () => {
    assert.equal(foldOutcomes([event({ kind: 'turn.completed', reason: 'completed', error: null, durationMs: 1 })]).size, 0);
  });

  test('keeps the claim and who made it', () => {
    const outcomes = foldOutcomes([
      event({ kind: 'run.closed', runId: 'r1', claim: 'partial', statement: 'the parser is done' }),
    ]);

    assert.equal(outcomes.get('r1')?.claim, 'partial');
    assert.equal(outcomes.get('r1')?.statement, 'the parser is done');
    assert.equal(outcomes.get('r1')?.source, 'user');
  });

  test('an agent claim is attributed to the agent', () => {
    const outcomes = foldOutcomes([
      event({ kind: 'run.closed', runId: 'r1', claim: 'delivered', statement: 'done', agent: 'codex' }),
    ]);

    assert.equal(outcomes.get('r1')?.source, 'codex');
  });

  test('a correction wins without erasing the claim it corrects', () => {
    const events = [
      event({ kind: 'run.closed', runId: 'r1', claim: 'delivered', statement: 'done' }),
      event({ kind: 'run.closed', runId: 'r1', claim: 'partial', statement: 'the tests were wrong' }),
    ];

    assert.equal(foldOutcomes(events).get('r1')?.claim, 'partial');
    // The earlier claim is still in the log, which is the whole point of appending.
    assert.equal(events.filter((e) => e.kind === 'run.closed').length, 2);
  });
});

describe('foldEvidence', () => {
  test('keeps what it points at and the tree it applies to', () => {
    const [item] = foldEvidence([evidence('ev1')]);

    assert.equal(item?.kind, 'command');
    assert.equal(item?.ref.label, 'npm test');
    assert.equal(item?.ref.eventId, 'e-cmd');
    assert.equal(item?.state.commit, 'abc123');
    assert.equal(item?.runId, 'r1');
    assert.equal(item?.workItemId, 'w1');
  });

  test('a corrected item replaces its earlier version', () => {
    const items = foldEvidence([
      evidence('ev1', { summary: '269 passed' }),
      evidence('ev1', { summary: 'actually 3 were skipped' }),
    ]);

    assert.equal(items.length, 1);
    assert.equal(items[0]?.summary, 'actually 3 were skipped');
  });

  test('separate items stay separate', () => {
    assert.equal(foldEvidence([evidence('ev1'), evidence('ev2')]).length, 2);
  });

  test('an external link needs no event to point at', () => {
    const [item] = foldEvidence([
      evidence('ev1', {
        evidenceKind: 'link',
        ref: { eventId: null, url: 'https://example.com/run/9', label: 'staging deploy' },
      }),
    ]);

    assert.equal(item?.ref.url, 'https://example.com/run/9');
    assert.equal(item?.ref.eventId, null);
  });
});

describe('foldRetained', () => {
  test('keeps the claim, its kind, and where it came from', () => {
    const [item] = foldRetained([retained('k1')]);

    assert.equal(item?.kind, 'decision');
    assert.equal(item?.text, 'gh, not an API token');
    assert.equal(item?.runId, 'r1');
    assert.equal(item?.selected, true);
  });

  test('an amendment changes the flags without changing the words', () => {
    const items = foldRetained([
      retained('k1'),
      retained('k1', { selected: false, retired: true }),
    ]);

    assert.equal(items.length, 1);
    assert.equal(items[0]?.text, 'gh, not an API token');
    assert.equal(items[0]?.selected, false);
    assert.equal(items[0]?.retired, true);
  });
});

describe('selectedForContext', () => {
  test('carries forward only what was selected and still stands', () => {
    const items = foldRetained([
      retained('k1', { text: 'carried' }),
      retained('k2', { text: 'not selected', selected: false }),
      retained('k3', { text: 'retired', retired: true }),
    ]);

    assert.deepEqual(
      selectedForContext(items).map((entry) => entry.text),
      ['carried'],
    );
  });

  test('oldest first, so a later decision reads as the later one', () => {
    const items = foldRetained([retained('k1', { text: 'first' }), retained('k2', { text: 'second' })]);

    assert.deepEqual(
      selectedForContext(items).map((entry) => entry.text),
      ['first', 'second'],
    );
  });
});
