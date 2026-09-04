import { EventEmitter } from 'node:events';
import { exec } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';
import type {
  AdapterEvent,
  AnswerRecordedBody,
  AgentAvailability,
  AgentId,
  ApprovalRequestedBody,
  HarnessEvent,
  PermissionMode,
  PlanItem,
  ThreadRuntimeState,
  EvidenceItem,
  EvidenceKind,
  EvidenceRef,
  CandidateIdentity,
  GateOverride,
  ExpectationSet,
  RecoveryCycle,
  RecoveryAction,
  RecoveryActionKind,
  RecoveryConflict,
  TransitionEvaluationConflict,
  RecoveryWorkerContext,
  RecoveryActionRequest,
  TransitionAttempt,
  TransitionEvaluation,
  TransitionOverride,
  RetainedItem,
  RetainedKind,
  RunClaim,
  ThreadSummary,
  WorkItem,
  WorkingState,
  WorkSourceError,
  WorkspaceResolution,
  WorkspaceRoleSelection,
  WorkspaceIssueCatalog,
  IssueCatalogSource,
  IssueCatalogOverlay,
  CatalogIssue,
  IssueOpenRefusalCode,
  IssueOpenResult,
  IssuePreparation,
  IssueRouteProjection,
  ProjectOverview,
  ProjectIssueDetail,
  ProjectIssueDetailSource,
  ProjectIssueThreadHistory,
  ReferenceIdentity,
  TypedAnswer,
  WorkspaceGuardrail,
} from '@awos/protocol';
import {
  AGENT_IDS,
  createRequiredTransitionOverride,
  createTransitionEvaluation,
  isTrustedVisualEventKind,
  PINNED_CONTEXT_MAX_CHARS,
  RETAINED_FILE,
  RUN_CONTEXT_MAX_CHARS,
  WORKSPACE_FILE,
  WORKSPACE_LOCAL_FILE,
} from '@awos/protocol';
import type { HarnessConfig } from './config.js';
import { isNativeResumeNotFoundError, type WorkerAdapter, type AdapterContext, type WorkerTurnOptions } from './adapters/agent.js';
import { createWorkerAdapter, probeWorkerProfiles, registeredWorkerProfiles } from './adapters/registry.js';
import { isQwenResumeNotFoundError } from './adapters/qwen-code.js';
import { PermissionBridge } from './permission-bridge.js';
import {
  ThreadStore,
  type CanonicalThreadLog,
  type CompareAndAppendEntry,
  type ExpectedTransitionAttempt,
} from './store/thread-store.js';
import { ContextStore, applyPinnedContext, buildPinnedContext } from './store/context-store.js';
import { resolveWorkspace } from './workspace/resolve.js';
import { CORE_EXPECTATION_ITEM_IDS, CORE_EVALUATOR_PROFILE_IDS } from './workspace/manifest.js';
import { WorkspaceRoleSelectionStore } from './workspace/role-selection-store.js';
import { applyWorkspace, buildWorkspaceBlock } from './workspace/prompt.js';
import { WorkItemStore } from './work/store.js';
import { CatalogStore } from './work/catalog-store.js';
import {
  applyRetained,
  applyWorkItem,
  buildRetainedBlock,
  buildWorkItemBlock,
} from './work/prompt.js';
import {
  foldEvidence,
  foldAttestations,
  foldAnswers,
  foldHumanAttestationConflicts,
  foldTypedAnswerConflicts,
  foldExpectationSetConflicts,
  foldExpectationSets,
  foldExpectationSetHistory,
  foldOutcomes,
  foldRetained,
  foldTransitionEvaluationHistory,
  selectedForContext,
} from './work/ledger.js';
import { projectRunEvidence } from './work/runs.js';
import {
  RECOVERY_MAX_TRANSIENT_EVALUATOR_RETRIES,
  RecoveryConflictError,
  buildRecoveryWorkerContext,
  findRecoveryCycle,
  foldRecoveryCycles,
  hasValidHumanRecoveryAction,
  isTransientEvaluatorRefusal,
  recoveryPolicy,
  recoveryWorkerPrompt,
  sameTransitionFingerprint,
  transitionFingerprint,
} from './work/recovery.js';
import {
  buildIntegrationExpectationSet,
  buildGuardrailExpectationSet,
  candidateIdentity,
  evaluateGate,
  evaluateOwnedGuardedTransition,
  evaluateOwnedIntegrationTransition,
  explainGate,
  type GateDecision,
  type TransitionDecision,
} from './work/gate.js';
import { fetchIssue, parseIssueRef } from './work/github.js';
import { explainIssueRoute } from './work/issue-route-presentation.js';
import { projectIssueRoute } from './work/issue-route.js';
import { projectProjectOverview, type ProjectOverviewEntry } from './work/project-overview.js';
import { projectProjectIssueDetail } from './work/project-issue.js';
import { applyReplay, buildReplay, hasReplay, stripReplay } from './store/replay.js';
import { ArtifactWatcher } from './artifact-watcher.js';
import { contentHash } from './store/artifact-store.js';
import { snapshotWorkingTree, diffTrees, headTree, headCommit } from './util/git.js';
import type { Lane } from './util/worktree.js';
import { provisionLane, laneDiff, integrateLane, removeLane } from './util/worktree.js';
import { createLogger } from './util/logger.js';
import { workerEnvironment } from './util/spawn.js';

const log = createLogger('orchestrator');
const execAsync = promisify(exec);

/** A planning or integration evaluation lost its canonical log reservation. */
export class TransitionEvaluationConflictError extends Error {
  readonly conflict: TransitionEvaluationConflict;

  constructor(conflict: TransitionEvaluationConflict) {
    super(conflict.detail);
    this.name = 'TransitionEvaluationConflictError';
    this.conflict = conflict;
  }
}

function emptyAgentRecord<T>(factory: () => T): Record<AgentId, T> {
  return Object.fromEntries(AGENT_IDS.map((agent) => [agent, factory()])) as Record<AgentId, T>;
}

/** Pin every declaration that contributed to the effective integration/verify contract. */
function workspaceIntegrationSource(
  workspace: Extract<WorkspaceResolution, { status: 'ok' }>['workspace'],
  head: string | null,
): ReferenceIdentity {
  const relevantFiles = new Set<string>(
    [workspace.origins.integration, workspace.origins.verify].map((origin) =>
      origin === 'local' ? WORKSPACE_LOCAL_FILE : WORKSPACE_FILE,
    ),
  );
  const sources = workspace.sources.filter((source) => relevantFiles.has(source));
  if (sources.length === 0) {
    throw new Error('The effective integration and verification contract has no canonical source.');
  }
  const files = sources.map((source) => {
    const locator = resolvePath(workspace.root, source);
    const digest = contentHash(readFileSync(locator, 'utf8'));
    return {
      locator,
      contentDigest: digest,
      nativeRevision: `git:${head ?? 'none'};content:${digest}`,
    };
  });
  const contentDigest = contentHash(JSON.stringify({
    files,
    origins: {
      integration: workspace.origins.integration,
      verify: workspace.origins.verify,
    },
  }));
  return {
    sourceKind: 'workspace-declaration',
    locator: files.map((file) => file.locator).join('|'),
    nativeRevision:
      `git:${head ?? 'none'};origins:integration=${workspace.origins.integration},verify=${workspace.origins.verify}` +
      `;sources:${files.map((file) => file.contentDigest).join(',')}`,
    contentDigest,
  };
}

/** Keep an invalid/no-workspace attempt recordable without pretending a config source exists. */
function integrationFailureSource(cwd: string, candidate: WorkingState): ReferenceIdentity {
  const digest = candidate.tree ?? contentHash(`${candidate.commit ?? 'unidentified'}:${resolvePath(cwd)}`);
  return {
    sourceKind: 'external-digest',
    locator: resolvePath(cwd),
    nativeRevision: candidate.commit ?? `working-tree:${digest}`,
    contentDigest: digest,
  };
}

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

/** The last of a command's output, which is the part that says what went wrong. */
function tail(output: string, max = 400): string {
  const trimmed = output.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}

const RETAINED_KINDS = ['discovery', 'decision', 'constraint', 'question'] as const;

/** A retained kind an agent actually wrote, or null for anything else it put there. */
function asRetainedKind(value: unknown): RetainedKind | null {
  return (RETAINED_KINDS as readonly string[]).includes(value as string)
    ? (value as RetainedKind)
    : null;
}

function validTypedAnswerInput(value: unknown): value is TypedAnswer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const answer = value as { type?: unknown; value?: unknown };
  switch (answer.type) {
    case 'string':
    case 'choice':
      return typeof answer.value === 'string' && answer.value.trim() !== '';
    case 'number':
      return typeof answer.value === 'number' && Number.isFinite(answer.value);
    case 'boolean':
      return typeof answer.value === 'boolean';
    default:
      return false;
  }
}

function matchesHumanAuthorityCredential(
  expected: string | undefined,
  presented: string | undefined,
  ordinary: string | undefined,
): boolean {
  if (
    expected === undefined ||
    expected === '' ||
    presented === undefined ||
    presented === '' ||
    (ordinary !== undefined && presented === ordinary)
  ) return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const presentedBytes = Buffer.from(presented, 'utf8');
  return expectedBytes.length === presentedBytes.length && timingSafeEqual(expectedBytes, presentedBytes);
}

function sameTypedAnswerDefinition(
  existing: { expectationItemId: string; expectationSetId: string; actor: string; authority: string; answer: TypedAnswer; candidate: CandidateIdentity; evidenceIds: readonly string[] },
  input: { expectationItemId: string; expectationSetId: string; answer: TypedAnswer; candidate: CandidateIdentity; evidenceIds?: readonly string[] },
): boolean {
  return JSON.stringify({
    expectationItemId: existing.expectationItemId,
    expectationSetId: existing.expectationSetId,
    actor: existing.actor,
    authority: existing.authority,
    answer: existing.answer,
    candidate: existing.candidate,
    evidenceIds: existing.evidenceIds,
  }) === JSON.stringify({
    expectationItemId: input.expectationItemId,
    expectationSetId: input.expectationSetId,
    actor: 'user',
    authority: 'user',
    answer: input.answer,
    candidate: input.candidate,
    evidenceIds: input.evidenceIds ?? [],
  });
}

function sameHumanAttestationDefinition(
  existing: { expectationItemId: string; expectationSetId: string; actor: string; authority: string; statement: string; candidate: CandidateIdentity; evidenceIds: readonly string[] },
  input: { expectationItemId: string; expectationSetId: string; statement: string; candidate: CandidateIdentity; evidenceIds: readonly string[] },
): boolean {
  return JSON.stringify({
    expectationItemId: existing.expectationItemId,
    expectationSetId: existing.expectationSetId,
    actor: existing.actor,
    authority: existing.authority,
    statement: existing.statement,
    candidate: existing.candidate,
    evidenceIds: existing.evidenceIds,
  }) === JSON.stringify({
    expectationItemId: input.expectationItemId,
    expectationSetId: input.expectationSetId,
    actor: 'user',
    authority: 'user',
    statement: input.statement,
    candidate: input.candidate,
    evidenceIds: input.evidenceIds,
  });
}

function appliesToTransition(
  guardrail: WorkspaceGuardrail,
  sourceStepId: string,
  targetStepId: string,
): boolean {
  return 'step' in guardrail.attach
    ? guardrail.attach.step === targetStepId
    : guardrail.attach.from === sourceStepId && guardrail.attach.to === targetStepId;
}

/** How many files a patch touches, for a one-line report of what an integration moved. */
function countChangedFiles(patch: string): number {
  return patch.split('\n').filter((line) => line.startsWith('diff --git ')).length;
}

/** Give staged action bodies the event envelope evaluators need without persisting them yet. */
function previewEvent(
  canonical: CanonicalThreadLog,
  entry: CompareAndAppendEntry,
  index: number,
): HarnessEvent {
  const { turnId, ts, ...rest } = entry.body;
  return {
    ...rest,
    id: `staged:${canonical.threadId}:${canonical.revision}:${index}`,
    seq: canonical.revision + index + 1,
    threadId: canonical.threadId,
    agent: entry.agent,
    turnId: turnId ?? null,
    ts: ts ?? Date.now(),
  } as HarnessEvent;
}

function issueKey(workspaceRoot: string, repository: string, number: number): string {
  return `${workspaceRoot}\0${repository}\0${number}`;
}

function asCatalogIssue(item: WorkItem): CatalogIssue {
  return {
    number: item.source.number,
    url: item.source.url,
    title: item.snapshot.title,
    state: item.snapshot.state.toUpperCase() === 'OPEN' ? 'OPEN' : 'CLOSED',
    labels: [...item.snapshot.labels],
    assignees: [],
    updatedAt: item.snapshot.revision,
  };
}

function issueFromSnapshot(base: CatalogIssue, url: string, snapshot: WorkItem['snapshot']): CatalogIssue {
  return {
    ...base,
    url,
    title: snapshot.title,
    state: snapshot.state.toUpperCase() === 'OPEN' ? 'OPEN' : 'CLOSED',
    labels: [...snapshot.labels],
    updatedAt: snapshot.revision || base.updatedAt,
  };
}

function assigneeMetadata(catalogIssue: CatalogIssue | undefined, workItem: WorkItem | undefined): {
  known: boolean;
  source: 'catalog' | 'work-item-snapshot' | 'unavailable';
} {
  if (catalogIssue !== undefined) return { known: true, source: 'catalog' };
  if (workItem !== undefined) return { known: false, source: 'work-item-snapshot' };
  return { known: false, source: 'unavailable' };
}

function routeSummary(projection: IssueRouteProjection): IssuePreparation['route'] {
  return {
    routeId: projection.route.routeId,
    stepId: projection.route.stepId,
    action: projection.action.projectAction,
    role: projection.action.responsibleRole,
  };
}

function instructionInput(item: WorkItem): IssuePreparation['instruction'] {
  return {
    kind: 'github-issue',
    repository: item.source.repo,
    issueNumber: item.source.number,
    url: item.source.url,
    title: item.snapshot.title,
    revision: item.snapshot.revision,
  };
}

