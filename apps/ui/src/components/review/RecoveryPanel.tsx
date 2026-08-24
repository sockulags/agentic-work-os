import { useRef, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  Check,
  GitCompareArrows,
  KeyRound,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
} from 'lucide-react';
import type {
  AgentId,
  CandidateIdentity,
  EvaluatorFact,
  EvidenceItem as EvidenceRecord,
  RecoveryActionRequest,
  RecoveryCycle,
  RecoveryCycleStatus,
  TransitionEvaluation,
  TransitionNextAction,
  TypedAnswer,
  VisualEvidence,
} from '@awos/protocol';
import { useHarnessContext } from '@/state/HarnessContext';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ReviewState, type ReviewStateName } from './ReviewPatterns';
import type { RunView } from '@/lib/runs';
import { cn } from '@/lib/utils';

const STATUS_META: Record<
  RecoveryCycleStatus,
  { state: ReviewStateName; label: string }
> = {
  correcting: { state: 'busy', label: 'Correction in progress' },
  'waiting-human': { state: 'waiting', label: 'Waiting for human action' },
  'worker-unavailable': { state: 'waiting', label: 'Worker unavailable' },
  interrupted: { state: 'interrupted', label: 'Interrupted after restart' },
  exhausted: { state: 'waiting', label: 'Correction budget exhausted' },
  blocked: { state: 'blocked', label: 'Blocked' },
  passed: { state: 'passed', label: 'Passed' },
  cancelled: { state: 'stale', label: 'Cancelled' },
};

const NEXT_ACTION_LABEL: Record<TransitionNextAction, string> = {
  'correct-candidate': 'Correct the candidate',
  'provide-evidence': 'Provide evidence',
  'provide-answer': 'Provide a typed answer',
  'request-override': 'Request a required-intent override',
  escalate: 'Escalate',
};

type DialogKind = 'answer' | 'evidence' | 'override' | 'repin' | 'cancel' | 'retry-evaluator';

interface RecoveryPanelProps {
  /** Optional fixture/test override; normal product rendering reads the core projection. */
  cycles?: readonly RecoveryCycle[];
  runs?: readonly RunView[];
}

/**
 * The recovery surface is a view over the core's durable projection.
 *
 * It deliberately does not fold a verdict, decide whether a retry is safe, or construct a
 * policy. The current refusal, responsible actor, next action, attempt and log head all
 * come from `RecoveryCycle`; the only local lookup is finding visual evidence already in
 * the event-derived run views so the immutable reference/candidate identities are readable.
 */
export function RecoveryPanel({ cycles: cycleOverride, runs: runsOverride }: RecoveryPanelProps = {}): React.JSX.Element | null {
  const harness = useHarnessContext();
  const cycles = cycleOverride ?? harness.runtime?.recovery ?? [];
  const runs = runsOverride ?? harness.runs;

  if (cycles.length === 0) return null;

  return (
    <section className="min-w-0 space-y-2 border-t border-border pt-2" aria-labelledby="recovery-heading">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <h3 id="recovery-heading" className="text-[10px] font-medium uppercase tracking-wide text-foreground">
          Recovery
        </h3>
        <span className="text-[10px] text-muted-foreground">Core-owned decisions</span>
      </div>
      <div className="space-y-2">
        {cycles.map((cycle) => (
          <RecoveryCycleCard key={cycle.cycleId} cycle={cycle} runs={runs} />
        ))}
      </div>
    </section>
  );
}

