import { EventEmitter } from 'node:events';
import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
  EvidenceKind,
  EvidenceRef,
  RetainedItem,
  RetainedKind,
  RunClaim,
  ThreadSummary,
  WorkItem,
  WorkingState,
  WorkSourceError,
  WorkspaceResolution,
} from '@awos/protocol';
import { PINNED_CONTEXT_MAX_CHARS, RETAINED_FILE, RUN_CONTEXT_MAX_CHARS } from '@awos/protocol';
import type { HarnessConfig } from './config.js';
import type { AgentAdapter, AdapterContext } from './adapters/agent.js';
import { ClaudeAdapter } from './adapters/claude.js';
import { CodexAdapter } from './adapters/codex.js';
import { PermissionBridge } from './permission-bridge.js';
import { ThreadStore } from './store/thread-store.js';
import { ContextStore, applyPinnedContext, buildPinnedContext } from './store/context-store.js';
import { resolveWorkspace } from './workspace/resolve.js';
import { applyWorkspace, buildWorkspaceBlock } from './workspace/prompt.js';
import { WorkItemStore } from './work/store.js';
import {
  applyRetained,
  applyWorkItem,
  buildRetainedBlock,
  buildWorkItemBlock,
} from './work/prompt.js';
import { foldRetained, selectedForContext } from './work/ledger.js';
import { fetchIssue, parseIssueRef } from './work/github.js';
import { applyReplay, buildReplay, hasReplay, stripReplay } from './store/replay.js';
import { ArtifactWatcher } from './artifact-watcher.js';
import { contentHash } from './store/artifact-store.js';
import { snapshotWorkingTree, diffTrees, headTree, headCommit } from './util/git.js';
import type { Lane } from './util/worktree.js';
import { provisionLane, laneDiff, integrateLane, removeLane } from './util/worktree.js';
import { createLogger } from './util/logger.js';

const log = createLogger('orchestrator');
const execAsync = promisify(exec);

/**
 * Keep a recorded context within its budget.
 *
 * The cut is marked rather than silent: a run's value is as evidence, and evidence that
 * has been trimmed without saying so is worse than no evidence.
 */
function capContext(payload: string): string {
  if (payload.length <= RUN_CONTEXT_MAX_CHARS) return payload;
  return `${payload.slice(0, RUN_CONTEXT_MAX_CHARS)}

_[cut here: the context sent was ${payload.length} characters; this record holds the first ${RUN_CONTEXT_MAX_CHARS}]_`;
}

const RETAINED_KINDS = ['discovery', 'decision', 'constraint', 'question'] as const;

