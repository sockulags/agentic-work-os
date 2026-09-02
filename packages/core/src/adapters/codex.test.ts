import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AdapterEvent } from '@awos/protocol';
import {
  CodexAdapter,
  itemType,
  classifyCodexItem,
  summarizeCodexItem,
  codexItemOutput,
  extractCodexPlan,
  describeCodexApproval,
} from './codex.js';
import type { AdapterContext, ArmDeadline } from './agent.js';
import type { HarnessConfig } from '../config.js';

describe('itemType', () => {
  test('accepts either field name Codex has used', () => {
    assert.equal(itemType({ id: '1', type: 'CommandExecution' }), 'commandexecution');
    assert.equal(itemType({ id: '1', itemType: 'FileChange' }), 'filechange');
  });

  test('returns unknown rather than throwing on a bare item', () => {
    assert.equal(itemType({ id: '1' }), 'unknown');
  });
});

describe('classifyCodexItem', () => {
  test('classifies by substring so version drift does not break it', () => {
    assert.equal(classifyCodexItem('commandexecution'), 'command');
    assert.equal(classifyCodexItem('localshellcall'), 'command');
    assert.equal(classifyCodexItem('filechange'), 'file_edit');
    assert.equal(classifyCodexItem('applypatch'), 'file_edit');
    assert.equal(classifyCodexItem('mcptoolcall'), 'mcp');
    assert.equal(classifyCodexItem('websearch'), 'web');
    assert.equal(classifyCodexItem('somethingelse'), 'other');
  });
});

describe('summarizeCodexItem', () => {
  test('joins an argv-array command', () => {
    assert.equal(
      summarizeCodexItem({ id: '1', command: ['cargo', 'test', '--all'] }),
      'cargo test --all',
    );
  });

  test('passes a string command through', () => {
    assert.equal(summarizeCodexItem({ id: '1', command: 'ls -la' }), 'ls -la');
  });

  test('names a single changed file', () => {
    assert.equal(
      summarizeCodexItem({ id: '1', changes: [{ path: 'src/a.rs' }] }),
      'edit src/a.rs',
    );
  });

  test('counts and truncates many changed files', () => {
    const changes = ['a', 'b', 'c', 'd'].map((p) => ({ path: p }));
    assert.equal(summarizeCodexItem({ id: '1', changes }), 'edit 4 files: a, b, c…');
  });

  test('qualifies an MCP tool with its server', () => {
    assert.equal(
      summarizeCodexItem({ id: '1', name: 'create_issue', server: 'github' }),
      'github/create_issue',
    );
  });
});

describe('codexItemOutput', () => {
  test('prefers aggregated output', () => {
    assert.equal(
      codexItemOutput({ id: '1', aggregatedOutput: 'all of it', output: 'partial' }),
      'all of it',
    );
  });

  test('renders file changes as a readable patch', () => {
    const text = codexItemOutput({
      id: '1',
      changes: [{ path: 'a.ts', diff: '@@ -1 +1 @@\n-old\n+new' }],
    });
    assert.equal(text, '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new');
    assert.match(text, /^--- a\/a\.ts\n\+\+\+ b\/a\.ts\n@@ /);
  });

  test('renders additions with a /dev/null source header', () => {
    assert.equal(
      codexItemOutput({
        id: '1',
        changes: [{ path: 'new.ts', kind: 'ADDED', diff: '@@ -0,0 +1 @@\n+new' }],
      }),
      '--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+new',
    );
  });

  test('renders deletions with a /dev/null destination header', () => {
    assert.equal(
      codexItemOutput({
        id: '1',
        changes: [{ path: 'old.ts', kind: 'DELETED', diff: '@@ -1 +0,0 @@\n-old' }],
      }),
      '--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old',
    );
  });

  test('preserves changed-without-diff output', () => {
    assert.equal(codexItemOutput({ id: '1', changes: [{ path: 'a.ts' }] }), 'changed a.ts');
  });

  test('serializes a structured result', () => {
    assert.match(codexItemOutput({ id: '1', result: { ok: true } }), /"ok": true/);
  });

  test('returns empty string when there is nothing to show', () => {
    assert.equal(codexItemOutput({ id: '1' }), '');
  });
});

