import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotWorkingTree, diffTrees } from './git.js';

/**
 * These drive real git in a throwaway repo. `snapshotWorkingTree` writes tree objects via
 * a scratch index and never commits, so no author identity is required.
 */
describe('git working-tree snapshots', () => {
  let repo: string;
  let plain: string;

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'awos-gittest-repo-'));
    plain = mkdtempSync(join(tmpdir(), 'awos-gittest-plain-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
  });

  after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  });

  test('returns null outside a git repository', async () => {
    assert.equal(await snapshotWorkingTree(plain), null);
  });

  test('captures a tree that changes when a tracked file changes', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    const before = await snapshotWorkingTree(repo);
    assert.ok(before, 'snapshot inside a repo yields a tree sha');

    writeFileSync(join(repo, 'a.txt'), 'two\n');
    const afterEdit = await snapshotWorkingTree(repo);
    assert.ok(afterEdit);
    assert.notEqual(before, afterEdit, 'the tree sha moves when a file changes');
  });

  test('diffs two snapshots into a unified patch', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    const before = await snapshotWorkingTree(repo);
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    const afterEdit = await snapshotWorkingTree(repo);

    const patch = await diffTrees(repo, before!, afterEdit!);
    assert.ok(patch, 'a change produces a patch');
    assert.match(patch, /a\.txt/);
    assert.match(patch, /-one/);
    assert.match(patch, /\+two/);
  });

  test('includes untracked files but honors .gitignore', async () => {
    const base = await snapshotWorkingTree(repo);

    writeFileSync(join(repo, 'new.txt'), 'fresh\n'); // untracked, should appear
    writeFileSync(join(repo, 'ignored.txt'), 'noise\n'); // ignored, should not
    const next = await snapshotWorkingTree(repo);

    const patch = (await diffTrees(repo, base!, next!)) ?? '';
    assert.match(patch, /new\.txt/, 'untracked files are captured');
    assert.doesNotMatch(patch, /ignored\.txt/, 'gitignored files are excluded');
  });

  test('returns null when the two snapshots are identical', async () => {
    const snap = await snapshotWorkingTree(repo);
    assert.equal(await diffTrees(repo, snap!, snap!), null);
  });
});
