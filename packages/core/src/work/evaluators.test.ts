import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createExpectationSet,
  type AdapterEvent,
  type CandidateIdentity,
  type EvaluatorCapability,
  type EvidenceItem,
  type ExpectationItem,
  type ExpectationSet,
  type HarnessEvent,
  type PixelCaptureContract,
  type VisualEvidence,
  type WorkspaceGuardrail,
} from '@awos/protocol';
import {
  CORE_EVALUATOR_KINDS,
  CORE_EVALUATOR_REGISTRY,
  CORE_EVALUATOR_VERSION,
  EVALUATOR_DIAGNOSTIC_MAX_CHARS,
  coreExpectationManifestEntry,
  coreEvaluator,
  foldEvidence,
  evaluateGuardrail,
  evaluateGuardedTransition,
  evaluateIntegrationTransition,
  evaluateTransition,
  evaluateVerificationChecks,
  type GuardrailEvaluatorInput,
} from '../index.js';
import { evaluateOwnedGuardrails } from './evaluators.js';
import { evaluateOwnedIntegrationTransition } from './gate.js';
import { ThreadStore, type EventLogSnapshot } from '../store/thread-store.js';

const candidate: CandidateIdentity = {
  kind: 'working-tree',
  id: 'tree-a',
  revision: 'commit-a',
  digest: 'tree-a',
  pinned: true,
};

const verify = [{ name: 'test', command: 'npm test' }];

let sequence = 0;
const visualFixtureDirs: string[] = [];

after(() => {
  for (const dir of visualFixtureDirs) rmSync(dir, { recursive: true, force: true });
});

function expectation(
  id: string,
  kind: ExpectationItem['kind'] = 'requirement',
  enforcement: ExpectationItem['enforcement'] = 'required',
  authority?: ExpectationItem['authority'],
): ExpectationSet {
  const item: ExpectationItem = {
    id,
    kind,
    name: id,
    enforcement,
    allowOverride: enforcement === 'required',
    reference: {
      sourceKind: kind === 'mandatory-question' || kind === 'human-attestation' ? 'human-answer' : 'repository-file',
      locator: `identity://${id}`,
      nativeRevision: 'revision-a',
      contentDigest: `digest-${id}`,
      selector: null,
    },
    ...(authority === undefined ? {} : { authority }),
  };
  return createExpectationSet({
    expectationSetId: 'set-a',
    manifestDigest: 'manifest-a',
    items: [item],
    authority: { sourceOwner: 'project', pinnedBy: 'user' },
    supersedes: null,
  });
}

function guardrail(
  kind: WorkspaceGuardrail['kind'],
  parameters: WorkspaceGuardrail['parameters'],
): WorkspaceGuardrail {
  return {
    id: `guardrail-${kind}`,
    kind,
    attach: { step: 'review' },
    enforcement: 'required',
    allowOverride: false,
    parameters,
    correction: { maxRuns: 2, onExhausted: 'waiting-for-human' },
  };
}

function evidence(
  id: string,
  overrides: Partial<EvidenceItem> = {},
): EvidenceItem {
  return {
    id,
    runId: null,
    workItemId: null,
    threadId: 'thread-a',
    kind: 'command',
    ref: { eventId: null, url: null, label: 'npm test' },
    summary: 'ignored claim text',
    state: { commit: 'commit-a', tree: 'tree-a', dirty: false },
    check: { name: 'test', passed: true, exitCode: 0 },
    source: 'codex',
    at: ++sequence,
    ...overrides,
  };
}

const visualCapture: PixelCaptureContract = {
  browser: 'chromium/128',
  runtime: 'node/22',
  viewport: '1440x900',
  dpr: 1,
  fonts: 'fonts-v1',
  data: 'fixture-v1',
  animation: 'disabled-v1',
  region: 'main',
  selector: '#app',
};

function visualEvidence(
  kind: VisualEvidence['kind'],
  overrides: Partial<Extract<VisualEvidence, { kind: typeof kind }>> = {},
): VisualEvidence {
  const base = kind === 'pixel-diff'
      ? {
        kind,
        reference: { eventId: 'reference-event-v1', artifactId: 'reference-v1', locator: 'identity://prototype.dashboard', revision: 'revision-a', digest: 'digest-prototype.dashboard' },
        candidate: { eventId: 'candidate-event-v1', artifactId: 'candidate-v1', locator: 'artifact://candidate-v1', revision: 'candidate-revision', digest: 'candidate-image-digest' },
        capture: visualCapture,
        measurement: { comparedPixels: 100, differentPixels: 0, equal: true, exact: true },
      }
    : {
        kind,
        reference: { eventId: 'reference-event-v1', artifactId: 'reference-v1', locator: 'identity://prototype.dashboard', revision: 'revision-a', digest: 'digest-prototype.dashboard' },
        candidate: { eventId: 'candidate-event-v1', artifactId: 'candidate-v1', locator: 'artifact://candidate-v1', revision: 'candidate-revision', digest: 'candidate-image-digest' },
        rubric: { eventId: 'rubric-event-v1', id: 'prototype.dashboard', revision: 'revision-a', digest: 'digest-prototype.dashboard' },
        evaluator: { eventId: 'capability-event-v1', id: 'independent-model', version: '1' },
        outcome: 'satisfied' as const,
        detail: null,
      };
  return { ...base, ...overrides } as VisualEvidence;
}

function visualSourceEvents(visual: VisualEvidence): HarnessEvent[] {
  const capture = visual.kind === 'pixel-diff' ? visual.capture : null;
  const events = [
    event({
      kind: 'visual.artifact.recorded',
      role: 'reference',
      artifactId: visual.reference.artifactId,
      locator: visual.reference.locator,
      revision: visual.reference.revision,
      digest: visual.reference.digest,
      selector: visual.reference.selector,
      capture,
    }, visual.reference.eventId ?? 'missing-reference-event'),
    event({
      kind: 'visual.artifact.recorded',
      role: 'candidate',
      artifactId: visual.candidate.artifactId,
      locator: visual.candidate.locator,
      revision: visual.candidate.revision,
      digest: visual.candidate.digest,
      selector: visual.candidate.selector,
      capture,
    }, visual.candidate.eventId ?? 'missing-candidate-event'),
  ];
  if (visual.kind === 'model-rubric') {
    events.push(
      event({
        kind: 'visual.rubric.recorded',
        rubricId: visual.rubric.id,
        revision: visual.rubric.revision,
        digest: visual.rubric.digest,
      }, visual.rubric.eventId ?? 'missing-rubric-event'),
      event({
        kind: 'visual.evaluator-capability.recorded',
        evaluatorId: visual.evaluator.id,
        version: visual.evaluator.version,
        independent: true,
      }, visual.evaluator.eventId ?? 'missing-capability-event'),
    );
  }
  return events;
}

function visualEvidenceEvent(
  visual: VisualEvidence,
  evidenceId = 'visual-evidence',
  eventId = `${evidenceId}-event`,
  overrides: Record<string, unknown> = {},
): HarnessEvent {
  return event({
    kind: 'evidence.recorded',
    evidenceId,
    runId: null,
    workItemId: null,
    evidenceKind: 'artifact',
    ref: { eventId: eventId, url: visual.candidate.locator, label: 'visual evidence' },
    summary: 'visual evidence',
    state: { commit: 'commit-a', tree: 'tree-a', dirty: false },
    check: null,
    visual,
    expectationSetId: 'set-a',
    expectationItemId: 'prototype.dashboard',
    ...overrides,
  }, eventId);
}

function visualEventLog(
  visual: VisualEvidence,
  evidenceId = 'visual-evidence',
  overrides: Record<string, unknown> = {},
): HarnessEvent[] {
  return [...visualSourceEvents(visual), visualEvidenceEvent(visual, evidenceId, `${evidenceId}-event`, overrides)];
}