function RecoveryCycleCard({ cycle, runs }: { cycle: RecoveryCycle; runs: readonly RunView[] }): React.JSX.Element {
  const { startRecovery, applyRecoveryAction } = useHarnessContext();
  const latest = cycle.latestEvaluation;
  const refusal = latest?.refusal ?? null;
  const status = STATUS_META[cycle.status];
  const visualEvidence = visualEvidenceFor(runs, latest?.evidenceIds ?? []);
  const lastCorrection = cycle.correctionRuns.at(-1) ?? null;
  const responsibleWorker = recoveryWorker(cycle, refusal, cycle.status === 'interrupted');
  const workerDetail = workerStatus(cycle);
  const replacementTransitionId = cycle.actions.at(-1)?.supersededByTransitionId ?? null;
  const reason = cycle.escalation?.detail ?? refusal?.reason ?? latest?.verdict ?? 'No current evaluation.';
  const staleFacts = latest?.facts.filter((fact) => fact.observation === 'stale' || fact.provenance.validity === 'stale') ?? [];
  const correctionsRemaining = Math.max(0, cycle.maxRuns - cycle.correctionsUsed);
  const evaluationsRemaining = Math.max(0, cycle.maxEvaluations - cycle.evaluationsUsed);

  const start = (agent: AgentId): void => {
    if (latest === null) return;
    void startRecovery({
      transitionId: cycle.transitionId,
      expectedAttempt: latest.attempt,
      expectedHead: cycle.head,
      agent,
      cycleId: cycle.cycleId,
    });
  };

  const submitAction = (action: RecoveryActionRequest): void => {
    void applyRecoveryAction(action);
  };

  return (
    <article
      className={cn(
        'min-w-0 space-y-2 rounded-md border border-border bg-surface-raised p-2.5',
        cycle.status === 'blocked' && 'border-state-blocked-border',
      )}
      aria-labelledby={`recovery-cycle-${cycle.cycleId}`}
    >
      <header className="min-w-0 space-y-1">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-2 gap-y-1">
          <h4 id={`recovery-cycle-${cycle.cycleId}`} className="min-w-0 break-words font-medium">
            {cycle.sourceStepId} <span aria-hidden="true">→</span> {cycle.targetStepId}
          </h4>
          <ReviewState state={status.state} label={status.label} />
        </div>
        <p className="break-all font-mono text-[10px] text-muted-foreground">
          transition {cycle.transitionId} · cycle {cycle.cycleId}
        </p>
      </header>

      <dl className="grid min-w-0 gap-1.5 text-[11px]">
        <RecoveryField label="Primary reason">
          <span className="break-words">{reason}</span>
        </RecoveryField>
        <RecoveryField label="Responsible actor">
          <span className="break-all font-mono">{refusal?.responsibleActor ?? '—'}</span>
        </RecoveryField>
        <RecoveryField label="Core action">
          <span className="break-words">
            {cycle.escalation
              ? escalationActionLabel(cycle.escalation.action)
              : refusal
                ? NEXT_ACTION_LABEL[refusal.nextAction]
                : latest?.verdict ?? '—'}
          </span>
        </RecoveryField>
        <RecoveryField label="Corrections remaining">
          <span>{correctionsRemaining} of {cycle.maxRuns}</span>
          <span className="ml-1 text-[10px] text-muted-foreground">
            · evaluations {evaluationsRemaining} of {cycle.maxEvaluations}
          </span>
        </RecoveryField>
        {workerDetail && (
          <RecoveryField label="Worker status">
            <span className="break-words">{workerDetail}</span>
          </RecoveryField>
        )}
      </dl>

      {refusal?.required.kind === 'structured-answer' && (
        <section className="space-y-1 rounded-md border border-state-waiting-border bg-state-waiting-surface px-2 py-1.5" aria-labelledby={`recovery-question-${cycle.cycleId}`}>
          <h5 id={`recovery-question-${cycle.cycleId}`} className="text-[10px] font-medium text-state-waiting">Exact question and authority</h5>
          <p className="break-words text-[10px] text-state-waiting">{refusal.required.answer.description}</p>
          <p className="break-all font-mono text-[10px] text-state-waiting">question {refusal.required.answer.questionId} · authority user</p>
        </section>
      )}

      {visualEvidence.length > 0 && (
        <VisualComparison
          cycleId={cycle.cycleId}
          evidence={visualEvidence}
          candidate={latest?.candidate ?? null}
        />
      )}

      {latest && visualEvidence.length === 0 && latest.evidenceIds.length > 0 && (
        <section className="min-w-0 rounded-md border border-border bg-muted/20 p-2" aria-labelledby={`recovery-evidence-${cycle.cycleId}`}>
          <h5 id={`recovery-evidence-${cycle.cycleId}`} className="mb-1 flex items-center gap-1.5 text-[10px] font-medium">
            <GitCompareArrows className="h-3 w-3 shrink-0" aria-hidden="true" />
            Referenced evidence
          </h5>
          <p className="break-all font-mono text-[10px] text-muted-foreground">
            {latest.evidenceIds.join(' · ')}
          </p>
        </section>
      )}

      {staleFacts.length > 0 && <StaleEvidenceNotice cycleId={cycle.cycleId} facts={staleFacts} />}

      {cycle.activeCorrection && (
        <CorrectionContextNotice correction={cycle.activeCorrection} />
      )}

      {cycle.waiting && (
        <section className="space-y-1 rounded-md border border-state-waiting-border bg-state-waiting-surface px-2 py-1.5" aria-labelledby={`recovery-waiting-${cycle.cycleId}`}>
          <h5 id={`recovery-waiting-${cycle.cycleId}`} className="text-[10px] font-medium text-state-waiting">Core waiting state</h5>
          <p className="break-words text-[10px] text-state-waiting">{cycle.waiting.detail}</p>
          <p className="break-all font-mono text-[10px] text-state-waiting">reason {cycle.waiting.reason} · authority {cycle.waiting.authority}</p>
        </section>
      )}

      {cycle.status === 'interrupted' && lastCorrection?.interruptedByRestart && (
        <p className="rounded-md border border-state-interrupted-border bg-state-interrupted-surface px-2 py-1.5 text-[10px] text-state-interrupted">
          This historical correction run is not live after restart. Choose Resume or Cancel explicitly.
        </p>
      )}

      {cycle.escalation && (
        <section className="space-y-1 rounded-md border border-state-blocked-border bg-state-blocked-surface px-2 py-1.5" aria-labelledby={`recovery-escalation-${cycle.cycleId}`}>
          <h5 id={`recovery-escalation-${cycle.cycleId}`} className="flex items-center gap-1.5 text-[10px] font-medium text-state-blocked">
            <ShieldAlert className="h-3 w-3 shrink-0" aria-hidden="true" />
            Core escalation: {cycle.escalation.reason}
          </h5>
          <p className="break-words text-[10px] text-state-blocked">{cycle.escalation.detail}</p>
          <p className="text-[10px] font-medium text-state-blocked">
            Action: {escalationActionLabel(cycle.escalation.action)}
          </p>
        </section>
      )}

      {cycle.status === 'cancelled' && replacementTransitionId && (
        <p className="rounded-md border border-state-stale-border bg-state-stale-surface px-2 py-1.5 text-[10px] text-state-stale">
          Superseded by transition {replacementTransitionId}. The earlier cycle remains historical.
        </p>
      )}

      <RecoveryActions
        cycle={cycle}
        latest={latest}
        refusal={refusal}
        worker={responsibleWorker}
        onStart={start}
        onAction={submitAction}
      />

      <RecoveryDetails cycle={cycle} />
    </article>
  );
}

