import { randomUUID } from 'node:crypto';
import {
  CODEX_METHODS,
  CODEX_NOTIFICATIONS,
  CodexWire,
  type PlanItem,
  type PlanItemStatus,
  type ToolKind,
} from '@awos/protocol';
import type { WorkerAdapter, AgentCapabilities, AdapterContext } from './agent.js';
import { spawnCli, type StdioChild } from '../util/spawn.js';
import { readJsonLines, encodeJsonLine } from '../util/jsonl.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('adapter:codex');

/**
 * Drives `codex app-server` over JSON-RPC on stdio.
 *
 * Unlike Claude, this protocol is bidirectional in both directions: the server sends us
 * *requests* (approvals) that block its turn until we answer. Every inbound request must
 * be answered exactly once, including during shutdown, or the agent hangs forever.
 */
/** Exported for the capability probe; see the note on CLAUDE_CAPABILITIES. */
export const CODEX_CAPABILITIES: AgentCapabilities = {
  streamingToolOutput: true,
  streamingText: true,
  reasoning: true,
  plans: true,
  // `turn/diff/updated` carries a cumulative patch for the whole turn.
  turnDiff: true,
  approvals: true,
  resumableSessions: true,
};

export class CodexAdapter implements WorkerAdapter {
  readonly id = 'codex-app-server' as const;

  readonly capabilities: AgentCapabilities = CODEX_CAPABILITIES;

  #ctx: AdapterContext;
  #child: StdioChild | null = null;
  #threadId: string | null = null;
  #turnId: string | null = null;
  #busy = false;
  #model: string | null = null;
  #starting: Promise<void> | null = null;
  #nextRequestId = 1;
  #turnStartedAt = 0;

  /** Requests we sent, awaiting a response. */
  readonly #pending = new Map<
    number | string,
    { resolve: (result: unknown) => void; reject: (err: Error) => void; method: string }
  >();

  /** Approvals the server asked us for, keyed by our approvalId. */
  readonly #approvals = new Map<
    string,
    { rpcId: number | string; timer: NodeJS.Timeout }
  >();

