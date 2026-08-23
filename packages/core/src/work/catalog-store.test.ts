import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, test } from 'node:test';
import { CatalogStore } from './catalog-store.js';
import { OPEN_ISSUE_LIMIT, type GitHubOptions } from './github.js';

const dirs: string[] = [];
const fakeGh = join(import.meta.dirname, '..', 'testing', 'fake-gh.js');
const options: GitHubOptions = {
  bin: process.execPath,
  binArgs: [fakeGh, '--catalog-test'],
  timeoutMs: 10_000,
};
const scope = { workspaceRoot: 'C:/workspace-a', repository: 'owner/repo' };

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'awos-catalog-'));
  dirs.push(dir);
  return dir;
}

function calls(path: string): number {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

function catalogPath(dir: string, target: { workspaceRoot: string; repository: string }): string {
  const key = createHash('sha256').update(`${target.workspaceRoot}\0${target.repository}`).digest('hex');
  return join(dir, 'issue-catalog', `${key}.json`);
}

function persistedIssue(number: number) {
  return {
    number,
    url: `https://github.com/owner/repo/issues/${number}`,
    title: `Issue ${number}`,
    state: 'OPEN',
    labels: [],
    assignees: [],
    updatedAt: '2026-08-23T10:00:00Z',
  };
}

afterEach(() => {
  for (const key of ['FAKE_GH_CATALOG_FAIL', 'FAKE_GH_CATALOG_ISSUES', 'FAKE_GH_CALLS_FILE']) {
    delete process.env[key];
  }
});

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('CatalogStore', () => {
  test('explicit refresh stores a successful snapshot and changed data replaces it', async () => {
    const store = new CatalogStore(tempDir());
    const first = await store.refresh(scope, options);
    assert.equal(first.freshness, 'current');
    assert.equal(first.issues[0]?.title, 'Execute one GitHub issue as a work item');

    process.env['FAKE_GH_CATALOG_ISSUES'] = JSON.stringify([
      {
        number: 14,
        url: 'https://github.com/owner/repo/issues/14',
        title: 'Changed',
        state: 'OPEN',
        labels: [],
        assignees: [],
        updatedAt: '2026-08-24T10:00:00Z',
      },
    ]);
    const changed = await store.refresh(scope, options);
    assert.equal(changed.freshness, 'current');
    assert.equal(changed.issues[0]?.title, 'Changed');
  });

  test('a failed refresh preserves prior data but makes it cached and actionable', async () => {
    const store = new CatalogStore(tempDir());
    const before = await store.refresh(scope, options);
    process.env['FAKE_GH_CATALOG_FAIL'] = 'offline';

    const failed = await store.refresh(scope, options);

    assert.deepEqual(failed.issues, before.issues);
    assert.equal(failed.freshness, 'cached');
    assert.equal(failed.error?.kind, 'offline');
  });

  test('a failed first refresh is not an empty current catalog', async () => {
    const store = new CatalogStore(tempDir());
    process.env['FAKE_GH_CATALOG_FAIL'] = 'auth';

    const failed = await store.refresh(scope, options);

    assert.equal(failed.freshness, 'not-fetched');
    assert.deepEqual(failed.issues, []);
    assert.equal(failed.error?.kind, 'auth');
  });

  test('restart reads cached data without invoking gh', async () => {
    const dir = tempDir();
    const callLog = join(dir, 'calls.log');
    process.env['FAKE_GH_CALLS_FILE'] = callLog;
    await new CatalogStore(dir).refresh(scope, options);
    const afterRefresh = calls(callLog);

    const revived = new CatalogStore(dir).read(scope);

    assert.equal(revived.freshness, 'cached');
    assert.equal(revived.successfulAt !== null, true);
    assert.equal(calls(callLog), afterRefresh);
  });

  test('workspace and repository are isolated and malformed data is ignored safely', async () => {
    const dir = tempDir();
    const otherScope = { workspaceRoot: 'C:/workspace-b', repository: 'owner/repo' };
    const secondRepo = { workspaceRoot: scope.workspaceRoot, repository: 'other/repo' };
    const store = new CatalogStore(dir);
    await store.refresh(scope, options);
    await store.refresh(otherScope, options);

    assert.equal(store.read(secondRepo).freshness, 'not-fetched');
    writeFileSync(catalogPath(dir, secondRepo), '{broken', 'utf8');
    assert.equal(new CatalogStore(dir).read(secondRepo).freshness, 'not-fetched');
  });

  test('rejects structurally malformed persisted issue fields', () => {
    const dir = tempDir();
    new CatalogStore(dir);
    const invalidIssues = [
      { number: 0, url: 'u', title: 't', state: 'OPEN', labels: [], assignees: [], updatedAt: 'd' },
      { number: 1, url: 'u', title: 't', state: 'OPEN', labels: [7], assignees: [], updatedAt: 'd' },
      { number: 1, url: 'u', title: 't', state: 'OPEN', labels: [], assignees: [null], updatedAt: 'd' },
      { number: 1, url: 7, title: 't', state: 'OPEN', labels: [], assignees: [], updatedAt: 'd' },
    ];

    invalidIssues.forEach((issue, index) => {
      const target = { workspaceRoot: scope.workspaceRoot, repository: `invalid/repo-${index}` };
      writeFileSync(catalogPath(dir, target), JSON.stringify({
        ...target,
        complete: true,
        successfulAt: Date.now(),
        issues: [issue],
      }), 'utf8');
      assert.equal(new CatalogStore(dir).read(target).freshness, 'not-fetched');
    });
  });

  test('rejects oversized snapshots and a complete claim at the fixed bound', () => {
    const dir = tempDir();
    new CatalogStore(dir);
    const cases = [
      { repository: 'invalid/oversized', complete: false, issues: Array.from({ length: OPEN_ISSUE_LIMIT + 1 }, (_, i) => persistedIssue(i + 1)) },
      { repository: 'invalid/false-complete', complete: true, issues: Array.from({ length: OPEN_ISSUE_LIMIT }, (_, i) => persistedIssue(i + 1)) },
    ];

    for (const candidate of cases) {
      const target = { workspaceRoot: scope.workspaceRoot, repository: candidate.repository };
      writeFileSync(catalogPath(dir, target), JSON.stringify({
        ...target,
        complete: candidate.complete,
        successfulAt: Date.now(),
        issues: candidate.issues,
      }), 'utf8');
      assert.equal(new CatalogStore(dir).read(target).freshness, 'not-fetched');
    }

    const conservative = { workspaceRoot: scope.workspaceRoot, repository: 'valid/conservative' };
    writeFileSync(catalogPath(dir, conservative), JSON.stringify({
      ...conservative,
      complete: false,
      successfulAt: Date.now(),
      issues: [persistedIssue(1)],
    }), 'utf8');
    assert.equal(new CatalogStore(dir).read(conservative).freshness, 'cached');
  });

  test('a persistence failure preserves the prior snapshot as cached', async () => {
    const dir = tempDir();
    let failWrites = false;
    const store = new CatalogStore(dir, {
      writeFile: (path, content) => {
        if (failWrites) throw new Error('injected disk full');
        writeFileSync(path, content, 'utf8');
      },
    });
    const current = await store.refresh(scope, options);
    failWrites = true;

    const failed = await store.refresh(scope, options);

    assert.equal(current.freshness, 'current');
    assert.equal(failed.freshness, 'cached');
    assert.deepEqual(failed.issues, current.issues);
    assert.equal(failed.successfulAt, current.successfulAt);
    assert.equal(failed.error?.kind, 'unknown');
    assert.equal(failed.error?.retryable, true);
    assert.match(failed.error?.message ?? '', /AWOS_DATA_DIR/);
  });

  test('a first-refresh persistence failure returns not-fetched without debris', async () => {
    const dir = tempDir();
    const store = new CatalogStore(dir, {
      writeFile: () => { throw new Error('injected read-only data directory'); },
    });

    const failed = await store.refresh(scope, options);

    assert.equal(failed.freshness, 'not-fetched');
    assert.deepEqual(failed.issues, []);
    assert.equal(failed.error?.kind, 'unknown');
    assert.match(failed.error?.message ?? '', /writable/);
    assert.deepEqual(readdirSync(join(dir, 'issue-catalog')), []);
  });

  test('recovers a validated backup left by an interrupted replacement', async () => {
    const dir = tempDir();
    await new CatalogStore(dir).refresh(scope, options);
    const path = catalogPath(dir, scope);
    renameSync(path, `${path}.bak`);

    const recovered = new CatalogStore(dir).read(scope);

    assert.equal(recovered.freshness, 'cached');
    assert.equal(recovered.issues[0]?.number, 14);
    assert.equal(existsSync(path), true, 'the backup was restored to its primary path');
  });

  test('a fixed source limit is available to tests and is not silently treated as exhaustive', () => {
    assert.equal(OPEN_ISSUE_LIMIT, 50);
  });
});
