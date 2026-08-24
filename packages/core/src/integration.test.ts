import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessEvent, ThreadRuntimeState } from '@awos/protocol';
import { RETAINED_FILE, WORKSPACE_FILE, WORKSPACE_LOCAL_FILE, WORKSPACE_SCHEMA_VERSION } from '@awos/protocol';
import { foldEvidence, foldOutcomes, foldRetained, foldTransitionEvaluations } from './work/ledger.js';
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
const FAKE_QWEN = join(here, 'testing', 'fake-qwen.js');
const FAKE_GH = join(here, 'testing', 'fake-gh.js');

let dataDir: string;
/**
 * The default working directory for a thread under test.
 *
 * A throwaway directory rather than `process.cwd()`, which is this repository. Now that a
 * repository can declare a workspace, running the suite from inside one would put that
 * project's rules — its agent list, its prompt block — into tests about something else,
 * and the result would depend on where `npm test` was started from.
 */
let workDir: string;
let orchestrator: Orchestrator | null = null;
const repos: string[] = [];

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
    laneSetup: '',
    laneSetupTimeoutMs: 60_000,
    ghBin: process.execPath,
    ghBinArgs: [FAKE_GH],
    ghTimeoutMs: 5_000,
    ...overrides,
  };
}

/** A throwaway git repo to act as a thread's working directory. Lanes need a real one. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'awos-e2e-repo-'));
  repos.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  // Keep the host's line-ending policy out of assertions about file contents.
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: dir });
  return dir;
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
  workDir = mkdtempSync(join(tmpdir(), 'awos-e2e-cwd-'));
});

afterEach(async () => {
  await orchestrator?.stop();
  orchestrator = null;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
  while (repos.length > 0) rmSync(repos.pop() as string, { recursive: true, force: true });
});

describe('Claude adapter end to end', () => {
  test('streams a turn and records the full event sequence', async () => {
    const { orch, events } = await boot(makeConfig());
    const thread = orch.createThread({ cwd: workDir });

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
    const thread = orch.createThread({ cwd: workDir });
    await orch.send(thread.id, 'claude', 'hello');

    const saved = orch.store.get(thread.id);
    assert.equal(saved?.nativeSessions.claude, '11111111-2222-3333-4444-555555555555');
  });

  test('reports tool calls with their output', async () => {
    const { orch, events } = await boot(
      makeConfig({ claudeBinArgs: [FAKE_CLAUDE, '--tool'] }),
    );
    const thread = orch.createThread({ cwd: workDir });
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

  test('reports a burst of parallel tool calls, failures included', async () => {
    const { orch, events } = await boot(
      makeConfig({ claudeBinArgs: [FAKE_CLAUDE, '--tools'] }),
    );
    const thread = orch.createThread({ cwd: workDir });
    await orch.send(thread.id, 'claude', 'do several things');

    const started = events.filter((e) => e.kind === 'tool.started');
    assert.equal(started.length, 5);
    assert.deepEqual(
      started.map((e) => (e.kind === 'tool.started' ? e.toolKind : null)),
      ['file_read', 'search', 'command', 'command', 'file_edit'],
    );

    const completed = events.filter((e) => e.kind === 'tool.completed');
    assert.equal(completed.length, 5);
    assert.deepEqual(
      completed
        .map((e) => (e.kind === 'tool.completed' ? e.status : null))
        .filter((status) => status !== 'ok'),
      ['error'],
    );
  });

  test('streams a thinking block as reasoning deltas and one completion', async () => {
    const { orch, events } = await boot(makeConfig({ claudeBinArgs: [FAKE_CLAUDE, '--think'] }));
    const thread = orch.createThread({ cwd: workDir });

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

  test('keeps text identity when final assistant payload omits thinking', async () => {
    const { orch, events } = await boot(
      makeConfig({ claudeBinArgs: [FAKE_CLAUDE, '--think-omit-final'] }),
    );
    const thread = orch.createThread({ cwd: workDir });

    await orch.send(thread.id, 'claude', 'think about it');

    const delta = events.find((event) => event.kind === 'message.delta');
    const completed = events.find((event) => event.kind === 'message.completed');
    assert.ok(delta, 'text delta emitted');
    assert.ok(completed, 'text completion emitted');
    assert.equal(
      delta.kind === 'message.delta' ? delta.itemId : null,
      completed.kind === 'message.completed' ? completed.itemId : null,
    );
    assert.match(delta.kind === 'message.delta' ? delta.itemId : '', /#0$/);
    assert.equal(events.filter((event) => event.kind === 'reasoning.delta').length > 0, true);
  });

  test('records usage from the result event', async () => {
    const { orch, events } = await boot(makeConfig());
    const thread = orch.createThread({ cwd: workDir });
    await orch.send(thread.id, 'claude', 'hi');

    const usage = events.find((e) => e.kind === 'usage');
    assert.ok(usage);
    assert.equal(usage.kind === 'usage' ? usage.inputTokens : null, 100);
    assert.equal(usage.kind === 'usage' ? usage.outputTokens : null, 20);
  });

  test('handles several sequential turns on one process', async () => {
    const { orch, events } = await boot(makeConfig());
    const thread = orch.createThread({ cwd: workDir });

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
    const thread = orch.createThread({ cwd: workDir });

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
    const thread = orch.createThread({ cwd: workDir });
    await orch.send(thread.id, 'codex', 'run it');

    const output = events.find((e) => e.kind === 'tool.output');
    assert.ok(output, 'codex streams output as it is produced');
    assert.equal(output.kind === 'tool.output' ? output.chunk : null, 'hi\n');
  });

  test('surfaces an approval and blocks the turn until it is answered', async () => {
    const { orch, events } = await boot(
      makeConfig({ codexBinArgs: [FAKE_CODEX, '--tool', '--approval'] }),
    );
    const thread = orch.createThread({ cwd: workDir });

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
    const thread = orch.createThread({ cwd: workDir });

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
    const thread = orch.createThread({ cwd: workDir });
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
    const thread = orch.createThread({ cwd: workDir });

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
    const thread = orch.createThread({ cwd: workDir });
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
    const thread = orch.createThread({ cwd: workDir });

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
    const thread = orch.createThread({ cwd: workDir });
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
    const thread = orch.createThread({ cwd: workDir });

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
    const thread = orch.createThread({ cwd: workDir });

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
    const thread = orch.createThread({ cwd: workDir });

    await orch.send(thread.id, 'claude', 'the very first message');

    const events = orch.store.events(thread.id);
    const message = events.find((e) => e.kind === 'message.completed');
    const text = message?.kind === 'message.completed' ? message.text : '';
    assert.doesNotMatch(text, /harness-replay/);
  });

  test('refuses a second turn while one is in flight', async () => {
    const { orch } = await boot(makeConfig({ claudeBinArgs: [FAKE_CLAUDE, '--slow'] }));
    const thread = orch.createThread({ cwd: workDir });

    const first = orch.send(thread.id, 'claude', 'long running');
    // Two agents writing to the same working directory at once is a correctness
    // problem, so the orchestrator rejects rather than queues.
    await assert.rejects(
      () => orch.send(thread.id, 'codex', 'meanwhile'),
      /still working/,
    );
    await first;
  });

  test('runs both agents at once once each has a lane', async () => {
    const { orch } = await boot(
      makeConfig({
        claudeBinArgs: [FAKE_CLAUDE, '--slow'],
        codexBinArgs: [FAKE_CODEX, '--slow'],
      }),
    );
    const thread = orch.createThread({ cwd: makeRepo() });
    await orch.setParallel(thread.id, true);

    // Sample the runtime state as it changes, so "both were working" is something the
    // test observed rather than something it assumed from two resolved promises.
    let peak = 0;
    orch.on('state', (state: ThreadRuntimeState) => {
      peak = Math.max(peak, state.busy.length);
    });

    const first = orch.send(thread.id, 'claude', 'long running');
    const second = orch.send(thread.id, 'codex', 'at the same time');
    await Promise.all([first, second]);

    assert.equal(peak, 2, 'both agents held a turn at the same moment');

    const state = orch.state(thread.id);
    assert.equal(state.busy.length, 0, 'both turns finished');
    assert.ok(state.lanes.claude, 'claude got a lane');
    assert.ok(state.lanes.codex, 'codex got a lane');
    assert.notEqual(state.lanes.claude, state.lanes.codex, 'the lanes are separate directories');
  });

  test('refuses to integrate a lane without a canonical workspace source', async () => {
    const { orch } = await boot(makeConfig());
    const cwd = makeRepo();
    const thread = orch.createThread({ cwd });
    await orch.setParallel(thread.id, true);
    await orch.send(thread.id, 'claude', 'anything, to provision the lane');

    const lane = orch.state(thread.id).lanes.claude;
    assert.ok(lane);
    // Stand in for the agent's edit: the fake CLIs stream events, they don't touch files.
    writeFileSync(join(lane, 'from-the-lane.txt'), 'work\n');
    assert.equal(existsSync(join(cwd, 'from-the-lane.txt')), false, 'not there before');

    const result = await orch.integrateLane(thread.id, 'claude');
    assert.equal(result.ok, false);
    assert.match(result.detail, /canonical integration source/);
    assert.equal(existsSync(join(cwd, 'from-the-lane.txt')), false, 'missing source cannot pass');

    // The transcript is the record: an integration is part of the conversation.
    const refused = orch.store
      .events(thread.id)
      .find((e) => e.kind === 'lane.updated' && e.status === 'refused');
    assert.ok(refused, 'the refusal is in the log');
  });

  test('refuses to leave parallel mode while a lane holds unintegrated work', async () => {
    const { orch } = await boot(makeConfig());
    const thread = orch.createThread({ cwd: makeRepo() });
    await orch.setParallel(thread.id, true);
    await orch.send(thread.id, 'claude', 'provision the lane');

    const lane = orch.state(thread.id).lanes.claude;
    assert.ok(lane);
    writeFileSync(join(lane, 'unsaved.txt'), 'would be lost\n');

    await assert.rejects(() => orch.setParallel(thread.id, false), /not in your working directory/);
    assert.equal(existsSync(join(lane, 'unsaved.txt')), true, 'the work is still there');
  });

  test('a thread survives a restart with its transcript and sessions intact', async () => {
    const config = makeConfig();
    const { orch } = await boot(config);
    const thread = orch.createThread({ cwd: workDir });
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
    const thread = orch.createThread({ cwd: workDir });
    orch.setPinnedContext(thread.id, 'House rules: never push to main.');

    await orch.send(thread.id, 'claude', 'first');
    await orch.send(thread.id, 'claude', 'second');

    const received = receivedByClaude(orch, thread.id);
    assert.equal(received.length, 2);
    for (const text of received) assert.match(text, /pinned-context/);
  });

  test('an empty context adds nothing to the prompt', async () => {
    const { orch } = await boot(makeConfig());
    const thread = orch.createThread({ cwd: workDir });

    await orch.send(thread.id, 'claude', 'no notes here');

    assert.doesNotMatch(receivedByClaude(orch, thread.id)[0] ?? '', /pinned-context/);
  });

  test('the recorded user message stays what the user typed', async () => {
    const { orch } = await boot(makeConfig());
    const thread = orch.createThread({ cwd: workDir });
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
    const thread = orch.createThread({ cwd: workDir });
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

describe('workspace contract', () => {
  /** Declare a directory a workspace, the way a repository would in Git. */
  function declare(root: string, declaration: Record<string, unknown>): void {
    mkdirSync(join(root, '.awos'), { recursive: true });
    writeFileSync(
      join(root, WORKSPACE_FILE),
      JSON.stringify({ version: WORKSPACE_SCHEMA_VERSION, name: 'under-test', ...declaration }),
      'utf8',
    );
  }

  /** The fake echoes the head of what it received, so this reads the actual wire payloads. */
  function receivedBy(orch: Orchestrator, threadId: string, agent: 'claude' | 'codex'): string[] {
    return orch.store
      .events(threadId)
      .filter((e) => e.kind === 'message.completed' && e.agent === agent)
      .map((e) => (e.kind === 'message.completed' ? e.text : ''));
  }

  /** The most recent turn's payload. */
  function lastReceivedBy(orch: Orchestrator, threadId: string, agent: 'claude' | 'codex'): string {
    const all = receivedBy(orch, threadId, agent);
    return all[all.length - 1] ?? '';
  }

  test('rides on the prompt of every turn, for either agent', async () => {
    const { orch } = await boot(makeConfig());
    declare(workDir, {});
    const thread = orch.createThread({ cwd: workDir });

    await orch.send(thread.id, 'claude', 'first');
    await orch.send(thread.id, 'claude', 'second');
    await orch.send(thread.id, 'codex', 'third');

    const claude = receivedBy(orch, thread.id, 'claude');
    assert.equal(claude.length, 2);
    for (const payload of claude) assert.match(payload, /<workspace>/);
    assert.match(lastReceivedBy(orch, thread.id, 'codex'), /<workspace>/);
  });

  test('an undeclared directory works exactly as it did before', async () => {
    const { orch } = await boot(makeConfig());
    const thread = orch.createThread({ cwd: workDir });

    await orch.send(thread.id, 'claude', 'no workspace here');

    assert.doesNotMatch(lastReceivedBy(orch, thread.id, 'claude'), /<workspace>/);
  });

  test('resolves from a subdirectory of the declared root', async () => {
    const { orch } = await boot(makeConfig());
    declare(workDir, {});
    const nested = join(workDir, 'packages', 'core');
    mkdirSync(nested, { recursive: true });
    const thread = orch.createThread({ cwd: nested });

    await orch.send(thread.id, 'claude', 'from inside the project');

    assert.match(lastReceivedBy(orch, thread.id, 'claude'), /<workspace>/);
  });

  test('orchestrator resolves a core expectation guardrail from the immutable manifest', async () => {
    const { orch } = await boot(makeConfig());
    declare(workDir, {
      agents: ['codex'],
      roles: [{ id: 'developer', label: 'Developer' }],
      steps: [{ id: 'implement', action: 'Implement', role: 'developer', workers: ['codex'] }],
      guardrails: [{
        id: 'evidence', kind: 'evidence-present', attach: { step: 'implement' },
        enforcement: 'required', parameters: { expectationItem: 'scope' },
      }],
    });

    const resolution = orch.workspace(workDir);
    assert.equal(resolution.status, 'ok');
    const guardrailParameters = resolution.status === 'ok' ? resolution.workspace.guardrails[0]?.parameters : undefined;
    assert.equal(guardrailParameters !== undefined && 'expectationItem' in guardrailParameters ? guardrailParameters.expectationItem : null, 'scope');
  });

  test('orchestrator keeps unsupported model guardrails invalid without a provider registry', async () => {
    const { orch } = await boot(makeConfig());
    declare(workDir, {
      agents: ['codex'],
      roles: [{ id: 'reviewer', label: 'Reviewer' }],
      steps: [{ id: 'review', action: 'Review', role: 'reviewer', workers: ['codex'] }],
      guardrails: [{
        id: 'rubric', kind: 'model-rubric', attach: { step: 'review' },
        enforcement: 'required', parameters: { expectationItem: 'scope', evaluatorProfile: 'independent-model' },
      }],
    });

    const resolution = orch.workspace(workDir);
    assert.equal(resolution.status, 'invalid');
    assert.equal(resolution.status === 'invalid' ? resolution.problems[0]?.path : null, 'guardrails[0].parameters.evaluatorProfile');
    assert.match(resolution.status === 'invalid' ? resolution.problems[0]?.message ?? '' : '', /Unknown evaluator profile/);
  });

  test('only an authorized typed answer opens a recorded planning transition', async () => {
    const { orch } = await boot(makeConfig({ humanAuthorityToken: 'planning-human-secret' }));
    declare(workDir, {
      agents: ['codex'],
      roles: [{ id: 'planner', label: 'Planner' }, { id: 'reviewer', label: 'Reviewer' }],
      steps: [
        { id: 'plan', action: 'Plan', role: 'planner', workers: ['codex'] },
        { id: 'review', action: 'Review', role: 'reviewer', workers: ['codex'] },
      ],
      guardrails: [{
        id: 'scope-answer',
        kind: 'mandatory-answer',
        attach: { step: 'review' },
        enforcement: 'required',
        parameters: { expectationItem: 'question.scope', authority: 'user' },
      }],
    });
    const thread = orch.createThread({ cwd: workDir });
    const candidate = {
      kind: 'working-tree' as const,
      id: 'planning-tree',
      revision: 'planning-commit',
      digest: 'planning-tree',
      pinned: true,
    };
    const first = await orch.evaluatePlanningTransition(thread.id, {
      sourceStepId: 'plan', targetStepId: 'review', candidate, transitionId: 'planning-scope',
    });
    assert.equal(first.verdict, 'waiting-for-human');
    assert.ok(first.evaluation.expectationSetId);

    orch.store.append(thread.id, 'codex', { kind: 'message.completed', itemId: 'worker-message', text: 'keep it' });
    orch.store.append(thread.id, 'codex', {
      kind: 'approval.resolved', approvalId: 'generic-approval', optionId: 'allow', behavior: 'allow', auto: false,
    });
    const workerOnly = await orch.evaluatePlanningTransition(thread.id, {
      sourceStepId: 'plan', targetStepId: 'review', candidate, transitionId: 'planning-scope',
    });
    assert.equal(workerOnly.verdict, 'waiting-for-human');

    orch.recordAnswer(thread.id, {
      expectationItemId: 'question.scope',
      expectationSetId: first.evaluation.expectationSetId,
      answer: { type: 'choice', value: 'keep' },
      candidate,
      answerId: 'planning-answer',
      humanCredential: 'planning-human-secret',
    });
    const opened = await orch.evaluatePlanningTransition(thread.id, {
      sourceStepId: 'plan', targetStepId: 'review', candidate, transitionId: 'planning-scope',
    });
    assert.equal(opened.verdict, 'passed');
    assert.equal(orch.store.events(thread.id).filter((event) => event.kind === 'transition.evaluated').length, 3);
  });

  test('refuses a turn to an agent the project does not allow', async () => {
    const { orch } = await boot(makeConfig());
    declare(workDir, { agents: ['codex'] });
    const thread = orch.createThread({ cwd: workDir });

    await assert.rejects(() => orch.send(thread.id, 'claude', 'hello'), /allows codex here/);
    // A refused turn leaves no trace: nothing was said, so nothing is in the transcript.
    assert.equal(orch.store.events(thread.id).length, 0);

    await orch.send(thread.id, 'codex', 'hello');
    assert.ok(orch.store.events(thread.id).length > 0, 'the allowed agent still works');
  });

  test('keeps the declaration out of the canonical event log', async () => {
    const { orch } = await boot(makeConfig());
    declare(workDir, { context: { notes: 'internal-only-note' } });
    const thread = orch.createThread({ cwd: workDir });

    await orch.send(thread.id, 'claude', 'just this');

    // The block is transport, like the replay preamble and the pinned notes: the harness
    // never writes a project's configuration into the log, so it cannot accumulate a copy
    // per turn. Only what the harness itself authored is asserted on — an agent may quote
    // anything it was given, and its reply is the agent talking, not the harness storing.
    const written = orch.store.events(thread.id).filter((event) => event.agent === null);
    assert.doesNotMatch(JSON.stringify(written), /internal-only-note/);
    const message = written.find((e) => e.kind === 'user.message');
    assert.equal(message?.kind === 'user.message' ? message.text : null, 'just this');
  });

  test('recovers a stale Qwen session with full replay and one run', async () => {
    const { orch, events } = await boot(makeConfig({ qwenBin: FAKE_QWEN }));
    const thread = orch.createThread({ cwd: workDir });
    await orch.send(thread.id, 'qwen-local', 'prior-qwen-context');
    await orch.stop();
    await orch.start();
    declare(workDir, { repository: { github: 'sockulags/agentic-work-os' } });
    const { item } = await orch.attachWorkItem(thread.id, '#14');
    assert.ok(item);
    orch.store.setNativeSession(thread.id, 'qwen-local', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    await orch.send(thread.id, 'qwen-local', 'current-qwen-message-once', true);

    const log = readFileSync(join(workDir, '.awos-qwen-invocations.log'), 'utf8').trim().split('\n');
    assert.equal(log.length, 3, 'prior turn, stale resume, then one fresh session');
    const reply = events
      .filter((event) => event.kind === 'message.completed' && event.agent === 'qwen-local')
      .at(-1);
    const received = reply?.kind === 'message.completed' ? reply.text : '';
    assert.match(received, /<harness-replay>/);
    assert.match(received, /prior-qwen-answer/);
    assert.match(received, /prior-qwen-tool-result/);
    assert.equal((received.match(/current-qwen-message-once/g) ?? []).length, 1);

    const currentMessages = orch.store.events(thread.id).filter(
      (event) => event.kind === 'user.message' && event.text === 'current-qwen-message-once',
    );
    assert.equal(currentMessages.length, 1);
    assert.notEqual(orch.store.get(thread.id)?.nativeSessions['qwen-local'], 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.equal(events.filter((event) => event.kind === 'error' && event.agent === 'qwen-local').length, 0);
    assert.equal(
      events.filter((event) => event.kind === 'turn.completed' && event.agent === 'qwen-local').length,
      2,
      'one prior completion and one recovered completion, not a stale error completion',
    );
    assert.equal(orch.store.events(thread.id).filter((event) => event.kind === 'run.started').length, 1);
    assert.equal(orch.store.events(thread.id).filter((event) => event.kind === 'run.completed').length, 1);
  });

  test('retries stale Qwen once and preserves a permanent retry failure', async () => {
    const { orch } = await boot(makeConfig({ qwenBin: FAKE_QWEN }));
    const thread = orch.createThread({ cwd: workDir });
    orch.store.setNativeSession(thread.id, 'qwen-local', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    await assert.rejects(() => orch.send(thread.id, 'qwen-local', 'retry-but-fail'));

    const log = readFileSync(join(workDir, '.awos-qwen-invocations.log'), 'utf8').trim().split('\n');
    assert.equal(log.length, 2, 'stale resume is retried once, but the permanent failure is not retried');
    assert.equal(orch.store.events(thread.id).filter((event) => event.kind === 'error' && event.agent === 'qwen-local').length, 1);
    assert.equal(
      orch.store.events(thread.id).filter((event) => event.kind === 'turn.completed' && event.agent === 'qwen-local').length,
      1,
      'only the permanent retry failure is terminal',
    );
    assert.equal(
      orch.store.events(thread.id).filter(
        (event) => event.kind === 'user.message' && event.text === 'retry-but-fail',
      ).length,
      1,
    );
  });

  test('provisions a lane with the setup command the project declares', async () => {
    const { orch } = await boot(makeConfig({ laneSetup: 'node -e "process.exit(1)"' }));
    const cwd = makeRepo();
    declare(cwd, {
      setup: { command: `node -e "require('fs').writeFileSync('setup-ran.txt','yes')"` },
    });
    const thread = orch.createThread({ cwd });
    await orch.setParallel(thread.id, true);

    await orch.send(thread.id, 'claude', 'provision the lane');

    const lane = orch.state(thread.id).lanes.claude;
    assert.ok(lane);
    // The project's command ran, and the stale environment variable did not.
    assert.equal(readFileSync(join(lane, 'setup-ran.txt'), 'utf8'), 'yes');
    const provisioned = orch.store
      .events(thread.id)
      .find((e) => e.kind === 'lane.updated' && e.status === 'provisioned');
    assert.match(
      provisioned?.kind === 'lane.updated' ? (provisioned.detail ?? '') : '',
      /^ran node -e/,
    );
  });

  test('a thread stored before workspaces existed still opens', async () => {
    const config = makeConfig();
    const { orch } = await boot(config);
    const thread = orch.createThread({ cwd: workDir });
    await orch.send(thread.id, 'claude', 'from an older build');
    await orch.stop();
    orchestrator = null;

    // Rewrite the stored metadata as an older build wrote it, then declare the directory
    // a workspace under the thread. Nothing about the thread names one, and nothing has
    // to: the workspace is resolved from the directory every time it is needed.
    const metaPath = join(dataDir, 'threads', thread.id, 'meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
    delete meta['parallel'];
    writeFileSync(metaPath, JSON.stringify(meta), 'utf8');
    declare(workDir, {});

    const revived = new Orchestrator(config);
    await revived.start();
    orchestrator = revived;

    const reloaded = revived.store.get(thread.id);
    assert.equal(reloaded?.cwd, workDir);
    assert.equal(revived.workspace(workDir).status, 'ok');
    await revived.send(thread.id, 'claude', 'and still works');
    assert.match(lastReceivedBy(revived, thread.id, 'claude'), /<workspace>/);
  });
});

describe('work items', () => {
  /** Declare the directory a workspace, since a work item needs a project to belong to. */
  function declare(root: string, github: string | null = 'sockulags/agentic-work-os'): void {
    mkdirSync(join(root, '.awos'), { recursive: true });
    writeFileSync(
      join(root, WORKSPACE_FILE),
      JSON.stringify({
        version: WORKSPACE_SCHEMA_VERSION,
        name: 'under-test',
        ...(github === null ? {} : { repository: { github } }),
      }),
      'utf8',
    );
  }

  function received(orch: Orchestrator, threadId: string, agent: 'claude' | 'codex'): string[] {
    return orch.store
      .events(threadId)
      .filter((e) => e.kind === 'message.completed' && e.agent === agent)
      .map((e) => (e.kind === 'message.completed' ? e.text : ''));
  }

  function runs(orch: Orchestrator, threadId: string): HarnessEvent[] {
    return orch.store.events(threadId).filter((e) => e.kind === 'run.started');
  }

  afterEach(() => {
    delete process.env['FAKE_GH_FAIL'];
    delete process.env['FAKE_GH_TITLE'];
    delete process.env['FAKE_GH_UPDATED_AT'];
  });

  test('attaches an issue by URL and links it to the thread', async () => {
    const { orch } = await boot(makeConfig());
    declare(workDir);
    const thread = orch.createThread({ cwd: workDir });

    const { item, error } = await orch.attachWorkItem(
      thread.id,
      'https://github.com/sockulags/agentic-work-os/issues/14',
    );

    assert.equal(error, null);
    assert.equal(item?.source.number, 14);
    assert.equal(orch.store.get(thread.id)?.workItemId, item?.id);
    assert.equal(orch.workItem(thread.id)?.id, item?.id);
  });

  test('resolves a bare number against the repository the workspace declares', async () => {
    const { orch } = await boot(makeConfig());
    declare(workDir);
    const thread = orch.createThread({ cwd: workDir });

    const { item } = await orch.attachWorkItem(thread.id, '#14');

    assert.equal(item?.source.repo, 'sockulags/agentic-work-os');
    assert.equal(item?.source.number, 14);
  });

  test('a directory that is not a workspace has nowhere to file an issue', async () => {
    const { orch } = await boot(makeConfig());
    const thread = orch.createThread({ cwd: workDir });

    const { item, error } = await orch.attachWorkItem(thread.id, '#14');

    assert.equal(item, null);
    assert.match(error?.message ?? '', /not a workspace/);
  });

  test('reports a missing issue as something to fix, not as a crash', async () => {
    const { orch } = await boot(makeConfig());
    declare(workDir);
    const thread = orch.createThread({ cwd: workDir });
    process.env['FAKE_GH_FAIL'] = 'not-found';

    const { item, error } = await orch.attachWorkItem(thread.id, '#4242');

    assert.equal(item, null);
    assert.equal(error?.kind, 'not-found');
    assert.equal(orch.store.get(thread.id)?.workItemId, null, 'a failed attach links nothing');
  });

  test('carries the issue into every turn, whether or not it is a run', async () => {
    const { orch } = await boot(makeConfig());
    declare(workDir);
    const thread = orch.createThread({ cwd: workDir });
    await orch.attachWorkItem(thread.id, '#14');

    await orch.send(thread.id, 'claude', 'a plain message');

    assert.match(received(orch, thread.id, 'claude')[0] ?? '', /<work-item>/);
    assert.equal(runs(orch, thread.id).length, 0, 'a message is not a run');
  });

  test('a run records what the agent was given and how it ended', async () => {
    const { orch } = await boot(makeConfig());
    declare(workDir);
    const thread = orch.createThread({ cwd: workDir });
    const { item } = await orch.attachWorkItem(thread.id, '#14');

    await orch.send(thread.id, 'claude', 'start on this', true);

    const started = runs(orch, thread.id)[0];
    assert.ok(started?.kind === 'run.started');
    assert.equal(started.workItemId, item?.id);
    assert.equal(started.source, 'sockulags/agentic-work-os#14');
    assert.equal(started.revision, item?.snapshot.revision);
    assert.equal(started.instruction, 'start on this');
    assert.equal(started.agent, 'claude', 'the run names the agent that took it');
    // The context is the payload as sent, which is what makes it evidence.
    assert.match(started.context, /<workspace>/);
    assert.match(started.context, /<work-item>/);
    assert.match(started.context, /start on this/);

    const completed = orch.store.events(thread.id).find((e) => e.kind === 'run.completed');
    assert.ok(completed?.kind === 'run.completed');
    assert.equal(completed.runId, started.runId);
    assert.equal(completed.state, 'completed');
  });

  test('an interrupted run is recorded as interrupted', async () => {
    const { orch } = await boot(makeConfig({ codexBinArgs: [FAKE_CODEX, '--slow'] }));
    declare(workDir);
    const thread = orch.createThread({ cwd: workDir });
    await orch.attachWorkItem(thread.id, '#14');

    const running = orch.send(thread.id, 'codex', 'start on this', true);
    // Interrupt once the turn is actually in flight, not before it exists.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await orch.interrupt(thread.id, 'codex');
    await running;

    const completed = orch.store.events(thread.id).find((e) => e.kind === 'run.completed');
    assert.equal(completed?.kind === 'run.completed' ? completed.state : null, 'interrupted');
  });

  test('the work item and its runs reopen after a restart', async () => {
    const config = makeConfig();
    const { orch } = await boot(config);
    declare(workDir);
    const thread = orch.createThread({ cwd: workDir });
    const { item } = await orch.attachWorkItem(thread.id, '#14');
    await orch.send(thread.id, 'claude', 'start on this', true);
    await orch.stop();
    orchestrator = null;

    const revived = new Orchestrator(config);
    await revived.start();
    orchestrator = revived;

    assert.equal(revived.workItem(thread.id)?.id, item?.id);
    assert.equal(revived.workItem(thread.id)?.snapshot.title, item?.snapshot.title);
    const started = runs(revived, thread.id)[0];
    assert.ok(started?.kind === 'run.started');
    assert.match(started.context, /<work-item>/);
    const projected = revived.state(thread.id).runStates.find((run) => run.runId === started.runId);
    assert.equal(projected?.state, 'completed');
    assert.equal(projected?.interruptedByRestart, false);
    assert.equal(
      revived.store.events(thread.id).filter((event) => event.kind === 'run.completed').length,
      1,
      'a clean restart does not add another completion',
    );
  });

  describe('refreshing', () => {
    test('a changed issue updates the item without touching the run that already happened', async () => {
      const { orch } = await boot(makeConfig());
      declare(workDir);
      const thread = orch.createThread({ cwd: workDir });
      process.env['FAKE_GH_TITLE'] = 'As it was';
      await orch.attachWorkItem(thread.id, '#14');
      await orch.send(thread.id, 'claude', 'start on this', true);

      process.env['FAKE_GH_TITLE'] = 'Rewritten by someone else';
      process.env['FAKE_GH_UPDATED_AT'] = '2026-09-01T08:00:00Z';
      const { item, error } = await orch.refreshWorkItem(thread.id);

      assert.equal(error, null);
      assert.equal(item?.snapshot.title, 'Rewritten by someone else');
      assert.equal(item?.snapshot.revision, '2026-09-01T08:00:00Z');

      // The run is an appended event, so the source moving cannot rewrite what it read —
      // which is what lets the UI say "changed since this run" by comparing the two.
      const started = runs(orch, thread.id)[0];
      assert.ok(started?.kind === 'run.started');
      assert.equal(started.revision, '2026-08-22T19:26:05Z');
      assert.match(started.context, /As it was/);
      assert.doesNotMatch(started.context, /Rewritten by someone else/);
    });

    test('an unchanged issue is still a successful check', async () => {
      const { orch } = await boot(makeConfig());
      declare(workDir);
      const thread = orch.createThread({ cwd: workDir });
      const attached = await orch.attachWorkItem(thread.id, '#14');

      const { item, error } = await orch.refreshWorkItem(thread.id);

      assert.equal(error, null);
      assert.equal(item?.snapshot.revision, attached.item?.snapshot.revision);
      assert.ok((item?.lastRefreshedAt ?? 0) >= (attached.item?.lastRefreshedAt ?? 0));
    });

    test('an unreachable source keeps the item it could not update', async () => {
      const { orch } = await boot(makeConfig());
      declare(workDir);
      const thread = orch.createThread({ cwd: workDir });
      await orch.attachWorkItem(thread.id, '#14');

      process.env['FAKE_GH_FAIL'] = 'offline';
      const { item, error } = await orch.refreshWorkItem(thread.id);

      assert.equal(error?.kind, 'offline');
      assert.equal(error?.retryable, true);
      assert.ok(item, 'the last known issue is still there to read');
    });
  });

  test('detaching leaves the runs that used the item in the log', async () => {
    const { orch } = await boot(makeConfig());
    declare(workDir);
    const thread = orch.createThread({ cwd: workDir });
    await orch.attachWorkItem(thread.id, '#14');
    await orch.send(thread.id, 'claude', 'start on this', true);

    orch.detachWorkItem(thread.id);

    assert.equal(orch.workItem(thread.id), null);
    assert.equal(runs(orch, thread.id).length, 1, 'a run that happened is not undone');
  });
});

describe('outcomes, evidence and retained context', () => {
  function declare(root: string): void {
    mkdirSync(join(root, '.awos'), { recursive: true });
    writeFileSync(
      join(root, WORKSPACE_FILE),
      JSON.stringify({
        version: WORKSPACE_SCHEMA_VERSION,
        name: 'under-test',
        repository: { github: 'sockulags/agentic-work-os' },
      }),
      'utf8',
    );
  }

  /** A thread with an issue attached and one run against it. */
  async function withRun(orch: Orchestrator, cwd: string) {
    declare(cwd);
    const thread = orch.createThread({ cwd });
    await orch.attachWorkItem(thread.id, '#14');
    await orch.send(thread.id, 'claude', 'start on this', true);

    const started = orch.store.events(thread.id).find((e) => e.kind === 'run.started');
    assert.ok(started?.kind === 'run.started');
    return { thread, runId: started.runId, workItemId: started.workItemId };
  }

  function ledger(orch: Orchestrator, threadId: string) {
    const events = orch.store.events(threadId);
    return {
      outcomes: foldOutcomes(events),
      evidence: foldEvidence(events),
      retained: foldRetained(events),
    };
  }

  test('a run can claim an outcome its terminal state cannot express', async () => {
    const { orch } = await boot(makeConfig());
    const { thread, runId } = await withRun(orch, workDir);

    // The turn ended cleanly. What the run achieved is a different question.
    const completed = orch.store.events(thread.id).find((e) => e.kind === 'run.completed');
    assert.equal(completed?.kind === 'run.completed' ? completed.state : null, 'completed');

    orch.closeRun(thread.id, runId, 'partial', 'the parser is done, the UI is not');

    const outcome = ledger(orch, thread.id).outcomes.get(runId);
    assert.equal(outcome?.claim, 'partial');
    assert.equal(outcome?.statement, 'the parser is done, the UI is not');
    assert.equal(outcome?.source, 'user');
  });

  test('a correction stands without erasing what it corrected', async () => {
    const { orch } = await boot(makeConfig());
    const { thread, runId } = await withRun(orch, workDir);

    orch.closeRun(thread.id, runId, 'delivered', 'done');
    orch.closeRun(thread.id, runId, 'partial', 'the tests were passing for the wrong reason');

    assert.equal(ledger(orch, thread.id).outcomes.get(runId)?.claim, 'partial');
    const claims = orch.store.events(thread.id).filter((e) => e.kind === 'run.closed');
    assert.equal(claims.length, 2, 'both claims are in the log, in the order they were made');
  });

  test('refuses to close a run this thread never started', async () => {
    const { orch } = await boot(makeConfig());
    const { thread } = await withRun(orch, workDir);

    assert.throws(() => orch.closeRun(thread.id, 'not-a-run', 'delivered', 'x'), /No run/);
  });

  test('evidence points at a fact in the log and the tree it applies to', async () => {
    const { orch } = await boot(makeConfig({ claudeBinArgs: [FAKE_CLAUDE, '--tool'] }));
    const cwd = makeRepo();
    const { thread, runId, workItemId } = await withRun(orch, cwd);

    const command = orch.store.events(thread.id).find((e) => e.kind === 'tool.completed');
    assert.ok(command, 'the run ran a command to point at');

    await orch.recordEvidence(thread.id, {
      runId,
      kind: 'command',
      ref: { eventId: command.id, url: null, label: 'echo hello' },
      summary: 'exit 0',
    });

    const [item] = ledger(orch, thread.id).evidence;
    assert.equal(item?.ref.eventId, command.id);
    assert.equal(item?.runId, runId);
    assert.equal(item?.workItemId, workItemId);
    // A claim about code is a claim about a particular tree, so the tree is captured.
    assert.match(item?.state.commit ?? '', /^[0-9a-f]{40}$/);
    assert.match(item?.state.tree ?? '', /^[0-9a-f]{40}$/);
  });

  test('evidence records whether the tree had uncommitted work in it', async () => {
    const { orch } = await boot(makeConfig());
    const cwd = makeRepo();
    const { thread, runId } = await withRun(orch, cwd);

    // Stand in for the agent's edit; the fakes stream events, they do not touch files.
    writeFileSync(join(cwd, 'changed.txt'), 'not committed\n');
    await orch.recordEvidence(thread.id, {
      runId,
      kind: 'note',
      ref: { eventId: null, url: null, label: 'by hand' },
      summary: 'checked it myself',
    });

    assert.equal(ledger(orch, thread.id).evidence[0]?.state.dirty, true);
  });

  test('an external link is evidence a person vouches for', async () => {
    const { orch } = await boot(makeConfig());
    const { thread, runId } = await withRun(orch, workDir);

    await orch.recordEvidence(thread.id, {
      runId,
      kind: 'link',
      ref: { eventId: null, url: 'https://example.com/ci/9', label: 'CI run 9' },
      summary: 'green',
    });

    const [item] = ledger(orch, thread.id).evidence;
    assert.equal(item?.ref.url, 'https://example.com/ci/9');
    assert.equal(item?.source, 'user');
    // Outside a repository there is no tree to name, and saying nothing beats guessing.
    assert.equal(item?.state.commit, null);
  });

  test('refuses evidence for a run this thread never started', async () => {
    const { orch } = await boot(makeConfig());
    const { thread } = await withRun(orch, workDir);

    await assert.rejects(
      () =>
        orch.recordEvidence(thread.id, {
          runId: 'not-a-run',
          kind: 'note',
          ref: { eventId: null, url: null, label: 'x' },
          summary: 'x',
        }),
      /No run/,
    );
  });

  describe('retained context', () => {
    test('is kept against the work item without touching the issue', async () => {
      const { orch } = await boot(makeConfig());
      const { thread, runId, workItemId } = await withRun(orch, workDir);

      orch.retainContext(thread.id, {
        kind: 'decision',
        text: 'gh, never a token of our own',
        runId,
      });

      const [item] = orch.retainedFor(thread.id);
      assert.equal(item?.text, 'gh, never a token of our own');
      assert.equal(item?.workItemId, workItemId);
      assert.equal(item?.runId, runId);
      assert.equal(item?.selected, true);
      // The issue itself is untouched: nothing here writes back to GitHub.
      assert.equal(orch.workItem(thread.id)?.snapshot.body, 'The issue body, as GitHub has it.');
    });

    test('reaches the next run on the same item', async () => {
      const { orch } = await boot(makeConfig());
      const { thread } = await withRun(orch, workDir);
      orch.retainContext(thread.id, { kind: 'constraint', text: 'no network in tests' });

      await orch.send(thread.id, 'claude', 'carry on', true);

      const runs = orch.store.events(thread.id).filter((e) => e.kind === 'run.started');
      const latest = runs[runs.length - 1];
      assert.ok(latest?.kind === 'run.started');
      assert.match(latest.context, /<retained-context>/);
      assert.match(latest.context, /no network in tests/);
    });

    test('is carried into a second thread working the same issue', async () => {
      const { orch } = await boot(makeConfig());
      const { thread } = await withRun(orch, workDir);
      orch.retainContext(thread.id, { kind: 'discovery', text: 'gh exits 1 for everything' });

      // A different conversation, the same issue: the second thread must not start out
      // ignorant of what the first one established.
      const second = orch.createThread({ cwd: workDir });
      await orch.attachWorkItem(second.id, '#14');
      await orch.send(second.id, 'codex', 'pick this up', true);

      assert.equal(orch.retainedFor(second.id).length, 1);
      const started = orch.store.events(second.id).find((e) => e.kind === 'run.started');
      assert.match(started?.kind === 'run.started' ? started.context : '', /gh exits 1 for everything/);
    });

    test('dropping it from the context leaves the record and its history', async () => {
      const { orch } = await boot(makeConfig());
      const { thread } = await withRun(orch, workDir);
      orch.retainContext(thread.id, { kind: 'decision', text: 'a decision we changed our minds about' });
      const [item] = orch.retainedFor(thread.id);
      assert.ok(item);

      orch.amendRetained(thread.id, item.id, { selected: false, retired: true });

      const [after] = orch.retainedFor(thread.id);
      assert.equal(after?.text, item.text, 'an amendment cannot rewrite the words');
      assert.equal(after?.selected, false);
      assert.equal(after?.retired, true);
      assert.equal(
        orch.store.events(thread.id).filter((e) => e.kind === 'context.retained').length,
        2,
        'both versions are in the log',
      );

      await orch.send(thread.id, 'claude', 'carry on', true);
      const runs = orch.store.events(thread.id).filter((e) => e.kind === 'run.started');
      const latest = runs[runs.length - 1];
      assert.doesNotMatch(
        latest?.kind === 'run.started' ? latest.context : '',
        /changed our minds/,
      );
    });

    test('an agent keeps something by writing a line, the way it publishes an artifact', async () => {
      const { orch } = await boot(makeConfig());
      declare(workDir);
      const thread = orch.createThread({ cwd: workDir });
      await orch.attachWorkItem(thread.id, '#14');

      mkdirSync(join(workDir, '.awos'), { recursive: true });
      writeFileSync(
        join(workDir, RETAINED_FILE),
        `${JSON.stringify({ kind: 'discovery', text: 'the CLI reports rate limits as exit 1' })}\n` +
          'this line is not JSON and must not stop the next one\n' +
          `${JSON.stringify({ kind: 'nonsense', text: 'an unknown kind is skipped' })}\n` +
          `${JSON.stringify({ kind: 'question', text: 'who owns the rate limit?' })}\n`,
        'utf8',
      );

      await orch.send(thread.id, 'claude', 'go', true);

      const kept = orch.retainedFor(thread.id);
      assert.deepEqual(
        kept.map((entry) => entry.kind).sort(),
        ['discovery', 'question'],
      );
      assert.equal(kept[0]?.source, 'claude', 'attributed to the agent that wrote it');
    });

    test('reading the file again adds nothing, so a restart cannot duplicate it', async () => {
      const config = makeConfig();
      const { orch } = await boot(config);
      declare(workDir);
      const thread = orch.createThread({ cwd: workDir });
      await orch.attachWorkItem(thread.id, '#14');
      mkdirSync(join(workDir, '.awos'), { recursive: true });
      writeFileSync(
        join(workDir, RETAINED_FILE),
        `${JSON.stringify({ kind: 'decision', text: 'written once' })}\n`,
        'utf8',
      );

      await orch.send(thread.id, 'claude', 'first', true);
      await orch.send(thread.id, 'claude', 'second', true);
      await orch.stop();
      orchestrator = null;

      const revived = new Orchestrator(config);
      await revived.start();
      orchestrator = revived;
      await revived.send(thread.id, 'claude', 'after a restart', true);

      assert.equal(revived.retainedFor(thread.id).length, 1);
    });
  });

  test('the ledger survives a restart, still linked to its run and its issue', async () => {
    const config = makeConfig();
    const { orch } = await boot(config);
    const { thread, runId, workItemId } = await withRun(orch, workDir);
    orch.closeRun(thread.id, runId, 'delivered', 'the boundary is done');
    await orch.recordEvidence(thread.id, {
      runId,
      kind: 'link',
      ref: { eventId: null, url: 'https://example.com/ci/9', label: 'CI run 9' },
      summary: 'green',
    });
    orch.retainContext(thread.id, { kind: 'decision', text: 'gh, never a token of our own' });
    await orch.stop();
    orchestrator = null;

    const revived = new Orchestrator(config);
    await revived.start();
    orchestrator = revived;

    const after = ledger(revived, thread.id);
    assert.equal(after.outcomes.get(runId)?.claim, 'delivered');
    assert.equal(after.evidence[0]?.runId, runId);
    assert.equal(after.evidence[0]?.workItemId, workItemId);
    assert.equal(after.evidence[0]?.ref.url, 'https://example.com/ci/9');
    const [kept] = revived.retainedFor(thread.id);
    assert.equal(kept?.workItemId, workItemId);
    assert.equal(kept?.text, 'gh, never a token of our own');
  });
});

describe('the integration gate', () => {
  const TEST_COMMAND = `node -e "require('fs').writeFileSync('ran-test.txt','yes')"`;
  const FAIL_COMMAND = 'node -e "process.exit(1)"';

  /**
   * A workspace whose checks are node one-liners.
   *
   * `pass` writes a marker so a test can prove the command really ran; `fail` exits
   * non-zero the way a broken suite does.
   */
  function declare(root: string, integration: Record<string, unknown>): void {
    mkdirSync(join(root, '.awos'), { recursive: true });
    writeFileSync(
      join(root, WORKSPACE_FILE),
      JSON.stringify({
        version: 2,
        name: 'under-test',
        verify: [
          { name: 'test', command: TEST_COMMAND },
          { name: 'fail', command: FAIL_COMMAND },
        ],
        integration,
      }),
      'utf8',
    );
  }

  function declareLocal(root: string, declaration: Record<string, unknown>): void {
    mkdirSync(join(root, dirname(WORKSPACE_LOCAL_FILE)), { recursive: true });
    writeFileSync(
      join(root, WORKSPACE_LOCAL_FILE),
      JSON.stringify({ version: 2, ...declaration }),
      'utf8',
    );
  }

  function expectationSet(orch: Orchestrator, threadId: string) {
    const created = orch.store.events(threadId).find((event) => event.kind === 'expectation.set.created');
    assert.ok(created?.kind === 'expectation.set.created');
    return created.expectationSet;
  }

  function sourceReference(orch: Orchestrator, threadId: string) {
    const set = expectationSet(orch, threadId);
    const reference = set.items[0]?.reference;
    assert.ok(reference);
    return { set, reference };
  }

  /** A thread in lanes mode with a lane provisioned for Claude and work in it. */
  async function laneWithWork(orch: Orchestrator, cwd: string) {
    const thread = orch.createThread({ cwd });
    await orch.setParallel(thread.id, true);
    await orch.send(thread.id, 'claude', 'provision the lane');

    const lane = orch.state(thread.id).lanes.claude;
    assert.ok(lane);
    // Stand in for the agent's edit: the fakes stream events, they do not touch files.
    writeFileSync(join(lane, 'from-the-lane.txt'), 'work\n');
    return { thread, lane };
  }

  function gateEvents(orch: Orchestrator, threadId: string) {
    return orch.store.events(threadId).filter((e) => e.kind === 'gate.evaluated');
  }

  test('evaluates attached schema-v3 guardrails together with reserved verification during integration', async () => {
    const { orch } = await boot(makeConfig());
    const cwd = makeRepo();
    mkdirSync(join(cwd, '.awos'), { recursive: true });
    writeFileSync(join(cwd, WORKSPACE_FILE), JSON.stringify({
      version: WORKSPACE_SCHEMA_VERSION,
      name: 'v3-integration',
      verify: [{ name: 'test', command: TEST_COMMAND }],
      integration: { requires: ['test'], allowOverride: false },
      roles: [
        { id: 'lane-owner', label: 'Lane owner' },
        { id: 'workspace-owner', label: 'Workspace owner' },
      ],
      steps: [
        { id: 'lane', action: 'Lane', role: 'lane-owner', workers: ['codex'] },
        { id: 'workspace', action: 'Workspace', role: 'workspace-owner', workers: ['codex'] },
      ],
      guardrails: [{
        id: 'evidence',
        kind: 'evidence-present',
        attach: { from: 'lane', to: 'workspace' },
        enforcement: 'required',
        parameters: { expectationItem: 'scope', evidenceKind: 'command' },
      }],
    }), 'utf8');
    execFileSync('git', ['add', WORKSPACE_FILE], { cwd });
    execFileSync('git', ['commit', '-qm', 'workspace guardrails'], { cwd });

    const { thread } = await laneWithWork(orch, cwd);
    await orch.runCheck(thread.id, 'claude', 'test');
    const result = await orch.integrateLane(thread.id, 'claude');
    assert.equal(result.ok, true, result.detail);
    const evaluated = orch.store.events(thread.id).find((event) => event.kind === 'gate.evaluated');
    assert.ok(evaluated?.kind === 'gate.evaluated');
    assert.equal(evaluated.evaluation?.verdict, 'passed');
    assert.deepEqual(
      evaluated.evaluation?.facts.map((fact) => [fact.requirementId, fact.provenance.evaluatorKind]),
      [['scope', 'evidence-present'], ['test', 'verification']],
    );
    assert.ok(evaluated.evaluation?.facts.every((fact) => fact.provenance.expectationSetId === evaluated.evaluation?.expectationSetId));
    const set = orch.store.events(thread.id).find((event) => event.kind === 'expectation.set.created');
    assert.ok(set?.kind === 'expectation.set.created');
    assert.ok(set.expectationSet.items.every((item) => item.reference.locator.includes(resolvePath(cwd, WORKSPACE_FILE))));
  });

  test('a schema-v3 guardrail can deny an override allowed by legacy integration policy', async () => {
    const { orch } = await boot(makeConfig());
    const cwd = makeRepo();
    mkdirSync(join(cwd, '.awos'), { recursive: true });
    writeFileSync(join(cwd, WORKSPACE_FILE), JSON.stringify({
      version: WORKSPACE_SCHEMA_VERSION,
      name: 'v3-override-policy',
      verify: [
        { name: 'test', command: TEST_COMMAND },
        { name: 'fail', command: FAIL_COMMAND },
      ],
      integration: { requires: ['test'], allowOverride: true },
      roles: [
        { id: 'lane-owner', label: 'Lane owner' },
        { id: 'workspace-owner', label: 'Workspace owner' },
      ],
      steps: [
        { id: 'lane', action: 'Lane', role: 'lane-owner', workers: ['codex'] },
        { id: 'workspace', action: 'Workspace', role: 'workspace-owner', workers: ['codex'] },
      ],
      guardrails: [{
        id: 'locked-check',
        kind: 'verification',
        attach: { from: 'lane', to: 'workspace' },
        enforcement: 'required',
        allowOverride: false,
        parameters: { checks: ['fail'] },
      }],
    }), 'utf8');
    execFileSync('git', ['add', WORKSPACE_FILE], { cwd });
    execFileSync('git', ['commit', '-qm', 'workspace override policy'], { cwd });

    const { thread } = await laneWithWork(orch, cwd);
    await orch.runCheck(thread.id, 'claude', 'test');
    await orch.runCheck(thread.id, 'claude', 'fail');
    const result = await orch.integrateLane(thread.id, 'claude', {
      actor: 'user',
      reason: 'reviewed the failing check',
    });

    assert.equal(result.ok, false);
    const evaluated = orch.store.events(thread.id).find((event) => event.kind === 'gate.evaluated');
    assert.ok(evaluated?.kind === 'gate.evaluated');
    assert.equal(evaluated.evaluation?.verdict, 'blocked');
    assert.match(evaluated.evaluation?.refusal?.reason ?? '', /does not permit/);
    assert.deepEqual(
      evaluated.evaluation?.enforcement.map((entry) => [entry.requirementId, entry.allowOverride]),
      [['fail', false], ['test', true]],
    );
    assert.equal(existsSync(join(cwd, 'from-the-lane.txt')), false, 'the refused override applies nothing');
  });

  test('an unverified lane is refused, and the target directory is untouched', async () => {
    const { orch } = await boot(makeConfig());
    const cwd = makeRepo();
    declare(cwd, { requires: ['test'] });
    const { thread } = await laneWithWork(orch, cwd);

    const result = await orch.integrateLane(thread.id, 'claude');

    assert.equal(result.ok, false);
    assert.match(result.detail, /test has not been run/);
    assert.equal(existsSync(join(cwd, 'from-the-lane.txt')), false, 'nothing was applied');

    const evaluated = gateEvents(orch, thread.id)[0];
    assert.ok(evaluated?.kind === 'gate.evaluated');
    assert.equal(evaluated.allowed, false);
    assert.equal(evaluated.requirements[0]?.name, 'test');
    assert.equal(evaluated.requirements[0]?.state, 'missing');
    // The record names the content it judged, not just the moment it judged it.
    assert.match(evaluated.candidate.tree ?? '', /^[0-9a-f]{40}$/);
  });

  test('records the shared transition evaluation before applying the lane patch', async () => {
    const { orch } = await boot(makeConfig());
    const cwd = makeRepo();
    declare(cwd, { requires: ['test'] });
    const { thread } = await laneWithWork(orch, cwd);
    const target = join(cwd, 'from-the-lane.txt');
    let targetExistedWhenEvaluated: boolean | null = null;
    orch.on('event', (event: HarnessEvent) => {
      if (event.kind === 'gate.evaluated') {
        targetExistedWhenEvaluated = existsSync(target);
        assert.ok(event.evaluation, 'new integration events carry the shared evaluation');
        assert.equal(event.evaluation.verdict, 'retry');
        assert.equal(event.evaluation.attempt, 1);
        assert.equal(event.evaluation.sourceStepId, 'lane');
        assert.equal(event.evaluation.targetStepId, 'workspace');
      }
    });

    const result = await orch.integrateLane(thread.id, 'claude');

    assert.equal(result.ok, false);
    assert.equal(targetExistedWhenEvaluated, false);
    assert.equal(existsSync(target), false);
    const latest = [...foldTransitionEvaluations(orch.store.events(thread.id)).values()][0];
    assert.equal(latest?.verdict, 'retry');
    assert.equal(latest?.refusal?.nextAction, 'provide-evidence');
  });

  test('refuses when the lane changes after a passing evaluation, before applying anything', async () => {
    const { orch } = await boot(makeConfig());
    const cwd = makeRepo();
    declare(cwd, { requires: ['test'] });
    const { thread, lane } = await laneWithWork(orch, cwd);
    await orch.runCheck(thread.id, 'claude', 'test');
    const target = join(cwd, 'from-the-lane.txt');
    let changed = false;
    orch.on('event', (event: HarnessEvent) => {
      if (event.kind !== 'gate.evaluated' || changed) return;
      changed = true;
      writeFileSync(join(lane, 'from-the-lane.txt'), 'changed after evaluation\n');
    });

    const result = await orch.integrateLane(thread.id, 'claude');

    assert.equal(result.ok, false);
    assert.equal(changed, true);
    assert.match(result.detail, /changed after evaluation/);
    assert.equal(existsSync(target), false, 'the target stayed untouched after the mismatch');
    assert.equal(readFileSync(join(lane, 'from-the-lane.txt'), 'utf8'), 'changed after evaluation\n');
    assert.equal(gateEvents(orch, thread.id).at(-1)?.kind, 'gate.evaluated');
  });

  test('pins base-only integration and verification to the base declaration', async () => {
    const { orch } = await boot(makeConfig());
    const cwd = makeRepo();
    declare(cwd, { requires: ['test'] });
    const { thread } = await laneWithWork(orch, cwd);
    await orch.runCheck(thread.id, 'claude', 'test');

    assert.equal((await orch.integrateLane(thread.id, 'claude')).ok, true);
    const { set, reference } = sourceReference(orch, thread.id);
    assert.equal(reference.locator, resolvePath(cwd, WORKSPACE_FILE));
    assert.match(reference.nativeRevision, /origins:integration=shared,verify=shared/);
    assert.match(reference.contentDigest, /^[0-9a-f]{40}$/);
    assert.notEqual(reference.nativeRevision, set.manifestDigest);
    assert.notEqual(reference.contentDigest, set.manifestDigest);
  });

  test('pins local-only effective integration and verification to the local declaration', async () => {
    const { orch } = await boot(makeConfig());
    const cwd = makeRepo();
    declare(cwd, { requires: ['fail'] });
    declareLocal(cwd, {
      verify: [{ name: 'test', command: TEST_COMMAND }],
      integration: { requires: ['test'] },
    });
    const { thread } = await laneWithWork(orch, cwd);
    await orch.runCheck(thread.id, 'claude', 'test');

    assert.equal((await orch.integrateLane(thread.id, 'claude')).ok, true);
    const { reference } = sourceReference(orch, thread.id);
    assert.equal(reference.locator, resolvePath(cwd, WORKSPACE_LOCAL_FILE));
    assert.match(reference.nativeRevision, /origins:integration=local,verify=local/);
  });

  test('records both sources for a genuinely combined effective contract', async () => {
    const { orch } = await boot(makeConfig());
    const cwd = makeRepo();
    declare(cwd, { requires: ['test'] });
    declareLocal(cwd, {
      verify: [{ name: 'test', command: TEST_COMMAND }],
    });
    const { thread } = await laneWithWork(orch, cwd);
    await orch.runCheck(thread.id, 'claude', 'test');

    assert.equal((await orch.integrateLane(thread.id, 'claude')).ok, true);
    const { reference } = sourceReference(orch, thread.id);
    assert.equal(
      reference.locator,
      `${resolvePath(cwd, WORKSPACE_FILE)}|${resolvePath(cwd, WORKSPACE_LOCAL_FILE)}`,
    );
    assert.match(reference.nativeRevision, /origins:integration=shared,verify=local/);
    assert.match(reference.nativeRevision, /sources:[0-9a-f]{40},[0-9a-f]{40}/);
  });

  test('keeps source and manifest identity stable across unchanged resolution', async () => {
    const { orch } = await boot(makeConfig());
    const cwd = makeRepo();
    declare(cwd, { requires: ['test'] });
    const { thread } = await laneWithWork(orch, cwd);
    await orch.runCheck(thread.id, 'claude', 'test');

    assert.equal((await orch.integrateLane(thread.id, 'claude')).ok, true);
    const first = sourceReference(orch, thread.id);
    assert.equal((await orch.integrateLane(thread.id, 'claude')).ok, true);
    const second = sourceReference(orch, thread.id);

    assert.deepEqual(second, first);
    assert.equal(
      orch.store.events(thread.id).filter((event) => event.kind === 'expectation.set.created').length,
      1,
    );
  });

  test('replays the latest transition result and pinned expectation after restart', async () => {
    const { orch } = await boot(makeConfig());
    const cwd = makeRepo();
    declare(cwd, { requires: ['test'] });
    const { thread } = await laneWithWork(orch, cwd);
    await orch.integrateLane(thread.id, 'claude');

    const before = foldTransitionEvaluations(orch.store.events(thread.id)).values().next().value;
    assert.ok(before);
    await orch.stop();
    orchestrator = null;

    const revived = new Orchestrator(makeConfig());
    await revived.start();
    orchestrator = revived;
    const after = foldTransitionEvaluations(revived.store.events(thread.id)).values().next().value;

    assert.deepEqual(after, before);
    assert.equal(after?.attempt, 1);
    assert.equal(after?.expectationSetId, before.expectationSetId);
    assert.equal(after?.refusal?.reason, before.refusal?.reason);
  });

  test('a verified lane integrates, all of it', async () => {
    const { orch } = await boot(makeConfig());
    const cwd = makeRepo();
    declare(cwd, { requires: ['test'] });
    const { thread, lane } = await laneWithWork(orch, cwd);

    const check = await orch.runCheck(thread.id, 'claude', 'test');
    assert.equal(check.passed, true);
    // The command ran in the lane, which is where the work is.
    assert.equal(existsSync(join(lane, 'ran-test.txt')), true);

    const result = await orch.integrateLane(thread.id, 'claude');

    assert.equal(result.ok, true, result.detail);
    assert.equal(readFileSync(join(cwd, 'from-the-lane.txt'), 'utf8'), 'work\n');
    const evaluated = gateEvents(orch, thread.id).pop();
    assert.equal(evaluated?.kind === 'gate.evaluated' ? evaluated.allowed : null, true);
  });

  test('a failing check blocks and says so', async () => {
    const { orch } = await boot(makeConfig());
    const cwd = makeRepo();
    declare(cwd, { requires: ['fail'] });
    const { thread } = await laneWithWork(orch, cwd);

    const check = await orch.runCheck(thread.id, 'claude', 'fail');
    assert.equal(check.passed, false);

    const result = await orch.integrateLane(thread.id, 'claude');
    assert.equal(result.ok, false);
    assert.match(result.detail, /fail failed/);
    assert.equal(existsSync(join(cwd, 'from-the-lane.txt')), false);
  });

  test('a pass goes stale when the lane changes under it', async () => {
    const { orch } = await boot(makeConfig());
    const cwd = makeRepo();
    declare(cwd, { requires: ['test'] });
    const { thread, lane } = await laneWithWork(orch, cwd);
    await orch.runCheck(thread.id, 'claude', 'test');

    // The agent keeps working after the check. This is the case a prompt instruction
    // cannot catch: the tests really did pass, just not on this.
    writeFileSync(join(lane, 'later-edit.txt'), 'after the check\n');

    const result = await orch.integrateLane(thread.id, 'claude');

    assert.equal(result.ok, false);
    assert.match(result.detail, /passed against different content/);
    const evaluated = gateEvents(orch, thread.id).pop();
    assert.ok(evaluated?.kind === 'gate.evaluated');
    assert.equal(evaluated.requirements[0]?.state, 'stale');
    assert.notEqual(evaluated.requirements[0]?.evidenceTree, evaluated.candidate.tree);
  });

  test('running the check again on the new content unblocks it', async () => {
    const { orch } = await boot(makeConfig());
    const cwd = makeRepo();
    declare(cwd, { requires: ['test'] });
    const { thread, lane } = await laneWithWork(orch, cwd);
    await orch.runCheck(thread.id, 'claude', 'test');
    writeFileSync(join(lane, 'later-edit.txt'), 'after the check\n');
    assert.equal((await orch.integrateLane(thread.id, 'claude')).ok, false);

    await orch.runCheck(thread.id, 'claude', 'test');
    const result = await orch.integrateLane(thread.id, 'claude');

    assert.equal(result.ok, true, result.detail);
    assert.equal(existsSync(join(cwd, 'later-edit.txt')), true);
  });

  test('a check result is evidence, bound to the tree it ran against', async () => {
    const { orch } = await boot(makeConfig());
    const cwd = makeRepo();
    declare(cwd, { requires: ['test'] });
    const { thread } = await laneWithWork(orch, cwd);

    await orch.runCheck(thread.id, 'claude', 'test');

    const [item] = foldEvidence(orch.store.events(thread.id));
    assert.equal(item?.check?.name, 'test');
    assert.equal(item?.check?.passed, true);
    assert.equal(item?.kind, 'command');
    assert.match(item?.ref.label ?? '', /^node -e/);
    assert.match(item?.state.tree ?? '', /^[0-9a-f]{40}$/);
    const evaluated = (await orch.gate(thread.id, 'claude')).candidate;
    assert.equal(item?.state.tree, evaluated.tree, 'the evidence names the candidate itself');
  });

  test('a project that requires nothing integrates as it always did', async () => {
    const { orch } = await boot(makeConfig());
    const cwd = makeRepo();
    declare(cwd, {});
    const { thread } = await laneWithWork(orch, cwd);

    const result = await orch.integrateLane(thread.id, 'claude');

    assert.equal(result.ok, true, result.detail);
    const evaluated = gateEvents(orch, thread.id)[0];
    assert.equal(evaluated?.kind === 'gate.evaluated' ? evaluated.requirements.length : -1, 0);
  });

  describe('override', () => {
    test('is refused outright where the project has not permitted one', async () => {
      const { orch } = await boot(makeConfig());
      const cwd = makeRepo();
      declare(cwd, { requires: ['test'] });
      const { thread } = await laneWithWork(orch, cwd);

      await assert.rejects(
        () => orch.integrateLane(thread.id, 'claude', { actor: 'user', reason: 'trust me' }),
        /does not permit overriding/,
      );
      assert.equal(existsSync(join(cwd, 'from-the-lane.txt')), false);
      const evaluated = gateEvents(orch, thread.id).pop();
      assert.equal(evaluated?.kind === 'gate.evaluated' ? evaluated.evaluation?.verdict : null, 'failed');
      assert.equal(evaluated?.kind === 'gate.evaluated' ? evaluated.evaluation?.refusal?.retryable : null, true);
    });

    test('where permitted, it applies the work and records who said what', async () => {
      const { orch } = await boot(makeConfig());
      const cwd = makeRepo();
      declare(cwd, { requires: ['fail'], allowOverride: true });
      const { thread } = await laneWithWork(orch, cwd);
      const check = await orch.runCheck(thread.id, 'claude', 'fail');
      assert.equal(check.passed, false);

      const result = await orch.integrateLane(thread.id, 'claude', {
        actor: 'user',
        reason: 'the suite is broken on main, verified by hand',
      });

      assert.equal(result.ok, true, result.detail);
      assert.equal(readFileSync(join(cwd, 'from-the-lane.txt'), 'utf8'), 'work\n');

      const evaluated = gateEvents(orch, thread.id).pop();
      assert.ok(evaluated?.kind === 'gate.evaluated');
      assert.equal(evaluated.allowed, true);
      assert.equal(evaluated.override?.actor, 'user');
      assert.match(evaluated.override?.reason ?? '', /broken on main/);
      // What was bypassed is in the same record as the bypass.
      assert.equal(evaluated.requirements[0]?.state, 'failed');
    });

    test('has to say why', async () => {
      const { orch } = await boot(makeConfig());
      const cwd = makeRepo();
      declare(cwd, { requires: ['test'], allowOverride: true });
      const { thread } = await laneWithWork(orch, cwd);

      await assert.rejects(
        () => orch.integrateLane(thread.id, 'claude', { actor: 'user', reason: '  ' }),
        /has to say why/,
      );
    });
  });

  test('refuses to run a check the workspace does not declare', async () => {
    const { orch } = await boot(makeConfig());
    const cwd = makeRepo();
    declare(cwd, { requires: ['test'] });
    const { thread } = await laneWithWork(orch, cwd);

    await assert.rejects(() => orch.runCheck(thread.id, 'claude', 'nope'), /No verification command/);
  });

  test('the gate reads the same before integrating as it does during', async () => {
    const { orch } = await boot(makeConfig());
    const cwd = makeRepo();
    declare(cwd, { requires: ['test'] });
    const { thread } = await laneWithWork(orch, cwd);

    const before = await orch.gate(thread.id, 'claude');
    assert.equal(before.allowed, false);
    assert.equal(before.requirements[0]?.state, 'missing');

    await orch.runCheck(thread.id, 'claude', 'test');
    const after = await orch.gate(thread.id, 'claude');

    assert.equal(after.allowed, true);
    assert.equal((await orch.integrateLane(thread.id, 'claude')).ok, true);
  });
});
