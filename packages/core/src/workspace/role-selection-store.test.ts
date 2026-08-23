import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { WebSocket, type RawData } from 'ws';
import type { HarnessConfig } from '../config.js';
import { Orchestrator } from '../orchestrator.js';
import { HarnessServer } from '../server.js';
import { WorkspaceRoleSelectionStore, workspaceRoleSelectionPath } from './role-selection-store.js';

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function config(dataDir: string): HarnessConfig {
  return {
    dataDir,
    claudeBin: 'unused',
    codexBin: 'unused',
    claudeBinArgs: [],
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
    ghBin: 'unused',
    ghBinArgs: [],
    ghTimeoutMs: 100,
  };
}

function workspace(root: string, roles: unknown[]): string {
  mkdirSync(join(root, '.awos'), { recursive: true });
  const raw = JSON.stringify({ version: 2, name: 'test', roles }, null, 2);
  writeFileSync(join(root, '.awos', 'workspace.json'), raw, 'utf8');
  return raw;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('role preference persists by workspace, survives restart, and ignores malformed data', () => {
  const dataDir = tempDir('awos-role-store-');
  const rootA = 'C:/workspace-a';
  const rootB = 'C:/workspace-b';
  const store = new WorkspaceRoleSelectionStore(dataDir);

  store.write(rootA, 'maintainer');
  store.write(rootB, 'reviewer');
  assert.equal(new WorkspaceRoleSelectionStore(dataDir).read(rootA), 'maintainer');
  assert.equal(new WorkspaceRoleSelectionStore(dataDir).read(rootB), 'reviewer');

  const malformed = workspaceRoleSelectionPath(join(dataDir, 'workspace-role-selections'), 'C:/malformed');
  writeFileSync(malformed, '{broken', 'utf8');
  assert.equal(store.read('C:/malformed'), null);

  const wrongShape = workspaceRoleSelectionPath(join(dataDir, 'workspace-role-selections'), 'C:/wrong-shape');
  writeFileSync(wrongShape, JSON.stringify({ workspaceRoot: 'C:/wrong-shape', roleId: 42 }), 'utf8');
  assert.equal(store.read('C:/wrong-shape'), null);
});

test('projection exposes all four states and refuses unknown ids without overwriting', () => {
  const dataDir = tempDir('awos-role-projection-');
  const root = tempDir('awos-role-workspace-');
  const shared = workspace(root, [{ id: 'maintainer', label: 'Maintainer' }]);
  const orch = new Orchestrator(config(dataDir));

  assert.deepEqual(orch.workspaceRoleSelection(root), { status: 'needs-selection', roleId: null, role: null });
  const selected = orch.setWorkspaceRoleSelection(root, 'maintainer');
  assert.deepEqual(selected, {
    status: 'selected',
    roleId: 'maintainer',
    role: { id: 'maintainer', label: 'Maintainer' },
  });
  assert.throws(() => orch.setWorkspaceRoleSelection(root, 'unknown'), /Unknown workspace role/);
  assert.equal(orch.workspaceRoleSelection(root).roleId, 'maintainer');
  assert.equal(readFileSync(join(root, '.awos', 'workspace.json'), 'utf8'), shared);

  const revived = new Orchestrator(config(dataDir));
  assert.equal(revived.workspaceRoleSelection(root).roleId, 'maintainer');
  assert.deepEqual(revived.setWorkspaceRoleSelection(root, null), {
    status: 'needs-selection',
    roleId: null,
    role: null,
  });
  orch.setWorkspaceRoleSelection(root, 'maintainer');

  workspace(root, [{ id: 'reviewer', label: 'Reviewer' }]);
  assert.deepEqual(orch.workspaceRoleSelection(root), { status: 'stale', roleId: 'maintainer', role: null });
  assert.deepEqual(orch.setWorkspaceRoleSelection(root, 'reviewer'), {
    status: 'selected',
    roleId: 'reviewer',
    role: { id: 'reviewer', label: 'Reviewer' },
  });

  const noRoles = tempDir('awos-role-no-roles-');
  workspace(noRoles, []);
  assert.deepEqual(orch.workspaceRoleSelection(noRoles), { status: 'unconfigured', roleId: null, role: null });
});

test('role get/set RPC works by cwd and by thread', async () => {
  const dataDir = tempDir('awos-role-rpc-data-');
  const root = tempDir('awos-role-rpc-workspace-');
  workspace(root, [{ id: 'maintainer', label: 'Maintainer' }]);
  const cfg = config(dataDir);
  const orch = new Orchestrator(cfg);
  const server = new HarnessServer(cfg, orch);
  const port = await server.listen();
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });

  try {
    await request(socket, 'hello', { token: server.token });
    const before = await request(socket, 'workspace.role.get', { cwd: root });
    assert.equal((before['selection'] as { status: string }).status, 'needs-selection');
    const thread = orch.createThread({ cwd: root });
    const set = await request(socket, 'workspace.role.set', { threadId: thread.id, roleId: 'maintainer' });
    assert.equal((set['selection'] as { status: string }).status, 'selected');
    const byThread = await request(socket, 'workspace.role.get', { threadId: thread.id });
    assert.equal((byThread['selection'] as { roleId: string }).roleId, 'maintainer');
    const byCwd = await request(socket, 'workspace.role.get', { cwd: root });
    assert.equal((byCwd['selection'] as { roleId: string }).roleId, 'maintainer');
  } finally {
    socket.close();
    await server.close();
  }
});

function request(
  socket: WebSocket,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const requestId = `${type}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    const onMessage = (raw: RawData) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message['requestId'] !== requestId) return;
      socket.off('message', onMessage);
      if (message['type'] === 'error') reject(new Error(String(message['message'])));
      else resolve(message);
    };
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ type, requestId, ...payload }));
    setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`timed out waiting for ${type}`));
    }, 5_000);
  });
}