interface VisualFixture {
  readonly store: ThreadStore;
  readonly threadId: string;
  readonly visual: VisualEvidence;
  readonly snapshot: EventLogSnapshot;
  readonly events: readonly HarnessEvent[];
  readonly evidence: EvidenceItem[];
}

type VisualTestInput = GuardrailEvaluatorInput & { readonly fixture: VisualFixture };

function evaluateOwnedVisual(input: VisualTestInput) {
  const { fixture, guardrail, ...rest } = input;
  return fixture.store.withTrustedThreadContext(fixture.threadId, () =>
    evaluateOwnedGuardrails({ ...rest, guardrails: [guardrail] }),
  );
}

/** Append visual source/evidence bodies through the real store and use its stamped ids. */
function appendVisualFixture(
  store: ThreadStore,
  threadId: string,
  template: VisualEvidence,
  evidenceId: string,
  expectationSetId: string,
  state: { commit: string | null; tree: string | null; dirty: boolean } = { commit: 'commit-a', tree: 'tree-a', dirty: false },
): VisualEvidence {
  const referenceEvent = store.append(threadId, null, {
    kind: 'visual.artifact.recorded',
    role: 'reference',
    artifactId: template.reference.artifactId,
    locator: template.reference.locator,
    revision: template.reference.revision,
    digest: template.reference.digest,
    selector: template.reference.selector ?? null,
    capture: template.kind === 'pixel-diff' ? template.capture : null,
  });
  const candidateEvent = store.append(threadId, null, {
    kind: 'visual.artifact.recorded',
    role: 'candidate',
    artifactId: template.candidate.artifactId,
    locator: template.candidate.locator,
    revision: template.candidate.revision,
    digest: template.candidate.digest,
    selector: template.candidate.selector ?? null,
    capture: template.kind === 'pixel-diff' ? template.capture : null,
  });

  let visual: VisualEvidence = {
    ...template,
    reference: { ...template.reference, eventId: referenceEvent.id },
    candidate: { ...template.candidate, eventId: candidateEvent.id },
  };
  if (template.kind === 'model-rubric') {
    const rubricEvent = store.append(threadId, null, {
      kind: 'visual.rubric.recorded',
      rubricId: template.rubric.id,
      revision: template.rubric.revision,
      digest: template.rubric.digest,
    });
    const capabilityEvent = store.append(threadId, null, {
      kind: 'visual.evaluator-capability.recorded',
      evaluatorId: template.evaluator.id,
      version: template.evaluator.version,
      independent: true,
    });
    visual = {
      ...visual,
      rubric: { ...template.rubric, eventId: rubricEvent.id },
      evaluator: { ...template.evaluator, eventId: capabilityEvent.id },
    } as VisualEvidence;
  }

  store.append(threadId, null, {
    kind: 'evidence.recorded',
    evidenceId,
    runId: null,
    workItemId: null,
    evidenceKind: 'artifact',
    ref: { eventId: candidateEvent.id, url: visual.candidate.locator, label: 'visual evidence' },
    summary: 'visual evidence',
    state,
    check: null,
    visual,
    expectationSetId,
    expectationItemId: 'prototype.dashboard',
  });
  return visual;
}

function visualFixture(
  template: VisualEvidence,
  evidenceId = 'visual-evidence',
  expectationSetId = 'set-a',
  state?: { commit: string | null; tree: string | null; dirty: boolean },
  prefix: readonly AdapterEvent[] = [],
): VisualFixture {
  const dir = mkdtempSync(join(tmpdir(), 'awos-visual-'));
  visualFixtureDirs.push(dir);
  const store = new ThreadStore(dir);
  const thread = store.create({ cwd: '/repo' });
  for (const eventBody of prefix) store.append(thread.id, null, eventBody);
  const visual = appendVisualFixture(store, thread.id, template, evidenceId, expectationSetId, state);
  return currentVisualFixture(store, thread.id, visual);
}

function currentVisualFixture(store: ThreadStore, threadId: string, visual: VisualEvidence): VisualFixture {
  const snapshot = store.snapshot(threadId);
  return {
    store,
    threadId,
    visual,
    snapshot,
    events: snapshot.events,
    evidence: foldEvidence(snapshot.events),
  };
}

function mismatchedPixelFixture(mode: 'kind' | 'digest' | 'capture'): VisualFixture {
  const dir = mkdtempSync(join(tmpdir(), 'awos-visual-mismatch-'));
  visualFixtureDirs.push(dir);
  const store = new ThreadStore(dir);
  const thread = store.create({ cwd: '/repo' });
  const template = visualEvidence('pixel-diff') as Extract<VisualEvidence, { kind: 'pixel-diff' }>;
  const referenceEvent = mode === 'kind'
    ? store.append(thread.id, null, {
        kind: 'artifact.updated',
        artifactId: template.reference.artifactId,
        title: 'reference',
        artifactKind: 'image',
        content: 'data:image/png;base64,invalid',
        path: '/repo/.awos/artifacts/reference.png',
        updatedAt: 1,
      })
    : store.append(thread.id, null, {
        kind: 'visual.artifact.recorded',
        role: 'reference',
        artifactId: template.reference.artifactId,
        locator: template.reference.locator,
        revision: template.reference.revision,
        digest: mode === 'digest' ? 'recorded-reference-digest' : template.reference.digest,
        selector: null,
        capture: template.capture,
      });
  const candidateEvent = store.append(thread.id, null, {
    kind: 'visual.artifact.recorded',
    role: 'candidate',
    artifactId: template.candidate.artifactId,
    locator: template.candidate.locator,
    revision: template.candidate.revision,
    digest: template.candidate.digest,
    selector: null,
    capture: mode === 'capture' ? { ...template.capture, dpr: 2 } : template.capture,
  });
  const visual = {
    ...template,
    reference: { ...template.reference, eventId: referenceEvent.id },
    candidate: { ...template.candidate, eventId: candidateEvent.id },
  } as VisualEvidence;
  store.append(thread.id, null, {
    kind: 'evidence.recorded',
    evidenceId: `mismatch-${mode}`,
    runId: null,
    workItemId: null,
    evidenceKind: 'artifact',
    ref: { eventId: candidateEvent.id, url: visual.candidate.locator, label: 'visual evidence' },
    summary: 'mismatched visual evidence',
    state: { commit: 'commit-a', tree: 'tree-a', dirty: false },
    check: null,
    visual,
    expectationSetId: 'set-a',
    expectationItemId: 'prototype.dashboard',
  });
  return currentVisualFixture(store, thread.id, visual);
}

const independentModelCapability: EvaluatorCapability = {
  kind: 'model-rubric',
  id: 'independent-model',
  version: '1',
  independent: true,
};

function event(body: Record<string, unknown>, id?: string): HarnessEvent {
  const seq = ++sequence;
  return {
    id: id ?? `event-${seq}`,
    seq,
    threadId: 'thread-a',
    agent: null,
    turnId: null,
    ts: 1_000 + sequence,
    ...body,
  } as unknown as HarnessEvent;
}

function answerEvent(overrides: Record<string, unknown> = {}): HarnessEvent {
  return event({
    kind: 'answer.recorded',
    answerId: 'answer-a',
    expectationItemId: 'question-a',
    expectationSetId: 'set-a',
    actor: 'user',
    authority: 'user',
    answer: { type: 'choice', value: 'keep' },
    candidate,
    evidenceIds: [],
    recordedAt: 1_010,
    ...overrides,
  });
}

