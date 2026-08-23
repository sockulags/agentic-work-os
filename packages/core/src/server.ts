import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import type {
  AgentAvailability,
  ClientMessage,
  ServerMessage,
  ServerResponseBody,
  WorkItem,
  WorkSourceError,
} from '@awos/protocol';
import type { HarnessConfig } from './config.js';
import type { Orchestrator } from './orchestrator.js';
import { createLogger } from './util/logger.js';
import { probeWorkerProfiles } from './adapters/registry.js';

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
        const result = await orchestrator.integrateLane(
          msg.threadId,
          msg.agent,
          msg.override === undefined ? null : { actor: 'user', reason: msg.override.reason },
        );
        return result.ok ? { type: 'ok' } : { type: 'error', message: result.detail };
      }

      case 'gate.get': {
        const decision = await orchestrator.gate(msg.threadId, msg.agent);
        return {
          type: 'gate',
          threadId: msg.threadId,
          agent: msg.agent,
          allowed: decision.allowed,
          requirements: decision.requirements,
          candidate: decision.candidate,
        };
      }

      case 'verify.run':
        // Not awaited: a project's test suite is minutes of work, and its result arrives
        // as an event like everything else that takes time here.
        void orchestrator.runCheck(msg.threadId, msg.agent, msg.name).catch((err: Error) => {
          this.broadcast({ type: 'notice', level: 'error', message: err.message });
        });
        return { type: 'ok' };

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
        return this.#work(msg.threadId, { item: orchestrator.workItem(msg.threadId), error: null });

      case 'work.attach':
        return this.#work(msg.threadId, await orchestrator.attachWorkItem(msg.threadId, msg.reference));

      case 'work.refresh':
        return this.#work(msg.threadId, await orchestrator.refreshWorkItem(msg.threadId));

      case 'work.detach':
        orchestrator.detachWorkItem(msg.threadId);
        return { type: 'work', threadId: msg.threadId, item: null, error: null, retained: [] };

      case 'run.close':
        orchestrator.closeRun(msg.threadId, msg.runId, msg.claim, msg.statement);
        return { type: 'ok' };

      case 'evidence.record':
        await orchestrator.recordEvidence(msg.threadId, {
          runId: msg.runId,
          kind: msg.evidenceKind,
          ref: msg.ref,
          summary: msg.summary,
          ...(msg.evidenceId === undefined ? {} : { evidenceId: msg.evidenceId }),
        });
        return { type: 'ok' };

      case 'context.retain':
        orchestrator.retainContext(msg.threadId, {
          kind: msg.retainedKind,
          text: msg.text,
          runId: msg.runId ?? null,
        });
        return this.#work(msg.threadId, {
          item: orchestrator.workItem(msg.threadId),
          error: null,
        });

      case 'context.amend':
        orchestrator.amendRetained(msg.threadId, msg.retainedId, {
          ...(msg.selected === undefined ? {} : { selected: msg.selected }),
          ...(msg.retired === undefined ? {} : { retired: msg.retired }),
        });
        return this.#work(msg.threadId, {
          item: orchestrator.workItem(msg.threadId),
          error: null,
        });

      case 'work.start':
        // Not awaited, for the same reason `turn.send` is not: a run is a turn, and a turn
        // is minutes of streamed events rather than a request to wait on.
        void orchestrator.send(msg.threadId, msg.agent, msg.text, true).catch((err: Error) => {
          this.broadcast({ type: 'notice', level: 'error', message: err.message });
        });
        return { type: 'ok' };

      case 'catalog.get': {
        const cwd = this.#workspaceCwd(msg);
        return { type: 'catalog', cwd, ...orchestrator.getIssueCatalog(cwd) };
      }

      case 'catalog.refresh': {
        const cwd = this.#workspaceCwd(msg);
        return { type: 'catalog', cwd, ...(await orchestrator.refreshIssueCatalog(cwd)) };
      }

      case 'agents.probe':
        return { type: 'agents.probe', agents: await this.#probeAgents() };

      default: {
        const exhaustive: never = msg;
        throw new Error(`Unhandled request: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /**
   * One shape for every answer about a thread's work.
   *
   * The retained ledger comes along with each of them: it changes whenever the item does,
   * and a client that had to ask twice would spend half its life showing one of the two
   * halves out of date.
   */
  #work(
    threadId: string,
    result: { item: WorkItem | null; error: WorkSourceError | null },
  ): ServerResponseBody {
    return {
      type: 'work',
      threadId,
      ...result,
      retained: this.#orchestrator.retainedFor(threadId),
    };
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
    return probeWorkerProfiles(this.#config);
  }
}
