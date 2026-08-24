import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterEvent, HarnessEvent } from '@awos/protocol';
import { isCurrentEventLogSnapshot, isEventLogSnapshot, ThreadStore } from './thread-store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awos-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ThreadStore', () => {
  test('rejects worker-attributed visual evidence before appending it', () => {
    const store = new ThreadStore(dir);
    const thread = store.create({ cwd: '/repo' });
    const visualEvent: AdapterEvent = {
      kind: 'evidence.recorded',
      evidenceId: 'visual-worker-evidence',
      runId: null,
      workItemId: null,
      evidenceKind: 'artifact',
      ref: { eventId: null, url: null, label: 'visual' },
      summary: 'visual',
      state: { commit: null, tree: null, dirty: false },
      check: null,
      visual: {
        kind: 'model-rubric',
        reference: { eventId: 'ref-event', artifactId: 'ref', locator: 'artifact://ref', revision: '1', digest: 'ref' },
        candidate: { eventId: 'candidate-event', artifactId: 'candidate', locator: 'artifact://candidate', revision: '1', digest: 'candidate' },
        rubric: { eventId: 'rubric-event', id: 'visual', revision: '1', digest: 'rubric' },
        evaluator: { eventId: 'capability-event', id: 'independent-model', version: '1' },
        outcome: 'satisfied',
      },
    };

    assert.throws(
      () => store.append(thread.id, 'codex', visualEvent),
      /trusted core adapter/,
    );
    assert.equal(store.events(thread.id).length, 0);
  });

  test('assigns strictly increasing seq across agents', () => {
    const store = new ThreadStore(dir);
    const thread = store.create({ cwd: '/repo' });

    const a = store.append(thread.id, 'claude', { kind: 'message.completed', itemId: '1', text: 'a' });
    const b = store.append(thread.id, 'codex', { kind: 'message.completed', itemId: '2', text: 'b' });
    const c = store.append(thread.id, 'claude', { kind: 'message.completed', itemId: '3', text: 'c' });

    // Ordering must come from the store, not from two racing child processes.
    assert.deepEqual([a.seq, b.seq, c.seq], [1, 2, 3]);
    assert.equal(store.head(thread.id), 3);
  });

  test('creates a frozen store-owned snapshot that becomes stale after append', () => {
    const store = new ThreadStore(dir);
    const thread = store.create({ cwd: '/repo' });
    store.append(thread.id, 'codex', { kind: 'message.completed', itemId: '1', text: 'a' });

    const snapshot = store.snapshot(thread.id);
    assert.equal(isEventLogSnapshot(snapshot), true);
    assert.equal(isCurrentEventLogSnapshot(snapshot), true);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.events), true);
    assert.equal(Object.isFrozen(snapshot.events[0]), true);
    assert.throws(() => (snapshot.events as HarnessEvent[]).push(snapshot.events[0]!));
    assert.throws(() => ((snapshot.events[0] as HarnessEvent & { text: string }).text = 'changed'));

    const copied = [...snapshot.events];
    assert.equal(isEventLogSnapshot(copied), false);
    assert.equal(isEventLogSnapshot({ ...snapshot }), false);

    // Public transcript reads cannot mutate the append-only records used by a future view.
    store.events(thread.id).push(snapshot.events[0]!);
    assert.equal(store.snapshot(thread.id).events.length, 1);

    store.append(thread.id, 'codex', { kind: 'message.completed', itemId: '2', text: 'b' });
    assert.equal(snapshot.events.length, 1);
    assert.equal(isCurrentEventLogSnapshot(snapshot), false);
    const current = store.snapshot(thread.id);
    assert.equal(isCurrentEventLogSnapshot(current), true);
    assert.equal(current.events.length, 2);
  });

  test('eventsSince returns only events above the watermark', () => {
    const store = new ThreadStore(dir);
    const thread = store.create({ cwd: '/repo' });
    for (let i = 0; i < 5; i++) {
      store.append(thread.id, 'codex', { kind: 'message.completed', itemId: `${i}`, text: `${i}` });
    }
    const since = store.eventsSince(thread.id, 3);
    assert.deepEqual(since.map((e) => e.seq), [4, 5]);
  });

  test('persists across a restart', () => {
    const first = new ThreadStore(dir);
    const thread = first.create({ cwd: '/repo', title: 'my thread' });
    first.append(thread.id, 'claude', { kind: 'message.completed', itemId: '1', text: 'hello' });
    first.setNativeSession(thread.id, 'claude', 'sess-abc');
    first.setWatermark(thread.id, 'codex', 1);

    const second = new ThreadStore(dir);
    const reloaded = second.get(thread.id);

    assert.equal(reloaded?.title, 'my thread');
    assert.equal(reloaded?.nativeSessions.claude, 'sess-abc');
    assert.equal(reloaded?.watermarks.codex, 1);
    assert.equal(second.events(thread.id).length, 1);
    assert.equal(second.head(thread.id), 1);
  });

  test('does not revive persisted lane mode while keeping session and lane history', () => {
    const first = new ThreadStore(dir);
    const thread = first.create({ cwd: '/repo' });
    first.update(thread.id, { parallel: true });
    first.setNativeSession(thread.id, 'claude', 'sess-abc');
    first.append(thread.id, 'claude', {
      kind: 'lane.updated',
      status: 'provisioned',
      path: '/data/threads/t1/lanes/claude',
      detail: null,
    });

    const second = new ThreadStore(dir);
    const reloaded = second.get(thread.id);

    assert.equal(reloaded?.parallel, false);
    assert.equal(reloaded?.nativeSessions.claude, 'sess-abc');
    assert.equal(second.events(thread.id).some((event) => event.kind === 'lane.updated'), true);
  });

  test('clears a stale native session and its replay watermark together', () => {
    const store = new ThreadStore(dir);
    const thread = store.create({ cwd: '/repo' });
    store.setNativeSession(thread.id, 'qwen-local', 'stale-session');
    store.setWatermark(thread.id, 'qwen-local', 12);

    store.clearNativeSession(thread.id, 'qwen-local');

    const summary = store.get(thread.id);
    assert.equal(summary?.nativeSessions['qwen-local'], undefined);
    assert.equal(summary?.watermarks['qwen-local'], 0);
  });

  test('survives a transcript torn by a crash mid-append', () => {
    const first = new ThreadStore(dir);
    const thread = first.create({ cwd: '/repo' });
    first.append(thread.id, 'claude', { kind: 'message.completed', itemId: '1', text: 'complete' });

    // Simulate a process killed halfway through writing the next line.
    appendFileSync(join(dir, 'threads', thread.id, 'events.jsonl'), '{"seq":2,"kind":"mess');

    const second = new ThreadStore(dir);
    // The complete event survives; only the torn line is dropped.
    assert.equal(second.events(thread.id).length, 1);
    assert.equal(second.head(thread.id), 1);
  });

  test('a corrupt thread does not stop other threads loading', () => {
    const first = new ThreadStore(dir);
    const good = first.create({ cwd: '/repo', title: 'good' });
    const bad = first.create({ cwd: '/repo', title: 'bad' });
    first.append(good.id, 'claude', { kind: 'message.completed', itemId: '1', text: 'x' });

    // Truncate the bad thread's metadata to invalid JSON.
    appendFileSync(join(dir, 'threads', bad.id, 'meta.json'), '{{{ not json');

    const second = new ThreadStore(dir);
    assert.equal(second.get(good.id)?.title, 'good');
    assert.equal(second.get(bad.id), undefined);
  });

  test('delete removes the thread from disk', () => {
    const store = new ThreadStore(dir);
    const thread = store.create({ cwd: '/repo' });
    store.append(thread.id, 'claude', { kind: 'message.completed', itemId: '1', text: 'x' });

    store.delete(thread.id);
    assert.equal(store.get(thread.id), undefined);
    assert.equal(store.list().length, 0);

    const reloaded = new ThreadStore(dir);
    assert.equal(reloaded.get(thread.id), undefined);
  });

  test('the transcript on disk is one json object per line', () => {
    const store = new ThreadStore(dir);
    const thread = store.create({ cwd: '/repo' });
    store.append(thread.id, 'claude', { kind: 'message.completed', itemId: '1', text: 'a' });
    store.append(thread.id, 'codex', { kind: 'message.completed', itemId: '2', text: 'b' });

    const raw = readFileSync(join(dir, 'threads', thread.id, 'events.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  });

  test('list is ordered by most recently updated', () => {
    const store = new ThreadStore(dir);
    const older = store.create({ cwd: '/a', title: 'older' });
    const newer = store.create({ cwd: '/b', title: 'newer' });
    store.append(older.id, 'claude', { kind: 'message.completed', itemId: '1', text: 'x' });

    assert.equal(store.list()[0]?.id, older.id);
    store.append(newer.id, 'claude', { kind: 'message.completed', itemId: '2', text: 'y' });
    assert.equal(store.list()[0]?.id, newer.id);
  });
});