function attestationEvent(overrides: Record<string, unknown> = {}): HarnessEvent {
  return event({
    kind: 'human.attestation.recorded',
    attestationId: 'attestation-a',
    expectationItemId: 'attestation-a',
    expectationSetId: 'set-a',
    actor: 'user',
    authority: 'user',
    statement: 'I reviewed the current candidate.',
    candidate,
    evidenceIds: ['evidence-a'],
    recordedAt: 1_011,
    ...overrides,
  });
}

function verificationFact(overrides: Partial<EvidenceItem> = {}, requirementId = 'test') {
  const fact = evaluateVerificationChecks({
    checkNames: ['test'],
    verify,
    evidence: overrides === undefined ? [] : [evidence('evidence-a', overrides)],
    candidate,
    expectationSetId: 'set-a',
  }).facts[0]!;
  return { ...fact, requirementId };
}

describe('core evaluator registry', () => {
  test('pins human-attestation identities in the core expectation manifest', () => {
    assert.equal(coreExpectationManifestEntry('review.semantic')?.kind, 'human-attestation');
  });

  test('is static and closed with pixel and model evaluators included', () => {
    assert.deepEqual(CORE_EVALUATOR_KINDS, [
      'verification',
      'evidence-present',
      'mandatory-answer',
      'human-attestation',
      'pixel-diff',
      'model-rubric',
    ]);
    assert.deepEqual(Object.keys(CORE_EVALUATOR_REGISTRY), [...CORE_EVALUATOR_KINDS]);
    assert.equal(coreEvaluator('pixel-diff')?.kind, 'pixel-diff');
    assert.equal(coreEvaluator('model-rubric')?.kind, 'model-rubric');
  });

  test('unknown evaluator kinds become bounded unknown facts instead of throwing', () => {
    const result = evaluateGuardrail({
      guardrail: { ...guardrail('verification', { checks: ['test'] }), kind: 'unsupported' as WorkspaceGuardrail['kind'] },
      expectationSet: expectation('scope'),
      candidate,
      verify,
      evidence: [],
      events: [],
    });

    assert.equal(result[0]?.state, 'unknown');
    assert.equal(result[0]?.provenance.validity, 'unavailable');
    assert.equal(result[0]?.provenance.evaluatorVersion, '1');
    assert.equal(result[0]?.provenance.evaluatorKind, 'core');
    assert.ok((result[0]?.detail?.length ?? 0) <= EVALUATOR_DIAGNOSTIC_MAX_CHARS);
  });
});

describe('pixel-diff evaluator', () => {
  function pixelInput(
    visual: VisualEvidence = visualEvidence('pixel-diff'),
    overrides: Partial<Parameters<typeof evaluateGuardrail>[0]> = {},
  ) {
    const fixture = visualFixture(visual);
    return {
      guardrail: guardrail('pixel-diff', { expectationItem: 'prototype.dashboard', exact: true, capture: visualCapture }),
      expectationSet: expectation('prototype.dashboard', 'prototype'),
      candidate,
      verify,
      evidence: fixture.evidence,
      events: fixture.events,
      ...overrides,
      fixture,
    } as VisualTestInput;
  }

  test('accepts a complete exact measurement and reports measured non-equality without semantic claims', () => {
    const equal = evaluateOwnedVisual(pixelInput());
    assert.equal(equal[0]?.state, 'satisfied');
    assert.equal(equal[0]?.provenance.evaluatorClass, 'pixel');
    assert.match(equal[0]?.detail ?? '', /pixel equality/);
    assert.doesNotMatch(equal[0]?.detail ?? '', /semantic|behavior|a11y/i);

    const different = evaluateOwnedVisual(pixelInput(visualEvidence('pixel-diff', {
      measurement: { comparedPixels: 100, differentPixels: 3, equal: false, exact: true },
    })));
    assert.equal(different[0]?.state, 'failed');
    assert.equal(different[0]?.observation, 'failed');
    assert.match(different[0]?.detail ?? '', /3 differing pixels/);
  });

  test('fails closed for incomplete captures and exact requirements', () => {
    const incomplete = evaluateOwnedVisual(pixelInput(visualEvidence('pixel-diff', {
      capture: { ...visualCapture, fonts: '' },
    })));
    assert.equal(incomplete[0]?.state, 'unknown');
    assert.equal(incomplete[0]?.provenance.validity, 'uncertain');

    const incompleteTransition = evaluateTransition({
      attempt: {
        transitionId: 'pixel-incomplete', attempt: 1, runId: null, actor: 'user',
        sourceStepId: 'review', targetStepId: 'integrate', expectationSetId: expectation('prototype.dashboard', 'prototype').expectationSetId,
        candidate, evidenceIds: [],
      },
      expectationSet: expectation('prototype.dashboard', 'prototype'),
      facts: incomplete,
      timestamp: 10,
    });
    assert.equal(incompleteTransition.verdict, 'waiting-for-human');
    assert.equal(incompleteTransition.refusal?.nextAction, 'provide-evidence');

    const notExact = evaluateOwnedVisual(pixelInput(visualEvidence('pixel-diff', {
      measurement: { comparedPixels: 100, differentPixels: 0, equal: true, exact: false },
    })));
    assert.equal(notExact[0]?.state, 'unknown');
    assert.equal(notExact[0]?.provenance.validity, 'uncertain');
  });

  test('cannot pass absolute pixel enforcement without a complete event chain', () => {
    const visual = visualEvidence('pixel-diff');
    const input = pixelInput(visual, {
      guardrail: { ...pixelInput(visual).guardrail, enforcement: 'absolute' },
      events: [],
      evidence: [],
    });
    const fact = evaluateGuardrail(input);
    assert.equal(fact[0]?.state, 'unknown');
    const transition = evaluateTransition({
      attempt: {
        transitionId: 'pixel-absolute-fabricated', attempt: 1, runId: null, actor: 'user',
        sourceStepId: 'review', targetStepId: 'integrate', expectationSetId: expectation('prototype.dashboard', 'prototype', 'absolute').expectationSetId,
        candidate, evidenceIds: [],
      },
      expectationSet: expectation('prototype.dashboard', 'prototype', 'absolute'),
      facts: fact,
      timestamp: 10,
    });
    assert.notEqual(transition.verdict, 'passed');
  });

  test('owner evaluation accepts the real chain while public calls cannot select a snapshot', () => {
    const fixture = visualFixture(visualEvidence('pixel-diff'));
    const input = {
      guardrail: guardrail('pixel-diff', { expectationItem: 'prototype.dashboard', exact: true, capture: visualCapture }),
      expectationSet: expectation('prototype.dashboard', 'prototype'),
      candidate,
      verify,
      evidence: fixture.evidence,
      events: fixture.events,
      fixture,
    } as VisualTestInput;
    assert.equal(evaluateOwnedVisual(input)[0]?.state, 'satisfied');

    const publicResult = evaluateGuardrail(input);
    assert.equal(publicResult[0]?.state, 'unknown');
    assert.equal(publicResult[0]?.provenance.validity, 'unavailable');

    for (const eventSnapshot of [
      fixture.snapshot,
      [...fixture.snapshot.events],
      { ...fixture.snapshot },
      { threadId: fixture.threadId, revision: fixture.snapshot.revision, events: fixture.snapshot.events },
    ]) {
      const castAttempt = {
        ...input,
        eventSnapshot,
      } as unknown as GuardrailEvaluatorInput;
      const ignoredSnapshot = evaluateGuardrail(castAttempt);
      assert.equal(ignoredSnapshot[0]?.state, 'unknown');
      assert.equal(ignoredSnapshot[0]?.provenance.validity, 'unavailable');
    }
  });

  test('owner evaluation rejects wrong source kind, recorded digest, and capture', () => {
    for (const mode of ['kind', 'digest', 'capture'] as const) {
      const mismatch = mismatchedPixelFixture(mode);
      const input = {
        guardrail: guardrail('pixel-diff', { expectationItem: 'prototype.dashboard', exact: true, capture: visualCapture }),
        expectationSet: expectation('prototype.dashboard', 'prototype'),
        candidate,
        verify,
        evidence: mismatch.evidence,
        events: mismatch.events,
        fixture: mismatch,
      } as VisualTestInput;
      assert.notEqual(evaluateOwnedVisual(input)[0]?.state, 'satisfied', mode);
    }
  });

  test('required pixel uncertainty waits for one human action while missing sources still request evidence', () => {
    const invalid = evaluateOwnedVisual(pixelInput(visualEvidence('pixel-diff', {
      measurement: { comparedPixels: 10, differentPixels: 2, equal: true, exact: true },
    })));
    assert.equal(invalid[0]?.provenance.validity, 'uncertain');
    const invalidTransition = evaluateTransition({
      attempt: {
        transitionId: 'pixel-invalid', attempt: 1, runId: null, actor: 'user',
        sourceStepId: 'review', targetStepId: 'integrate', expectationSetId: expectation('prototype.dashboard', 'prototype').expectationSetId,
        candidate, evidenceIds: [],
      },
      expectationSet: expectation('prototype.dashboard', 'prototype'),
      facts: invalid,
      timestamp: 10,
    });
    assert.equal(invalidTransition.verdict, 'waiting-for-human');
    assert.equal(invalidTransition.refusal?.nextAction, 'provide-evidence');
    assert.equal(invalidTransition.refusal?.responsibleActor, 'user');

    const unavailable = evaluateGuardrail(pixelInput(undefined, { events: [], evidence: [] }));
    assert.equal(unavailable[0]?.provenance.validity, 'unavailable');
    const unavailableTransition = evaluateTransition({
      attempt: {
        transitionId: 'pixel-unavailable', attempt: 1, runId: null, actor: 'user',
        sourceStepId: 'review', targetStepId: 'integrate', expectationSetId: expectation('prototype.dashboard', 'prototype').expectationSetId,
        candidate, evidenceIds: [],
      },
      expectationSet: expectation('prototype.dashboard', 'prototype'),
      facts: unavailable,
      timestamp: 10,
    });
    assert.equal(unavailableTransition.verdict, 'retry');
    assert.equal(unavailableTransition.refusal?.nextAction, 'provide-evidence');
  });

  test('marks changed references and candidates stale', () => {
    const changedReference = evaluateOwnedVisual(pixelInput(visualEvidence('pixel-diff', {
      reference: {
        eventId: 'reference-event-v2',
        artifactId: 'reference-v2',
        locator: 'identity://prototype.dashboard',
        revision: 'revision-b',
        digest: 'digest-prototype.dashboard-v2',
      },
    })));
    assert.equal(changedReference[0]?.state, 'unknown');
    assert.equal(changedReference[0]?.provenance.validity, 'stale');

    const staleFixture = visualFixture(
      visualEvidence('pixel-diff'),
      'stale-candidate',
      'set-a',
      { commit: 'commit-old', tree: 'tree-old', dirty: false },
    );
    const changedCandidate = evaluateOwnedVisual({
      guardrail: guardrail('pixel-diff', { expectationItem: 'prototype.dashboard', exact: true, capture: visualCapture }),
      expectationSet: expectation('prototype.dashboard', 'prototype'),
      candidate,
      verify,
      evidence: staleFixture.evidence,
      events: staleFixture.events,
      fixture: staleFixture,
    });
    assert.equal(changedCandidate[0]?.state, 'unknown');
    assert.equal(changedCandidate[0]?.provenance.validity, 'stale');
  });
});

