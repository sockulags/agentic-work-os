#!/usr/bin/env node
/**
 * A single-tool MCP server whose only job is to relay Claude's permission prompts
 * back to the harness core.
 *
 * Claude Code spawns this as its own child (via `--mcp-config`) and calls the tool
 * whenever a tool call needs approval. We dial the core's PermissionBridge over
 * loopback TCP, wait for a human decision, and return Claude's expected contract.
 *
 * Hand-rolled JSON-RPC rather than @modelcontextprotocol/sdk: this server implements
 * exactly three methods, the framing code already exists for the Codex adapter, and
 * keeping it dependency-free means it starts fast and can't break on an SDK bump.
 *
 * stdout is the protocol channel. All diagnostics go to stderr — see util/logger.ts.
 */

import { connect, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { LineDecoder, encodeJsonLine } from '../util/jsonl.js';
import { createLogger } from '../util/logger.js';
import {
  CLAUDE_PERMISSION_TOOL_NAME,
  type ClaudePermissionToolResult,
} from '@awos/protocol';

const log = createLogger('permission-mcp');

const MCP_PROTOCOL_VERSION = '2024-11-05';

const BRIDGE_PORT = Number.parseInt(process.env['AWOS_BRIDGE_PORT'] ?? '', 10);
const BRIDGE_TOKEN = process.env['AWOS_BRIDGE_TOKEN'] ?? '';
const THREAD_ID = process.env['AWOS_THREAD_ID'] ?? '';

interface PendingRequest {
  resolve: (decision: BridgeResponse) => void;
  reject: (err: Error) => void;
}

interface BridgeResponse {
  type: 'response';
  requestId: string;
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}

/** Connection to the harness core, established lazily and re-established on drop. */
class BridgeClient {
  #socket: Socket | null = null;
  #connecting: Promise<Socket> | null = null;
  readonly #pending = new Map<string, PendingRequest>();

  async #connect(): Promise<Socket> {
    if (this.#socket && !this.#socket.destroyed) return this.#socket;
    if (this.#connecting) return this.#connecting;

    this.#connecting = new Promise<Socket>((resolve, reject) => {
      const socket = connect({ port: BRIDGE_PORT, host: '127.0.0.1' });
      socket.setEncoding('utf8');
      const decoder = new LineDecoder();
      let ready = false;

      const onError = (err: Error): void => {
        this.#connecting = null;
        this.#socket = null;
        if (!ready) reject(err);
        this.#failAll(err);
      };

      socket.on('error', onError);

      socket.on('close', () => {
        this.#socket = null;
        this.#connecting = null;
        const err = new Error('permission bridge closed the connection');
        // The bridge hangs up without a `ready` frame when the token is wrong or the
        // thread is unknown. Rejecting here is what turns that into a deny; without it
        // the connect promise never settles and the agent waits forever.
        if (!ready) reject(err);
        this.#failAll(err);
      });

      socket.on('data', (chunk: string) => {
        for (const line of decoder.push(chunk)) {
          let frame: { type: string } & Record<string, unknown>;
          try {
            frame = JSON.parse(line) as { type: string } & Record<string, unknown>;
          } catch {
            continue;
          }

          if (frame.type === 'ready') {
            ready = true;
            this.#socket = socket;
            this.#connecting = null;
            resolve(socket);
            continue;
          }

          if (frame.type === 'response') {
            const response = frame as unknown as BridgeResponse;
            const pending = this.#pending.get(response.requestId);
            if (pending) {
              this.#pending.delete(response.requestId);
              pending.resolve(response);
            }
          }
        }
      });

      socket.on('connect', () => {
        socket.write(
          encodeJsonLine({ type: 'hello', token: BRIDGE_TOKEN, threadId: THREAD_ID }),
        );
      });
    });

    return this.#connecting;
  }

  #failAll(err: Error): void {
    for (const [, pending] of this.#pending) pending.reject(err);
    this.#pending.clear();
  }

  async request(
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string | null,
  ): Promise<BridgeResponse> {
    const socket = await this.#connect();
    const requestId = randomUUID();

    return new Promise<BridgeResponse>((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      socket.write(encodeJsonLine({ type: 'request', requestId, toolName, input, toolUseId }));
    });
  }
}

