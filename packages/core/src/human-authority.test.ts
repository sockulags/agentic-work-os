import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { WebSocket, type RawData } from 'ws';
import { WORKSPACE_FILE, WORKSPACE_SCHEMA_VERSION, type CandidateIdentity } from '@awos/protocol';
import { HUMAN_AUTH_TOKEN_ENV, type HarnessConfig } from './config.js';
import { Orchestrator } from './orchestrator.js';
import { HarnessServer } from './server.js';

const dirs: string[] = [];

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
    humanAuthorityToken: 'human-only-secret',
  };
}

const candidate: CandidateIdentity = {
  kind: 'working-tree',
  id: 'tree-human-auth',
  revision: 'commit-human-auth',
  digest: 'tree-human-auth',
  pinned: true,
};

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('ordinary bearer, absent credential, and wrong credential cannot write human records', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'awos-human-auth-'));
  dirs.push(dataDir);
  const cfg = config(dataDir);
  const orchestrator = new Orchestrator(cfg);
  const server = new HarnessServer(cfg, orchestrator);
  const port = await server.listen();
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await opened(socket);

  try {
    await response(socket, 'hello', { token: server.token });
    const thread = orchestrator.createThread({ cwd: process.cwd() });
    const request = {
      threadId: thread.id,
      expectationItemId: 'question.scope',
      expectationSetId: 'set-human-auth',
      answer: { type: 'choice', value: 'keep' },
      candidate,
      answerId: 'answer-human-auth',
    };

    for (const humanCredential of [undefined, 'wrong-secret', server.token]) {
      const result = await response(socket, 'answer.record', {
        ...request,
        ...(humanCredential === undefined ? {} : { humanCredential }),
      });
      assert.equal(result.type, 'error');
    }
    assert.equal(orchestrator.store.events(thread.id).filter((event) => event.kind === 'answer.recorded').length, 0);
  } finally {
    socket.close();
    await server.close();
    await orchestrator.stop();
  }
});

test('the distinct credential writes answers and attestations without entering records or reads', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'awos-human-auth-ok-'));
  dirs.push(dataDir);
  const cfg = config(dataDir);
  const orchestrator = new Orchestrator(cfg);
  const server = new HarnessServer(cfg, orchestrator);
  const port = await server.listen();
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await opened(socket);

  try {
    await response(socket, 'hello', { token: server.token });
    const thread = orchestrator.createThread({ cwd: process.cwd() });
    await response(socket, 'answer.record', {
      threadId: thread.id,
      expectationItemId: 'question.scope',
      expectationSetId: 'set-human-auth',
      answer: { type: 'boolean', value: true },
      candidate,
      answerId: 'answer-human-auth',
      humanCredential: cfg.humanAuthorityToken,
    });
    await response(socket, 'attestation.record', {
      threadId: thread.id,
      expectationItemId: 'review.semantic',
      expectationSetId: 'set-human-auth',
      statement: 'I reviewed the pinned candidate.',
      candidate,
      evidenceIds: [],
      attestationId: 'attestation-human-auth',
      humanCredential: cfg.humanAuthorityToken,
    });

    const beforeDuplicate = orchestrator.store.events(thread.id).length;
    orchestrator.recordAnswer(thread.id, {
      expectationItemId: 'question.scope',
      expectationSetId: 'set-human-auth',
      answer: { type: 'boolean', value: true },
      candidate,
      answerId: 'answer-human-auth',
      humanCredential: cfg.humanAuthorityToken,
    });
    assert.equal(orchestrator.store.events(thread.id).length, beforeDuplicate, 'identical duplicate is idempotent');
    assert.throws(() => orchestrator.recordAnswer(thread.id, {
      expectationItemId: 'question.other',
      expectationSetId: 'other-set',
      answer: { type: 'boolean', value: false },
      candidate: { ...candidate, id: 'other-tree', digest: 'other-tree' },
      answerId: 'answer-human-auth',
      humanCredential: cfg.humanAuthorityToken,
    }), /conflicting immutable definition/);
    assert.equal(orchestrator.store.events(thread.id).filter((event) => event.kind === 'answer.recorded').length, 1);

    orchestrator.recordAttestation(thread.id, {
      expectationItemId: 'review.semantic',
      expectationSetId: 'set-human-auth',
      statement: 'I reviewed the pinned candidate.',
      candidate,
      evidenceIds: [],
      attestationId: 'attestation-human-auth',
      humanCredential: cfg.humanAuthorityToken,
    });
    assert.throws(() => orchestrator.recordAttestation(thread.id, {
      expectationItemId: 'review.other',
      expectationSetId: 'other-set',
      statement: 'A conflicting statement.',
      candidate: { ...candidate, id: 'other-tree', digest: 'other-tree' },
      evidenceIds: ['other-evidence'],
      attestationId: 'attestation-human-auth',
      humanCredential: cfg.humanAuthorityToken,
    }), /conflicting immutable definition/);
    assert.equal(orchestrator.store.events(thread.id).filter((event) => event.kind === 'attestation.recorded').length, 1);

    const openedThread = await response(socket, 'thread.open', { threadId: thread.id });
    const serialized = JSON.stringify(openedThread);
    assert.doesNotMatch(serialized, /human-only-secret/);
    assert.equal(orchestrator.store.events(thread.id).filter((event) => event.kind === 'answer.recorded').length, 1);
    assert.equal(orchestrator.store.events(thread.id).filter((event) => event.kind === 'attestation.recorded').length, 1);
  } finally {
    socket.close();
    await server.close();
    await orchestrator.stop();
  }
});