describe('model-rubric evaluator', () => {
  function modelInput(
    visual: VisualEvidence = visualEvidence('model-rubric'),
    overrides: Partial<Parameters<typeof evaluateGuardrail>[0]> = {},
  ) {
    const fixture = visualFixture(visual);
    return {
      guardrail: guardrail('model-rubric', { expectationItem: 'prototype.dashboard', evaluatorProfile: 'independent-model' }),
      expectationSet: expectation('prototype.dashboard', 'prototype'),
      candidate,
      verify,
      evidence: fixture.evidence,
      events: fixture.events,
      evaluatorCapabilities: [independentModelCapability],
      ...overrides,
      fixture,
    } as VisualTestInput;
  }

  test('uses only an available independent capability and keeps unavailable profiles unknown', () => {
    const available = evaluateOwnedVisual(modelInput());
    assert.equal(available[0]?.state, 'satisfied');
    assert.equal(available[0]?.provenance.evaluatorClass, 'model');

    const publicResult = evaluateGuardrail(modelInput());
    assert.equal(publicResult[0]?.state, 'unknown');
    assert.equal(publicResult[0]?.provenance.validity, 'unavailable');
    const modelFixture = modelInput();
    for (const eventSnapshot of [
      modelFixture.fixture.snapshot,
      [...modelFixture.fixture.snapshot.events],
      { ...modelFixture.fixture.snapshot },
      { threadId: modelFixture.fixture.threadId, revision: modelFixture.fixture.snapshot.revision, events: modelFixture.fixture.snapshot.events },
    ]) {
      const castAttempt = {
        ...modelFixture,
        eventSnapshot,
      } as unknown as GuardrailEvaluatorInput;
      const ignoredSnapshot = evaluateGuardrail(castAttempt);
      assert.equal(ignoredSnapshot[0]?.state, 'unknown');
      assert.equal(ignoredSnapshot[0]?.provenance.validity, 'unavailable');
    }

    const unavailable = evaluateOwnedVisual(modelInput(undefined, { evaluatorCapabilities: [] }));
    assert.equal(unavailable[0]?.state, 'unknown');
    assert.equal(unavailable[0]?.provenance.validity, 'unavailable');

    const fabricatedChain = evaluateGuardrail(modelInput(undefined, { events: [], evidence: [] }));
    assert.equal(fabricatedChain[0]?.state, 'unknown');
    assert.equal(fabricatedChain[0]?.provenance.validity, 'unavailable');
    assert.notEqual(fabricatedChain[0]?.state, 'satisfied');
    const fabricatedTransition = evaluateTransition({
      attempt: {
        transitionId: 'model-fabricated-chain', attempt: 1, runId: null, actor: 'user',
        sourceStepId: 'review', targetStepId: 'integrate', expectationSetId: expectation('prototype.dashboard', 'prototype').expectationSetId,
        candidate, evidenceIds: [],
      },
      expectationSet: expectation('prototype.dashboard', 'prototype'),
      facts: fabricatedChain,
      timestamp: 10,
    });
    assert.notEqual(fabricatedTransition.verdict, 'passed');

    const self = evaluateOwnedVisual(modelInput(undefined, { producingWorkerProfileId: 'independent-model' }));
    assert.equal(self[0]?.state, 'unknown');
    assert.equal(self[0]?.provenance.validity, 'uncertain');

    const unavailableTransition = evaluateTransition({
      attempt: {
        transitionId: 'model-unavailable', attempt: 1, runId: null, actor: 'user',
        sourceStepId: 'review', targetStepId: 'integrate', expectationSetId: expectation('prototype.dashboard', 'prototype').expectationSetId,
        candidate, evidenceIds: [],
      },
      expectationSet: expectation('prototype.dashboard', 'prototype'),
      facts: unavailable,
      timestamp: 10,
    });
    assert.equal(unavailableTransition.verdict, 'retry');
    assert.equal(unavailableTransition.refusal?.nextAction, 'provide-evidence');
  });

  test('maps uncertainty and conflicting semantic observations to unknown facts', () => {
    for (const outcome of ['uncertain', 'conflicting'] as const) {
      const result = evaluateOwnedVisual(modelInput(visualEvidence('model-rubric', { outcome })));
      assert.equal(result[0]?.state, 'unknown', outcome);
      assert.equal(result[0]?.provenance.validity, 'uncertain', outcome);
    }

    const invalidSemantic = {
      ...visualEvidence('model-rubric'),
      outcome: 'not-a-model-outcome',
    } as unknown as VisualEvidence;
    const invalidFact = evaluateOwnedVisual(modelInput(invalidSemantic));
    assert.equal(invalidFact[0]?.state, 'unknown');
    assert.equal(invalidFact[0]?.provenance.validity, 'uncertain');
    const invalidTransition = evaluateTransition({
      attempt: {
        transitionId: 'semantic-invalid', attempt: 1, runId: null, actor: 'user',
        sourceStepId: 'review', targetStepId: 'integrate', expectationSetId: expectation('prototype.dashboard', 'prototype').expectationSetId,
        candidate, evidenceIds: [],
      },
      expectationSet: expectation('prototype.dashboard', 'prototype'),
      facts: invalidFact,
      timestamp: 10,
    });
    assert.equal(invalidTransition.verdict, 'waiting-for-human');
    assert.equal(invalidTransition.refusal?.nextAction, 'provide-evidence');

    const semanticSatisfied = visualEvidence('model-rubric', { outcome: 'satisfied' });
    const semanticFailed = visualEvidence('model-rubric', { outcome: 'failed' });
    const conflictFixture = visualFixture(semanticSatisfied, 'model-a');
    appendVisualFixture(
      conflictFixture.store,
      conflictFixture.threadId,
      semanticFailed,
      'model-b',
      'set-a',
    );
    const conflictCurrent = currentVisualFixture(conflictFixture.store, conflictFixture.threadId, conflictFixture.visual);
    const conflictingEvidence = evaluateOwnedVisual({
      guardrail: guardrail('model-rubric', { expectationItem: 'prototype.dashboard', evaluatorProfile: 'independent-model' }),
      expectationSet: expectation('prototype.dashboard', 'prototype'),
      candidate,
      verify,
      evidence: conflictCurrent.evidence,
      events: conflictCurrent.events,
      evaluatorCapabilities: [independentModelCapability],
      fixture: conflictCurrent,
    } as VisualTestInput);
    assert.equal(conflictingEvidence[0]?.state, 'unknown');
    assert.match(conflictingEvidence[0]?.detail ?? '', /Conflicting semantic facts/);

    const transition = evaluateTransition({
      attempt: {
        transitionId: 'semantic-uncertainty', attempt: 1, runId: null, actor: 'user',
        sourceStepId: 'review', targetStepId: 'integrate', expectationSetId: expectation('prototype.dashboard', 'prototype').expectationSetId,
        candidate, evidenceIds: [],
      },
      expectationSet: expectation('prototype.dashboard', 'prototype'),
      facts: conflictingEvidence,
      timestamp: 10,
    });
    assert.equal(transition.verdict, 'waiting-for-human');
    assert.equal(transition.refusal?.responsibleActor, 'user');
  });

  test('freezes the adapter request and never lets it choose the transition verdict', () => {
    const expectationSet = expectation('prototype.dashboard', 'prototype');
    const capability: EvaluatorCapability = {
      ...independentModelCapability,
      evaluate(request) {
        assert.throws(() => {
          (request.reference as { artifactId: string }).artifactId = 'replacement';
        });
        return { outcome: 'failed', detail: 'bounded adapter observation' };
      },
    };
    const facts = evaluateOwnedVisual(modelInput(undefined, { evaluatorCapabilities: [capability] }));
    assert.equal(expectationSet.items[0]?.reference.contentDigest, 'digest-prototype.dashboard');
    assert.equal(facts[0]?.state, 'failed');
    const transition = evaluateTransition({
      attempt: {
        transitionId: 'model-transition', attempt: 1, runId: null, actor: 'user',
        sourceStepId: 'review', targetStepId: 'integrate', expectationSetId: expectationSet.expectationSetId,
        candidate, evidenceIds: [],
      },
      expectationSet,
      facts,
      timestamp: 10,
    });
    assert.equal(transition.verdict, 'retry');
    assert.equal(transition.override, null);
  });

  test('forbids absolute model enforcement even when the evidence says satisfied', () => {
    const input = modelInput(undefined, {
      guardrail: { ...modelInput().guardrail, enforcement: 'absolute' },
    });
    const fact = evaluateOwnedVisual(input);
    assert.equal(fact[0]?.state, 'unknown');
    assert.equal(fact[0]?.provenance.validity, 'uncertain');
    const expectationSet = expectation('prototype.dashboard', 'prototype', 'absolute');
    const transition = evaluateTransition({
      attempt: {
        transitionId: 'model-absolute', attempt: 1, runId: null, actor: 'user',
        sourceStepId: 'review', targetStepId: 'integrate', expectationSetId: expectationSet.expectationSetId,
        candidate, evidenceIds: [],
      },
      expectationSet,
      facts: fact,
      timestamp: 10,
    });
    assert.equal(transition.verdict, 'blocked');
    assert.match(transition.refusal?.reason ?? '', /cannot use absolute enforcement/);
  });

  test('requires one branded snapshot for the full visual source chain and refetches after append', () => {
    const first = visualFixture(visualEvidence('pixel-diff'), 'a-visual');
    const other = visualFixture(visualEvidence('pixel-diff'), 'b-visual');
    const ownerInput = {
      guardrail: guardrail('pixel-diff', { expectationItem: 'prototype.dashboard', exact: true, capture: visualCapture }),
      expectationSet: expectation('prototype.dashboard', 'prototype'),
      candidate,
      verify,
      evidence: first.evidence,
      events: first.events,
      fixture: first,
    } as VisualTestInput;
    assert.equal(evaluateOwnedVisual(ownerInput)[0]?.state, 'satisfied');

    const foreignInput = {
      ...ownerInput,
      evidence: other.evidence,
      events: other.events,
    } as VisualTestInput;
    const foreignResult = evaluateOwnedVisual(foreignInput);
    assert.equal(foreignResult[0]?.state, 'satisfied');
    assert.deepEqual(foreignResult[0]?.evidenceIds, ['a-visual']);

    first.store.append(first.threadId, 'codex', { kind: 'message.completed', itemId: 'later', text: 'later' });
    const freshAfterAppend = evaluateOwnedVisual(ownerInput);
    assert.equal(freshAfterAppend[0]?.state, 'satisfied');

    const publicForeignAttempt = {
      attempt: {
        transitionId: 'foreign-visual',
        attempt: 1,
        runId: null,
        actor: 'user' as const,
        sourceStepId: 'review',
        targetStepId: 'integrate',
        expectationSetId: ownerInput.expectationSet.expectationSetId,
        candidate,
        evidenceIds: [],
      },
      expectationSet: ownerInput.expectationSet,
      timestamp: 10,
      guardrails: [ownerInput.guardrail],
      verify,
      evidence: other.evidence,
      events: other.events,
      eventSnapshot: other.snapshot,
    } as unknown as Parameters<typeof evaluateGuardedTransition>[0];
    const rejectedForeignAttempt = evaluateGuardedTransition(publicForeignAttempt);
    assert.notEqual(rejectedForeignAttempt.verdict, 'passed');
    assert.equal(rejectedForeignAttempt.facts[0]?.state, 'unknown');
  });
});