function issueRefusal(
  code: IssueOpenRefusalCode,
  message: string,
  route?: IssueRouteProjection,
  sourceError?: WorkSourceError,
): IssueOpenResult {
  return {
    ok: false,
    code,
    message,
    ...(route === undefined ? {} : { route }),
    ...(sourceError === undefined ? {} : { sourceError }),
  };
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

  readonly #adapters = new Map<AgentId, WorkerAdapter>();
  #permissionMode: PermissionMode = 'default';
  /**
   * Agents with a turn in flight, each mapped to the turn it is running.
   *
   * A map rather than a single field because parallel mode lifts the one-turn rule: with
   * a lane each, two agents cannot race on the filesystem, so the lock is per agent.
   */
  readonly #turns = new Map<AgentId, string | null>();
  /** Run identity for each in-flight turn that was explicitly started as work. */
  readonly #activeRuns = new Map<AgentId, string>();
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

  isRunActive(runId: string): boolean {
    return [...this.#activeRuns.values()].includes(runId);
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
    const agents = emptyAgentRecord(() => ({ status: 'idle', model: null as string | null }));
    for (const agent of AGENT_IDS) {
      const status = this.#agentStatus.get(agent);
      if (status) agents[agent] = status;
    }
    const lanes: Partial<Record<AgentId, string>> = {};
    for (const [agent, lane] of this.#lanes) lanes[agent] = lane.path;

    return {
      threadId: this.id,
      busyWith: this.busyWith,
      busy: this.#busy,
      runStates: projectRunEvidence(this.#store.events(this.id), (runId) => this.isRunActive(runId)),
      recovery: foldRecoveryCycles(this.#store.events(this.id), (runId) => this.isRunActive(runId)),
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
  async send(
    agent: AgentId,
    text: string,
    asRun = false,
    options: { runId?: string; recoveryContext?: RecoveryWorkerContext; keepRunActive?: boolean } = {},
  ): Promise<void> {
    const reservedRun = this.#activeRuns.get(agent);
    if (reservedRun !== undefined && reservedRun !== options.runId) {
      throw new Error(`${agent} already has an active correction run.`);
    }
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
    const userMessageSeq = this.#store.head(this.id);

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
    const buildPayload = (currentReplay: typeof replay): string => applyWorkspace(
      buildWorkspaceBlock(workspace),
      applyWorkItem(
        buildWorkItemBlock(item),
        applyRetained(
          buildRetainedBlock(selectedForContext(retained)),
          applyPinnedContext(pinned, applyReplay(currentReplay.preamble, text)),
        ),
      ),
    );
    let payload = buildPayload(replay);
    let adapter = this.#adapter(agent, cwd);

    // Recorded before dispatch, and before the run can fail, so a run that dies on the
    // first token still leaves behind what it was asked to do and what it was given.
    const runId = asRun && item ? options.runId ?? randomUUID() : null;
    if (options.runId !== undefined && runId === null) {
      throw new Error('A recovery correction run needs a linked work item.');
    }
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
        ...(options.recoveryContext === undefined
          ? {}
          : {
              transitionId: options.recoveryContext.transitionId,
              recoveryContext: options.recoveryContext,
            }),
      });
    }

    // Claim the turn synchronously, before any await, so a second send to the same agent
    // sees it busy and is rejected rather than racing in.
    this.#turns.set(agent, null);
    if (runId) this.#activeRuns.set(agent, runId);
    this.#onState();

    // Agents that don't report their own turn diff (Claude) get one synthesized from a
    // git snapshot taken around the turn. Ground truth from the working tree, never a
    // guess parsed from tool output. Codex reports its own, so we don't shadow it.
    let diffBaseline: Awaited<ReturnType<typeof snapshotWorkingTree>> = null;
    let failure: string | null = null;
    try {
      diffBaseline = adapter.capabilities.turnDiff ? null : await snapshotWorkingTree(cwd);
      let retriedStaleResume = false;
      for (;;) {
        try {
          const turnOptions: WorkerTurnOptions | undefined = options.recoveryContext === undefined
            ? undefined
            : { recoveryContext: options.recoveryContext };
          await adapter.sendTurn(payload, turnOptions);
          break;
        } catch (err) {
          if (!retriedStaleResume && (isQwenResumeNotFoundError(err) || isNativeResumeNotFoundError(err))) {
            retriedStaleResume = true;
            await this.#resetStaleNativeSession(agent);

            // Resetting the watermark makes the retry a full canonical replay. Exclude
            // this turn's already-recorded user event: the user prompt remains the one
            // direct payload argument, so it is not sent twice and is not recorded again.
            const retryReplay = buildReplay(
              this.#store.eventsSince(this.id, 0).filter((event) => event.seq < userMessageSeq),
              agent,
              {
                maxChars: this.#config.replayMaxChars,
                maxToolOutput: this.#config.replayMaxToolOutput,
                includeSameAgentHistory: true,
              },
            );
            payload = buildPayload(retryReplay);
            adapter = this.#adapter(agent, cwd);
            continue;
          }
          failure = err instanceof Error ? err.message : String(err);
          throw err;
        }
      }
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
      if (runId && options.keepRunActive !== true) this.#activeRuns.delete(agent);
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
    this.#store.update(this.id, { parallel: on, nativeSessions: {}, watermarks: emptyAgentRecord(() => 0) });
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
  async integrate(
    agent: AgentId,
    override: GateOverride | null = null,
  ): Promise<{ ok: boolean; detail: string }> {
    const summary = this.#store.get(this.id);
    if (!summary) throw new Error(`Unknown thread ${this.id}`);
    // Capture the revision before any asynchronous workspace inspection. The evaluation
    // CAS below must refuse if another process advances the canonical log meanwhile.
    const evaluationExpectedHead = this.#store.head(this.id);
    const evaluationInitialEvents = this.#store.events(this.id);

    const lane = this.#lanes.get(agent);
    if (!lane) throw new Error(`${agent} has no lane to integrate.`);
    if (this.#turns.has(agent)) {
      throw new Error(`${agent} is still working. Interrupt it before integrating its lane.`);
    }

    const workspace = this.#workspace(summary.cwd);
    // Only a directory with no declaration has an empty policy. A declaration that exists
    // but does not resolve has one the harness could not read, which is refused below
    // rather than reported as a project that asked for nothing.
    const integration =
      workspace.status === 'ok'
        ? workspace.workspace.integration
        : { requires: [], allowOverride: false };
    const verify = workspace.status === 'ok' ? workspace.workspace.verify : [];
    const invalidOverrideReason = override === null
      ? undefined
      : !integration.allowOverride
        ? 'This workspace does not permit overriding the integration gate. Set integration.allowOverride if it should.'
        : override.actor !== 'user'
          ? 'An integration override needs an authorized user.'
          : override.reason.trim() === ''
            ? 'An override has to say why. It is going into the record.'
            : undefined;

    const candidate = await this.#workingState(agent);
    let workspaceSource: ReferenceIdentity;
    let invalidSourceReason: string | undefined;
    if (workspace.status === 'ok') {
      try {
        workspaceSource = workspaceIntegrationSource(workspace.workspace, await headCommit(summary.cwd));
      } catch {
        workspaceSource = integrationFailureSource(summary.cwd, candidate);
        invalidSourceReason = 'The workspace integration source could not be pinned, so the transition was refused.';
      }
    } else if (workspace.status === 'invalid') {
      workspaceSource = integrationFailureSource(summary.cwd, candidate);
      invalidSourceReason =
        `The workspace declaration is invalid, so the integration gate it configures could not be read and the transition was refused. ${
          workspace.problems[0]?.message ?? ''
        }`.trim();
    } else {
      workspaceSource = integrationFailureSource(summary.cwd, candidate);
      invalidSourceReason = 'The workspace has no valid canonical integration source, so the transition was refused.';
    }
    const integrationGuardrails = workspace.status === 'ok'
      ? workspace.workspace.guardrails.filter((guardrail) =>
          'step' in guardrail.attach
            ? guardrail.attach.step === 'workspace'
            : guardrail.attach.from === 'lane' && guardrail.attach.to === 'workspace',
        )
      : [];
    const configuredResult = workspace.status === 'ok'
      ? buildGuardrailExpectationSet(integration, verify, workspaceSource, integrationGuardrails)
      : { expectationSet: buildIntegrationExpectationSet(integration, verify, workspaceSource), conflicts: [] as readonly string[] };
    const transitionPrefix = `${this.id}:lane.integration:${agent}:`;
    const transitionId = `${transitionPrefix}${configuredResult.expectationSet.expectationSetId}`;
    const initialHistory = foldTransitionEvaluationHistory(evaluationInitialEvents);
    const expectedAttempt = initialHistory.get(transitionId)?.at(-1)?.attempt ?? 0;
    const transitionOverride: TransitionOverride | null = invalidOverrideReason === undefined && override !== null
      ? {
          enforcement: 'required',
          permission: 'explicit',
          permissionGranted: true,
          actor: 'user',
          authorizedUserId: 'user',
          reason: override.reason,
        }
      : null;
    const persisted = this.#store.compareAndAppendBatch<TransitionDecision>(this.id, evaluationExpectedHead, {
      transitionId,
      expectedAttempt,
      build: (canonical) => {
        const currentEvents = canonical.events;
        const expectationSets = foldExpectationSets(currentEvents);
        const expectationConflicts = foldExpectationSetConflicts(currentEvents);
        const expectationHistory = foldExpectationSetHistory(currentEvents);
        const configuredSet = configuredResult.expectationSet;
        const expectationConflict = expectationConflicts.get(configuredSet.expectationSetId);
        const priorSet = [...expectationHistory]
          .filter((set) => set.scope?.sourceStepId === 'lane')
          .at(-1);
        const expectationSet: ExpectationSet = expectationSets.get(configuredSet.expectationSetId) ?? {
          ...configuredSet,
          ...(priorSet === undefined || priorSet.expectationSetId === configuredSet.expectationSetId
            ? {}
            : { supersedes: priorSet.expectationSetId }),
        };
        const history = foldTransitionEvaluationHistory(currentEvents);
        const previousAttempt = history.get(transitionId)?.at(-1);
        const latestTransition = [...history.values()]
          .flat()
          .filter((evaluation) => evaluation.transitionId.startsWith(transitionPrefix))
          .sort((left, right) => left.timestamp - right.timestamp)
          .at(-1);
        const evidence = foldEvidence(currentEvents);
        const gateDecision = evaluateGate({
          integration,
          verify,
          evidence,
          candidateTree: candidate.tree,
        });
        const attempt: TransitionAttempt = {
          transitionId,
          attempt: (previousAttempt?.attempt ?? 0) + 1,
          runId: this.#latestRun(agent)?.runId ?? null,
          actor: 'user',
          sourceStepId: 'lane',
          targetStepId: 'workspace',
          expectationSetId: expectationSet.expectationSetId,
          candidate: candidateIdentity(candidate.tree, candidate.commit),
          evidenceIds: gateDecision.requirements
            .map((requirement) => requirement.evidenceId)
            .filter((evidenceId): evidenceId is string => evidenceId !== null),
          supersedesTransitionId:
            latestTransition !== undefined && latestTransition.transitionId !== transitionId
              ? latestTransition.transitionId
              : null,
        };
        const invalidAttemptReason = expectationConflict !== undefined
          ? 'The pinned expectation set has conflicting immutable definitions and cannot be evaluated.'
          : configuredResult.conflicts.length > 0
            ? `The attached guardrails have conflicting definitions for: ${configuredResult.conflicts.join(', ')}.`
            : invalidSourceReason;
        const decision = this.#store.withTrustedThreadContext(this.id, () => evaluateOwnedIntegrationTransition({
          integration,
          verify,
          evidence,
          candidateTree: candidate.tree,
          attempt,
          expectationSet,
          timestamp: Date.now(),
          override: transitionOverride,
          ...(invalidOverrideReason === undefined ? {} : { invalidOverrideReason }),
          ...(invalidAttemptReason === undefined ? {} : { invalidAttemptReason }),
          guardrails: integrationGuardrails,
          events: currentEvents,
          producingWorkerProfileId: agent,
        }));
        const entries: CompareAndAppendEntry[] = [];
        if (!expectationSets.has(expectationSet.expectationSetId)) {
          entries.push({ agent: null, body: { kind: 'expectation.set.created', expectationSet } });
          if (priorSet !== undefined && priorSet.expectationSetId !== expectationSet.expectationSetId) {
            entries.push({
              agent: null,
              body: {
                kind: 'expectation.set.superseded',
                expectationSetId: priorSet.expectationSetId,
                supersededByExpectationSetId: expectationSet.expectationSetId,
                supersedesTransitionId: latestTransition?.transitionId ?? null,
              },
            });
          }
        }
        entries.push({
          agent,
          body: {
            kind: 'gate.evaluated',
            gate: 'lane.integration',
            allowed: decision.allowed,
            candidate,
            requirements: decision.requirements,
            override,
            evaluation: decision.evaluation,
            ts: decision.evaluation.timestamp,
          },
        });
        return { entries, value: decision };
      },
    });
    if (persisted === null) {
      this.#throwEvaluationConflict(transitionId, expectedAttempt, evaluationExpectedHead);
    }
    const decision = persisted.value;
    for (const event of persisted.events) this.#emit(event);
    this.#onState();

    if (invalidOverrideReason !== undefined) {
      this.#record(agent, {
        kind: 'lane.updated',
        status: 'refused',
        path: lane.path,
        detail: invalidOverrideReason,
      });
      this.#onState();
      // The invalid attempt is recorded, but preserve the existing request boundary and
      // error text for callers that used the old integration API.
      throw new Error(invalidOverrideReason);
    }

    if (!decision.allowed) {
      const detail = `integration is gated: ${
        decision.requirements.length === 0 && decision.refusal !== null
          ? decision.refusal.reason
          : explainGate(decision)
      }`;
      this.#record(agent, {
        kind: 'lane.updated',
        status: 'refused',
        path: lane.path,
        detail,
      });
      this.#onState();
      // Nothing has touched the user's directory at this point, and nothing will.
      return { ok: false, detail };
    }

    const result = await integrateLane(lane, summary.cwd, {
      expectedTree: candidate.tree,
      expectedRevision: candidate.commit,
    });
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
    return resolveWorkspace(cwd, {
      laneSetup: this.#config.laneSetup,
      expectationItemIds: CORE_EXPECTATION_ITEM_IDS,
      evaluatorProfileIds: CORE_EVALUATOR_PROFILE_IDS,
    });
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
    expectationSetId?: string | null;
    expectationItemId?: string | null;
  }): Promise<void> {
    const started = this.#runStarted(input.runId);
    if (!started) throw new Error(`No run ${input.runId} in this thread.`);

    const evidenceId = input.evidenceId ?? randomUUID();
    this.#record(null, {
      kind: 'evidence.recorded',
      evidenceId,
      runId: input.runId,
      workItemId: started.workItemId,
      evidenceKind: input.kind,
      ref: input.ref,
      summary: input.summary,
      state: await this.#workingState(started.agent),
      check: null,
      ...(input.expectationSetId === undefined ? {} : { expectationSetId: input.expectationSetId }),
      ...(input.expectationItemId === undefined ? {} : { expectationItemId: input.expectationItemId }),
    });
    this.#onState();
  }

  /** Record a typed user answer; worker messages and tool approvals never enter this path. */
  recordAnswer(input: {
    expectationItemId: string;
    expectationSetId: string;
    answer: TypedAnswer;
    candidate: CandidateIdentity;
    evidenceIds?: readonly string[];
    answerId?: string;
  }): void {
    const prepared = this.#prepareAnswerRecord(input);
    if (prepared.body === null) return;
    this.#record(null, prepared.body);
    this.#onState();
  }

  #prepareAnswerRecord(input: {
    expectationItemId: string;
    expectationSetId: string;
    answer: TypedAnswer;
    candidate: CandidateIdentity;
    evidenceIds?: readonly string[];
    answerId?: string;
  }): { answerId: string; body: AnswerRecordedBody | null } {
    if (input.expectationItemId.trim() === '' || input.expectationSetId.trim() === '') {
      throw new Error('A typed answer needs an expectation item and expectation set identity.');
    }
    if (input.answerId !== undefined && input.answerId.trim() === '') {
      throw new Error('A typed answer id must be non-empty when supplied.');
    }
    if (!validTypedAnswerInput(input.answer)) {
      throw new Error('A typed answer must use a supported non-prose value.');
    }
    const answerId = input.answerId ?? randomUUID();
    const events = this.#store.events(this.id);
    if (foldTypedAnswerConflicts(events).has(answerId)) {
      throw new Error('The typed answer id already has a conflicting immutable definition.');
    }
    const existing = foldAnswers(events).find((answer) => answer.answerId === answerId);
    if (existing !== undefined) {
      if (sameTypedAnswerDefinition(existing, input)) return { answerId, body: null };
      throw new Error('The typed answer id already has a conflicting immutable definition.');
    }
    const recordedAt = Date.now();
    return { answerId, body: {
      kind: 'answer.recorded',
      answerId,
      expectationItemId: input.expectationItemId,
      expectationSetId: input.expectationSetId,
      actor: 'user',
      authority: 'user',
      answer: input.answer,
      candidate: { ...input.candidate },
      evidenceIds: [...(input.evidenceIds ?? [])],
      recordedAt,
    } };
  }

  /** Record an explicit user attestation with its immutable transition identities. */
  recordAttestation(input: {
    expectationItemId: string;
    expectationSetId: string;
    statement: string;
    candidate: CandidateIdentity;
    evidenceIds: readonly string[];
    attestationId?: string;
  }): void {
    if (input.expectationItemId.trim() === '' || input.expectationSetId.trim() === '') {
      throw new Error('An attestation needs an expectation item and expectation set identity.');
    }
    if (input.attestationId !== undefined && input.attestationId.trim() === '') {
      throw new Error('An attestation id must be non-empty when supplied.');
    }
    if (input.statement.trim() === '') throw new Error('An attestation needs a non-empty statement.');
    const attestationId = input.attestationId ?? randomUUID();
    const events = this.#store.events(this.id);
    if (foldHumanAttestationConflicts(events).has(attestationId)) {
      throw new Error('The human attestation id already has a conflicting immutable definition.');
    }
    const existing = foldAttestations(events).find((attestation) => attestation.attestationId === attestationId);
    if (existing !== undefined) {
      if (sameHumanAttestationDefinition(existing, input)) return;
      throw new Error('The human attestation id already has a conflicting immutable definition.');
    }
    const recordedAt = Date.now();
    this.#record(null, {
      kind: 'attestation.recorded',
      attestationId,
      expectationItemId: input.expectationItemId,
      expectationSetId: input.expectationSetId,
      actor: 'user',
      authority: 'user',
      statement: input.statement,
      candidate: { ...input.candidate },
      evidenceIds: [...input.evidenceIds],
      recordedAt,
    });
    this.#onState();
  }

  /**
   * Run a check the workspace names, where the work actually is.
   *
   * In the agent's lane when it has one, because a check run against the user's directory
   * says nothing about content that is still in a worktree. The result is evidence like
   * any other — bound to the tree it ran against, which is what makes it possible to tell
   * later whether it is still about the same thing.
   *
   * A failure is recorded, not thrown. "The tests failed" is the answer to the question,
   * and losing it would leave the gate unable to say why it is refusing.
   */
  async runCheck(name: string, agent: AgentId): Promise<{ passed: boolean; detail: string }> {
    const summary = this.#store.get(this.id);
    if (!summary) throw new Error(`Unknown thread ${this.id}`);

    const workspace = this.#workspace(summary.cwd);
    if (workspace.status !== 'ok') {
      throw new Error('This directory is not a workspace, so it declares no checks to run.');
    }
    const command = workspace.workspace.verify.find((entry) => entry.name === name)?.command;
    if (command === undefined) {
      throw new Error(
        `No verification command called "${name}". The workspace declares: ${
          workspace.workspace.verify.map((entry) => entry.name).join(', ') || 'none'
        }.`,
      );
    }

    const cwd = this.#lanes.get(agent)?.path ?? summary.cwd;
    let passed = true;
    let exitCode: number | null = 0;
    let output = '';
    try {
      const result = await execAsync(command, {
        cwd,
        env: workerEnvironment(),
        timeout: this.#config.laneSetupTimeoutMs,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      });
      output = tail(String(result.stdout ?? ''));
    } catch (err) {
      passed = false;
      const failure = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      exitCode = typeof failure.code === 'number' ? failure.code : null;
      output = tail(String(failure.stderr || failure.stdout || failure.message || ''));
    }

    // Captured after the command, not before. The evidence has to name the content that
    // would actually be integrated, and a check that writes tracked files has changed that
    // content by running — recording the tree it started from would produce evidence that
    // is stale the moment it is written. Files git ignores never enter the hash at all, so
    // for the ordinary case of a test suite dropping build output this changes nothing.
    const state = await this.#workingState(agent);
    const detail = `${passed ? 'passed' : 'failed'}${exitCode === null ? '' : ` (exit ${exitCode})`}`;
    const run = this.#latestRun(agent);
    this.#record(null, {
      kind: 'evidence.recorded',
      evidenceId: randomUUID(),
      // Linked to the run and the item when there are any, and standing on its own when
      // there are not: a lane can be verified before anyone has filed an issue for it.
      runId: run?.runId ?? null,
      workItemId: run?.workItemId ?? this.workItem()?.id ?? null,
      evidenceKind: 'command',
      ref: { eventId: null, url: null, label: command },
      summary: output === '' ? detail : `${detail} — ${output}`,
      state,
      check: { name, passed, exitCode },
    });
    this.#onState();
    return { passed, detail };
  }

  /** Everything this thread has recorded as evidence. */
  evidence(): EvidenceItem[] {
    return foldEvidence(this.#store.events(this.id));
  }

  /**
   * What the gate would decide about an agent's lane right now.
   *
   * Read-only, and it reaches the verdict the integration itself would, so the panel
   * cannot show one answer while the core acts on another. That includes the two cases
   * where the policy cannot be read at all: an empty requirement list then means the
   * harness never saw the gate, not that the project asked for nothing, and reporting it
   * as satisfied would put a green light in front of a refusal.
   */
  async gate(
    agent: AgentId,
  ): Promise<GateDecision & { candidate: WorkingState; refusalReason: string | null }> {
    const summary = this.#store.get(this.id);
    if (!summary) throw new Error(`Unknown thread ${this.id}`);
    const workspace = this.#workspace(summary.cwd);
    const integration =
      workspace.status === 'ok'
        ? workspace.workspace.integration
        : { requires: [], allowOverride: false };
    const verify = workspace.status === 'ok' ? workspace.workspace.verify : [];
    // The wording integrate() refuses with, so the preview and the refusal that follows it
    // say the same thing. An unreadable declaration names its first problem; a missing one
    // has no canonical source to pin.
    const refusalReason =
      workspace.status === 'invalid'
        ? `The workspace declaration is invalid, so the integration gate it configures could not be read and the transition was refused. ${
            workspace.problems[0]?.message ?? ''
          }`.trim()
        : workspace.status === 'none'
          ? 'The workspace has no valid canonical integration source, so the transition was refused.'
          : null;

    const candidate = await this.#workingState(agent);
    const decision = evaluateGate({
      integration,
      verify,
      evidence: this.evidence(),
      candidateTree: candidate.tree,
    });
    return {
      ...decision,
      allowed: refusalReason === null && decision.allowed,
      refusalReason,
      candidate,
    };
  }

  /** Evaluate a planning edge from the recorded human answer/attestation facts. */
  async evaluatePlanningTransition(input: {
    sourceStepId: string;
    targetStepId: string;
    candidate: CandidateIdentity;
    transitionId?: string;
    expectedAttempt?: number;
    expectedHead?: number;
    override?: TransitionOverride | null;
    runId?: string | null;
    supersedesTransitionId?: string | null;
    recoveryCycleId?: string | null;
    /** Recovery actions are staged here and committed with their resulting evaluation. */
    prelude?: (canonical: CanonicalThreadLog) => readonly CompareAndAppendEntry[];
  }): Promise<TransitionDecision> {
    const summary = this.#store.get(this.id);
    if (!summary) throw new Error(`Unknown thread ${this.id}`);
    // Hold the caller's observed revision across all asynchronous workspace reads. The
    // evaluation CAS will reject any log change rather than evaluating cached history.
    const evaluationExpectedHead = this.#store.head(this.id);
    const evaluationInitialEvents = this.#store.events(this.id);
    if (input.sourceStepId.trim() === '' || input.targetStepId.trim() === '') {
      throw new Error('A planning transition needs source and target steps.');
    }

    // Preserve the optimistic pre-CAS boundary even for an undeclared workspace whose
    // source inspection does not otherwise await external work.
    await Promise.resolve();
    const workspace = this.#workspace(summary.cwd);
    let sourceFailureReason: string | undefined;
    let source: ReferenceIdentity;
    if (workspace.status === 'ok') {
      try {
        source = workspaceIntegrationSource(workspace.workspace, await headCommit(summary.cwd));
      } catch {
        source = integrationFailureSource(summary.cwd, {
          commit: input.candidate.revision,
          tree: input.candidate.digest,
          dirty: false,
        });
        sourceFailureReason = 'The workspace source could not be pinned, so the planning transition was refused.';
      }
    } else {
      source = integrationFailureSource(summary.cwd, {
        commit: input.candidate.revision,
        tree: input.candidate.digest,
        dirty: false,
      });
    }
    const guardrails = workspace.status === 'ok'
      ? workspace.workspace.guardrails.filter((guardrail) => appliesToTransition(
          guardrail,
          input.sourceStepId,
          input.targetStepId,
        ))
      : [];
    const built = buildGuardrailExpectationSet(
      { requires: [], allowOverride: false },
      workspace.status === 'ok' ? workspace.workspace.verify : [],
      source,
      guardrails,
      { workItemId: summary.workItemId, sourceStepId: input.sourceStepId, targetStepId: input.targetStepId },
    );
    const transitionId = input.transitionId ?? `${this.id}:planning:${input.sourceStepId}:${input.targetStepId}`;
    const initialHistory = foldTransitionEvaluationHistory(evaluationInitialEvents);
    const expectedAttempt = input.expectedAttempt ?? initialHistory.get(transitionId)?.at(-1)?.attempt ?? 0;
    const expectedHead = input.expectedHead ?? evaluationExpectedHead;
    const persisted = this.#store.compareAndAppendBatch<TransitionDecision>(this.id, expectedHead, {
      transitionId,
      expectedAttempt,
      build: (canonical) => {
        const preludeEntries = input.prelude?.(canonical) ?? [];
        const currentEvents = [
          ...canonical.events,
          ...preludeEntries.map((entry, index) => previewEvent(canonical, entry, index)),
        ];
        const foldedSets = foldExpectationSets(currentEvents);
        const conflicts = foldExpectationSetConflicts(currentEvents);
        const prior = [...foldedSets.values()]
          .filter((set) => set.scope?.sourceStepId === input.sourceStepId && set.scope?.targetStepId === input.targetStepId)
          .at(-1);
        const configuredSet = foldedSets.has(built.expectationSet.expectationSetId)
          ? foldedSets.get(built.expectationSet.expectationSetId)!
          : {
              ...built.expectationSet,
              ...(prior === undefined ? {} : { supersedes: prior.expectationSetId }),
            };
        const history = foldTransitionEvaluationHistory(currentEvents);
        const previous = history.get(transitionId)?.at(-1);
        if (input.recoveryCycleId !== undefined && input.recoveryCycleId !== null) {
          if (previous !== undefined && configuredSet.expectationSetId !== previous.expectationSetId) {
            throw new Error('The pinned recovery policy changed; repin before evaluating this transition again.');
          }
          const recovery = findRecoveryCycle(
            currentEvents,
            { cycleId: input.recoveryCycleId },
            (runId) => this.isRunActive(runId),
          );
          if (recovery?.cancelled) throw new Error('The recovery cycle was cancelled before its evaluation was appended.');
        }
        const attempt: TransitionAttempt = {
          transitionId,
          attempt: (previous?.attempt ?? 0) + 1,
          runId: input.runId ?? null,
          actor: 'user',
          sourceStepId: input.sourceStepId,
          targetStepId: input.targetStepId,
          expectationSetId: configuredSet.expectationSetId,
          candidate: { ...input.candidate },
          evidenceIds: [],
          supersedesTransitionId: input.supersedesTransitionId ?? previous?.transitionId ?? null,
        };
        const evaluation = this.#store.withTrustedThreadContext(this.id, () => evaluateOwnedGuardedTransition({
          attempt,
          expectationSet: configuredSet,
          timestamp: Date.now(),
          override: input.override ?? null,
          guardrails,
          verify: workspace.status === 'ok' ? workspace.workspace.verify : [],
          evidence: foldEvidence(currentEvents),
          events: currentEvents,
        }));
        const invalidReason = workspace.status !== 'ok'
          ? 'The workspace declaration is unavailable, so the planning transition was refused.'
          : sourceFailureReason ?? (
              conflicts.has(configuredSet.expectationSetId)
                ? 'The pinned expectation set has conflicting immutable definitions and cannot be evaluated.'
                : built.conflicts.length > 0
                  ? `The attached guardrails have conflicting definitions for: ${built.conflicts.join(', ')}.`
                  : undefined
            );
        const finalEvaluation = invalidReason === undefined
          ? evaluation
          : createTransitionEvaluation({
              ...evaluation,
              verdict: 'failed',
              refusal: {
                unmetRequirementIds: configuredSet.items.map((item) => item.id),
                reason: invalidReason,
                required: { kind: 'evidence', evidence: { requirementIds: configuredSet.items.map((item) => item.id), description: 'Provide a valid workspace policy and immutable expectation set.' } },
                responsibleActor: 'user',
                nextAction: 'escalate',
                retryable: true,
              },
              override: null,
            });
        const entries: CompareAndAppendEntry[] = [...preludeEntries];
        if (!foldedSets.has(configuredSet.expectationSetId)) {
          entries.push({ agent: null, body: { kind: 'expectation.set.created', expectationSet: configuredSet } });
          if (prior !== undefined && prior.expectationSetId !== configuredSet.expectationSetId) {
            entries.push({
              agent: null,
              body: {
                kind: 'expectation.set.superseded',
                expectationSetId: prior.expectationSetId,
                supersededByExpectationSetId: configuredSet.expectationSetId,
                supersedesTransitionId: null,
              },
            });
          }
        }
        entries.push({ agent: null, body: { kind: 'transition.evaluated', evaluation: finalEvaluation } });
        return {
          entries,
          value: {
            allowed: finalEvaluation.verdict === 'passed',
            requirements: [],
            evaluation: finalEvaluation,
            verdict: finalEvaluation.verdict,
            refusal: finalEvaluation.refusal,
          },
        };
      },
    });
    if (persisted === null) {
      this.#throwEvaluationConflict(transitionId, expectedAttempt, expectedHead);
    }
    for (const event of persisted.events) this.#emit(event);
    this.#onState();
    return persisted.value;
  }

  /** Read recovery state from the event log; no mutable recovery register is consulted. */
  getRecovery(input: { transitionId?: string; cycleId?: string }): RecoveryCycle | null {
    return findRecoveryCycle(
      this.#store.events(this.id),
      input,
      (runId) => this.isRunActive(runId),
    );
  }

  /**
   * Start the next bounded correction, or return the durable wait/escalation state.
   *
   * The only event that reserves a correction is a compare-and-append against the current
   * log head. This keeps two requests from starting two workers for one refusal even when
   * both requests performed an asynchronous worker probe first.
   */
  async startRecovery(input: {
    transitionId: string;
    expectedAttempt: number;
    expectedHead?: number;
    agent: AgentId;
    cycleId?: string;
  }): Promise<RecoveryCycle | null> {
    if (input.transitionId.trim() === '' || !Number.isInteger(input.expectedAttempt) || input.expectedAttempt < 1) {
      throw new Error('A recovery start needs a transition id and positive expected attempt.');
    }

    const summary = this.#store.get(this.id);
    if (!summary) throw new Error(`Unknown thread ${this.id}`);
    const currentHead = this.#store.refresh(this.id);
    if (input.expectedHead !== undefined && input.expectedHead !== currentHead) {
      throw new Error(
        `The recovery start is stale; expected log head ${input.expectedHead}, found ${currentHead}.`,
      );
    }
    let cycle = this.getRecovery({ transitionId: input.transitionId, cycleId: input.cycleId });
    const transitionCycle = this.getRecovery({ transitionId: input.transitionId });
    if (cycle === null && transitionCycle !== null) {
      throw new Error(
        `Transition ${input.transitionId} already has recovery cycle ${transitionCycle.cycleId}; ` +
          'a second cycle cannot be created for the same refusal attempt.',
      );
    }
    let events = this.#store.events(this.id);
    let history = foldTransitionEvaluationHistory(events).get(input.transitionId) ?? [];
    let latest = history.at(-1) ?? null;
    if (latest === null) throw new Error(`No evaluated transition ${input.transitionId} exists in this thread.`);
    if (latest.attempt !== input.expectedAttempt) {
      throw new Error(
        `The transition changed before recovery could start; expected attempt ${input.expectedAttempt}, found ${latest.attempt}.`,
      );
    }

    const workspace = this.#workspace(summary.cwd);
    const guardrails = workspace.status === 'ok'
      ? workspace.workspace.guardrails.filter((guardrail) => appliesToTransition(
          guardrail,
          latest!.sourceStepId,
          latest!.targetStepId,
        ))
      : [];
    if (cycle === null) {
      const policy = recoveryPolicy(guardrails, latest);
      const initialFingerprint = transitionFingerprint(latest, this.evidence());
      const cycleId = input.cycleId ?? randomUUID();
      const expectedHead = this.#store.head(this.id);
      const started = this.#compareRecord(expectedHead, null, {
        kind: 'recovery.cycle.started',
        cycleId,
        transitionId: latest.transitionId,
        refusalAttempt: latest.attempt,
        expectationSetId: latest.expectationSetId,
        sourceStepId: latest.sourceStepId,
        targetStepId: latest.targetStepId,
        maxRuns: policy.maxRuns,
        maxEvaluations: policy.maxEvaluations,
        onExhausted: policy.onExhausted,
        guardrailIds: [...policy.guardrailIds],
        initialFingerprint,
      }, { transitionId: latest.transitionId, attempt: latest.attempt });
      if (started === null) {
        // The winner may have created the cycle or a human may have appended a new
        // evaluation. Re-read and never manufacture a second cycle in either case.
        return this.getRecovery({ transitionId: input.transitionId, cycleId: input.cycleId });
      }
      cycle = this.getRecovery({ transitionId: input.transitionId, cycleId });
      if (cycle === null) throw new Error('The recovery cycle could not be replayed after it was appended.');
    }

    if (cycle.cancelled) return cycle;
    if (cycle.activeCorrection !== null) return cycle;

    // Re-read after cycle creation. The append-only projection, not the values captured
    // before the compare-and-append, decides what this request is allowed to do.
    events = this.#store.events(this.id);
    history = foldTransitionEvaluationHistory(events).get(input.transitionId) ?? [];
    latest = history.at(-1) ?? null;
    if (latest === null) return this.getRecovery({ cycleId: cycle.cycleId });
    if (latest.attempt !== input.expectedAttempt) {
      throw new Error(
        `The transition changed while recovery was starting; expected attempt ${input.expectedAttempt}, found ${latest.attempt}.`,
      );
    }

    if (latest.verdict === 'passed') return this.getRecovery({ cycleId: cycle.cycleId });
    if (latest.refusal === null) throw new Error('A refused recovery evaluation must include its structured blocker.');

    if (latest.verdict === 'blocked' || latest.verdict === 'failed') {
      this.#escalateRecovery(cycle, latest, latest.verdict === 'blocked' ? 'absolute' : 'invalid');
      return this.getRecovery({ cycleId: cycle.cycleId });
    }
    if (latest.verdict === 'waiting-for-human') {
      this.#waitForRecovery(cycle, latest, 'human-action', latest.refusal.reason);
      return this.getRecovery({ cycleId: cycle.cycleId });
    }
    if (isTransientEvaluatorRefusal(latest)) {
      this.#waitForRecovery(cycle, latest, 'transient-evaluator', latest.refusal.reason);
      return this.getRecovery({ cycleId: cycle.cycleId });
    }

    const fingerprint = transitionFingerprint(latest, this.evidence());
    const previousCorrection = cycle.correctionRuns.at(-1);
    if (previousCorrection !== undefined && sameTransitionFingerprint(previousCorrection.fingerprint, fingerprint)) {
      this.#escalateRecovery(cycle, latest, 'unchanged-candidate');
      return this.getRecovery({ cycleId: cycle.cycleId });
    }
    if (cycle.correctionsUsed >= cycle.maxRuns || cycle.evaluationsUsed >= cycle.maxEvaluations) {
      this.#escalateRecovery(cycle, latest, 'exhausted');
      return this.getRecovery({ cycleId: cycle.cycleId });
    }
    if (this.workItem() === null) {
      // A correction is a work run, not an untracked conversational turn. Do not reserve
      // a correction slot when the thread has no durable work item to link to.
      this.#escalateRecovery(cycle, latest, 'invalid');
      return this.getRecovery({ cycleId: cycle.cycleId });
    }

    let unavailable: { detail: string } | null;
    try {
      unavailable = await this.#correctionWorkerAvailability(workspace, latest, input.agent);
    } catch (error) {
      unavailable = {
        detail: `Worker profile ${input.agent} could not be checked: ${error instanceof Error ? error.message : String(error)}.`,
      };
    }
    if (unavailable !== null) {
      this.#waitForRecovery(cycle, latest, 'worker-unavailable', unavailable.detail, input.agent);
      return this.getRecovery({ cycleId: cycle.cycleId });
    }

    // The probe was asynchronous. Recheck the exact attempt and active reservation before
    // consuming a correction slot.
    const current = this.getRecovery({ cycleId: cycle.cycleId });
    if (current?.activeCorrection !== null && current?.activeCorrection !== undefined) return current;
    const latestAfterProbe = (foldTransitionEvaluationHistory(this.#store.events(this.id)).get(input.transitionId) ?? []).at(-1);
    if (latestAfterProbe === undefined || latestAfterProbe.attempt !== input.expectedAttempt) {
      throw new Error('The transition changed while the worker availability was being checked.');
    }
    if (current?.actions.some((action) => action.attempt >= latestAfterProbe.attempt)) {
      return current;
    }
    const attempts = foldTransitionEvaluationHistory(this.#store.events(this.id)).get(input.transitionId) ?? [];
    const actionHistory = current?.actions ?? [];
    const correctionIndex = (current?.correctionsUsed ?? 0) + 1;
    const context = buildRecoveryWorkerContext({
      cycleId: cycle.cycleId,
      correctionIndex,
      refusalAttempt: cycle.refusalAttempt,
      evaluation: latestAfterProbe,
      attempts,
      actions: actionHistory,
      fingerprint: transitionFingerprint(latestAfterProbe, this.evidence()),
    });
    const correctionPrompt = recoveryWorkerPrompt(context);
    const runId = randomUUID();
    // Reuse the live-run map as the runtime reservation. It is cleared by send's normal
    // finally path and is not persisted or treated as recovery truth after restart.
    this.#activeRuns.set(input.agent, runId);
    const reserved = this.#compareRecord(this.#store.head(this.id), input.agent, {
      kind: 'recovery.correction.started',
      cycleId: cycle.cycleId,
      transitionId: latestAfterProbe.transitionId,
      refusalAttempt: cycle.refusalAttempt,
      correctionIndex,
      runId,
      workerProfileId: input.agent,
      fingerprint: context.fingerprint,
      context,
    }, { transitionId: latestAfterProbe.transitionId, attempt: latestAfterProbe.attempt });
    if (reserved === null) {
      this.#activeRuns.delete(input.agent);
      return this.getRecovery({ cycleId: cycle.cycleId });
    }

    try {
      await this.send(input.agent, correctionPrompt, true, {
        runId,
        recoveryContext: context,
        keepRunActive: true,
      });
    } catch (error) {
      this.#activeRuns.delete(input.agent);
      log.warn('recovery worker failed', {
        threadId: this.id,
        cycleId: cycle.cycleId,
        runId,
        message: error instanceof Error ? error.message : String(error),
      });
      return this.getRecovery({ cycleId: cycle.cycleId });
    }

    // A human may cancel or repin while the worker turn is in flight. The completed
    // worker must not append an evaluation to that superseded cycle.
    const afterCorrection = this.getRecovery({ cycleId: cycle.cycleId });
    if (afterCorrection?.cancelled) return afterCorrection;

    // A completed correction is evaluated against the current candidate before another
    // correction may be reserved. A concurrent typed human action wins the expected-attempt
    // check and leaves the cycle waiting instead of silently overwriting it.
    const afterState = await this.#workingState(input.agent);
    const beforeEvaluation = this.getRecovery({ cycleId: cycle.cycleId });
    if (beforeEvaluation?.cancelled) return beforeEvaluation;
    const nextCandidate = latestAfterProbe.candidate.kind === 'working-tree'
      ? candidateIdentity(afterState.tree, afterState.commit)
      : latestAfterProbe.candidate;
    let decision: TransitionDecision;
    // `send` was asked to retain the live-run reservation through this post-turn
    // evaluation, so a second start cannot race the correction between the worker turn
    // and its evaluation append.
    try {
      decision = await this.evaluatePlanningTransition({
        sourceStepId: latestAfterProbe.sourceStepId,
        targetStepId: latestAfterProbe.targetStepId,
        candidate: nextCandidate,
        transitionId: latestAfterProbe.transitionId,
        expectedAttempt: latestAfterProbe.attempt,
        runId,
        recoveryCycleId: cycle.cycleId,
      });
    } catch (error) {
      if (error instanceof TransitionEvaluationConflictError) throw error;
      log.warn('recovery evaluation was superseded', {
        threadId: this.id,
        cycleId: cycle.cycleId,
        message: error instanceof Error ? error.message : String(error),
      });
      return this.getRecovery({ cycleId: cycle.cycleId });
    } finally {
      if (this.#activeRuns.get(input.agent) === runId) this.#activeRuns.delete(input.agent);
    }

    if (decision.evaluation.verdict === 'retry' && decision.evaluation.refusal !== null) {
      return this.startRecovery({
        transitionId: decision.evaluation.transitionId,
        expectedAttempt: decision.evaluation.attempt,
        agent: input.agent,
        cycleId: cycle.cycleId,
      });
    }
    return this.getRecovery({ cycleId: cycle.cycleId });
  }

  /** Apply one typed human action and re-evaluate the same transition where appropriate. */
  async applyRecoveryAction(input: RecoveryActionRequest): Promise<RecoveryCycle | null> {
    this.#store.refresh(this.id);
    const cycle = this.getRecovery({ cycleId: input.cycleId });
    if (cycle === null) throw new Error(`No recovery cycle ${input.cycleId} exists in this thread.`);
    // Check the displayed version before any terminal-state or payload branch. A stale
    // action against a cycle that has since been cancelled is still a typed conflict.
    this.#assertRecoveryActionFresh(cycle, input);
    if (cycle.cancelled) throw new Error('This recovery cycle is cancelled; repin before acting on it.');
    const latest = cycle.latestEvaluation;
    if (latest === null || latest.refusal === null) throw new Error('This recovery cycle has no current refusal to act on.');
    if (
      cycle.activeCorrection !== null &&
      input.kind !== 'cancel' &&
      input.kind !== 'repin'
    ) {
      throw new Error('A recovery worker is active; wait for it to finish or cancel/repin the cycle first.');
    }
    if (
      cycle.actions.some((action) => action.attempt >= latest.attempt) &&
      input.kind !== 'cancel' &&
      input.kind !== 'repin'
    ) {
      throw new Error('A recovery action for the current attempt is already being evaluated.');
    }

    const actionBase = {
      actionId: randomUUID(),
      cycleId: cycle.cycleId,
      transitionId: cycle.transitionId,
      attempt: latest.attempt,
      expectedHead: input.expectedHead,
      actor: 'user' as const,
      authority: 'user' as const,
    };

    switch (input.kind) {
      case 'cancel': {
        this.#appendRecoveryAction(cycle, input, {
          ...actionBase,
          kind: 'cancel',
          candidate: { ...latest.candidate },
          evidenceIds: [...latest.evidenceIds],
          reason: input.reason?.trim() || null,
        }, [{
          agent: null,
          body: {
            kind: 'recovery.cycle.cancelled',
            cycleId: cycle.cycleId,
            transitionId: cycle.transitionId,
            reason: 'user',
            supersededByTransitionId: null,
          },
        }]);
        return this.getRecovery({ cycleId: cycle.cycleId });
      }

      case 'repin': {
        if (input.sourceStepId.trim() === '' || input.targetStepId.trim() === '') {
          throw new Error('A repin needs source and target step identities.');
        }
        if (
          !input.candidate.pinned ||
          input.candidate.id.trim() === '' ||
          (input.candidate.revision === null && input.candidate.digest === null)
        ) {
          throw new Error('A repin needs a new pinned candidate/reference identity.');
        }
        if (sameCandidateIdentity(input.candidate, latest.candidate)) {
          throw new Error('Repin needs a new immutable candidate/reference identity.');
        }
        const transitionId = repinTransitionId(this.id, cycle, input.sourceStepId, input.targetStepId, input.candidate);
        if (transitionId === cycle.transitionId) {
          throw new Error('The generated repin identity must differ from the superseded transition.');
        }
        const existingRepin = foldTransitionEvaluationHistory(this.#store.events(this.id)).get(transitionId);
        if (existingRepin !== undefined) {
          throw new Error(`The generated repin transition identity ${transitionId} already exists.`);
        }
        const action: RecoveryAction = {
          ...actionBase,
          kind: 'repin',
          candidate: { ...input.candidate },
          evidenceIds: [],
          reason: 'The human repinned the candidate and started a new transition identity.',
          supersededByTransitionId: transitionId,
        };
        await this.#evaluateRecoveryAction(cycle, input, action, [{
          agent: null,
          body: {
            kind: 'recovery.cycle.cancelled',
            cycleId: cycle.cycleId,
            transitionId: cycle.transitionId,
            reason: 'repinned',
            supersededByTransitionId: transitionId,
          },
        }], {
          sourceStepId: input.sourceStepId,
          targetStepId: input.targetStepId,
          candidate: { ...input.candidate },
          transitionId,
          expectedAttempt: 0,
          supersedesTransitionId: cycle.transitionId,
        });
        return this.getRecovery({ transitionId });
      }

      case 'answer': {
        if (
          latest.refusal.required.kind !== 'structured-answer' ||
          latest.refusal.required.answer.questionId !== input.questionId ||
          input.expectationItemId !== latest.refusal.required.answer.questionId ||
          input.expectationSetId !== latest.expectationSetId ||
          !sameCandidateIdentity(input.candidate, latest.candidate)
        ) {
          throw new Error('The typed answer does not match the current structured human blocker.');
        }
        const answerEvidenceIds = input.evidenceIds ?? [];
        const knownEvidence = new Map(this.evidence().map((item) => [item.id, item]));
        const answerEvidence = answerEvidenceIds.map((id) => knownEvidence.get(id));
        if (answerEvidence.some((item) => item === undefined)) {
          throw new Error('A typed answer referenced an unknown evidence id.');
        }
        if (answerEvidence.some((item) => item !== undefined && !sameCandidateIdentity(input.candidate, candidateFromEvidenceItem(item)))) {
          throw new Error('Typed answer evidence must be pinned to the answered candidate.');
        }
        const answerId = input.answerId ?? randomUUID();
        const preparedAnswer = this.#prepareAnswerRecord({
          expectationItemId: input.expectationItemId,
          expectationSetId: input.expectationSetId,
          answer: input.answer,
          candidate: input.candidate,
          evidenceIds: input.evidenceIds,
          answerId,
        });
        const action: RecoveryAction = {
          ...actionBase,
          kind: 'answer',
          candidate: { ...input.candidate },
          evidenceIds: [...answerEvidenceIds],
          questionId: input.questionId,
          answerId,
          answer: input.answer,
        };
        await this.#evaluateRecoveryAction(cycle, input, action, preparedAnswer.body === null ? [] : [{ agent: null, body: preparedAnswer.body }], {
          sourceStepId: latest.sourceStepId,
          targetStepId: latest.targetStepId,
          candidate: { ...input.candidate },
          transitionId: cycle.transitionId,
          expectedAttempt: latest.attempt,
          recoveryCycleId: cycle.cycleId,
        });
        return this.getRecovery({ cycleId: cycle.cycleId });
      }

      case 'evidence': {
        if (input.evidenceIds.length === 0) throw new Error('A recovery evidence action needs at least one evidence id.');
        const evidence = this.evidence();
        const known = new Map(evidence.map((item) => [item.id, item]));
        const selected = input.evidenceIds.map((id) => known.get(id));
        if (selected.some((item) => item === undefined)) throw new Error('A recovery evidence action referenced an unknown evidence id.');
        if (selected.some((item) => item !== undefined && !sameCandidateIdentity(input.candidate, candidateFromEvidenceItem(item)))) {
          throw new Error('Recovery evidence must be pinned to the candidate it claims to support.');
        }
        const action: RecoveryAction = {
          ...actionBase,
          kind: 'evidence',
          candidate: { ...input.candidate },
          evidenceIds: [...input.evidenceIds],
        };
        await this.#evaluateRecoveryAction(cycle, input, action, [], {
          sourceStepId: latest.sourceStepId,
          targetStepId: latest.targetStepId,
          candidate: { ...input.candidate },
          transitionId: cycle.transitionId,
          expectedAttempt: latest.attempt,
          recoveryCycleId: cycle.cycleId,
        });
        return this.getRecovery({ cycleId: cycle.cycleId });
      }

      case 'override': {
        if (input.authorizedUserId.trim() === '' || input.reason.trim() === '') {
          throw new Error('A recovery override needs an authorized user and a non-empty reason.');
        }
        const override = createRequiredTransitionOverride({
          permissionGranted: true,
          authorizedUserId: input.authorizedUserId,
          reason: input.reason,
        });
        const action: RecoveryAction = {
          ...actionBase,
          kind: 'override',
          candidate: { ...latest.candidate },
          evidenceIds: [...latest.evidenceIds],
          authorizedUserId: input.authorizedUserId,
          reason: input.reason,
        };
        await this.#evaluateRecoveryAction(cycle, input, action, [], {
          sourceStepId: latest.sourceStepId,
          targetStepId: latest.targetStepId,
          candidate: { ...latest.candidate },
          transitionId: cycle.transitionId,
          expectedAttempt: latest.attempt,
          override,
          recoveryCycleId: cycle.cycleId,
        });
        return this.getRecovery({ cycleId: cycle.cycleId });
      }

      case 'retry-evaluator': {
        if (!isTransientEvaluatorRefusal(latest)) {
          throw new Error('This refusal is not a transient evaluator failure.');
        }
        if (cycle.transientEvaluatorRetries >= RECOVERY_MAX_TRANSIENT_EVALUATOR_RETRIES) {
          throw new Error('Transient evaluator retries are exhausted; the cycle remains waiting for a human.');
        }
        if (input.expectedAttempt !== latest.attempt) {
          throw new Error(
            `The transition changed before the evaluator retry; expected attempt ${input.expectedAttempt}, found ${latest.attempt}.`,
          );
        }
        const action: RecoveryAction = {
          ...actionBase,
          kind: 'retry-evaluator',
          candidate: { ...latest.candidate },
          evidenceIds: [...latest.evidenceIds],
        };
        await this.#evaluateRecoveryAction(cycle, input, action, [], {
          sourceStepId: latest.sourceStepId,
          targetStepId: latest.targetStepId,
          candidate: { ...latest.candidate },
          transitionId: cycle.transitionId,
          expectedAttempt: input.expectedAttempt,
          recoveryCycleId: cycle.cycleId,
        });
        return this.getRecovery({ cycleId: cycle.cycleId });
      }
    }
  }

  #assertRecoveryActionFresh(cycle: RecoveryCycle, input: RecoveryActionRequest): void {
    const latest = (foldTransitionEvaluationHistory(this.#store.events(this.id)).get(cycle.transitionId) ?? []).at(-1) ?? null;
    const actualHead = this.#store.head(this.id);
    if (
      input.expectedTransitionId !== cycle.transitionId ||
      input.expectedAttempt !== latest?.attempt ||
      input.expectedHead !== actualHead
    ) {
      throw this.#recoveryConflict(cycle, input.kind, input.expectedAttempt, input.expectedTransitionId, input.expectedHead, latest, actualHead);
    }
  }

  #recoveryConflict(
    cycle: RecoveryCycle,
    actionKind: RecoveryActionKind,
    expectedAttempt: number,
    expectedTransitionId: string,
    expectedHead: number,
    latest: TransitionEvaluation | null,
    actualHead: number,
  ): RecoveryConflictError {
    const conflict: RecoveryConflict = {
      kind: 'stale-action',
      cycleId: cycle.cycleId,
      transitionId: cycle.transitionId,
      actionKind,
      expectedAttempt,
      actualAttempt: latest?.attempt ?? null,
      expectedTransitionId,
      actualTransitionId: latest?.transitionId ?? null,
      expectedHead,
      actualHead,
      detail: `Recovery action ${actionKind} is stale; expected ${expectedTransitionId} attempt ${expectedAttempt} at log head ${expectedHead}, ` +
        `but the canonical log is ${cycle.transitionId} attempt ${latest?.attempt ?? 'unknown'} at head ${actualHead}.`,
    };
    return new RecoveryConflictError(conflict);
  }

  #throwEvaluationConflict(transitionId: string, expectedAttempt: number, expectedHead: number): never {
    this.#store.refresh(this.id);
    const actualHead = this.#store.head(this.id);
    const actualAttempt = foldTransitionEvaluationHistory(this.#store.events(this.id))
      .get(transitionId)
      ?.at(-1)
      ?.attempt ?? null;
    throw new TransitionEvaluationConflictError({
      kind: 'stale-evaluation',
      transitionId,
      expectedAttempt,
      actualAttempt,
      expectedHead,
      actualHead,
      detail: `Evaluation ${transitionId} is stale; expected attempt ${expectedAttempt} at log head ${expectedHead}, ` +
        `but the canonical log is at attempt ${actualAttempt ?? 'none'} and head ${actualHead}.`,
    });
  }

  /** Recheck human action eligibility inside the final evaluation CAS. */
  #recoveryActionPrelude(
    cycle: RecoveryCycle,
    input: RecoveryActionRequest,
    action: RecoveryAction,
    additional: readonly CompareAndAppendEntry[],
  ): (canonical: CanonicalThreadLog) => readonly CompareAndAppendEntry[] {
    return (canonical) => {
      const actualCycle = findRecoveryCycle(
        canonical.events,
        { cycleId: input.cycleId },
        (runId) => this.isRunActive(runId),
      );
      const latest = (foldTransitionEvaluationHistory(canonical.events).get(cycle.transitionId) ?? []).at(-1) ?? null;
      if (
        actualCycle === null ||
        actualCycle.transitionId !== cycle.transitionId ||
        actualCycle.cancelled ||
        latest === null ||
        latest.refusal === null ||
        canonical.revision !== input.expectedHead ||
        input.expectedTransitionId !== cycle.transitionId ||
        input.expectedAttempt !== latest.attempt ||
        action.transitionId !== cycle.transitionId ||
        action.attempt !== latest.attempt ||
        (actualCycle.activeCorrection !== null && input.kind !== 'repin') ||
        (actualCycle.actions.some((item) => item.attempt >= latest.attempt) && input.kind !== 'repin')
      ) {
        throw this.#recoveryConflict(
          cycle,
          input.kind,
          input.expectedAttempt,
          input.expectedTransitionId,
          input.expectedHead,
          latest,
          canonical.revision,
        );
      }
      return [
        { agent: null, body: { kind: 'recovery.action.recorded', action } },
        ...additional,
      ];
    };
  }

  async #evaluateRecoveryAction(
    cycle: RecoveryCycle,
    input: RecoveryActionRequest,
    action: RecoveryAction,
    additional: readonly CompareAndAppendEntry[],
    evaluation: {
      sourceStepId: string;
      targetStepId: string;
      candidate: CandidateIdentity;
      transitionId: string;
      expectedAttempt: number;
      runId?: string | null;
      supersedesTransitionId?: string | null;
      recoveryCycleId?: string | null;
      override?: TransitionOverride | null;
    },
  ): Promise<TransitionDecision> {
    try {
      return await this.evaluatePlanningTransition({
        ...evaluation,
        expectedHead: input.expectedHead,
        prelude: this.#recoveryActionPrelude(cycle, input, action, additional),
      });
    } catch (error) {
      if (!(error instanceof TransitionEvaluationConflictError)) throw error;
      this.#store.refresh(this.id);
      const latest = (foldTransitionEvaluationHistory(this.#store.events(this.id)).get(cycle.transitionId) ?? []).at(-1) ?? null;
      throw this.#recoveryConflict(
        cycle,
        input.kind,
        input.expectedAttempt,
        input.expectedTransitionId,
        input.expectedHead,
        latest,
        this.#store.head(this.id),
      );
    }
  }

  /** Append the authority-changing action and any linked ledger/cancellation event atomically. */
  #appendRecoveryAction(
    cycle: RecoveryCycle,
    input: RecoveryActionRequest,
    action: RecoveryAction,
    additional: readonly CompareAndAppendEntry[] = [],
  ): void {
    const appended = this.#compareRecordBatch(
      input.expectedHead,
      [
        { agent: null, body: { kind: 'recovery.action.recorded', action } },
        ...additional,
      ],
      { transitionId: input.expectedTransitionId, attempt: input.expectedAttempt },
    );
    if (appended !== null) return;

    const latest = (foldTransitionEvaluationHistory(this.#store.events(this.id)).get(cycle.transitionId) ?? []).at(-1) ?? null;
    throw this.#recoveryConflict(
      cycle,
      input.kind,
      input.expectedAttempt,
      input.expectedTransitionId,
      input.expectedHead,
      latest,
      this.#store.head(this.id),
    );
  }

  #correctionWorkerAvailability(
    workspace: WorkspaceResolution,
    evaluation: TransitionEvaluation,
    agent: AgentId,
  ): Promise<{ detail: string } | null> {
    if (workspace.status !== 'ok') {
      return Promise.resolve({ detail: 'The workspace is unavailable; no correction worker may be selected.' });
    }
    const target = workspace.workspace.steps.find((step) => step.id === evaluation.targetStepId);
    if (
      target === undefined ||
      !workspace.workspace.agents.includes(agent) ||
      !target.workers.includes(agent)
    ) {
      return Promise.resolve({ detail: `Worker profile ${agent} is not authorized for transition target ${evaluation.targetStepId}.` });
    }
    return probeWorkerProfiles(this.#config, [agent]).then((availability) => {
      const result = availability[0];
      return result?.available === true ? null : {
        detail: result?.detail ?? `Worker profile ${agent} is unavailable.`,
      };
    });
  }

  #waitForRecovery(
    cycle: RecoveryCycle,
    evaluation: TransitionEvaluation,
    reason: 'human-action' | 'worker-unavailable' | 'transient-evaluator',
    detail: string,
    workerProfileId?: AgentId,
  ): void {
    if (
      cycle.waiting?.reason === reason &&
      cycle.waiting.detail === detail &&
      (workerProfileId === undefined || cycle.worker.profileId === workerProfileId)
    ) return;
    if (evaluation.refusal === null) return;
    this.#record(null, {
      kind: 'recovery.cycle.waiting',
      cycleId: cycle.cycleId,
      transitionId: cycle.transitionId,
      refusalAttempt: cycle.refusalAttempt,
      reason,
      required: evaluation.refusal.required,
      authority: 'user',
      detail,
      ...(workerProfileId === undefined ? {} : { workerProfileId }),
    });
  }

  #escalateRecovery(
    cycle: RecoveryCycle,
    evaluation: TransitionEvaluation,
    reason: 'unchanged-candidate' | 'exhausted' | 'absolute' | 'invalid',
  ): void {
    if (cycle.escalation?.reason === reason) return;
    if (evaluation.refusal === null) return;
    const validHumanAction = hasValidHumanRecoveryAction(evaluation);
    const action = reason === 'absolute' || reason === 'invalid' || !validHumanAction
      ? 'blocked'
      : cycle.onExhausted;
    const detail = reason === 'unchanged-candidate'
      ? 'The candidate and referenced evidence fingerprint did not change; no correction run was consumed.'
      : reason === 'exhausted'
        ? `The bounded correction budget of ${cycle.maxRuns} run(s) and ${cycle.maxEvaluations} evaluation(s) is exhausted.`
        : evaluation.refusal.reason;
    this.#record(null, {
      kind: 'recovery.cycle.escalated',
      cycleId: cycle.cycleId,
      transitionId: cycle.transitionId,
      refusalAttempt: cycle.refusalAttempt,
      reason,
      action,
      detail,
    });
  }

  /** The most recent run started by an agent in this thread, if any. */
  #latestRun(agent: AgentId): { runId: string; workItemId: string } | null {
    let latest: { runId: string; workItemId: string } | null = null;
    for (const event of this.#store.events(this.id)) {
      if (event.kind === 'run.started' && event.agent === agent) {
        latest = { runId: event.runId, workItemId: event.workItemId };
      }
    }
    return latest;
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
        env: workerEnvironment(),
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

  #adapter(agent: AgentId, cwd: string): WorkerAdapter {
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
      onSessionLost: () => this.#store.clearNativeSession(this.id, agent),
    };

    const adapter = createWorkerAdapter(agent, ctx);
    this.#adapters.set(agent, adapter);
    return adapter;
  }

  async #resetStaleNativeSession(agent: AgentId): Promise<void> {
    await this.#adapters.get(agent)?.stop();
    this.#adapters.delete(agent);
    this.#store.clearNativeSession(this.id, agent);
  }

  /** Persist, update derived state, broadcast. The single write path for events. */
  #record(agent: AgentId | null, body: AdapterEvent): HarnessEvent {
    if (agent !== null && (body.kind === 'answer.recorded' || body.kind === 'attestation.recorded' || body.kind === 'human.attestation.recorded')) {
      throw new Error('Human answer and attestation records require the core human-authority boundary.');
    }
    if (agent !== null && (
      (body.kind === 'evidence.recorded' && body.visual !== undefined) ||
      isTrustedVisualEventKind(body.kind)
    )) {
      throw new Error('Visual evidence can only be recorded by a trusted core adapter.');
    }
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
    return event;
  }

  /** Publish a recovery reservation only when the expected append-only head is current. */
  #compareRecord(
    expectedHead: number,
    agent: AgentId | null,
    body: AdapterEvent,
    expectedAttempt?: ExpectedTransitionAttempt,
  ): HarnessEvent | null {
    const event = this.#store.compareAndAppend(this.id, expectedHead, agent, body, expectedAttempt);
    if (event === null) return null;
    this.#emit(event);
    this.#onState();
    return event;
  }

  #compareRecordBatch(
    expectedHead: number,
    entries: readonly CompareAndAppendEntry[],
    expectedAttempt?: ExpectedTransitionAttempt,
  ): HarnessEvent[] | null {
    const events = this.#store.compareAndAppendBatch(this.id, expectedHead, entries, expectedAttempt);
    if (events === null) return null;
    for (const event of events) this.#emit(event);
    this.#onState();
    return events;
  }
}

