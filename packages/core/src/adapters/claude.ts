import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CLAUDE_PERMISSION_SERVER_NAME,
  CLAUDE_PERMISSION_TOOL_FQN,
  ClaudeWire,
  type PlanItem,
  type ToolKind,
} from '@awos/protocol';
import type { WorkerAdapter, AgentCapabilities, AdapterContext } from './agent.js';
import { spawnCli, type StdioChild } from '../util/spawn.js';
import { readJsonLines, encodeJsonLine } from '../util/jsonl.js';
import { createLogger } from '../util/logger.js';
import type { BridgeDecision, BridgeRequest } from '../permission-bridge.js';

const log = createLogger('adapter:claude');

const here = dirname(fileURLToPath(import.meta.url));
/** Resolved against dist/, since that's what actually runs. */
const PERMISSION_MCP_ENTRY = join(here, '..', 'permission-mcp', 'main.js');

function nextOrdinal(
  ordinals: Map<'text' | 'thinking', number>,
  kind: 'text' | 'thinking',
): number {
  const ordinal = ordinals.get(kind) ?? 0;
  ordinals.set(kind, ordinal + 1);
  return ordinal;
}

function semanticItemId(messageId: string, ordinal: number): string {
  return `${messageId}#${ordinal}`;
}

/**
 * Drives `claude -p` in bidirectional stream-json mode.
 *
 * One process per thread, alive across many turns: the CLI keeps reading stdin and
 * emits a `result` event to close each turn. That is what makes a persistent session
 * possible without the Agent SDK.
 */
/**
 * Exported so the server can report capabilities without spawning an agent — the probe
 * runs before any thread exists.
 */
export const CLAUDE_CAPABILITIES: AgentCapabilities = {
  // Claude reports tool results in one `tool_result` block rather than streaming
  // stdout as it is produced, so the UI shows output on completion, not live.
  streamingToolOutput: false,
  streamingText: true,
  reasoning: true,
  plans: true,
  // No turn-level diff exists in the stream-json protocol. Individual Edit/Write results
  // are prose confirmations, not patches, so reconstructing one would mean guessing.
  turnDiff: false,
  approvals: true,
  resumableSessions: true,
};

export class ClaudeAdapter implements WorkerAdapter {
  readonly id = 'claude-code-cli' as const;

  readonly capabilities: AgentCapabilities = CLAUDE_CAPABILITIES;

  #ctx: AdapterContext;
  #child: StdioChild | null = null;
  #sessionId: string | null = null;
  #model: string | null = null;
  #busy = false;
  #turnId: string | null = null;
  #starting: Promise<void> | null = null;

  /** Resolves the in-flight `sendTurn` when the CLI emits `result`. */
  #turnSettle: { resolve: () => void; reject: (e: Error) => void } | null = null;

  /** Pending approvals keyed by our approvalId. */
  readonly #approvals = new Map<
    string,
    { resolve: (d: BridgeDecision) => void; request: BridgeRequest; timer: NodeJS.Timeout }
  >();

  /** Control requests we sent to the CLI (currently only `interrupt`). */
  readonly #controlWaiters = new Map<string, (ok: boolean) => void>();

  /** Streaming state. Subsequent deltas carry only the raw content-block index. */
  #streamMessageId: string | null = null;
  readonly #blockItemIds = new Map<number, string>();
  readonly #blockOrdinals = new Map<'text' | 'thinking', number>();

  /** tool_use id → display name, so `tool_result` can be labelled on completion. */
  readonly #toolNames = new Map<string, string>();

  constructor(ctx: AdapterContext) {
    this.#ctx = ctx;
  }

  get nativeSessionId(): string | null {
    return this.#sessionId;
  }