test('integration rejects a measured visual diff, then a repin supersedes the old visual reference', () => {
  const oldSet = expectation('prototype.dashboard', 'prototype');
  const visualGuardrail = guardrail('pixel-diff', {
    expectationItem: 'prototype.dashboard',
    exact: true,
    capture: visualCapture,
  });
  const diffVisual = visualEvidence('pixel-diff', {
    measurement: { comparedPixels: 100, differentPixels: 2, equal: false, exact: true },
  });
  const diffFixture = visualFixture(diffVisual, 'diff-evidence', oldSet.expectationSetId);
  const diffEvidence = diffFixture.evidence[0]!;
  const attempt = {
    transitionId: 'visual-integration',
    attempt: 1,
    runId: null,
    actor: 'user' as const,
    sourceStepId: 'lane',
    targetStepId: 'workspace',
    expectationSetId: oldSet.expectationSetId,
    candidate,
    evidenceIds: [diffEvidence.id],
  };
  const rejected = diffFixture.store.withTrustedThreadContext(diffFixture.threadId, () => evaluateOwnedIntegrationTransition({
    integration: { requires: [], allowOverride: false },
    verify: [],
    evidence: [diffEvidence],
    candidateTree: candidate.digest,
    attempt,
    expectationSet: oldSet,
    timestamp: 10,
    guardrails: [visualGuardrail],
    events: diffFixture.events,
  }));
  assert.equal(rejected.verdict, 'retry');
  assert.equal(rejected.refusal?.nextAction, 'correct-candidate');
  assert.equal(rejected.evaluation.facts[0]?.provenance.evaluatorKind, 'pixel-diff');

  const newSet = createExpectationSet({
    ...oldSet,
    expectationSetId: 'set-b',
    manifestDigest: 'manifest-b',
    items: [{ ...oldSet.items[0]!, reference: { ...oldSet.items[0]!.reference, contentDigest: 'digest-prototype.dashboard-v2', nativeRevision: 'revision-b' } }],
    supersedes: oldSet.expectationSetId,
  });
  const oldVisual = diffFixture.visual;
  diffFixture.store.append(diffFixture.threadId, null, { kind: 'expectation.set.created', expectationSet: oldSet });
  diffFixture.store.append(diffFixture.threadId, null, { kind: 'expectation.set.created', expectationSet: newSet });
  diffFixture.store.append(diffFixture.threadId, null, {
    kind: 'expectation.set.superseded',
    expectationSetId: oldSet.expectationSetId,
    supersededByExpectationSetId: newSet.expectationSetId,
    supersedesTransitionId: 'visual-integration',
  });
  const historyFixture = currentVisualFixture(diffFixture.store, diffFixture.threadId, oldVisual);
  const staleOld = evaluateOwnedVisual(pixelInputForSet(oldSet, historyFixture));
  assert.equal(staleOld[0]?.provenance.validity, 'stale');

  const repinnedVisual = visualEvidence('pixel-diff', {
    reference: {
      eventId: 'reference-event-v2',
      artifactId: 'reference-v2',
      locator: 'identity://prototype.dashboard',
      revision: 'revision-b',
      digest: 'digest-prototype.dashboard-v2',
    },
    measurement: { comparedPixels: 100, differentPixels: 0, equal: true, exact: true },
  });
  const actualRepinnedVisual = appendVisualFixture(
    diffFixture.store,
    diffFixture.threadId,
    repinnedVisual,
    'repinned-visual',
    newSet.expectationSetId,
  );
  const repinnedFixture = currentVisualFixture(
    diffFixture.store,
    diffFixture.threadId,
    actualRepinnedVisual,
  );
  const repinned = evaluateOwnedVisual(pixelInputForSet(newSet, repinnedFixture));
  assert.equal(repinned[0]?.state, 'satisfied');
  assert.equal(newSet.authority.pinnedBy, 'user');
  assert.equal(newSet.supersedes, oldSet.expectationSetId);
  assert.equal(oldSet.supersedes, null);
  assert.equal(oldSet.items[0]?.reference.contentDigest, 'digest-prototype.dashboard');
  assert.equal(newSet.items[0]?.reference.contentDigest, 'digest-prototype.dashboard-v2');
});

