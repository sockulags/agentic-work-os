import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AgentCapabilities,
  HarnessEvent,
  ModelTarget,
  WorkerProfileId,
} from '@awos/protocol';
import { buildReplay } from './store/replay.js';
import { Orchestrator } from './orchestrator.js';
import type { HarnessConfig } from './config.js';
import type { AdapterContext, WorkerAdapter, WorkerTurnOptions } from './adapters/agent.js';
import type { AdapterFactory, WorkerProfileDefinition, WorkerRegistries } from './adapters/registry.js';
import { ThreadStore } from './store/thread-store.js';

const BUILD_PROFILE = 'claude-build';
const REVIEW_PROFILE = 'claude-review';
const SHARED_TARGET_ID = 'shared-claude-target';
const SHARED_FACTORY_ID = 'shared-claude-adapter';

const SHARED_CAPABILITIES: AgentCapabilities = {
  streamingToolOutput: false,
  streamingText: false,
  reasoning: false,
  plans: false,
  turnDiff: false,
  approvals: true,
  resumableSessions: true,
};

function config(dataDir: string): HarnessConfig {
  return {
    dataDir,
    claudeBin: 'unused',
    codexBin: 'unused',
    claudeBinArgs: [],
    codexBinArgs: [],
    claudeModel: '',
    codexModel: '',
    host: '127.0.0.1',
    port: 0,
    replayMaxChars: 24_000,
    replayMaxToolOutput: 800,
    laneSetup: '',
    laneSetupTimeoutMs: 10_000,
    interruptGraceMs: 100,
    approvalTimeoutMs: 5_000,
    codexInitTimeoutMs: 100,
    ghBin: 'unused',
    ghBinArgs: [],
    ghTimeoutMs: 100,
  };
}

function makeRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'awos-profile-identity-repo-'));
  mkdirSync(join(root, '.awos'), { recursive: true });
  writeFileSync(
    join(root, '.awos', 'workspace.json'),
    JSON.stringify({
      version: 3,
      name: 'profile identity test',
      agents: [BUILD_PROFILE, REVIEW_PROFILE],
      roles: [{ id: 'engineering', label: 'Engineering' }],
      steps: [{ id: 'implement', action: 'implement', role: 'engineering', workers: [BUILD_PROFILE, REVIEW_PROFILE] }],
      routes: [{ id: 'implementation', match: { allLabels: ['implementation'] }, step: 'implement' }],
    }),
    'utf8',
  );
  writeFileSync(join(root, 'seed.txt'), 'seed\n', 'utf8');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'profile-test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Profile Test'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
  return root;
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), message);
}

class SharedAdapter implements WorkerAdapter {
  readonly id = SHARED_FACTORY_ID;
  readonly capabilities = SHARED_CAPABILITIES;
  readonly #context: AdapterContext;
  readonly #payloads: Map<WorkerProfileId, string[]>;
  readonly #approvalResolvers = new Map<string, () => void>();
  #nativeSessionId: string | null = null;
  #busy = false;
  #turnNumber = 0;

  constructor(context: AdapterContext, payloads: Map<WorkerProfileId, string[]>) {
    this.#context = context;
    this.#payloads = payloads;
  }

  get nativeSessionId(): string | null {
    return this.#nativeSessionId;
  }

  get busy(): boolean {
    return this.#busy;
  }

  async start(): Promise<void> {}