function repinTransitionId(
  threadId: string,
  cycle: RecoveryCycle,
  sourceStepId: string,
  targetStepId: string,
  candidate: CandidateIdentity,
): string {
  const referenceDigest = createHash('sha256').update(JSON.stringify({
    authorizedExpectationSetId: cycle.expectationSetId,
    supersedesTransitionId: cycle.transitionId,
    sourceStepId,
    targetStepId,
    referenceIdentity: {
      kind: candidate.kind,
      id: candidate.id,
      revision: candidate.revision,
      digest: candidate.digest,
      pinned: candidate.pinned,
    },
  })).digest('hex');
  return `${threadId}:planning:${sourceStepId}:${targetStepId}:repin:${referenceDigest}`;
}

function sameCandidateIdentity(left: CandidateIdentity, right: CandidateIdentity): boolean {
  return left.kind === right.kind &&
    left.id === right.id &&
    left.revision === right.revision &&
    left.digest === right.digest &&
    left.pinned === right.pinned;
}

function candidateFromEvidenceItem(item: EvidenceItem): CandidateIdentity {
  return {
    kind: 'working-tree',
    id: item.state.tree ?? item.state.commit ?? 'unidentified-working-tree',
    revision: item.state.commit,
    digest: item.state.tree,
    pinned: item.state.tree !== null,
  };
}