function pixelInputForSet(set: ExpectationSet, fixture: VisualFixture) {
  return {
    guardrail: guardrail('pixel-diff', { expectationItem: 'prototype.dashboard', exact: true, capture: visualCapture }),
    expectationSet: set,
    candidate,
    verify,
    evidence: fixture.evidence,
    events: fixture.events,
    fixture,
  } as VisualTestInput;
}

describe('verification evaluator', () => {
  test('keeps satisfied, missing, failed, and stale distinct', () => {
    const satisfied = evaluateVerificationChecks({
      checkNames: ['test'], verify, evidence: [evidence('satisfied')], candidate, expectationSetId: 'set-a',
    });
    assert.equal(satisfied.requirements[0]?.state, 'satisfied');
    assert.equal(satisfied.facts[0]?.state, 'satisfied');
    assert.equal(satisfied.facts[0]?.observation, 'satisfied');

    const missing = evaluateVerificationChecks({
      checkNames: ['test'], verify, evidence: [], candidate, expectationSetId: 'set-a',
    });
    assert.equal(missing.requirements[0]?.state, 'missing');
    assert.equal(missing.facts[0]?.observation, 'missing');
    assert.equal(missing.facts[0]?.provenance.validity, 'unavailable');

    const failed = evaluateVerificationChecks({
      checkNames: ['test'], verify,
      evidence: [evidence('failed', { check: { name: 'test', passed: false, exitCode: 1 } })],
      candidate,
      expectationSetId: 'set-a',
    });
    assert.equal(failed.requirements[0]?.state, 'failed');
    assert.equal(failed.facts[0]?.state, 'failed');
    assert.equal(failed.facts[0]?.observation, 'failed');

    const stale = evaluateVerificationChecks({
      checkNames: ['test'], verify,
      evidence: [evidence('stale', { state: { commit: 'commit-old', tree: 'tree-old', dirty: false } })],
      candidate,
      expectationSetId: 'set-a',
    });
    assert.equal(stale.requirements[0]?.state, 'stale');
    assert.equal(stale.facts[0]?.state, 'unknown');
    assert.equal(stale.facts[0]?.observation, 'stale');
    assert.equal(stale.facts[0]?.provenance.validity, 'stale');
  });

  test('requires the declared named command, not a similar check or summary', () => {
    const result = evaluateVerificationChecks({
      checkNames: ['test'], verify,
      evidence: [evidence('wrong', { check: { name: 'lint', passed: true, exitCode: 0 } })],
      candidate,
      expectationSetId: 'set-a',
    });
    assert.equal(result.requirements[0]?.state, 'missing');
    assert.equal(result.facts[0]?.observation, 'missing');
  });
});

test('legacy named integration checks use the shared verification evaluator and candidate identity', () => {
  const set = expectation('test');
  const decision = evaluateIntegrationTransition({
    integration: { requires: ['test'], allowOverride: false },
    verify,
    evidence: [evidence('integration-evidence')],
    candidateTree: candidate.digest,
    attempt: {
      transitionId: 'integration-a',
      attempt: 1,
      runId: null,
      actor: 'user',
      sourceStepId: 'lane',
      targetStepId: 'workspace',
      expectationSetId: set.expectationSetId,
      candidate,
      evidenceIds: [],
    },
    expectationSet: set,
    timestamp: 40,
  });

  assert.equal(decision.requirements[0]?.state, 'satisfied');
  assert.equal(decision.evaluation.facts[0]?.provenance.evaluatorId, 'verification');
  assert.equal(decision.evaluation.facts[0]?.provenance.evaluatorVersion, CORE_EVALUATOR_VERSION);

  const stale = evaluateIntegrationTransition({
    integration: { requires: ['test'], allowOverride: false },
    verify,
    evidence: [evidence('integration-stale', { state: { commit: 'commit-old', tree: 'tree-old', dirty: false } })],
    candidateTree: 'tree-new',
    attempt: {
      transitionId: 'integration-b',
      attempt: 1,
      runId: null,
      actor: 'user',
      sourceStepId: 'lane',
      targetStepId: 'workspace',
      expectationSetId: set.expectationSetId,
      candidate: { ...candidate, id: 'tree-new', digest: 'tree-new' },
      evidenceIds: [],
    },
    expectationSet: set,
    timestamp: 41,
  });
  assert.equal(stale.requirements[0]?.state, 'stale');
  assert.equal(stale.evaluation.facts[0]?.observation, 'stale');
});