function RecoveryField({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid min-w-0 grid-cols-[7.5rem_minmax(0,1fr)] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function VisualComparison({
  cycleId,
  evidence,
  candidate,
}: {
  cycleId: string;
  evidence: readonly EvidenceRecord[];
  candidate: CandidateIdentity | null;
}): React.JSX.Element {
  return (
    <section className="min-w-0 space-y-1.5 rounded-md border border-border bg-muted/20 p-2" aria-labelledby={`visual-comparison-heading-${cycleId}`}>
      <h5 id={`visual-comparison-heading-${cycleId}`} className="flex items-center gap-1.5 text-[10px] font-medium">
        <GitCompareArrows className="h-3 w-3 shrink-0" aria-hidden="true" />
        Reference and candidate comparison
      </h5>
      {evidence.map((item) => {
        const visual = item.visual;
        if (visual === undefined) return null;
        return (
          <div key={item.id} className="min-w-0 space-y-1 border-t border-border pt-1.5">
            <p className="break-all font-mono text-[10px] text-muted-foreground">evidence {item.id}</p>
            <div className="grid min-w-0 gap-1.5 sm:grid-cols-2">
              <VisualIdentity label="Reference" identity={visual.reference} />
              <VisualIdentity label="Evaluated candidate" identity={visual.candidate} />
            </div>
            {visual.kind === 'pixel-diff' ? (
              <p className="break-words text-[10px] text-muted-foreground">
                Pixel comparator: {visual.measurement.equal ? 'equal' : 'different'} · {visual.measurement.differentPixels} different of {visual.measurement.comparedPixels} compared · {visual.measurement.exact ? 'exact' : 'non-exact'}
              </p>
            ) : (
              <p className="break-words text-[10px] text-muted-foreground">
                Rubric outcome: {visual.outcome}{visual.detail ? ` · ${visual.detail}` : ''}
              </p>
            )}
          </div>
        );
      })}
      {candidate && (
        <p className="break-all border-t border-border pt-1.5 font-mono text-[10px] text-muted-foreground">
          transition candidate · {candidate.kind} · {candidate.id} · revision {candidate.revision ?? 'none'} · digest {candidate.digest ?? 'none'}
        </p>
      )}
    </section>
  );
}

function VisualIdentity({
  label,
  identity,
}: {
  label: string;
  identity: Extract<VisualEvidence, { kind: 'pixel-diff' | 'model-rubric' }>['reference'];
}): React.JSX.Element {
  return (
    <div className="min-w-0 rounded border border-border bg-surface-raised px-2 py-1.5">
      <p className="text-[10px] font-medium">{label}</p>
      <p className="break-all font-mono text-[10px] text-muted-foreground">
        artifact {identity.artifactId}
        <br />revision {identity.revision}
        <br />digest {identity.digest}
        <br />{identity.locator}
      </p>
    </div>
  );
}

/**
 * Prior evidence that the core marked stale is primary content, not a detail.
 *
 * The reason text is the evaluator's own; the panel only groups the stale facts and names
 * the authority the core recorded as able to pin a replacement reference.
 */
function StaleEvidenceNotice({
  cycleId,
  facts,
}: {
  cycleId: string;
  facts: readonly EvaluatorFact[];
}): React.JSX.Element {
  const authority = facts.find((fact) => fact.authority !== undefined)?.authority ?? 'user';
  return (
    <section
      className="min-w-0 space-y-1 rounded-md border border-state-stale-border bg-state-stale-surface px-2 py-1.5"
      aria-labelledby={`recovery-stale-${cycleId}`}
    >
      <h5 id={`recovery-stale-${cycleId}`} className="flex items-center gap-1.5 text-[10px] font-medium text-state-stale">
        <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
        Prior evidence is stale
      </h5>
      <ul className="space-y-0.5 text-[10px] text-state-stale">
        {facts.map((fact) => (
          <li key={fact.requirementId} className="break-words">
            {fact.detail ?? 'The recorded evidence was produced against a different pinned reference.'}
          </li>
        ))}
      </ul>
      <p className="break-words text-[10px] text-state-stale">
        Only the {authority} may pin a replacement reference; the core then records the superseding transition.
      </p>
    </section>
  );
}

function CorrectionContextNotice({
  correction,
}: {
  correction: NonNullable<RecoveryCycle['activeCorrection']>;
}): React.JSX.Element {
  return (
    <section className="rounded-md border border-state-busy-border bg-state-busy-surface px-2 py-1.5" aria-labelledby={`recovery-context-${correction.runId}`}>
      <h5 id={`recovery-context-${correction.runId}`} className="flex items-center gap-1.5 text-[10px] font-medium text-state-busy">
        <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" />
        Correction worker active
      </h5>
      <p className="mt-0.5 break-words text-[10px] text-state-busy">
        Structured recovery context delivered to {correction.workerProfileId} · run <span className="break-all font-mono">{correction.runId}</span> · schema {correction.context.schema}
      </p>
      <p className="mt-0.5 text-[10px] text-state-busy">The full structured payload is retained on the run context and is not duplicated here.</p>
    </section>
  );
}

function RecoveryActions({
  cycle,
  latest,
  refusal,
  worker,
  onStart,
  onAction,
}: {
  cycle: RecoveryCycle;
  latest: TransitionEvaluation | null;
  refusal: NonNullable<TransitionEvaluation['refusal']> | null;
  worker: AgentId | null;
  onStart: (agent: AgentId) => void;
  onAction: (action: RecoveryActionRequest) => void;
}): React.JSX.Element | null {
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const interrupted = cycle.status === 'interrupted';
  const canStartWorker = refusal?.nextAction === 'correct-candidate' && latest !== null && cycle.activeCorrection === null && cycle.escalation === null && !cycle.cancelled && worker !== null;
  const canRetryEvaluator = cycle.waiting?.reason === 'transient-evaluator' && latest !== null && cycle.escalation === null && !cycle.cancelled;
  const canCancel = refusal !== null && latest !== null && !cycle.cancelled;
  const canRepin = refusal !== null && latest !== null && !cycle.cancelled;
  const canAnswer = refusal?.nextAction === 'provide-answer' && latest !== null && !cycle.cancelled;
  const canEvidence = refusal?.nextAction === 'provide-evidence' && latest !== null && !cycle.cancelled;
  const canOverride = refusal?.nextAction === 'request-override' && latest !== null && !cycle.cancelled;

  if (
    !canStartWorker &&
    !canRetryEvaluator &&
    !canCancel &&
    !canRepin &&
    !canAnswer &&
    !canEvidence &&
    !canOverride
  ) return null;

  const openDialog = (kind: DialogKind, event: React.MouseEvent<HTMLButtonElement>): void => {
    triggerRef.current = event.currentTarget;
    setDialog(kind);
  };

  const closeDialog = (): void => setDialog(null);

  return (
    <>
      <div className="flex min-w-0 flex-wrap gap-1.5 border-t border-border pt-2" aria-label="Recovery actions">
        {canStartWorker && worker && (
          <Button
            type="button"
            size="sm"
            variant="default"
            onClick={() => onStart(worker)}
            className="h-auto max-w-full px-2 py-1 text-[10px]"
          >
            <Play className="h-3 w-3 shrink-0" aria-hidden="true" />
            {interrupted ? `Resume correction with ${worker}` : `Start correction with ${worker}`}
          </Button>
        )}
        {canRetryEvaluator && latest && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={(event) => openDialog('retry-evaluator', event)}
            className="h-auto px-2 py-1 text-[10px]"
          >
            <RefreshCw className="h-3 w-3 shrink-0" aria-hidden="true" />
            Retry evaluator
          </Button>
        )}
        {canAnswer && (
          <Button type="button" size="sm" variant="outline" onClick={(event) => openDialog('answer', event)} className="h-auto px-2 py-1 text-[10px]">
            <Check className="h-3 w-3 shrink-0" aria-hidden="true" />
            Provide typed answer
          </Button>
        )}
        {canEvidence && (
          <Button type="button" size="sm" variant="outline" onClick={(event) => openDialog('evidence', event)} className="h-auto px-2 py-1 text-[10px]">
            <Check className="h-3 w-3 shrink-0" aria-hidden="true" />
            Submit evidence
          </Button>
        )}
        {canOverride && (
          <Button type="button" size="sm" variant="outline" onClick={(event) => openDialog('override', event)} className="h-auto px-2 py-1 text-[10px]">
            <KeyRound className="h-3 w-3 shrink-0" aria-hidden="true" />
            Request core override
          </Button>
        )}
        {canRepin && (
          <Button type="button" size="sm" variant="outline" onClick={(event) => openDialog('repin', event)} className="h-auto px-2 py-1 text-[10px]">
            <RotateCcw className="h-3 w-3 shrink-0" aria-hidden="true" />
            Replace reference
          </Button>
        )}
        {canCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={(event) => openDialog('cancel', event)} className="h-auto px-2 py-1 text-[10px]">
            <Ban className="h-3 w-3 shrink-0" aria-hidden="true" />
            Cancel recovery
          </Button>
        )}
      </div>

      {dialog && latest && refusal && (
        <RecoveryActionDialog
          kind={dialog}
          cycle={cycle}
          latest={latest}
          refusal={refusal}
          onClose={closeDialog}
          onAction={(action) => {
            onAction(action);
            closeDialog();
          }}
          triggerRef={triggerRef}
        />
      )}
    </>
  );
}

