import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HUMAN_AUTH_TOKEN_ENV } from '../config.js';
import { snapshotWorkingTree, diffTrees, tryGit } from './git.js';

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

  test('does not pass the human authority credential to git children', async () => {
    const previous = process.env[HUMAN_AUTH_TOKEN_ENV];
    process.env[HUMAN_AUTH_TOKEN_ENV] = 'human-git-secret';
    writeFileSync(
      join(repo, 'env-probe.js'),
      "process.stdout.write(JSON.stringify({ ordinary: process.env.AWOS_TOKEN, human: process.env.AWOS_HUMAN_AUTH_TOKEN }));\n",
    );
    try {
      const result = await tryGit(repo, ['awos-env'], {
        AWOS_TOKEN: 'ordinary-git-token',
        [HUMAN_AUTH_TOKEN_ENV.toLowerCase()]: 'override-human-git-secret-lower',
        AwOs_HuMaN_AuTh_ToKeN: 'override-human-git-secret-mixed',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'alias.awos-env',
        GIT_CONFIG_VALUE_0: '!node env-probe.js',
      });
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout ?? ''), { ordinary: 'ordinary-git-token' });
    } finally {
      if (previous === undefined) delete process.env[HUMAN_AUTH_TOKEN_ENV];
      else process.env[HUMAN_AUTH_TOKEN_ENV] = previous;
    }
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
