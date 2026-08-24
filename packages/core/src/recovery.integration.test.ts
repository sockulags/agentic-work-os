import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, describe, afterEach } from 'node:test';
import { WebSocket, type RawData } from 'ws';
import type { CandidateIdentity } from '@awos/protocol';
import { createTransitionEvaluation, WORKSPACE_FILE, WORKSPACE_SCHEMA_VERSION } from '@awos/protocol';
import { Orchestrator } from './orchestrator.js';
import type { HarnessConfig } from './config.js';
import { HarnessServer } from './server.js';
import { candidateIdentity } from './work/gate.js';
import { RecoveryConflictError } from './work/recovery.js';
import { ThreadStore } from './store/thread-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(here, 'testing', 'fake-claude.js');

const dataDirs: string[] = [];
const repos: string[] = [];
const orchestrators: Orchestrator[] = [];

function config(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  const dataDir = mkdtempSync(join(tmpdir(), 'awos-recovery-data-'));
  dataDirs.push(dataDir);
  return {
    dataDir,
    claudeBin: process.execPath,
    codexBin: process.execPath,
    claudeBinArgs: [FAKE_CLAUDE, '--recovery-edit'],
    codexBinArgs: [FAKE_CLAUDE],
    claudeModel: '',
    codexModel: '',
    host: '127.0.0.1',
    port: 0,
    replayMaxChars: 24_000,
    replayMaxToolOutput: 800,
    interruptGraceMs: 1_000,
    approvalTimeoutMs: 5_000,
    codexInitTimeoutMs: 10_000,
    laneSetup: '',
    laneSetupTimeoutMs: 60_000,
    ghBin: process.execPath,
    ghBinArgs: [],
    ghTimeoutMs: 5_000,
    humanAuthorityToken: 'recovery-human-secret',
    ...overrides,
  };
}

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'awos-recovery-repo-'));
  repos.push(cwd);
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
  writeFileSync(join(cwd, 'seed.txt'), 'seed\n');
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd });
  return cwd;
}

function declare(
  cwd: string,
  guardrail: Record<string, unknown>,
  workers: string[] = ['claude'],
  verify: Array<{ name: string; command: string }> = [],
): void {
  mkdirSync(join(cwd, '.awos'), { recursive: true });
  writeFileSync(join(cwd, WORKSPACE_FILE), JSON.stringify({
    version: WORKSPACE_SCHEMA_VERSION,
    name: 'recovery-test',
    agents: workers,
    roles: [
      { id: 'implementer', label: 'Implementer' },
      { id: 'reviewer', label: 'Reviewer' },
    ],
    steps: [
      { id: 'implement', action: 'Implement', role: 'implementer', workers },
      { id: 'review', action: 'Review', role: 'reviewer', workers },
    ],
    verify,
    guardrails: [guardrail],
  }), 'utf8');
}

function work(orch: Orchestrator, threadId: string, cwd: string): void {
  const item = orch.work.record({
    workspaceRoot: cwd,
    ref: { repo: 'owner/repo', number: 59, url: 'https://github.com/owner/repo/issues/59' },
    snapshot: {
      title: 'Recovery', body: 'Recover refused transitions', state: 'OPEN', labels: [], author: 'user', revision: 'issue-1',
    },
  });
  orch.store.update(threadId, { workItemId: item.id });
}

function candidate(id: string): CandidateIdentity {
  return { kind: 'working-tree', id, revision: `revision-${id}`, digest: `digest-${id}`, pinned: true };
}

function recoveryVersion(cycle: { head: number; transitionId: string; latestEvaluation: { attempt: number } | null }) {
  return {
    expectedAttempt: cycle.latestEvaluation?.attempt ?? 0,
    expectedTransitionId: cycle.transitionId,
    expectedHead: cycle.head,
  };
}

async function boot(overrides: Partial<HarnessConfig> = {}): Promise<{ orch: Orchestrator; threadId: string; cwd: string }> {
  const orch = new Orchestrator(config(overrides));
  orchestrators.push(orch);
  await orch.start();
  const cwd = repo();
  const thread = orch.createThread({ cwd });
  work(orch, thread.id, cwd);
  return { orch, threadId: thread.id, cwd };
}

