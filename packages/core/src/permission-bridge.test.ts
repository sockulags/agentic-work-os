import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PermissionBridge, type BridgeDecision } from './permission-bridge.js';
import { LineDecoder } from './util/jsonl.js';
import { CLAUDE_PERMISSION_TOOL_NAME } from '@awos/protocol';

/**
 * Round-trip tests for Claude's approval path.
 *
 * This exercises the real permission MCP server as a child process, driven over stdio
 * exactly the way Claude Code drives it. It is the only test that covers the full
 * loop — MCP tool call → loopback socket → harness decision → Claude's expected
 * response contract — and that loop is where a mistake means either a hung agent or an
 * unapproved shell command.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = join(here, 'permission-mcp', 'main.js');

let bridge: PermissionBridge;
let child: ChildProcess | null = null;

/** Minimal MCP client: speaks just enough to call one tool. */
class McpHarness {
  #child: ChildProcess;
  #decoder = new LineDecoder();
  #nextId = 1;
  readonly #pending = new Map<number, (result: unknown) => void>();

  constructor(proc: ChildProcess) {
    this.#child = proc;
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      for (const line of this.#decoder.push(chunk)) {
        const msg = JSON.parse(line) as { id?: number; result?: unknown };
        if (msg.id === undefined) continue;
        const waiter = this.#pending.get(msg.id);
        if (waiter) {
          this.#pending.delete(msg.id);
          waiter(msg.result);
        }
      }
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
}

function launchMcp(threadId: string, token: string, port: number): McpHarness {
  child = spawn(process.execPath, [MCP_ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AWOS_BRIDGE_PORT: String(port),
      AWOS_BRIDGE_TOKEN: token,
      AWOS_THREAD_ID: threadId,
      AWOS_LOG_LEVEL: 'error',
    },
  });
  return new McpHarness(child);
}

