import { createServer, type Server, type Socket } from 'node:net';
import { randomUUID, randomBytes } from 'node:crypto';
import { LineDecoder, encodeJsonLine } from './util/jsonl.js';
import { createLogger } from './util/logger.js';
import type { WorkerProfileId } from '@awos/protocol';

const log = createLogger('permission-bridge');

/**
 * Rendezvous point for Claude's approval prompts.
 *
 * Claude Code spawns its own MCP servers, so a permission-prompt tool has no direct
 * handle on the core process that launched Claude. The bridge closes that loop: it
 * listens on a loopback port, the MCP server dials in with a one-time token, and
 * approval requests travel up while decisions travel down.
 *
 * Loopback-only with a 256-bit token because this socket can approve arbitrary shell
 * commands. It is the most security-sensitive surface in the harness.
 */

export interface BridgeRequest {
  threadId: string;
  /** Exact configured profile whose Claude process opened the bridge connection. */
  workerProfileId?: WorkerProfileId;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string | null;
}

export type BridgeDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export type BridgeHandler = (req: BridgeRequest) => Promise<BridgeDecision>;

interface HelloFrame {
  type: 'hello';
  /**
   * Left unnarrowed by the frame guard on purpose. The guard can only say a field is
   * present and well typed; whether a token is the right one is the comparison's job,
   * and that comparison has to treat a missing or non-string token exactly the way it
   * treats a wrong one.
   */
  token: unknown;
  threadId: string;
  workerProfileId?: unknown;
}

interface RequestFrame {
  type: 'request';
  requestId: string;
  toolName: string;
  input?: Record<string, unknown>;
  toolUseId?: string | null;
}

type InboundFrame = HelloFrame | RequestFrame;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrow a parsed line to a frame whose fields are safe to read.
 *
 * Everything arriving here is unauthenticated input from a loopback socket, so casting
 * it to `InboundFrame` would be a compile-time assertion over bytes the peer chose.
 * Anything that does not match a known frame shape becomes `null`, which is what keeps a
 * malformed line from throwing out of the socket's `data` listener and killing the daemon.
 */
function asInboundFrame(value: unknown): InboundFrame | null {
  if (!isPlainObject(value)) return null;

  if (value['type'] === 'hello') {
    if (typeof value['threadId'] !== 'string') return null;
    if (value['workerProfileId'] !== undefined && typeof value['workerProfileId'] !== 'string') return null;
    return { type: 'hello', token: value['token'], threadId: value['threadId'], workerProfileId: value['workerProfileId'] };
  }

  if (value['type'] === 'request') {
    if (typeof value['requestId'] !== 'string') return null;
    if (typeof value['toolName'] !== 'string') return null;
    const input = value['input'];
    if (input !== undefined && !isPlainObject(input)) return null;
    const toolUseId = value['toolUseId'];
    if (toolUseId !== undefined && toolUseId !== null && typeof toolUseId !== 'string') return null;
    return {
      type: 'request',
      requestId: value['requestId'],
      toolName: value['toolName'],
      input,
      toolUseId,
    };
  }

  return null;
}

export class PermissionBridge {
  readonly token: string;
  #server: Server | null = null;
  #port = 0;
  /** One handler per thread/profile; multiple profiles may share one adapter implementation. */
  readonly #handlers = new Map<string, BridgeHandler>();
  readonly #sockets = new Set<Socket>();

  constructor() {
    this.token = randomBytes(32).toString('hex');
  }

  get port(): number {
    return this.#port;
  }

