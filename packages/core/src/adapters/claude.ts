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
import type { WorkerAdapter, AgentCapabilities, AdapterContext, WorkerTurnOptions } from './agent.js';
import { spawnCli, type StdioChild } from '../util/spawn.js';
import { readJsonLines, encodeJsonLine } from '../util/jsonl.js';
import { createLogger } from '../util/logger.js';
import { CLAUDE_TURN_TIMEOUT_DEFAULT_MS } from '../config.js';
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
 * One input written to stdin whose turn the CLI has not finished on this stream.
 *
 * The stream carries no turn id, so the only thing that separates one turn from the next
 * is where its input sits in the order they were written. Keeping the inputs themselves
 * is what lets an event be placed: the CLI replays each line back as it takes it up, and
 * that echo names the boundary the events after it fall behind.
 */
type PendingInput = {
  /** The turn this input opened. Kept so a dropped event can name what it belonged to. */
  readonly turnId: string;
  /** The exact text written, which is what the CLI's replay of it is matched against. */
  readonly text: string;
  /** Set when the CLI replayed this input, so a second turn sending the same text
   * is matched against its own entry rather than this one. */
  started: boolean;
  /** Set when the watchdog gave up on the turn, so nothing it says is ours to report. */
  abandoned: boolean;
};

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

  /** Deadline on the turn in flight, armed with the input and cleared when it settles. */
  #turnTimer: NodeJS.Timeout | null = null;

  /**
   * Inputs written to stdin whose turn the CLI has not finished, oldest first.
   *
   * Entry zero is the turn the stream is currently talking about; the rest are lines the
   * CLI has not taken up yet. Only the last entry can be a live turn, because `#busy`
   * refuses a second one — everything ahead of it is a turn the watchdog abandoned, and
   * every event of those is dropped rather than stamped with the turn in flight.
   *
   * Two things move entry zero on, and each moves it exactly one turn:
   *
   * - the `result` that closes it, which is unambiguous;
   * - the CLI replaying a *later* input, which says it has taken that later line up.
   *
   * The second is what keeps a release that renames or drops `result` from muting the
   * worker for good. It is also where this adapter's one assumption about the CLI lives;
   * #passTo states it and says what it costs.
   */
  readonly #inputs: PendingInput[] = [];

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
      // Whatever it still owed died with it, so nothing is left to disown.
      this.#inputs.length = 0;
      this.#emitStatus('exited', code === null ? null : `exit code ${code}`);
      this.#failTurn(new Error(`Claude Code exited (code ${code ?? 'null'})`));
    });

    this.#emitStatus('ready', null);
  }

  async stop(): Promise<void> {
    this.#clearTurnTimer();
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

  async sendTurn(text: string, _options?: WorkerTurnOptions): Promise<void> {
    await this.start();
    const child = this.#child;
    if (!child) throw new Error('Claude Code is not running.');
    if (this.#busy) throw new Error('Claude is already working on a turn.');

    this.#busy = true;
    const turnId = randomUUID();
    this.#turnId = turnId;
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
      // The boundary is recorded with the write, not with the CLI's replay of it: a line
      // it has not read yet is still a turn whose events have to be told from the next.
      this.#inputs.push({
        turnId,
        text,
        started: false,
        abandoned: false,
      });
      // Armed with the write rather than on any acknowledgement: the CLI sends nothing to
      // confirm it took the turn, so the whole wait — including a CLI that never reads the
      // line — is what has to be bounded.
      const deadline = this.#ctx.config.claudeTurnTimeoutMs ?? CLAUDE_TURN_TIMEOUT_DEFAULT_MS;
      this.#turnTimer = setTimeout(() => this.#timeOutTurn(deadline), deadline);
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
    // Approvals arrive over the bridge rather than on the stream, so the gate in #onEvent
    // never sees them. While an abandoned turn is still the one the CLI is working on, its
    // tool call must not be shown as the current turn's, or the operator answers for work
    // they are not looking at. Denying still answers the bridge, which is what keeps that
    // call from blocking forever.
    if (this.#currentInputAbandoned()) {
      log.warn('approval from an abandoned turn denied', { tool: request.toolName });
      return Promise.resolve({
        behavior: 'deny',
        message: 'The turn that asked for this timed out.',
      });
    }

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

  /** Is the CLI, as far as this stream shows, working on a turn we gave up on? */
  #currentInputAbandoned(): boolean {
    return this.#inputs[0]?.abandoned === true;
  }

  /**
   * Place an event against the input queue and say whether it is ours to report.
   *
   * A turn the watchdog abandoned goes on running, and the CLI keeps reporting on it.
   * Those events belong to a turn that is over here, so they are dropped rather than
   * attributed to whatever turn is in flight now.
   */
  #ownsEvent(msg: ClaudeWire.ClaudeOutputEvent): boolean {
    const replayed = replayedInputText(msg);
    if (replayed !== null) this.#passTo(replayed);

    const current = this.#inputs[0];
    // Nothing outstanding — a stray event with no turn to place it against. The handlers
    // below already refuse to close a turn that does not exist.
    if (current === undefined) return true;

    if (msg.type === 'result') {
      // One `result` per input, so this closes the turn at the front of the queue —
      // whether or not that is the turn in flight, and never the one after it.
      this.#inputs.shift();
      if (!current.abandoned) return true;
      log.debug('result from an abandoned turn ignored', { turnId: current.turnId });
      return false;
    }

    if (!current.abandoned) return true;
    log.debug('event from an abandoned turn ignored', {
      type: msg.type,
      turnId: current.turnId,
    });
    return false;
  }

  /**
   * The CLI replayed an input back at us. Move the front of the queue to that input.
   *
   * Each input is passed on its own: the replay of input three says the CLI has taken up
   * input three, which retires input two and nothing else. An abandoned turn stays
   * disowned until its own input is behind us, so two turns that both timed out are two
   * separate stretches of stream to drop rather than one.
   *
   * The text is what makes this an answer rather than a guess, and it is the only guard:
   * a replay that matches none of the inputs we sent moves nothing. Matching also means a
   * turn's own replay never retires that turn, since its entry is not strictly before
   * itself — which is what keeps a CLI that was wedged before it ever read the line from
   * having its late replay open the gate on the very turn the deadline disowned.
   *
   * The assumption left is that the CLI replays a line when it takes the turn up, not when
   * it buffers the line. Nothing in the repo pins that down. If it read ahead, the replay
   * of a later input would arrive while an earlier turn was still talking, and that turn's
   * tail — its `result` included — would be taken for the next turn's. That is not
   * defended against here, because the defence tried first (refusing to move on from a
   * turn that had said nothing) assumed a turn the CLI ran always says something, and a
   * turn can be taken up, say nothing and be over. Refusing on that basis failed the
   * healthy turn after it, which is the wedge #88 exists to remove; read-ahead is
   * unestablished and, once the abandoned turn has streamed, indistinguishable on this
   * stream from a `result` the CLI simply dropped.
   */
  #passTo(text: string): void {
    const index = this.#inputs.findIndex((input) => !input.started && input.text === text);
    if (index === -1) {
      log.warn('replayed input matches no turn we sent; leaving the boundary where it is');
      return;
    }

    this.#inputs.splice(0, index);
    const current = this.#inputs[0];
    if (current !== undefined) current.started = true;
  }

  #onEvent(msg: ClaudeWire.ClaudeOutputEvent): void {
    // Control responses are correlated by request id rather than by turn, so they are
    // never anyone else's; everything else has to be placed against the input queue.
    if (msg.type !== 'control_response' && !this.#ownsEvent(msg)) return;

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
    // A `result` outside a turn has nothing to close. Emitting anyway would fabricate a
    // completion carrying no turn id and bank its tokens on nobody.
    if (!this.#busy) {
      log.warn('result outside a turn ignored', { subtype: msg.subtype });
      return;
    }

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

    this.#clearTurnTimer();
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

  /**
   * The turn outlived its deadline, so nothing on this stream is going to end it.
   *
   * Approvals are settled first: the CLI's tool call is blocked on one, and an approval
   * left pending would sit until its own timer fires against a turn that no longer exists.
   * The CLI is not interrupted — that path ends in SIGTERM when the control request goes
   * unanswered, and the point of giving up locally is to leave a live worker behind.
   */
  #timeOutTurn(deadline: number): void {
    if (!this.#busy) return;
    const message = `Claude did not complete the turn within ${deadline}ms.`;
    log.warn('turn timed out', { turnId: this.#turnId, deadline });

    // The CLI still has this turn's input, and everything it says about it up to that
    // input's own boundary has to be dropped. Mark it before anything clears the id.
    this.#abandon(this.#turnId);

    this.#ctx.emit({ kind: 'error', severity: 'turn', turnId: this.#turnId, message });
    for (const [approvalId] of this.#approvals) {
      this.#settleApproval(approvalId, {
        behavior: 'deny',
        message: 'The turn timed out.',
      });
    }
    this.#failTurn(new Error(message));
    // The process is still alive and can take another turn; say so, or the UI goes on
    // showing a worker that is busy with nothing.
    this.#emitStatus('idle', null);
  }

  #clearTurnTimer(): void {
    if (this.#turnTimer === null) return;
    clearTimeout(this.#turnTimer);
    this.#turnTimer = null;
  }

  /** The turn is over here but its input is still the CLI's, so disown what it says. */
  #abandon(turnId: string | null): void {
    const input = this.#inputs.find((candidate) => candidate.turnId === turnId);
    if (input) input.abandoned = true;
  }

  #failTurn(err: Error): void {
    this.#clearTurnTimer();
    if (!this.#busy) return;
    // The CLI was never told the turn ended, so anything it still owes on that input is
    // no more ours than a timed-out turn's would be.
    this.#abandon(this.#turnId);
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

/**
 * The input text the CLI is replaying back at us, or null if this is not a replay.
 *
 * `--replay-user-messages` echoes each line we write as a `user` event, which is the only
 * mark on this stream that says which input the CLI has taken up. The text is what makes
 * it an answer rather than a guess: a `user` event that carries none of the inputs we
 * sent is some other message the CLI chose to put on the stream, and it must not be read
 * as the CLI moving on.
 *
 * Only the main stream counts: a subagent's user message names the tool call it belongs
 * to, and that call is inside the turn being placed rather than evidence of the next one.
 * The other main-stream user message is a tool result, which carries a `tool_result`
 * block. The string body is the shape the CLI uses today; the array form is the shape we
 * write, and both are read here so a replay is recognised either way.
 */
function replayedInputText(msg: ClaudeWire.ClaudeOutputEvent): string | null {
  if (msg.type !== 'user') return null;
  const event = msg as ClaudeWire.ClaudeUserEvent;
  if (event.parent_tool_use_id != null) return null;
  const content = event.message?.content;
  if (typeof content === 'string') return content.length > 0 ? content : null;
  if (!Array.isArray(content) || content.length === 0) return null;
  if (content.some((block) => block.type === 'tool_result')) return null;
  const text = content
    .filter((block): block is ClaudeWire.ClaudeTextBlock => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
  return text.length > 0 ? text : null;
}

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
