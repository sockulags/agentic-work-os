import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import type {
  AgentAvailability,
  ClientMessage,
  ServerMessage,
  ServerResponseBody,
} from '@awos/protocol';
import { AGENT_IDS } from '@awos/protocol';
import type { HarnessConfig } from './config.js';
import type { Orchestrator } from './orchestrator.js';
import { runCapture } from './util/spawn.js';
import { createLogger } from './util/logger.js';
import { CLAUDE_CAPABILITIES } from './adapters/claude.js';
import { CODEX_CAPABILITIES } from './adapters/codex.js';

const log = createLogger('server');

export async function validateWorkingDirectory(cwd: string): Promise<void> {
  try {
    const info = await stat(cwd);
    if (info.isDirectory()) return;
  } catch {
    // Normalize missing, inaccessible, and otherwise invalid paths into one actionable
    // message for the new-thread form.
  }

  throw new Error(`Working directory does not exist or is not a directory: ${cwd}`);
}

/**
 * The UI's only entry point into the core.
 *
 * Loopback plus a shared secret, for the same reason the permission bridge is guarded:
 * anything that can open this socket can run arbitrary commands through an agent. The
 * token is minted per process and handed to the UI at launch (Tauri passes it as an
 * argument; `npm run dev` prints it).
 */
export class HarnessServer {
  readonly token: string;
  readonly #config: HarnessConfig;
  readonly #orchestrator: Orchestrator;
  readonly #clients = new Set<WebSocket>();
  #wss: WebSocketServer | null = null;

  constructor(config: HarnessConfig, orchestrator: Orchestrator) {
    this.#config = config;
    this.#orchestrator = orchestrator;
    this.token = process.env['AWOS_TOKEN'] ?? randomBytes(24).toString('hex');

    orchestrator.on('event', (event) => this.broadcast({ type: 'event', event }));
    orchestrator.on('state', (state) => this.broadcast({ type: 'state', state }));
    orchestrator.on('thread', (thread) => this.broadcast({ type: 'thread.updated', thread }));
  }

