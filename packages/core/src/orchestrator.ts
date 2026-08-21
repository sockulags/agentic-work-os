import { EventEmitter } from 'node:events';
import type {
  AdapterEvent,
  AgentId,
  ApprovalRequestedBody,
  HarnessEvent,
  PermissionMode,
  PlanItem,
  ThreadRuntimeState,
  ThreadSummary,
} from '@awos/protocol';
import { PINNED_CONTEXT_MAX_CHARS } from '@awos/protocol';
import type { HarnessConfig } from './config.js';
import type { AgentAdapter, AdapterContext } from './adapters/agent.js';
import { ClaudeAdapter } from './adapters/claude.js';
import { CodexAdapter } from './adapters/codex.js';
import { PermissionBridge } from './permission-bridge.js';
import { ThreadStore } from './store/thread-store.js';
import { ContextStore, applyPinnedContext, buildPinnedContext } from './store/context-store.js';
import { applyReplay, buildReplay, hasReplay, stripReplay } from './store/replay.js';
import { ArtifactWatcher } from './artifact-watcher.js';
import { contentHash } from './store/artifact-store.js';
import { snapshotWorkingTree, diffTrees } from './util/git.js';
import { createLogger } from './util/logger.js';

const log = createLogger('orchestrator');

export interface OrchestratorEvents {
  event: (event: HarnessEvent) => void;
  state: (state: ThreadRuntimeState) => void;
  thread: (thread: ThreadSummary) => void;
}

/**
 * A live conversation: one canonical transcript, up to two agent processes.
 *
 * Adapters are lazy. A thread that only ever talks to Claude never spawns Codex, which
 * matters because each process is a real agent session with real startup cost.
 */
class Thread {
  readonly id: string;
  readonly #config: HarnessConfig;
  readonly #store: ThreadStore;
  readonly #context: ContextStore;
  readonly #bridge: PermissionBridge;
  readonly #emit: (event: HarnessEvent) => void;
  readonly #onState: () => void;

  readonly #adapters = new Map<AgentId, AgentAdapter>();
  #permissionMode: PermissionMode = 'default';
  #busyWith: AgentId | null = null;
  #currentTurnId: string | null = null;
  #lastTurnAgent: AgentId | null = null;
  #plan: PlanItem[] = [];
  #diff: string | null = null;
  readonly #pendingApprovals = new Map<string, ApprovalRequestedBody>();
  readonly #agentStatus = new Map<AgentId, { status: string; model: string | null }>();
  readonly #artifacts: ArtifactWatcher | null = null;

