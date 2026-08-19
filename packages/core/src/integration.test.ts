import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessEvent } from '@awos/protocol';
import { Orchestrator } from './orchestrator.js';
import type { HarnessConfig } from './config.js';

/**
 * End-to-end tests against fake CLIs that speak the real wire protocols.
 *
 * These are the tests that actually prove the harness works: they drive real child
 * processes through real stdio framing, real JSON-RPC correlation, and the real replay
 * path. The unit tests above them cover pure functions; only these cover the parts that
 * fail in production.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(here, 'testing', 'fake-claude.js');
const FAKE_CODEX = join(here, 'testing', 'fake-codex.js');

let dataDir: string;
let orchestrator: Orchestrator | null = null;

function makeConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    dataDir,
    claudeBin: process.execPath,
    codexBin: process.execPath,
    claudeBinArgs: [FAKE_CLAUDE],
    codexBinArgs: [FAKE_CODEX],
    claudeModel: '',
    codexModel: '',
    host: '127.0.0.1',
    port: 0,
    replayMaxChars: 24_000,
    replayMaxToolOutput: 800,
    interruptGraceMs: 1_000,
    approvalTimeoutMs: 5_000,
    codexInitTimeoutMs: 10_000,
    ...overrides,
  };
}

async function boot(config: HarnessConfig): Promise<{ orch: Orchestrator; events: HarnessEvent[] }> {
  const orch = new Orchestrator(config);
  await orch.start();
  orchestrator = orch;
  const events: HarnessEvent[] = [];
  orch.on('event', (event: HarnessEvent) => events.push(event));
  return { orch, events };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'awos-e2e-'));
});

afterEach(async () => {
  await orchestrator?.stop();
  orchestrator = null;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Claude adapter end to end', () => {
  test('streams a turn and records the full event sequence', async () => {
    const { orch, events } = await boot(makeConfig());
    const thread = orch.createThread({ cwd: process.cwd() });

    await orch.send(thread.id, 'claude', 'hello there');

    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.includes('user.message'), 'user message recorded');
    assert.ok(kinds.includes('turn.started'), 'turn opened');
    assert.ok(kinds.includes('message.delta'), 'text streamed as deltas');
    assert.ok(kinds.includes('message.completed'), 'final message emitted');
    assert.ok(kinds.includes('turn.completed'), 'turn closed');

    // Deltas must reassemble into exactly the final text.
    const deltas = events.filter((e) => e.kind === 'message.delta');
    const assembled = deltas.map((e) => (e.kind === 'message.delta' ? e.text : '')).join('');
    const final = events.find((e) => e.kind === 'message.completed');
    assert.equal(final?.kind === 'message.completed' ? final.text : null, assembled);
  });

  test('captures the native session id so a later run can resume', async () => {
    const { orch } = await boot(makeConfig());
    const thread = orch.createThread({ cwd: process.cwd() });
    await orch.send(thread.id, 'claude', 'hello');

    const saved = orch.store.get(thread.id);
    assert.equal(saved?.nativeSessions.claude, '11111111-2222-3333-4444-555555555555');
  });

  test('reports tool calls with their output', async () => {
    const { orch, events } = await boot(
      makeConfig({ claudeBinArgs: [FAKE_CLAUDE, '--tool'] }),
    );
    const thread = orch.createThread({ cwd: process.cwd() });
    await orch.send(thread.id, 'claude', 'run something');

    const started = events.find((e) => e.kind === 'tool.started');
    assert.ok(started, 'tool.started emitted');
    assert.equal(started.kind === 'tool.started' ? started.title : null, 'echo hello');
    assert.equal(started.kind === 'tool.started' ? started.toolKind : null, 'command');

    const completed = events.find((e) => e.kind === 'tool.completed');
    assert.ok(completed, 'tool.completed emitted');
    assert.equal(completed.kind === 'tool.completed' ? completed.status : null, 'ok');
    assert.match(completed.kind === 'tool.completed' ? completed.output : '', /hello/);
  });

  test('streams a thinking block as reasoning deltas and one completion', async () => {
    const { orch, events } = await boot(makeConfig({ claudeBinArgs: [FAKE_CLAUDE, '--think'] }));
    const thread = orch.createThread({ cwd: process.cwd() });

    await orch.send(thread.id, 'claude', 'think about it');

    const deltas = events.filter((e) => e.kind === 'reasoning.delta');
    assert.ok(deltas.length > 1, 'reasoning arrives in several deltas, not one lump');

    const completed = events.find((e) => e.kind === 'reasoning.completed');
    assert.ok(completed, 'reasoning.completed emitted');

    // The UI folds deltas and the completion into one block by item id, and times the
    // block from the first delta — both break if the ids drift apart.
    const itemIds = new Set(deltas.map((e) => (e.kind === 'reasoning.delta' ? e.itemId : '')));
    assert.equal(itemIds.size, 1);
    assert.ok(itemIds.has(completed.kind === 'reasoning.completed' ? completed.itemId : ''));

    const assembled = deltas.map((e) => (e.kind === 'reasoning.delta' ? e.text : '')).join('');
    assert.equal(completed.kind === 'reasoning.completed' ? completed.text : null, assembled);

    // Adding the thinking block moved the text to content-block index 1; the message
    // path has to survive that shift.
    assert.ok(
      events.some((e) => e.kind === 'message.completed'),
      'the answer still lands alongside the reasoning',
    );
  });

  test('records usage from the result event', async () => {
    const { orch, events } = await boot(makeConfig());
    const thread = orch.createThread({ cwd: process.cwd() });
    await orch.send(thread.id, 'claude', 'hi');

    const usage = events.find((e) => e.kind === 'usage');
    assert.ok(usage);
    assert.equal(usage.kind === 'usage' ? usage.inputTokens : null, 100);
    assert.equal(usage.kind === 'usage' ? usage.outputTokens : null, 20);
  });

  test('handles several sequential turns on one process', async () => {
    const { orch, events } = await boot(makeConfig());
    const thread = orch.createThread({ cwd: process.cwd() });

    await orch.send(thread.id, 'claude', 'first');
    await orch.send(thread.id, 'claude', 'second');

    const completions = events.filter((e) => e.kind === 'turn.completed');
    assert.equal(completions.length, 2);
    // A single long-lived process is the whole point of stream-json input mode.
    const inits = events.filter((e) => e.kind === 'agent.status' && e.status === 'spawning');
    assert.equal(inits.length, 1, 'the CLI process should be reused across turns');
  });
});

describe('Codex adapter end to end', () => {
  test('completes the handshake and streams a turn', async () => {
    const { orch, events } = await boot(makeConfig());
    const thread = orch.createThread({ cwd: process.cwd() });

    await orch.send(thread.id, 'codex', 'do the thing');

    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.includes('message.delta'));
    assert.ok(kinds.includes('message.completed'));
    assert.ok(kinds.includes('plan.updated'));
    assert.ok(kinds.includes('turn.completed'));

    assert.equal(orch.store.get(thread.id)?.nativeSessions.codex, 'thr_fake_1');
  });

  test('streams incremental command output', async () => {
    const { orch, events } = await boot(makeConfig({ codexBinArgs: [FAKE_CODEX, '--tool'] }));
    const thread = orch.createThread({ cwd: process.cwd() });
    await orch.send(thread.id, 'codex', 'run it');

    const output = events.find((e) => e.kind === 'tool.output');
    assert.ok(output, 'codex streams output as it is produced');
    assert.equal(output.kind === 'tool.output' ? output.chunk : null, 'hi\n');
  });

  test('surfaces an approval and blocks the turn until it is answered', async () => {
    const { orch, events } = await boot(
      makeConfig({ codexBinArgs: [FAKE_CODEX, '--tool', '--approval'] }),
    );
    const thread = orch.createThread({ cwd: process.cwd() });

    // Answer the approval as soon as it appears; the turn cannot finish before then.
    orch.on('event', (event: HarnessEvent) => {
      if (event.kind === 'approval.requested') {
        orch.resolveApproval(thread.id, event.approvalId, 'allow');
      }
    });

    await orch.send(thread.id, 'codex', 'needs permission');

    const requested = events.find((e) => e.kind === 'approval.requested');
    assert.ok(requested, 'approval surfaced to the UI');
    assert.equal(requested.kind === 'approval.requested' ? requested.title : null, 'Run a shell command');

    const resolved = events.find((e) => e.kind === 'approval.resolved');
    assert.equal(resolved?.kind === 'approval.resolved' ? resolved.behavior : null, 'allow');
    assert.equal(resolved?.kind === 'approval.resolved' ? resolved.auto : null, false);

    // The tool only ran because we allowed it.
    assert.ok(events.some((e) => e.kind === 'tool.started'));
  });

  test('a denied approval aborts the tool without failing the turn', async () => {
    const { orch, events } = await boot(
      makeConfig({ codexBinArgs: [FAKE_CODEX, '--tool', '--approval'] }),
    );
    const thread = orch.createThread({ cwd: process.cwd() });

    orch.on('event', (event: HarnessEvent) => {
      if (event.kind === 'approval.requested') {
        orch.resolveApproval(thread.id, event.approvalId, 'deny');
      }
    });

    await orch.send(thread.id, 'codex', 'needs permission');

    const completed = events.find((e) => e.kind === 'tool.completed');
    assert.equal(completed?.kind === 'tool.completed' ? completed.status : null, 'aborted');
    const turn = events.find((e) => e.kind === 'turn.completed');
    assert.equal(turn?.kind === 'turn.completed' ? turn.reason : null, 'completed');
  });

  test('promotes a turn diff to a first-class event and thread state', async () => {
    const { orch, events } = await boot(makeConfig({ codexBinArgs: [FAKE_CODEX, '--diff'] }));
    const thread = orch.createThread({ cwd: process.cwd() });
    await orch.send(thread.id, 'codex', 'change something');

    const diff = events.find((e) => e.kind === 'diff.updated');
    assert.ok(diff, 'diff.updated emitted rather than being buried in a raw event');
    assert.match(diff.kind === 'diff.updated' ? diff.patch : '', /\+let updated = 2;/);

    // The panel reads this from runtime state, not by scanning the event log.
    assert.match(orch.state(thread.id).diff ?? '', /src\/lib\.rs/);
    assert.equal(orch.state(thread.id).lastTurnAgent, 'codex');
  });

  test('a new turn clears the previous turn diff', async () => {
    const { orch } = await boot(
      makeConfig({ codexBinArgs: [FAKE_CODEX, '--diff'], claudeBinArgs: [FAKE_CLAUDE] }),
    );
    const thread = orch.createThread({ cwd: process.cwd() });

    await orch.send(thread.id, 'codex', 'change something');
    assert.ok(orch.state(thread.id).diff, 'codex reported a diff');

    // Claude reports no turn diff. Carrying Codex's over would credit it to Claude.
    await orch.send(thread.id, 'claude', 'now look at it');
    assert.equal(orch.state(thread.id).diff, null);
    assert.equal(orch.state(thread.id).lastTurnAgent, 'claude');
  });

  test('keeps the last turn owner independent from a live composer switch', async () => {
    const { orch } = await boot(
      makeConfig({ codexBinArgs: [FAKE_CODEX, '--diff'], claudeBinArgs: [FAKE_CLAUDE] }),
    );
    const thread = orch.createThread({ cwd: process.cwd() });
    const liveStates: Array<ReturnType<Orchestrator['state']>> = [];
    orch.on('state', (state) => liveStates.push(state));

    await orch.send(thread.id, 'codex', 'make a change');
    orch.store.update(thread.id, { activeAgent: 'claude' });

    assert.equal(orch.store.get(thread.id)?.activeAgent, 'claude');
    assert.equal(orch.state(thread.id).lastTurnAgent, 'codex');
    assert.ok(liveStates.some((state) => state.lastTurnAgent === 'codex'));
    assert.ok(orch.state(thread.id).diff, 'the Codex turn diff remains visible');

    await orch.send(thread.id, 'claude', 'review the change');
    orch.store.update(thread.id, { activeAgent: 'codex' });

    assert.equal(orch.store.get(thread.id)?.activeAgent, 'codex');
    assert.equal(orch.state(thread.id).lastTurnAgent, 'claude');
    assert.ok(liveStates.some((state) => state.lastTurnAgent === 'claude'));
    assert.equal(orch.state(thread.id).diff, null);
  });

  test('reconstructs a null diff after a later persisted turn has no diff', async () => {
    const config = makeConfig({
      codexBinArgs: [FAKE_CODEX, '--diff'],
      claudeBinArgs: [FAKE_CLAUDE],
    });
    const { orch } = await boot(config);
    const thread = orch.createThread({ cwd: process.cwd() });

    await orch.send(thread.id, 'codex', 'change something');
    await orch.send(thread.id, 'claude', 'now look at it');
    assert.equal(orch.state(thread.id).diff, null, 'live state clears the previous diff');

    await orch.stop();
    orchestrator = null;

    const revived = new Orchestrator(config);
    await revived.start();
    orchestrator = revived;

    assert.equal(revived.state(thread.id).diff, null);
    assert.equal(revived.state(thread.id).lastTurnAgent, 'claude');
  });

  test('falls back to a fresh thread when resume is rejected', async () => {
    const { orch } = await boot(makeConfig());
    const thread = orch.createThread({ cwd: process.cwd() });
    // Plant a session id the fake server will reject.
    orch.store.setNativeSession(thread.id, 'codex', 'stale-thread');

    await orch.send(thread.id, 'codex', 'still works?');

    // A stale native session must degrade to a new one, not break the thread.
    assert.equal(orch.store.get(thread.id)?.nativeSessions.codex, 'thr_fake_1');
  });
});

describe('cross-agent handoff', () => {
  test('replays the other agent\'s work into the incoming agent', async () => {
    const { orch } = await boot(makeConfig({ claudeBinArgs: [FAKE_CLAUDE, '--tool'] }));
    const thread = orch.createThread({ cwd: process.cwd() });

    await orch.send(thread.id, 'claude', 'set up the project');
    await orch.send(thread.id, 'codex', 'now add tests');

    // The fake echoes back the first 20 chars of what it received, which tells us
    // exactly what landed on the wire.
    const events = orch.store.events(thread.id);
    const codexMessages = events.filter(
      (e) => e.agent === 'codex' && e.kind === 'message.completed',
    );
    assert.ok(codexMessages.length > 0);

    const received = codexMessages[0];
    const text = received?.kind === 'message.completed' ? received.text : '';
    // Codex saw the replay preamble, not the bare user message.
    assert.match(text, /harness-replay/);
  });

  test('advances the watermark so context is not replayed twice', async () => {
    const { orch } = await boot(makeConfig());
    const thread = orch.createThread({ cwd: process.cwd() });

    await orch.send(thread.id, 'claude', 'first');
    await orch.send(thread.id, 'codex', 'second');

    const afterSwitch = orch.store.get(thread.id);
    const codexWatermark = afterSwitch?.watermarks.codex ?? 0;
    assert.ok(codexWatermark > 0, 'codex watermark advanced after it took a turn');

    await orch.send(thread.id, 'codex', 'third');

    const afterRepeat = orch.store.get(thread.id);
    assert.ok(
      (afterRepeat?.watermarks.codex ?? 0) > codexWatermark,
      'watermark keeps advancing',
    );
  });

  test('the first turn for an agent carries no replay block', async () => {
    const { orch } = await boot(makeConfig());
    const thread = orch.createThread({ cwd: process.cwd() });

    await orch.send(thread.id, 'claude', 'the very first message');

    const events = orch.store.events(thread.id);
    const message = events.find((e) => e.kind === 'message.completed');
    const text = message?.kind === 'message.completed' ? message.text : '';
    assert.doesNotMatch(text, /harness-replay/);
  });

  test('refuses a second turn while one is in flight', async () => {
    const { orch } = await boot(makeConfig({ claudeBinArgs: [FAKE_CLAUDE, '--slow'] }));
    const thread = orch.createThread({ cwd: process.cwd() });

    const first = orch.send(thread.id, 'claude', 'long running');
    // Two agents writing to the same working directory at once is a correctness
    // problem, so the orchestrator rejects rather than queues.
    await assert.rejects(
      () => orch.send(thread.id, 'codex', 'meanwhile'),
      /still working/,
    );
    await first;
  });

  test('a thread survives a restart with its transcript and sessions intact', async () => {
    const config = makeConfig();
    const { orch } = await boot(config);
    const thread = orch.createThread({ cwd: process.cwd() });
    await orch.send(thread.id, 'claude', 'remember this');
    await orch.stop();
    orchestrator = null;

    const revived = new Orchestrator(config);
    await revived.start();
    orchestrator = revived;

    const reloaded = revived.store.get(thread.id);
    assert.equal(reloaded?.nativeSessions.claude, '11111111-2222-3333-4444-555555555555');
    assert.ok(revived.store.events(thread.id).length > 0);
  });
});

describe('pinned context', () => {
  /** The fake echoes the head of what it received, so this reads the actual wire payload. */
  function receivedByClaude(orch: Orchestrator, threadId: string): string[] {
    return orch.store
      .events(threadId)
      .filter((e) => e.kind === 'message.completed' && e.agent === 'claude')
      .map((e) => (e.kind === 'message.completed' ? e.text : ''));
  }

  test('rides on every turn, not just the first', async () => {
    const { orch } = await boot(makeConfig());
    const thread = orch.createThread({ cwd: process.cwd() });
    orch.setPinnedContext(thread.id, 'House rules: never push to main.');

    await orch.send(thread.id, 'claude', 'first');
    await orch.send(thread.id, 'claude', 'second');

    const received = receivedByClaude(orch, thread.id);
    assert.equal(received.length, 2);
    for (const text of received) assert.match(text, /pinned-context/);
  });

  test('an empty context adds nothing to the prompt', async () => {
    const { orch } = await boot(makeConfig());
    const thread = orch.createThread({ cwd: process.cwd() });

    await orch.send(thread.id, 'claude', 'no notes here');

    assert.doesNotMatch(receivedByClaude(orch, thread.id)[0] ?? '', /pinned-context/);
  });

  test('the recorded user message stays what the user typed', async () => {
    const { orch } = await boot(makeConfig());
    const thread = orch.createThread({ cwd: process.cwd() });
    orch.setPinnedContext(thread.id, 'House rules: never push to main.');

    await orch.send(thread.id, 'claude', 'just this');

    // The block is transport, like the replay preamble. Recording it would put it in the
    // user's own chat bubble.
    const message = orch.store.events(thread.id).find((e) => e.kind === 'user.message');
    assert.equal(message?.kind === 'user.message' ? message.text : null, 'just this');
  });

  test('is picked up from disk after a restart', async () => {
    const config = makeConfig();
    const { orch } = await boot(config);
    const thread = orch.createThread({ cwd: process.cwd() });
    orch.setPinnedContext(thread.id, 'House rules: never push to main.');
    await orch.stop();
    orchestrator = null;

    const revived = new Orchestrator(config);
    await revived.start();
    orchestrator = revived;

    await revived.send(thread.id, 'claude', 'still there?');
    assert.match(receivedByClaude(revived, thread.id)[0] ?? '', /pinned-context/);
  });

  test('rejects pinning to a thread that does not exist', async () => {
    const { orch } = await boot(makeConfig());
    assert.throws(() => orch.setPinnedContext('nope', 'hi'), /Unknown thread/);
    assert.throws(() => orch.getPinnedContext('nope'), /Unknown thread/);
  });
});
