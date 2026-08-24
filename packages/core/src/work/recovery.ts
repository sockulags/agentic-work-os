import { createHash } from 'node:crypto';
import type {
  AgentId,
  HarnessEvent,
  RecoveryAction,
  RecoveryCorrectionRun,
  RecoveryConflict,
  RecoveryCycle,
  RecoveryCycleStatus,
  RecoveryWorkerContext,
  TransitionEvaluation,
  TransitionFingerprint,
  WorkspaceGuardrail,
} from '@awos/protocol';
import {
  EVALUATOR_DIAGNOSTIC_MAX_CHARS,
  type EvidenceItem,
} from '@awos/protocol';
import { foldTransitionEvaluationHistory } from './ledger.js';

/** Separate from correction-run limits: an evaluator outage must not spend worker runs. */
export const RECOVERY_MAX_TRANSIENT_EVALUATOR_RETRIES = 3;
export const RECOVERY_CONTEXT_MAX_CHARS = 48_000;

export class RecoveryConflictError extends Error {
  readonly conflict: RecoveryConflict;

  constructor(conflict: RecoveryConflict) {
    super(conflict.detail);
    this.name = 'RecoveryConflictError';
    this.conflict = conflict;
  }
}

export interface RecoveryPolicy {
  maxRuns: number;
  maxEvaluations: number;
  onExhausted: 'waiting-for-human' | 'blocked';
  guardrailIds: readonly string[];
}

/** The persisted cycle records, folded without a mutable recovery register. */
export function foldRecoveryCycles(
  events: readonly HarnessEvent[],
  isRunLive: (runId: string) => boolean = () => false,
): RecoveryCycle[] {
  const cycles = new Map<string, MutableCycle>();
  const runStates = new Map<string, 'completed' | 'interrupted' | 'error'>();
  const runStarted = new Set<string>();

  for (const event of events) {
    if (event.kind === 'run.started') runStarted.add(event.runId);
    if (event.kind === 'run.completed') runStates.set(event.runId, event.state);

    switch (event.kind) {
      case 'recovery.cycle.started':
        if (!cycles.has(event.cycleId)) {
          cycles.set(event.cycleId, {
            cycleId: event.cycleId,
            transitionId: event.transitionId,
            refusalAttempt: event.refusalAttempt,
            expectationSetId: event.expectationSetId,
            sourceStepId: event.sourceStepId,
            targetStepId: event.targetStepId,
            maxRuns: event.maxRuns,
            maxEvaluations: event.maxEvaluations,
            onExhausted: event.onExhausted,
            correctionRuns: [],
            actions: [],
            waiting: null,
            escalation: null,
            cancelled: false,
            workerProfileId: null,
            workerAvailable: null,
            workerDetail: null,
            lastEventSeq: event.seq,
            initialFingerprint: event.initialFingerprint,
          });
        }
        break;

      case 'recovery.correction.started': {
        const cycle = cycles.get(event.cycleId);
        if (!cycle || cycle.correctionRuns.some((run) => run.runId === event.runId)) break;
        cycle.correctionRuns.push({
          runId: event.runId,
          cycleId: event.cycleId,
          transitionId: event.transitionId,
          refusalAttempt: event.refusalAttempt,
          correctionIndex: event.correctionIndex,
          workerProfileId: event.workerProfileId,
          fingerprint: event.fingerprint,
          startedAt: event.ts,
          state: 'running',
          interruptedByRestart: false,
          context: event.context,
        });
        cycle.workerProfileId = event.workerProfileId;
        cycle.workerAvailable = true;
        cycle.workerDetail = null;
        cycle.waiting = null;
        cycle.escalation = null;
        cycle.lastEventSeq = event.seq;
        break;
      }

      case 'recovery.cycle.waiting': {
        const cycle = cycles.get(event.cycleId);
        if (!cycle) break;
        cycle.waiting = {
          reason: event.reason,
          required: event.required,
          authority: event.authority,
          detail: event.detail,
        };
        cycle.escalation = null;
        if (event.workerProfileId !== undefined) {
          cycle.workerProfileId = event.workerProfileId;
          cycle.workerAvailable = event.reason === 'worker-unavailable' ? false : cycle.workerAvailable;
          cycle.workerDetail = event.detail;
        }
        cycle.lastEventSeq = event.seq;
        break;
      }

      case 'recovery.cycle.escalated': {
        const cycle = cycles.get(event.cycleId);
        if (!cycle) break;
        cycle.escalation = { reason: event.reason, action: event.action, detail: event.detail };
        cycle.waiting = null;
        cycle.lastEventSeq = event.seq;
        break;
      }

      case 'recovery.action.recorded': {
        const cycle = cycles.get(event.action.cycleId);
        if (!cycle || cycle.actions.some((action) => action.actionId === event.action.actionId)) break;
        cycle.actions.push(event.action);
        // A new typed action supersedes a prior durable wait/escalation only after the
        // transition is evaluated again. Keeping the records is what makes that
        // distinction visible after restart.
        cycle.lastEventSeq = event.seq;
        break;
      }

      case 'recovery.cycle.cancelled': {
        const cycle = cycles.get(event.cycleId);
        if (!cycle) break;
        cycle.cancelled = true;
        cycle.waiting = null;
        cycle.escalation = null;
        cycle.lastEventSeq = event.seq;
        break;
      }

      default:
        break;
    }
  }

  const histories = foldTransitionEvaluationHistory(events);
  return [...cycles.values()].map((cycle) => {
    const attempts = histories.get(cycle.transitionId) ?? [];
    const latestEvaluationSeq = latestEvaluationEventSeq(events, cycle.transitionId);
    return projectCycle(cycle, attempts, latestEvaluationSeq, events.at(-1)?.seq ?? 0, runStarted, runStates, isRunLive);
  });
}