/**
 * Owns every live thread and the one shared permission bridge.
 */
export class Orchestrator extends EventEmitter {
  readonly store: ThreadStore;
  readonly context: ContextStore;
  readonly work: WorkItemStore;
  readonly catalog: CatalogStore;
  readonly roleSelections: WorkspaceRoleSelectionStore;
  readonly #config: HarnessConfig;
  readonly #bridge = new PermissionBridge();
  readonly #threads = new Map<string, Thread>();
  readonly #issueLocks = new Map<string, Promise<void>>();

  constructor(config: HarnessConfig) {
    super();
    this.#config = config;
    this.store = new ThreadStore(config.dataDir);
    this.context = new ContextStore(config.dataDir);
    this.work = new WorkItemStore(config.dataDir);
    this.catalog = new CatalogStore(config.dataDir);
    this.roleSelections = new WorkspaceRoleSelectionStore(config.dataDir);
  }

  async start(): Promise<void> {
    await this.#bridge.listen(this.#config.host);
  }

  async stop(): Promise<void> {
    await Promise.all([...this.#threads.values()].map((thread) => thread.stop()));
    this.#threads.clear();
    await this.#bridge.close();
  }

  createThread(options: { cwd: string; title?: string; agent?: AgentId; workItemId?: string | null }): ThreadSummary {
    const summary = this.store.create(options);
    this.emit('thread', summary);
    return summary;
  }

  /**
   * Prepare one issue for a worker without starting a turn.
   *
   * The stable key is resolved before the lock is acquired. Once inside it, continuation is
   * deliberately the first read: a linked local thread is enough to answer, even when GitHub,
   * the catalog, or the machine's worker installation is unavailable.
   */
  async prepareIssue(input: {
    cwd?: string;
    threadId?: string;
    number: number;
  }): Promise<IssueOpenResult> {
    if ((input.cwd === undefined) === (input.threadId === undefined)) {
      return issueRefusal('invalid-request', 'Provide exactly one of cwd or threadId.');
    }
    if (!Number.isInteger(input.number) || input.number < 1) {
      return issueRefusal('invalid-request', 'Issue number must be a positive whole number.');
    }

    let cwd: string;
    if (input.threadId !== undefined) {
      const thread = this.store.get(input.threadId);
      if (!thread) return issueRefusal('thread-not-found', `Unknown thread ${input.threadId}.`);
      cwd = thread.cwd;

      const item = thread.workItemId === null ? undefined : this.work.get(thread.workItemId);
      if (item?.source.number === input.number) {
        const continued = await this.#withIssueLock(
          issueKey(item.workspaceRoot, item.source.repo, input.number),
          async () => this.#continueLocalItem(item.id, cwd),
        );
        if (continued !== null) return continued;
      }
    } else {
      cwd = input.cwd?.trim() ?? '';
      if (cwd === '') return issueRefusal('invalid-request', 'cwd must be a non-empty directory path.');

      const normalizedCwd = resolvePath(cwd);
      const candidates = this.work.list(normalizedCwd)
        .filter((item) => item.workspaceRoot === normalizedCwd && item.source.number === input.number)
        .map((item) => ({ item, thread: this.#canonicalLinkedThread(item.id) }))
        .filter((entry): entry is { item: WorkItem; thread: ThreadSummary } => entry.thread !== undefined)
        .sort((a, b) => b.thread.updatedAt - a.thread.updatedAt || a.thread.id.localeCompare(b.thread.id));
      const local = candidates[0];
      if (local) {
        const continued = await this.#withIssueLock(
          issueKey(local.item.workspaceRoot, local.item.source.repo, input.number),
          async () => this.#continueLocalItem(local.item.id, cwd),
        );
        if (continued !== null) return continued;
      }
    }

    const resolution = this.workspace(cwd);
    if (resolution.status === 'none') {
      return issueRefusal(
        'workspace-not-found',
        'This directory is not a declared workspace. Declare .awos/workspace.json first.',
      );
    }
    if (resolution.status === 'invalid') {
      const routingProblem = resolution.problems.some((problem) => /^(roles|steps|routes)(\.|\[|$)/.test(problem.path));
      return issueRefusal(
        routingProblem ? 'route-invalid' : 'workspace-invalid',
        `The workspace declaration is invalid. Fix it before taking this issue. ${resolution.problems[0]?.message ?? ''}`.trim(),
      );
    }

    const repository = resolution.workspace.repository.github;
    if (repository === null) {
      return issueRefusal(
        'repository-not-configured',
        'This workspace does not declare repository.github, so the issue cannot be resolved.',
      );
    }

    const workspaceRoot = resolution.workspace.root;
    const key = issueKey(workspaceRoot, repository, input.number);
    return this.#withIssueLock(key, () => this.#prepareIssueLocked({
      cwd,
      number: input.number,
      workspaceRoot,
      repository,
      resolution,
    }));
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

  async integrateLane(
    threadId: string,
    agent: AgentId,
    override: GateOverride | null = null,
  ): Promise<{ ok: boolean; detail: string }> {
    return this.#thread(threadId).integrate(agent, override);
  }

  /** Run a named verification check where the agent's work is. */
  async runCheck(
    threadId: string,
    agent: AgentId,
    name: string,
  ): Promise<{ passed: boolean; detail: string }> {
    return this.#thread(threadId).runCheck(name, agent);
  }

  /** What the gate would decide about an agent's lane right now. */
  async gate(
    threadId: string,
    agent: AgentId,
  ): Promise<GateDecision & { candidate: WorkingState; refusalReason: string | null }> {
    return this.#thread(threadId).gate(agent);
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
    return resolveWorkspace(cwd, {
      laneSetup: this.#config.laneSetup,
      expectationItemIds: CORE_EXPECTATION_ITEM_IDS,
      evaluatorProfileIds: CORE_EVALUATOR_PROFILE_IDS,
    });
  }

  /** Project the local role preference against the current shared role authority. */
  workspaceRoleSelection(cwd: string): WorkspaceRoleSelection {
    const resolution = this.workspace(cwd);
    if (resolution.status !== 'ok' || resolution.workspace.roles.length === 0) {
      return { status: 'unconfigured', roleId: null, role: null };
    }

    const roleId = this.roleSelections.read(resolution.workspace.root);
    if (roleId === null) return { status: 'needs-selection', roleId: null, role: null };

    const role = resolution.workspace.roles.find((candidate) => candidate.id === roleId) ?? null;
    return role === null
      ? { status: 'stale', roleId, role: null }
      : { status: 'selected', roleId, role };
  }

  /** Validate against the current resolved workspace before changing local preference data. */
  setWorkspaceRoleSelection(cwd: string, roleId: string | null): WorkspaceRoleSelection {
    const resolution = this.workspace(cwd);
    if (resolution.status !== 'ok' || resolution.workspace.roles.length === 0) {
      throw new Error('This directory has no configured workspace roles.');
    }

    if (roleId !== null) {
      if (typeof roleId !== 'string') throw new Error('Workspace role id must be a string or null.');
      const role = resolution.workspace.roles.find((candidate) => candidate.id === roleId);
      if (role === undefined) {
        throw new Error(
          `Unknown workspace role "${roleId}". Choose one of: ${resolution.workspace.roles
            .map((candidate) => candidate.id)
            .join(', ')}.`,
        );
      }
    }

    this.roleSelections.write(resolution.workspace.root, roleId);
    return this.workspaceRoleSelection(cwd);
  }

  getIssueCatalog(cwd: string): { catalog: WorkspaceIssueCatalog | null; error: WorkSourceError | null } {
    const scope = this.#catalogScope(cwd);
    if (!scope.ok) return { catalog: null, error: scope.error };
    return { catalog: this.#composeIssueCatalog(this.catalog.read(scope)), error: null };
  }

  async refreshIssueCatalog(
    cwd: string,
  ): Promise<{ catalog: WorkspaceIssueCatalog | null; error: WorkSourceError | null }> {
    const scope = this.#catalogScope(cwd);
    if (!scope.ok) return { catalog: null, error: scope.error };
    const source = await this.catalog.refresh(scope, this.#github());
    return { catalog: this.#composeIssueCatalog(source), error: source.error };
  }

  /**
   * Read the project-level overview without contacting GitHub.
   *
   * The catalog is local state, while the core probes only the worker profiles named by
   * the workspace steps for every authoritative read. The projection below owns the
   * classification; the UI never re-routes an issue or infers a blocker.
   */
  async getProjectOverview(cwd: string): Promise<{ overview: ProjectOverview | null; error: WorkSourceError | null }> {
    const resolution = this.workspace(cwd);
    if (resolution.status !== 'ok') {
      const scope = this.#catalogScope(cwd);
      return { overview: null, error: scope.ok ? null : scope.error };
    }

    const repository = resolution.workspace.repository.github;
    if (repository === null) {
      return {
        overview: null,
        error: {
          kind: 'unknown',
          message: 'This workspace does not declare repository.github, so no project overview is available.',
          retryable: false,
        },
      };
    }

    const source = this.catalog.read({ workspaceRoot: resolution.workspace.root, repository });
    let workerAvailability: AgentAvailability[];
    let workerError: WorkSourceError | null = null;
    const profileIds = [...new Set(resolution.workspace.steps.flatMap((step) => step.workers))];
    try {
      workerAvailability = await probeWorkerProfiles(this.#config, profileIds);
    } catch (error) {
      const detail = error instanceof Error && error.message !== '' ? ` ${error.message}` : '';
      workerAvailability = [];
      workerError = {
        kind: 'unknown',
        message: `Could not check worker availability.${detail}`,
        retryable: true,
      };
    }

    const workerLabels = Object.fromEntries(
      registeredWorkerProfiles(this.#config).map((profile) => [profile.id, profile.label]),
    );
    const overview = projectProjectOverview({
      cwd,
      workspace: resolution,
      source,
      roleSelection: this.workspaceRoleSelection(cwd),
      availability: workerAvailability,
      workerLabels,
      entries: this.#projectOverviewEntries(source),
    });
    return { overview, error: workerError ?? source.error };
  }

  /**
   * Read one issue's detail without creating or changing a WorkItem.
   *
   * The catalog remains the route authority. When it is current, GitHub is asked once for
   * body/author detail through the existing bounded read adapter. A linked WorkItem is the
   * honest dated fallback when that read fails; it is never refreshed or persisted here.
   */
  async getProjectIssueDetail(
    cwd: string,
    number: number,
  ): Promise<{ detail: ProjectIssueDetail | null; error: WorkSourceError | null }> {
    const resolution = this.workspace(cwd);
    if (resolution.status !== 'ok') {
      const scope = this.#catalogScope(cwd);
      return { detail: null, error: scope.ok ? null : scope.error };
    }

    const repository = resolution.workspace.repository.github;
    if (repository === null) {
      return {
        detail: null,
        error: {
          kind: 'unknown',
          message: 'This workspace does not declare repository.github, so issue detail is unavailable.',
          retryable: false,
        },
      };
    }

    const source = this.catalog.read({ workspaceRoot: resolution.workspace.root, repository });
    const workItem = this.work.find(resolution.workspace.root, repository, number);
    const catalogIssue = source.issues.find((candidate) => candidate.number === number);
    if (catalogIssue === undefined && workItem === undefined) {
      return {
        detail: null,
        error: {
          kind: 'not-found',
          message: `Issue #${number} is not in the current catalog and has no linked local snapshot.`,
          retryable: false,
        },
      };
    }

    let issue = catalogIssue ?? asCatalogIssue(workItem as WorkItem);
    let snapshot = workItem?.snapshot ?? null;
    const assignees = assigneeMetadata(catalogIssue, workItem);
    let detailSource: ProjectIssueDetailSource = {
      kind: snapshot === null ? 'catalog-metadata' : 'work-item-snapshot',
      freshness: snapshot === null ? source.freshness : 'cached',
      catalogFreshness: source.freshness,
      fetchedAt: workItem?.fetchedAt ?? null,
      checkedAt: workItem?.lastRefreshedAt ?? source.successfulAt,
      revision: (snapshot?.revision ?? issue.updatedAt) || null,
      assigneesKnown: assignees.known,
      assigneesSource: assignees.source,
      error: source.error,
    };
    let detailError = source.error;
    let fallbackToSnapshot = source.freshness !== 'current' && workItem !== undefined;

    if (source.freshness === 'current') {
      try {
        const fetched = await fetchIssue({ repo: repository, number }, this.#github());
        if (fetched.ok && fetched.ref.number === number) {
          issue = issueFromSnapshot(issue, fetched.ref.url, fetched.snapshot);
          snapshot = fetched.snapshot;
          const now = Date.now();
          detailSource = {
            kind: 'github',
            freshness: 'current',
            catalogFreshness: 'current',
            fetchedAt: now,
            checkedAt: now,
            revision: fetched.snapshot.revision || issue.updatedAt || null,
            assigneesKnown: assignees.known,
            assigneesSource: assignees.source,
            error: null,
          };
          detailError = null;
        } else {
          detailError = fetched.ok
            ? {
                kind: 'unknown',
                message: `GitHub returned issue #${fetched.ref.number} while reading issue #${number}.`,
                retryable: true,
              }
            : fetched.error;
          fallbackToSnapshot = workItem !== undefined;
        }
      } catch (error) {
        detailError = {
          kind: 'offline',
          message: error instanceof Error ? error.message : 'Could not read issue detail from GitHub.',
          retryable: true,
        };
        fallbackToSnapshot = workItem !== undefined;
      }
    }

    if (fallbackToSnapshot && workItem !== undefined && detailSource.kind !== 'github') {
      issue = issueFromSnapshot(catalogIssue ?? asCatalogIssue(workItem), workItem.source.url, workItem.snapshot);
      snapshot = workItem.snapshot;
      detailSource = {
        kind: 'work-item-snapshot',
        freshness: 'cached',
        catalogFreshness: source.freshness,
        fetchedAt: workItem.fetchedAt,
        checkedAt: workItem.lastRefreshedAt,
        revision: workItem.snapshot.revision || issue.updatedAt || null,
        assigneesKnown: assignees.known,
        assigneesSource: assignees.source,
        error: detailError,
      };
    } else if (detailSource.kind !== 'github') {
      detailSource = { ...detailSource, error: detailError };
    }

    // A failed current detail read is a cached detail source for new-action purposes. The
    // panel still reports that the catalog itself was current through catalogFreshness.
    const routeSource: IssueCatalogSource = {
      ...source,
      freshness: fallbackToSnapshot ? 'cached' : source.freshness,
      successfulAt: fallbackToSnapshot && workItem !== undefined ? workItem.lastRefreshedAt : source.successfulAt,
      issues: [issue],
      error: detailError,
    };

    const profileIds = [...new Set(resolution.workspace.steps.flatMap((step) => step.workers))];
    let availability: AgentAvailability[] = [];
    let workerError: WorkSourceError | null = null;
    try {
      availability = await probeWorkerProfiles(this.#config, profileIds);
    } catch (error) {
      workerError = {
        kind: 'unknown',
        message: error instanceof Error ? `Could not check worker availability. ${error.message}` : 'Could not check worker availability.',
        retryable: true,
      };
    }

    const workerLabels = Object.fromEntries(
      registeredWorkerProfiles(this.#config).map((profile) => [profile.id, profile.label]),
    );
    const detail = projectProjectIssueDetail({
      cwd,
      workspace: resolution,
      issue,
      catalogIssue: catalogIssue ?? null,
      snapshot,
      source: detailSource,
      routeSource,
      roleSelection: this.workspaceRoleSelection(cwd),
      availability,
      workerLabels,
      linkedThreads: workItem === undefined ? [] : this.#projectIssueThreadHistory(workItem.id),
    });
    return { detail, error: workerError ?? detailError };
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
    input: {
      runId: string;
      kind: EvidenceKind;
      ref: EvidenceRef;
      summary: string;
      evidenceId?: string;
      expectationSetId?: string | null;
      expectationItemId?: string | null;
    },
  ): Promise<void> {
    await this.#thread(threadId).recordEvidence(input);
  }

  /** Evaluate a planning edge from the recorded human answer/attestation facts. */
  async evaluatePlanningTransition(
    threadId: string,
    input: {
      sourceStepId: string;
      targetStepId: string;
      candidate: CandidateIdentity;
      transitionId?: string;
      expectedAttempt?: number;
      expectedHead?: number;
    },
  ): Promise<TransitionDecision> {
    return this.#thread(threadId).evaluatePlanningTransition(input);
  }

  /** Read the durable recovery projection for a transition or cycle. */
  getRecovery(
    threadId: string,
    input: { transitionId?: string; cycleId?: string } = {},
  ): RecoveryCycle | null {
    // Recovery reads carry a head for the next human CAS. Refresh the canonical log
    // before projecting it so a second process cannot hand the UI an old action version.
    this.store.refresh(threadId);
    return this.#thread(threadId).getRecovery(input);
  }

  /** Start an explicitly selected worker correction; the worker profile is never substituted. */
  async startRecovery(
    threadId: string,
    input: { transitionId: string; expectedAttempt: number; expectedHead?: number; agent: AgentId; cycleId?: string },
  ): Promise<RecoveryCycle | null> {
    return this.#thread(threadId).startRecovery(input);
  }

  /** Apply a typed human recovery action through the distinct authority boundary. */
  async applyRecoveryAction(
    threadId: string,
    input: RecoveryActionRequest,
  ): Promise<RecoveryCycle | null> {
    this.#requireHumanAuthorityCredential(input.humanCredential);
    const { humanCredential: _humanCredential, ...action } = input;
    return this.#thread(threadId).applyRecoveryAction(action);
  }

  /** Append a core-owned typed user answer for a planning expectation. */
  recordAnswer(
    threadId: string,
    input: {
      expectationItemId: string;
      expectationSetId: string;
      answer: TypedAnswer;
      candidate: CandidateIdentity;
      evidenceIds?: readonly string[];
      answerId?: string;
      humanCredential?: string;
    },
  ): void {
    this.#requireHumanAuthorityCredential(input.humanCredential);
    const { humanCredential: _humanCredential, ...record } = input;
    this.#thread(threadId).recordAnswer(record);
  }

  /** Append a core-owned user attestation; the evaluator verifies its evidence later. */
  recordAttestation(
    threadId: string,
    input: {
      expectationItemId: string;
      expectationSetId: string;
      statement: string;
      candidate: CandidateIdentity;
      evidenceIds: readonly string[];
      attestationId?: string;
      humanCredential?: string;
    },
  ): void {
    this.#requireHumanAuthorityCredential(input.humanCredential);
    const { humanCredential: _humanCredential, ...record } = input;
    this.#thread(threadId).recordAttestation(record);
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

  async #withIssueLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#issueLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.#issueLocks.set(key, current);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#issueLocks.get(key) === current) this.#issueLocks.delete(key);
    }
  }

  async #prepareIssueLocked(input: {
    cwd: string;
    number: number;
    workspaceRoot: string;
    repository: string;
    resolution: Extract<WorkspaceResolution, { status: 'ok' }>;
  }): Promise<IssueOpenResult> {
    const existing = this.work.find(input.workspaceRoot, input.repository, input.number);
    if (existing) {
      const linked = this.#canonicalLinkedThread(existing.id);
      if (linked) return this.#continuedIssue(linked, existing, input.resolution);
    }

    return this.#takeIssue(input);
  }

  #continuedIssue(
    thread: ThreadSummary,
    item: WorkItem,
    resolution: Extract<WorkspaceResolution, { status: 'ok' }> | null,
  ): IssueOpenResult {
    const issue = asCatalogIssue(item);
    const projection = resolution === null ? null : projectIssueRoute({
      workspace: resolution,
      issue,
      source: {
        workspaceRoot: item.workspaceRoot,
        repository: item.source.repo,
        freshness: 'current',
        complete: true,
        successfulAt: item.lastRefreshedAt,
        issues: [issue],
        error: null,
      },
      // Continuation is local and does not require the saved role to remain selectable.
      roleSelection: { status: 'unconfigured', roleId: null, role: null },
      availability: [],
    });

    return {
      ok: true,
      preparation: {
        threadId: thread.id,
        workItemId: item.id,
        mode: 'continued',
        route: projection === null ? null : routeSummary(projection),
        allowedWorkerProfileIds: projection === null ? [] : [...projection.action.allowedWorkerProfileIds],
        currentlyAvailableWorkerProfileIds: [],
        workerAvailability: 'not-checked',
        instruction: instructionInput(item),
      },
    };
  }

  #canonicalLinkedThread(workItemId: string): ThreadSummary | undefined {
    return this.store.list()
      .filter((thread) => thread.workItemId === workItemId)
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  }

  async #continueLocalItem(workItemId: string, cwd: string): Promise<IssueOpenResult | null> {
    const item = this.work.get(workItemId);
    const linked = item === undefined ? undefined : this.#canonicalLinkedThread(item.id);
    if (!item || !linked) return null;

    const resolution = this.workspace(cwd);
    const matchingResolution = resolution.status === 'ok' &&
      resolution.workspace.root === item.workspaceRoot &&
      resolution.workspace.repository.github === item.source.repo
      ? resolution
      : null;
    return this.#continuedIssue(linked, item, matchingResolution);
  }

  async #takeIssue(input: {
    cwd: string;
    number: number;
    workspaceRoot: string;
    repository: string;
    resolution: Extract<WorkspaceResolution, { status: 'ok' }>;
  }): Promise<IssueOpenResult> {
    const source = this.catalog.read({ workspaceRoot: input.workspaceRoot, repository: input.repository });
    const catalogIssue = source.issues.find((issue) => issue.number === input.number);

    if (source.freshness !== 'current') {
      const route = catalogIssue
        ? projectIssueRoute({
            workspace: input.resolution,
            issue: catalogIssue,
            source,
            roleSelection: { status: 'unconfigured', roleId: null, role: null },
            availability: [],
          })
        : undefined;
      return issueRefusal(
        'catalog-not-current',
        route ? explainIssueRoute(route) : 'Refresh the issue catalog before taking this issue.',
        route,
      );
    }

    if (!catalogIssue) {
      return issueRefusal(
        'issue-absent',
        `Issue #${input.number} is not present in the current open-issue catalog.`,
      );
    }
    if (catalogIssue.state !== 'OPEN') {
      return issueRefusal('issue-not-open', `Issue #${input.number} is not open.`);
    }

    const roleSelection = this.workspaceRoleSelection(input.cwd);
    const initialProjection = projectIssueRoute({
      workspace: input.resolution,
      issue: catalogIssue,
      source,
      roleSelection,
      availability: [],
    });
    if (initialProjection.action.reason !== 'worker-unavailable') {
      const refusal = this.#projectionRefusal(initialProjection);
      if (refusal !== null) return refusal;
    }

    let availability;
    try {
      availability = await probeWorkerProfiles(this.#config, initialProjection.action.allowedWorkerProfileIds);
    } catch (error) {
      const detail = error instanceof Error && error.message !== '' ? ` ${error.message}` : '';
      return issueRefusal('workers-unavailable', `Could not check the allowed worker profiles.${detail}`);
    }

    const availableProjection = projectIssueRoute({
      workspace: input.resolution,
      issue: catalogIssue,
      source,
      roleSelection,
      availability,
    });
    if (availableProjection.action.status !== 'available') {
      return this.#projectionRefusal(availableProjection) ?? issueRefusal(
        'workers-unavailable',
        explainIssueRoute(availableProjection),
        availableProjection,
      );
    }

    let fetched;
    try {
      fetched = await fetchIssue(
        { repo: input.repository, number: input.number },
        this.#github(),
      );
    } catch (error) {
      const detail = error instanceof Error && error.message !== '' ? ` ${error.message}` : '';
      return issueRefusal('source-fetch-failed', `Could not fetch issue #${input.number}.${detail}`);
    }
    if (!fetched.ok) {
      return issueRefusal(
        fetched.error.kind === 'not-found' ? 'issue-absent' : 'source-fetch-failed',
        fetched.error.message,
        availableProjection,
        fetched.error,
      );
    }
    if (fetched.ref.number !== input.number) {
      return issueRefusal(
        'source-fetch-failed',
        `GitHub returned issue #${fetched.ref.number} while fetching issue #${input.number}.`,
        availableProjection,
      );
    }
    if (fetched.snapshot.state.toUpperCase() !== 'OPEN') {
      return issueRefusal('issue-not-open', `Issue #${input.number} is no longer open.`, availableProjection);
    }

    const fullIssue: CatalogIssue = {
      ...catalogIssue,
      number: fetched.ref.number,
      url: fetched.ref.url,
      title: fetched.snapshot.title,
      state: 'OPEN',
      labels: [...fetched.snapshot.labels],
      updatedAt: fetched.snapshot.revision,
    };
    const currentResolution = this.workspace(input.cwd);
    if (currentResolution.status === 'none') {
      return issueRefusal('workspace-not-found', 'The workspace changed while the issue was being prepared. Retry after restoring its declaration.');
    }
    if (currentResolution.status === 'invalid') {
      const routingProblem = currentResolution.problems.some((problem) => /^(roles|steps|routes)(\.|\[|$)/.test(problem.path));
      return issueRefusal(
        routingProblem ? 'route-invalid' : 'workspace-invalid',
        `The workspace changed and is now invalid. ${currentResolution.problems[0]?.message ?? ''}`.trim(),
      );
    }
    const currentRepository = currentResolution.workspace.repository.github;
    if (currentRepository === null) {
      return issueRefusal('repository-not-configured', 'The workspace no longer declares repository.github. Retry after restoring it.');
    }
    if (currentResolution.workspace.root !== input.workspaceRoot || currentRepository !== input.repository) {
      return issueRefusal('route-changed', 'The workspace or repository changed while the issue was being prepared. Retry the command.');
    }

    const currentRoleSelection = this.workspaceRoleSelection(input.cwd);
    const sourceProjection = projectIssueRoute({
      workspace: input.resolution,
      issue: fullIssue,
      source: { ...source, issues: [fullIssue], error: null },
      roleSelection: currentRoleSelection,
      availability: [],
    });
    if (sourceProjection.route.status !== 'routed') {
      return this.#projectionRefusal(sourceProjection) ?? issueRefusal(
        'route-invalid',
        explainIssueRoute(sourceProjection),
        sourceProjection,
      );
    }
    const policyIdentity = (projection: IssueRouteProjection) => JSON.stringify({
      routeId: projection.route.routeId,
      stepId: projection.route.stepId,
      role: projection.action.responsibleRole,
      action: projection.action.projectAction,
      workers: projection.action.allowedWorkerProfileIds,
    });
    if (policyIdentity(sourceProjection) !== policyIdentity(availableProjection)) {
      return issueRefusal(
        'route-changed',
        'The issue route changed while it was being prepared. Refresh the catalog and retry the command.',
        sourceProjection,
      );
    }
    const currentProjection = projectIssueRoute({
      workspace: currentResolution,
      issue: fullIssue,
      source: { ...source, issues: [fullIssue], error: null },
      roleSelection: currentRoleSelection,
      availability: [],
    });
    if (
      currentProjection.route.status !== 'routed' ||
      policyIdentity(currentProjection) !== policyIdentity(sourceProjection)
    ) {
      return issueRefusal(
        'route-changed',
        'Workspace routing policy changed while the issue was being prepared. Retry the command.',
        currentProjection,
      );
    }
    const authorizedProjection = projectIssueRoute({
      workspace: currentResolution,
      issue: fullIssue,
      source: { ...source, issues: [fullIssue], error: null },
      roleSelection: currentRoleSelection,
      availability,
    });
    if (authorizedProjection.action.status !== 'available') {
      return this.#projectionRefusal(authorizedProjection) ?? issueRefusal(
        'workers-unavailable',
        explainIssueRoute(authorizedProjection),
        authorizedProjection,
      );
    }

    let item: WorkItem;
    try {
      item = this.work.record({
        workspaceRoot: input.workspaceRoot,
        ref: fetched.ref,
        snapshot: fetched.snapshot,
      });
    } catch (error) {
      const detail = error instanceof Error && error.message !== '' ? ` ${error.message}` : '';
      return issueRefusal('persistence-failed', `Could not persist the issue work item.${detail}`);
    }

    let thread: ThreadSummary;
    try {
      thread = this.store.create({
        cwd: input.cwd,
        title: fetched.snapshot.title,
        workItemId: item.id,
      });
    } catch (error) {
      const detail = error instanceof Error && error.message !== '' ? ` ${error.message}` : '';
      return issueRefusal('persistence-failed', `Could not persist the issue thread.${detail}`);
    }
    this.emit('thread', thread);

    return {
      ok: true,
      preparation: {
        threadId: thread.id,
        workItemId: item.id,
        mode: 'taken',
        route: routeSummary(authorizedProjection),
        allowedWorkerProfileIds: [...authorizedProjection.action.allowedWorkerProfileIds],
        currentlyAvailableWorkerProfileIds: authorizedProjection.action.availability
          .filter((fact) => fact.available)
          .map((fact) => fact.profileId),
        workerAvailability: 'checked',
        instruction: instructionInput(item),
      },
    };
  }

  #projectionRefusal(projection: IssueRouteProjection): IssueOpenResult | null {
    const message = explainIssueRoute(projection);
    switch (projection.action.reason) {
      case 'invalid-workspace':
        return issueRefusal('route-invalid', message, projection);
      case 'not-routed':
        return issueRefusal('route-unrouted', message, projection);
      case 'conflicted-route':
        return issueRefusal('route-conflict', message, projection);
      case 'refresh-required':
        return issueRefusal('catalog-not-current', message, projection);
      case 'role-required':
        return issueRefusal('role-required', message, projection);
      case 'role-mismatch':
        return issueRefusal('role-mismatch', message, projection);
      case 'worker-unavailable':
        return issueRefusal('workers-unavailable', message, projection);
      case 'available':
        return null;
    }
  }

