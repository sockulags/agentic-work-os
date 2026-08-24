import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
  createExpectationSet,
  createTransitionEvaluation,
  type CandidateIdentity,
  type HarnessEvent,
  type TransitionEvaluation,
} from '@awos/protocol';
import { Orchestrator, TransitionEvaluationConflictError } from './orchestrator.js';
import type { HarnessConfig } from './config.js';
import { foldTransitionEvaluationConflicts, foldTransitionEvaluationHistory } from './work/ledger.js';
import { ThreadStore } from './store/thread-store.js';

const dataDirs: string[] = [];
const orchestrators: Orchestrator[] = [];

function config(dataDir: string): HarnessConfig {
  return {
    dataDir,
    claudeBin: process.execPath,
    codexBin: process.execPath,
    claudeBinArgs: [],
    codexBinArgs: [],
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
    humanAuthorityToken: 'evaluation-cas-human-secret',
  };
}

function candidate(id: string): CandidateIdentity {
  return {
    kind: 'working-tree',
    id,
    revision: `revision-${id}`,
    digest: `digest-${id}`,
    pinned: true,
  };
}

const expectationSet = createExpectationSet({
  expectationSetId: 'evaluation-cas-set',
  manifestDigest: 'evaluation-cas-manifest',
  items: [{
    id: 'requirement',
    kind: 'requirement',
    name: 'Requirement',
    enforcement: 'required',
    allowOverride: false,
    reference: {
      sourceKind: 'repository-file',
      locator: 'identity://evaluation-cas',
      nativeRevision: 'revision-1',
      contentDigest: 'digest-1',
      selector: null,
    },
  }],
  authority: { sourceOwner: 'project', pinnedBy: 'user' },
  scope: { workItemId: null, sourceStepId: 'implement', targetStepId: 'review' },
  supersedes: null,
});

function refusal() {
  return {
    unmetRequirementIds: ['requirement'],
    reason: 'The requirement is not satisfied.',
    required: {
      kind: 'evidence' as const,
      evidence: { requirementIds: ['requirement'], description: 'Provide the required evidence.' },
    },
    responsibleActor: 'user' as const,
    nextAction: 'correct-candidate' as const,
    retryable: true,
  };
}

function evaluation(
  transitionId: string,
  attempt: number,
  runId: string | null,
  previous?: TransitionEvaluation,
): TransitionEvaluation {
  return createTransitionEvaluation({
    transitionId,
    attempt,
    runId,
    actor: 'user',
    sourceStepId: 'implement',
    targetStepId: 'review',
    expectationSetId: expectationSet.expectationSetId,
    candidate: candidate(`candidate-${attempt}`),
    evidenceIds: [],
    facts: [{
      requirementId: 'requirement',
      state: 'failed',
      observation: 'failed',
      evidenceIds: [],
      provenance: {
        evaluatorId: 'evaluation-cas',
        evaluatorVersion: '1',
        evaluatorClass: 'deterministic',
        expectationSetId: expectationSet.expectationSetId,
        candidate: candidate(`candidate-${attempt}`),
        evidenceIds: [],
        validity: 'current',
        detail: null,
      },
      detail: 'not satisfied',
    }],
    provenance: [{
      evaluatorId: 'evaluation-cas',
      evaluatorVersion: '1',
      evaluatorClass: 'deterministic',
      expectationSetId: expectationSet.expectationSetId,
      candidate: candidate(`candidate-${attempt}`),
      evidenceIds: [],
      validity: 'current',
      detail: null,
    }],
    enforcement: [{ requirementId: 'requirement', enforcement: 'required', allowOverride: false }],
    timestamp: attempt,
    verdict: 'retry',
    refusal: refusal(),
    override: null,
    previous,
  } as Parameters<typeof createTransitionEvaluation>[0]);
}

afterEach(async () => {
  while (orchestrators.length > 0) await orchestrators.pop()!.stop();
  while (dataDirs.length > 0) rmSync(dataDirs.pop()!, { recursive: true, force: true });
});