function RecoveryActionDialog({
  kind,
  cycle,
  latest,
  refusal,
  onClose,
  onAction,
  triggerRef,
}: {
  kind: DialogKind;
  cycle: RecoveryCycle;
  latest: TransitionEvaluation;
  refusal: NonNullable<TransitionEvaluation['refusal']>;
  onClose: () => void;
  onAction: (action: RecoveryActionRequest) => void;
  triggerRef: React.MutableRefObject<HTMLElement | null>;
}): React.JSX.Element {
  const firstInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [value, setValue] = useState('');
  const [secondaryValue, setSecondaryValue] = useState('');
  const [credential, setCredential] = useState('');
  const [candidateKind, setCandidateKind] = useState<CandidateIdentity['kind']>('revision');
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>([]);
  const schema = refusal.required.kind === 'structured-answer' ? refusal.required.answer.schema : null;
  const answerType = answerTypeForSchema(schema);

  const title = dialogTitle(kind);
  const description = dialogDescription(kind, refusal);

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const base = {
      cycleId: cycle.cycleId,
      expectedAttempt: latest.attempt,
      expectedTransitionId: cycle.transitionId,
      expectedHead: cycle.head,
    };

    if (kind === 'answer') {
      const answer = typedAnswer(answerType, value);
      if (answer === null) return;
      if (refusal.required.kind !== 'structured-answer') return;
      onAction({
        kind: 'answer',
        ...base,
        questionId: refusal.required.answer.questionId,
        expectationItemId: refusal.required.answer.questionId,
        expectationSetId: cycle.expectationSetId,
        answer,
        candidate: { ...latest.candidate },
        ...(credential.trim() === '' ? {} : { humanCredential: credential.trim() }),
      });
      return;
    }

    if (kind === 'evidence') {
      if (selectedEvidence.length === 0) return;
      onAction({
        kind: 'evidence',
        ...base,
        evidenceIds: selectedEvidence,
        candidate: { ...latest.candidate },
        ...(credential.trim() === '' ? {} : { humanCredential: credential.trim() }),
      });
      return;
    }

    if (kind === 'retry-evaluator') {
      onAction({
        ...base,
        kind: 'retry-evaluator',
        ...(credential.trim() === '' ? {} : { humanCredential: credential.trim() }),
      });
      return;
    }

    if (kind === 'override') {
      if (value.trim() === '' || secondaryValue.trim() === '') return;
      onAction({
        kind: 'override',
        ...base,
        authorizedUserId: value.trim(),
        reason: secondaryValue.trim(),
        ...(credential.trim() === '' ? {} : { humanCredential: credential.trim() }),
      });
      return;
    }

    if (kind === 'repin') {
      if (value.trim() === '' || secondaryValue.trim() === '') return;
      onAction({
        kind: 'repin',
        ...base,
        sourceStepId: cycle.sourceStepId,
        targetStepId: cycle.targetStepId,
        candidate: {
          kind: candidateKind,
          id: value.trim(),
          revision: secondaryValue.trim(),
          digest: null,
          pinned: true,
        },
        ...(credential.trim() === '' ? {} : { humanCredential: credential.trim() }),
      });
      return;
    }

    onAction({
      kind: 'cancel',
      ...base,
      ...(value.trim() === '' ? {} : { reason: value.trim() }),
      ...(credential.trim() === '' ? {} : { humanCredential: credential.trim() }),
    });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="w-[calc(100vw-1rem)] max-h-[85vh] min-w-0 max-w-xl"
        aria-describedby={`recovery-dialog-description-${cycle.cycleId}`}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          firstInputRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus();
        }}
      >
        <DialogTitle className="text-base font-semibold">{title}</DialogTitle>
        <DialogDescription id={`recovery-dialog-description-${cycle.cycleId}`} className="break-words text-xs text-muted-foreground">
          {description}
        </DialogDescription>

        <form className="awos-scroll min-w-0 space-y-2 overflow-y-auto pr-1 text-xs" aria-label={`${title} fields`} onSubmit={submit}>
          {kind === 'answer' && refusal.required.kind === 'structured-answer' && (
            <>
              <section className="space-y-1 rounded-md border border-state-waiting-border bg-state-waiting-surface px-2 py-1.5" aria-labelledby="recovery-question-heading">
                <h3 id="recovery-question-heading" className="font-medium text-state-waiting">Exact question</h3>
                <p className="break-words text-state-waiting">{refusal.required.answer.description}</p>
                <p className="break-all font-mono text-[10px] text-state-waiting">
                  question {refusal.required.answer.questionId} · authority user
                </p>
                <p className="text-[10px] text-state-waiting">A free-form approval or worker message is not an accepted answer.</p>
              </section>
              <label className="block space-y-1">
                <span className="font-medium">Typed value{schema ? ` · ${schema}` : ''}</span>
                {answerType === 'boolean' ? (
                  <span className="flex items-center gap-2">
                    <input
                      ref={firstInputRef as React.RefObject<HTMLInputElement>}
                      type="checkbox"
                      checked={value === 'true'}
                      onChange={(event) => setValue(String(event.target.checked))}
                      aria-label="Typed boolean answer"
                    />
                    <span>{value === 'true' ? 'true' : 'false'}</span>
                  </span>
                ) : (
                  <input
                    ref={firstInputRef as React.RefObject<HTMLInputElement>}
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    type={answerType === 'number' ? 'number' : 'text'}
                    inputMode={answerType === 'number' ? 'decimal' : undefined}
                    aria-label="Typed answer"
                    className="awos-input w-full py-1.5"
                  />
                )}
              </label>
              <HumanCredentialInput value={credential} onChange={setCredential} />
            </>
          )}

          {kind === 'evidence' && (
            <>
              <EvidencePicker
                selected={selectedEvidence}
                onChange={setSelectedEvidence}
                firstInputRef={firstInputRef}
              />
              <HumanCredentialInput value={credential} onChange={setCredential} />
            </>
          )}

          {kind === 'retry-evaluator' && (
            <>
              <p className="rounded-md border border-state-waiting-border bg-state-waiting-surface px-2 py-1.5 text-[10px] text-state-waiting">
                The core marked this evaluator failure transient and exposed this retry action. It will recheck the displayed attempt and log head.
              </p>
              <HumanCredentialInput
                value={credential}
                onChange={setCredential}
                inputRef={firstInputRef as React.RefObject<HTMLInputElement>}
              />
            </>
          )}

          {kind === 'override' && (
            <>
              <p className="rounded-md border border-state-waiting-border bg-state-waiting-surface px-2 py-1.5 text-[10px] text-state-waiting">
                This form is shown only because the core refusal names a required-intent override action. Absolute intent never receives this action.
              </p>
              <label className="block space-y-1">
                <span className="font-medium">Authorized user id</span>
                <input ref={firstInputRef as React.RefObject<HTMLInputElement>} value={value} onChange={(event) => setValue(event.target.value)} aria-label="Authorized user id" className="awos-input w-full py-1.5" />
              </label>
              <label className="block space-y-1">
                <span className="font-medium">Override reason</span>
                <textarea value={secondaryValue} onChange={(event) => setSecondaryValue(event.target.value)} aria-label="Override reason" className="awos-input min-h-20 w-full py-1.5" />
              </label>
              <HumanCredentialInput value={credential} onChange={setCredential} />
            </>
          )}

          {kind === 'repin' && (
            <>
              <p className="rounded-md border border-state-stale-border bg-state-stale-surface px-2 py-1.5 text-[10px] text-state-stale">
                The core will create a new transition identity that supersedes {cycle.transitionId}. Enter a different pinned candidate/reference identity.
              </p>
              <label className="block space-y-1">
                <span className="font-medium">Candidate kind</span>
                <select value={candidateKind} onChange={(event) => setCandidateKind(event.target.value as CandidateIdentity['kind'])} aria-label="Replacement candidate kind" className="awos-input w-full py-1.5">
                  <option value="revision">revision</option>
                  <option value="artifact">artifact</option>
                  <option value="commit">commit</option>
                  <option value="working-tree">working-tree</option>
                </select>
              </label>
              <label className="block space-y-1">
                <span className="font-medium">Replacement candidate id</span>
                <input ref={firstInputRef as React.RefObject<HTMLInputElement>} value={value} onChange={(event) => setValue(event.target.value)} aria-label="Replacement candidate id" className="awos-input w-full py-1.5" />
              </label>
              <label className="block space-y-1">
                <span className="font-medium">Replacement revision</span>
                <input value={secondaryValue} onChange={(event) => setSecondaryValue(event.target.value)} aria-label="Replacement revision" className="awos-input w-full py-1.5 font-mono" />
              </label>
              <HumanCredentialInput value={credential} onChange={setCredential} />
            </>
          )}

          {kind === 'cancel' && (
            <>
              <p className="rounded-md border border-border bg-muted/30 px-2 py-1.5 text-[10px] text-muted-foreground">
                Cancelling is a durable user action. It does not rewrite the refusal or any historical correction run.
              </p>
              <label className="block space-y-1">
                <span className="font-medium">Reason (optional)</span>
                <textarea ref={firstInputRef as React.RefObject<HTMLTextAreaElement>} value={value} onChange={(event) => setValue(event.target.value)} aria-label="Cancellation reason" className="awos-input min-h-20 w-full py-1.5" />
              </label>
              <HumanCredentialInput value={credential} onChange={setCredential} />
            </>
          )}

          <div className="flex flex-wrap justify-end gap-1.5 border-t border-border pt-2">
            <Button type="button" size="sm" variant="ghost" onClick={onClose} className="h-auto px-2 py-1 text-[10px]">Back</Button>
            <Button type="submit" size="sm" variant={kind === 'cancel' ? 'destructive' : 'default'} className="h-auto px-2 py-1 text-[10px]">
              {dialogSubmitLabel(kind)}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EvidencePicker({
  selected,
  onChange,
  firstInputRef,
}: {
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  firstInputRef: React.MutableRefObject<HTMLInputElement | HTMLTextAreaElement | null>;
}): React.JSX.Element {
  const { runs } = useHarnessContext();
  const evidence = uniqueEvidence(runs);
  return (
    <fieldset className="min-w-0 space-y-1.5">
      <legend className="font-medium">Evidence ids for the core to validate</legend>
      <p className="text-[10px] text-muted-foreground">The core checks candidate identity and requirement membership. Selecting text or an approval does not bypass that check.</p>
      {evidence.length === 0 ? (
        <p className="rounded-md border border-border px-2 py-1.5 text-[10px] text-muted-foreground">No recorded evidence is available in this thread.</p>
      ) : (
        <div className="awos-scroll max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2" aria-label="Recorded evidence">
          {evidence.map((item, index) => {
            const checked = selected.includes(item.id);
            return (
              <label key={item.id} className="flex min-w-0 items-start gap-2 rounded px-1 py-1 hover:bg-accent">
                <input
                  ref={index === 0 ? (firstInputRef as React.RefObject<HTMLInputElement>) : undefined}
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => onChange(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))}
                  aria-label={`Evidence ${item.id}`}
                  className="mt-0.5 shrink-0"
                />
                <span className="min-w-0 break-words text-[10px]">
                  <span className="break-all font-mono">{item.id}</span> · {item.kind} · {item.summary}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}

function HumanCredentialInput({
  value,
  onChange,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  inputRef?: React.RefObject<HTMLInputElement>;
}): React.JSX.Element {
  return (
    <label className="block space-y-1">
      <span className="font-medium">Human authority credential</span>
      <input ref={inputRef} required type="password" value={value} onChange={(event) => onChange(event.target.value)} aria-label="Human authority credential" autoComplete="off" className="awos-input w-full py-1.5 font-mono" />
    </label>
  );
}

function RecoveryDetails({ cycle }: { cycle: RecoveryCycle }): React.JSX.Element {
  return (
    <details className="min-w-0 border-t border-border pt-1.5">
      <summary className="cursor-pointer text-[10px] font-medium text-muted-foreground underline-offset-2 hover:underline">
        Inspect ids, attempts, facts, provenance, and actions
      </summary>
      <div className="awos-scroll mt-1.5 max-h-80 min-w-0 space-y-2 overflow-auto rounded-md border border-border bg-muted/20 p-2 text-[10px]" aria-label="Recovery record details">
        <section aria-labelledby={`recovery-identities-${cycle.cycleId}`}>
          <h5 id={`recovery-identities-${cycle.cycleId}`} className="font-medium">Identities and revisions</h5>
          <dl className="mt-1 grid min-w-0 gap-1 font-mono text-muted-foreground">
            <DetailRow label="cycle" value={cycle.cycleId} />
            <DetailRow label="transition" value={cycle.transitionId} />
            <DetailRow label="expectation set" value={cycle.expectationSetId} />
            <DetailRow label="source / target" value={`${cycle.sourceStepId} / ${cycle.targetStepId}`} />
            <DetailRow label="refusal attempt" value={String(cycle.refusalAttempt)} />
            <DetailRow label="log head" value={String(cycle.head)} />
            <DetailRow label="worker" value={`${cycle.worker.profileId ?? 'none'} · available ${cycle.worker.available === null ? 'unknown' : String(cycle.worker.available)}`} />
            <DetailRow label="on exhausted" value={cycle.onExhausted} />
          </dl>
        </section>

        {cycle.latestEvaluation && (
          <EvaluationDetails evaluation={cycle.latestEvaluation} label="Current evaluation" />
        )}

        {cycle.attempts.length > 0 && (
          <section aria-labelledby={`recovery-attempts-${cycle.cycleId}`}>
            <h5 id={`recovery-attempts-${cycle.cycleId}`} className="font-medium">Attempts ({cycle.attempts.length})</h5>
            <div className="mt-1 space-y-1.5">
              {cycle.attempts.map((attempt) => <EvaluationDetails key={`${attempt.transitionId}-${attempt.attempt}`} evaluation={attempt} label={`Attempt ${attempt.attempt}`} />)}
            </div>
          </section>
        )}

        <section aria-labelledby={`recovery-corrections-${cycle.cycleId}`}>
          <h5 id={`recovery-corrections-${cycle.cycleId}`} className="font-medium">Correction runs ({cycle.correctionRuns.length})</h5>
          {cycle.correctionRuns.length === 0 ? (
            <p className="mt-1 text-muted-foreground">None reserved.</p>
          ) : (
            <ul className="mt-1 space-y-1.5">
              {cycle.correctionRuns.map((run) => (
                <li key={run.runId} className="min-w-0 rounded border border-border px-1.5 py-1">
                  <p className="break-all font-mono">run {run.runId} · {run.workerProfileId} · {run.state}{run.interruptedByRestart ? ' · interrupted by restart' : ''}</p>
                  <p className="break-all text-muted-foreground">fingerprint {run.fingerprint.digest} · candidate {candidateText(run.fingerprint.candidate)} · evidence {run.fingerprint.evidenceIds.join(', ') || 'none'}</p>
                  <p className="break-all text-muted-foreground">context {run.context.schema} · correction {run.correctionIndex}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby={`recovery-actions-${cycle.cycleId}`}>
          <h5 id={`recovery-actions-${cycle.cycleId}`} className="font-medium">Typed actions ({cycle.actions.length})</h5>
          {cycle.actions.length === 0 ? (
            <p className="mt-1 text-muted-foreground">None recorded.</p>
          ) : (
            <ul className="mt-1 space-y-1.5">
              {cycle.actions.map((action) => (
                <li key={action.actionId} className="min-w-0 rounded border border-border px-1.5 py-1">
                  <p className="break-all font-mono">{action.kind} · action {action.actionId} · actor {action.actor} · authority {action.authority}</p>
                  <p className="break-all text-muted-foreground">transition {action.transitionId} · attempt {action.attempt} · expected head {action.expectedHead}</p>
                  <p className="break-all text-muted-foreground">candidate {candidateText(action.candidate)} · evidence {action.evidenceIds.join(', ') || 'none'}</p>
                  {action.questionId && <p className="break-all text-muted-foreground">question {action.questionId} · answer {action.answerId ?? 'none'}{action.answer ? ` · ${action.answer.type}` : ''}</p>}
                  {action.authorizedUserId && <p className="break-words text-muted-foreground">authorized user {action.authorizedUserId} · reason {action.reason ?? 'none'}</p>}
                  {action.supersededByTransitionId && <p className="break-all text-state-stale">superseded by {action.supersededByTransitionId}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </details>
  );
}

function EvaluationDetails({ evaluation, label }: { evaluation: TransitionEvaluation; label: string }): React.JSX.Element {
  return (
    <section className="min-w-0 rounded border border-border px-1.5 py-1" aria-label={label}>
      <h5 className="font-medium">{label}</h5>
      <p className="mt-1 break-all font-mono text-muted-foreground">
        {evaluation.verdict} · actor {evaluation.actor} · transition {evaluation.transitionId} · attempt {evaluation.attempt} · run {evaluation.runId ?? 'none'}
      </p>
      <p className="break-all text-muted-foreground">candidate {candidateText(evaluation.candidate)} · evidence {evaluation.evidenceIds.join(', ') || 'none'} · expectation {evaluation.expectationSetId}</p>
      <p className="break-all text-muted-foreground">supersedes {evaluation.supersedesTransitionId ?? 'none'} · override {overrideText(evaluation)}</p>
      {evaluation.provenance.length > 0 && (
        <p className="break-all text-muted-foreground">provenance {evaluation.provenance.map((entry) => `${entry.evaluatorId}@${entry.evaluatorVersion} · ${entry.evaluatorClass} · ${entry.validity} · candidate ${candidateText(entry.candidate)} · evidence ${entry.evidenceIds.join(', ') || 'none'}`).join(' | ')}</p>
      )}
      {evaluation.refusal && (
        <div className="mt-1 space-y-1">
          <p className="break-words">refusal: {evaluation.refusal.reason} · actor {evaluation.refusal.responsibleActor} · action {evaluation.refusal.nextAction}</p>
          <p className="break-all text-muted-foreground">unmet {evaluation.refusal.unmetRequirementIds.join(', ') || 'none'} · retryable {String(evaluation.refusal.retryable)}</p>
        </div>
      )}
      <ul className="mt-1 space-y-1">
        {evaluation.facts.map((fact) => (
          <li key={fact.requirementId} className="min-w-0 border-l border-border pl-1.5">
            <p className="break-words">fact {fact.requirementId} · {fact.state}{fact.observation ? ` · observation ${fact.observation}` : ''} · {fact.detail ?? 'no detail'}</p>
            <p className="break-all text-muted-foreground">evidence {fact.evidenceIds.join(', ') || 'none'} · evaluator {fact.provenance.evaluatorId}@{fact.provenance.evaluatorVersion} · {fact.provenance.evaluatorClass} · validity {fact.provenance.validity}</p>
            <p className="break-all text-muted-foreground">provenance candidate {candidateText(fact.provenance.candidate)} · evidence {fact.provenance.evidenceIds.join(', ') || 'none'}{fact.provenance.detail ? ` · ${fact.provenance.detail}` : ''}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DetailRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="grid min-w-0 grid-cols-[7.5rem_minmax(0,1fr)] gap-2">
      <dt>{label}</dt>
      <dd className="min-w-0 break-all">{value}</dd>
    </div>
  );
}

function recoveryWorker(
  cycle: RecoveryCycle,
  refusal: NonNullable<TransitionEvaluation['refusal']> | null,
  resuming: boolean,
): AgentId | null {
  if (resuming) return cycle.correctionRuns.at(-1)?.workerProfileId ?? null;
  if (cycle.worker.profileId !== null) return cycle.worker.profileId;
  return refusal?.responsibleActor === 'claude' || refusal?.responsibleActor === 'codex' || refusal?.responsibleActor === 'qwen-local'
    ? refusal.responsibleActor
    : null;
}

function workerStatus(cycle: RecoveryCycle): string | null {
  const { profileId, available, detail } = cycle.worker;
  if (profileId === null && available === null && detail === null) return null;
  return [
    profileId === null ? null : `profile ${profileId}`,
    available === null ? null : available ? 'available' : 'unavailable',
    detail,
  ].filter((part): part is string => part !== null).join(' · ');
}

function visualEvidenceFor(runs: readonly RunView[], ids: readonly string[]): EvidenceRecord[] {
  const wanted = new Set(ids);
  const found = new Map<string, EvidenceRecord>();
  for (const run of runs) {
    for (const item of run.evidence) {
      if (wanted.has(item.id) && item.visual !== undefined) found.set(item.id, item);
    }
  }
  return ids.flatMap((id) => {
    const item = found.get(id);
    return item === undefined ? [] : [item];
  });
}

function uniqueEvidence(runs: readonly RunView[]): EvidenceRecord[] {
  const evidence = new Map<string, EvidenceRecord>();
  for (const run of runs) for (const item of run.evidence) evidence.set(item.id, item);
  return [...evidence.values()];
}

function answerTypeForSchema(schema: string | null): TypedAnswer['type'] {
  if (schema === 'number') return 'number';
  if (schema === 'boolean') return 'boolean';
  if (schema === 'choice' || schema?.startsWith('choice:')) return 'choice';
  return 'string';
}

function typedAnswer(type: TypedAnswer['type'], value: string): TypedAnswer | null {
  if (type === 'boolean') return { type, value: value === 'true' };
  if (type === 'number') {
    const parsed = Number(value);
    return value.trim() === '' || !Number.isFinite(parsed) ? null : { type, value: parsed };
  }
  return value.trim() === '' ? null : { type, value: value.trim() };
}

function candidateText(candidate: CandidateIdentity): string {
  return `${candidate.kind}:${candidate.id} revision=${candidate.revision ?? 'none'} digest=${candidate.digest ?? 'none'} pinned=${String(candidate.pinned)}`;
}

function overrideText(evaluation: TransitionEvaluation): string {
  if (evaluation.override === null) return 'none';
  return `${evaluation.override.actor} ${evaluation.override.authorizedUserId} · ${evaluation.override.reason}`;
}

function escalationActionLabel(action: 'waiting-for-human' | 'blocked'): string {
  return action === 'waiting-for-human' ? 'Wait for the human action named by the core' : 'Blocked; no human bypass is available';
}

function dialogTitle(kind: DialogKind): string {
  switch (kind) {
    case 'answer': return 'Provide the required typed answer';
    case 'evidence': return 'Submit evidence to the core';
    case 'override': return 'Request a core-authorized override';
    case 'repin': return 'Replace the pinned reference';
    case 'cancel': return 'Cancel recovery';
    case 'retry-evaluator': return 'Retry the evaluator';
  }
}

function dialogDescription(kind: DialogKind, refusal: NonNullable<TransitionEvaluation['refusal']>): string {
  if (kind === 'answer' && refusal.required.kind === 'structured-answer') return `The core requires question ${refusal.required.answer.questionId} from authority user.`;
  if (kind === 'evidence') return 'Submit only evidence ids already recorded in this thread; the core rechecks their candidate identity.';
  if (kind === 'override') return 'The core will accept this only if the current refusal names a legal required-intent override.';
  if (kind === 'repin') return 'The core creates a new transition identity and keeps this refusal as historical context.';
  if (kind === 'retry-evaluator') return 'The core marked the evaluator failure transient and will validate this typed retry against the current recovery record.';
  return 'This action is recorded by the core and does not rewrite prior evaluations.';
}

function dialogSubmitLabel(kind: DialogKind): string {
  switch (kind) {
    case 'answer': return 'Submit typed answer';
    case 'evidence': return 'Submit evidence';
    case 'override': return 'Submit override request';
    case 'repin': return 'Replace and re-evaluate';
    case 'cancel': return 'Cancel recovery';
    case 'retry-evaluator': return 'Retry evaluator';
  }
}