function sharedConfig(dataDir: string): HarnessConfig {
  return { ...config(), dataDir };
}

afterEach(async () => {
  while (orchestrators.length > 0) await orchestrators.pop()!.stop();
  while (dataDirs.length > 0) rmSync(dataDirs.pop()!, { recursive: true, force: true });
  while (repos.length > 0) rmSync(repos.pop()!, { recursive: true, force: true });
});

describe('durable recovery cycle', () => {
  test('runs the default two correction runs after the initial evaluation, for three evaluations total', async () => {
    const { orch, threadId, cwd } = await boot();
    declare(cwd, {
      id: 'visual',
      kind: 'evidence-present',
      attach: { step: 'review' },
      enforcement: 'required',
      allowOverride: true,
      parameters: { expectationItem: 'prototype.dashboard', evidenceKind: 'artifact' },
      correction: { onExhausted: 'waiting-for-human' },
    });

    const initial = await orch.evaluatePlanningTransition(threadId, {
      sourceStepId: 'implement', targetStepId: 'review', candidate: candidate('initial'), transitionId: 'visual-transition',
    });
    assert.equal(initial.verdict, 'retry');

    const cycle = await orch.startRecovery(threadId, {
      transitionId: 'visual-transition', expectedAttempt: initial.evaluation.attempt, agent: 'claude',
    });
    assert.equal(cycle?.maxRuns, 2);
    assert.equal(cycle?.maxEvaluations, 3);
    assert.equal(cycle?.correctionsUsed, 2);
    assert.equal(cycle?.evaluationsUsed, 3);
    assert.equal(cycle?.status, 'waiting-human');
    assert.equal(cycle?.escalation?.reason, 'exhausted');
    assert.equal(cycle?.correctionRuns.length, 2);
    assert.ok(cycle?.correctionRuns.every((run) => run.context.blocker.required.kind === 'evidence'));
    assert.ok(cycle?.correctionRuns.every((run) => run.context.evaluation.provenance.length === 1));
    assert.equal(new Set(cycle?.correctionRuns.map((run) => run.runId)).size, 2);
    assert.equal(
      orch.store.events(threadId).filter((event) => event.kind === 'run.started' && event.recoveryContext !== undefined).length,
      2,
    );
  });

  test('keeps a human question waiting until a valid typed answer opens the transition', async () => {
    const { orch, threadId, cwd } = await boot();
    declare(cwd, {
      id: 'scope-question',
      kind: 'mandatory-answer',
      attach: { step: 'review' },
      enforcement: 'required',
      parameters: { expectationItem: 'question.scope', authority: 'user' },
    });
    const initial = await orch.evaluatePlanningTransition(threadId, {
      sourceStepId: 'implement', targetStepId: 'review', candidate: candidate('question'), transitionId: 'question-transition',
    });
    assert.equal(initial.verdict, 'waiting-for-human');
    const waiting = await orch.startRecovery(threadId, {
      transitionId: 'question-transition', expectedAttempt: initial.evaluation.attempt, agent: 'claude',
    });
    assert.equal(waiting?.status, 'waiting-human');
    await assert.rejects(
      orch.applyRecoveryAction(threadId, {
        kind: 'answer', cycleId: waiting!.cycleId, ...recoveryVersion(waiting!), questionId: 'wrong', expectationItemId: 'wrong',
        expectationSetId: initial.evaluation.expectationSetId, answer: { type: 'choice', value: 'keep' },
        candidate: candidate('question'), humanCredential: 'recovery-human-secret',
      }),
      /does not match/,
    );
    const answered = await orch.applyRecoveryAction(threadId, {
      kind: 'answer', cycleId: waiting!.cycleId, ...recoveryVersion(waiting!), questionId: 'question.scope', expectationItemId: 'question.scope',
      expectationSetId: initial.evaluation.expectationSetId, answer: { type: 'choice', value: 'keep' },
      candidate: candidate('question'), answerId: 'answer-59', humanCredential: 'recovery-human-secret',
    });
    assert.equal(answered?.status, 'passed');
    assert.equal(answered?.actions.at(-1)?.authority, 'user');
    assert.equal(answered?.actions.at(-1)?.questionId, 'question.scope');
  });

  test('does not persist a staged answer when another store advances the head before evaluation CAS', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'awos-recovery-action-answer-'));
    dataDirs.push(dataDir);
    const orch = new Orchestrator(sharedConfig(dataDir));
    orchestrators.push(orch);
    await orch.start();
    const cwd = repo();
    const thread = orch.createThread({ cwd });
    work(orch, thread.id, cwd);
    declare(cwd, {
      id: 'scope-question',
      kind: 'mandatory-answer',
      attach: { step: 'review' },
      enforcement: 'required',
      parameters: { expectationItem: 'question.scope', authority: 'user' },
    });
    const initial = await orch.evaluatePlanningTransition(thread.id, {
      sourceStepId: 'implement', targetStepId: 'review', candidate: candidate('atomic-answer'), transitionId: 'atomic-answer-transition',
    });
    const waiting = await orch.startRecovery(thread.id, {
      transitionId: 'atomic-answer-transition', expectedAttempt: initial.evaluation.attempt, agent: 'claude',
    });
    assert.equal(waiting?.status, 'waiting-human');
    const displayed = recoveryVersion(waiting!);
    const actionPromise = orch.applyRecoveryAction(thread.id, {
      kind: 'answer', cycleId: waiting!.cycleId, ...displayed,
      questionId: 'question.scope', expectationItemId: 'question.scope',
      expectationSetId: initial.evaluation.expectationSetId,
      answer: { type: 'choice', value: 'keep' }, candidate: candidate('atomic-answer'), answerId: 'atomic-answer-id',
      humanCredential: 'recovery-human-secret',
    });
    const otherStore = new ThreadStore(dataDir);
    otherStore.append(thread.id, null, { kind: 'plan.updated', items: [] });
    await assert.rejects(
      actionPromise,
      (error: unknown) => error instanceof RecoveryConflictError,
    );
    let events = orch.store.events(thread.id);
    assert.equal(events.filter((event) => event.kind === 'recovery.action.recorded').length, 0);
    assert.equal(events.filter((event) => event.kind === 'answer.recorded').length, 0);
    assert.equal(events.filter((event) => event.kind === 'transition.evaluated').length, 1);

    const fresh = orch.getRecovery(thread.id, { cycleId: waiting!.cycleId });
    const answered = await orch.applyRecoveryAction(thread.id, {
      kind: 'answer', cycleId: waiting!.cycleId, ...recoveryVersion(fresh!),
      questionId: 'question.scope', expectationItemId: 'question.scope',
      expectationSetId: initial.evaluation.expectationSetId,
      answer: { type: 'choice', value: 'keep' }, candidate: candidate('atomic-answer'), answerId: 'atomic-answer-id',
      humanCredential: 'recovery-human-secret',
    });
    assert.equal(answered?.status, 'passed');
    events = orch.store.events(thread.id);
    assert.deepEqual(
      events.slice(-3).map((event) => event.kind),
      ['recovery.action.recorded', 'answer.recorded', 'transition.evaluated'],
    );
  });

  test('does not persist a staged repin when another store advances the head before evaluation CAS', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'awos-recovery-action-repin-'));
    dataDirs.push(dataDir);
    const orch = new Orchestrator(sharedConfig(dataDir));
    orchestrators.push(orch);
    await orch.start();
    const cwd = repo();
    const thread = orch.createThread({ cwd });
    work(orch, thread.id, cwd);
    declare(cwd, {
      id: 'visual', kind: 'evidence-present', attach: { step: 'review' }, enforcement: 'required', allowOverride: true,
      parameters: { expectationItem: 'prototype.dashboard', evidenceKind: 'artifact' },
      correction: { maxRuns: 0, onExhausted: 'waiting-for-human' },
    });
    const initial = await orch.evaluatePlanningTransition(thread.id, {
      sourceStepId: 'implement', targetStepId: 'review', candidate: candidate('atomic-repin-old'), transitionId: 'atomic-repin-old',
    });
    const waiting = await orch.startRecovery(thread.id, {
      transitionId: 'atomic-repin-old', expectedAttempt: initial.evaluation.attempt, agent: 'claude',
    });
    assert.equal(waiting?.status, 'waiting-human');
    const displayed = recoveryVersion(waiting!);
    const actionPromise = orch.applyRecoveryAction(thread.id, {
      kind: 'repin', cycleId: waiting!.cycleId, ...displayed,
      sourceStepId: 'implement', targetStepId: 'review', candidate: candidate('atomic-repin-new'),
      humanCredential: 'recovery-human-secret',
    });
    const otherStore = new ThreadStore(dataDir);
    otherStore.append(thread.id, null, { kind: 'plan.updated', items: [] });
    await assert.rejects(
      actionPromise,
      (error: unknown) => error instanceof RecoveryConflictError,
    );
    let events = orch.store.events(thread.id);
    assert.equal(events.filter((event) => event.kind === 'recovery.action.recorded').length, 0);
    assert.equal(events.filter((event) => event.kind === 'recovery.cycle.cancelled').length, 0);
    assert.equal(events.filter((event) => event.kind === 'transition.evaluated').length, 1);

    const fresh = orch.getRecovery(thread.id, { cycleId: waiting!.cycleId });
    await orch.applyRecoveryAction(thread.id, {
      kind: 'repin', cycleId: waiting!.cycleId, ...recoveryVersion(fresh!),
      sourceStepId: 'implement', targetStepId: 'review', candidate: candidate('atomic-repin-new'),
      humanCredential: 'recovery-human-secret',
    });
    events = orch.store.events(thread.id);
    assert.deepEqual(
      events.slice(-3).map((event) => event.kind),
      ['recovery.action.recorded', 'recovery.cycle.cancelled', 'transition.evaluated'],
    );
  });

  test('does not persist a staged evaluator retry when another store advances the head before evaluation CAS', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'awos-recovery-action-retry-'));
    dataDirs.push(dataDir);
    const orch = new Orchestrator(sharedConfig(dataDir));
    orchestrators.push(orch);
    await orch.start();
    const cwd = repo();
    const thread = orch.createThread({ cwd });
    declare(cwd, {
      id: 'visual', kind: 'evidence-present', attach: { step: 'review' }, enforcement: 'required', allowOverride: true,
      parameters: { expectationItem: 'prototype.dashboard', evidenceKind: 'artifact' },
      correction: { maxRuns: 0, onExhausted: 'waiting-for-human' },
    });
    const initial = await orch.evaluatePlanningTransition(thread.id, {
      sourceStepId: 'implement', targetStepId: 'review', candidate: candidate('atomic-retry'), transitionId: 'atomic-retry-transition',
    });
    assert.ok(initial.evaluation.refusal);
    const transient = createTransitionEvaluation({
      ...initial.evaluation,
      attempt: initial.evaluation.attempt + 1,
      runId: null,
      facts: initial.evaluation.facts.map((fact) => ({
        ...fact,
        state: 'unknown' as const,
        observation: 'unknown' as const,
        provenance: { ...fact.provenance, validity: 'unavailable' as const },
        detail: 'evaluator unavailable',
      })),
      provenance: initial.evaluation.provenance.map((provenance) => ({ ...provenance, validity: 'unavailable' as const })),
      verdict: 'retry' as const,
      refusal: {
        ...initial.evaluation.refusal,
        nextAction: 'correct-candidate' as const,
        retryable: true,
      },
      override: null,
      previous: initial.evaluation,
    } as Parameters<typeof createTransitionEvaluation>[0]);
    orch.store.append(thread.id, null, { kind: 'transition.evaluated', evaluation: transient });
    const waiting = await orch.startRecovery(thread.id, {
      transitionId: 'atomic-retry-transition', expectedAttempt: transient.attempt, agent: 'claude',
    });
    assert.equal(waiting?.status, 'waiting-human');
    assert.equal(waiting?.waiting?.reason, 'transient-evaluator');
    const displayed = recoveryVersion(waiting!);
    const actionPromise = orch.applyRecoveryAction(thread.id, {
      kind: 'retry-evaluator', cycleId: waiting!.cycleId, ...displayed,
      humanCredential: 'recovery-human-secret',
    });
    const otherStore = new ThreadStore(dataDir);
    otherStore.append(thread.id, null, { kind: 'plan.updated', items: [] });
    await assert.rejects(
      actionPromise,
      (error: unknown) => error instanceof RecoveryConflictError,
    );
    let events = orch.store.events(thread.id);
    assert.equal(events.filter((event) => event.kind === 'recovery.action.recorded').length, 0);
    assert.equal(events.filter((event) => event.kind === 'transition.evaluated').length, 2);

    const fresh = orch.getRecovery(thread.id, { cycleId: waiting!.cycleId });
    const retried = await orch.applyRecoveryAction(thread.id, {
      kind: 'retry-evaluator', cycleId: waiting!.cycleId, ...recoveryVersion(fresh!),
      humanCredential: 'recovery-human-secret',
    });
    assert.ok(retried);
    events = orch.store.events(thread.id);
    assert.deepEqual(
      events.slice(-2).map((event) => event.kind),
      ['recovery.action.recorded', 'transition.evaluated'],
    );
  });

  test('rejects a stale typed action as a structured conflict without recording authority', async () => {
    const { orch, threadId, cwd } = await boot();
    declare(cwd, {
      id: 'scope-question',
      kind: 'mandatory-answer',
      attach: { step: 'review' },
      enforcement: 'required',
      parameters: { expectationItem: 'question.scope', authority: 'user' },
    });
    const initial = await orch.evaluatePlanningTransition(threadId, {
      sourceStepId: 'implement', targetStepId: 'review', candidate: candidate('stale'), transitionId: 'stale-transition',
    });
    const waiting = await orch.startRecovery(threadId, {
      transitionId: 'stale-transition', expectedAttempt: initial.evaluation.attempt, agent: 'claude',
    });
    assert.ok(waiting);
    const displayed = recoveryVersion(waiting);
    await orch.evaluatePlanningTransition(threadId, {
      sourceStepId: 'implement', targetStepId: 'review', candidate: candidate('stale'), transitionId: 'stale-transition',
    });

    await assert.rejects(
      orch.applyRecoveryAction(threadId, {
        kind: 'answer', cycleId: waiting!.cycleId, ...displayed,
        questionId: 'question.scope', expectationItemId: 'question.scope',
        expectationSetId: initial.evaluation.expectationSetId,
        answer: { type: 'choice', value: 'keep' }, candidate: candidate('stale'),
        humanCredential: 'recovery-human-secret',
      }),
      (error: unknown) => {
        assert.ok(error instanceof RecoveryConflictError);
        assert.equal(error.conflict.kind, 'stale-action');
        assert.equal(error.conflict.expectedAttempt, 1);
        assert.equal(error.conflict.actualAttempt, 2);
        return true;
      },
    );
    const events = orch.store.events(threadId);
    assert.equal(events.filter((event) => event.kind === 'recovery.action.recorded').length, 0);
    assert.equal(events.filter((event) => event.kind === 'answer.recorded').length, 0);
  });

  test('core-generated repin identity starts attempt one, supersedes the old transition, and rejects reuse', async () => {
    const { orch, threadId, cwd } = await boot();
    declare(cwd, {
      id: 'visual',
      kind: 'evidence-present',
      attach: { step: 'review' },
      enforcement: 'required',
      parameters: { expectationItem: 'prototype.dashboard', evidenceKind: 'artifact' },
      correction: { maxRuns: 0, onExhausted: 'waiting-for-human' },
    });
    const initial = await orch.evaluatePlanningTransition(threadId, {
      sourceStepId: 'implement', targetStepId: 'review', candidate: candidate('repin-old'), transitionId: 'repin-old-transition',
    });
    const waiting = await orch.startRecovery(threadId, {
      transitionId: 'repin-old-transition', expectedAttempt: initial.evaluation.attempt, agent: 'claude',
    });
    assert.equal(waiting?.status, 'waiting-human');
    const displayed = recoveryVersion(waiting!);
    await orch.applyRecoveryAction(threadId, {
      kind: 'repin', cycleId: waiting!.cycleId, ...displayed,
      sourceStepId: 'implement', targetStepId: 'review', candidate: candidate('repin-new'),
      humanCredential: 'recovery-human-secret',
    });

    const events = orch.store.events(threadId);
    const oldCycle = orch.getRecovery(threadId, { cycleId: waiting!.cycleId });
    assert.equal(oldCycle?.cancelled, true);
    const repinAction = events.find(
      (event) => event.kind === 'recovery.action.recorded' && event.action.kind === 'repin',
    );
    assert.equal(repinAction?.kind, 'recovery.action.recorded');
    assert.notEqual(repinAction?.action.supersededByTransitionId, 'repin-old-transition');
    const newEvaluation = events
      .filter((event): event is Extract<typeof event, { kind: 'transition.evaluated' }> => event.kind === 'transition.evaluated')
      .find((event) => event.evaluation.transitionId !== 'repin-old-transition');
    assert.ok(newEvaluation);
    assert.equal(newEvaluation.evaluation.attempt, 1);
    assert.equal(newEvaluation.evaluation.supersedesTransitionId, 'repin-old-transition');
    assert.equal(repinAction?.action.supersededByTransitionId, newEvaluation.evaluation.transitionId);

    await assert.rejects(
      orch.applyRecoveryAction(threadId, {
        kind: 'repin', cycleId: waiting!.cycleId, ...displayed,
        sourceStepId: 'implement', targetStepId: 'review', candidate: candidate('repin-again'),
        humanCredential: 'recovery-human-secret',
      }),
      (error: unknown) => error instanceof RecoveryConflictError,
    );
    assert.equal(orch.store.events(threadId).filter((event) => event.kind === 'recovery.action.recorded').length, 1);
  });

  test('recovery action RPC returns a typed conflict instead of a generic error', async () => {
    const { orch, threadId, cwd } = await boot();
    declare(cwd, {
      id: 'scope-question', kind: 'mandatory-answer', attach: { step: 'review' }, enforcement: 'required',
      parameters: { expectationItem: 'question.scope', authority: 'user' },
    });
    const initial = await orch.evaluatePlanningTransition(threadId, {
      sourceStepId: 'implement', targetStepId: 'review', candidate: candidate('rpc-stale'), transitionId: 'rpc-stale-transition',
    });
    const waiting = await orch.startRecovery(threadId, {
      transitionId: 'rpc-stale-transition', expectedAttempt: initial.evaluation.attempt, agent: 'claude',
    });
    assert.ok(waiting);
    const displayed = recoveryVersion(waiting);
    await orch.evaluatePlanningTransition(threadId, {
      sourceStepId: 'implement', targetStepId: 'review', candidate: candidate('rpc-stale'), transitionId: 'rpc-stale-transition',
    });

    const server = new HarnessServer(config(), orch);
    const port = await server.listen();
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const request = (type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const requestId = `${type}-${Math.random()}`;
      return new Promise((resolve, reject) => {
        const onMessage = (raw: RawData): void => {
          const message = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (message.requestId !== requestId) return;
          socket.off('message', onMessage);
          clearTimeout(timer);
          resolve(message);
        };
        socket.on('message', onMessage);
        socket.send(JSON.stringify({ type, requestId, ...payload }));
        const timer = setTimeout(() => {
          socket.off('message', onMessage);
          reject(new Error(`Timed out waiting for ${type}`));
        }, 5_000);
      });
    };

    try {
      await request('hello', { token: server.token });
      const response = await request('recovery.action', {
        threadId,
        action: {
          kind: 'answer', cycleId: waiting!.cycleId, ...displayed,
          questionId: 'question.scope', expectationItemId: 'question.scope',
          expectationSetId: initial.evaluation.expectationSetId,
          answer: { type: 'choice', value: 'keep' }, candidate: candidate('rpc-stale'),
          humanCredential: 'recovery-human-secret',
        },
      });
      assert.equal(response.type, 'recovery.conflict');
      assert.equal((response.conflict as { kind: string }).kind, 'stale-action');
    } finally {
      socket.close();
      await server.close();
    }
  });

  test('waits durably for an unavailable explicitly selected worker without substitution', async () => {
    const { orch, threadId, cwd } = await boot({ qwenBaseUrl: 'http://127.0.0.1:1/v1' });
    declare(cwd, {
      id: 'visual', kind: 'evidence-present', attach: { step: 'review' }, enforcement: 'required', allowOverride: true,
      parameters: { expectationItem: 'prototype.dashboard', evidenceKind: 'artifact' },
    }, ['qwen-local']);
    const initial = await orch.evaluatePlanningTransition(threadId, {
      sourceStepId: 'implement', targetStepId: 'review', candidate: candidate('unavailable'), transitionId: 'unavailable-transition',
    });
    const cycle = await orch.startRecovery(threadId, {
      transitionId: 'unavailable-transition', expectedAttempt: initial.evaluation.attempt, agent: 'qwen-local',
    });
    assert.equal(cycle?.status, 'worker-unavailable');
    assert.equal(cycle?.worker.profileId, 'qwen-local');
    assert.equal(cycle?.correctionsUsed, 0);
    assert.equal(orch.store.events(threadId).some((event) => event.kind === 'recovery.correction.started'), false);
  });

  test('rechecks policy, authority, and reason before accepting an override', async () => {
    const { orch, threadId, cwd } = await boot();
    declare(cwd, {
      id: 'verification',
      kind: 'verification',
      attach: { step: 'review' },
      enforcement: 'required',
      allowOverride: true,
      parameters: { checks: ['failing-check'] },
      correction: { maxRuns: 0, onExhausted: 'waiting-for-human' },
    }, ['claude'], [{ name: 'failing-check', command: 'node -e "process.exit(1)"' }]);

    await orch.runCheck(threadId, 'claude', 'failing-check');
    const evidence = orch.store.events(threadId).find(
      (event) => event.kind === 'evidence.recorded' && event.check?.name === 'failing-check',
    );
    assert.equal(evidence?.kind, 'evidence.recorded');
    const currentCandidate = evidence?.kind === 'evidence.recorded'
      ? candidateIdentity(evidence.state.tree, evidence.state.commit)
      : candidate('missing');
    const initial = await orch.evaluatePlanningTransition(threadId, {
      sourceStepId: 'implement', targetStepId: 'review', candidate: currentCandidate, transitionId: 'override-transition',
    });
    assert.equal(initial.verdict, 'retry');

    const waiting = await orch.startRecovery(threadId, {
      transitionId: 'override-transition', expectedAttempt: initial.evaluation.attempt, agent: 'claude',
    });
    assert.equal(waiting?.status, 'waiting-human');
    assert.equal(waiting?.correctionsUsed, 0);

    await assert.rejects(
      orch.applyRecoveryAction(threadId, {
        kind: 'override', cycleId: waiting!.cycleId, ...recoveryVersion(waiting!), authorizedUserId: 'user-1', reason: '  ',
        humanCredential: 'recovery-human-secret',
      }),
      /non-empty reason/,
    );
    const passed = await orch.applyRecoveryAction(threadId, {
      kind: 'override', cycleId: waiting!.cycleId, ...recoveryVersion(waiting!), authorizedUserId: 'user-1',
      reason: 'The user accepted the known check failure for this candidate.',
      humanCredential: 'recovery-human-secret',
    });
    assert.equal(passed?.status, 'passed');
    assert.equal(passed?.latestEvaluation?.override?.authorizedUserId, 'user-1');
    assert.equal(passed?.actions.at(-1)?.kind, 'override');
  });

  test('two starts race to one correction reservation', async () => {
    const { orch, threadId, cwd } = await boot();
    declare(cwd, {
      id: 'visual', kind: 'evidence-present', attach: { step: 'review' }, enforcement: 'required', allowOverride: true,
      parameters: { expectationItem: 'prototype.dashboard', evidenceKind: 'artifact' },
      correction: { maxRuns: 1, onExhausted: 'waiting-for-human' },
    });
    const initial = await orch.evaluatePlanningTransition(threadId, {
      sourceStepId: 'implement', targetStepId: 'review', candidate: candidate('race'), transitionId: 'race-transition',
    });
    const results = await Promise.all([
      orch.startRecovery(threadId, { transitionId: 'race-transition', expectedAttempt: initial.evaluation.attempt, agent: 'claude' }),
      orch.startRecovery(threadId, { transitionId: 'race-transition', expectedAttempt: initial.evaluation.attempt, agent: 'claude' }),
    ]);
    const cycle = results.find((result) => result !== null) ?? orch.getRecovery(threadId, { transitionId: 'race-transition' });
    assert.equal(cycle?.correctionRuns.length, 1);
    assert.equal(orch.store.events(threadId).filter((event) => event.kind === 'recovery.correction.started').length, 1);
  });
});