export function findRecoveryCycle(
  events: readonly HarnessEvent[],
  input: { transitionId?: string; cycleId?: string },
  isRunLive: (runId: string) => boolean = () => false,
): RecoveryCycle | null {
  const cycles = foldRecoveryCycles(events, isRunLive).filter((cycle) =>
    (input.cycleId === undefined || cycle.cycleId === input.cycleId) &&
    (input.transitionId === undefined || cycle.transitionId === input.transitionId),
  );
  return cycles.at(-1) ?? null;
}

/** Fingerprint candidate content and referenced evidence records, never their prose summary. */
export function transitionFingerprint(
  evaluation: TransitionEvaluation,
  evidence: readonly EvidenceItem[] = [],
): TransitionFingerprint {
  const evidenceIds = [...new Set([
    ...evaluation.evidenceIds,
    ...evaluation.facts.flatMap((fact) => fact.evidenceIds),
    ...evaluation.provenance.flatMap((provenance) => provenance.evidenceIds),
  ])].sort();
  const records = evidence
    .filter((item) => evidenceIds.includes(item.id))
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      ref: { eventId: item.ref.eventId, url: item.ref.url },
      state: item.state,
      check: item.check,
      expectationSetId: item.expectationSetId ?? null,
      expectationItemId: item.expectationItemId ?? null,
      visualIdentity: item.visual === undefined ? null : visualIdentity(item.visual),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const candidate = cloneCandidate(evaluation.candidate);
  const digest = createHash('sha256').update(JSON.stringify({ candidate, evidenceIds, records })).digest('hex');
  return { candidate, evidenceIds, digest };
}

export function sameTransitionFingerprint(left: TransitionFingerprint, right: TransitionFingerprint): boolean {
  return left.digest === right.digest &&
    JSON.stringify(left.candidate) === JSON.stringify(right.candidate) &&
    JSON.stringify(left.evidenceIds) === JSON.stringify(right.evidenceIds);
}

/** Select the most conservative correction policy from guardrails attached to this edge. */
export function recoveryPolicy(
  guardrails: readonly WorkspaceGuardrail[],
  evaluation: TransitionEvaluation,
): RecoveryPolicy {
  const relevant = guardrails.filter((guardrail) => {
    if ('step' in guardrail.attach) return guardrail.attach.step === evaluation.targetStepId;
    return guardrail.attach.from === evaluation.sourceStepId && guardrail.attach.to === evaluation.targetStepId;
  });
  const policies = relevant.length > 0 ? relevant : guardrails;
  const maxRuns = policies.length === 0
    ? 0
    : Math.min(...policies.map((guardrail) => clampRuns(guardrail.correction.maxRuns)));
  const onExhausted = policies.some((guardrail) => guardrail.correction.onExhausted === 'blocked')
    ? 'blocked'
    : 'waiting-for-human';
  return {
    maxRuns,
    maxEvaluations: maxRuns + 1,
    onExhausted,
    guardrailIds: policies.map((guardrail) => guardrail.id),
  };
}

