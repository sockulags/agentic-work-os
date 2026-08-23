import { randomUUID } from 'node:crypto';
import {
  isSDKAssistantMessage,
  isSDKPartialAssistantMessage,
  isSDKResultMessage,
  isSDKSystemMessage,
  isSDKUserMessage,
  query,
  type CanUseTool,
  type ContentBlock,
  type Query,
  type SDKMessage,
  type ToolInput,
} from '@qwen-code/sdk';
import type { ToolKind, PermissionMode, ModelTarget } from '@awos/protocol';
import type { WorkerAdapter, AgentCapabilities, AdapterContext } from './agent.js';
import { resolveWorkspace } from '../workspace/resolve.js';
import type { HarnessConfig } from '../config.js';

export const QWEN_CORE_TOOLS = [
  'read_file',
  'glob',
  'grep_search',
  'edit',
  'run_shell_command',
] as const;

export const QWEN_CAPABILITIES: AgentCapabilities = {
  streamingToolOutput: false,
  streamingText: true,
  reasoning: true,
  plans: false,
  turnDiff: false,
  approvals: true,
  resumableSessions: true,
};

/** A persisted Qwen session was explicitly proven absent before execution began. */
export class QwenResumeNotFoundError extends Error {
  readonly code = 'qwen_resume_not_found' as const;
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Qwen Code resume session was not found: ${sessionId}`);
    this.name = 'QwenResumeNotFoundError';
    this.sessionId = sessionId;
  }
}

export function isQwenResumeNotFoundError(error: unknown): error is QwenResumeNotFoundError {
  return error instanceof QwenResumeNotFoundError;
}

function isQwenResumeNotFoundMessage(message: string, sessionId: string): boolean {
  const lines = message.split(/\r?\n/).map((line) => line.trim());
  return lines.some((line) =>
    line.includes(`No saved session found with ID ${sessionId}.`) ||
    line.includes(`No session with id "${sessionId}"`),
  );
}

export interface QwenQueryFactoryArgs {
  prompt: string;
  options: NonNullable<Parameters<typeof query>[0]['options']>;
}

export type QwenQueryFactory = (args: QwenQueryFactoryArgs) => Query;

interface PendingApproval {
  resolve: (result: { behavior: 'allow'; updatedInput: ToolInput } | { behavior: 'deny'; message: string }) => void;
  timer: NodeJS.Timeout;
  input: ToolInput;
  signal: AbortSignal;
  onAbort: () => void;
}

let qwenInferenceBusy = false;

/** Testable global inference slot. Qwen's local runtime is intentionally single-slot. */
export function resetQwenInferenceSlotForTests(): void {
  qwenInferenceBusy = false;
}

function acquireQwenInferenceSlot(): (() => void) | null {
  if (qwenInferenceBusy) return null;
  qwenInferenceBusy = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    qwenInferenceBusy = false;
  };
}

function qwenBaseUrl(config: HarnessConfig): string {
  return config.qwenBaseUrl ?? 'http://127.0.0.1:1234/v1';
}

function qwenApiKey(config: HarnessConfig): string {
  return config.qwenApiKey ?? 'local-placeholder';
}

function qwenTimeout(config: HarnessConfig): number {
  return config.qwenTurnTimeoutMs ?? 600_000;
}

function qwenPermissionMode(mode: PermissionMode): 'default' | 'plan' | 'auto-edit' {
  if (mode === 'acceptEdits') return 'auto-edit';
  if (mode === 'plan') return 'plan';
  // dontAsk is retained at the AWOS protocol boundary. Qwen still receives the
  // fail-closed callback so the shell allowlist cannot be bypassed.
  return 'default';
}

function hasShellComposition(command: string): boolean {
  return /[\r\n;&|><`$(){}]/.test(command);
}

const BLOCKED_GIT_FLAGS = new Set([
  '--output', '-o', '--ext-diff', '--textconv', '--config', '-c', '--config-env',
  '--paginate', '-p', '--no-pager', '--exec-path', '--html-path', '--man-path', '--info-path',
]);