describe('evaluation persistence CAS', () => {
  test('independent Orchestrators race one planning transition, then a fresh call creates only attempt two', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'awos-evaluation-cas-'));
    dataDirs.push(dataDir);
    const first = new Orchestrator(config(dataDir));
    orchestrators.push(first);
    await first.start();
    const thread = first.createThread({ cwd: dataDir });

    const second = new Orchestrator(config(dataDir));
    orchestrators.push(second);
    await second.start();

    const inputs = {
      sourceStepId: 'implement',
      targetStepId: 'review',
      candidate: candidate('planning'),
      transitionId: 'planning-race',
    };
    const raced = await Promise.allSettled([
      first.evaluatePlanningTransition(thread.id, inputs),
      second.evaluatePlanningTransition(thread.id, inputs),
    ]);
    assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = raced.find((result) => result.status === 'rejected');
    assert.ok(rejected?.status === 'rejected');
    assert.ok(rejected.reason instanceof TransitionEvaluationConflictError);

    const initial = first.store.events(thread.id).filter((event) =>
      (event.kind === 'transition.evaluated' || event.kind === 'gate.evaluated') &&
      event.evaluation?.transitionId === 'planning-race',
    );
    assert.equal(initial.length, 1);
    assert.equal(initial[0]?.kind === 'transition.evaluated' ? initial[0].evaluation.attempt : null, 1);

    await first.evaluatePlanningTransition(thread.id, inputs);
    const restarted = new Orchestrator(config(dataDir));
    orchestrators.push(restarted);
    await restarted.start();
    const history = foldTransitionEvaluationHistory(restarted.store.events(thread.id)).get('planning-race') ?? [];
    assert.deepEqual(history.map((item) => item.attempt), [1, 2]);
    assert.equal(new Set(history.map((item) => `${item.transitionId}:${item.attempt}`)).size, 2);
    assert.equal(foldTransitionEvaluationConflicts(restarted.store.events(thread.id)).has('planning-race'), false);
  });

  test('independent stores serialize integration and recovery evaluations, reject duplicates, and fold uniquely after restart', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'awos-evaluation-cas-store-'));
    dataDirs.push(dataDir);
    const seed = new ThreadStore(dataDir);
    const thread = seed.create({ cwd: dataDir });
    seed.append(thread.id, null, { kind: 'expectation.set.created', expectationSet });
    const initial = evaluation('integration-recovery-race', 1, null);
    seed.append(thread.id, null, { kind: 'transition.evaluated', evaluation: initial });

    const first = new ThreadStore(dataDir);
    const second = new ThreadStore(dataDir);
    const expectedHead = first.head(thread.id);
    const buildGate = (canonical: { latestAttempt: (transitionId: string) => number | null }) => {
      const next = evaluation('integration-recovery-race', (canonical.latestAttempt('integration-recovery-race') ?? 0) + 1, 'integration-run', initial);
      return {
        entries: [{
          agent: 'claude' as const,
          body: {
            kind: 'gate.evaluated' as const,
            gate: 'lane.integration' as const,
            allowed: false,
            candidate: { commit: next.candidate.revision, tree: next.candidate.digest, dirty: false },
            requirements: [],
            override: null,
            evaluation: next,
          },
        }],
        value: next,
      };
    };
    const raced = [
      first.compareAndAppendBatch(thread.id, expectedHead, {
        transitionId: 'integration-recovery-race',
        expectedAttempt: 1,
        build: buildGate,
      }),
      second.compareAndAppendBatch(thread.id, expectedHead, {
        transitionId: 'integration-recovery-race',
        expectedAttempt: 1,
        build: buildGate,
      }),
    ];
    assert.equal(raced.filter((result) => result !== null).length, 1);

    const fresh = new ThreadStore(dataDir);
    const currentHead = fresh.head(thread.id);
    const recovery = fresh.compareAndAppendBatch(thread.id, currentHead, {
      transitionId: 'integration-recovery-race',
      expectedAttempt: 2,
      build: (canonical) => {
        const next = evaluation('integration-recovery-race', (canonical.latestAttempt('integration-recovery-race') ?? 0) + 1, 'recovery-run', initial);
        return { entries: [{ agent: null, body: { kind: 'transition.evaluated', evaluation: next } }], value: next };
      },
    });
    assert.ok(recovery !== null);

    const restarted = new ThreadStore(dataDir);
    const events = restarted.events(thread.id);
    const history = foldTransitionEvaluationHistory(events).get('integration-recovery-race') ?? [];
    assert.deepEqual(history.map((item) => item.attempt), [1, 2, 3]);
    assert.equal(events.filter((event) => event.kind === 'gate.evaluated' && event.evaluation?.transitionId === 'integration-recovery-race').length, 1);
    assert.equal(new Set(history.map((item) => `${item.transitionId}:${item.attempt}`)).size, 3);
    assert.equal(foldTransitionEvaluationConflicts(events).has('integration-recovery-race'), false);
  });
});