  constructor(
    id: string,
    deps: {
      config: HarnessConfig;
      store: ThreadStore;
      context: ContextStore;
      bridge: PermissionBridge;
      emit: (event: HarnessEvent) => void;
      onState: () => void;
    },
  ) {
    this.id = id;
    this.#config = deps.config;
    this.#store = deps.store;
    this.#context = deps.context;
    this.#bridge = deps.bridge;
    this.#emit = deps.emit;
    this.#onState = deps.onState;

    // Rebuild derived state from history so a reopened thread shows its checklist and
    // the diff from the last turn that produced one.
    const publishedArtifacts = new Map<string, string>();
    for (const event of this.#store.events(id)) {
      if (event.kind === 'plan.updated') this.#plan = event.items;
      else if (event.kind === 'turn.started') {
        this.#lastTurnAgent = event.agent;
        this.#diff = null;
      }
      else if (event.kind === 'diff.updated') this.#diff = event.patch;
      else if (event.kind === 'artifact.updated') {
        // A tombstone retires the id: leaving its hash behind would make the watcher
        // announce the same deletion again on every restart.
        if (event.content === '') publishedArtifacts.delete(event.artifactId);
        else publishedArtifacts.set(event.artifactId, contentHash(event.content));
      }
    }

    const cwd = this.#store.get(id)?.cwd;
    if (cwd) {
      this.#artifacts = new ArtifactWatcher({
        cwd,
        known: publishedArtifacts,
        // Attributed to the turn in flight, which is a guess the watcher cannot verify —
        // it sees a file change, not an author — but during a turn the agent is the only
        // thing writing, and knowing which turn produced a document is worth more than
        // the rare misattribution of a file the user saved at the same moment.
        emit: (body) => this.#record(null, { ...body, turnId: this.#currentTurnId }),
      });
      this.#artifacts.start();
    }
  }

  get busyWith(): AgentId | null {
    return this.#busyWith;
  }

  setPermissionMode(mode: PermissionMode): void {
    this.#permissionMode = mode;
    // Existing processes were launched with the old mode baked into their argv, so the
    // change lands on the next spawn. Restarting mid-thread would drop native context.
    log.info('permission mode set', { threadId: this.id, mode, appliesOnNextSpawn: true });
  }

  state(): ThreadRuntimeState {
    const agents = {
      claude: this.#agentStatus.get('claude') ?? { status: 'idle', model: null },
      codex: this.#agentStatus.get('codex') ?? { status: 'idle', model: null },
    };
    return {
      threadId: this.id,
      busyWith: this.#busyWith,
      currentTurnId: this.#currentTurnId,
      lastTurnAgent: this.#lastTurnAgent,
      plan: this.#plan,
      diff: this.#diff,
      pendingApprovals: [...this.#pendingApprovals.values()],
      agents,
    };
  }

  // -------------------------------------------------------------------------

  async send(agent: AgentId, text: string): Promise<void> {
    if (this.#busyWith !== null) {
      throw new Error(
        `${this.#busyWith} is still working. Interrupt it before sending to ${agent}.`,
      );
    }

    const summary = this.#store.get(this.id);
    if (!summary) throw new Error(`Unknown thread ${this.id}`);

    // Build the replay *before* recording the new message. The user message counts as a
    // foreign event (its agent is null), so recording first would fold the prompt into
    // its own preamble and the agent would receive it twice.
    const watermark = summary.watermarks[agent] ?? 0;
    const unseen = this.#store.eventsSince(this.id, watermark);
    const replay = buildReplay(unseen, agent, {
      maxChars: this.#config.replayMaxChars,
      maxToolOutput: this.#config.replayMaxToolOutput,
    });

    // Record what the user actually typed, not the wire payload. The transcript should
    // reflect the conversation; the replay block is transport, not content.
    this.#record(null, {
      kind: 'user.message',
      text,
      hadReplay: replay.preamble !== null,
    });

    if (replay.preamble) {
      log.info('replaying context', {
        threadId: this.id,
        agent,
        turns: replay.turnCount,
        brief: replay.digestTurns,
        elided: replay.elidedTurns,
        chars: replay.preamble.length,
      });
    }

    // Read at send time, not cached on the thread: the notes are a file the user — or an
    // editor outside this app — can change between turns, and the next turn should carry
    // what is on disk now.
    const pinned = buildPinnedContext(this.#context.get(this.id), {
      maxChars: PINNED_CONTEXT_MAX_CHARS,
    });
    if (pinned) {
      log.info('pinning context', { threadId: this.id, agent, chars: pinned.length });
    }

    const payload = applyPinnedContext(pinned, applyReplay(replay.preamble, text));
    const adapter = this.#adapter(agent);

    // Claim the turn synchronously, before any await, so a second concurrent send sees
    // the thread busy and is rejected rather than racing in.
    this.#busyWith = agent;
    this.#onState();

    // Agents that don't report their own turn diff (Claude) get one synthesized from a
    // git snapshot taken around the turn. Ground truth from the working tree, never a
    // guess parsed from tool output. Codex reports its own, so we don't shadow it.
    const diffBaseline = adapter.capabilities.turnDiff
      ? null
      : await snapshotWorkingTree(summary.cwd);

    try {
      await adapter.sendTurn(payload);
    } finally {
      // Emit the synthesized diff before clearing the turn id, so it's attributed to the
      // turn that produced it. A no-op when nothing changed or the cwd isn't a git repo.
      if (diffBaseline !== null) {
        const after = await snapshotWorkingTree(summary.cwd);
        const patch = after ? await diffTrees(summary.cwd, diffBaseline, after) : null;
        if (patch) this.#record(agent, { kind: 'diff.updated', turnId: this.#currentTurnId, patch });
      }
      this.#busyWith = null;
      this.#currentTurnId = null;
      // Advance the watermark whether or not the turn succeeded: the agent received the
      // context either way, and re-sending it would duplicate history in its session.
      this.#store.setWatermark(this.id, agent, this.#store.head(this.id));
      this.#onState();
    }
  }

  async interrupt(): Promise<void> {
    const agent = this.#busyWith;
    if (!agent) return;
    await this.#adapters.get(agent)?.interrupt();
  }

  resolveApproval(approvalId: string, optionId: string): void {
    const pending = this.#pendingApprovals.get(approvalId);
    if (!pending) throw new Error(`No pending approval ${approvalId}`);
    // Only the agent that raised it can answer it, so ask both — the other is a no-op.
    for (const adapter of this.#adapters.values()) {
      adapter.resolveApproval(approvalId, optionId);
    }
  }

  async stop(): Promise<void> {
    this.#artifacts?.stop();
    await Promise.all([...this.#adapters.values()].map((adapter) => adapter.stop()));
    this.#adapters.clear();
    this.#bridge.unregisterThread(this.id);
  }

  // -------------------------------------------------------------------------

  #adapter(agent: AgentId): AgentAdapter {
    const existing = this.#adapters.get(agent);
    if (existing) return existing;

    const summary = this.#store.get(this.id);
    if (!summary) throw new Error(`Unknown thread ${this.id}`);

    const ctx: AdapterContext = {
      threadId: this.id,
      cwd: summary.cwd,
      config: this.#config,
      permissionMode: this.#permissionMode,
      resumeSessionId: summary.nativeSessions[agent] ?? null,
      permissionBridge: this.#bridge,
      emit: (event) => this.#record(agent, event),
      onSessionId: (sessionId) => this.#store.setNativeSession(this.id, agent, sessionId),
    };

    const adapter = agent === 'claude' ? new ClaudeAdapter(ctx) : new CodexAdapter(ctx);
    this.#adapters.set(agent, adapter);
    return adapter;
  }

  /** Persist, update derived state, broadcast. The single write path for events. */
  #record(agent: AgentId | null, body: AdapterEvent): void {
    const event = this.#store.append(this.id, agent, body);

    switch (event.kind) {
      case 'turn.started':
        this.#currentTurnId = event.turnId;
        this.#lastTurnAgent = event.agent;
        // The diff is scoped to a turn. Carrying it over would show the previous
        // agent's changes as if the current one had made them.
        this.#diff = null;
        break;
      case 'plan.updated':
        this.#plan = event.items;
        break;
      case 'diff.updated':
        this.#diff = event.patch;
        break;
      case 'approval.requested':
        this.#pendingApprovals.set(event.approvalId, event);
        break;
      case 'approval.resolved':
        this.#pendingApprovals.delete(event.approvalId);
        break;
      case 'agent.status':
        if (agent) this.#agentStatus.set(agent, { status: event.status, model: event.model });
        break;
      default:
        break;
    }

    this.#emit(event);

    // These change the panels around the transcript, not just the transcript.
    if (
      event.kind === 'plan.updated' ||
      event.kind === 'diff.updated' ||
      event.kind === 'turn.started' ||
      event.kind === 'approval.requested' ||
      event.kind === 'approval.resolved' ||
      event.kind === 'agent.status'
    ) {
      this.#onState();
    }
  }
}