/** A refusal with no current evaluator observation can be retried without a worker run. */
export function isTransientEvaluatorRefusal(evaluation: TransitionEvaluation): boolean {
  if (evaluation.verdict !== 'retry' || evaluation.refusal === null) return false;
  if (evaluation.refusal.nextAction === 'provide-answer' || evaluation.refusal.nextAction === 'escalate') return false;
  const unmet = new Set(evaluation.refusal.unmetRequirementIds);
  if (unmet.size === 0) return false;
  const facts = evaluation.facts.filter((fact) => unmet.has(fact.requirementId));
  return facts.length === unmet.size && facts.every((fact) =>
    fact.state === 'unknown' &&
    fact.observation !== 'missing' &&
    (fact.provenance.validity === 'unavailable' || fact.provenance.validity === 'uncertain'),
  );
}

/** Whether exhaustion may safely wait for a typed human action. Absolute intent never can. */
export function hasValidHumanRecoveryAction(evaluation: TransitionEvaluation): boolean {
  if (evaluation.refusal === null || evaluation.refusal.retryable === false) return false;
  if (evaluation.refusal.nextAction === 'escalate') return false;
  if (evaluation.refusal.nextAction === 'provide-answer') return evaluation.refusal.required.kind === 'structured-answer';
  if (evaluation.refusal.nextAction === 'provide-evidence' || evaluation.refusal.nextAction === 'correct-candidate') {
    return evaluation.refusal.required.kind === 'evidence';
  }
  if (evaluation.refusal.nextAction === 'request-override') {
    return evaluation.enforcement.some((entry) =>
      entry.enforcement === 'required' && entry.allowOverride === true && entry.authority !== 'user',
    );
  }
  return false;
}

export function buildRecoveryWorkerContext(input: {
  cycleId: string;
  correctionIndex: number;
  refusalAttempt?: number;
  evaluation: TransitionEvaluation;
  attempts: readonly TransitionEvaluation[];
  actions: readonly RecoveryAction[];
  fingerprint: TransitionFingerprint;
}): RecoveryWorkerContext {
  if (input.evaluation.refusal === null) throw new Error('A correction worker needs a structured transition refusal.');
  return boundRecoveryContext({
    schema: 'awos.recovery.v1',
    cycleId: input.cycleId,
    transitionId: input.evaluation.transitionId,
    refusalAttempt: input.refusalAttempt ?? input.evaluation.attempt,
    correctionIndex: input.correctionIndex,
    sourceStepId: input.evaluation.sourceStepId,
    targetStepId: input.evaluation.targetStepId,
    expectationSetId: input.evaluation.expectationSetId,
    fingerprint: input.fingerprint,
    blocker: input.evaluation.refusal,
    evaluation: input.evaluation,
    attempts: input.attempts,
    actions: input.actions,
  });
}

/** Deterministic bounded JSON for the worker prompt. Structured ids remain in the event. */
export function serializeRecoveryContext(context: RecoveryWorkerContext): string {
  const json = JSON.stringify(context, null, 2);
  if (json.length <= RECOVERY_CONTEXT_MAX_CHARS) return json;
  const compact = boundRecoveryContext(context);
  const compactJson = JSON.stringify(compact, null, 2);
  if (compactJson.length <= RECOVERY_CONTEXT_MAX_CHARS) return compactJson;

  // Keep the complete blocker and all retrieval ids in a separately addressable object;
  // only evaluator prose is shortened when a pathological log exceeds the prompt budget.
  const bounded = {
    schema: context.schema,
    cycleId: context.cycleId,
    transitionId: context.transitionId,
    refusalAttempt: context.refusalAttempt,
    correctionIndex: context.correctionIndex,
    sourceStepId: context.sourceStepId,
    targetStepId: context.targetStepId,
    expectationSetId: context.expectationSetId,
    fingerprint: context.fingerprint,
    blocker: boundRefusal(context.blocker),
    evaluation: boundEvaluation(context.evaluation),
    attempts: context.attempts.map(boundEvaluation),
    actions: context.actions.map((action) => ({
      ...action,
      reason: action.reason === undefined || action.reason === null ? action.reason : boundText(action.reason),
      evidenceIds: [...action.evidenceIds],
      candidate: cloneCandidate(action.candidate),
    })),
    retrievalIds: [...new Set([
      ...context.evaluation.evidenceIds,
      ...context.evaluation.facts.flatMap((fact) => fact.evidenceIds),
      ...context.evaluation.provenance.flatMap((provenance) => provenance.evidenceIds),
      ...context.actions.flatMap((action) => action.evidenceIds),
    ])],
    truncated: true,
  };
  const boundedJson = JSON.stringify(bounded);
  if (boundedJson.length > RECOVERY_CONTEXT_MAX_CHARS) {
    throw new Error('The structured recovery context exceeds its bounded serialization limit.');
  }
  return boundedJson;
}

