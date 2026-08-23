import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import { WebSocket, type RawData } from 'ws';
import type { HarnessConfig } from './config.js';
import { Orchestrator } from './orchestrator.js';
import { HarnessServer } from './server.js';
import type { IssueOpenResult, IssuePreparation } from '@awos/protocol';
import { WORKSPACE_FILE, WORKSPACE_SCHEMA_VERSION } from '@awos/protocol';

const fakeGh = join(import.meta.dirname, 'testing', 'fake-gh.js');
const dataDirs: string[] = [];
const workspaceDirs: string[] = [];
const liveOrchestrators: Orchestrator[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dataDirs.push(dir);
  return dir;
}

function workspaceRoot(): string {
  const root = tempDir('awos-issue-open-workspace-');
  workspaceDirs.push(root);
  return root;
}

function probeScript(root: string, marker: string): string {
  const path = join(root, 'probe.cjs');
  writeFileSync(
    path,
    `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'probe\\n'); console.log('probe');\n`,
    'utf8',
  );
  return path;
}

function controlledProbeScript(root: string, marker: string, release: string): string {
  const path = join(root, 'controlled-probe.cjs');
  writeFileSync(
    path,
    `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'ready'); while(!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); console.log('probe');\n`,
    'utf8',
  );
  return path;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function declare(root: string, declaration: Record<string, unknown> = {}): void {
  mkdirSync(join(root, '.awos'), { recursive: true });
  writeFileSync(
    join(root, WORKSPACE_FILE),
    JSON.stringify({
      version: WORKSPACE_SCHEMA_VERSION,
      name: 'issue-open test workspace',
      repository: { github: 'owner/repo' },
      roles: [{ id: 'maintainer', label: 'Maintainer' }],
      steps: [{ id: 'implement', action: 'Implement the issue', role: 'maintainer', workers: ['claude'] }],
      routes: [{ id: 'enhancement', match: { anyLabels: ['enhancement'] }, step: 'implement' }],
      ...declaration,
    }),
    'utf8',
  );
}

function issueRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 14,
    title: 'Prepare this issue',
    state: 'OPEN',
    labels: [{ name: 'enhancement' }],
    assignees: [],
    updatedAt: '2026-08-24T10:00:00Z',
    url: 'https://github.com/owner/repo/issues/14',
    isPullRequest: false,
    ...overrides,
  };
}

function config(dataDir: string, root: string, marker: string, overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    dataDir,
    claudeBin: process.execPath,
    codexBin: 'awos-missing-codex',
    claudeBinArgs: [probeScript(root, marker)],
    codexBinArgs: [],
    claudeModel: '',
    codexModel: '',
    host: '127.0.0.1',
    port: 0,
    replayMaxChars: 24_000,
    replayMaxToolOutput: 800,
    laneSetup: '',
    laneSetupTimeoutMs: 10_000,
    interruptGraceMs: 100,
    approvalTimeoutMs: 100,
    codexInitTimeoutMs: 100,
    ghBin: process.execPath,
    ghBinArgs: [fakeGh, '--issue-open-test'],
    ghTimeoutMs: 5_000,
    ...overrides,
  };
}

function openOrchestrator(cfg: HarnessConfig): Orchestrator {
  const orchestrator = new Orchestrator(cfg);
  liveOrchestrators.push(orchestrator);
  return orchestrator;
}

async function currentCatalog(orchestrator: Orchestrator, root: string, rows = [issueRow()]): Promise<void> {
  process.env['FAKE_GH_ISSUE_OPEN_ISSUES'] = JSON.stringify(rows);
  const result = await orchestrator.refreshIssueCatalog(root);
  assert.equal(result.error, null);
  assert.equal(result.catalog?.source.freshness, 'current');
}

function preparation(result: IssueOpenResult): IssuePreparation {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.preparation;
}