  #github(): { bin: string; binArgs: string[]; timeoutMs: number } {
    return {
      bin: this.#config.ghBin,
      binArgs: this.#config.ghBinArgs,
      timeoutMs: this.#config.ghTimeoutMs,
    };
  }

  #catalogScope(
    cwd: string,
  ): { ok: true; workspaceRoot: string; repository: string } | { ok: false; error: WorkSourceError } {
    const resolution = this.workspace(cwd);
    if (resolution.status !== 'ok') {
      return {
        ok: false,
        error: {
          kind: 'unknown',
          message:
            resolution.status === 'none'
              ? 'This directory is not a workspace yet. Declare .awos/workspace.json first.'
              : 'The workspace declaration is invalid. Fix it before reading its GitHub issue catalog.',
          retryable: false,
        },
      };
    }
    const repository = resolution.workspace.repository.github;
    if (repository === null) {
      return {
        ok: false,
        error: {
          kind: 'unknown',
          message: 'This workspace does not declare repository.github, so no GitHub issue catalog is available.',
          retryable: false,
        },
      };
    }
    return { ok: true, workspaceRoot: resolution.workspace.root, repository };
  }

  #composeIssueCatalog(source: IssueCatalogSource): WorkspaceIssueCatalog {
    const overlay: Record<string, IssueCatalogOverlay> = {};
    for (const issue of source.issues) {
      overlay[`${source.repository}#${issue.number}`] = { linkedThreads: [], runs: [] };
    }

    const items = this.work.list(source.workspaceRoot).filter((item) => item.source.repo === source.repository);
    const summaries = this.store.list();
    for (const item of items) {
      const key = `${item.source.repo}#${item.source.number}`;
      const linked = summaries.filter((thread) => thread.workItemId === item.id);
      if (linked.length === 0) continue;
      const entry = overlay[key] ??= { linkedThreads: [], runs: [] };
      entry.linkedThreads.push(
        ...linked.map((thread) => ({
          threadId: thread.id,
          workItemId: item.id,
          title: thread.title,
          updatedAt: thread.updatedAt,
        })),
      );

      for (const thread of linked) {
        const events = this.store.events(thread.id);
        const runtime = this.#threads.get(thread.id);
        entry.runs.push(
          ...projectRunEvidence(
            events,
            (runId) => runtime?.isRunActive(runId) === true,
            item.id,
          ),
        );
      }
    }

    return { source, overlay };
  }

  #projectOverviewEntries(source: IssueCatalogSource): ProjectOverviewEntry[] {
    const entries = new Map<string, ProjectOverviewEntry>();
    for (const issue of source.issues) {
      entries.set(`${source.repository}#${issue.number}`, {
        issue,
        linkedThreads: [],
        runs: [],
      });
    }

    const summaries = this.store.list();
    const items = this.work.list(source.workspaceRoot).filter((item) => item.source.repo === source.repository);
    for (const item of items) {
      const linkedThreads = summaries.filter((thread) => thread.workItemId === item.id);
      if (linkedThreads.length === 0) continue;

      const key = `${item.source.repo}#${item.source.number}`;
      const entry = entries.get(key) ?? {
        issue: asCatalogIssue(item),
        linkedThreads: [],
        runs: [],
      };
      entry.linkedThreads = linkedThreads.map((thread) => ({
        threadId: thread.id,
        workItemId: item.id,
        title: thread.title,
        updatedAt: thread.updatedAt,
      }));
      entry.runs = linkedThreads.flatMap((thread) =>
        projectRunEvidence(
          this.store.events(thread.id),
          (runId) => this.#threads.get(thread.id)?.isRunActive(runId) === true,
          item.id,
        ),
      );
      entries.set(key, entry);
    }

    return [...entries.values()];
  }

  #projectIssueThreadHistory(workItemId: string): ProjectIssueThreadHistory[] {
    return this.store.list()
      .filter((thread) => thread.workItemId === workItemId)
      .map((thread) => {
        const events = this.store.events(thread.id);
        const outcomes = foldOutcomes(events);
        const runs = projectRunEvidence(
          events,
          (runId) => this.#threads.get(thread.id)?.isRunActive(runId) === true,
          workItemId,
        ).map((run) => ({ run, outcome: outcomes.get(run.runId) ?? null }));
        return {
          thread: {
            threadId: thread.id,
            workItemId,
            title: thread.title,
            updatedAt: thread.updatedAt,
          },
          runs,
          evidence: foldEvidence(events).filter((item) => item.workItemId === workItemId),
        };
      });
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

  #requireHumanAuthorityCredential(presented: string | undefined): void {
    if (!matchesHumanAuthorityCredential(
      this.#config.humanAuthorityToken,
      presented,
      process.env['AWOS_TOKEN'],
    )) {
      throw new Error('A distinct human-authority credential is required for this write.');
    }
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