/** Prompt framing is structured JSON, not a lossy summary of `refusal.reason`. */
export function recoveryWorkerPrompt(context: RecoveryWorkerContext): string {
  return [
    'Correct the refused transition in the current workspace.',
    'Do not change the transition target, expectation set, worker profile, or policy.',
    'Use only the structured recovery context below. A refusal is not permission to bypass a guardrail.',
    '<awos-recovery-context>',
    serializeRecoveryContext(context),
    '</awos-recovery-context>',
  ].join('\n');
}

interface MutableCycle {
  cycleId: string;
  transitionId: string;
  refusalAttempt: number;
  expectationSetId: string;
  sourceStepId: string;
  targetStepId: string;
  maxRuns: number;
  maxEvaluations: number;
  onExhausted: 'waiting-for-human' | 'blocked';
  correctionRuns: RecoveryCorrectionRun[];
  actions: RecoveryAction[];
  waiting: RecoveryCycle['waiting'];
  escalation: RecoveryCycle['escalation'];
  cancelled: boolean;
  workerProfileId: AgentId | null;
  workerAvailable: boolean | null;
  workerDetail: string | null;
  lastEventSeq: number;
  initialFingerprint: TransitionFingerprint;
}

function projectCycle(
  cycle: MutableCycle,
  attempts: readonly TransitionEvaluation[],
  latestEvaluationSeq: number,
  head: number,
  runStarted: ReadonlySet<string>,
  runStates: ReadonlyMap<string, 'completed' | 'interrupted' | 'error'>,
  isRunLive: (runId: string) => boolean,
): RecoveryCycle {
  const correctionRuns: RecoveryCorrectionRun[] = cycle.correctionRuns.map((run) => {
    const terminal = runStates.get(run.runId);
    const live = isRunLive(run.runId);
    return {
      ...run,
      state: (live ? 'running' : terminal ?? 'interrupted') as RecoveryCorrectionRun['state'],
      interruptedByRestart: terminal === undefined && !live && (runStarted.has(run.runId) || !live),
    };
  });
  const activeCorrection = correctionRuns.find((run) => run.state === 'running') ?? null;
  const latestEvaluation = attempts.at(-1) ?? null;
  const correctionRunIds = new Set(correctionRuns.map((run) => run.runId));
  const correctionEvaluations = attempts.filter((attempt) => attempt.runId !== null && correctionRunIds.has(attempt.runId)).length;
  const currentWaiting = cycle.waiting !== null && cycle.lastEventSeq > latestEvaluationSeq ? cycle.waiting : null;
  const currentEscalation = cycle.escalation !== null && cycle.lastEventSeq > latestEvaluationSeq ? cycle.escalation : null;
  let status: RecoveryCycleStatus;

  if (cycle.cancelled) status = 'cancelled';
  else if (activeCorrection !== null) status = 'correcting';
  else if (latestEvaluation?.verdict === 'passed') status = 'passed';
  else if (currentEscalation !== null) {
    // Exhaustion is an explanation, not a third terminal policy: a valid required
    // human action remains waiting-human, while an invalid/absolute exhaustion blocks.
    status = currentEscalation.action === 'blocked' ? 'blocked' : 'waiting-human';
  } else if (currentWaiting?.reason === 'worker-unavailable') {
    status = 'worker-unavailable';
  } else if (latestEvaluation?.verdict === 'blocked' || latestEvaluation?.verdict === 'failed') {
    status = 'blocked';
  } else if (latestEvaluation?.verdict === 'waiting-for-human' || currentWaiting !== null) {
    status = 'waiting-human';
  } else if (correctionRuns.some((run) => run.state === 'interrupted')) {
    status = 'interrupted';
  } else {
    status = 'waiting-human';
  }

  return {
    cycleId: cycle.cycleId,
    head,
    transitionId: cycle.transitionId,
    refusalAttempt: cycle.refusalAttempt,
    expectationSetId: cycle.expectationSetId,
    sourceStepId: cycle.sourceStepId,
    targetStepId: cycle.targetStepId,
    maxRuns: cycle.maxRuns,
    maxEvaluations: cycle.maxEvaluations,
    onExhausted: cycle.onExhausted,
    status,
    correctionRuns,
    activeCorrection,
    correctionsUsed: correctionRuns.length,
    // The initial refusal plus evaluations linked to correction runs. Human actions and
    // transient evaluator retries are deliberately outside the worker correction budget.
    evaluationsUsed: (attempts.length > 0 ? 1 : 0) + correctionEvaluations,
    transientEvaluatorRetries: cycle.actions.filter((action) => action.kind === 'retry-evaluator').length,
    latestEvaluation,
    attempts: [...attempts],
    actions: cycle.actions.map((action) => ({ ...action, evidenceIds: [...action.evidenceIds], candidate: cloneCandidate(action.candidate) })),
    waiting: currentWaiting,
    escalation: currentEscalation,
    cancelled: cycle.cancelled,
    worker: {
      profileId: cycle.workerProfileId,
      available: cycle.workerAvailable,
      detail: cycle.workerDetail,
    },
  };
}

