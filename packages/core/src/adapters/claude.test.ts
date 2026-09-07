import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterEvent } from '@awos/protocol';
import {
  ClaudeAdapter,
  classifyClaudeTool,
  summarizeClaudeTool,
  flattenToolResult,
  extractTodos,
  describePermission,
} from './claude.js';
import type { AdapterContext } from './agent.js';
import type { HarnessConfig } from '../config.js';

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

/**
 * A broken stdout pipe, which is not the process exiting.
 *
 * `ChildProcess`'s `error` event and the `error` event of its `stdout` stream are two
 * different events, and only the first one was ever listened for. The second was therefore
 * thrown by Node as an uncaught exception, so one worker's broken pipe ended the daemon —
 * every thread, every other worker, and the socket the UI is attached to.
 *
 * What is left once it does not is a process that can no longer be heard from and may still
 * be running, which is the second half of the case: it must not go on to clear a reference
 * or fail a turn belonging to the process that replaces it, and it must not be left running
 * in the thread's directory beside it.
 */
describe('ClaudeAdapter stdout failure', () => {
  /**
   * A CLI that opens the turn and then goes quiet, so the turn is genuinely in flight.
   *
   * It records its pid at both ends of its life, and takes its time going: the window
   * between a stdout failure and the process's own exit is where a still-wired `close`
   * would reach across into whatever replaced it.
   */
  const SILENT_CLI = String.raw`import { appendFileSync } from 'node:fs';

const marker = new URL('marker.txt', import.meta.url);
appendFileSync(marker, 'start ' + process.pid + '\n');
process.on('exit', () => appendFileSync(marker, 'exit ' + process.pid + '\n'));

const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
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
    if (message.type !== 'user') continue;
    emit({
      type: 'system',
      subtype: 'init',
      session_id: '11111111-2222-3333-4444-555555555555',
      model: 'fake-model',
    });
    // And nothing after it: no result event ever closes this turn.
  }
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), 300));`;

  function claudeTestConfig(dir: string, cli: string): HarnessConfig {
    return {
      dataDir: dir,
      claudeBin: process.execPath,
      codexBin: process.execPath,
      claudeBinArgs: [cli],
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
    };
  }

  async function until(label: string, check: () => boolean): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  test('fails the turn once, ends the worker, and leaves its replacement alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awos-claude-stdout-'));
    const cli = join(dir, 'cli.mjs');
    writeFileSync(cli, SILENT_CLI, 'utf8');
    const marker = (): string[] => {
      const file = join(dir, 'marker.txt');
      return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    };

    const events: AdapterEvent[] = [];
    const adapter = new ClaudeAdapter({
      threadId: 'thread-1',
      cwd: dir,
      config: claudeTestConfig(dir, cli),
      permissionMode: 'bypassPermissions',
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

    let second: 'pending' | 'settled' = 'pending';

    try {
      const first = adapter.sendTurn('do the work');
      // The CLI's own init is proof the process is up and its stdout is being read.
      await until('the CLI to open the turn', () =>
        of('agent.status').some((event) => event.model === 'fake-model'),
      );
      const failedPid = marker()[0]?.split(' ')[1];

      // Without a listener on the stream this call throws, and in the daemon it would have
      // been an uncaught exception instead.
      assert.doesNotThrow(() => adapter.failStdoutForTests(new Error('EIO: read failed')));
      await assert.rejects(first, /stdout failed/);

      // The replacement, started while the failed process is still winding down — which is
      // exactly when a `close` still wired to the adapter would fail the wrong turn.
      const next = adapter.sendTurn('try again');
      const settle = (): void => {
        second = 'settled';
      };
      next.then(settle, settle);

      await until('the failed worker to exit', () => marker().includes(`exit ${failedPid}`));
      // Its exit is on the parent's doorstep by now; give it every chance to be heard.
      await new Promise((resolve) => setTimeout(resolve, 250));

      assert.equal(second, 'pending', "the failed worker settled its replacement's turn");
      const completed = of('turn.completed');
      assert.deepEqual(
        completed.map((event) => event.reason),
        ['error'],
      );
      assert.match(String(completed[0]?.error), /EIO: read failed/);

      const statuses = of('agent.status').map((event) => event.status);
      assert.equal(statuses.filter((status) => status === 'failed').length, 1);
      // The exit of a worker the adapter already gave up on is not the adapter's to report.
      assert.deepEqual(
        statuses.filter((status) => status === 'exited'),
        [],
      );
      assert.ok(
        of('error').some(
          (event) => event.severity === 'fatal' && /EIO: read failed/.test(event.message),
        ),
        'the thread was never told its worker had failed',
      );

      // Two workers in one directory is the invariant the shared-directory mode exists to
      // hold, so the failed one has to be gone rather than merely disowned.
      const lines = marker();
      assert.equal(lines.filter((line) => line.startsWith('start ')).length, 2);
      assert.ok(lines.includes(`exit ${failedPid}`), 'the failed worker was left running');
    } finally {
      await adapter.stop();
      // A worker this case failed to end would hold the directory open, and a verdict
      // replaced by EBUSY says nothing about the assertions above it.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* reported by the assertions, not by the cleanup */
      }
    }
  });
});
