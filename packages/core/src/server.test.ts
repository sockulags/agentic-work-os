import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket, type RawData } from 'ws';
import type { AgentAvailability, AgentCapabilities, ModelTarget, WorkerDiagnostic } from '@awos/protocol';
import type { HarnessConfig } from './config.js';
import { Orchestrator } from './orchestrator.js';
import { HarnessServer, validateWorkingDirectory } from './server.js';
import type { AdapterFactory, WorkerProfileDefinition, WorkerRegistries } from './adapters/registry.js';
import type { WorkerAdapter } from './adapters/agent.js';

const dataDirs: string[] = [];
const sockets: WebSocket[] = [];
const servers: HarnessServer[] = [];
const orchestrators: Orchestrator[] = [];

/**
 * Teardown outside the test body, because the body is what a crash takes with it.
 *
 * An unguarded frame throws out of the socket listener, which abandons the running test
 * mid-await: a `finally` there would never run, and the still-listening server would hold
 * the runner open long past the reported failure.
 */
after(async () => {
  for (const socket of sockets) socket.terminate();
  for (const server of servers) await server.close();
  for (const orchestrator of orchestrators) await orchestrator.stop();
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
});

test('validates that a working directory exists and is a directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'awos-cwd-'));
  const file = join(root, 'file.txt');
  writeFileSync(file, 'not a directory');

  try {
    await validateWorkingDirectory(root);
    await assert.rejects(
      validateWorkingDirectory(file),
      new Error(`Working directory does not exist or is not a directory: ${file}`),
    );

    const missing = join(root, 'missing');
    await assert.rejects(
      validateWorkingDirectory(missing),
      new Error(`Working directory does not exist or is not a directory: ${missing}`),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

function customClaudeRegistry(): WorkerRegistries {
  const target: ModelTarget = {
    id: 'shared-claude-target', provider: 'claude', model: 'shared-model', endpoint: null, authProfile: null,
  };
  const capabilities: AgentCapabilities = {
    streamingToolOutput: false, streamingText: false, reasoning: false, plans: false,
    turnDiff: false, approvals: false, resumableSessions: false,
  };
  const factory: AdapterFactory = {
    id: 'shared-claude-adapter',
    capabilities,
    supports: (candidate) => candidate.provider === 'claude',
    create: () => ({ id: 'shared-claude-adapter' } as WorkerAdapter),
  };
  const profile = (id: string, label: string): WorkerProfileDefinition => ({
    id,
    agent: 'claude',
    label,
    adapterId: factory.id,
    targetId: target.id,
    policy: { permissionModes: ['default'], nativeTurnDiff: false },
    probe: async () => ({ available: true, detail: `${label} ready` }),
  });
  return {
    profiles: [profile('claude-build', 'Claude Build'), profile('claude-review', 'Claude Review')],
    targets: [{ target, resolve: () => target }],
    factories: [factory],
  };
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

/** Deadlined, so a daemon that died instead of answering fails the test rather than hanging it. */
function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the socket to close')), 5_000);
    socket.once('close', (code: number) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function response(
  socket: WebSocket,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const requestId = `${type}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`timed out waiting for ${type}`));
    }, 5_000);
    const onMessage = (raw: RawData): void => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message['requestId'] !== requestId) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ type, requestId, ...payload }));
  });
}

/**
 * A frame nobody validated must cost its own socket and nothing else.
 *
 * `null` is the case worth naming: it is valid JSON, so the parse succeeds, and reading
 * a field off it throws synchronously inside the `'message'` listener, where there is no
 * catch left. Unguarded, that ends the process — so the two working clients are the real
 * assertions: one held open across the refusals, one connecting after them, and neither
 * is possible if the daemon is gone.
 */
test('an unvalidated frame closes only its own socket and leaves the daemon serving', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'awos-ws-frame-'));
  dataDirs.push(dataDir);
  const cfg = config(dataDir);
  const orchestrator = new Orchestrator(cfg);
  orchestrators.push(orchestrator);
  const server = new HarnessServer(cfg, orchestrator);
  servers.push(server);
  const port = await server.listen();

  // An authenticated client held open across every bad frame: the criterion is that a
  // refused frame costs its own socket, not that the daemon merely survives it.
  const bystander = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(bystander);
  bystander.on('error', () => {});
  await opened(bystander);
  assert.equal((await response(bystander, 'hello', { token: server.token }))['type'], 'ok');

  const frames = ['null', '[]', '1', '"x"', '{"requestId":"r1"}', '{"type":"hello"}'];
  for (const frame of frames) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(socket);
    socket.on('error', () => {});
    await opened(socket);
    const code = closed(socket);
    socket.send(frame);
    assert.equal(await code, 1003, `frame ${frame} should be refused as malformed`);
  }

  assert.equal(bystander.readyState, WebSocket.OPEN, 'a refused frame closed another client');
  assert.equal((await response(bystander, 'thread.list'))['type'], 'thread.list');

  const survivor = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(survivor);
  survivor.on('error', () => {});
  await opened(survivor);
  const reply = await response(survivor, 'hello', { token: server.token });
  assert.equal(reply['type'], 'ok');
});

/**
 * The diagnostics RPC has to answer two different questions without confusing them: what
 * the harness is configured to run, and what it last observed about those processes.
 */
test('worker diagnostics report configuration always and liveness only after an explicit check', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'awos-ws-workers-'));
  dataDirs.push(dataDir);
  const cfg = config(dataDir);
  const orchestrator = new Orchestrator(cfg);
  orchestrators.push(orchestrator);
  const server = new HarnessServer(cfg, orchestrator);
  servers.push(server);
  const port = await server.listen();

  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(socket);
  socket.on('error', () => {});
  await opened(socket);
  assert.equal((await response(socket, 'hello', { token: server.token }))['type'], 'ok');

  const read = async (payload: Record<string, unknown> = {}): Promise<WorkerDiagnostic[]> => {
    const message = await response(socket, 'workers.diagnostics', payload);
    assert.equal(message['type'], 'workers.diagnostics');
    return message['diagnostics'] as WorkerDiagnostic[];
  };

  // This daemon has just started and nothing about a transient process is persisted, so
  // every configured worker is unchecked — not reachable, and not missing either.
  const before = await read();
  assert.deepEqual(before.map((diagnostic) => diagnostic.profileId), ['claude', 'codex', 'qwen-local']);
  for (const diagnostic of before) {
    assert.equal(diagnostic.capability.configured, true);
    assert.equal(diagnostic.capability.supported, true);
    assert.equal(diagnostic.capability.reasonCode, 'configured');
    assert.equal(diagnostic.reasonCode, 'not-checked');
    assert.equal(diagnostic.health.checkedAt, null);
    assert.equal(diagnostic.dispatchable, false);
  }

  const started = Date.now();
  const [claude] = await read({ profileIds: ['claude'], probe: true });
  assert.equal(claude?.reasonCode, 'unavailable', 'the configured binary is not on PATH in this test');
  assert.equal(claude?.dispatchable, false);
  assert.ok((claude?.health.checkedAt ?? 0) >= started);
  assert.match(claude?.reason ?? '', /did not answer the last check/);
  // The stable code carries the meaning; the probe's own words stay in bounded detail.
  assert.notEqual(claude?.health.detail, null);
  assert.ok((claude?.health.detail ?? '').length <= 200);

  const after = await read();
  assert.equal(after.find((diagnostic) => diagnostic.profileId === 'claude')?.reasonCode, 'unavailable');
  assert.equal(after.find((diagnostic) => diagnostic.profileId === 'codex')?.reasonCode, 'not-checked');
});

test('agents.probe uses configured custom profiles and keeps same-provider profiles selectable', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'awos-ws-custom-profiles-'));
  dataDirs.push(dataDir);
  const cfg = config(dataDir);
  const orchestrator = new Orchestrator(cfg, customClaudeRegistry());
  orchestrators.push(orchestrator);
  const server = new HarnessServer(cfg, orchestrator);
  servers.push(server);
  const port = await server.listen();

  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(socket);
  socket.on('error', () => {});
  await opened(socket);
  assert.equal((await response(socket, 'hello', { token: server.token }))['type'], 'ok');

  const probe = await response(socket, 'agents.probe');
  const agents = probe['agents'] as AgentAvailability[];
  assert.deepEqual(agents.map((agent) => agent.profileId), ['claude-build', 'claude-review']);
  assert.deepEqual(agents.map((agent) => agent.agent), ['claude', 'claude']);
  assert.deepEqual(agents.map((agent) => agent.label), ['Claude Build', 'Claude Review']);

  const created = await response(socket, 'thread.create', {
    cwd: dataDir,
    title: 'custom profile selection',
    agent: 'claude-build',
  });
  assert.equal(created['type'], 'thread.created');
  const thread = created['thread'] as { id: string; activeAgent: string };
  assert.equal(thread.activeAgent, 'claude-build');

  assert.equal((await response(socket, 'thread.setAgent', {
    threadId: thread.id,
    agent: 'claude-review',
  }))['type'], 'ok');
  const openedThread = await response(socket, 'thread.open', { threadId: thread.id });
  assert.equal((openedThread['thread'] as { activeAgent: string }).activeAgent, 'claude-review');
});