/** Parse the JSON payload Claude expects inside the tool's text content. */
function readDecision(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  const text = content?.[0]?.text ?? '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

beforeEach(async () => {
  bridge = new PermissionBridge();
  await bridge.listen();
});

afterEach(async () => {
  child?.kill();
  child = null;
  await bridge.close();
});

describe('permission bridge round trip', () => {
  test('an allow decision reaches Claude in the expected shape', async () => {
    const threadId = randomUUID();
    bridge.registerThread(threadId, async () => ({ behavior: 'allow' }) as BridgeDecision);

    const mcp = launchMcp(threadId, bridge.token, bridge.port);
    await mcp.request('initialize', {});

    const result = await mcp.request('tools/call', {
      name: CLAUDE_PERMISSION_TOOL_NAME,
      arguments: { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1' },
    });

    const decision = readDecision(result);
    assert.equal(decision['behavior'], 'allow');
    // Claude requires updatedInput on allow; echoing the original is the correct default.
    assert.deepEqual(decision['updatedInput'], { command: 'ls' });
  });

  test('a deny decision carries the reason back', async () => {
    const threadId = randomUUID();
    bridge.registerThread(threadId, async () => ({
      behavior: 'deny',
      message: 'Not on my watch.',
    }));

    const mcp = launchMcp(threadId, bridge.token, bridge.port);
    await mcp.request('initialize', {});

    const decision = readDecision(
      await mcp.request('tools/call', {
        name: CLAUDE_PERMISSION_TOOL_NAME,
        arguments: { tool_name: 'Bash', input: { command: 'rm -rf /' } },
      }),
    );

    assert.equal(decision['behavior'], 'deny');
    assert.equal(decision['message'], 'Not on my watch.');
  });

  test('the handler receives the tool name and input verbatim', async () => {
    const threadId = randomUUID();
    let seen: unknown = null;
    bridge.registerThread(threadId, async (req) => {
      seen = req;
      return { behavior: 'allow' };
    });

    const mcp = launchMcp(threadId, bridge.token, bridge.port);
    await mcp.request('initialize', {});
    await mcp.request('tools/call', {
      name: CLAUDE_PERMISSION_TOOL_NAME,
      arguments: {
        tool_name: 'Edit',
        input: { file_path: '/a/b.ts', old_string: 'x' },
        tool_use_id: 'toolu_9',
      },
    });

    assert.deepEqual(seen, {
      threadId,
      toolName: 'Edit',
      input: { file_path: '/a/b.ts', old_string: 'x' },
      toolUseId: 'toolu_9',
    });
  });

  test('an unregistered thread denies rather than hanging', async () => {
    // This is the shutdown race: Claude asks for permission after the thread is gone.
    const mcp = launchMcp('never-registered', bridge.token, bridge.port);
    await mcp.request('initialize', {});

    const decision = readDecision(
      await mcp.request('tools/call', {
        name: CLAUDE_PERMISSION_TOOL_NAME,
        arguments: { tool_name: 'Bash', input: { command: 'ls' } },
      }),
    );

    assert.equal(decision['behavior'], 'deny');
  });

  test('a bad token is rejected and the tool fails closed', async () => {
    const threadId = randomUUID();
    bridge.registerThread(threadId, async () => ({ behavior: 'allow' }));

    const mcp = launchMcp(threadId, 'wrong-token', bridge.port);
    await mcp.request('initialize', {});

    const decision = readDecision(
      await mcp.request('tools/call', {
        name: CLAUDE_PERMISSION_TOOL_NAME,
        arguments: { tool_name: 'Bash', input: { command: 'ls' } },
      }),
    );

    // An attacker on loopback must not be able to approve anything, and a genuine
    // misconfiguration must not silently grant access either.
    assert.equal(decision['behavior'], 'deny');
  });

  test('exposes exactly one tool, under the name Claude is told to call', async () => {
    const threadId = randomUUID();
    bridge.registerThread(threadId, async () => ({ behavior: 'allow' }));
    const mcp = launchMcp(threadId, bridge.token, bridge.port);
    await mcp.request('initialize', {});

    const listed = (await mcp.request('tools/list')) as { tools: Array<{ name: string }> };
    assert.equal(listed.tools.length, 1);
    assert.equal(listed.tools[0]?.name, CLAUDE_PERMISSION_TOOL_NAME);
  });

  test('several approvals in flight resolve independently', async () => {
    const threadId = randomUUID();
    const gates = new Map<string, (d: BridgeDecision) => void>();

    bridge.registerThread(
      threadId,
      (req) =>
        new Promise<BridgeDecision>((resolve) => {
          gates.set(String(req.input['id']), resolve);
        }),
    );

    const mcp = launchMcp(threadId, bridge.token, bridge.port);
    await mcp.request('initialize', {});

    const first = mcp.request('tools/call', {
      name: CLAUDE_PERMISSION_TOOL_NAME,
      arguments: { tool_name: 'Bash', input: { id: 'a' } },
    });
    const second = mcp.request('tools/call', {
      name: CLAUDE_PERMISSION_TOOL_NAME,
      arguments: { tool_name: 'Bash', input: { id: 'b' } },
    });

    // Wait for both to arrive, then answer out of order.
    await waitFor(() => gates.size === 2);
    gates.get('b')?.({ behavior: 'deny', message: 'no' });
    gates.get('a')?.({ behavior: 'allow' });

    assert.equal(readDecision(await first)['behavior'], 'allow');
    assert.equal(readDecision(await second)['behavior'], 'deny');
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Frame validation on the bridge's unauthenticated edge.
 *
 * These drive a raw socket rather than the MCP server, because the MCP server only ever
 * sends well-formed frames. Any local process can open this port and write whatever it
 * likes, and until a frame is validated the harness has no business reading fields off
 * it. A throw out of the socket's `data` listener is uncaught in the daemon, so here it
 * escapes into the test runner and fails the test outright — which is the assertion that
 * the daemon survives each input below.
 */

interface RawExchange {
  /** JSON frames the bridge wrote back, in order. */
  frames: Array<Record<string, unknown>>;
  /** True when the bridge hung up, false when it was still holding the socket open. */
  closed: boolean;
}

/** Write raw lines to the bridge and collect whatever comes back. */
function speak(port: number, lines: string[], expectFrames = 0): Promise<RawExchange> {
  return new Promise<RawExchange>((resolve) => {
    const frames: Array<Record<string, unknown>> = [];
    const decoder = new LineDecoder();
    let settled = false;

    const socket: Socket = connect(port, '127.0.0.1', () => {
      for (const line of lines) socket.write(`${line}\n`);
    });
    socket.setEncoding('utf8');

    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ frames, closed });
    };

    // Long enough for a local round trip, short enough to keep the suite quick. Only the
    // cases where the bridge deliberately keeps the socket open wait this out.
    const timer = setTimeout(() => finish(false), 300);

    socket.on('data', (chunk: string) => {
      for (const line of decoder.push(chunk)) {
        frames.push(JSON.parse(line) as Record<string, unknown>);
      }
      if (expectFrames > 0 && frames.length >= expectFrames) finish(false);
    });
    socket.on('error', () => {});
    socket.on('close', () => finish(true));
  });
}

/** Inputs that must be rejected before any field of the frame is read. */
const MALFORMED: Array<{ name: string; line: (token: string) => string }> = [
  { name: 'a bare null', line: () => 'null' },
  { name: 'a bare number', line: () => '42' },
  { name: 'a bare string', line: () => '"hello"' },
  { name: 'an array', line: () => '[]' },
  { name: 'an object with no type', line: () => '{"threadId":"x"}' },
  { name: 'a non-string type', line: () => '{"type":7}' },
  { name: 'an unknown type', line: () => '{"type":"goodbye"}' },
  { name: 'a hello with no token', line: () => '{"type":"hello","threadId":"x"}' },
  { name: 'a hello with a null token', line: () => '{"type":"hello","token":null,"threadId":"x"}' },
  {
    name: 'a hello with a non-string token',
    line: () => '{"type":"hello","token":123,"threadId":"x"}',
  },
  { name: 'a hello with no threadId', line: (token) => JSON.stringify({ type: 'hello', token }) },
  {
    name: 'a hello with a non-string threadId',
    line: (token) => JSON.stringify({ type: 'hello', token, threadId: 7 }),
  },
];

describe('permission bridge frame validation', () => {
  for (const input of MALFORMED) {
    test(`${input.name} is rejected without crashing the daemon`, async () => {
      const exchange = await speak(bridge.port, [input.line(bridge.token)]);

      assert.deepEqual(exchange.frames, [], 'a rejected peer must learn nothing');
      assert.equal(exchange.closed, true, 'the bridge must hang up on a rejected peer');

      // Surviving the input is the point: the bridge still serves a legitimate client.
      const good = await speak(
        bridge.port,
        [JSON.stringify({ type: 'hello', token: bridge.token, threadId: randomUUID() })],
        1,
      );
      assert.equal(good.frames[0]?.['type'], 'ready');
    });
  }

  test('a wrong token is indistinguishable from a malformed frame', async () => {
    const badToken = await speak(bridge.port, [
      JSON.stringify({ type: 'hello', token: 'x'.repeat(64), threadId: 'x' }),
    ]);
    const noToken = await speak(bridge.port, ['{"type":"hello","threadId":"x"}']);

    // Same silence, same hang-up. A prober must not be able to tell which check failed.
    assert.deepEqual(badToken, noToken);
    assert.deepEqual(badToken.frames, []);
    assert.equal(badToken.closed, true);
  });

  test('a request missing requestId is rejected rather than dispatched', async () => {
    const threadId = randomUUID();
    let dispatched = 0;
    bridge.registerThread(threadId, async () => {
      dispatched += 1;
      return { behavior: 'allow' };
    });

    const exchange = await speak(bridge.port, [
      JSON.stringify({ type: 'hello', token: bridge.token, threadId }),
      JSON.stringify({ type: 'request', toolName: 'Bash', input: { command: 'ls' } }),
    ]);

    assert.equal(dispatched, 0);
    assert.deepEqual(
      exchange.frames.map((frame) => frame['type']),
      ['ready'],
    );
    assert.equal(exchange.closed, true);
  });

  test('a request missing toolName is rejected rather than dispatched', async () => {
    const threadId = randomUUID();
    let dispatched = 0;
    bridge.registerThread(threadId, async () => {
      dispatched += 1;
      return { behavior: 'allow' };
    });

    const exchange = await speak(bridge.port, [
      JSON.stringify({ type: 'hello', token: bridge.token, threadId }),
      JSON.stringify({ type: 'request', requestId: 'r1', input: { command: 'ls' } }),
    ]);

    assert.equal(dispatched, 0);
    assert.deepEqual(
      exchange.frames.map((frame) => frame['type']),
      ['ready'],
    );
    assert.equal(exchange.closed, true);
  });

  test('a request whose input is not an object is rejected rather than dispatched', async () => {
    const threadId = randomUUID();
    let dispatched = 0;
    bridge.registerThread(threadId, async () => {
      dispatched += 1;
      return { behavior: 'allow' };
    });

    const exchange = await speak(bridge.port, [
      JSON.stringify({ type: 'hello', token: bridge.token, threadId }),
      JSON.stringify({ type: 'request', requestId: 'r1', toolName: 'Bash', input: 'ls' }),
    ]);

    assert.equal(dispatched, 0);
    assert.equal(exchange.closed, true);
  });

  test('an unparseable line is still rejected without crashing', async () => {
    const exchange = await speak(bridge.port, ['{not json']);

    assert.deepEqual(exchange.frames, []);
    assert.equal(exchange.closed, true);
  });

  test('a well-formed hello and request still work', async () => {
    const threadId = randomUUID();
    bridge.registerThread(threadId, async () => ({ behavior: 'allow' }));

    const exchange = await speak(
      bridge.port,
      [
        JSON.stringify({ type: 'hello', token: bridge.token, threadId }),
        JSON.stringify({
          type: 'request',
          requestId: 'r1',
          toolName: 'Bash',
          input: { command: 'ls' },
          toolUseId: null,
        }),
      ],
      2,
    );

    assert.deepEqual(
      exchange.frames.map((frame) => frame['type']),
      ['ready', 'response'],
    );
    assert.equal(exchange.frames[1]?.['requestId'], 'r1');
    assert.equal(exchange.frames[1]?.['behavior'], 'allow');
  });
});
