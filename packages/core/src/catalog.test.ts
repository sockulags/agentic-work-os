import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, type RawData } from 'ws';
import { WORKSPACE_FILE, WORKSPACE_SCHEMA_VERSION } from '@awos/protocol';
import type { HarnessConfig } from './config.js';
import { Orchestrator } from './orchestrator.js';
import { HarnessServer } from './server.js';

const dirs: string[] = [];
const fakeGh = join(import.meta.dirname, 'testing', 'fake-gh.js');
const fakeClaude = join(import.meta.dirname, 'testing', 'fake-claude.js');
const workspaceRoot = resolve(import.meta.dirname, '../../..');

function config(dataDir: string, overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    dataDir,
    claudeBin: process.execPath,
    codexBin: 'unused',
    claudeBinArgs: [fakeClaude, '--slow'],
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
    ghBinArgs: [fakeGh, '--catalog-orchestrator-test'],
    ghTimeoutMs: 10_000,
    ...overrides,
  };
}

function deterministicProbe(root: string): string {
  const path = join(root, 'overview-worker-probe.cjs');
  writeFileSync(path, "process.stdout.write('fake-worker 1.0\\n');\n", 'utf8');
  return path;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'awos-catalog-orch-'));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function request(socket: WebSocket, type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
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
      reject(new Error(`timed out waiting for ${type}`));
    }, 5_000);
  });
}

test('catalog overlays linked threads and presents an unfinished run as interrupted after restart', async () => {
  const dataDir = tempDir();
  const cwd = workspaceRoot;
  const orch = new Orchestrator(config(dataDir));
  const item = orch.work.record({
    workspaceRoot: cwd,
    ref: { repo: 'sockulags/agentic-work-os', number: 14, url: 'https://github.com/sockulags/agentic-work-os/issues/14' },
    snapshot: {
      title: 'Issue', body: '', state: 'OPEN', labels: [], author: '', revision: 'r1',
    },
  });
  const thread = orch.createThread({ cwd, title: 'Linked thread' });
  orch.store.update(thread.id, { workItemId: item.id });
  orch.store.append(thread.id, 'claude', {
    kind: 'run.started',
    runId: 'historical-run',
    workItemId: item.id,
    source: 'sockulags/agentic-work-os#14',
    revision: 'r1',
    context: 'context',
    instruction: 'work',
  });
  await orch.catalog.refresh(
    { workspaceRoot: cwd, repository: 'sockulags/agentic-work-os' },
    { bin: process.execPath, binArgs: [fakeGh, '--catalog-orchestrator-test'], timeoutMs: 10_000 },
  );

  const result = orch.getIssueCatalog(cwd);

  assert.equal(result.error, null);
  const overlay = result.catalog?.overlay['sockulags/agentic-work-os#14'];
  assert.equal(overlay?.linkedThreads[0]?.threadId, thread.id);
  assert.equal(overlay?.linkedThreads[0]?.title, 'Linked thread');
  assert.equal(overlay?.runs[0]?.runId, 'historical-run');
  assert.equal(overlay?.runs[0]?.live, false);
  assert.equal(overlay?.runs[0]?.state, 'interrupted');
  assert.equal(overlay?.runs[0]?.interruptedByRestart, true);
  assert.equal(
    orch.store.events(thread.id).filter((event) => event.kind === 'run.completed').length,
    0,
    'restart projection does not append a synthetic completion',
  );
});