  async sendTurn(text: string, _options?: WorkerTurnOptions): Promise<void> {
    if (this.#busy) throw new Error(`${this.#context.workerProfileId} is already busy`);
    this.#busy = true;
    const turnId = `${this.#context.workerProfileId}-turn-${++this.#turnNumber}`;
    const sessionId = `session:${this.#context.workerProfileId}`;
    if (this.#nativeSessionId === null) {
      this.#nativeSessionId = sessionId;
      this.#context.onSessionId(sessionId);
    }
    this.#payloads.set(this.#context.workerProfileId, [
      ...(this.#payloads.get(this.#context.workerProfileId) ?? []),
      text,
    ]);
    this.#context.emit({ kind: 'turn.started', nativeSessionId: this.#nativeSessionId, turnId });

    const approvalId = `approval:${this.#context.workerProfileId}:${this.#turnNumber}`;
    const completed = new Promise<void>((resolve) => this.#approvalResolvers.set(approvalId, resolve));
    this.#context.emit({
      kind: 'approval.requested',
      approvalId,
      toolName: 'shared-tool',
      toolKind: 'command',
      title: `run for ${this.#context.workerProfileId}`,
      detail: text,
      input: { profileId: this.#context.workerProfileId },
      options: [{ id: 'allow', label: 'Allow', behavior: 'allow', persistent: false }],
      turnId,
    });

    try {
      await completed;
      this.#context.emit({ kind: 'approval.resolved', approvalId, optionId: 'allow', behavior: 'allow', auto: false, turnId });
      this.#context.emit({
        kind: 'message.completed',
        itemId: `message:${turnId}`,
        text: `completed by ${this.#context.workerProfileId}`,
        turnId,
      });
      this.#context.emit({ kind: 'turn.completed', reason: 'completed', error: null, durationMs: 1, turnId });
    } finally {
      this.#approvalResolvers.delete(approvalId);
      this.#busy = false;
    }
  }

  async interrupt(): Promise<void> {
    for (const resolve of this.#approvalResolvers.values()) resolve();
  }

  resolveApproval(approvalId: string): void {
    this.#approvalResolvers.get(approvalId)?.();
  }

  async stop(): Promise<void> {
    await this.interrupt();
  }
}

function profile(id: WorkerProfileId): WorkerProfileDefinition {
  return {
    id,
    agent: 'claude',
    label: id,
    adapterId: SHARED_FACTORY_ID,
    targetId: SHARED_TARGET_ID,
    policy: { permissionModes: ['default'], nativeTurnDiff: false },
    probe: async () => ({ available: true, detail: 'test' }),
  };
}

function registries(payloads: Map<WorkerProfileId, string[]>, created: Array<{ profileId: WorkerProfileId; targetId: string }>): WorkerRegistries {
  const target: ModelTarget = {
    id: SHARED_TARGET_ID,
    provider: 'claude',
    model: 'shared-model',
    endpoint: null,
    authProfile: null,
  };
  const factory: AdapterFactory = {
    id: SHARED_FACTORY_ID,
    capabilities: SHARED_CAPABILITIES,
    supports: (candidate) => candidate.id === SHARED_TARGET_ID,
    create: (context, resolvedTarget) => {
      created.push({ profileId: context.workerProfileId, targetId: resolvedTarget.id });
      return new SharedAdapter(context, payloads);
    },
  };
  return {
    profiles: [profile(BUILD_PROFILE), profile(REVIEW_PROFILE)],
    targets: [{ target, resolve: () => target }],
    factories: [factory],
  };
}

function pendingApprovalId(orch: Orchestrator, threadId: string, profileId: WorkerProfileId): string {
  const pending = new Set(orch.state(threadId).pendingApprovals.map((approval) => approval.approvalId));
  const event = orch.store.events(threadId).slice().reverse().find(
    (candidate): candidate is Extract<HarnessEvent, { kind: 'approval.requested' }> =>
      candidate.kind === 'approval.requested' && candidate.profileId === profileId && pending.has(candidate.approvalId),
  );
  assert.ok(event, `no pending approval for ${profileId}`);
  return event.approvalId;
}