  #turnSettle: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(ctx: AdapterContext) {
    this.#ctx = ctx;
  }

  get nativeSessionId(): string | null {
    return this.#threadId;
  }

  get busy(): boolean {
    return this.#busy;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.#child && this.#threadId) return;
    if (this.#starting) return this.#starting;
    this.#starting = this.#doStart();
    try {
      await this.#starting;
    } finally {
      this.#starting = null;
    }
  }

  async #doStart(): Promise<void> {
    const { config, cwd, resumeSessionId } = this.#ctx;

    log.info('spawning', { cwd });
    this.#emitStatus('spawning', null);

    const child = spawnCli(config.codexBin, [...config.codexBinArgs, 'app-server'], { cwd });
    this.#child = child;

    readJsonLines<CodexWire.JsonRpcMessage>(child.stdout, {
      onMessage: (msg) => this.#onMessage(msg),
      onUnparseable: (line) => log.debug('non-json stdout', { line: line.slice(0, 200) }),
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text) log.warn('stderr', { text: text.slice(0, 500) });
    });

    child.on('error', (err) => {
      log.error('spawn failed', { message: err.message });
      this.#emitStatus('failed', err.message);
      this.#ctx.emit({
        kind: 'error',
        severity: 'fatal',
        message:
          `Could not start Codex (${config.codexBin} app-server): ${err.message}. ` +
          'Check that it is installed and on PATH, or set AWOS_CODEX_BIN.',
      });
      this.#rejectAllPending(err);
      this.#failTurn(err);
    });

    child.on('close', (code) => {
      log.info('exited', { code });
      this.#child = null;
      this.#threadId = null;
      this.#emitStatus('exited', code === null ? null : `exit code ${code}`);
      const err = new Error(`Codex app-server exited (code ${code ?? 'null'})`);
      this.#rejectAllPending(err);
      this.#failTurn(err);
    });

    // Handshake. The server rejects everything until initialize/initialized complete.
    await this.#request(CODEX_METHODS.initialize, {
      clientInfo: { name: 'agentic-work-os', title: 'Agentic Work OS', version: '0.1.0' },
    } satisfies CodexWire.CodexInitializeParams);

    this.#notify(CODEX_METHODS.initialized, {});

    if (resumeSessionId) {
      try {
        const result = (await this.#request(CODEX_METHODS.threadResume, {
          threadId: resumeSessionId,
        })) as CodexWire.CodexThreadStartResult | undefined;
        this.#threadId = result?.thread?.id ?? resumeSessionId;
      } catch (err) {
        // A resumable id can go stale — Codex may have pruned it. Starting fresh and
        // letting replay rebuild context is better than failing the whole thread.
        log.warn('resume failed, starting a new thread', {
          message: (err as Error).message,
        });
        this.#threadId = null;
      }
    }

    if (!this.#threadId) {
      const params: CodexWire.CodexThreadStartParams = { cwd };
      if (config.codexModel) params.model = config.codexModel;
      const result = (await this.#request(
        CODEX_METHODS.threadStart,
        params,
      )) as CodexWire.CodexThreadStartResult;
      this.#threadId = result.thread.id;
    }

    this.#ctx.onSessionId(this.#threadId);
    this.#emitStatus('ready', null);
    log.info('ready', { threadId: this.#threadId });
  }

  async stop(): Promise<void> {
    // Answer anything outstanding before we go, or the server waits forever.
    for (const [approvalId] of this.#approvals) {
      this.#settleApproval(approvalId, 'denied', true);
    }

    const child = this.#child;
    this.#child = null;
    this.#threadId = null;
    if (!child) return;

    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve();
      }, this.#ctx.config.interruptGraceMs);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  async sendTurn(text: string): Promise<void> {
    await this.start();
    if (!this.#child || !this.#threadId) throw new Error('Codex is not running.');
    if (this.#busy) throw new Error('Codex is already working on a turn.');

    this.#busy = true;
    this.#turnStartedAt = Date.now();
    // Provisional id; replaced by the server's turn id when `turn/started` lands.
    this.#turnId = randomUUID();

    this.#ctx.emit({
      kind: 'turn.started',
      turnId: this.#turnId,
      nativeSessionId: this.#threadId,
    });
    this.#emitStatus('busy', null);

    const settled = new Promise<void>((resolve, reject) => {
      this.#turnSettle = {
        resolve: () => {
          this.#turnSettle = null;
          resolve();
        },
        reject: (err) => {
          this.#turnSettle = null;
          reject(err);
        },
      };
    });

    try {
      await this.#request(CODEX_METHODS.turnStart, {
        threadId: this.#threadId,
        input: [{ type: 'text', text }],
      } satisfies CodexWire.CodexTurnStartParams);
    } catch (err) {
      this.#failTurn(err as Error);
      throw err;
    }

    // turn/start returns as soon as the turn is accepted; completion arrives later
    // as a notification, which is what actually settles this promise.
    return settled;
  }

  async interrupt(): Promise<void> {
    if (!this.#busy || !this.#threadId) return;
    try {
      await this.#request(CODEX_METHODS.turnInterrupt, { threadId: this.#threadId });
    } catch (err) {
      log.warn('interrupt failed', { message: (err as Error).message });
    }
  }

  resolveApproval(approvalId: string, optionId: string): void {
    const decision: CodexWire.CodexApprovalResponse['decision'] =
      optionId === 'allow'
        ? 'approved'
        : optionId === 'allow_session'
          ? 'approved_for_session'
          : optionId === 'abort'
            ? 'abort'
            : 'denied';
    this.#settleApproval(approvalId, decision, false);
  }

  #settleApproval(
    approvalId: string,
    decision: CodexWire.CodexApprovalResponse['decision'],
    auto: boolean,
  ): void {
    const pending = this.#approvals.get(approvalId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#approvals.delete(approvalId);

    this.#respond(pending.rpcId, { decision });

    const behavior =
      decision === 'approved' || decision === 'approved_for_session' ? 'allow' : 'deny';
    this.#ctx.emit({
      kind: 'approval.resolved',
      turnId: this.#turnId,
      approvalId,
      optionId: decision,
      behavior,
      auto,
    });
  }

  // -------------------------------------------------------------------------
  // JSON-RPC plumbing
  // -------------------------------------------------------------------------

  #write(payload: unknown): void {
    const child = this.#child;
    if (!child) throw new Error('Codex is not running.');
    child.stdin.write(encodeJsonLine(payload));
  }

  #request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.#pending.delete(id)) {
          reject(new Error(`Codex did not answer ${method} within the timeout.`));
        }
      }, this.#ctx.config.codexInitTimeoutMs);

      this.#pending.set(id, {
        method,
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      try {
        this.#write({ method, id, params });
      } catch (err) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(err as Error);
      }
    });
  }

  #notify(method: string, params: unknown): void {
    this.#write({ method, params });
  }

  #respond(id: number | string, result: unknown): void {
    try {
      this.#write({ id, result });
    } catch (err) {
      log.warn('could not send response', { message: (err as Error).message });
    }
  }

  #rejectAllPending(err: Error): void {
    for (const [, pending] of this.#pending) pending.reject(err);
    this.#pending.clear();
  }

  #onMessage(msg: CodexWire.JsonRpcMessage): void {
    if (CodexWire.isJsonRpcResponse(msg)) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if (CodexWire.isJsonRpcFailure(msg)) {
        pending.reject(new Error(`${pending.method}: ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (CodexWire.isJsonRpcRequest(msg)) {
      this.#onServerRequest(msg);
      return;
    }

    this.#onNotification(msg as CodexWire.JsonRpcNotification);
  }

  #onServerRequest(msg: CodexWire.JsonRpcRequest): void {
    if (msg.method !== CODEX_NOTIFICATIONS.approvalRequest) {
      // Unknown inbound request: answer anyway so the turn is never wedged.
      log.warn('unhandled server request', { method: msg.method });
      this.#respond(msg.id, {});
      return;
    }

    const params = (msg.params ?? {}) as CodexWire.CodexApprovalRequestParams;
    const approvalId = randomUUID();
    const { title, detail, toolKind } = describeCodexApproval(params);

    const timer = setTimeout(() => {
      log.warn('approval timed out', { approvalId });
      this.#settleApproval(approvalId, 'denied', true);
    }, this.#ctx.config.approvalTimeoutMs);

    this.#approvals.set(approvalId, { rpcId: msg.id, timer });

    this.#ctx.emit({
      kind: 'approval.requested',
      turnId: this.#turnId,
      approvalId,
      toolName: params.type ?? 'exec',
      toolKind,
      title,
      detail,
      input: params,
      options: [
        { id: 'allow', label: 'Allow once', behavior: 'allow', persistent: false },
        {
          id: 'allow_session',
          label: 'Allow for session',
          behavior: 'allow',
          persistent: true,
        },
        { id: 'deny', label: 'Deny', behavior: 'deny', persistent: false },
      ],
    });
  }

  #onNotification(msg: CodexWire.JsonRpcNotification): void {
    const params = (msg.params ?? {}) as Record<string, unknown>;

    switch (msg.method) {
      case CODEX_NOTIFICATIONS.threadStarted: {
        const p = params as unknown as CodexWire.CodexThreadStartedParams;
        if (p.thread?.id) {
          this.#threadId = p.thread.id;
          this.#ctx.onSessionId(p.thread.id);
        }
        return;
      }

      case CODEX_NOTIFICATIONS.turnStarted: {
        const p = params as unknown as CodexWire.CodexTurnStartedParams;
        if (p.turn?.id) this.#turnId = p.turn.id;
        return;
      }

      case CODEX_NOTIFICATIONS.turnCompleted: {
        const p = params as unknown as CodexWire.CodexTurnCompletedParams;
        const usage = p.turn?.usage;
        if (usage) {
          this.#ctx.emit({
            kind: 'usage',
            turnId: this.#turnId,
            inputTokens: usage.inputTokens ?? null,
            outputTokens: usage.outputTokens ?? null,
            cacheReadTokens: usage.cachedInputTokens ?? null,
            cacheWriteTokens: null,
            costUsd: null,
          });
        }

        const status = p.turn?.status;
        this.#ctx.emit({
          kind: 'turn.completed',
          turnId: this.#turnId,
          reason:
            status === 'interrupted'
              ? 'interrupted'
              : status === 'failed'
                ? 'error'
                : 'completed',
          error: status === 'failed' ? 'Codex reported a failed turn.' : null,
          durationMs: Date.now() - this.#turnStartedAt,
        });

        this.#busy = false;
        this.#turnId = null;
        this.#emitStatus('idle', null);
        this.#turnSettle?.resolve();
        return;
      }

      case CODEX_NOTIFICATIONS.agentMessageDelta: {
        const p = params as unknown as CodexWire.CodexAgentMessageDeltaParams;
        if (!p.delta) return;
        this.#ctx.emit({
          kind: 'message.delta',
          turnId: this.#turnId,
          itemId: p.itemId ?? 'agent-message',
          text: p.delta,
        });
        return;
      }

      case CODEX_NOTIFICATIONS.reasoningDelta: {
        const p = params as unknown as CodexWire.CodexAgentMessageDeltaParams;
        if (!p.delta) return;
        this.#ctx.emit({
          kind: 'reasoning.delta',
          turnId: this.#turnId,
          itemId: p.itemId ?? 'reasoning',
          text: p.delta,
        });
        return;
      }

      case CODEX_NOTIFICATIONS.execOutputDelta: {
        const p = params as unknown as CodexWire.CodexExecOutputDeltaParams;
        const chunk = p.chunk ?? p.delta;
        if (!chunk) return;
        this.#ctx.emit({
          kind: 'tool.output',
          turnId: this.#turnId,
          itemId: p.itemId ?? p.execId ?? 'exec',
          stream: p.stream === 'stderr' ? 'stderr' : 'stdout',
          chunk,
        });
        return;
      }

      case CODEX_NOTIFICATIONS.itemStarted: {
        const p = params as unknown as CodexWire.CodexItemLifecycleParams;
        this.#onItemStarted(p.item);
        return;
      }

      case CODEX_NOTIFICATIONS.itemCompleted: {
        const p = params as unknown as CodexWire.CodexItemLifecycleParams;
        this.#onItemCompleted(p.item);
        return;
      }

      case CODEX_NOTIFICATIONS.planUpdated: {
        const items = extractCodexPlan(params);
        if (items.length > 0) {
          this.#ctx.emit({ kind: 'plan.updated', turnId: this.#turnId, items });
        }
        return;
      }

      case CODEX_NOTIFICATIONS.diffUpdated: {
        const p = params as unknown as CodexWire.CodexDiffUpdatedParams;
        if (typeof p.diff === 'string') {
          this.#ctx.emit({ kind: 'diff.updated', turnId: this.#turnId, patch: p.diff });
        }
        return;
      }

      default:
        log.debug('unhandled notification', { method: msg.method });
    }
  }

  #onItemStarted(item: CodexWire.CodexItem | undefined): void {
    if (!item) return;
    const type = itemType(item);
    // Message and reasoning items arrive as deltas; only tool-shaped items open a row.
    if (type === 'agentmessage' || type === 'reasoning' || type === 'usermessage') return;

    this.#ctx.emit({
      kind: 'tool.started',
      turnId: this.#turnId,
      itemId: item.id,
      name: type,
      toolKind: classifyCodexItem(type),
      title: summarizeCodexItem(item),
      input: item,
    });
  }

  #onItemCompleted(item: CodexWire.CodexItem | undefined): void {
    if (!item) return;
    const type = itemType(item);

    if (type === 'agentmessage') {
      if (item.text) {
        this.#ctx.emit({
          kind: 'message.completed',
          turnId: this.#turnId,
          itemId: item.id,
          text: item.text,
        });
      }
      return;
    }

    if (type === 'reasoning') {
      if (item.text) {
        this.#ctx.emit({
          kind: 'reasoning.completed',
          turnId: this.#turnId,
          itemId: item.id,
          text: item.text,
        });
      }
      return;
    }

    if (type === 'usermessage') return;

    const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null;
    const failed =
      item.status === 'failed' || item.status === 'error' || (exitCode !== null && exitCode !== 0);

    this.#ctx.emit({
      kind: 'tool.completed',
      turnId: this.#turnId,
      itemId: item.id,
      status: item.status === 'aborted' ? 'aborted' : failed ? 'error' : 'ok',
      output: codexItemOutput(item),
      exitCode,
    });
  }

  #emitStatus(
    status: 'spawning' | 'ready' | 'busy' | 'idle' | 'exited' | 'failed',
    detail: string | null,
  ): void {
    this.#ctx.emit({
      kind: 'agent.status',
      turnId: this.#turnId,
      status,
      model: this.#model,
      detail,
    });
  }

  #failTurn(err: Error): void {
    if (!this.#busy) return;
    this.#busy = false;
    this.#ctx.emit({
      kind: 'turn.completed',
      turnId: this.#turnId,
      reason: 'error',
      error: err.message,
      durationMs: Date.now() - this.#turnStartedAt,
    });
    this.#turnId = null;
    this.#turnSettle?.reject(err);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

/** Codex has used both `type` and `itemType` across versions; accept either. */
export function itemType(item: CodexWire.CodexItem): string {
  return (item.type ?? item.itemType ?? 'unknown').toLowerCase();
}

export function classifyCodexItem(type: string): ToolKind {
  if (type.includes('command') || type.includes('exec') || type.includes('shell')) {
    return 'command';
  }
  if (type.includes('filechange') || type.includes('patch') || type.includes('edit')) {
    return 'file_edit';
  }
  if (type.includes('read')) return 'file_read';
  // `web` is tested before `search`: `websearch` contains both, and the more specific
  // classification is the useful one.
  if (type.includes('web')) return 'web';
  if (type.includes('search') || type.includes('grep')) return 'search';
  if (type.includes('mcp')) return 'mcp';
  if (type.includes('todo') || type.includes('plan')) return 'todo';
  return 'other';
}

export function summarizeCodexItem(item: CodexWire.CodexItem): string {
  if (item.command !== undefined) {
    return Array.isArray(item.command) ? item.command.join(' ') : String(item.command);
  }
  if (Array.isArray(item.changes) && item.changes.length > 0) {
    const paths = item.changes.map((c) => c.path).filter(Boolean);
    return paths.length === 1
      ? `edit ${paths[0]}`
      : `edit ${paths.length} files: ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? '…' : ''}`;
  }
  if (item.name) return item.server ? `${item.server}/${item.name}` : item.name;
  return itemType(item);
}

export function codexItemOutput(item: CodexWire.CodexItem): string {
  if (typeof item.aggregatedOutput === 'string') return item.aggregatedOutput;
  if (typeof item.output === 'string') return item.output;
  if (Array.isArray(item.changes)) {
    return item.changes
      .map((c) => {
        if (!c.diff) return `changed ${c.path}`;

        const kind = c.kind?.toLowerCase();
        const oldPath =
          kind === 'add' ||
          kind === 'added' ||
          kind === 'create' ||
          kind === 'created'
            ? '/dev/null'
            : `a/${c.path}`;
        const newPath =
          kind === 'delete' ||
          kind === 'deleted' ||
          kind === 'remove' ||
          kind === 'removed'
            ? '/dev/null'
            : `b/${c.path}`;

        return `--- ${oldPath}\n+++ ${newPath}\n${c.diff}`;
      })
      .join('\n\n');
  }
  if (item.result !== undefined) {
    return typeof item.result === 'string' ? item.result : JSON.stringify(item.result, null, 2);
  }
  return '';
}

export function extractCodexPlan(params: Record<string, unknown>): PlanItem[] {
  const raw = (params['plan'] ?? params['steps']) as unknown;
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry): PlanItem[] => {
    if (typeof entry === 'string') return [{ text: entry, status: 'pending' }];
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const text =
      typeof record['step'] === 'string'
        ? record['step']
        : typeof record['text'] === 'string'
          ? record['text']
          : null;
    if (text === null) return [];

    const rawStatus = typeof record['status'] === 'string' ? record['status'] : 'pending';
    const status: PlanItemStatus =
      rawStatus === 'completed' || rawStatus === 'done'
        ? 'completed'
        : rawStatus === 'in_progress' || rawStatus === 'active'
          ? 'in_progress'
          : 'pending';
    return [{ text, status }];
  });
}

export function describeCodexApproval(params: CodexWire.CodexApprovalRequestParams): {
  title: string;
  detail: string;
  toolKind: ToolKind;
} {
  if (params.command !== undefined) {
    const command = Array.isArray(params.command) ? params.command.join(' ') : String(params.command);
    return {
      title: 'Run a shell command',
      detail: params.cwd ? `${command}\n\nin ${params.cwd}` : command,
      toolKind: 'command',
    };
  }

  if (Array.isArray(params.changes) && params.changes.length > 0) {
    const detail = params.changes
      .map((c) => (c.diff ? `--- ${c.path}\n${c.diff}` : `changed ${c.path}`))
      .join('\n\n');
    return { title: 'Apply file changes', detail, toolKind: 'file_edit' };
  }

  return {
    title: params.reason ?? 'Approve this action',
    detail: JSON.stringify(params, null, 2),
    toolKind: 'other',
  };
}