  get busy(): boolean {
    return this.#busy;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.#child) return;
    if (this.#starting) return this.#starting;
    this.#starting = this.#doStart();
    try {
      await this.#starting;
    } finally {
      this.#starting = null;
    }
  }

  async #doStart(): Promise<void> {
    const { config, cwd, threadId, permissionMode, resumeSessionId } = this.#ctx;

    // Register before spawning: Claude can request permission on its very first tool.
    this.#ctx.permissionBridge.registerThread(threadId, (req) => this.#onPermission(req));

    const sessionId = resumeSessionId ?? randomUUID();
    this.#sessionId = sessionId;

    const mcpConfig = {
      mcpServers: {
        [CLAUDE_PERMISSION_SERVER_NAME]: {
          command: process.execPath,
          args: [PERMISSION_MCP_ENTRY],
          env: {
            AWOS_BRIDGE_PORT: String(this.#ctx.permissionBridge.port),
            AWOS_BRIDGE_TOKEN: this.#ctx.permissionBridge.token,
            AWOS_THREAD_ID: threadId,
            AWOS_LOG_LEVEL: process.env['AWOS_LOG_LEVEL'] ?? 'info',
          },
        },
      },
    };

    const args = [
      ...config.claudeBinArgs,
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      // Echoes our own input back, which is how we confirm the CLI accepted a turn
      // rather than silently dropping it.
      '--replay-user-messages',
      '--permission-mode',
      permissionMode,
    ];

    // A resumed session id must be passed with --resume; a fresh one with --session-id.
    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    } else {
      args.push('--session-id', sessionId);
    }

    if (config.claudeModel) args.push('--model', config.claudeModel);

    // Approvals are pointless in modes that never prompt, and wiring the MCP server
    // in those modes just adds a process and a startup wait.
    if (permissionMode !== 'bypassPermissions' && permissionMode !== 'dontAsk') {
      args.push('--permission-prompt-tool', CLAUDE_PERMISSION_TOOL_FQN);
      args.push('--mcp-config', JSON.stringify(mcpConfig));
    }

    log.info('spawning', { cwd, sessionId, resumed: Boolean(resumeSessionId) });
    this.#emitStatus('spawning', null);

    const child = spawnCli(config.claudeBin, args, { cwd });
    this.#child = child;

    readJsonLines<ClaudeWire.ClaudeOutputEvent>(child.stdout, {
      onMessage: (msg) => this.#onEvent(msg),
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
          `Could not start Claude Code (${config.claudeBin}): ${err.message}. ` +
          'Check that it is installed and on PATH, or set AWOS_CLAUDE_BIN.',
      });
      this.#failTurn(err);
    });

    child.on('close', (code) => {
      log.info('exited', { code });
      this.#child = null;
      this.#emitStatus('exited', code === null ? null : `exit code ${code}`);
      this.#failTurn(new Error(`Claude Code exited (code ${code ?? 'null'})`));
    });

    this.#emitStatus('ready', null);
  }

  async stop(): Promise<void> {
    this.#ctx.permissionBridge.unregisterThread(this.#ctx.threadId);

    // Anything still waiting on a human gets denied — we're going away.
    for (const [approvalId] of this.#approvals) {
      this.#settleApproval(approvalId, {
        behavior: 'deny',
        message: 'Harness shutting down.',
      });
    }

    const child = this.#child;
    this.#child = null;
    if (!child) return;

    // Closing stdin is the clean exit path for `claude -p`: it finishes the turn,
    // runs SessionEnd hooks, and exits on its own.
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
    const child = this.#child;
    if (!child) throw new Error('Claude Code is not running.');
    if (this.#busy) throw new Error('Claude is already working on a turn.');

    this.#busy = true;
    this.#turnId = randomUUID();
    this.#blockItemIds.clear();
    this.#blockOrdinals.clear();
    this.#streamMessageId = null;

    this.#ctx.emit({
      kind: 'turn.started',
      turnId: this.#turnId,
      nativeSessionId: this.#sessionId,
    });
    this.#emitStatus('busy', null);

    const payload: ClaudeWire.ClaudeUserInput = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
    };

    const startedAt = Date.now();

    return new Promise<void>((resolve, reject) => {
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
      this.#turnStartedAt = startedAt;
      child.stdin.write(encodeJsonLine(payload), (err) => {
        if (err) this.#failTurn(err);
      });
    });
  }

  #turnStartedAt = 0;

  async interrupt(): Promise<void> {
    const child = this.#child;
    if (!child || !this.#busy) return;

    const requestId = randomUUID();
    const control: ClaudeWire.ClaudeControlRequest = {
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'interrupt' },
    };

    const acknowledged = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.#controlWaiters.delete(requestId);
        resolve(false);
      }, this.#ctx.config.interruptGraceMs);

      this.#controlWaiters.set(requestId, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });

      child.stdin.write(encodeJsonLine(control));
    });

    if (acknowledged) return;

    // The control channel is the documented path but is not guaranteed across CLI
    // versions, so we fall back to killing the process. The thread survives: the next
    // turn respawns and resumes the same session id.
    log.warn('interrupt not acknowledged, terminating process');
    child.kill('SIGTERM');
  }

  // -------------------------------------------------------------------------
  // Approvals
  // -------------------------------------------------------------------------

  #onPermission(request: BridgeRequest): Promise<BridgeDecision> {
    const approvalId = randomUUID();
    const { title, detail } = describePermission(request);

    return new Promise<BridgeDecision>((resolve) => {
      const timer = setTimeout(() => {
        log.warn('approval timed out', { approvalId, tool: request.toolName });
        this.#settleApproval(approvalId, {
          behavior: 'deny',
          message: 'No response from the operator; denied by timeout.',
        });
      }, this.#ctx.config.approvalTimeoutMs);

      this.#approvals.set(approvalId, { resolve, request, timer });

      this.#ctx.emit({
        kind: 'approval.requested',
        turnId: this.#turnId,
        approvalId,
        toolName: request.toolName,
        toolKind: classifyClaudeTool(request.toolName),
        title,
        detail,
        input: request.input,
        options: [
          { id: 'allow', label: 'Allow once', behavior: 'allow', persistent: false },
          { id: 'deny', label: 'Deny', behavior: 'deny', persistent: false },
        ],
      });
    });
  }

  resolveApproval(approvalId: string, optionId: string): void {
    const decision: BridgeDecision =
      optionId === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: 'Denied by the operator.' };
    this.#settleApproval(approvalId, decision, false);
  }

  #settleApproval(approvalId: string, decision: BridgeDecision, auto = true): void {
    const pending = this.#approvals.get(approvalId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#approvals.delete(approvalId);
    pending.resolve(decision);

    this.#ctx.emit({
      kind: 'approval.resolved',
      turnId: this.#turnId,
      approvalId,
      optionId: decision.behavior,
      behavior: decision.behavior,
      auto,
    });
  }

  // -------------------------------------------------------------------------
  // Event translation
  // -------------------------------------------------------------------------

  #onEvent(msg: ClaudeWire.ClaudeOutputEvent): void {
    switch (msg.type) {
      case 'system':
        this.#onSystem(msg as ClaudeWire.ClaudeSystemEvent);
        return;
      case 'stream_event':
        this.#onStreamEvent(msg as ClaudeWire.ClaudeStreamEvent);
        return;
      case 'assistant':
        this.#onAssistant(msg as ClaudeWire.ClaudeAssistantEvent);
        return;
      case 'user':
        this.#onUser(msg as ClaudeWire.ClaudeUserEvent);
        return;
      case 'result':
        this.#onResult(msg as ClaudeWire.ClaudeResultEvent);
        return;
      case 'control_response': {
        const res = msg as ClaudeWire.ClaudeControlResponse;
        const waiter = this.#controlWaiters.get(res.response.request_id);
        if (waiter) {
          this.#controlWaiters.delete(res.response.request_id);
          waiter(res.response.subtype === 'success');
        }
        return;
      }
      default:
        // Unknown event types are expected as the CLI evolves; surface, don't crash.
        this.#ctx.emit({ kind: 'raw', turnId: this.#turnId, label: String(msg.type), payload: msg });
    }
  }

  #onSystem(msg: ClaudeWire.ClaudeSystemEvent): void {
    if (msg.subtype === 'init') {
      const init = msg as ClaudeWire.ClaudeSystemInitEvent;
      this.#sessionId = init.session_id;
      this.#model = init.model ?? null;
      this.#ctx.onSessionId(init.session_id);
      this.#emitStatus('busy', null);

      for (const err of init.mcp_server_errors ?? []) {
        this.#ctx.emit({
          kind: 'error',
          severity: 'turn',
          message: `MCP server "${err.name}" did not load: ${err.message}`,
        });
      }
      return;
    }

    if (msg.subtype === 'api_retry') {
      const retry = msg as ClaudeWire.ClaudeSystemApiRetryEvent;
      this.#ctx.emit({
        kind: 'agent.status',
        turnId: this.#turnId,
        status: 'busy',
        model: this.#model,
        detail: `Retrying after ${retry.error} (attempt ${retry.attempt}/${retry.max_retries})`,
      });
      return;
    }

    this.#ctx.emit({
      kind: 'raw',
      turnId: this.#turnId,
      label: `system/${msg.subtype}`,
      payload: msg,
    });
  }

  #onStreamEvent(msg: ClaudeWire.ClaudeStreamEvent): void {
    // Subagent streams would interleave with the main one and garble the transcript.
    if (msg.parent_tool_use_id !== null) return;

    const event = msg.event;

    if (event.type === 'message_start') {
      this.#streamMessageId = event.message?.id ?? randomUUID();
      this.#blockItemIds.clear();
      this.#blockOrdinals.clear();
      return;
    }

    if (event.type === 'content_block_start' && event.index !== undefined) {
      const blockType = event.content_block?.type;
      if (blockType === 'text' || blockType === 'thinking') {
        this.#blockItemIds.set(event.index, this.#nextStreamItemId(blockType));
      }
      return;
    }

    if (event.type === 'content_block_stop' && event.index !== undefined) {
      this.#blockItemIds.delete(event.index);
      return;
    }

    if (event.type !== 'content_block_delta' || event.index === undefined) return;

    const delta = event.delta;
    if (!delta) return;

    const blockType =
      delta.type === 'text_delta' ? 'text' : delta.type === 'thinking_delta' ? 'thinking' : null;
    if (!blockType) return;
    const itemId = this.#blockItemIds.get(event.index) ?? this.#nextStreamItemId(blockType);
    this.#blockItemIds.set(event.index, itemId);

    if (delta.type === 'text_delta' && delta.text) {
      this.#ctx.emit({
        kind: 'message.delta',
        turnId: this.#turnId,
        itemId,
        text: delta.text,
      });
    } else if (delta.type === 'thinking_delta' && delta.thinking) {
      this.#ctx.emit({
        kind: 'reasoning.delta',
        turnId: this.#turnId,
        itemId,
        text: delta.thinking,
      });
    }
    // `input_json_delta` is skipped: partial tool input is not useful to render and
    // the complete input arrives with the `assistant` message moments later.
  }

  #onAssistant(msg: ClaudeWire.ClaudeAssistantEvent): void {
    const fromSubagent = msg.parent_tool_use_id !== null;
    const messageId = msg.message.id ?? this.#streamMessageId ?? randomUUID();
    if (msg.message.model) this.#model = msg.message.model;

    const ordinals = new Map<'text' | 'thinking', number>();
    msg.message.content.forEach((block) => {
      if (block.type === 'text') {
        if (fromSubagent) return;
        const itemId = semanticItemId(messageId, nextOrdinal(ordinals, 'text'));
        const text = (block as ClaudeWire.ClaudeTextBlock).text;
        if (!text) return;
        this.#ctx.emit({
          kind: 'message.completed',
          turnId: this.#turnId,
          itemId,
          text,
        });
        return;
      }

      if (block.type === 'thinking') {
        if (fromSubagent) return;
        const itemId = semanticItemId(messageId, nextOrdinal(ordinals, 'thinking'));
        const thinking = (block as ClaudeWire.ClaudeThinkingBlock).thinking;
        if (!thinking) return;
        this.#ctx.emit({
          kind: 'reasoning.completed',
          turnId: this.#turnId,
          itemId,
          text: thinking,
        });
        return;
      }

      if (block.type === 'tool_use') {
        const tool = block as ClaudeWire.ClaudeToolUseBlock;
        this.#toolNames.set(tool.id, tool.name);

        // TodoWrite is Claude's plan mechanism; surface it as a plan, not a tool call.
        if (tool.name === 'TodoWrite') {
          const items = extractTodos(tool.input);
          if (items.length > 0) {
            this.#ctx.emit({ kind: 'plan.updated', turnId: this.#turnId, items });
            return;
          }
        }

        this.#ctx.emit({
          kind: 'tool.started',
          turnId: this.#turnId,
          itemId: tool.id,
          name: tool.name,
          toolKind: classifyClaudeTool(tool.name),
          title: summarizeClaudeTool(tool.name, tool.input, fromSubagent),
          input: tool.input,
        });
      }
    });
  }

  #onUser(msg: ClaudeWire.ClaudeUserEvent): void {
    const content = msg.message.content;
    // A string body is the `--replay-user-messages` echo of our own input.
    if (typeof content === 'string') return;

    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const result = block as ClaudeWire.ClaudeToolResultBlock;
      const text = flattenToolResult(result.content);

      // A TodoWrite result has no matching tool.started, so it has nothing to close.
      if (this.#toolNames.get(result.tool_use_id) === 'TodoWrite') {
        this.#toolNames.delete(result.tool_use_id);
        continue;
      }

      this.#ctx.emit({
        kind: 'tool.completed',
        turnId: this.#turnId,
        itemId: result.tool_use_id,
        status: result.is_error ? 'error' : 'ok',
        output: text,
        exitCode: null,
      });
      this.#toolNames.delete(result.tool_use_id);
    }
  }

  #onResult(msg: ClaudeWire.ClaudeResultEvent): void {
    this.#sessionId = msg.session_id;
    this.#ctx.onSessionId(msg.session_id);

    const usage = msg.usage;
    if (usage || msg.total_cost_usd !== undefined) {
      this.#ctx.emit({
        kind: 'usage',
        turnId: this.#turnId,
        inputTokens: usage?.input_tokens ?? null,
        outputTokens: usage?.output_tokens ?? null,
        cacheReadTokens: usage?.cache_read_input_tokens ?? null,
        cacheWriteTokens: usage?.cache_creation_input_tokens ?? null,
        costUsd: msg.total_cost_usd ?? null,
      });
    }

    const reason =
      msg.subtype === 'success'
        ? 'completed'
        : msg.subtype === 'error_max_turns'
          ? 'max_turns'
          : 'error';

    this.#ctx.emit({
      kind: 'turn.completed',
      turnId: this.#turnId,
      reason,
      error: msg.is_error ? (msg.result ?? msg.subtype) : null,
      durationMs: msg.duration_ms ?? Date.now() - this.#turnStartedAt,
    });

    this.#busy = false;
    this.#turnId = null;
    this.#emitStatus('idle', null);
    this.#turnSettle?.resolve();
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  #nextStreamItemId(kind: 'text' | 'thinking'): string {
    return semanticItemId(
      this.#streamMessageId ?? 'msg',
      nextOrdinal(this.#blockOrdinals, kind),
    );
  }

  #emitStatus(status: 'spawning' | 'ready' | 'busy' | 'idle' | 'exited' | 'failed', detail: string | null): void {
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