const bridge = new BridgeClient();

// ---------------------------------------------------------------------------
// MCP surface
// ---------------------------------------------------------------------------

const TOOL_DEFINITION = {
  name: CLAUDE_PERMISSION_TOOL_NAME,
  description:
    'Ask the human operator to approve or deny a tool call. Called automatically by ' +
    'Claude Code via --permission-prompt-tool; not intended for direct use.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string', description: 'Name of the tool awaiting approval' },
      input: { type: 'object', description: 'Input the tool would receive' },
      tool_use_id: { type: 'string', description: 'Identifier of the pending tool call' },
    },
    required: ['tool_name', 'input'],
    additionalProperties: true,
  },
} as const;

function write(message: unknown): void {
  process.stdout.write(encodeJsonLine(message));
}

function respond(id: unknown, result: unknown): void {
  write({ jsonrpc: '2.0', id, result });
}

function respondError(id: unknown, code: number, message: string): void {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

/** Wrap a permission decision in the shape Claude Code expects. */
function toolResult(payload: ClaudePermissionToolResult): unknown {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

async function handleToolCall(id: unknown, params: unknown): Promise<void> {
  const args = (params as { name?: string; arguments?: Record<string, unknown> }) ?? {};
  const toolArgs = args.arguments ?? {};
  const toolName = typeof toolArgs['tool_name'] === 'string' ? toolArgs['tool_name'] : 'unknown';
  const toolInput =
    typeof toolArgs['input'] === 'object' && toolArgs['input'] !== null
      ? (toolArgs['input'] as Record<string, unknown>)
      : {};
  const toolUseId = typeof toolArgs['tool_use_id'] === 'string' ? toolArgs['tool_use_id'] : null;

  try {
    const decision = await bridge.request(toolName, toolInput, toolUseId);
    if (decision.behavior === 'allow') {
      respond(
        id,
        toolResult({ behavior: 'allow', updatedInput: decision.updatedInput ?? toolInput }),
      );
    } else {
      respond(
        id,
        toolResult({ behavior: 'deny', message: decision.message ?? 'Denied by operator.' }),
      );
    }
  } catch (err) {
    // Failing closed is the only defensible default: if we cannot reach a human,
    // we must not grant the tool call.
    log.error('bridge request failed', { message: (err as Error).message });
    respond(
      id,
      toolResult({
        behavior: 'deny',
        message: `Harness unreachable, denying by default: ${(err as Error).message}`,
      }),
    );
  }
}

function main(): void {
  if (!Number.isFinite(BRIDGE_PORT) || BRIDGE_TOKEN === '' || THREAD_ID === '') {
    log.error('missing AWOS_BRIDGE_PORT / AWOS_BRIDGE_TOKEN / AWOS_THREAD_ID');
    process.exit(2);
  }

  const decoder = new LineDecoder();
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (chunk: string) => {
    for (const line of decoder.push(chunk)) {
      let msg: { id?: unknown; method?: string; params?: unknown };
      try {
        msg = JSON.parse(line) as { id?: unknown; method?: string; params?: unknown };
      } catch {
        continue;
      }

      switch (msg.method) {
        case 'initialize':
          respond(msg.id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'awos-permissions', version: '0.1.0' },
          });
          break;

        case 'notifications/initialized':
          break;

        case 'tools/list':
          respond(msg.id, { tools: [TOOL_DEFINITION] });
          break;

        case 'tools/call':
          void handleToolCall(msg.id, msg.params);
          break;

        case 'ping':
          respond(msg.id, {});
          break;

        default:
          // Notifications carry no id and must not be answered.
          if (msg.id !== undefined) {
            respondError(msg.id, -32601, `Method not found: ${String(msg.method)}`);
          }
      }
    }
  });

  process.stdin.on('end', () => process.exit(0));
  log.info('ready', { bridgePort: BRIDGE_PORT, threadId: THREAD_ID });
}

main();
