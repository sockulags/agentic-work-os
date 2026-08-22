import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { IssueRef, IssueSnapshot } from '@awos/protocol';
import { WorkItemStore } from './store.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'awos-work-'));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const ref: IssueRef = {
  repo: 'sockulags/agentic-work-os',
  number: 14,
  url: 'https://github.com/sockulags/agentic-work-os/issues/14',
};

function snapshot(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    title: 'Execute one GitHub issue as a work item',
    body: 'The body.',
    state: 'OPEN',
    labels: ['enhancement'],
    author: 'sockulags',
    revision: '2026-08-22T19:26:05Z',
    ...overrides,
  };
}

describe('WorkItemStore', () => {
  test('records an issue under the workspace that attached it', () => {
    const dir = tempDir();
    const store = new WorkItemStore(dir);

    const item = store.record({ workspaceRoot: '/repo', ref, snapshot: snapshot() });

    assert.equal(item.workspaceRoot, '/repo');
    assert.equal(item.source.number, 14);
    assert.deepEqual(store.list('/repo'), [item]);
    assert.deepEqual(store.list('/somewhere-else'), []);
  });

  test('asking twice about one issue keeps one record', () => {
    const store = new WorkItemStore(tempDir());

    const first = store.record({ workspaceRoot: '/repo', ref, snapshot: snapshot() });
    const second = store.record({ workspaceRoot: '/repo', ref, snapshot: snapshot() });

    assert.equal(second.id, first.id, 'identity is the workspace plus the issue');
    assert.equal(store.list('/repo').length, 1);
  });

  test('the same issue in two workspaces is two records', () => {
    const store = new WorkItemStore(tempDir());

    const a = store.record({ workspaceRoot: '/repo-a', ref, snapshot: snapshot() });
    const b = store.record({ workspaceRoot: '/repo-b', ref, snapshot: snapshot() });

    assert.notEqual(a.id, b.id);
  });

  describe('refresh', () => {
    test('an unchanged source moves the check time but not the content age', () => {
      const store = new WorkItemStore(tempDir());
      const first = store.record({ workspaceRoot: '/repo', ref, snapshot: snapshot() });

      const again = store.record({ workspaceRoot: '/repo', ref, snapshot: snapshot() });

      assert.equal(again.fetchedAt, first.fetchedAt, 'what we are reading is no newer');
      assert.ok(again.lastRefreshedAt >= first.lastRefreshedAt, 'but it was checked again');
    });

    test('a changed source is new content, and says so', () => {
      const store = new WorkItemStore(tempDir());
      const first = store.record({ workspaceRoot: '/repo', ref, snapshot: snapshot() });

      const changed = store.record({
        workspaceRoot: '/repo',
        ref,
        snapshot: snapshot({ revision: '2026-09-01T08:00:00Z', title: 'Rewritten' }),
      });

      assert.equal(changed.id, first.id);
      assert.equal(changed.snapshot.title, 'Rewritten');
      assert.ok(changed.fetchedAt >= first.fetchedAt);
      assert.notEqual(changed.snapshot.revision, first.snapshot.revision);
    });
  });

  test('survives a restart, because the file is the state', () => {
    const dir = tempDir();
    const item = new WorkItemStore(dir).record({ workspaceRoot: '/repo', ref, snapshot: snapshot() });

    const revived = new WorkItemStore(dir);

    assert.deepEqual(revived.get(item.id), item);
  });

  test('one unreadable item does not cost the others', () => {
    const dir = tempDir();
    const store = new WorkItemStore(dir);
    const good = store.record({ workspaceRoot: '/repo', ref, snapshot: snapshot() });
    writeFileSync(join(dir, 'work-items', 'broken.json'), '{ not json', 'utf8');

    const revived = new WorkItemStore(dir);

    assert.deepEqual(revived.get(good.id), good);
    assert.equal(revived.list('/repo').length, 1);
  });

  test('removing an item removes its file', () => {
    const dir = tempDir();
    const store = new WorkItemStore(dir);
    const item = store.record({ workspaceRoot: '/repo', ref, snapshot: snapshot() });

    store.remove(item.id);

    assert.equal(store.get(item.id), undefined);
    assert.deepEqual(readdirSync(join(dir, 'work-items')), []);
  });
});
