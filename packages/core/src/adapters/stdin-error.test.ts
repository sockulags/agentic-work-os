import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterEvent } from '@awos/protocol';
import type { HarnessConfig } from '../config.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import type { AdapterContext } from './agent.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(here, '..', 'testing', 'fake-claude.js');
const FAKE_CODEX = join(here, '..', 'testing', 'fake-codex.js');

function testConfig(dir: string, overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    dataDir: dir,
    claudeBin: process.execPath,
    codexBin: process.execPath,
    claudeBinArgs: [],
    codexBinArgs: [],
    claudeModel: '',
    codexModel: '',
    host: '127.0.0.1',
    port: 0,
    replayMaxChars: 1_000,
    replayMaxToolOutput: 1_000,
    interruptGraceMs: 1_000,
    approvalTimeoutMs: 1_000,
    codexInitTimeoutMs: 2_000,
    laneSetup: '',
    laneSetupTimeoutMs: 60_000,
    ghBin: process.execPath,
    ghBinArgs: [],
    ghTimeoutMs: 5_000,
    ...overrides,
  };
}

function permissionBridge(): AdapterContext['permissionBridge'] {
  return {
    port: 0,
    token: 'test-token',
    registerThread: () => {},
    unregisterThread: () => {},
  } as unknown as AdapterContext['permissionBridge'];
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function unheldRejections(work: () => Promise<void>): Promise<unknown[]> {
  const loose: unknown[] = [];
  const record = (reason: unknown): void => {
    loose.push(reason);
  };
  process.on('unhandledRejection', record);
  try {
    await work();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', record);
  }
  return loose;
}

function completed(events: AdapterEvent[]): Extract<AdapterEvent, { kind: 'turn.completed' }>[] {
  return events.filter(
    (event): event is Extract<AdapterEvent, { kind: 'turn.completed' }> =>
      event.kind === 'turn.completed',
  );
}

test('Claude survives a write after its exited CLI and closes one error turn', { concurrency: false }, async () => {
  const dir = mkdtempSync(join(process.env.TEMP ?? process.cwd(), 'awos-stdin-claude-'));
  const marker = join(dir, 'exited');
  const events: AdapterEvent[] = [];
  const adapter = new ClaudeAdapter({
    threadId: 'thread-1',
    workerProfileId: 'claude',
    workerProfileIds: ['claude'],
    agentId: 'claude',
    cwd: dir,
    config: testConfig(dir, {
      claudeBinArgs: [FAKE_CLAUDE, '--exit-after-ready', '--exit-marker', marker],
    }),
    permissionMode: 'default',
    permissionBridge: permissionBridge(),
    resumeSessionId: null,
    emit: (event) => events.push(event),
    onSessionId: () => {},
  });

  try {
    await adapter.start();
    // The fake writes this marker from its exit handler. Its helper child keeps the pipes
    // open, so this is deterministically before the parent's `close` event on Windows/Linux.
    await waitForFile(marker);

    const loose = await unheldRejections(async () => {
      // Depending on which pipe closes first, Node reports either the handled stdin error
      // or the child's close. Both are the worker-scoped terminal failure for this turn.
      await assert.rejects(adapter.sendTurn('write after exit'), /Claude Code (worker stdin error|exited)/);
    });

    assert.deepEqual(loose, []);
    const terminal = completed(events);
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]?.reason, 'error');
    assert.match(terminal[0]?.error ?? '', /Claude Code/);
    assert.equal(adapter.busy, false);
  } finally {
    await adapter.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex survives a write after its exited CLI and closes one error turn', { concurrency: false }, async () => {
  const dir = mkdtempSync(join(process.env.TEMP ?? process.cwd(), 'awos-stdin-codex-'));
  const marker = join(dir, 'exited');
  const events: AdapterEvent[] = [];
  const adapter = new CodexAdapter({
    threadId: 'thread-1',
    workerProfileId: 'codex',
    workerProfileIds: ['codex'],
    agentId: 'codex',
    cwd: dir,
    config: testConfig(dir, {
      codexBinArgs: [FAKE_CODEX, '--exit-after-ready', '--exit-marker', marker],
    }),
    permissionMode: 'default',
    permissionBridge: permissionBridge(),
    resumeSessionId: null,
    emit: (event) => events.push(event),
    onSessionId: () => {},
  });

  try {
    await adapter.start();
    // The fake writes this marker from its exit handler. Its helper child keeps the pipes
    // open, so this is deterministically before the parent's `close` event on Windows/Linux.
    await waitForFile(marker);

    const loose = await unheldRejections(async () => {
      await assert.rejects(adapter.sendTurn('write after exit'), /Codex (worker stdin error|app-server exited)/);
    });

    assert.deepEqual(loose, []);
    const terminal = completed(events);
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]?.reason, 'error');
    assert.match(terminal[0]?.error ?? '', /Codex/);
    assert.equal(adapter.busy, false);
  } finally {
    await adapter.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