/** A retained kind an agent actually wrote, or null for anything else it put there. */
function asRetainedKind(value: unknown): RetainedKind | null {
  return (RETAINED_KINDS as readonly string[]).includes(value as string)
    ? (value as RetainedKind)
    : null;
}

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
  readonly #work: WorkItemStore;
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
      work: WorkItemStore;
      bridge: PermissionBridge;
      emit: (event: HarnessEvent) => void;
      onState: () => void;
    },
  ) {
    this.id = id;
    this.#config = deps.config;
    this.#store = deps.store;
    this.#context = deps.context;
    this.#work = deps.work;
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

  /**
   * Take a turn.
   *
   * `asRun` marks the turn as the start of a run against the thread's work item: the same
   * dispatch, bracketed by `run.started` and `run.completed` so the log records what
   * authorized the work, what the agent was given, and how it ended. Ordinary messages in
   * the same thread still carry the work item in their context — the issue is standing
   * truth about the thread — but they are conversation, not a run.
   */
  async send(agent: AgentId, text: string, asRun = false): Promise<void> {
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

    const item = this.workItem();
    const retained = item === null ? [] : this.retained(item.id);
    const payload = applyWorkspace(
      buildWorkspaceBlock(workspace),
      applyWorkItem(
        buildWorkItemBlock(item),
        applyRetained(
          buildRetainedBlock(selectedForContext(retained)),
          applyPinnedContext(pinned, applyReplay(replay.preamble, text)),
        ),
      ),
    );
    const adapter = this.#adapter(agent, cwd);

    // Recorded before dispatch, and before the run can fail, so a run that dies on the
    // first token still leaves behind what it was asked to do and what it was given.
    const runId = asRun && item ? randomUUID() : null;
    const runFrom = this.#store.head(this.id);
    if (runId && item) {
      this.#record(agent, {
        kind: 'run.started',
        runId,
        workItemId: item.id,
        source: `${item.source.repo}#${item.source.number}`,
        revision: item.snapshot.revision,
        context: capContext(payload),
        instruction: text,
      });
    }

    // Claim the turn synchronously, before any await, so a second send to the same agent
    // sees it busy and is rejected rather than racing in.
    this.#turns.set(agent, null);
    this.#onState();

    // Agents that don't report their own turn diff (Claude) get one synthesized from a
    // git snapshot taken around the turn. Ground truth from the working tree, never a
    // guess parsed from tool output. Codex reports its own, so we don't shadow it.
    const diffBaseline = adapter.capabilities.turnDiff ? null : await snapshotWorkingTree(cwd);

    let failure: string | null = null;
    try {
      await adapter.sendTurn(payload);
    } catch (err) {
      failure = (err as Error).message;
      throw err;
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
      // Read after the turn rather than watched during it: nothing needs these the moment
      // they are written, and a file read on a boundary we already have beats another
      // watcher with its own debounce and restart story.
      if (item) this.#ingestRetained(agent, cwd, item.id, runId);
      if (runId) this.#closeRun(agent, runId, runFrom, failure);
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

  /**
   * Retained context for a work item, from every thread that has worked on it.
   *
   * Folded across threads because the item outlives any one of them: a second thread on
   * the same issue must not start out ignorant of what the first one established. The
   * store holds every thread's events in memory already, so this is a filter rather than
   * a read.
   */
  retained(workItemId: string): RetainedItem[] {
    return foldRetained(this.#store.allEvents()).filter(
      (entry) => entry.workItemId === workItemId,
    );
  }

  /**
   * Take what the agent wrote to `.awos/retained.jsonl` and put it in the ledger.
   *
   * Deduplicated on kind and text rather than on file position, so an agent that rewrites
   * the file, or a restart that re-reads it, adds nothing. The file is left alone: it is
   * the agent's scratch, and deleting other people's files to track our own bookkeeping is
   * how you lose someone's notes.
   */
  #ingestRetained(agent: AgentId, cwd: string, workItemId: string, runId: string | null): void {
    const path = join(cwd, RETAINED_FILE);
    if (!existsSync(path)) return;

    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      log.warn('unreadable retained file', { path, message: (err as Error).message });
      return;
    }

    const known = new Set(
      this.retained(workItemId).map((entry) => `${entry.kind}:${entry.text}`),
    );

    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      let parsed: { kind?: unknown; text?: unknown };
      try {
        parsed = JSON.parse(line) as { kind?: unknown; text?: unknown };
      } catch {
        // One malformed line is the agent's typo, not a reason to drop the rest.
        log.warn('malformed retained line', { path });
        continue;
      }

      const kind = asRetainedKind(parsed.kind);
      const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
      if (kind === null || text === '') continue;
      if (known.has(`${kind}:${text}`)) continue;
      known.add(`${kind}:${text}`);

      this.#record(agent, {
        kind: 'context.retained',
        retainedId: randomUUID(),
        workItemId,
        retainedKind: kind,
        text,
        runId,
        // On by default: an agent that bothered to write something down meant it to be
        // read, and the person can drop it in one click if they disagree.
        selected: true,
        retired: false,
      });
    }
  }

  /**
   * The code an evidence item is about.
   *
   * Taken from the lane when the agent has one, because that is where its work actually
   * is; a claim about the thread directory would be a claim about files the agent never
   * touched.
   */
  async #workingState(agent: AgentId | null): Promise<WorkingState> {
    const summary = this.#store.get(this.id);
    const lane = agent === null ? undefined : this.#lanes.get(agent);
    const cwd = lane?.path ?? summary?.cwd;
    if (cwd === undefined) return { commit: null, tree: null, dirty: false };

    const [commit, tree, head] = await Promise.all([
      headCommit(cwd),
      snapshotWorkingTree(cwd),
      headTree(cwd),
    ]);
    return { commit, tree, dirty: tree !== null && head !== null && tree !== head };
  }

  /** Close a run with what it actually achieved. */
  closeRun(runId: string, claim: RunClaim, statement: string): void {
    if (!this.#hasRun(runId)) throw new Error(`No run ${runId} in this thread.`);
    this.#record(null, { kind: 'run.closed', runId, claim, statement });
    this.#onState();
  }

  /** Attach evidence to a run, with the tree it applies to captured now. */
  async recordEvidence(input: {
    runId: string;
    kind: EvidenceKind;
    ref: EvidenceRef;
    summary: string;
    evidenceId?: string;
  }): Promise<void> {
    const started = this.#runStarted(input.runId);
    if (!started) throw new Error(`No run ${input.runId} in this thread.`);

    this.#record(null, {
      kind: 'evidence.recorded',
      evidenceId: input.evidenceId ?? randomUUID(),
      runId: input.runId,
      workItemId: started.workItemId,
      evidenceKind: input.kind,
      ref: input.ref,
      summary: input.summary,
      state: await this.#workingState(started.agent),
    });
    this.#onState();
  }

  /** Write something down against the work item. */
  retainContext(input: {
    kind: RetainedKind;
    text: string;
    runId?: string | null;
    retainedId?: string;
    selected?: boolean;
    retired?: boolean;
  }): void {
    const item = this.workItem();
    if (item === null) throw new Error('This thread has no work item to retain anything against.');

    this.#record(null, {
      kind: 'context.retained',
      retainedId: input.retainedId ?? randomUUID(),
      workItemId: item.id,
      retainedKind: input.kind,
      text: input.text,
      runId: input.runId ?? null,
      selected: input.selected ?? true,
      retired: input.retired ?? false,
    });
    this.#onState();
  }

  /**
   * Change whether a retained item is carried forward, or retire it.
   *
   * Composed here from the current record rather than taken from the caller, so a client
   * cannot rewrite the text of a claim while pretending to tick a box. The new record is
   * appended; the old one stays exactly as it was written.
   */
  amendRetained(retainedId: string, patch: { selected?: boolean; retired?: boolean }): void {
    const current = this.retained(this.workItem()?.id ?? '').find((entry) => entry.id === retainedId);
    if (!current) throw new Error(`No retained item ${retainedId} on this work item.`);

    this.#record(null, {
      kind: 'context.retained',
      retainedId: current.id,
      workItemId: current.workItemId,
      retainedKind: current.kind,
      text: current.text,
      runId: current.runId,
      selected: patch.selected ?? current.selected,
      retired: patch.retired ?? current.retired,
    });
    this.#onState();
  }

  #hasRun(runId: string): boolean {
    return this.#runStarted(runId) !== null;
  }

  #runStarted(runId: string): { workItemId: string; agent: AgentId | null } | null {
    for (const event of this.#store.events(this.id)) {
      if (event.kind === 'run.started' && event.runId === runId) {
        return { workItemId: event.workItemId, agent: event.agent };
      }
    }
    return null;
  }

  /** The work item this thread answers, or null. Read through, never cached. */
  workItem(): WorkItem | null {
    const id = this.#store.get(this.id)?.workItemId ?? null;
    return id === null ? null : (this.#work.get(id) ?? null);
  }

  /**
   * Close a run with how its turn actually ended.
   *
   * Read back out of the log rather than tracked in a field: the terminal state is
   * already recorded there by whichever path finished the turn, and a second copy kept
   * alongside would be one more thing that can disagree with the transcript.
   */
  #closeRun(agent: AgentId, runId: string, fromSeq: number, failure: string | null): void {
    if (failure !== null) {
      this.#record(agent, { kind: 'run.completed', runId, state: 'error', detail: failure });
      return;
    }

    const completion = this.#store
      .eventsSince(this.id, fromSeq)
      .filter((event) => event.kind === 'turn.completed' && event.agent === agent)
      .pop();

    if (completion?.kind !== 'turn.completed') {
      this.#record(agent, {
        kind: 'run.completed',
        runId,
        state: 'completed',
        detail: 'the agent ended the turn without reporting how',
      });
      return;
    }

    switch (completion.reason) {
      case 'completed':
        this.#record(agent, { kind: 'run.completed', runId, state: 'completed', detail: null });
        return;
      case 'interrupted':
        this.#record(agent, { kind: 'run.completed', runId, state: 'interrupted', detail: null });
        return;
      case 'error':
        this.#record(agent, {
          kind: 'run.completed',
          runId,
          state: 'error',
          detail: completion.error,
        });
        return;
      default:
        // max_turns and max_budget: the agent stopped short of the work, which is not a
        // finished run however cleanly the process exited.
        this.#record(agent, {
          kind: 'run.completed',
          runId,
          state: 'error',
          detail: `the agent stopped early (${completion.reason})`,
        });
    }
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
  readonly work: WorkItemStore;
  readonly #config: HarnessConfig;
  readonly #bridge = new PermissionBridge();
  readonly #threads = new Map<string, Thread>();

  constructor(config: HarnessConfig) {
    super();
    this.#config = config;
    this.store = new ThreadStore(config.dataDir);
    this.context = new ContextStore(config.dataDir);
    this.work = new WorkItemStore(config.dataDir);
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

  async send(threadId: string, agent: AgentId, text: string, asRun = false): Promise<void> {
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

    await this.#thread(threadId).send(agent, text, asRun);
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

  // -------------------------------------------------------------------------
  // Work items
  // -------------------------------------------------------------------------

  /** The item a thread answers, or null. */
  workItem(threadId: string): WorkItem | null {
    const id = this.store.get(threadId)?.workItemId ?? null;
    return id === null ? null : (this.work.get(id) ?? null);
  }

  /**
   * Attach a GitHub issue to a thread.
   *
   * The reference may be a URL, `owner/name#12`, or a bare number resolved against the
   * workspace's declared repository — which is the whole reason the workspace contract
   * came first: without it there is nothing a bare `#14` could mean.
   *
   * A failure to reach GitHub is returned rather than thrown. Every one of them is
   * something the user can act on, and the panel that asked has to be able to say which.
   */
  async attachWorkItem(
    threadId: string,
    reference: string,
  ): Promise<{ item: WorkItem | null; error: WorkSourceError | null }> {
    const summary = this.store.get(threadId);
    if (!summary) throw new Error(`Unknown thread ${threadId}`);

    const workspace = this.workspace(summary.cwd);
    if (workspace.status !== 'ok') {
      return {
        item: null,
        error: {
          kind: 'unknown',
          // Where the record would belong is undefined without a workspace, and a work
          // item filed against nothing would be unreachable from every other thread.
          message:
            'This directory is not a workspace yet. Declare .awos/workspace.json first, so the issue has a project to belong to.',
          retryable: false,
        },
      };
    }

    const parsed = parseIssueRef(reference, workspace.workspace.repository.github);
    if ('error' in parsed) {
      return { item: null, error: { kind: 'not-found', message: parsed.error, retryable: false } };
    }

    const result = await fetchIssue(parsed, this.#github());
    if (!result.ok) return { item: null, error: result.error };

    const item = this.work.record({
      workspaceRoot: workspace.workspace.root,
      ref: result.ref,
      snapshot: result.snapshot,
    });

    if (summary.workItemId !== item.id) {
      this.emit('thread', this.store.update(threadId, { workItemId: item.id }));
    }
    log.info('work item attached', { threadId, source: `${item.source.repo}#${item.source.number}` });
    return { item, error: null };
  }

  /**
   * Ask GitHub again.
   *
   * Nothing that has already run is touched: a run's context and revision are events, and
   * events do not change. What moves is the item's own snapshot, which is what later turns
   * and later runs will carry — so the UI can compare the two and say the source has
   * changed since a run, without anything having rewritten that run's history.
   */
  async refreshWorkItem(
    threadId: string,
  ): Promise<{ item: WorkItem | null; error: WorkSourceError | null }> {
    const current = this.workItem(threadId);
    if (current === null) {
      return {
        item: null,
        error: { kind: 'not-found', message: 'This thread has no work item to refresh.', retryable: false },
      };
    }

    const result = await fetchIssue(
      { repo: current.source.repo, number: current.source.number },
      this.#github(),
    );
    if (!result.ok) return { item: current, error: result.error };

    const item = this.work.record({
      workspaceRoot: current.workspaceRoot,
      ref: result.ref,
      snapshot: result.snapshot,
    });
    return { item, error: null };
  }

  /** Unlink a thread from its item. The item and the runs that used it both survive. */
  detachWorkItem(threadId: string): void {
    const summary = this.store.get(threadId);
    if (!summary) throw new Error(`Unknown thread ${threadId}`);
    if (summary.workItemId === null) return;
    this.emit('thread', this.store.update(threadId, { workItemId: null }));
  }

  // -------------------------------------------------------------------------
  // Outcomes, evidence and retained context
  // -------------------------------------------------------------------------

  /**
   * State what a run achieved, as opposed to how its turn ended.
   *
   * Never inferred from the turn: an agent that exits cleanly having done the wrong thing
   * is the case this exists for, and no signal in the log tells it apart from success.
   * Correcting a claim is another call — the record is appended, not edited.
   */
  closeRun(threadId: string, runId: string, claim: RunClaim, statement: string): void {
    this.#thread(threadId).closeRun(runId, claim, statement);
  }

  /** Attach evidence to a run, with the tree it applies to captured as it stands now. */
  async recordEvidence(
    threadId: string,
    input: { runId: string; kind: EvidenceKind; ref: EvidenceRef; summary: string; evidenceId?: string },
  ): Promise<void> {
    await this.#thread(threadId).recordEvidence(input);
  }

  /** Write something down against the thread's work item. */
  retainContext(
    threadId: string,
    input: { kind: RetainedKind; text: string; runId?: string | null; retainedId?: string },
  ): void {
    this.#thread(threadId).retainContext(input);
  }

  /** Carry a retained item forward or stop carrying it, without rewriting what it says. */
  amendRetained(
    threadId: string,
    retainedId: string,
    patch: { selected?: boolean; retired?: boolean },
  ): void {
    this.#thread(threadId).amendRetained(retainedId, patch);
  }

  /**
   * Everything retained about a thread's work item, from every thread that has touched it.
   *
   * Empty for a thread with no work item — there is nothing for the context to be about.
   */
  retainedFor(threadId: string): RetainedItem[] {
    const item = this.workItem(threadId);
    return item === null ? [] : this.#thread(threadId).retained(item.id);
  }

  #github(): { bin: string; binArgs: string[]; timeoutMs: number } {
    return {
      bin: this.#config.ghBin,
      binArgs: this.#config.ghBinArgs,
      timeoutMs: this.#config.ghTimeoutMs,
    };
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
      work: this.work,
      bridge: this.#bridge,
      emit: (event) => this.emit('event', event),
      onState: () => this.emit('state', thread.state()),
    });
    this.#threads.set(threadId, thread);
    return thread;
  }
}