  async listen(): Promise<number> {
    const wss = new WebSocketServer({ host: this.#config.host, port: this.#config.port });
    this.#wss = wss;

    await new Promise<void>((resolve, reject) => {
      wss.once('error', reject);
      wss.once('listening', () => {
        wss.off('error', reject);
        resolve();
      });
    });

    wss.on('connection', (socket) => this.#onConnection(socket));

    const address = wss.address();
    const port = typeof address === 'object' && address !== null ? address.port : this.#config.port;
    log.info('listening', { host: this.#config.host, port });
    return port;
  }

  async close(): Promise<void> {
    for (const client of this.#clients) client.close();
    this.#clients.clear();
    const wss = this.#wss;
    this.#wss = null;
    if (!wss) return;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const client of this.#clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  #onConnection(socket: WebSocket): void {
    let authenticated = false;

    const send = (message: ServerMessage): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };

    socket.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        socket.close(1003, 'invalid json');
        return;
      }

      if (!authenticated) {
        if (msg.type !== 'hello' || msg.token !== this.token) {
          log.warn('rejecting unauthenticated client');
          socket.close(4001, 'unauthorized');
          return;
        }
        authenticated = true;
        this.#clients.add(socket);
        send({ requestId: msg.requestId, type: 'ok' });
        return;
      }

      void this.#handle(msg)
        .then((body) => send({ ...body, requestId: msg.requestId }))
        .catch((err: Error) => {
          log.error('request failed', { type: msg.type, message: err.message });
          send({ requestId: msg.requestId, type: 'error', message: err.message });
        });
    });

    socket.on('close', () => this.#clients.delete(socket));
    socket.on('error', (err) => log.debug('client error', { message: err.message }));
  }

  async #handle(msg: ClientMessage): Promise<ServerResponseBody> {
    const orchestrator = this.#orchestrator;

    switch (msg.type) {
      case 'hello':
        return { type: 'ok' };

      case 'thread.list':
        return { type: 'thread.list', threads: orchestrator.store.list() };

      case 'thread.create': {
        const cwd = msg.cwd.trim();
        await validateWorkingDirectory(cwd);
        const thread = orchestrator.createThread({
          cwd,
          title: msg.title,
          agent: msg.agent,
        });
        return { type: 'thread.created', thread };
      }

      case 'thread.open': {
        const thread = orchestrator.store.get(msg.threadId);
        if (!thread) throw new Error(`Unknown thread ${msg.threadId}`);
        return {
          type: 'thread.opened',
          thread,
          events: orchestrator.store.events(msg.threadId),
          state: orchestrator.state(msg.threadId),
        };
      }

      case 'thread.delete':
        orchestrator.deleteThread(msg.threadId);
        this.broadcast({ type: 'thread.removed', threadId: msg.threadId });
        return { type: 'ok' };

      case 'thread.setAgent': {
        const thread = orchestrator.store.update(msg.threadId, { activeAgent: msg.agent });
        this.broadcast({ type: 'thread.updated', thread });
        return { type: 'ok' };
      }

      case 'thread.setPermissionMode':
        orchestrator.setPermissionMode(msg.threadId, msg.mode);
        return { type: 'ok' };

      case 'turn.send':
        // Deliberately not awaited: a turn runs for minutes and its output arrives as
        // pushed events. Awaiting here would stall this client's request pipeline.
        void orchestrator.send(msg.threadId, msg.agent, msg.text).catch((err: Error) => {
          this.broadcast({ type: 'notice', level: 'error', message: err.message });
        });
        return { type: 'ok' };

      case 'turn.interrupt':
        await orchestrator.interrupt(msg.threadId, msg.agent);
        return { type: 'ok' };

      case 'thread.setParallel':
        await orchestrator.setParallel(msg.threadId, msg.parallel);
        return { type: 'ok' };

      case 'lane.integrate': {
        // A refused integration is an answer, not a transport failure, but the UI has one
        // way to show either — and the reason is the part the user has to act on.
        const result = await orchestrator.integrateLane(msg.threadId, msg.agent);
        return result.ok ? { type: 'ok' } : { type: 'error', message: result.detail };
      }

      case 'approval.resolve':
        orchestrator.resolveApproval(msg.threadId, msg.approvalId, msg.optionId);
        return { type: 'ok' };

      case 'context.get':
        return {
          type: 'context',
          threadId: msg.threadId,
          text: orchestrator.getPinnedContext(msg.threadId),
        };

      case 'context.set':
        orchestrator.setPinnedContext(msg.threadId, msg.text);
        return { type: 'ok' };

      case 'workspace.get': {
        const cwd = this.#workspaceCwd(msg);
        return { type: 'workspace', cwd, resolution: orchestrator.workspace(cwd) };
      }

      case 'work.get':
        return {
          type: 'work',
          threadId: msg.threadId,
          item: orchestrator.workItem(msg.threadId),
          error: null,
        };

      case 'work.attach': {
        const result = await orchestrator.attachWorkItem(msg.threadId, msg.reference);
        return { type: 'work', threadId: msg.threadId, ...result };
      }

      case 'work.refresh': {
        const result = await orchestrator.refreshWorkItem(msg.threadId);
        return { type: 'work', threadId: msg.threadId, ...result };
      }

      case 'work.detach':
        orchestrator.detachWorkItem(msg.threadId);
        return { type: 'work', threadId: msg.threadId, item: null, error: null };

      case 'work.start':
        // Not awaited, for the same reason `turn.send` is not: a run is a turn, and a turn
        // is minutes of streamed events rather than a request to wait on.
        void orchestrator.send(msg.threadId, msg.agent, msg.text, true).catch((err: Error) => {
          this.broadcast({ type: 'notice', level: 'error', message: err.message });
        });
        return { type: 'ok' };

      case 'agents.probe':
        return { type: 'agents.probe', agents: await this.#probeAgents() };

      default: {
        const exhaustive: never = msg;
        throw new Error(`Unhandled request: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /**
   * Which directory a `workspace.get` is asking about.
   *
   * Naming both a thread and a path is rejected rather than resolved by precedence: the
   * two can disagree, and a caller that sent both does not know which one it meant.
   */
  #workspaceCwd(msg: { threadId?: string; cwd?: string }): string {
    if (msg.threadId !== undefined && msg.cwd !== undefined) {
      throw new Error('Ask about a thread or about a path, not both.');
    }
    if (msg.cwd !== undefined) return msg.cwd;
    if (msg.threadId === undefined) throw new Error('workspace.get needs a threadId or a cwd.');

    const thread = this.#orchestrator.store.get(msg.threadId);
    if (!thread) throw new Error(`Unknown thread ${msg.threadId}`);
    return thread.cwd;
  }

  async #probeAgents(): Promise<AgentAvailability[]> {
    return Promise.all(
      AGENT_IDS.map(async (agent): Promise<AgentAvailability> => {
        const bin = agent === 'claude' ? this.#config.claudeBin : this.#config.codexBin;
        // Capabilities describe the adapter, not the installation, so they are reported
        // even when the binary is missing.
        const capabilities = agent === 'claude' ? CLAUDE_CAPABILITIES : CODEX_CAPABILITIES;
        const result = await runCapture(bin, ['--version']);
        const output = `${result.stdout}${result.stderr}`.trim();
        if (result.code === 0 && output) {
          return {
            agent,
            available: true,
            detail: output.split('\n')[0] ?? output,
            capabilities,
          };
        }
        return {
          agent,
          available: false,
          detail: output || `\`${bin}\` not found on PATH`,
          capabilities,
        };
      }),
    );
  }
}