describe('evidence-present evaluator', () => {
  test('requires a concrete evidence kind and a pinned candidate identity', () => {
    const set = expectation('scope');
    const valid = evaluateGuardrail({
      guardrail: guardrail('evidence-present', { expectationItem: 'scope', evidenceKind: 'command' }),
      expectationSet: set,
      candidate,
      verify,
      evidence: [evidence('evidence-a')],
      events: [],
    });
    assert.equal(valid[0]?.state, 'satisfied');

    const summaryOnly = evaluateGuardrail({
      guardrail: guardrail('evidence-present', { expectationItem: 'scope' }),
      expectationSet: set,
      candidate,
      verify,
      evidence: [evidence('note', {
        kind: 'note',
        check: null,
        ref: { eventId: null, url: null, label: 'claim' },
      })],
      events: [],
    });
    assert.equal(summaryOnly[0]?.state, 'unknown');
    assert.equal(summaryOnly[0]?.observation, 'missing');

    const unpinned = evaluateGuardrail({
      guardrail: guardrail('evidence-present', { expectationItem: 'scope' }),
      expectationSet: set,
      candidate: { ...candidate, pinned: false, digest: null },
      verify,
      evidence: [evidence('evidence-b')],
      events: [],
    });
    assert.equal(unpinned[0]?.state, 'unknown');
    assert.equal(unpinned[0]?.provenance.validity, 'unpinned');
  });
});

describe('mandatory-answer evaluator', () => {
  test('accepts only a typed answer from the declared user authority', () => {
    const set = expectation('question-a', 'mandatory-question');
    const input = {
      guardrail: guardrail('mandatory-answer', { expectationItem: 'question-a', authority: 'user' }),
      expectationSet: set,
      candidate,
      verify,
      evidence: [],
    };
    const missing = evaluateGuardrail({ ...input, events: [] });
    assert.equal(missing[0]?.state, 'unknown');
    assert.equal(missing[0]?.observation, 'missing');

    const workerProseAndApproval = evaluateGuardrail({
      ...input,
      events: [
        event({ kind: 'message.completed', itemId: 'message-a', text: 'keep it' }),
        event({ kind: 'approval.resolved', approvalId: 'approval-a', optionId: 'allow', behavior: 'allow', auto: false }),
      ],
    });
    assert.equal(workerProseAndApproval[0]?.state, 'unknown');

    const answer = evaluateGuardrail({ ...input, events: [answerEvent({ expectationItemId: 'question-a' })] });
    assert.equal(answer[0]?.state, 'satisfied');
    assert.equal(answer[0]?.provenance.evaluatorKind, 'mandatory-answer');

    const conflictingAnswer = evaluateGuardrail({
      ...input,
      events: [
        answerEvent({ expectationItemId: 'question-a' }),
        answerEvent({ expectationItemId: 'question-a', answer: { type: 'choice', value: 'change' } }),
      ],
    });
    assert.equal(conflictingAnswer[0]?.state, 'unknown');
    assert.match(conflictingAnswer[0]?.detail ?? '', /Conflicting definitions/);

    const wrongActor = evaluateGuardrail({
      ...input,
      events: [answerEvent({ expectationItemId: 'question-a', actor: 'codex' })],
    });
    assert.equal(wrongActor[0]?.state, 'unknown');

    const wrongCandidate = evaluateGuardrail({
      ...input,
      events: [answerEvent({ expectationItemId: 'question-a', candidate: { ...candidate, id: 'tree-b', digest: 'tree-b' } })],
    });
    assert.equal(wrongCandidate[0]?.state, 'unknown');
    assert.equal(wrongCandidate[0]?.provenance.validity, 'stale');
  });

  test('selects the latest answer only within the active expectation and item', () => {
    const set = expectation('question-a', 'mandatory-question');
    const input = {
      guardrail: guardrail('mandatory-answer', { expectationItem: 'question-a', authority: 'user' }),
      expectationSet: set,
      candidate,
      verify,
      evidence: [],
    };
    const current = answerEvent({
      answerId: 'answer-current',
      recordedAt: 100,
      evidenceIds: ['answer-current-evidence'],
    });

    const currentWithLaterOldSet = evaluateGuardrail({
      ...input,
      events: [current, answerEvent({
        answerId: 'answer-old-set',
        expectationSetId: 'set-old',
        recordedAt: 200,
      })],
    });
    assert.equal(currentWithLaterOldSet[0]?.state, 'satisfied');
    assert.deepEqual(currentWithLaterOldSet[0]?.evidenceIds, ['answer-current-evidence']);

    const onlyOldSet = evaluateGuardrail({
      ...input,
      events: [answerEvent({ answerId: 'answer-old-only', expectationSetId: 'set-old', recordedAt: 200 })],
    });
    assert.equal(onlyOldSet[0]?.state, 'unknown');
    assert.equal(onlyOldSet[0]?.observation, 'missing');

    const laterCurrent = evaluateGuardrail({
      ...input,
      events: [current, answerEvent({
        answerId: 'answer-current-later',
        recordedAt: 300,
        evidenceIds: ['answer-current-later-evidence'],
      })],
    });
    assert.equal(laterCurrent[0]?.state, 'satisfied');
    assert.deepEqual(laterCurrent[0]?.evidenceIds, ['answer-current-later-evidence']);

    for (const [label, correction] of [
      ['actor', { actor: 'codex' }],
      ['candidate', { candidate: { ...candidate, id: 'tree-b', digest: 'tree-b' } }],
    ] as const) {
      const wrongCurrent = evaluateGuardrail({
        ...input,
        events: [current, answerEvent({
          answerId: `answer-wrong-${label}`,
          recordedAt: 400,
          ...correction,
        })],
      });
      assert.equal(wrongCurrent[0]?.state, 'unknown', `${label} correction must be evaluated as the latest active record`);
    }

    for (const [label, correction] of [
      ['actor', { actor: 'codex' }],
      ['candidate', { candidate: { ...candidate, id: 'tree-b', digest: 'tree-b' } }],
    ] as const) {
      const oldSetCorrection = evaluateGuardrail({
        ...input,
        events: [current, answerEvent({
          answerId: `answer-old-wrong-${label}`,
          expectationSetId: 'set-old',
          recordedAt: 500,
          ...correction,
        })],
      });
      assert.equal(oldSetCorrection[0]?.state, 'satisfied', `${label} old-set record must not shadow the active answer`);
    }
  });
});