function latestEvaluationEventSeq(events: readonly HarnessEvent[], transitionId: string): number {
  let seq = -1;
  for (const event of events) {
    if (event.kind === 'transition.evaluated' && event.evaluation.transitionId === transitionId) seq = event.seq;
    else if (event.kind === 'gate.evaluated' && event.evaluation?.transitionId === transitionId) seq = event.seq;
  }
  return seq;
}

function boundRecoveryContext(context: RecoveryWorkerContext): RecoveryWorkerContext {
  return {
    ...context,
    blocker: boundRefusal(context.blocker),
    evaluation: boundEvaluation(context.evaluation),
    attempts: context.attempts.map(boundEvaluation),
    actions: context.actions.map((action) => ({
      ...action,
      reason: action.reason === undefined || action.reason === null ? action.reason : boundText(action.reason),
      evidenceIds: [...action.evidenceIds],
      candidate: cloneCandidate(action.candidate),
    })),
    fingerprint: {
      ...context.fingerprint,
      candidate: cloneCandidate(context.fingerprint.candidate),
      evidenceIds: [...context.fingerprint.evidenceIds],
    },
  };
}

function boundRefusal(refusal: TransitionEvaluation['refusal'] & {}): TransitionEvaluation['refusal'] & {} {
  return {
    ...refusal,
    unmetRequirementIds: [...refusal.unmetRequirementIds],
    reason: boundText(refusal.reason),
    required: refusal.required.kind === 'evidence'
      ? {
          kind: 'evidence',
          evidence: {
            requirementIds: [...refusal.required.evidence.requirementIds],
            description: boundText(refusal.required.evidence.description),
          },
        }
      : {
          kind: 'structured-answer',
          answer: {
            questionId: refusal.required.answer.questionId,
            description: boundText(refusal.required.answer.description),
            schema: refusal.required.answer.schema === null ? null : boundText(refusal.required.answer.schema),
          },
        },
  };
}

function boundEvaluation(evaluation: TransitionEvaluation): TransitionEvaluation {
  return {
    ...evaluation,
    evidenceIds: [...evaluation.evidenceIds],
    facts: evaluation.facts.map((fact) => ({
      ...fact,
      detail: fact.detail === null ? null : boundText(fact.detail),
      diagnostics: (fact.diagnostics ?? []).map(boundText),
      evidenceIds: [...fact.evidenceIds],
      provenance: {
        ...fact.provenance,
        detail: fact.provenance.detail === null ? null : boundText(fact.provenance.detail),
        evidenceIds: [...fact.provenance.evidenceIds],
        candidate: cloneCandidate(fact.provenance.candidate),
      },
    })),
    provenance: evaluation.provenance.map((provenance) => ({
      ...provenance,
      detail: provenance.detail === null ? null : boundText(provenance.detail),
      evidenceIds: [...provenance.evidenceIds],
      candidate: cloneCandidate(provenance.candidate),
    })),
    enforcement: evaluation.enforcement.map((entry) => ({ ...entry })),
    candidate: cloneCandidate(evaluation.candidate),
    refusal: evaluation.refusal === null ? null : boundRefusal(evaluation.refusal),
  } as TransitionEvaluation;
}

function boundText(value: string): string {
  return value.length <= EVALUATOR_DIAGNOSTIC_MAX_CHARS
    ? value
    : `${value.slice(0, EVALUATOR_DIAGNOSTIC_MAX_CHARS)}…`;
}

function clampRuns(value: number): number {
  return Number.isInteger(value) && value >= 0 && value <= 5 ? value : 0;
}

function cloneCandidate(candidate: TransitionEvaluation['candidate']): TransitionEvaluation['candidate'] {
  return { ...candidate };
}

function visualIdentity(value: NonNullable<EvidenceItem['visual']>): unknown {
  if (value.kind === 'pixel-diff') {
    return {
      kind: value.kind,
      reference: value.reference,
      candidate: value.candidate,
      capture: value.capture,
      measurement: value.measurement,
    };
  }
  return {
    kind: value.kind,
    reference: value.reference,
    candidate: value.candidate,
    rubric: value.rubric,
    evaluator: value.evaluator,
    outcome: value.outcome,
  };
}