  async listen(host = '127.0.0.1'): Promise<number> {
    if (this.#server) return this.#port;

    const server = createServer((socket) => this.#onConnection(socket));
    this.#server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Port 0: the OS picks. Nothing else needs to guess it — we pass it via env.
      server.listen(0, host, () => {
        server.off('error', reject);
        resolve();
      });
    });

    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('permission bridge: unexpected socket address');
    }
    this.#port = address.port;
    log.info('listening', { port: this.#port });
    return this.#port;
  }

  registerThread(threadId: string, handler: BridgeHandler): void;
  registerThread(threadId: string, workerProfileId: WorkerProfileId, handler: BridgeHandler): void;
  registerThread(
    threadId: string,
    workerProfileIdOrHandler: WorkerProfileId | BridgeHandler,
    maybeHandler?: BridgeHandler,
  ): void {
    const workerProfileId = typeof workerProfileIdOrHandler === 'function' ? 'claude' : workerProfileIdOrHandler;
    const handler = typeof workerProfileIdOrHandler === 'function' ? workerProfileIdOrHandler : maybeHandler;
    if (!handler) throw new Error('A permission bridge handler is required.');
    this.#handlers.set(this.#key(threadId, workerProfileId), handler);
  }

  unregisterThread(threadId: string, workerProfileId?: WorkerProfileId): void {
    if (workerProfileId !== undefined) {
      this.#handlers.delete(this.#key(threadId, workerProfileId));
      return;
    }
    for (const key of this.#handlers.keys()) {
      if (key.startsWith(`${threadId}\u0000`)) this.#handlers.delete(key);
    }
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  #onConnection(socket: Socket): void {
    this.#sockets.add(socket);
    socket.setEncoding('utf8');

    const decoder = new LineDecoder();
    let authenticated = false;
    let threadId: string | null = null;
    let workerProfileId: WorkerProfileId | null = null;
    const connectionId = randomUUID().slice(0, 8);

    const send = (payload: unknown): void => {
      if (!socket.destroyed) socket.write(encodeJsonLine(payload));
    };

    const fail = (reason: string): void => {
      log.warn('rejecting connection', { connectionId, reason });
      socket.destroy();
    };

    socket.on('data', (chunk: string) => {
      for (const line of decoder.push(chunk)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          fail('unparseable frame');
          return;
        }

        const frame = asInboundFrame(parsed);
        if (frame === null) return fail('malformed frame');

        if (!authenticated) {
          if (frame.type !== 'hello') return fail('first frame was not hello');
          // Type first, then length, then contents: a missing or non-string token is a
          // bad token rather than a crash, and a wrong-length token is rejected without
          // comparing characters.
          if (
            typeof frame.token !== 'string' ||
            frame.token.length !== this.token.length ||
            frame.token !== this.token
          ) {
            return fail('bad token');
          }
          authenticated = true;
          threadId = frame.threadId;
          workerProfileId = typeof frame.workerProfileId === 'string' && frame.workerProfileId !== ''
            ? frame.workerProfileId
            : 'claude';
          log.debug('mcp client attached', { connectionId, threadId, workerProfileId });
          send({ type: 'ready' });
          continue;
        }

        if (frame.type !== 'request') return fail('unexpected frame after hello');
        void this.#dispatch(frame, threadId, workerProfileId, send);
      }
    });

    socket.on('error', (err) => {
      log.debug('socket error', { connectionId, message: err.message });
    });

    socket.on('close', () => {
      this.#sockets.delete(socket);
    });
  }

  async #dispatch(
    frame: RequestFrame,
    threadId: string | null,
    workerProfileId: WorkerProfileId | null,
    send: (payload: unknown) => void,
  ): Promise<void> {
    const respond = (decision: BridgeDecision): void => {
      send({ type: 'response', requestId: frame.requestId, ...decision });
    };

    const handler = threadId === null || workerProfileId === null
      ? undefined
      : this.#handlers.get(this.#key(threadId, workerProfileId));
    if (!handler) {
      // No handler means the thread was torn down while Claude was still running.
      // Denying is the only safe answer: we cannot ask anyone.
      respond({ behavior: 'deny', message: 'Harness is no longer tracking this thread.' });
      return;
    }

    try {
      const request: BridgeRequest = {
        threadId: threadId as string,
        toolName: frame.toolName,
        input: frame.input ?? {},
        toolUseId: frame.toolUseId ?? null,
      };
      if (workerProfileId !== null && workerProfileId !== 'claude') request.workerProfileId = workerProfileId;
      const decision = await handler(request);
      respond(decision);
    } catch (err) {
      log.error('handler threw', { message: (err as Error).message });
      respond({ behavior: 'deny', message: `Harness error: ${(err as Error).message}` });
    }
  }

  #key(threadId: string, workerProfileId: WorkerProfileId): string {
    return `${threadId}\u0000${workerProfileId}`;
  }
}