export function classifyClaudeTool(name: string): ToolKind {
  if (name.startsWith('mcp__')) return 'mcp';
  switch (name) {
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
    case 'PowerShell':
      return 'command';
    case 'Read':
    case 'NotebookRead':
      return 'file_read';
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
    case 'MultiEdit':
      return 'file_edit';
    case 'Glob':
    case 'Grep':
      return 'search';
    case 'WebFetch':
    case 'WebSearch':
      return 'web';
    case 'Task':
    case 'Agent':
      return 'task';
    case 'TodoWrite':
      return 'todo';
    default:
      return 'other';
  }
}

/** One-line summary for the collapsed tool row. */
export function summarizeClaudeTool(
  name: string,
  input: Record<string, unknown>,
  fromSubagent = false,
): string {
  const prefix = fromSubagent ? 'subagent · ' : '';
  const str = (key: string): string | null => {
    const value = input[key];
    return typeof value === 'string' ? value : null;
  };

  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return `${prefix}${str('command') ?? name}`;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `${prefix}${name} ${str('file_path') ?? str('notebook_path') ?? ''}`.trim();
    case 'Glob':
    case 'Grep':
      return `${prefix}${name} ${str('pattern') ?? ''}`.trim();
    case 'WebFetch':
      return `${prefix}fetch ${str('url') ?? ''}`.trim();
    case 'WebSearch':
      return `${prefix}search ${str('query') ?? ''}`.trim();
    case 'Task':
      return `${prefix}${str('description') ?? 'subagent task'}`;
    default: {
      const keys = Object.keys(input);
      return keys.length === 0 ? `${prefix}${name}` : `${prefix}${name}(${keys.join(', ')})`;
    }
  }
}

