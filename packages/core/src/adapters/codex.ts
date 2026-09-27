import { randomUUID } from 'node:crypto';
import {
  CODEX_METHODS,
  CODEX_NOTIFICATIONS,
  CodexWire,
  type PlanItem,
  type PlanItemStatus,
  type ToolKind,
} from '@awos/protocol';
import { NativeResumeNotFoundError } from './agent.js';
import type {
  WorkerAdapter,
  AgentCapabilities,
  AdapterContext,
  ArmDeadline,
  WorkerTurnOptions,
} from './agent.js';
import { CODEX_TURN_TIMEOUT_DEFAULT_MS } from '../config.js';
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

/** The deadline every caller but a test gets: the clock, through `setTimeout`. */
const armWithTimeout: ArmDeadline = (fire, ms) => {
  const timer = setTimeout(fire, ms);
  return () => clearTimeout(timer);
};

/**
 * How long a failed start waits for SIGTERM to be honoured before it stops being polite.
 *
 * An app-server that is still healthy enough to have answered `initialize` exits within
 * milliseconds of its stdin closing, so this is slack for a process caught mid-write, not
 * a normal cost. It is deliberately far below `interruptGraceMs`: a failed start is on the
 * orchestrator's retry path, where the whole teardown has to stay invisible.
 */
const ABANDON_TERM_GRACE_MS = 500;

/**
 * How long the same wait continues after SIGKILL before it gives up regardless.
 *
 * SIGKILL is not refusable, so this only covers the kernel reaping the process — and on
 * Windows, where the signal reaches the shell wrapper rather than the server itself, it
 * bounds a wait that could otherwise not end. A failed start must reject in bounded time
 * even when the process it spawned cannot be shown to be gone.
 */
const ABANDON_KILL_GRACE_MS = 250;

export class CodexAdapter implements WorkerAdapter {
  readonly id = 'codex-app-server' as const;

  readonly capabilities: AgentCapabilities = CODEX_CAPABILITIES;

  #ctx: AdapterContext;
  #child: StdioChild | null = null;
  #threadId: string | null = null;
  /** Our id for the turn in flight, stable for its whole life; what every event carries. */
  #turnId: string | null = null;
  /** Codex's own id for that turn, which is what the wire talks about. */
  #serverTurnId: string | null = null;
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

  /**
   * Cancels the deadline armed for the whole turn — the only thing that bounds the wait
   * for `turn/completed`. Null while no turn is being watched.
   */
  #cancelTurnDeadline: (() => void) | null = null;

  /**
   * Server turn ids the watchdog gave up on and has not seen end.
   *
   * The adapter goes on to accept another turn, so `busy` alone cannot tell a late
   * completion from the live one — and a stale completion that settled the wrong turn
   * would report work as finished that has barely started. An id leaves this set when its
   * own `turn/completed` arrives, which is the only thing that proves the server stopped
   * running it.
   */
  readonly #abandonedTurns = new Set<string>();

  /**
   * Set when the watchdog gave up on a turn Codex never named.
   *
   * Nothing that turn goes on to emit can be recognized, so it is never retired: from here
   * on the adapter only attributes a notification to the turn in flight when the wire says
   * so outright.
   */
  #abandonedUnnamedTurn = false;

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
    const { config, cwd } = this.#ctx;

    log.info('spawning', { cwd });
    this.#emitStatus('spawning', null);

    const child = spawnCli(config.codexBin, [...config.codexBinArgs, 'app-server'], { cwd });
    this.#child = child;

    child.stderr.setEncoding('utf8');
    const onStderr = (chunk: string): void => {
      const text = chunk.trim();
      if (text) log.warn('stderr', { text: text.slice(0, 500) });
    };
    child.stderr.on('data', onStderr);

    const onSpawnError = (err: Error): void => {
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
    };
    child.on('error', onSpawnError);