/**
 * Owns every live thread and the one shared permission bridge.
 */
export class Orchestrator extends EventEmitter {
  readonly store: ThreadStore;
  readonly context: ContextStore;
  readonly #config: HarnessConfig;
  readonly #bridge = new PermissionBridge();
  readonly #threads = new Map<string, Thread>();

  constructor(config: HarnessConfig) {
    super();
    this.#config = config;
    this.store = new ThreadStore(config.dataDir);
    this.context = new ContextStore(config.dataDir);
  }

  async start(): Promise<void> {
    await this.#bridge.listen(this.#config.host);
  }

  async stop(): Promise<void> {
    await Promise.all([...this.#threads.values()].map((thread) => thread.stop()));
    this.#threads.clear();
    await this.#bridge.close();
  }

  createThread(options: { cwd: string; title?: string; agent?: AgentId }): ThreadSummary {
    const summary = this.store.create(options);
    this.emit('thread', summary);
    return summary;
  }

  deleteThread(threadId: string): void {
    const thread = this.#threads.get(threadId);
    this.#threads.delete(threadId);
    void thread?.stop();
    this.store.delete(threadId);
  }

  state(threadId: string): ThreadRuntimeState {
    return this.#thread(threadId).state();
  }

  async send(threadId: string, agent: AgentId, text: string): Promise<void> {
    const summary = this.store.get(threadId);
    if (!summary) throw new Error(`Unknown thread ${threadId}`);

    if (summary.activeAgent !== agent) {
      const updated = this.store.update(threadId, { activeAgent: agent });
      this.emit('thread', updated);
    }

    // First real message names the thread, so the sidebar isn't a wall of "New thread".
    if (summary.title === 'New thread') {
      const title = text.trim().split('\n')[0]?.slice(0, 60) ?? 'New thread';
      this.emit('thread', this.store.update(threadId, { title }));
    }

    await this.#thread(threadId).send(agent, text);
    const after = this.store.get(threadId);
    if (after) this.emit('thread', after);
  }

  async interrupt(threadId: string): Promise<void> {
    await this.#thread(threadId).interrupt();
  }

  resolveApproval(threadId: string, approvalId: string, optionId: string): void {
    this.#thread(threadId).resolveApproval(approvalId, optionId);
  }

  setPermissionMode(threadId: string, mode: PermissionMode): void {
    this.#thread(threadId).setPermissionMode(mode);
  }

  getPinnedContext(threadId: string): string {
    this.#requireThread(threadId);
    return this.context.get(threadId);
  }

  setPinnedContext(threadId: string, text: string): void {
    // Checked against the store rather than the live thread map, so pinning notes on a
    // thread that has never taken a turn doesn't spin up its adapters.
    this.#requireThread(threadId);
    this.context.set(threadId, text);
  }

  /** Display form of a recorded user message, with any replay block removed. */
  static displayText(text: string): string {
    return hasReplay(text) ? stripReplay(text) : text;
  }

  #requireThread(threadId: string): void {
    if (!this.store.get(threadId)) throw new Error(`Unknown thread ${threadId}`);
  }

  #thread(threadId: string): Thread {
    const existing = this.#threads.get(threadId);
    if (existing) return existing;

    this.#requireThread(threadId);

    const thread = new Thread(threadId, {
      config: this.#config,
      store: this.store,
      context: this.context,
      bridge: this.#bridge,
      emit: (event) => this.emit('event', event),
      onState: () => this.emit('state', thread.state()),
    });
    this.#threads.set(threadId, thread);
    return thread;
  }
}
