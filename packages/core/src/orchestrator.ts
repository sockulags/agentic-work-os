import { EventEmitter } from 'node:events';
import { exec } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  AdapterEvent,
  AgentId,
  ApprovalRequestedBody,
  HarnessEvent,
  PermissionMode,
  PlanItem,
  ThreadRuntimeState,
  ThreadSummary,
  WorkspaceResolution,
} from '@awos/protocol';
import { PINNED_CONTEXT_MAX_CHARS } from '@awos/protocol';
import type { HarnessConfig } from './config.js';
import type { AgentAdapter, AdapterContext } from './adapters/agent.js';
import { ClaudeAdapter } from './adapters/claude.js';
import { CodexAdapter } from './adapters/codex.js';
import { PermissionBridge } from './permission-bridge.js';
import { ThreadStore } from './store/thread-store.js';
import { ContextStore, applyPinnedContext, buildPinnedContext } from './store/context-store.js';
import { resolveWorkspace } from './workspace/resolve.js';
import { applyWorkspace, buildWorkspaceBlock } from './workspace/prompt.js';
import { applyReplay, buildReplay, hasReplay, stripReplay } from './store/replay.js';
import { ArtifactWatcher } from './artifact-watcher.js';
import { contentHash } from './store/artifact-store.js';
import { snapshotWorkingTree, diffTrees, headTree } from './util/git.js';
import type { Lane } from './util/worktree.js';
import { provisionLane, laneDiff, integrateLane, removeLane } from './util/worktree.js';
import { createLogger } from './util/logger.js';

const log = createLogger('orchestrator');
const execAsync = promisify(exec);