function calls(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function request(socket: WebSocket, type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const requestId = `${type}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    const onMessage = (raw: RawData) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message['requestId'] !== requestId) return;
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ type, requestId, ...payload }));
    setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`Timed out waiting for ${type}`));
    }, 5_000);
  });
}

afterEach(() => {
  for (const key of [
    'FAKE_GH_ISSUE_OPEN_FAIL',
    'FAKE_GH_ISSUE_OPEN_ISSUES',
    'FAKE_GH_ISSUE_OPEN_CALLS_FILE',
    'FAKE_GH_ISSUE_OPEN_STATE',
    'FAKE_GH_ISSUE_OPEN_TITLE',
    'FAKE_GH_ISSUE_OPEN_BODY',
    'FAKE_GH_ISSUE_OPEN_UPDATED_AT',
    'FAKE_GH_ISSUE_OPEN_VIEW_LABELS',
    'FAKE_GH_ISSUE_OPEN_VIEW_READY_FILE',
    'FAKE_GH_ISSUE_OPEN_VIEW_RELEASE_FILE',
  ]) delete process.env[key];
});

after(async () => {
  await Promise.all(liveOrchestrators.splice(0).map((orchestrator) => orchestrator.stop()));
  for (const path of [...dataDirs, ...workspaceDirs]) rmSync(path, { recursive: true, force: true });
});

test('sequential and concurrent requests share one linked thread', async () => {
  const dataDir = tempDir('awos-issue-open-data-');
  const root = workspaceRoot();
  const marker = join(dataDir, 'probes.log');
  declare(root);
  const orchestrator = openOrchestrator(config(dataDir, root, marker));
  await orchestrator.setWorkspaceRoleSelection(root, 'maintainer');
  const callLog = join(dataDir, 'gh.log');
  process.env['FAKE_GH_ISSUE_OPEN_CALLS_FILE'] = callLog;
  await currentCatalog(orchestrator, root, [issueRow(), issueRow({ number: 15, url: 'https://github.com/owner/repo/issues/15' })]);

  const concurrent = await Promise.all([
    orchestrator.prepareIssue({ cwd: root, number: 15 }),
    orchestrator.prepareIssue({ cwd: root, number: 15 }),
  ]);
  const first = preparation(concurrent[0]!);
  const firstConcurrent = preparation(concurrent[1]!);
  assert.equal(firstConcurrent.threadId, first.threadId);
  const second = preparation(await orchestrator.prepareIssue({ cwd: root, number: 15 }));
  assert.equal(second.mode, 'continued');
  assert.equal(second.threadId, first.threadId);
  assert.deepEqual((await Promise.all([
    orchestrator.prepareIssue({ cwd: root, number: 15 }),
    orchestrator.prepareIssue({ cwd: root, number: 15 }),
  ])).map((result) => preparation(result).threadId), [first.threadId, first.threadId]);
  assert.equal(orchestrator.store.list().length, 1);
  assert.equal(calls(callLog).filter((call) => call === 'issue view').length, 1);
  assert.equal(calls(marker).length, 1);
  assert.equal(orchestrator.store.events(first.threadId).length, 0);
});

test('continuation is local and does not require source or worker availability', async () => {
  const dataDir = tempDir('awos-issue-open-continue-');
  const root = workspaceRoot();
  const marker = join(dataDir, 'probes.log');
  declare(root);
  const cfg = config(dataDir, root, marker);
  const orchestrator = openOrchestrator(cfg);
  await orchestrator.setWorkspaceRoleSelection(root, 'maintainer');
  const callLog = join(dataDir, 'gh.log');
  process.env['FAKE_GH_ISSUE_OPEN_CALLS_FILE'] = callLog;
  await currentCatalog(orchestrator, root);
  const taken = preparation(await orchestrator.prepareIssue({ cwd: root, number: 14 }));
  writeFileSync(callLog, '', 'utf8');
  writeFileSync(marker, '', 'utf8');
  process.env['FAKE_GH_ISSUE_OPEN_FAIL'] = 'offline';
  const continued = preparation(await orchestrator.prepareIssue({ cwd: root, number: 14 }));

  assert.equal(continued.mode, 'continued');
  assert.equal(continued.threadId, taken.threadId);
  assert.deepEqual(calls(callLog), []);
  assert.deepEqual(calls(marker), []);
  assert.equal(continued.workerAvailability, 'not-checked');
});

test('thread and root-cwd continuation survive missing or invalid workspace policy', async () => {
  const dataDir = tempDir('awos-issue-open-local-first-');
  const root = workspaceRoot();
  const marker = join(dataDir, 'probes.log');
  const callLog = join(dataDir, 'gh.log');
  declare(root);
  const orchestrator = openOrchestrator(config(dataDir, root, marker));
  await orchestrator.setWorkspaceRoleSelection(root, 'maintainer');
  process.env['FAKE_GH_ISSUE_OPEN_CALLS_FILE'] = callLog;
  await currentCatalog(orchestrator, root);
  const taken = preparation(await orchestrator.prepareIssue({ cwd: root, number: 14 }));
  writeFileSync(callLog, '', 'utf8');
  writeFileSync(marker, '', 'utf8');

  rmSync(join(root, WORKSPACE_FILE));
  const byThread = preparation(await orchestrator.prepareIssue({ threadId: taken.threadId, number: 14 }));
  assert.equal(byThread.mode, 'continued');
  assert.equal(byThread.threadId, taken.threadId);
  assert.equal(byThread.route, null);

  mkdirSync(join(root, '.awos'), { recursive: true });
  writeFileSync(join(root, WORKSPACE_FILE), '{ invalid', 'utf8');
  const byCwd = preparation(await orchestrator.prepareIssue({ cwd: root, number: 14 }));
  assert.equal(byCwd.mode, 'continued');
  assert.equal(byCwd.threadId, taken.threadId);
  assert.equal(byCwd.route, null);
  assert.deepEqual(byCwd.allowedWorkerProfileIds, []);
  assert.deepEqual(calls(callLog), []);
  assert.deepEqual(calls(marker), []);
});

test('workspace routing changes during an in-flight probe refuse without persistence', async () => {
  const dataDir = tempDir('awos-issue-open-policy-race-');
  const root = workspaceRoot();
  const ready = join(dataDir, 'probe-ready');
  const release = join(dataDir, 'probe-release');
  declare(root);
  const cfg = config(dataDir, root, join(dataDir, 'unused-probes.log'), {
    claudeBinArgs: [controlledProbeScript(root, ready, release)],
  });
  const orchestrator = openOrchestrator(cfg);
  await orchestrator.setWorkspaceRoleSelection(root, 'maintainer');
  await currentCatalog(orchestrator, root);

  const pending = orchestrator.prepareIssue({ cwd: root, number: 14 });
  await waitForFile(ready);
  declare(root, {
    steps: [{ id: 'implement', action: 'Implement the issue', role: 'maintainer', workers: ['codex'] }],
  });
  writeFileSync(release, 'go', 'utf8');
  const result = await pending;

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'route-changed');
  assert.equal(orchestrator.work.list(root).length, 0);
  assert.equal(orchestrator.store.list().length, 0);
});

test('workspace worker policy changes during an in-flight issue fetch refuse without persistence', async () => {
  const dataDir = tempDir('awos-issue-open-fetch-policy-race-');
  const root = workspaceRoot();
  const ready = join(dataDir, 'issue-view-ready');
  const release = join(dataDir, 'issue-view-release');
  declare(root);
  const orchestrator = openOrchestrator(config(dataDir, root, join(dataDir, 'probes.log')));
  await orchestrator.setWorkspaceRoleSelection(root, 'maintainer');
  await currentCatalog(orchestrator, root);

  process.env['FAKE_GH_ISSUE_OPEN_VIEW_READY_FILE'] = ready;
  process.env['FAKE_GH_ISSUE_OPEN_VIEW_RELEASE_FILE'] = release;
  const pending = orchestrator.prepareIssue({ cwd: root, number: 14 });
  await waitForFile(ready);
  declare(root, {
    steps: [{ id: 'implement', action: 'Implement the issue', role: 'maintainer', workers: ['codex'] }],
  });
  writeFileSync(release, 'go', 'utf8');
  const result = await pending;

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'route-changed');
  assert.equal(orchestrator.work.list(root).length, 0);
  assert.equal(orchestrator.store.list().length, 0);
});

test('chooses the newest surviving duplicate with a deterministic id tie break', async () => {
  const dataDir = tempDir('awos-issue-open-duplicates-');
  const root = workspaceRoot();
  declare(root);
  const cfg = config(dataDir, root, join(dataDir, 'probes.log'));
  const first = openOrchestrator(cfg);
  const item = first.work.record({
    workspaceRoot: root,
    ref: { repo: 'owner/repo', number: 14, url: 'https://github.com/owner/repo/issues/14' },
    snapshot: { title: 'Duplicate', body: 'body', state: 'OPEN', labels: ['enhancement'], author: 'author', revision: 'r1' },
  });
  const older = first.store.create({ cwd: root, title: 'older', workItemId: item.id });
  const newer = first.store.create({ cwd: root, title: 'newer', workItemId: item.id });
  first.store.update(newer.id, { title: 'newer touched' });
  const selectedNewest = preparation(await first.prepareIssue({ cwd: root, number: 14 }));
  assert.equal(selectedNewest.threadId, newer.id);

  const tiedAt = Date.now();
  writeFileSync(join(dataDir, 'threads', older.id, 'meta.json'), JSON.stringify({ ...first.store.get(older.id), updatedAt: tiedAt }), 'utf8');
  writeFileSync(join(dataDir, 'threads', newer.id, 'meta.json'), JSON.stringify({ ...first.store.get(newer.id), updatedAt: tiedAt }), 'utf8');
  const revived = openOrchestrator(cfg);
  const selectedTie = preparation(await revived.prepareIssue({ cwd: root, number: 14 }));
  assert.equal(selectedTie.threadId, [older.id, newer.id].sort()[0]);
});

test('detached or deleted threads are not continuation targets', async () => {
  const dataDir = tempDir('awos-issue-open-survival-');
  const root = workspaceRoot();
  const marker = join(dataDir, 'probes.log');
  declare(root);
  const orchestrator = openOrchestrator(config(dataDir, root, marker));
  await orchestrator.setWorkspaceRoleSelection(root, 'maintainer');
  await currentCatalog(orchestrator, root);

  const first = preparation(await orchestrator.prepareIssue({ cwd: root, number: 14 }));
  orchestrator.detachWorkItem(first.threadId);
  const afterDetach = preparation(await orchestrator.prepareIssue({ cwd: root, number: 14 }));
  assert.notEqual(afterDetach.threadId, first.threadId);

  orchestrator.deleteThread(afterDetach.threadId);
  const afterDelete = preparation(await orchestrator.prepareIssue({ cwd: root, number: 14 }));
  assert.notEqual(afterDelete.threadId, afterDetach.threadId);
  assert.equal(orchestrator.store.list().filter((thread) => thread.workItemId !== null).length, 1);
});

test('new Take refuses a missing or cached catalog while Continue succeeds locally', async () => {
  const dataDir = tempDir('awos-issue-open-freshness-');
  const root = workspaceRoot();
  declare(root);
  const cfg = config(dataDir, root, join(dataDir, 'probes.log'));
  const notFetched = openOrchestrator(cfg);
  const missing = await notFetched.prepareIssue({ cwd: root, number: 14 });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, 'catalog-not-current');

  await notFetched.setWorkspaceRoleSelection(root, 'maintainer');
  await currentCatalog(notFetched, root);
  const taken = preparation(await notFetched.prepareIssue({ cwd: root, number: 14 }));
  const continueFromCachedStore = openOrchestrator(cfg);
  const continued = await continueFromCachedStore.prepareIssue({ cwd: root, number: 14 });
  assert.equal(continued.ok, true);
  assert.equal(preparation(continued).threadId, taken.threadId);
  notFetched.deleteThread(taken.threadId);
  const cachedTake = openOrchestrator(cfg);
  const cachedResult = await cachedTake.prepareIssue({ cwd: root, number: 14 });
  assert.equal(cachedResult.ok, false);
  if (!cachedResult.ok) assert.equal(cachedResult.code, 'catalog-not-current');
});

test('route, role, and worker refusals are typed and do not create threads', async () => {
  const cases: Array<{ name: string; declaration?: Record<string, unknown>; setup?: (orchestrator: Orchestrator, root: string) => void; config?: Partial<HarnessConfig>; code: string }> = [
    { name: 'unrouted', declaration: { routes: [] }, code: 'route-unrouted' },
    {
      name: 'conflict',
      declaration: {
        routes: [
          { id: 'one', match: { anyLabels: ['enhancement'] }, step: 'implement' },
          { id: 'two', match: { anyLabels: ['enhancement'] }, step: 'implement' },
        ],
      },
      code: 'route-conflict',
    },
    { name: 'role-required', setup: undefined, code: 'role-required' },
    {
      name: 'role-mismatch',
      declaration: { roles: [{ id: 'reviewer', label: 'Reviewer' }], steps: [{ id: 'implement', action: 'Implement', role: 'reviewer', workers: ['claude'] }] },
      setup: (orchestrator, root) => { orchestrator.roleSelections.write(root, 'old-role'); },
      code: 'role-mismatch',
    },
    { name: 'worker-unavailable', config: { claudeBin: 'awos-no-claude' }, setup: (orchestrator, root) => { orchestrator.roleSelections.write(root, 'maintainer'); }, code: 'workers-unavailable' },
  ];

  for (const scenario of cases) {
    const dataDir = tempDir(`awos-issue-open-${scenario.name}-`);
    const root = workspaceRoot();
    declare(root, scenario.declaration);
    const orchestrator = openOrchestrator(config(dataDir, root, join(dataDir, 'probes.log'), scenario.config));
    scenario.setup?.(orchestrator, root);
    if (scenario.name === 'role-required') await currentCatalog(orchestrator, root);
    else await currentCatalog(orchestrator, root);
    if (scenario.name === 'role-mismatch') {
      // Rewrite the declaration so the persisted role is a valid but different role.
      declare(root, { roles: [{ id: 'maintainer', label: 'Maintainer' }, { id: 'reviewer', label: 'Reviewer' }] });
      orchestrator.roleSelections.write(root, 'reviewer');
    }
    const result = await orchestrator.prepareIssue({ cwd: root, number: 14 });
    assert.equal(result.ok, false, scenario.name);
    if (!result.ok) assert.equal(result.code, scenario.code, scenario.name);
    assert.equal(orchestrator.store.list().length, 0, scenario.name);
  }
});

test('invalid routing, closed source, and changed labels refuse before persistence', async () => {
  const dataDir = tempDir('awos-issue-open-recheck-');
  const root = workspaceRoot();
  declare(root);
  const orchestrator = openOrchestrator(config(dataDir, root, join(dataDir, 'probes.log')));
  await orchestrator.setWorkspaceRoleSelection(root, 'maintainer');
  await currentCatalog(orchestrator, root);

  process.env['FAKE_GH_ISSUE_OPEN_STATE'] = 'CLOSED';
  const closed = await orchestrator.prepareIssue({ cwd: root, number: 14 });
  assert.equal(closed.ok, false);
  if (!closed.ok) assert.equal(closed.code, 'issue-not-open');
  delete process.env['FAKE_GH_ISSUE_OPEN_STATE'];

  process.env['FAKE_GH_ISSUE_OPEN_VIEW_LABELS'] = JSON.stringify(['other']);
  const changed = await orchestrator.prepareIssue({ cwd: root, number: 14 });
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.equal(changed.code, 'route-unrouted');
  assert.equal(orchestrator.store.list().length, 0);

  declare(root, { routes: [{ id: 'bad', match: { anyLabels: ['enhancement'] }, step: 'missing-step' }] });
  const invalid = await orchestrator.prepareIssue({ cwd: root, number: 14 });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.code, 'route-invalid');
});

test('source and thread persistence failures leave no linked or new thread', async () => {
  const sourceData = tempDir('awos-issue-open-source-error-');
  const sourceRoot = workspaceRoot();
  declare(sourceRoot);
  const sourceOrchestrator = openOrchestrator(config(sourceData, sourceRoot, join(sourceData, 'probes.log')));
  await sourceOrchestrator.setWorkspaceRoleSelection(sourceRoot, 'maintainer');
  await currentCatalog(sourceOrchestrator, sourceRoot);
  process.env['FAKE_GH_ISSUE_OPEN_FAIL'] = 'offline';
  const sourceFailure = await sourceOrchestrator.prepareIssue({ cwd: sourceRoot, number: 14 });
  assert.equal(sourceFailure.ok, false);
  if (!sourceFailure.ok) assert.equal(sourceFailure.code, 'source-fetch-failed');
  assert.equal(sourceOrchestrator.store.list().length, 0);
  assert.equal(sourceOrchestrator.work.list(sourceRoot).length, 0);
  delete process.env['FAKE_GH_ISSUE_OPEN_FAIL'];

  const threadData = tempDir('awos-issue-open-thread-error-');
  const threadRoot = workspaceRoot();
  declare(threadRoot);
  const threadOrchestrator = openOrchestrator(config(threadData, threadRoot, join(threadData, 'probes.log')));
  await threadOrchestrator.setWorkspaceRoleSelection(threadRoot, 'maintainer');
  await currentCatalog(threadOrchestrator, threadRoot);
  const store = threadOrchestrator.store as unknown as { create: typeof threadOrchestrator.store.create };
  const original = store.create;
  store.create = (() => { throw new Error('disk full'); }) as typeof store.create;
  const threadFailure = await threadOrchestrator.prepareIssue({ cwd: threadRoot, number: 14 });
  store.create = original;
  assert.equal(threadFailure.ok, false);
  if (!threadFailure.ok) assert.equal(threadFailure.code, 'persistence-failed');
  assert.equal(threadOrchestrator.store.list().length, 0);
  assert.equal(threadOrchestrator.work.list(threadRoot).length, 1, 'the reusable cache may survive a thread write failure');
});

test('RPC accepts cwd and thread addresses and returns the typed preparation', async () => {
  const dataDir = tempDir('awos-issue-open-rpc-');
  const root = workspaceRoot();
  declare(root);
  const cfg = config(dataDir, root, join(dataDir, 'probes.log'));
  const orchestrator = openOrchestrator(cfg);
  await orchestrator.setWorkspaceRoleSelection(root, 'maintainer');
  await currentCatalog(orchestrator, root);
  const server = new HarnessServer(cfg, orchestrator);
  const port = await server.listen();
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  await request(socket, 'hello', { token: server.token });
  const byCwd = await request(socket, 'issue.open', { cwd: root, number: 14 });
  const firstResult = byCwd['result'] as IssueOpenResult;
  assert.equal(firstResult.ok, true);
  const threadId = preparation(firstResult).threadId;
  const byThread = await request(socket, 'issue.open', { threadId, number: 14 });
  const secondResult = byThread['result'] as IssueOpenResult;
  assert.equal(secondResult.ok, true);
  assert.equal(preparation(secondResult).mode, 'continued');
  assert.equal(preparation(secondResult).threadId, threadId);
  socket.close();
  await server.close();
});
