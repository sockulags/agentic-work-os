import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { PINNED_CONTEXT_MAX_CHARS } from '@awos/protocol';
import { ContextStore, applyPinnedContext, buildPinnedContext } from './context-store.js';
import { ThreadStore } from './thread-store.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'awos-context-'));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('ContextStore', () => {
  test('round-trips through context.md next to the transcript', () => {
    const dir = tempDir();
    const threads = new ThreadStore(dir);
    const thread = threads.create({ cwd: process.cwd() });
    const context = new ContextStore(dir);

    assert.equal(context.get(thread.id), '', 'a fresh thread has no pinned context');

    context.set(thread.id, '# Conventions\n\nNever push to main.');

    const path = join(dir, 'threads', thread.id, 'context.md');
    assert.equal(readFileSync(path, 'utf8'), '# Conventions\n\nNever push to main.');
    assert.equal(context.get(thread.id), '# Conventions\n\nNever push to main.');
  });

  test('survives a restart, because the file is the state', () => {
    const dir = tempDir();
    const threads = new ThreadStore(dir);
    const thread = threads.create({ cwd: process.cwd() });

    new ContextStore(dir).set(thread.id, 'remember this');

    assert.equal(new ContextStore(dir).get(thread.id), 'remember this');
  });

  test('keeps text over the prompt budget instead of refusing it', () => {
    const dir = tempDir();
    const threads = new ThreadStore(dir);
    const thread = threads.create({ cwd: process.cwd() });
    const context = new ContextStore(dir);

    const oversized = 'x'.repeat(PINNED_CONTEXT_MAX_CHARS + 1);
    context.set(thread.id, oversized);

    // The budget belongs to the prompt, not to the document. Refusing here would leave
    // the user's text with nowhere to live.
    assert.equal(context.get(thread.id), oversized);
  });

  test('clearing the text clears the context', () => {
    const dir = tempDir();
    const threads = new ThreadStore(dir);
    const thread = threads.create({ cwd: process.cwd() });
    const context = new ContextStore(dir);

    context.set(thread.id, 'temporary');
    context.set(thread.id, '');

    assert.equal(context.get(thread.id), '');
  });
});

describe('buildPinnedContext', () => {
  test('nothing pinned yields no block', () => {
    assert.equal(buildPinnedContext('', { maxChars: 100 }), null);
    assert.equal(buildPinnedContext('   \n\t ', { maxChars: 100 }), null);
  });

  test('wraps the notes in a tagged block', () => {
    const block = buildPinnedContext('Use pnpm, not npm.', { maxChars: 100 });
    assert.ok(block !== null);
    assert.ok(block.startsWith('<pinned-context>'));
    assert.ok(block.endsWith('</pinned-context>'));
    assert.match(block, /Use pnpm, not npm\./);
  });

  test('cuts at the budget and says that it did', () => {
    const block = buildPinnedContext('Z'.repeat(500), { maxChars: 100 });
    assert.ok(block !== null);
    assert.ok(block.includes('Z'.repeat(100)));
    assert.ok(!block.includes('Z'.repeat(101)));
    assert.match(block, /budget/);
  });
});

describe('applyPinnedContext', () => {
  test('leaves the prompt untouched when nothing is pinned', () => {
    assert.equal(applyPinnedContext(null, 'do the thing'), 'do the thing');
  });

  test('puts the block ahead of the prompt', () => {
    const block = buildPinnedContext('house rules', { maxChars: 100 });
    const payload = applyPinnedContext(block, 'do the thing');
    assert.ok(payload.startsWith('<pinned-context>'));
    assert.ok(payload.endsWith('do the thing'));
  });
});

describe('reading a file edited outside the app', () => {
  test('an oversized file is cut at injection, and the turn still goes out', () => {
    const dir = tempDir();
    const threads = new ThreadStore(dir);
    const thread = threads.create({ cwd: process.cwd() });

    writeFileSync(join(dir, 'threads', thread.id, 'context.md'), 'z'.repeat(50_000), 'utf8');

    const block = buildPinnedContext(new ContextStore(dir).get(thread.id), {
      maxChars: PINNED_CONTEXT_MAX_CHARS,
    });
    assert.ok(block !== null);
    assert.ok(block.length < 50_000);
    assert.match(block, /budget/);
  });
});