/** One machine config for the adapter tests; overrides carry whatever a case is about. */
function codexTestConfig(
  dir: string,
  server: string,
  overrides: Partial<HarnessConfig> = {},
): HarnessConfig {
  return {
    dataDir: dir,
    claudeBin: process.execPath,
    codexBin: process.execPath,
    claudeBinArgs: [],
    codexBinArgs: [server],
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

describe('CodexAdapter diff updates', () => {
  test('emits an empty snapshot so it supersedes a previous diff', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awos-codex-adapter-'));
    const server = join(dir, 'server.mjs');
    writeFileSync(
      server,
      String.raw`const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    if (message.method === 'thread/start') {
      emit({ id: message.id, result: { thread: { id: 'thread-1' } } });
      emit({ method: 'thread/started', params: { thread: { id: 'thread-1' } } });
    }
    if (message.method === 'turn/start') {
      emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
      emit({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });
      emit({ method: 'turn/diff/updated', params: { diff: 'diff --git a/a.ts b/a.ts' } });
      emit({ method: 'turn/diff/updated', params: { diff: '' } });
      emit({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));`,
      'utf8',
    );

    const events: AdapterEvent[] = [];
    const config = codexTestConfig(dir, server);
    const adapter = new CodexAdapter({
      threadId: 'thread-1',
      cwd: dir,
      config,
      permissionMode: 'default',
      permissionBridge: {} as AdapterContext['permissionBridge'],
      resumeSessionId: null,
      emit: (event) => events.push(event),
      onSessionId: () => {},
    });

    try {
      await adapter.sendTurn('revert it');
      const diffs = events.filter(
        (event): event is Extract<AdapterEvent, { kind: 'diff.updated' }> =>
          event.kind === 'diff.updated',
      );
      assert.deepEqual(
        diffs.map((event) => event.patch),
        ['diff --git a/a.ts b/a.ts', ''],
      );
    } finally {
      await adapter.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Poll until `check` holds, rather than sleeping a guessed interval.
 *
 * The timeout is a failsafe on a hang: everything waited for below happens within
 * milliseconds of being asked for, and no case decides anything on how long it took.
 */
async function until(label: string, check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * A wait nothing in the case itself bounds: the server ends the turn, or the adapter's own
 * clock does.
 *
 * The timer is a failsafe on a wedged turn rather than something a case decides on — what
 * is waited for here arrives in milliseconds. Without it a turn that never ends would hang
 * the run instead of failing it.
 */
function settles(label: string, work: Promise<void>): Promise<void> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 10_000).unref();
    }),
  ]);
}

/**
 * The turn watchdog under the case's control rather than the clock's.
 *
 * The adapter arms its deadline here and nothing fires it until a case says so. That is
 * what tells the turn meant to hang apart from the turn meant to finish: a real deadline
 * short enough to keep the suite quick also expires on a healthy turn once the machine is
 * loaded, and the two turns then differ by the runner's speed rather than by anything the
 * case did.
 */
function manualDeadlines() {
  const armed: Array<{ ms: number; fire: () => void; cancelled: boolean }> = [];

  const arm: ArmDeadline = (fire, ms) => {
    const deadline = { ms, fire, cancelled: false };
    armed.push(deadline);
    return () => {
      deadline.cancelled = true;
    };
  };

  /** The nth deadline the adapter armed, 1-based, once it has armed it. */
  const nth = async (n: number) => {
    await until(`the adapter to arm deadline ${n}`, () => armed.length >= n);
    return armed[n - 1]!;
  };

  /** Fires the nth deadline, as the clock would have. */
  const fire = async (n: number): Promise<void> => {
    const deadline = await nth(n);
    assert.equal(deadline.cancelled, false, `deadline ${n} was already cancelled`);
    deadline.fire();
  };

  return { arm, nth, fire };
}

/** Boilerplate every abandoned-turn case repeats: handshake, thread, and a turn counter. */
function codexTurnServer(body: string): string {
  return String.raw`import { appendFileSync } from 'node:fs';

// Collected and written in one go at the end of the chunk, because that is what Codex
// on a pipe looks like: the acceptance and the notifications that follow it arrive in a
// single read, and every line of a read is handled before an awaiting continuation gets
// to run. Writing a line at a time would hide the ordering CI actually gets.
const out = [];
const emit = (value) => out.push(JSON.stringify(value));
const flush = () => {
  if (out.length === 0) return;
  process.stdout.write(out.join('\n') + '\n');
  out.length = 0;
};
let buffer = '';
let turns = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    if (message.method === 'thread/start') {
      emit({ id: message.id, result: { thread: { id: 'thread-1' } } });
    }
    if (message.method === 'turn/interrupt') {
      // Recorded, and deliberately not acted on: a server that acknowledges an interrupt
      // and keeps going is what the bookkeeping has to survive.
      appendFileSync(
        new URL('interrupts.jsonl', import.meta.url),
        JSON.stringify(message.params) + '\n',
      );
      emit({ id: message.id, result: {} });
    }
    if (message.method === 'turn/start') {
      turns += 1;
      const turnId = 'turn-' + turns;
      emit({ id: message.id, result: { turn: { id: turnId } } });
` + body + String.raw`
    }
  }
  flush();
});
process.stdin.on('end', () => process.exit(0));`;
}

/**
 * One adapter over a fake server: a typed reader for what it emitted, a wait for the
 * event that says the server has been heard, and the turn deadline it armed.
 */
function codexHarness(dir: string, server: string, overrides: Partial<HarnessConfig> = {}) {
  const events: AdapterEvent[] = [];
  const deadlines = manualDeadlines();
  const adapter = new CodexAdapter({
    threadId: 'thread-1',
    cwd: dir,
    config: codexTestConfig(dir, server, overrides),
    permissionMode: 'default',
    permissionBridge: {} as AdapterContext['permissionBridge'],
    resumeSessionId: null,
    armTurnDeadline: deadlines.arm,
    emit: (event) => events.push(event),
    onSessionId: () => {},
  });

  const of = <K extends AdapterEvent['kind']>(
    kind: K,
  ): Array<Extract<AdapterEvent, { kind: K }>> =>
    events.filter((event): event is Extract<AdapterEvent, { kind: K }> => event.kind === kind);

  /**
   * Waits for an event of this kind.
   *
   * The server's lines are read in order, so an event is also evidence that everything
   * sent before it has been handled — which is how a case fires a deadline against a turn
   * that has provably already seen what the server said.
   */
  const waitFor = (kind: AdapterEvent['kind']): Promise<void> =>
    until(`a ${kind} event`, () => events.some((event) => event.kind === kind));

  return { adapter, of, waitFor, deadlines };
}

describe('CodexAdapter turn watchdog', () => {
  test('fails a turn whose completion never arrives and takes the next one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awos-codex-watchdog-'));
    const server = join(dir, 'server.mjs');
    // Accepts the first turn and never ends it, which is the drift the watchdog exists
    // for: a completion renamed, reshaped, or simply never sent. That completion then
    // turns up while the *second* turn is in flight — a server that was slow rather than
    // dead — so a stale completion settling the wrong turn is exercised by the same case.
    writeFileSync(
      server,
      String.raw`import { writeFileSync } from 'node:fs';

const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let buffer = '';
let turns = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    if (message.method === 'thread/start') {
      emit({ id: message.id, result: { thread: { id: 'thread-1' } } });
    }
    if (message.method === 'turn/interrupt') {
      // Recorded, and deliberately not acted on: a server that ignores the interrupt is
      // the case the abandoned-turn bookkeeping still has to survive.
      writeFileSync(new URL('interrupted', import.meta.url), '');
      emit({ id: message.id, result: {} });
    }
    if (message.method === 'turn/start') {
      turns += 1;
      const turnId = 'turn-' + turns;
      emit({ id: message.id, result: { turn: { id: turnId } } });
      if (turns === 1) {
        emit({ method: 'turn/started', params: { turn: { id: turnId } } });
        emit({
          id: 9001,
          method: 'item/permissions/requestApproval',
          params: { itemId: 'item-1', type: 'exec', command: ['echo', 'hi'] },
        });
      } else {
        // Turn 1 finally reports in, after the next turn has been accepted and before it
        // has even been given its own id.
        emit({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
        emit({ method: 'turn/started', params: { turn: { id: turnId } } });
        emit({
          method: 'turn/completed',
          params: { turn: { id: turnId, status: 'completed', usage: { inputTokens: 7 } } },
        });
      }
    }
  }
});
process.stdin.on('end', () => process.exit(0));`,
      'utf8',
    );

    const { adapter, of, waitFor, deadlines } = codexHarness(dir, server, {
      codexTurnTimeoutMs: 120,
    });

    try {
      await Promise.all([
        assert.rejects(
          adapter.sendTurn('hang forever'),
          /did not complete the turn within 120ms/,
        ),
        (async () => {
          // The turn is watched with the deadline this thread configured rather than the
          // ten-minute default — the number the message quotes, and the only reason a
          // case about a turn that never ends gets an answer at all.
          assert.equal((await deadlines.nth(1)).ms, 120);
          // Fired once the server is blocked on its approval, because releasing that
          // approval is part of what giving up on the turn has to do.
          await waitFor('approval.requested');
          await deadlines.fire(1);
        })(),
      ]);

      assert.equal(of('error').length, 1);
      assert.equal(of('error')[0]?.severity, 'turn');

      // The turn is recorded as a failure, never as a completion.
      assert.equal(of('turn.completed').length, 1);
      assert.equal(of('turn.completed')[0]?.reason, 'error');
      assert.match(of('turn.completed')[0]?.error ?? '', /did not complete the turn/);

      // The approval the server is blocked on is released with the turn that owns it.
      assert.equal(of('approval.resolved').length, 1);
      assert.equal(of('approval.resolved')[0]?.behavior, 'deny');
      assert.equal(of('approval.resolved')[0]?.auto, true);

      assert.equal(adapter.busy, false);

      // The next turn starts before the abandoned one reports in. What must settle it is
      // its own completion — carrying the usage only it sends — and not turn 1's, which
      // lands in the middle of it. Nothing fires this turn's deadline, so a turn that
      // takes its time is still a turn that succeeds.
      await settles('the next turn', adapter.sendTurn('and now a normal one'));
      assert.equal(of('usage').length, 1);
      assert.equal(of('usage')[0]?.inputTokens, 7);
      assert.equal(of('turn.completed').length, 2);
      assert.equal(of('turn.completed')[1]?.reason, 'completed');
      assert.ok(existsSync(join(dir, 'interrupted')), 'the abandoned turn should be interrupted');
    } finally {
      await adapter.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CodexAdapter abandoned turns', () => {
  test('ignores a completion for a turn only the acceptance ever named', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awos-codex-unstarted-'));
    const server = join(dir, 'server.mjs');
    // Names each turn in the `turn/start` result and never sends `turn/started`, which is
    // where the adapter used to learn the id. A turn that hangs before its first
    // notification is exactly the turn the watchdog gives up on, so the id has to be
    // taken from the acceptance or the abandoned turn is never recognizable again.
    writeFileSync(
      server,
      codexTurnServer(String.raw`      if (turns === 2) {
        // Turn 1 reports in at last, mid-way through turn 2, claiming real work.
        emit({
          method: 'turn/completed',
          params: { turn: { id: 'turn-1', status: 'completed', usage: { inputTokens: 99 } } },
        });
        // Turn 2 carries on afterwards. Seeing this is how the case knows the straggler
        // has already been read, so turn 2's deadline is fired against a turn that has
        // seen it and stayed its own.
        emit({ method: 'turn/diff/updated', params: { turnId: turnId, diff: 'live patch' } });
      }`),
      'utf8',
    );

    const { adapter, of, waitFor, deadlines } = codexHarness(dir, server, {
      codexTurnTimeoutMs: 120,
    });

    try {
      await Promise.all([
        assert.rejects(
          adapter.sendTurn('hang before you start'),
          /did not complete the turn within 120ms/,
        ),
        deadlines.fire(1),
      ]);

      // Turn 1's completion lands here. Settling this turn on it would report a turn that
      // has done nothing as finished, and bank the other turn's token usage against it.
      await Promise.all([
        assert.rejects(
          adapter.sendTurn('and now the next one'),
          /did not complete the turn within 120ms/,
        ),
        (async () => {
          await waitFor('diff.updated');
          await deadlines.fire(2);
        })(),
      ]);

      assert.equal(of('usage').length, 0);
      // Turn 2 kept its own patch through the straggler, which is what says it was still
      // the turn in flight when the straggler was ignored.
      assert.deepEqual(
        of('diff.updated').map((event) => event.patch),
        ['live patch'],
      );
      assert.deepEqual(
        of('turn.completed').map((event) => event.reason),
        ['error', 'error'],
      );

      // The adapter knew which turn it was giving up on, so it could ask for that one to
      // stop rather than for whatever the thread happens to be running by then.
      const [firstInterrupt] = readFileSync(join(dir, 'interrupts.jsonl'), 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as { threadId?: string; turnId?: string });
      assert.equal(firstInterrupt?.turnId, 'turn-1');
    } finally {
      await adapter.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('gives up on its own clock when nothing hands it a deadline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awos-codex-realclock-'));
    const server = join(dir, 'server.mjs');
    // Accepts the turn and says nothing more.
    writeFileSync(server, codexTurnServer(''), 'utf8');

    // The one case that lets the adapter arm its own `setTimeout`, so the default path
    // every real caller takes is exercised end to end. Nothing else has to fit inside
    // this window — there is no second turn — so a slow machine only makes the answer
    // arrive later.
    const adapter = new CodexAdapter({
      threadId: 'thread-1',
      cwd: dir,
      config: codexTestConfig(dir, server, { codexTurnTimeoutMs: 50 }),
      permissionMode: 'default',
      permissionBridge: {} as AdapterContext['permissionBridge'],
      resumeSessionId: null,
      emit: () => {},
      onSessionId: () => {},
    });

    try {
      await settles(
        'the turn to fail on its own deadline',
        assert.rejects(adapter.sendTurn('hang forever'), /did not complete the turn within 50ms/),
      );
      assert.equal(adapter.busy, false);
    } finally {
      await adapter.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps an abandoned turn out of the next turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awos-codex-stragglers-'));
    const server = join(dir, 'server.mjs');
    // Turn 1 is abandoned and goes on emitting: a patch, a command, its output. The
    // interrupt is answered and ignored, which is the whole reason this can happen.
    writeFileSync(
      server,
      codexTurnServer(String.raw`      emit({ method: 'turn/started', params: { turn: { id: turnId } } });
      if (turns === 2) {
        emit({ method: 'turn/diff/updated', params: { turnId: 'turn-1', diff: 'stale patch' } });
        emit({
          method: 'item/started',
          params: {
            turnId: 'turn-1',
            item: { id: 'stale-item', type: 'commandExecution', command: ['rm', '-rf', 'dist'] },
          },
        });
        // Codex has never put a turn on this one, so it can only be told apart by the
        // company it keeps.
        emit({
          method: 'exec/outputDelta',
          params: { itemId: 'stale-item', stream: 'stdout', chunk: 'from the abandoned turn' },
        });
        emit({ method: 'turn/diff/updated', params: { turnId: turnId, diff: 'live patch' } });
        emit({
          method: 'turn/completed',
          params: { turn: { id: turnId, status: 'completed' } },
        });
      }`),
      'utf8',
    );

    const { adapter, of, deadlines } = codexHarness(dir, server, { codexTurnTimeoutMs: 120 });

    try {
      await Promise.all([
        assert.rejects(
          adapter.sendTurn('hang forever'),
          /did not complete the turn within 120ms/,
        ),
        deadlines.fire(1),
      ]);

      // Nothing fires the second turn's deadline: it ends on the server's own completion,
      // however long that round trip took. The abandoned turn is still outstanding when
      // that completion is read, in the same read as the acceptance that names this turn.
      await settles('the next turn', adapter.sendTurn('and now a normal one'));

      // The abandoned turn's patch would have replaced the live one's wholesale: the diff
      // is a snapshot of the whole turn, not an addition to it.
      assert.deepEqual(
        of('diff.updated').map((event) => event.patch),
        ['live patch'],
      );
      // Its command never opens a row in a transcript it does not belong to, and neither
      // does the output of that command, which names no turn at all.
      assert.equal(of('tool.started').length, 0);
      assert.equal(of('tool.output').length, 0);

      assert.equal(of('turn.completed').length, 2);
      assert.equal(of('turn.completed')[1]?.reason, 'completed');
      // One turn, one id: the events that open and close it agree on which turn it was.
      assert.equal(of('turn.started')[1]?.turnId, of('turn.completed')[1]?.turnId);
    } finally {
      await adapter.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Handshake and thread, and whatever the case wants `turn/start` to answer — or not. */
function codexRefusingServer(onTurnStart: string): string {
  return String.raw`const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    if (message.method === 'thread/start') {
      emit({ id: message.id, result: { thread: { id: 'thread-1' } } });
    }
    if (message.method === 'turn/start') {
` + onTurnStart + String.raw`
    }
  }
});
process.stdin.on('end', () => process.exit(0));`;
}

/**
 * Runs `work` and reports the rejections nothing was holding while it ran.
 *
 * Asserted directly rather than inferred from the suite staying alive: a listener is what
 * keeps the default action — exiting the process — from firing, so without one a loose
 * rejection here would be charged to whichever case happened to be running at the exit.
 */
async function unheldRejections(work: () => Promise<void>): Promise<unknown[]> {
  const loose: unknown[] = [];
  const record = (reason: unknown): void => {
    loose.push(reason);
  };
  process.on('unhandledRejection', record);
  try {
    await work();
    // The event is raised once the microtask queue has drained, which is a turn of the
    // event loop later than the await that returned above.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', record);
  }
  return loose;
}

describe('CodexAdapter refused turn start', () => {
  test('reports a refused turn without losing the daemon', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awos-codex-refused-'));
    const server = join(dir, 'server.mjs');
    writeFileSync(
      server,
      codexRefusingServer(
        String.raw`      emit({ id: message.id, error: { code: -32000, message: 'no capacity' } });`,
      ),
      'utf8',
    );

    const { adapter, of } = codexHarness(dir, server);

    try {
      const loose = await unheldRejections(async () => {
        await assert.rejects(adapter.sendTurn('do the thing'), /turn\/start: no capacity/);
      });
      assert.deepEqual(loose, []);

      // Settled once, and by the failure: the turn the caller was told about is the turn
      // the transcript records. The adapter's whole report of this is that one event —
      // the same message reaches the caller as the rejection, not as a second event.
      assert.equal(of('turn.completed').length, 1);
      assert.equal(of('turn.completed')[0]?.reason, 'error');
      assert.match(of('turn.completed')[0]?.error ?? '', /no capacity/);
      assert.equal(of('error').length, 0);
      assert.equal(adapter.busy, false);
    } finally {
      await adapter.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reports a turn start that is never answered without losing the daemon', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awos-codex-unanswered-'));
    const server = join(dir, 'server.mjs');
    // Reads the request and says nothing, so the request's own timeout is what ends it.
    writeFileSync(server, codexRefusingServer('      // no answer, ever'), 'utf8');

    const { adapter, of } = codexHarness(dir, server);

    try {
      const loose = await unheldRejections(async () => {
        await assert.rejects(
          adapter.sendTurn('do the thing'),
          /did not answer turn\/start within the timeout/,
        );
      });
      assert.deepEqual(loose, []);

      assert.equal(of('turn.completed').length, 1);
      assert.equal(of('turn.completed')[0]?.reason, 'error');
      assert.equal(of('error').length, 0);
      assert.equal(adapter.busy, false);
    } finally {
      await adapter.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('extractCodexPlan', () => {
  test('reads the plan key', () => {
    assert.deepEqual(
      extractCodexPlan({ plan: [{ step: 'one', status: 'completed' }] }),
      [{ text: 'one', status: 'completed' }],
    );
  });

  test('falls back to the steps key', () => {
    assert.deepEqual(extractCodexPlan({ steps: [{ text: 'two', status: 'active' }] }), [
      { text: 'two', status: 'in_progress' },
    ]);
  });

  test('accepts bare strings', () => {
    assert.deepEqual(extractCodexPlan({ plan: ['just text'] }), [
      { text: 'just text', status: 'pending' },
    ]);
  });

  test('normalizes done to completed', () => {
    assert.deepEqual(extractCodexPlan({ plan: [{ step: 'x', status: 'done' }] }), [
      { text: 'x', status: 'completed' },
    ]);
  });

  test('returns empty on garbage', () => {
    assert.deepEqual(extractCodexPlan({}), []);
    assert.deepEqual(extractCodexPlan({ plan: 'nope' }), []);
  });
});

describe('describeCodexApproval', () => {
  test('shows the command and cwd for an exec approval', () => {
    const { title, detail, toolKind } = describeCodexApproval({
      command: ['rm', '-rf', 'dist'],
      cwd: '/repo',
    });
    assert.equal(title, 'Run a shell command');
    assert.equal(toolKind, 'command');
    assert.match(detail, /rm -rf dist/);
    assert.match(detail, /\/repo/);
  });

  test('renders the diff for a patch approval', () => {
    const { title, toolKind, detail } = describeCodexApproval({
      changes: [{ path: 'x.rs', diff: '-old\n+new' }],
    });
    assert.equal(title, 'Apply file changes');
    assert.equal(toolKind, 'file_edit');
    assert.match(detail, /\+new/);
  });

  test('falls back to the reason for an unrecognized shape', () => {
    const { title } = describeCodexApproval({ reason: 'Needs network access' });
    assert.equal(title, 'Needs network access');
  });
});