    const onClose = (code: number | null): void => {
      log.info('exited', { code });
      this.#child = null;
      this.#threadId = null;
      this.#emitStatus('exited', code === null ? null : `exit code ${code}`);
      // Nothing survives the process, so no abandoned turn can still be emitting.
      this.#abandonedTurns.clear();
      this.#abandonedUnnamedTurn = false;
      const err = new Error(`Codex app-server exited (code ${code ?? 'null'})`);
      this.#rejectAllPending(err);
      this.#failTurn(err);
    };
    child.on('close', onClose);

    /**
     * The stdout pipe failed, which is not the same thing as the process exiting.
     *
     * A `ChildProcess` `error` and its stdout's `error` are different events, and only the
     * first one was ever heard — the second was thrown by Node as an uncaught exception and
     * took the daemon with it. What is left after it is a server that may well still be
     * running and can no longer be heard from: every request in `#pending` is waiting for a
     * response line and the turn is waiting for `turn/completed`, and neither can arrive.
     *
     * So this gives up on that child entirely, as `abandon` below does, and for the same
     * reason it is scoped to *this* child: a start that replaces it must not have its
     * references cleared, its requests rejected, or its turn failed by the process it
     * replaced.
     */
    const onStdoutError = (err: Error): void => {
      log.error('stdout failed', { message: err.message });
      const failure = new Error(`Codex app-server stdout failed: ${err.message}`);

      child.off('error', onSpawnError);
      child.off('close', onClose);
      // Nobody reads either pipe now, and an unread pipe never reaches EOF. Drain both, and
      // hear what a process on its way out can still raise: an unheard 'error' is the same
      // uncaught exception this path exists to stop.
      child.stdout.resume();
      child.stderr.resume();
      child.on('error', (e) => log.debug('failed child error', { message: e.message }));
      child.stdin.on('error', (e) => log.debug('failed child stdin error', { message: e.message }));

      if (this.#child === child) {
        this.#child = null;
        this.#threadId = null;
        this.#abandonedTurns.clear();
        this.#abandonedUnnamedTurn = false;
        this.#emitStatus('failed', err.message);
        this.#ctx.emit({
          kind: 'error',
          severity: 'fatal',
          message: `Lost the connection to Codex: ${err.message}. The next turn starts a new app-server.`,
        });
        // Nothing is left to carry a decision back to the server blocking on one.
        for (const [approvalId] of this.#approvals) {
          this.#settleApproval(approvalId, 'denied', true);
        }
        this.#rejectAllPending(failure);
        this.#failTurn(failure);
      }

      // Closing stdin is what a healthy app-server exits on; the signal is for one that
      // does not. Leaving it running would put a second server in the thread's directory
      // the moment the next turn spawns one.
      child.stdin.end();
      child.kill('SIGTERM');
    };

    const detachStdout = readJsonLines<CodexWire.JsonRpcMessage>(child.stdout, {
      onMessage: (msg) => this.#onMessage(msg),
      onUnparseable: (line) => log.debug('non-json stdout', { line: line.slice(0, 200) }),
      onError: onStdoutError,
    });

    /**
     * Give up on this attempt's process, completely.
     *
     * A handshake step can fail at any point after the spawn — `thread/resume` does it
     * deliberately, on every stale session id — and the process is already running by
     * then. Left alone it would keep running with this adapter's reader still attached,
     * so a server nobody is talking to could still name a thread, and its eventual exit
     * could still fail a turn belonging to the process that replaced it.
     *
     * Everything here is scoped to *this* child: a start that failed and a start that
     * replaced it are two different processes, and only the failed one may be torn down.
     *
     * This resolves only once that process is actually gone, or the wait for it has run
     * out. Returning any earlier would let the caller's retry spawn a second app-server
     * while the first is still running, which is the overlap the teardown exists to
     * prevent.
     */
    const abandon = async (cause: Error): Promise<void> => {
      detachStdout();
      child.stderr.off('data', onStderr);
      child.off('error', onSpawnError);
      child.off('close', onClose);
      // Nobody reads either pipe now, and an unread pipe never reaches EOF — so its
      // stream never closes, and neither does the child. Drain both into nothing.
      child.stdout.resume();
      child.stderr.resume();
      // Ending and killing can still raise on a process on its way out, and an unheard
      // 'error' on a child would take the harness down rather than this attempt.
      child.on('error', (err) => log.debug('abandoned child error', { message: err.message }));
      child.stdin.on('error', (err) => log.debug('abandoned stdin error', { message: err.message }));
      // Detaching the reader took its stdout error listener with it, and a drained pipe on
      // a dying process is exactly where one arrives.
      child.stdout.on('error', (err) => log.debug('abandoned stdout error', { message: err.message }));

      // Only if it is still ours. A concurrent start owns the reference by then, and
      // clearing it would strand a healthy process exactly as this attempt stranded one.
      if (this.#child === child) {
        this.#child = null;
        this.#threadId = null;
      }

      // Nothing is left to answer them: the reader that would have carried a response is
      // detached, and the close that would have rejected them is no longer heard. Done
      // before the wait below, which has no answer for them either.
      this.#rejectAllPending(cause);

      // Closing stdin is what a healthy app-server exits on; the signal is for one that
      // does not.
      child.stdin.end();
      child.kill('SIGTERM');

      // `end()` and `kill()` only ask. What the caller is owed is the process being gone,
      // so wait for its exit — escalating once, and giving up either way on a short clock.
      await new Promise<void>((resolve) => {
        // Already reaped, in which case 'close' has fired or never will.
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }

        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(termTimer);
          clearTimeout(killTimer);
          child.off('close', onExit);
          resolve();
        };
        const onExit = (): void => finish();
        child.on('close', onExit);

        const termTimer = setTimeout(() => child.kill('SIGKILL'), ABANDON_TERM_GRACE_MS);
        const killTimer = setTimeout(() => {
          log.warn('abandoned child outlived its teardown', { pid: child.pid ?? null });
          finish();
        }, ABANDON_TERM_GRACE_MS + ABANDON_KILL_GRACE_MS);
      });
    };

    try {
      await this.#handshake();
    } catch (err) {
      await abandon(err as Error);
      throw err;
    }
  }

  /**
   * Turn a spawned process into a thread we can send turns to.
   *
   * Kept apart from the spawn because this is the part that fails: every throw below
   * lands in the caller's abandon path, which owns undoing the spawn.
   */
  async #handshake(): Promise<void> {
    const { config, cwd, resumeSessionId } = this.#ctx;

    // The server rejects everything until initialize/initialized complete.
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
        // A fresh native thread is not trustworthy against the old watermark. Clear
        // both identities so the orchestrator's next payload is rebuilt from canonical
        // replay rather than silently omitting prior context.
        this.#ctx.onSessionLost?.();
        this.#threadId = null;
        throw new NativeResumeNotFoundError(resumeSessionId);
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

  async sendTurn(text: string, _options?: WorkerTurnOptions): Promise<void> {
    await this.start();
    if (!this.#child || !this.#threadId) throw new Error('Codex is not running.');
    if (this.#busy) throw new Error('Codex is already working on a turn.');

    this.#busy = true;
    this.#turnStartedAt = Date.now();
    this.#turnId = randomUUID();
    this.#serverTurnId = null;
    const turnId = this.#turnId;

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

    // `settled` is only returned at the bottom of this method, and everything between
    // here and there can fail the turn — a refused or unanswered `turn/start` most of all.
    // A rejection nobody holds yet is an unhandled rejection, whose default action takes
    // the daemon down along with every other thread on it. Held from here on; the caller
    // still sees the failure, through the throw below or through the promise returned.
    void settled.catch(() => {});

    try {
      await this.#request(
        CODEX_METHODS.turnStart,
        {
          threadId: this.#threadId,
          input: [{ type: 'text', text }],
        } satisfies CodexWire.CodexTurnStartParams,
        // The acceptance already names the turn. Waiting for `turn/started` instead would
        // leave a turn that hangs before it — the case the watchdog exists for — nameless,
        // and a nameless turn cannot be told apart from the one that follows it.
        //
        // Read here rather than after the await, because Codex can put the acceptance and
        // the turn's first notifications in one read and every line of a read is handled
        // before an awaiting continuation gets to run. A turn still unnamed while its own
        // notifications are judged is a turn whose completion is taken for another's and
        // thrown away, and then nothing ends it.
        (result) => {
          const id = (result as CodexWire.CodexTurnStartResult | undefined)?.turn?.id;
          if (typeof id === 'string' && this.#busy && this.#turnId === turnId) {
            this.#serverTurnId = id;
          }
        },
      );
    } catch (err) {
      this.#failTurn(err as Error);
      throw err;
    }

    // Armed here rather than before the request: until the turn is accepted the wait is
    // already bounded by the request's own timeout. A turn that finished inside that
    // window needs no watchdog — and must not have this turn's bookkeeping written over
    // whatever started after it, hence the check that we are still the turn in flight.
    if (this.#busy && this.#turnId === turnId) {
      const deadline = this.#ctx.config.codexTurnTimeoutMs ?? CODEX_TURN_TIMEOUT_DEFAULT_MS;
      const arm = this.#ctx.armTurnDeadline ?? armWithTimeout;
      this.#cancelTurnDeadline = arm(() => this.#timeOutTurn(deadline), deadline);
    }

    // turn/start returns as soon as the turn is accepted; completion arrives later
    // as a notification, which is what actually settles this promise.
    return settled;
  }

  async interrupt(): Promise<void> {
    if (!this.#busy || !this.#threadId) return;
    try {
      await this.#request(CODEX_METHODS.turnInterrupt, this.#interruptParams(this.#threadId));
    } catch (err) {
      log.warn('interrupt failed', { message: (err as Error).message });
    }
  }

  /**
   * Raise a pipe failure on the worker's stdout, the way the OS would.
   *
   * Tests only. A broken pipe cannot be provoked portably from a healthy child, and what
   * needs covering is the listener wiring on the real stream of a really spawned process —
   * which is also why this emits the event rather than calling the handler: without the
   * listener, `emit('error')` is exactly the uncaught exception being guarded against.
   */
  failStdoutForTests(err: Error): void {
    this.#child?.stdout.emit('error', err);
  }

  /** Names the turn when Codex has told us its id, so the server stops that one and no other. */
  #interruptParams(threadId: string): CodexWire.CodexTurnInterruptParams {
    return this.#serverTurnId === null
      ? { threadId }
      : { threadId, turnId: this.#serverTurnId };
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

  /**
   * Sends a request and resolves on its response.
   *
   * `onResult` runs with the response line itself rather than a microtask later, which is
   * what bookkeeping the rest of that same read depends on has to do.
   */
  #request(
    method: string,
    params: unknown,
    onResult?: (result: unknown) => void,
  ): Promise<unknown> {
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
          onResult?.(result);
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

    // An approval from a turn the watchdog abandoned must not be shown as the current
    // turn's, or the operator answers for work they are not looking at. Denying it here
    // still answers the server, which is what keeps that turn from wedging.
    if (!this.#ownsActiveTurn(typeof params.turnId === 'string' ? params.turnId : null)) {
      log.warn('approval from another turn denied', { turn: params.turnId ?? null });
      this.#respond(msg.id, { decision: 'denied' } satisfies CodexWire.CodexApprovalResponse);
      return;
    }

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

  /**
   * Does something the server said about turn `turnId` belong to the turn in flight?
   *
   * A turn the watchdog abandoned goes on running on the server, so "the turn we are in"
   * and "the only turn that can still be talking" stop being the same thing. When both
   * sides name a turn the answer is exact. When either side is unnamed — Codex leaves the
   * turn off several notifications, and `exec/outputDelta` has never carried one — the
   * honest answer is only that it belongs to the turn in flight while nothing else could
   * be emitting.
   */
  #ownsActiveTurn(turnId: string | null): boolean {
    if (this.#serverTurnId !== null && turnId !== null) return turnId === this.#serverTurnId;
    return this.#abandonedTurns.size === 0 && !this.#abandonedUnnamedTurn;
  }

  #onNotification(msg: CodexWire.JsonRpcNotification): void {
    const params = (msg.params ?? {}) as Record<string, unknown>;

    // Everything below `thread/started` is scoped to a turn, and an abandoned turn's
    // stragglers — items, output, plans, diffs — would otherwise be stamped with the turn
    // in flight and land in its transcript and its patch. Read ownership before retiring
    // the id, or a completion would clear the doubt it is itself the evidence of.
    if (msg.method !== CODEX_NOTIFICATIONS.threadStarted) {
      const named = notificationTurnId(params);
      const owned = this.#ownsActiveTurn(named);
      // An abandoned turn reporting complete is the one thing that proves it has stopped.
      if (msg.method === CODEX_NOTIFICATIONS.turnCompleted && named !== null) {
        this.#abandonedTurns.delete(named);
      }
      if (!owned) {
        log.debug('notification from another turn ignored', { method: msg.method, turn: named });
        return;
      }
    }

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
        // Confirms rather than replaces our id: the turn was already named by the
        // acceptance, and this is the only chance to learn it when it was not.
        if (this.#busy && p.turn?.id) this.#serverTurnId = p.turn.id;
        return;
      }

      case CODEX_NOTIFICATIONS.turnCompleted: {
        const p = params as unknown as CodexWire.CodexTurnCompletedParams;
        if (!this.#busy) {
          log.debug('completion outside a turn ignored', { turn: p.turn?.id ?? null });
          return;
        }
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

        this.#clearTurnDeadline();
        this.#busy = false;
        this.#turnId = null;
        this.#serverTurnId = null;
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

  /**
   * The turn outlived its deadline, so nothing is going to end it.
   *
   * Approvals are settled first: the server blocks on them, and one left pending would
   * otherwise sit until its own timer fires against a turn that no longer exists.
   */
  #timeOutTurn(deadline: number): void {
    if (!this.#busy) return;
    const message = `Codex did not complete the turn within ${deadline}ms.`;
    log.warn('turn timed out', { turnId: this.#turnId, deadline });

    // Giving up locally does not stop the server, which may still be running this turn in
    // the thread's directory. Remember its id so nothing it says afterwards is taken for
    // the next turn's, and ask it to stop. The interrupt is a request, not a guarantee:
    // until the turn's own completion arrives, the adapter treats it as still emitting.
    if (this.#serverTurnId !== null) this.#abandonedTurns.add(this.#serverTurnId);
    else this.#abandonedUnnamedTurn = true;

    this.#ctx.emit({ kind: 'error', severity: 'turn', turnId: this.#turnId, message });
    for (const [approvalId] of this.#approvals) this.#settleApproval(approvalId, 'denied', true);
    if (this.#child && this.#threadId) {
      void this.#request(
        CODEX_METHODS.turnInterrupt,
        this.#interruptParams(this.#threadId),
      ).catch((err) => {
        log.warn('interrupt after a timed-out turn failed', { message: (err as Error).message });
      });
    }
    this.#failTurn(new Error(message));
    // The process is still alive and can take another turn; say so, or the UI goes on
    // showing a worker that is busy with nothing.
    this.#emitStatus('idle', null);
  }

  #clearTurnDeadline(): void {
    if (this.#cancelTurnDeadline === null) return;
    this.#cancelTurnDeadline();
    this.#cancelTurnDeadline = null;
  }

  #failTurn(err: Error): void {
    this.#clearTurnDeadline();
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
    this.#serverTurnId = null;
    this.#turnSettle?.reject(err);
  }
}

/**
 * The turn a notification names, across the shapes Codex uses for it.
 *
 * `turn/started` and `turn/completed` nest it under `turn`; item and diff notifications
 * carry a flat `turnId`; several carry nothing at all, which is what `null` means here.
 */
function notificationTurnId(params: Record<string, unknown>): string | null {
  const turn = params['turn'];
  if (typeof turn === 'object' && turn !== null) {
    const id = (turn as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return typeof params['turnId'] === 'string' ? params['turnId'] : null;
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