/** Flatten the two shapes a `tool_result` body can take. */
export function flattenToolResult(
  content: string | Array<{ type: string; text?: string }>,
): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Pull a plan out of a TodoWrite call. */
export function extractTodos(input: unknown): PlanItem[] {
  if (typeof input !== 'object' || input === null) return [];
  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return [];

  return todos.flatMap((entry): PlanItem[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const text =
      typeof record['content'] === 'string'
        ? record['content']
        : typeof record['text'] === 'string'
          ? record['text']
          : null;
    if (text === null) return [];
    const raw = typeof record['status'] === 'string' ? record['status'] : 'pending';
    const status =
      raw === 'completed' ? 'completed' : raw === 'in_progress' ? 'in_progress' : 'pending';
    return [{ text, status }];
  });
}

/** Title and body for the approval dialog. */
export function describePermission(request: BridgeRequest): {
  title: string;
  detail: string;
} {
  const input = request.input;
  const str = (key: string): string | null => {
    const value = input[key];
    return typeof value === 'string' ? value : null;
  };

  switch (request.toolName) {
    case 'Bash':
    case 'PowerShell':
      return {
        title: 'Run a shell command',
        detail: str('command') ?? JSON.stringify(input, null, 2),
      };
    case 'Write':
      return {
        title: `Write ${str('file_path') ?? 'a file'}`,
        detail: str('content')?.slice(0, 4000) ?? JSON.stringify(input, null, 2),
      };
    case 'Edit':
    case 'MultiEdit':
      return {
        title: `Edit ${str('file_path') ?? 'a file'}`,
        detail: JSON.stringify(input, null, 2),
      };
    default:
      return {
        title: `Use ${request.toolName}`,
        detail: JSON.stringify(input, null, 2),
      };
  }
}
