import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionLane, laneDiff, integrateLane, removeLane } from './worktree.js';

/**
 * These drive real git in throwaway repos. A lane is a real worktree, and the failure
 * modes worth testing — a lane that misses uncommitted work, an integration that half
 * applies — only show up against real git.
 */
describe('lanes', () => {
  const roots: string[] = [];
  let repo: string;
  let plain: string;

  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'awos-lane-repo-'));
    roots.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    // Without this, a checkout on Windows rewrites LF to CRLF and the assertions below
    // would be measuring the host's line-ending policy instead of what a lane carries.
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: dir });
    return dir;
  }

  function lanePath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'awos-lane-'));
    roots.push(dir);
    // git worktree add refuses an existing non-empty path, and mkdtemp made it for us.
    rmSync(dir, { recursive: true, force: true });
    return dir;
  }

  before(() => {
    repo = makeRepo();
    plain = mkdtempSync(join(tmpdir(), 'awos-lane-plain-'));
    roots.push(plain);
  });

  after(() => {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  });

  test('refuses a directory that is not a git repository', async () => {
    const result = await provisionLane(plain, lanePath());
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : '', /not a git repository/);
  });

  test('a lane starts from the working tree, not the last commit', async () => {
    const base = makeRepo();
    // Uncommitted work of both kinds: an edit to a tracked file and a brand new one.
    writeFileSync(join(base, 'a.txt'), 'edited but not committed\n');
    writeFileSync(join(base, 'new.txt'), 'untracked\n');

    const result = await provisionLane(base, lanePath());
    assert.ok(result.ok, result.ok === false ? result.reason : '');
    const lane = result.lane;

    assert.equal(readFileSync(join(lane.path, 'a.txt'), 'utf8'), 'edited but not committed\n');
    assert.equal(readFileSync(join(lane.path, 'new.txt'), 'utf8'), 'untracked\n');
    // Seeding is not a change the lane made.
    assert.equal(await laneDiff(lane), null);
  });

  test('integration applies the lane work to the base tree and leaves the lane alone', async () => {
    const base = makeRepo();
    const result = await provisionLane(base, lanePath());
    assert.ok(result.ok);
    const lane = result.lane;

    writeFileSync(join(lane.path, 'a.txt'), 'changed in the lane\n');
    writeFileSync(join(lane.path, 'added.txt'), 'new from the lane\n');

    const patch = await laneDiff(lane);
    assert.ok(patch, 'the lane reports what it changed');

    const integrated = await integrateLane(lane, base);
    assert.equal(integrated.ok, true);
    assert.equal(readFileSync(join(base, 'a.txt'), 'utf8'), 'changed in the lane\n');
    assert.equal(readFileSync(join(base, 'added.txt'), 'utf8'), 'new from the lane\n');
    assert.equal(readFileSync(join(lane.path, 'a.txt'), 'utf8'), 'changed in the lane\n');
  });

  test('integrating twice is not integrating twice', async () => {
    const base = makeRepo();
    const result = await provisionLane(base, lanePath());
    assert.ok(result.ok);
    const lane = result.lane;

    writeFileSync(join(lane.path, 'log.txt'), 'line\n');
    assert.equal((await integrateLane(lane, base)).ok, true);

    // The baseline advanced, so there is nothing left to carry over.
    const second = await integrateLane(lane, base);
    assert.deepEqual(second, { ok: true, patch: null });
    assert.equal(readFileSync(join(base, 'log.txt'), 'utf8'), 'line\n');
  });

  test('a conflicting integration is refused and changes nothing', async () => {
    const base = makeRepo();
    const result = await provisionLane(base, lanePath());
    assert.ok(result.ok);
    const lane = result.lane;

    // Both sides edit the same line from the same baseline.
    writeFileSync(join(lane.path, 'a.txt'), 'the lane version\n');
    writeFileSync(join(base, 'a.txt'), 'the base version\n');
    writeFileSync(join(base, 'untouched.txt'), 'still here\n');

    const integrated = await integrateLane(lane, base);
    assert.equal(integrated.ok, false);
    // All or nothing: the base keeps its own edit, with no markers written into it.
    assert.equal(readFileSync(join(base, 'a.txt'), 'utf8'), 'the base version\n');
    assert.doesNotMatch(readFileSync(join(base, 'a.txt'), 'utf8'), /<<<<</);
    assert.equal(readFileSync(join(base, 'untouched.txt'), 'utf8'), 'still here\n');

    // And the refusal is retryable: once the base moves out of the way, it lands.
    writeFileSync(join(base, 'a.txt'), 'one\n');
    assert.equal((await integrateLane(lane, base)).ok, true);
    assert.equal(readFileSync(join(base, 'a.txt'), 'utf8'), 'the lane version\n');
  });

  test('two lanes on one repo do not see each other until integration', async () => {
    const base = makeRepo();
    const first = await provisionLane(base, lanePath());
    const second = await provisionLane(base, lanePath());
    assert.ok(first.ok);
    assert.ok(second.ok);

    writeFileSync(join(first.lane.path, 'from-first.txt'), 'first\n');
    writeFileSync(join(second.lane.path, 'from-second.txt'), 'second\n');

    assert.equal(existsSync(join(second.lane.path, 'from-first.txt')), false);
    assert.equal(existsSync(join(base, 'from-first.txt')), false);

    assert.equal((await integrateLane(first.lane, base)).ok, true);
    assert.equal((await integrateLane(second.lane, base)).ok, true);
    assert.equal(readFileSync(join(base, 'from-first.txt'), 'utf8'), 'first\n');
    assert.equal(readFileSync(join(base, 'from-second.txt'), 'utf8'), 'second\n');
  });

  test('removing a lane leaves the base repo without worktree debris', async () => {
    const base = makeRepo();
    const result = await provisionLane(base, lanePath());
    assert.ok(result.ok);

    await removeLane(base, result.lane.path);
    const list = execFileSync('git', ['worktree', 'list'], { cwd: base, encoding: 'utf8' });
    assert.doesNotMatch(list.replace(/\\/g, '/'), new RegExp(result.lane.path.replace(/\\/g, '/')));
  });

  test('a lane leaves no branch behind in the user repo', async () => {
    const base = makeRepo();
    const result = await provisionLane(base, lanePath());
    assert.ok(result.ok);

    const branches = execFileSync('git', ['branch', '--list'], { cwd: base, encoding: 'utf8' });
    assert.doesNotMatch(branches, /awos/);
  });
});