const SAFE_GIT_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  status: new Set(['--short', '-s', '--branch', '-b', '--porcelain', '--untracked-files', '--ignored', '--show-stash', '--ahead-behind', '--no-ahead-behind', '--column', '--no-column']),
  diff: new Set(['--stat', '--numstat', '--shortstat', '--name-only', '--name-status', '--check', '--summary', '--patch', '-p', '-u', '--no-patch', '-s', '--cached', '--staged', '--color', '--no-color', '--word-diff', '--relative', '--no-renames', '-U']),
  show: new Set(['--stat', '--numstat', '--shortstat', '--name-only', '--name-status', '--summary', '--patch', '--no-patch', '-s', '--oneline', '--decorate', '--no-decorate', '--color', '--no-color', '--pretty', '--format', '--date', '-U']),
  log: new Set(['--stat', '--numstat', '--shortstat', '--name-only', '--name-status', '--patch', '--no-patch', '--oneline', '--decorate', '--no-decorate', '--all', '--first-parent', '--reverse', '--topo-order', '--date-order', '--no-merges', '--merges', '--follow', '--color', '--no-color', '--pretty', '--format', '--date', '--max-count', '-n', '--since', '--until', '--author', '--grep']),
  'rev-parse': new Set(['--show-toplevel', '--show-prefix', '--show-cdup', '--git-dir', '--absolute-git-dir', '--is-inside-work-tree', '--is-bare-repository', '--verify', '--quiet', '-q', '--short', '--abbrev-ref']),
  'ls-files': new Set(['--cached', '-c', '--deleted', '-d', '--modified', '-m', '--others', '--ignored', '-i', '--stage', '-s', '--unmerged', '-u', '--killed', '-k', '--directory', '--no-empty-directory', '--recurse-submodules', '--error-unmatch', '--full-name']),
};

const SAFE_GIT_FLAG_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  status: ['--porcelain=', '--untracked-files=', '--ignored=', '--column='],
  diff: ['--color=', '--word-diff=', '--unified=', '-U', '--relative=', '--find-renames=', '--find-copies='],
  show: ['--pretty=', '--format=', '--date=', '--color=', '--unified=', '-U', '--decorate='],
  log: ['--pretty=', '--format=', '--date=', '--max-count=', '-n', '--since=', '--until=', '--author=', '--grep=', '--branches=', '--tags=', '--remotes=', '--decorate='],
  'rev-parse': ['--short=', '--abbrev-ref='],
  'ls-files': ['--with-tree='],
};