test('keeps linked overlay without a source snapshot and matches live state by exact run id', async () => {
  const dataDir = tempDir();
  const cwd = workspaceRoot;
  const orch = new Orchestrator(config(dataDir));
  await orch.start();
  try {
    const item = orch.work.record({
      workspaceRoot: cwd,
      ref: { repo: 'sockulags/agentic-work-os', number: 47, url: 'https://github.com/sockulags/agentic-work-os/issues/47' },
      snapshot: { title: 'Catalog', body: '', state: 'OPEN', labels: [], author: '', revision: 'r1' },
    });
    const thread = orch.createThread({ cwd, title: 'Catalog work' });
    orch.store.update(thread.id, { workItemId: item.id });
    orch.store.append(thread.id, 'claude', {
      kind: 'run.started',
      runId: 'unfinished-old-run',
      workItemId: item.id,
      source: 'sockulags/agentic-work-os#47',
      revision: 'r1',
      context: 'context',
      instruction: 'old work',
    });

    const ordinaryTurn = orch.send(thread.id, 'claude', 'an unrelated ordinary turn');
    for (let attempts = 0; attempts < 100 && orch.state(thread.id).busy.length === 0; attempts += 1) {
      await delay(5);
    }

    const result = orch.getIssueCatalog(cwd);
    const overlay = result.catalog?.overlay['sockulags/agentic-work-os#47'];
    assert.equal(result.catalog?.source.freshness, 'not-fetched');
    assert.equal(overlay?.linkedThreads[0]?.threadId, thread.id);
    assert.equal(overlay?.runs[0]?.runId, 'unfinished-old-run');
    assert.equal(overlay?.runs[0]?.live, false);
    assert.equal(overlay?.runs[0]?.state, 'interrupted');
    assert.equal(overlay?.runs[0]?.interruptedByRestart, true);
    assert.equal(orch.state(thread.id).runStates[0]?.state, 'interrupted');
    assert.equal(orch.state(thread.id).runStates[0]?.interruptedByRestart, true);
    assert.equal(orch.state(thread.id).busyWith, 'claude', 'the unrelated turn was actually busy');
    await ordinaryTurn;
  } finally {
    await orch.stop();
  }
});

test('catalog RPC separates local get from explicit refresh', async () => {
  const cfg = config(tempDir());
  const orch = new Orchestrator(cfg);
  const server = new HarnessServer(cfg, orch);
  const port = await server.listen();
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  await request(socket, 'hello', { token: server.token });
  const before = await request(socket, 'catalog.get', { cwd: workspaceRoot });
  const refreshed = await request(socket, 'catalog.refresh', { cwd: workspaceRoot });
  socket.close();
  await server.close();

  const beforeCatalog = before['catalog'] as { source: { freshness: string } };
  const refreshedCatalog = refreshed['catalog'] as { source: { freshness: string } };
  assert.equal(beforeCatalog.source.freshness, 'not-fetched');
  assert.equal(refreshedCatalog.source.freshness, 'current');
});

test('project overview RPC returns the core-owned route and availability projection', async () => {
  const dataDir = tempDir();
  const cwd = tempDir();
  mkdirSync(join(cwd, '.awos'), { recursive: true });
  writeFileSync(
    join(cwd, WORKSPACE_FILE),
    JSON.stringify({
      version: WORKSPACE_SCHEMA_VERSION,
      name: 'Overview test workspace',
      repository: { github: 'owner/repo' },
      roles: [{ id: 'implementer', label: 'Implementer' }],
      steps: [{ id: 'implement', action: 'Implement issue', role: 'implementer', workers: ['claude'] }],
      routes: [{ id: 'enhancement', match: { anyLabels: ['enhancement'] }, step: 'implement' }],
    }),
    'utf8',
  );

  const cfg = config(dataDir, {
    claudeBin: process.execPath,
    claudeBinArgs: [deterministicProbe(cwd)],
  });
  const orch = new Orchestrator(cfg);
  await orch.setWorkspaceRoleSelection(cwd, 'implementer');
  const refreshed = await orch.refreshIssueCatalog(cwd);
  assert.equal(refreshed.error, null);

  const server = new HarnessServer(cfg, orch);
  const port = await server.listen();
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });

  try {
    await request(socket, 'hello', { token: server.token });
    const response = await request(socket, 'project.overview.get', { cwd });
    assert.equal(response['type'], 'project.overview');
    const overview = response['overview'] as { items: Array<{ action: string; group: string; reasonCode: string }> };
    assert.equal(overview.items[0]?.action, 'take');
    assert.equal(overview.items[0]?.group, 'available');
    assert.equal(overview.items[0]?.reasonCode, 'available');
  } finally {
    socket.close();
    await server.close();
  }
});
