import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterEvent } from '@awos/protocol';
import type { HarnessConfig } from '../config.js';
import type { AdapterContext } from './agent.js';
import {
  ClaudeAdapter,
  classifyClaudeTool,
  summarizeClaudeTool,
  flattenToolResult,
  extractTodos,
  describePermission,
} from './claude.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(here, '..', 'testing', 'fake-claude.js');

function claudeTestConfig(
  dir: string,
  fakeArgs: string[],
  overrides: Partial<HarnessConfig> = {},
): HarnessConfig {
  return {
    dataDir: dir,
    claudeBin: process.execPath,
    codexBin: process.execPath,
    claudeBinArgs: [FAKE_CLAUDE, ...fakeArgs],
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

function claudeHarness(dir: string, fakeArgs: string[], overrides: Partial<HarnessConfig> = {}) {
  const events: AdapterEvent[] = [];
  const config = claudeTestConfig(dir, fakeArgs, overrides);
  const adapter = new ClaudeAdapter({
    threadId: 'thread-1',
    cwd: dir,
    config,
    permissionMode: 'default',
    permissionBridge: {
      port: 0,
      token: 'test-token',
      registerThread: () => {},
      unregisterThread: () => {},
    } as unknown as AdapterContext['permissionBridge'],
    resumeSessionId: null,
    emit: (event) => events.push(event),
    onSessionId: () => {},
  });

  const of = <K extends AdapterEvent['kind']>(
    kind: K,
  ): Array<Extract<AdapterEvent, { kind: K }>> =>
    events.filter((event): event is Extract<AdapterEvent, { kind: K }> => event.kind === kind);

  return { adapter, of, config, events };
}

describe('ClaudeAdapter turn deadline', () => {
  test('abandons a turn that never gets a result and takes the next one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awos-claude-deadline-'));
    // The fake accepts the first turn, streams it, stays alive, and withholds its
    // `result` until the next turn's input arrives. Nothing but a deadline can end it.
    const { adapter, of, config } = claudeHarness(dir, ['--late-result'], {
      claudeTurnTimeoutMs: 120,
    });
    let stopped = false;

    try {
      const startedAt = Date.now();
      await assert.rejects(
        adapter.sendTurn('hang forever'),
        /did not complete the turn within 120ms/,
      );
      // The wait came from this deadline rather than the ten-minute default; spawning the
      // fake CLI accounts for most of what is left of this window.
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 3_000, `the turn should fail on its own deadline, took ${elapsed}ms`);

      // The operator sees the timeout as an event scoped to the turn, not only in a log.
      assert.equal(of('error').length, 1);
      assert.equal(of('error')[0]?.severity, 'turn');
      assert.equal(of('error')[0]?.turnId, of('turn.started')[0]?.turnId);

      // The turn is recorded as a failure, never as a completion.
      assert.equal(of('turn.completed').length, 1);
      assert.equal(of('turn.completed')[0]?.reason, 'error');
      assert.match(of('turn.completed')[0]?.error ?? '', /did not complete the turn/);

      // The process is still alive, so the worker is idle rather than exited.
      assert.equal(of('agent.status').at(-1)?.status, 'idle');
      assert.equal(adapter.busy, false);

      // The wedge is gone: the next turn is accepted and runs to completion. The deadline
      // is read when a turn arms it, so widening it here takes the watchdog meant for the
      // hung turn off the healthy one — which under a loaded suite is otherwise a race
      // between a real turn and a deliberately unreachable deadline.
      config.claudeTurnTimeoutMs = 60_000;
      await adapter.sendTurn('and now a normal one');

      // The counts below only mean something once the whole stream has been read. This
      // turn resolves on a `result`, and the point of the assertions is which one — so
      // wait for the CLI to close rather than for the first result that settles the turn.
      await adapter.stop();
      stopped = true;

      assert.equal(of('turn.completed').length, 2);
      assert.equal(of('turn.completed')[1]?.reason, 'completed');
      // One turn, one id: the events that open and close it agree on which turn it was.
      assert.equal(of('turn.started')[1]?.turnId, of('turn.completed')[1]?.turnId);

      // The abandoned turn's late result arrived mid-way through this one. Counting it
      // would have banked another turn's tokens here and closed a turn twice.
      assert.equal(of('usage').length, 1);
      assert.equal(of('usage')[0]?.turnId, of('turn.started')[1]?.turnId);
    } finally {
      if (!stopped) await adapter.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not mute the next turn when the abandoned result never arrives', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awos-claude-mute-'));
    // The result the first turn owes is never sent — a CLI whose result event was renamed
    // or dropped. Nothing but the replayed input ever shows that the turn ended, so a
    // watchdog that waits for the owed result would disown every turn after it forever.
    const { adapter, of, config } = claudeHarness(dir, ['--drop-result'], {
      claudeTurnTimeoutMs: 120,
    });
    let stopped = false;

    try {
      await assert.rejects(
        adapter.sendTurn('hang forever'),
        /did not complete the turn within 120ms/,
      );

      config.claudeTurnTimeoutMs = 60_000;
      await adapter.sendTurn('and now a normal one');
      await adapter.stop();
      stopped = true;

      // The second turn is not just accepted, it is visible: its reply reached the
      // transcript rather than being taken for the abandoned turn's.
      const second = of('turn.started')[1]?.turnId;
      assert.equal(of('turn.completed')[1]?.reason, 'completed');
      assert.equal(of('turn.completed')[1]?.turnId, second);
      assert.ok(
        of('message.completed').some(
          (event) => event.turnId === second && event.text.includes('and now a normal one'),
        ),
        'the second turn produced no visible reply',
      );
      assert.equal(of('usage').length, 1);
      assert.equal(of('usage')[0]?.turnId, second);
    } finally {
      if (!stopped) await adapter.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps two abandoned turns apart instead of discharging both at the first replay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awos-claude-two-abandoned-'));
    // The CLI stays blocked long enough for two submitted turns to outlive their
    // deadline. It then replays the second input and runs that second — also abandoned —
    // turn while a third is in flight, closing it with a `result` of its own. Reading
    // that replay as "everything before it is over" would hand the second turn's stream,
    // and its result, to the third.
    const { adapter, of, config, events } = claudeHarness(dir, ['--stall-second'], {
      claudeTurnTimeoutMs: 120,
    });
    let stopped = false;

    try {
      await assert.rejects(adapter.sendTurn('first turn'), /did not complete the turn/);
      await assert.rejects(adapter.sendTurn('second turn'), /did not complete the turn/);

      // The deadline is read when a turn arms it, so the third turn gets a reachable one.
      config.claudeTurnTimeoutMs = 60_000;
      await adapter.sendTurn('third turn');
      await adapter.stop();
      stopped = true;

      const third = of('turn.started')[2]?.turnId;
      assert.equal(of('turn.started').length, 3);
      assert.deepEqual(
        of('turn.completed').map((event) => event.reason),
        ['error', 'error', 'completed'],
      );
      assert.equal(of('turn.completed')[2]?.turnId, third);

      // The second turn was disowned when its deadline passed and stays disowned until
      // its own input is behind us, so nothing it said reached the transcript at all.
      assert.deepEqual(
        of('message.completed').filter((event) => event.text.includes('second turn')),
        [],
      );
      assert.ok(
        of('message.completed').some(
          (event) => event.turnId === third && event.text.includes('third turn'),
        ),
        'the third turn produced no visible reply',
      );

      // The third turn was closed by its own `result`, which arrives after its reply.
      // The abandoned turn's result came first and would have closed it before that.
      const reply = events.findIndex(
        (event) => event.kind === 'message.completed' && event.text.includes('third turn'),
      );
      const completed = events.findIndex(
        (event) => event.kind === 'turn.completed' && event.turnId === third,
      );
      assert.ok(reply >= 0 && completed > reply, 'the third turn was closed by another result');

      // The second turn's result landed mid-way through the third; its tokens are not
      // the third turn's to bank.
      assert.equal(of('usage').length, 1);
      assert.equal(of('usage')[0]?.turnId, third);
    } finally {
      if (!stopped) await adapter.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('classifyClaudeTool', () => {
  test('maps built-ins to their kind', () => {
    assert.equal(classifyClaudeTool('Bash'), 'command');
    assert.equal(classifyClaudeTool('Edit'), 'file_edit');
    assert.equal(classifyClaudeTool('Read'), 'file_read');
    assert.equal(classifyClaudeTool('Grep'), 'search');
    assert.equal(classifyClaudeTool('WebFetch'), 'web');
    assert.equal(classifyClaudeTool('Task'), 'task');
  });

  test('treats any mcp__ prefix as an MCP tool', () => {
    assert.equal(classifyClaudeTool('mcp__github__create_issue'), 'mcp');
  });

  test('falls back to other for unknown names', () => {
    // Claude Code adds tools between releases; an unknown name must not throw.
    assert.equal(classifyClaudeTool('SomeFutureTool'), 'other');
  });
});

describe('summarizeClaudeTool', () => {
  test('shows the command line for Bash', () => {
    assert.equal(summarizeClaudeTool('Bash', { command: 'npm test' }), 'npm test');
  });

  test('shows the path for file tools', () => {
    assert.equal(summarizeClaudeTool('Edit', { file_path: '/a/b.ts' }), 'Edit /a/b.ts');
  });

  test('marks subagent calls', () => {
    assert.equal(
      summarizeClaudeTool('Bash', { command: 'ls' }, true),
      'subagent · ls',
    );
  });

  test('degrades to a key list for unknown tools', () => {
    assert.equal(summarizeClaudeTool('Weird', { x: 1, y: 2 }), 'Weird(x, y)');
  });

  test('does not crash when the expected field is missing', () => {
    assert.equal(summarizeClaudeTool('Bash', {}), 'Bash');
  });
});

describe('flattenToolResult', () => {
  test('passes a string body through', () => {
    assert.equal(flattenToolResult('done'), 'done');
  });

  test('joins the block-array form', () => {
    assert.equal(
      flattenToolResult([
        { type: 'text', text: 'line 1' },
        { type: 'text', text: 'line 2' },
      ]),
      'line 1\nline 2',
    );
  });

  test('ignores non-text blocks', () => {
    assert.equal(
      flattenToolResult([{ type: 'image' }, { type: 'text', text: 'ok' }]),
      'ok',
    );
  });
});

describe('extractTodos', () => {
  test('reads a TodoWrite payload', () => {
    const items = extractTodos({
      todos: [
        { content: 'first', status: 'completed' },
        { content: 'second', status: 'in_progress' },
        { content: 'third', status: 'pending' },
      ],
    });
    assert.deepEqual(items, [
      { text: 'first', status: 'completed' },
      { text: 'second', status: 'in_progress' },
      { text: 'third', status: 'pending' },
    ]);
  });

  test('maps an unrecognized status to pending rather than dropping the item', () => {
    assert.deepEqual(extractTodos({ todos: [{ content: 'a', status: 'weird' }] }), [
      { text: 'a', status: 'pending' },
    ]);
  });

  test('returns empty for malformed input', () => {
    assert.deepEqual(extractTodos(null), []);
    assert.deepEqual(extractTodos({}), []);
    assert.deepEqual(extractTodos({ todos: 'nope' }), []);
    assert.deepEqual(extractTodos({ todos: [{ nope: true }] }), []);
  });
});

describe('describePermission', () => {
  test('surfaces the command for a Bash approval', () => {
    const { title, detail } = describePermission({
      threadId: 't',
      toolName: 'Bash',
      input: { command: 'rm -rf build' },
      toolUseId: null,
    });
    assert.equal(title, 'Run a shell command');
    // The operator must be able to read the exact command before approving it.
    assert.equal(detail, 'rm -rf build');
  });

  test('names the file for a Write approval', () => {
    const { title } = describePermission({
      threadId: 't',
      toolName: 'Write',
      input: { file_path: '/etc/hosts', content: 'x' },
      toolUseId: null,
    });
    assert.equal(title, 'Write /etc/hosts');
  });

  test('falls back to serialized input for unknown tools', () => {
    const { title, detail } = describePermission({
      threadId: 't',
      toolName: 'mcp__x__y',
      input: { a: 1 },
      toolUseId: null,
    });
    assert.equal(title, 'Use mcp__x__y');
    assert.match(detail, /"a": 1/);
  });
});