function tokenizeCommand(command: string): string[] | null {
  if (/["']/.test(command)) return null;
  return command.trim().split(/\s+/).filter(Boolean);
}

function isSafeGitFlag(subcommand: string, token: string): boolean {
  const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
  if (BLOCKED_GIT_FLAGS.has(token) || BLOCKED_GIT_FLAGS.has(name)) return false;
  if (SAFE_GIT_FLAGS[subcommand]?.has(token)) return true;
  return SAFE_GIT_FLAG_PREFIXES[subcommand]?.some((prefix) => token.startsWith(prefix) && token.length > prefix.length) ?? false;
}

function isReadOnlyGitCommand(command: string): boolean {
  const tokens = tokenizeCommand(command);
  if (!tokens || tokens[0] !== 'git' || tokens.length < 2) return false;
  const subcommand = tokens[1] ?? '';
  if (!(subcommand in SAFE_GIT_FLAGS)) return false;
  let pathspec = false;
  for (const token of tokens.slice(2)) {
    if (pathspec) continue;
    if (token === '--') {
      pathspec = true;
      continue;
    }
    if (token.startsWith('-') && !isSafeGitFlag(subcommand, token)) return false;
  }
  return true;
}

export function isAllowedQwenShellCommand(command: string, verifyCommands: readonly string[]): boolean {
  const normalized = command.trim();
  if (normalized === '' || hasShellComposition(normalized)) return false;
  return verifyCommands.includes(normalized) || isReadOnlyGitCommand(normalized);
}

export function classifyQwenTool(toolName: string): ToolKind {
  if (toolName === 'run_shell_command') return 'command';
  if (toolName === 'edit') return 'file_edit';
  if (toolName === 'read_file') return 'file_read';
  if (toolName === 'glob' || toolName === 'grep_search') return 'search';
  return 'other';
}

export function summarizeQwenTool(toolName: string, input: ToolInput): string {
  if (toolName === 'run_shell_command' && typeof input['command'] === 'string') return input['command'];
  const path = input['file_path'] ?? input['path'] ?? input['pattern'];
  return path === undefined ? toolName : `${toolName} ${String(path)}`;
}

export function qwenPermissionPolicy(
  toolName: string,
  input: ToolInput,
  mode: PermissionMode,
  verifyCommands: readonly string[],
): 'allow' | 'ask' | 'deny' {
  if (toolName === 'read_file' || toolName === 'glob' || toolName === 'grep_search') return 'allow';
  if (toolName === 'edit') {
    if (mode === 'bypassPermissions' || mode === 'acceptEdits') return 'allow';
    return mode === 'plan' || mode === 'dontAsk' ? 'deny' : 'ask';
  }
  if (toolName === 'run_shell_command') {
    const command = typeof input['command'] === 'string' ? input['command'] : '';
    if (!isAllowedQwenShellCommand(command, verifyCommands)) return 'deny';
    return mode === 'bypassPermissions' ? 'allow' : mode === 'plan' || mode === 'dontAsk' ? 'deny' : 'ask';
  }
  return 'deny';
}

export class QwenCodeAdapter implements WorkerAdapter {
  readonly id = 'qwen-code-sdk' as const;
  readonly capabilities: AgentCapabilities = QWEN_CAPABILITIES;

  #ctx: AdapterContext;
  #target: ModelTarget;
  #queryFactory: QwenQueryFactory;
  #query: Query | null = null;
  #abortController: AbortController | null = null;
  #sessionId: string | null;
  #model: string | null = null;
  #turnId: string | null = null;
  #turnStartedAt = 0;
  #busy = false;
  #interrupted = false;
  #timedOut = false;
  #terminalEmitted = false;
  #turnError: string | null = null;
  #resumeNotFound: QwenResumeNotFoundError | null = null;
  #sawModelOrToolContent = false;
  #verifyCommands: string[];
  #interruptFallback: NodeJS.Timeout | null = null;
  readonly #partialItemIds = new Map<number, string>();
  readonly #startedToolIds = new Set<string>();
  readonly #approvals = new Map<string, PendingApproval>();

  constructor(ctx: AdapterContext, target: ModelTarget, deps: { query?: QwenQueryFactory } = {}) {
    this.#ctx = ctx;
    this.#target = target;
    this.#sessionId = ctx.resumeSessionId;
    this.#queryFactory = deps.query ?? ((args) => query(args));
    const workspace = resolveWorkspace(ctx.cwd, { laneSetup: ctx.config.laneSetup });
    this.#verifyCommands = workspace.status === 'ok' ? workspace.workspace.verify.map((entry) => entry.command) : [];
  }

  get nativeSessionId(): string | null { return this.#sessionId; }
  get busy(): boolean { return this.#busy; }

  async start(): Promise<void> {
    // The SDK owns the child process and starts it on query(). There is deliberately no
    // qwen serve/daemon lifecycle here; the configured llama.cpp endpoint is external.
  }

  async stop(): Promise<void> {
    for (const [approvalId] of this.#approvals) this.#settleApproval(approvalId, { behavior: 'deny', message: 'Harness shutting down.' }, true);
    const queryInstance = this.#query;
    if (queryInstance) {
      this.#abortController?.abort();
      try { await queryInstance.close(); } catch { /* shutdown is already fail-closed */ }
    }
    this.#query = null;
    this.#abortController = null;
    this.#busy = false;
    this.#clearInterruptFallback();
  }

  async sendTurn(text: string): Promise<void> {
    if (this.#busy) throw new Error('Qwen Code is already working on a turn.');
    const release = acquireQwenInferenceSlot();
    if (!release) throw new Error('Qwen Code is already running another inference; concurrent Qwen turns are not queued.');
    let timeout: NodeJS.Timeout | null = null;
    try {
      this.#busy = true;
      this.#interrupted = false;
      this.#timedOut = false;
      this.#terminalEmitted = false;
      this.#turnError = null;
      this.#resumeNotFound = null;
      this.#sawModelOrToolContent = false;
      this.#turnId = randomUUID();
      this.#turnStartedAt = Date.now();
      this.#abortController = new AbortController();
      this.#partialItemIds.clear();
      this.#startedToolIds.clear();
      const resumedSessionId = this.#sessionId;
      this.#ctx.emit({ kind: 'turn.started', turnId: this.#turnId, nativeSessionId: this.#sessionId });
      this.#emitStatus('spawning', null);

      timeout = setTimeout(() => {
        this.#timedOut = true;
        // A hard turn timeout does not wait for the SDK control channel.
        void this.#query?.interrupt().catch(() => undefined);
        this.#abortController?.abort();
      }, qwenTimeout(this.#ctx.config));

      const queryInstance = this.#queryFactory({
        prompt: text,
        options: {
          cwd: this.#ctx.cwd,
          model: this.#target.model,
          pathToQwenExecutable: this.#ctx.config.qwenBin || undefined,
          env: {
            OPENAI_BASE_URL: this.#target.endpoint ?? qwenBaseUrl(this.#ctx.config),
            OPENAI_MODEL: this.#target.model,
            OPENAI_API_KEY: qwenApiKey(this.#ctx.config),
            // Keep read-only Git commands from launching a configured pager.
            GIT_PAGER: '',
            PAGER: '',
          },
          authType: 'openai',
          permissionMode: qwenPermissionMode(this.#ctx.permissionMode),
          canUseTool: this.#canUseTool,
          abortController: this.#abortController,
          // The SDK routes child stderr through its logger; debug enables that pipe so
          // the explicit pre-execution resume-miss line can be classified below.
          debug: true,
          logLevel: 'debug',
          stderr: (message) => {
            if (
              resumedSessionId !== null &&
              isQwenResumeNotFoundMessage(message, resumedSessionId) &&
              !this.#sawModelOrToolContent
            ) {
              this.#resumeNotFound = new QwenResumeNotFoundError(resumedSessionId);
            }
          },
          maxSessionTurns: -1,
          coreTools: [...QWEN_CORE_TOOLS],
          includePartialMessages: true,
          ...(this.#sessionId === null ? {} : { resume: this.#sessionId }),
          timeout: {
            canUseTool: this.#ctx.config.approvalTimeoutMs,
            controlRequest: Math.max(1, this.#ctx.config.interruptGraceMs),
          },
        },
      });
      this.#query = queryInstance;
      this.#sessionId = queryInstance.getSessionId();
      this.#ctx.onSessionId(this.#sessionId);
      this.#emitStatus('ready', null);

      for await (const message of queryInstance) this.#onMessage(message);

      if (this.#timedOut) {
        const error = `Qwen Code turn exceeded ${qwenTimeout(this.#ctx.config)}ms.`;
        if (!this.#terminalEmitted) {
          this.#ctx.emit({ kind: 'error', severity: 'turn', message: error, turnId: this.#turnId });
          this.#emitCompleted('error', error);
        }
        throw new Error(error);
      }
      const resumeNotFound = this.#recoverableResumeNotFound();
      if (resumeNotFound !== null) throw resumeNotFound;
      if (this.#turnError !== null) throw new Error(this.#turnError);
      if (!this.#terminalEmitted) this.#emitCompleted(this.#interrupted ? 'interrupted' : 'completed', null);
    } catch (error) {
      if (this.#interrupted && !this.#timedOut) {
        if (!this.#terminalEmitted) this.#emitCompleted('interrupted', null);
        return;
      }
      const resumeNotFound = this.#recoverableResumeNotFound();
      if (resumeNotFound !== null) throw resumeNotFound;
      const err = error instanceof Error ? error : new Error(String(error));
      if (!this.#terminalEmitted) {
        this.#ctx.emit({ kind: 'error', severity: 'turn', message: err.message, turnId: this.#turnId });
        this.#emitCompleted('error', err.message);
      }
      throw err;
    } finally {
      if (timeout) clearTimeout(timeout);
      this.#clearInterruptFallback();
      this.#query = null;
      this.#abortController = null;
      this.#busy = false;
      try {
        this.#emitStatus('idle', null);
      } finally {
        this.#turnId = null;
        release();
      }
    }
  }

  async interrupt(): Promise<void> {
    if (!this.#busy) return;
    this.#interrupted = true;
    const queryInstance = this.#query;
    if (!queryInstance) {
      this.#abortController?.abort();
      return;
    }
    void queryInstance.interrupt().catch(() => undefined);
    this.#clearInterruptFallback();
    this.#interruptFallback = setTimeout(() => {
      this.#interruptFallback = null;
      if (this.#busy && this.#query === queryInstance) this.#abortController?.abort();
    }, this.#ctx.config.interruptGraceMs);
  }

  resolveApproval(approvalId: string, optionId: string): void {
    const pending = this.#approvals.get(approvalId);
    if (!pending) return;
    if (optionId === 'allow') this.#settleApproval(approvalId, { behavior: 'allow', updatedInput: pending.input }, false);
    else this.#settleApproval(approvalId, { behavior: 'deny', message: 'Denied by the operator.' }, false);
  }

  #canUseTool: CanUseTool = async (toolName, input, { signal }) => {
    const policy = qwenPermissionPolicy(toolName, input, this.#ctx.permissionMode, this.#verifyCommands);
    if (policy === 'allow') return { behavior: 'allow', updatedInput: input };
    if (policy === 'deny') return { behavior: 'deny', message: 'Tool denied by the Agentic Work OS policy.' };
    if (signal.aborted || this.#interrupted || this.#timedOut) {
      return { behavior: 'deny', message: 'Tool denied because the turn is stopping.', interrupt: true };
    }

    const approvalId = randomUUID();
    return new Promise((resolve) => {
      const onAbort = (): void => {
        this.#settleApproval(approvalId, { behavior: 'deny', message: 'Turn interrupted; approval denied.' }, true);
      };
      const timer = setTimeout(() => {
        this.#settleApproval(approvalId, { behavior: 'deny', message: 'No response from the operator; denied by timeout.' }, true);
      }, this.#ctx.config.approvalTimeoutMs);
      this.#approvals.set(approvalId, { resolve, timer, input, signal, onAbort });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }

      this.#ctx.emit({
        kind: 'approval.requested',
        turnId: this.#turnId,
        approvalId,
        toolName,
        toolKind: classifyQwenTool(toolName),
        title: summarizeQwenTool(toolName, input),
        detail: JSON.stringify(input, null, 2),
        input,
        options: [
          { id: 'allow', label: 'Allow once', behavior: 'allow', persistent: false },
          { id: 'deny', label: 'Deny', behavior: 'deny', persistent: false },
        ],
      });
    });
  };

  #settleApproval(
    approvalId: string,
    decision: { behavior: 'allow'; updatedInput: ToolInput } | { behavior: 'deny'; message: string },
    auto: boolean,
  ): void {
    const pending = this.#approvals.get(approvalId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.signal.removeEventListener('abort', pending.onAbort);
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

  #onMessage(message: SDKMessage): void {
    if (isSDKSystemMessage(message)) {
      this.#sessionId = message.session_id;
      this.#ctx.onSessionId(message.session_id);
      this.#model = message.model ?? this.#model;
      this.#emitStatus(message.subtype === 'init' ? 'ready' : 'busy', message.subtype);
      return;
    }
    if (isSDKPartialAssistantMessage(message)) {
      this.#sawModelOrToolContent = true;
      this.#sessionId = message.session_id;
      this.#ctx.onSessionId(message.session_id);
      this.#onPartial(message.uuid, message.event);
      return;
    }
    if (isSDKAssistantMessage(message)) {
      this.#sawModelOrToolContent = true;
      this.#sessionId = message.session_id;
      this.#ctx.onSessionId(message.session_id);
      this.#model = message.message.model;
      for (const [index, block] of message.message.content.entries()) this.#onBlock(block, message.message.id, index);
      this.#partialItemIds.clear();
      return;
    }
    if (isSDKUserMessage(message)) {
      this.#sawModelOrToolContent = true;
      this.#sessionId = message.session_id;
      this.#ctx.onSessionId(message.session_id);
      const blocks = Array.isArray(message.message.content) ? message.message.content : [];
      for (const [index, block] of blocks.entries()) this.#onBlock(block, message.uuid ?? `user-${randomUUID()}`, index);
      return;
    }
    if (isSDKResultMessage(message)) {
      if (this.#recoverableResumeNotFound() !== null) return;
      this.#sessionId = message.session_id;
      this.#ctx.onSessionId(message.session_id);
      this.#model = this.#model ?? this.#target.model;
      if (message.usage) {
        this.#ctx.emit({
          kind: 'usage',
          turnId: this.#turnId,
          inputTokens: message.usage.input_tokens ?? null,
          outputTokens: message.usage.output_tokens ?? null,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? null,
          cacheWriteTokens: message.usage.cache_creation_input_tokens ?? null,
          costUsd: null,
        });
      }
      if (message.is_error) {
        const detail = message.error?.message ?? `Qwen Code returned ${message.subtype}.`;
        if (!this.#interrupted) {
          this.#turnError = message.subtype === 'error_max_turns' ? null : detail;
          this.#ctx.emit({ kind: 'error', severity: 'turn', message: detail, turnId: this.#turnId });
          this.#emitCompleted(message.subtype === 'error_max_turns' ? 'max_turns' : 'error', detail);
        }
        return;
      }
      if (!this.#interrupted && !this.#timedOut) this.#emitCompleted('completed', null);
    }
  }

  #onPartial(_uuid: string, event: { type: string; index?: number; content_block?: ContentBlock; delta?: { type: string; text?: string; thinking?: string } }): void {
    if (event.type === 'message_start') {
      this.#partialItemIds.clear();
      return;
    }
    const index = event.index ?? 0;
    const block = event.content_block;
    if (event.type === 'content_block_start') {
      const itemId = block?.type === 'tool_use' ? block.id : `qwen:${this.#turnId ?? 'turn'}:${index}`;
      this.#partialItemIds.set(index, itemId);
      if (block?.type === 'tool_use' && !this.#startedToolIds.has(block.id)) {
        this.#startedToolIds.add(block.id);
        this.#ctx.emit({ kind: 'tool.started', turnId: this.#turnId, itemId: block.id, name: block.name, toolKind: classifyQwenTool(block.name), title: summarizeQwenTool(block.name, (block.input ?? {}) as ToolInput), input: block.input });
      }
      return;
    }
    const itemId = this.#partialItemIds.get(index) ?? `qwen:${this.#turnId ?? 'turn'}:${index}`;
    this.#partialItemIds.set(index, itemId);
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
      this.#ctx.emit({ kind: 'message.delta', turnId: this.#turnId, itemId, text: event.delta.text });
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta' && event.delta.thinking) {
      this.#ctx.emit({ kind: 'reasoning.delta', turnId: this.#turnId, itemId, text: event.delta.thinking });
    }
  }

  #onBlock(block: ContentBlock, fallbackId: string, index: number): void {
    const itemId = this.#partialItemIds.get(index) ?? `${fallbackId}:${index}`;
    switch (block.type) {
      case 'text':
        if (block.text) this.#ctx.emit({ kind: 'message.completed', turnId: this.#turnId, itemId, text: block.text });
        return;
      case 'thinking':
        if (block.thinking) this.#ctx.emit({ kind: 'reasoning.completed', turnId: this.#turnId, itemId, text: block.thinking });
        return;
      case 'tool_use':
        this.#startedToolIds.add(block.id);
        // A streamed tool may start with `{}` and carry its real input only in the
        // final assistant block. Repeating the normalized event lets the transcript
        // reducer upsert the same row without losing the complete input/title.
        this.#ctx.emit({ kind: 'tool.started', turnId: this.#turnId, itemId: block.id, name: block.name, toolKind: classifyQwenTool(block.name), title: summarizeQwenTool(block.name, (block.input ?? {}) as ToolInput), input: block.input ?? {} });
        return;
      case 'tool_result': {
        const output = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        this.#ctx.emit({ kind: 'tool.completed', turnId: this.#turnId, itemId: block.tool_use_id, status: block.is_error ? 'error' : 'ok', output, exitCode: null });
      }
    }
  }

  #emitStatus(status: 'spawning' | 'ready' | 'busy' | 'idle', detail: string | null): void {
    this.#ctx.emit({ kind: 'agent.status', turnId: this.#turnId, status, model: this.#model, detail });
  }

  #emitCompleted(reason: 'completed' | 'interrupted' | 'error' | 'max_turns', error: string | null): void {
    if (this.#terminalEmitted) return;
    this.#terminalEmitted = true;
    this.#ctx.emit({ kind: 'turn.completed', turnId: this.#turnId, reason, error, durationMs: Date.now() - this.#turnStartedAt });
  }

  #recoverableResumeNotFound(): QwenResumeNotFoundError | null {
    return this.#resumeNotFound !== null && !this.#sawModelOrToolContent && !this.#timedOut
      ? this.#resumeNotFound
      : null;
  }

  #clearInterruptFallback(): void {
    if (!this.#interruptFallback) return;
    clearTimeout(this.#interruptFallback);
    this.#interruptFallback = null;
  }
}

export async function probeQwenEndpoint(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<{ available: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/models`, { signal: controller.signal });
    if (!response.ok) return { available: false, detail: `Qwen endpoint returned HTTP ${response.status}.` };
    return { available: true, detail: `${baseUrl} is reachable.` };
  } catch (error) {
    return { available: false, detail: error instanceof Error ? error.message : 'Qwen endpoint is not reachable.' };
  } finally {
    clearTimeout(timer);
  }
}
