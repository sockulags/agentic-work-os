import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadStore } from './thread-store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awos-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ThreadStore', () => {
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