/** How many files a patch touches, for a one-line report of what an integration moved. */
function countChangedFiles(patch: string): number {
  return patch.split('\n').filter((line) => line.startsWith('diff --git ')).length;
}

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
  /**
   * Agents with a turn in flight, each mapped to the turn it is running.
   *
   * A map rather than a single field because parallel mode lifts the one-turn rule: with
   * a lane each, two agents cannot race on the filesystem, so the lock is per agent.
   */
  readonly #turns = new Map<AgentId, string | null>();
  #lastTurnAgent: AgentId | null = null;
  #plan: PlanItem[] = [];
  #diff: string | null = null;
  #parallel = false;
  readonly #lanes = new Map<AgentId, Lane>();
  readonly #pendingApprovals = new Map<string, ApprovalRequestedBody>();
  readonly #agentStatus = new Map<AgentId, { status: string; model: string | null }>();
  /** One per watched working copy: the thread directory, plus a lane each in parallel mode. */
  readonly #watchers = new Map<string, ArtifactWatcher>();

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
    if (cwd) this.#watch(cwd, null, publishedArtifacts);
  }

  /**
   * Watch one working copy's artifacts directory.
   *
   * `agent` names the lane it belongs to, or null for the thread's shared directory. Lane
   * artifacts carry their agent in the id, because two lanes are two directories and both
   * may hold a file called `plan.md` — without that, whichever wrote last would silently
   * replace the other in the dock.
   */
  #watch(cwd: string, agent: AgentId | null, known?: Map<string, string>): void {
    if (this.#watchers.has(cwd)) return;
    const watcher = new ArtifactWatcher({
      cwd,
      known: known ?? new Map(),
      // Attributed to the turn in flight, which is a guess the watcher cannot verify —
      // it sees a file change, not an author — but during a turn the agent is the only
      // thing writing, and knowing which turn produced a document is worth more than
      // the rare misattribution of a file the user saved at the same moment.
      emit: (body) =>
        this.#record(agent, {
          ...body,
          artifactId: agent ? `${agent}/${body.artifactId}` : body.artifactId,
          turnId: agent ? (this.#turns.get(agent) ?? null) : this.#currentTurnId,
        }),
    });
    this.#watchers.set(cwd, watcher);
    watcher.start();
  }

  get busyWith(): AgentId | null {
    return this.#busy[0] ?? null;
  }

  get #busy(): AgentId[] {
    return [...this.#turns.keys()];
  }

  /** The turn the UI should attribute loose events to: the one that started most recently. */
  get #currentTurnId(): string | null {
    const turns = [...this.#turns.values()].filter((id): id is string => id !== null);
    return turns[turns.length - 1] ?? null;
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
    const lanes: Partial<Record<AgentId, string>> = {};
    for (const [agent, lane] of this.#lanes) lanes[agent] = lane.path;

    return {
      threadId: this.id,
      busyWith: this.busyWith,
      busy: this.#busy,
      lanes,
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
    if (this.#turns.has(agent)) {
      throw new Error(`${agent} is still working. Interrupt it before sending again.`);
    }
    // Without lanes the two agents share one directory, so the old rule stands: one turn
    // at a time, because the alternative is two processes editing the same files.
    if (!this.#parallel && this.#busy.length > 0) {
      throw new Error(
        `${this.busyWith} is still working. Interrupt it, or turn on parallel mode to give each agent its own lane.`,
      );
    }

    const summary = this.#store.get(this.id);
    if (!summary) throw new Error(`Unknown thread ${this.id}`);

    // Before anything is recorded or spawned: a project that lists which agents may work
    // in it gets to refuse the others. Checked here rather than in the UI because the rule
    // belongs to the repository, and the UI is one of several ways to reach this method.
    const workspace = this.#workspace(summary.cwd);
    if (workspace.status === 'ok' && !workspace.workspace.agents.includes(agent)) {
      throw new Error(
        `${workspace.workspace.name} allows ${workspace.workspace.agents.join(' and ')} here, not ${agent}. ` +
          'Change the agents list in .awos/workspace.json to work with it.',
      );
    }

    // Provisioning is lazy for the same reason adapters are: a thread that only ever
    // talks to Claude should not pay for a Codex checkout.
    const cwd = this.#parallel ? await this.#lane(agent, summary.cwd) : summary.cwd;

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

    const payload = applyWorkspace(
      buildWorkspaceBlock(workspace),
      applyPinnedContext(pinned, applyReplay(replay.preamble, text)),
    );
    const adapter = this.#adapter(agent, cwd);

    // Claim the turn synchronously, before any await, so a second send to the same agent
    // sees it busy and is rejected rather than racing in.
    this.#turns.set(agent, null);
    this.#onState();

    // Agents that don't report their own turn diff (Claude) get one synthesized from a
    // git snapshot taken around the turn. Ground truth from the working tree, never a
    // guess parsed from tool output. Codex reports its own, so we don't shadow it.
    const diffBaseline = adapter.capabilities.turnDiff ? null : await snapshotWorkingTree(cwd);

    try {
      await adapter.sendTurn(payload);
    } finally {
      // Emit the synthesized diff before clearing the turn id, so it's attributed to the
      // turn that produced it. A no-op when nothing changed or the cwd isn't a git repo.
      const turnId = this.#turns.get(agent) ?? null;
      if (diffBaseline !== null) {
        const after = await snapshotWorkingTree(cwd);
        const patch = after ? await diffTrees(cwd, diffBaseline, after) : null;
        if (patch) this.#record(agent, { kind: 'diff.updated', turnId, patch });
      }
      this.#turns.delete(agent);
      // Advance the watermark whether or not the turn succeeded: the agent received the
      // context either way, and re-sending it would duplicate history in its session.
      this.#store.setWatermark(this.id, agent, this.#store.head(this.id));
      this.#onState();
    }
  }

  /** Interrupt one agent, or everything that is running when none is named. */
  async interrupt(agent?: AgentId): Promise<void> {
    const targets = agent ? [agent] : this.#busy;
    await Promise.all(targets.map((id) => this.#adapters.get(id)?.interrupt()));
  }

  /**
   * Turn lanes on or off.
   *
   * Both directions restart the agents' processes, because an adapter's working directory
   * is fixed when it spawns. Their native sessions are dropped with them and the
   * watermarks reset, so the next turn replays the thread's full history into a fresh
   * session — the same rebuild §6 promises when an agent's own session is lost. It costs
   * a replay; it is the only way the agent's idea of where it is stays true.
   */
  async setParallel(on: boolean): Promise<void> {
    if (on === this.#parallel) return;

    const summary = this.#store.get(this.id);
    if (!summary) throw new Error(`Unknown thread ${this.id}`);
    if (this.#busy.length > 0) {
      throw new Error(`${this.busyWith} is working. Interrupt it before changing lanes.`);
    }

    if (on) {
      // Fail here rather than at the first turn: a repo-less directory cannot have lanes,
      // and the user should learn that from the switch they just flipped.
      if ((await headTree(summary.cwd)) === null) {
        throw new Error(
          'Parallel mode needs the thread directory to be a git repository with at least one commit.',
        );
      }
    } else {
      // Leaving lanes behind would throw away work the user never saw. Refuse instead.
      for (const [agent, lane] of this.#lanes) {
        if ((await laneDiff(lane)) !== null) {
          throw new Error(
            `${agent}'s lane has changes that are not in your working directory yet. Integrate or discard them first.`,
          );
        }
      }
    }

    await Promise.all([...this.#adapters.values()].map((adapter) => adapter.stop()));
    this.#adapters.clear();
    this.#store.update(this.id, { parallel: on, nativeSessions: {}, watermarks: { claude: 0, codex: 0 } });
    this.#parallel = on;

    if (!on) await this.#dropLanes();
    log.info('parallel mode set', { threadId: this.id, parallel: on });
    this.#onState();
  }

  /**
   * Apply one lane's work to the thread directory, all of it or none of it.
   *
   * Explicit rather than automatic: the thread directory is the one the user has open, and
   * an agent's work appearing in it without being asked for is the kind of surprise this
   * harness exists to avoid. A refusal is recorded too — an integration that did not
   * happen is a fact about the thread.
   */
  async integrate(agent: AgentId): Promise<{ ok: boolean; detail: string }> {
    const summary = this.#store.get(this.id);
    if (!summary) throw new Error(`Unknown thread ${this.id}`);

    const lane = this.#lanes.get(agent);
    if (!lane) throw new Error(`${agent} has no lane to integrate.`);
    if (this.#turns.has(agent)) {
      throw new Error(`${agent} is still working. Interrupt it before integrating its lane.`);
    }

    const result = await integrateLane(lane, summary.cwd);
    if (!result.ok) {
      this.#record(agent, {
        kind: 'lane.updated',
        status: 'refused',
        path: lane.path,
        detail: result.reason,
      });
      return { ok: false, detail: result.reason };
    }

    const detail =
      result.patch === null
        ? 'nothing to integrate'
        : `${countChangedFiles(result.patch)} file(s) applied to ${summary.cwd}`;
    this.#record(agent, { kind: 'lane.updated', status: 'integrated', path: lane.path, detail });
    return { ok: true, detail };
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
    for (const watcher of this.#watchers.values()) watcher.stop();
    this.#watchers.clear();
    await Promise.all([...this.#adapters.values()].map((adapter) => adapter.stop()));
    this.#adapters.clear();
    await this.#dropLanes();
    this.#bridge.unregisterThread(this.id);
  }

  // -------------------------------------------------------------------------

  /**
   * The project settings in force for a directory.
   *
   * Resolved per call rather than held on the thread. The declaration is a file in the
   * repository, so it can change between turns — a pull, a branch switch, an edit the
   * agent itself made — and a thread that cached it at open would keep working to rules
   * that are no longer in the repo. Two small synchronous reads, on the same path as the
   * pinned notes, which are re-read for the same reason.
   */
  #workspace(cwd: string): WorkspaceResolution {
    return resolveWorkspace(cwd, { laneSetup: this.#config.laneSetup });
  }

  /** The agent's lane, provisioned on first use. Its path, ready to be a working directory. */
  async #lane(agent: AgentId, baseCwd: string): Promise<string> {
    const existing = this.#lanes.get(agent);
    if (existing) return existing.path;

    const path = join(this.#config.dataDir, 'threads', this.id, 'lanes', agent);
    const result = await provisionLane(baseCwd, path);
    if (!result.ok) throw new Error(`Could not give ${agent} a lane: ${result.reason}`);

    this.#lanes.set(agent, result.lane);
    this.#watch(path, agent);

    const setup = await this.#runLaneSetup(path, baseCwd);
    this.#record(agent, {
      kind: 'lane.updated',
      status: 'provisioned',
      path,
      detail: setup,
    });
    this.#onState();
    return path;
  }

  /**
   * Run the project's setup command in a fresh lane.
   *
   * The command comes from the workspace the *project* directory resolves to, not the
   * lane's own — a lane is a checkout of that project and inherits its rules, and asking
   * the copy would only find the same file anyway.
   *
   * Returns what to tell the user rather than throwing: a lane whose `npm install` failed
   * is still a lane the agent can read and edit in, and stopping the turn over it would be
   * a worse trade than saying so.
   */
  async #runLaneSetup(cwd: string, projectCwd: string): Promise<string | null> {
    const workspace = this.#workspace(projectCwd);
    const setup = workspace.status === 'ok' ? workspace.workspace.setup : null;
    const command = setup?.command.trim() ?? '';
    if (command === '') {
      return 'files git ignores were not copied; declare setup.command in .awos/workspace.json to install dependencies here';
    }

    try {
      await execAsync(command, {
        cwd,
        timeout: setup?.timeoutMs ?? this.#config.laneSetupTimeoutMs,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      });
      return `ran ${command}`;
    } catch (err) {
      const detail = String((err as { stderr?: string }).stderr ?? (err as Error).message ?? '')
        .trim()
        .slice(0, 400);
      log.warn('lane setup failed', { cwd, command, detail });
      return `setup command failed: ${command} — ${detail}`;
    }
  }

  /** Remove every lane, keeping any that still holds work the user has not seen. */
  async #dropLanes(): Promise<void> {
    const summary = this.#store.get(this.id);
    for (const [agent, lane] of [...this.#lanes]) {
      if (summary && (await laneDiff(lane)) !== null) {
        // Deleting this would destroy the only copy of that work. Leave it on disk and
        // name it, so the path is in the log rather than only in the user's memory.
        log.warn('keeping a lane with unintegrated work', { agent, path: lane.path });
        this.#record(agent, {
          kind: 'lane.updated',
          status: 'removed',
          path: lane.path,
          detail: 'kept on disk: it still holds changes that were never integrated',
        });
        this.#lanes.delete(agent);
        continue;
      }
      if (summary) await removeLane(summary.cwd, lane.path);
      this.#lanes.delete(agent);
    }
  }

  #adapter(agent: AgentId, cwd: string): AgentAdapter {
    const existing = this.#adapters.get(agent);
    if (existing) return existing;

    const summary = this.#store.get(this.id);
    if (!summary) throw new Error(`Unknown thread ${this.id}`);

    const ctx: AdapterContext = {
      threadId: this.id,
      cwd,
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
        // Bind the turn to the agent running it, so two lanes in flight keep their own.
        if (event.agent) this.#turns.set(event.agent, event.turnId);
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

  async interrupt(threadId: string, agent?: AgentId): Promise<void> {
    await this.#thread(threadId).interrupt(agent);
  }

  async setParallel(threadId: string, parallel: boolean): Promise<void> {
    await this.#thread(threadId).setParallel(parallel);
    const after = this.store.get(threadId);
    if (after) this.emit('thread', after);
  }

  async integrateLane(threadId: string, agent: AgentId): Promise<{ ok: boolean; detail: string }> {
    return this.#thread(threadId).integrate(agent);
  }

  resolveApproval(threadId: string, approvalId: string, optionId: string): void {
    this.#thread(threadId).resolveApproval(approvalId, optionId);
  }

  setPermissionMode(threadId: string, mode: PermissionMode): void {
    this.#thread(threadId).setPermissionMode(mode);
  }

  /**
   * The workspace a directory resolves to.
   *
   * Takes a path, not a thread id, because that is the whole point of the contract: a
   * repository is a workspace before any conversation about it exists, and the same
   * answer has to come back whether it is asked for by an open thread, by the new-thread
   * form, or by a lane.
   */
  workspace(cwd: string): WorkspaceResolution {
    return resolveWorkspace(cwd, { laneSetup: this.#config.laneSetup });
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