test('profiles sharing an adapter and target keep independent state and routing', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'awos-profile-identity-data-'));
  const root = makeRepository();
  const payloads = new Map<WorkerProfileId, string[]>();
  const created: Array<{ profileId: WorkerProfileId; targetId: string }> = [];
  const orch = new Orchestrator(config(dataDir), registries(payloads, created));

  try {
    await orch.start();
    const thread = orch.createThread({ cwd: root, agent: BUILD_PROFILE });
    const workspace = orch.workspace(root);
    assert.equal(workspace.status, 'ok');
    if (workspace.status !== 'ok') return;
    assert.deepEqual(workspace.workspace.agents, [BUILD_PROFILE, REVIEW_PROFILE]);
    assert.deepEqual(workspace.workspace.steps[0]?.workers, [BUILD_PROFILE, REVIEW_PROFILE]);
    assert.equal(workspace.workspace.routes[0]?.step, 'implement');
    assert.equal(thread.activeAgent, BUILD_PROFILE);

    await orch.setParallel(thread.id, true);

    const firstBuild = orch.send(thread.id, BUILD_PROFILE, 'first from build');
    await waitFor(() => orch.state(thread.id).pendingApprovals.length === 1, 'build approval did not arrive');
    orch.resolveApproval(thread.id, pendingApprovalId(orch, thread.id, BUILD_PROFILE), 'allow');
    await firstBuild;

    let summary = orch.store.get(thread.id);
    assert.equal(summary?.nativeSessions[BUILD_PROFILE], `session:${BUILD_PROFILE}`);
    assert.ok((summary?.watermarks[BUILD_PROFILE] ?? 0) > 0);
    assert.equal(summary?.nativeSessions[REVIEW_PROFILE], undefined);
    assert.equal(summary?.watermarks[REVIEW_PROFILE] ?? 0, 0);
    assert.deepEqual(Object.keys(orch.state(thread.id).lanes), [BUILD_PROFILE]);

    const firstReview = orch.send(thread.id, REVIEW_PROFILE, 'first from review');
    await waitFor(() => orch.state(thread.id).pendingApprovals.length === 1, 'review approval did not arrive');
    const reviewPayload = payloads.get(REVIEW_PROFILE)?.[0] ?? '';
    const replay = reviewPayload.slice(
      reviewPayload.indexOf('<harness-replay>'),
      reviewPayload.indexOf('</harness-replay>') + '</harness-replay>'.length,
    );
    assert.match(replay, /claude-build/);
    assert.match(replay, /first from build/);
    assert.doesNotMatch(replay, /first from review/);
    orch.resolveApproval(thread.id, pendingApprovalId(orch, thread.id, REVIEW_PROFILE), 'allow');
    await firstReview;

    summary = orch.store.get(thread.id);
    assert.equal(summary?.activeAgent, REVIEW_PROFILE);
    assert.equal(summary?.nativeSessions[REVIEW_PROFILE], `session:${REVIEW_PROFILE}`);
    assert.ok((summary?.watermarks[REVIEW_PROFILE] ?? 0) > 0);
    assert.ok((summary?.watermarks[BUILD_PROFILE] ?? 0) < (summary?.watermarks[REVIEW_PROFILE] ?? 0));
    assert.deepEqual(Object.keys(orch.state(thread.id).lanes).sort(), [BUILD_PROFILE, REVIEW_PROFILE].sort());

    const secondBuild = orch.send(thread.id, BUILD_PROFILE, 'second from build');
    await waitFor(() => orch.state(thread.id).pendingApprovals.length === 1, 'second build approval did not arrive');
    const secondBuildPayload = payloads.get(BUILD_PROFILE)?.[1] ?? '';
    assert.match(secondBuildPayload, /claude-review/);
    orch.resolveApproval(thread.id, pendingApprovalId(orch, thread.id, BUILD_PROFILE), 'allow');
    await secondBuild;
    assert.equal(orch.store.get(thread.id)?.activeAgent, BUILD_PROFILE);

    const parallelBuild = orch.send(thread.id, BUILD_PROFILE, 'parallel build');
    const parallelReview = orch.send(thread.id, REVIEW_PROFILE, 'parallel review');
    await waitFor(() => orch.state(thread.id).pendingApprovals.length === 2, 'parallel approvals did not arrive');
    assert.deepEqual(orch.state(thread.id).busy.sort(), [BUILD_PROFILE, REVIEW_PROFILE].sort());
    const buildApproval = pendingApprovalId(orch, thread.id, BUILD_PROFILE);
    const reviewApproval = pendingApprovalId(orch, thread.id, REVIEW_PROFILE);
    orch.resolveApproval(thread.id, buildApproval, 'allow');
    await waitFor(() => orch.state(thread.id).pendingApprovals.length === 1, 'resolving build approval broadcast to review');
    assert.ok(orch.state(thread.id).pendingApprovals.some((approval) => approval.approvalId === reviewApproval));
    orch.resolveApproval(thread.id, reviewApproval, 'allow');
    await Promise.all([parallelBuild, parallelReview]);

    summary = orch.store.get(thread.id);
    assert.equal(summary?.nativeSessions[BUILD_PROFILE], `session:${BUILD_PROFILE}`);
    assert.equal(summary?.nativeSessions[REVIEW_PROFILE], `session:${REVIEW_PROFILE}`);
    assert.equal(orch.state(thread.id).busy.length, 0);
    assert.deepEqual(created, [
      { profileId: BUILD_PROFILE, targetId: SHARED_TARGET_ID },
      { profileId: REVIEW_PROFILE, targetId: SHARED_TARGET_ID },
    ]);

    const workerEvents = orch.store.events(thread.id).filter((event) => event.agent === 'claude');
    assert.ok(workerEvents.length > 0);
    assert.ok(workerEvents.filter((event) => event.profileId === BUILD_PROFILE).length > 0);
    assert.ok(workerEvents.filter((event) => event.profileId === REVIEW_PROFILE).length > 0);
    assert.ok(workerEvents.every((event) => event.profileId === BUILD_PROFILE || event.profileId === REVIEW_PROFILE));
  } finally {
    await orch.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy provider-only events resolve their profile in memory without rewriting the log', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'awos-profile-legacy-data-'));
  const threadId = 'legacy-thread';
  const threadDir = join(dataDir, 'threads', threadId);
  mkdirSync(threadDir, { recursive: true });
  const legacyEvent = {
    id: 'legacy-event',
    seq: 1,
    threadId,
    agent: 'claude',
    turnId: 'legacy-turn',
    ts: 1,
    kind: 'message.completed',
    itemId: 'legacy-message',
    text: 'legacy transcript',
  };
  writeFileSync(join(threadDir, 'meta.json'), JSON.stringify({
    id: threadId,
    title: 'legacy',
    cwd: '/legacy',
    createdAt: 1,
    updatedAt: 1,
    activeAgent: 'claude',
    nativeSessions: { claude: 'legacy-session' },
    watermarks: { claude: 1 },
    eventCount: 1,
    workItemId: null,
    parallel: false,
  }), 'utf8');
  const eventsPath = join(threadDir, 'events.jsonl');
  writeFileSync(eventsPath, `${JSON.stringify(legacyEvent)}\n`, 'utf8');

  try {
    const store = new ThreadStore(dataDir);
    const loaded = store.events(threadId)[0];
    assert.equal(loaded?.agent, 'claude');
    assert.equal(loaded?.profileId, 'claude');
    assert.equal(store.get(threadId)?.nativeSessions.claude, 'legacy-session');
    assert.equal(store.get(threadId)?.watermarks.claude, 1);
    assert.doesNotMatch(readFileSync(eventsPath, 'utf8'), /profileId/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('replay filters shared-provider history by profile identity', () => {
  const event = (profileId: WorkerProfileId, text: string, seq: number): HarnessEvent => ({
    id: `event-${seq}`,
    seq,
    threadId: 'thread',
    agent: 'claude',
    profileId,
    turnId: `turn-${seq}`,
    ts: seq,
    kind: 'message.completed',
    itemId: `message-${seq}`,
    text,
  });
  const result = buildReplay(
    [event(BUILD_PROFILE, 'build history', 1), event(REVIEW_PROFILE, 'review history', 2)],
    REVIEW_PROFILE,
    { maxChars: 10_000, maxToolOutput: 800 },
  );
  assert.match(result.preamble ?? '', /build history/);
  assert.doesNotMatch(result.preamble ?? '', /review history/);
});