describe('human-attestation evaluator', () => {
  test('requires an explicit user record and current concrete evidence', () => {
    const set = expectation('attestation-a', 'human-attestation', 'required', 'user');
    const input = {
      guardrail: guardrail('human-attestation', { expectationItem: 'attestation-a', authority: 'user' }),
      expectationSet: set,
      candidate,
      verify,
      evidence: [evidence('evidence-a')],
    };
    const valid = evaluateGuardrail({ ...input, events: [attestationEvent()] });
    assert.equal(valid[0]?.state, 'satisfied');

    const wrongActor = evaluateGuardrail({ ...input, events: [attestationEvent({ actor: 'codex' })] });
    assert.equal(wrongActor[0]?.state, 'unknown');

    const wrongExpectation = evaluateGuardrail({ ...input, events: [attestationEvent({ expectationSetId: 'other-set' })] });
    assert.equal(wrongExpectation[0]?.state, 'unknown');

    const staleCandidate = evaluateGuardrail({
      ...input,
      events: [attestationEvent({ candidate: { ...candidate, id: 'tree-b', digest: 'tree-b' } })],
    });
    assert.equal(staleCandidate[0]?.state, 'unknown');
    assert.equal(staleCandidate[0]?.provenance.validity, 'stale');

    const missingEvidence = evaluateGuardrail({
      ...input,
      evidence: [],
      events: [attestationEvent()],
    });
    assert.equal(missingEvidence[0]?.state, 'unknown');

    const conflictingAttestation = evaluateGuardrail({
      ...input,
      events: [
        attestationEvent(),
        attestationEvent({ statement: 'A different statement.' }),
      ],
    });
    assert.equal(conflictingAttestation[0]?.state, 'unknown');
    assert.match(conflictingAttestation[0]?.detail ?? '', /Conflicting definitions/);
  });

  test('does not carry an attestation across an expectation-set supersession', () => {
    const set = expectation('attestation-a', 'human-attestation', 'required', 'user');
    const input = {
      guardrail: guardrail('human-attestation', { expectationItem: 'attestation-a', authority: 'user' }),
      expectationSet: set,
      candidate,
      verify,
      evidence: [evidence('evidence-a')],
      events: [
        attestationEvent(),
        event({
          kind: 'expectation.set.superseded',
          expectationSetId: 'set-a',
          supersededByExpectationSetId: 'set-b',
          supersedesTransitionId: 'transition-a',
        }),
      ],
    };
    const result = evaluateGuardrail(input);
    assert.equal(result[0]?.state, 'unknown');
    assert.equal(result[0]?.provenance.validity, 'stale');
  });

  test('selects the latest attestation only within the active expectation and item', () => {
    const set = expectation('attestation-a', 'human-attestation', 'required', 'user');
    const input = {
      guardrail: guardrail('human-attestation', { expectationItem: 'attestation-a', authority: 'user' }),
      expectationSet: set,
      candidate,
      verify,
      evidence: [evidence('evidence-a'), evidence('evidence-b')],
    };
    const current = attestationEvent({
      attestationId: 'attestation-current',
      recordedAt: 100,
      evidenceIds: ['evidence-a'],
    });

    const currentWithLaterOldSet = evaluateGuardrail({
      ...input,
      events: [current, attestationEvent({
        attestationId: 'attestation-old-set',
        expectationSetId: 'set-old',
        recordedAt: 200,
      })],
    });
    assert.equal(currentWithLaterOldSet[0]?.state, 'satisfied');
    assert.deepEqual(currentWithLaterOldSet[0]?.evidenceIds, ['evidence-a']);

    const onlyOldSet = evaluateGuardrail({
      ...input,
      events: [attestationEvent({ attestationId: 'attestation-old-only', expectationSetId: 'set-old', recordedAt: 200 })],
    });
    assert.equal(onlyOldSet[0]?.state, 'unknown');
    assert.equal(onlyOldSet[0]?.observation, 'missing');

    const laterCurrent = evaluateGuardrail({
      ...input,
      events: [current, attestationEvent({
        attestationId: 'attestation-current-later',
        recordedAt: 300,
        evidenceIds: ['evidence-b'],
      })],
    });
    assert.equal(laterCurrent[0]?.state, 'satisfied');
    assert.deepEqual(laterCurrent[0]?.evidenceIds, ['evidence-b']);

    for (const [label, correction] of [
      ['actor', { actor: 'codex' }],
      ['candidate', { candidate: { ...candidate, id: 'tree-b', digest: 'tree-b' } }],
    ] as const) {
      const wrongCurrent = evaluateGuardrail({
        ...input,
        events: [current, attestationEvent({
          attestationId: `attestation-wrong-${label}`,
          recordedAt: 400,
          ...correction,
        })],
      });
      assert.equal(wrongCurrent[0]?.state, 'unknown', `${label} correction must be evaluated as the latest active record`);
    }

    for (const [label, correction] of [
      ['actor', { actor: 'codex' }],
      ['candidate', { candidate: { ...candidate, id: 'tree-b', digest: 'tree-b' } }],
    ] as const) {
      const oldSetCorrection = evaluateGuardrail({
        ...input,
        events: [current, attestationEvent({
          attestationId: `attestation-old-wrong-${label}`,
          expectationSetId: 'set-old',
          recordedAt: 500,
          ...correction,
        })],
      });
      assert.equal(oldSetCorrection[0]?.state, 'satisfied', `${label} old-set record must not shadow the active attestation`);
    }
  });
});

describe('human authority and transition ownership', () => {
  test('a typed answer opens the planning transition while worker prose does not', () => {
    const set = expectation('question-a', 'mandatory-question', 'required', 'user');
    const base = {
      transitionId: 'planning-a',
      attempt: 1,
      runId: null,
      actor: 'user' as const,
      sourceStepId: 'plan',
      targetStepId: 'review',
      expectationSetId: set.expectationSetId,
      candidate,
      evidenceIds: [],
    };
    const guardrailInput = {
      guardrail: guardrail('mandatory-answer', { expectationItem: 'question-a', authority: 'user' }),
      expectationSet: set,
      candidate,
      verify,
      evidence: [],
    };
    const waiting = evaluateTransition({
      attempt: base,
      expectationSet: set,
      facts: evaluateGuardrail({ ...guardrailInput, events: [event({ kind: 'message.completed', itemId: 'm', text: 'answer' })] }),
      timestamp: 20,
    });
    assert.equal(waiting.verdict, 'waiting-for-human');

    const opened = evaluateTransition({
      attempt: base,
      expectationSet: set,
      facts: evaluateGuardrail({ ...guardrailInput, events: [answerEvent({ expectationItemId: 'question-a' })] }),
      timestamp: 21,
    });
    assert.equal(opened.verdict, 'passed');
  });

  test('required overrides remain core-owned and cannot bypass explicit user final authority', () => {
    const overridable = expectation('question-a', 'mandatory-question');
    const override = {
      enforcement: 'required' as const,
      permission: 'explicit' as const,
      permissionGranted: true as const,
      actor: 'user' as const,
      authorizedUserId: 'user-a',
      reason: 'reviewed',
    };
    const overridableResult = evaluateTransition({
      attempt: {
        transitionId: 'transition-a', attempt: 1, runId: null, actor: 'user', sourceStepId: 'plan', targetStepId: 'review',
        expectationSetId: overridable.expectationSetId, candidate, evidenceIds: [],
      },
      expectationSet: overridable,
      facts: [verificationFact({ check: { name: 'test', passed: false, exitCode: 1 } }, 'question-a')],
      timestamp: 30,
      override,
    });
    assert.equal(overridableResult.verdict, 'passed');

    const absoluteHuman = expectation('question-a', 'mandatory-question', 'required', 'user');
    const absoluteResult = evaluateTransition({
      attempt: {
        transitionId: 'transition-b', attempt: 1, runId: null, actor: 'user', sourceStepId: 'plan', targetStepId: 'review',
        expectationSetId: absoluteHuman.expectationSetId, candidate, evidenceIds: [],
      },
      expectationSet: absoluteHuman,
      facts: [verificationFact({ check: { name: 'test', passed: false, exitCode: 1 } }, 'question-a')],
      timestamp: 31,
      override,
    });
    assert.equal(absoluteResult.verdict, 'blocked');
    assert.match(absoluteResult.refusal?.reason ?? '', /cannot be overridden/i);
  });
});