test('verification children preserve ordinary bearer context but never receive human authority', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'awos-human-auth-check-'));
  const cwd = mkdtempSync(join(tmpdir(), 'awos-human-auth-check-cwd-'));
  dirs.push(dataDir, cwd);
  const previousOrdinary = process.env['AWOS_TOKEN'];
  const humanEnvKeys = [HUMAN_AUTH_TOKEN_ENV, HUMAN_AUTH_TOKEN_ENV.toLowerCase(), 'AwOs_HuMaN_AuTh_ToKeN'];
  const previousHuman = new Map(humanEnvKeys.map((key) => [key, process.env[key]]));
  process.env['AWOS_TOKEN'] = 'ordinary-check-token';
  humanEnvKeys.forEach((key, index) => { process.env[key] = `human-check-token-${index}`; });
  mkdirSync(join(cwd, '.awos'), { recursive: true });
  writeFileSync(join(cwd, WORKSPACE_FILE), JSON.stringify({
    version: WORKSPACE_SCHEMA_VERSION,
    name: 'human-auth-check',
    verify: [{
      name: 'probe',
      command: 'node -e "require(\'fs\').writeFileSync(\'child-env.json\',JSON.stringify({ordinary:process.env.AWOS_TOKEN,canonical:process.env.AWOS_HUMAN_AUTH_TOKEN,lower:process.env.awos_human_auth_token,mixed:process.env.AwOs_HuMaN_AuTh_ToKeN}))"',
    }],
  }), 'utf8');

  const cfg = config(dataDir);
  const orchestrator = new Orchestrator(cfg);
  try {
    const thread = orchestrator.createThread({ cwd });
    const result = await orchestrator.runCheck(thread.id, 'codex', 'probe');
    assert.equal(result.passed, true);
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'child-env.json'), 'utf8')), {
      ordinary: 'ordinary-check-token',
    });
  } finally {
    await orchestrator.stop();
    if (previousOrdinary === undefined) delete process.env['AWOS_TOKEN'];
    else process.env['AWOS_TOKEN'] = previousOrdinary;
    for (const key of humanEnvKeys) {
      delete process.env[key];
      const value = previousHuman.get(key);
      if (value !== undefined) process.env[key] = value;
    }
  }
});

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

function response(
  socket: WebSocket,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const requestId = `${type}-${Math.random()}`;
  return new Promise((resolve) => {
    const onMessage = (raw: RawData): void => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.requestId !== requestId) return;
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ type, requestId, ...payload }));
  });
}
