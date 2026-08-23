import { useEffect, useState } from 'react';
import {
  GitMerge,
  Play,
  Plus,
} from 'lucide-react';
import type {
  AgentId,
  RetainedItem,
  RetainedKind,
  RunClaim,
  WorkItem,
  WorkSourceError,
} from '@awos/protocol';
import { useHarnessContext } from '@/state/HarnessContext';
import { Button } from '@/components/ui/button';
import {
  CandidateSummary,
  EvidenceItem as EvidenceItemView,
  GateResult,
  RetainedContextItem,
  RunSummary,
  ReviewState,
  WorkItemHeader,
} from '@/components/review/ReviewPatterns';
import type { RunView } from '@/lib/runs';
import { cn } from '@/lib/utils';

/**
 * The issue this thread is answering, and what has been run against it.
 *
 * The panel exists to make three things checkable that the transcript cannot answer on
 * its own: what authorized the work, exactly what the agent was handed, and whether the
 * source has moved since. Everything here is read from the harness — the item from the
 * core, the run details from the event log, and live/restart status from the core
 * projection — so nothing on screen is a second copy that can disagree with the record.
 */
export function WorkPanel(): React.JSX.Element {
  const { activeThreadId, work, attachWorkItem, refreshWorkItem, detachWorkItem } =
    useHarnessContext();

  if (activeThreadId === null) {
    return (
      <div className="space-y-1 px-4 py-3 text-xs">
        <ReviewState state="idle" label="No thread selected" />
        <p className="text-muted-foreground">Open a thread to give it a work item.</p>
      </div>
    );
  }

  if (work === null || work.threadId !== activeThreadId) {
    return (
      <div className="space-y-1 px-4 py-3 text-xs">
        <ReviewState state="busy" />
        <p className="text-muted-foreground">Loading the work item…</p>
      </div>
    );
  }

  return (
    <div className="awos-scroll h-full space-y-3 overflow-y-auto px-4 py-3 text-xs">
      {work.item === null ? (
        <AttachForm busy={work.busy} error={work.error} onAttach={attachWorkItem} />
      ) : (
        <>
          <WorkItemHeader
            item={work.item}
            busy={work.busy}
            onRefresh={() => void refreshWorkItem()}
            onDetach={() => void detachWorkItem()}
          />
          {work.error && <Problem error={work.error} />}
          <Retained items={work.retained} />
          <Gates />
          <Runs item={work.item} />
          <StartWork />
        </>
      )}
    </div>
  );
}
function AttachForm({
  busy,
  error,
  onAttach,
}: {
  busy: boolean;
  error: WorkSourceError | null;
  onAttach: (reference: string) => Promise<void>;
}): React.JSX.Element {
  const [reference, setReference] = useState('');

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (reference.trim() === '') return;
        void onAttach(reference.trim());
      }}
    >
      <p className="text-muted-foreground">
        Point this thread at a GitHub issue. It stays GitHub&rsquo;s issue — what is kept here is
        the reference and what each run was given.
      </p>
      <input
        value={reference}
        onChange={(e) => setReference(e.target.value)}
        placeholder="#14, owner/name#14, or the issue URL"
        aria-label="Issue reference"
        className="awos-input w-full py-1.5 font-mono text-xs"
      />
      {error && <Problem error={error} />}
      <Button type="submit" size="sm" variant="outline" disabled={busy} className="h-auto px-2 py-1 text-xs">
        {busy ? 'Reading GitHub…' : 'Attach'}
      </Button>
    </form>
  );
}

/**
 * The runs this thread has made, newest first.
 *
 * Folded out of the event log rather than fetched: the log is the record of what happened,
 * and a run is one of the things that happened in it.
 */
function Runs({ item }: { item: WorkItem }): React.JSX.Element {
  const runs = useHarnessContext().runs;

  if (runs.length === 0) {
    return (
      <p className="border-t border-border pt-2 text-muted-foreground">
        No runs yet. Starting work records the agent, what it was given, and how it ended.
      </p>
    );
  }

  return (
    <ul className="space-y-2 border-t border-border pt-2">
      {runs.map((run) => (
        <Run key={run.runId} run={run} currentRevision={item.snapshot.revision} />
      ))}
    </ul>
  );
}

function Run({ run, currentRevision }: { run: RunView; currentRevision: string }): React.JSX.Element {
  const [showContext, setShowContext] = useState(false);

  return (
    <li className="space-y-1">
      <RunSummary run={run} currentRevision={currentRevision} />

      <Outcome run={run} />
      <Evidence run={run} />

      <button
        type="button"
        onClick={() => setShowContext((open) => !open)}
        className="text-[10px] text-muted-foreground underline-offset-2 hover:underline"
      >
        {showContext ? 'Hide the context sent' : 'Inspect the context sent'}
      </button>

      {showContext && (
        <pre className="awos-scroll max-h-64 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap">
          {run.context}
        </pre>
      )}
    </li>
  );
}

const CLAIMS: Array<{ value: RunClaim; label: string }> = [
  { value: 'delivered', label: 'Delivered' },
  { value: 'partial', label: 'Partly done' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'abandoned', label: 'Abandoned' },
];

const CLAIM_STYLE: Record<RunClaim, string> = {
  delivered: 'text-state-passed',
  partial: 'text-state-stale',
  blocked: 'text-state-blocked',
  abandoned: 'text-muted-foreground',
};

/**
 * What the run achieved, as opposed to how its turn ended.
 *
 * Shown next to the terminal state rather than instead of it: "the process exited cleanly"
 * and "the work is done" are different facts, and collapsing them is exactly the mistake
 * this record exists to prevent. Restating is offered even once a claim is made, because
 * finding out later that it was wrong is the normal case, not an edge one.
 */
function Outcome({ run }: { run: RunView }): React.JSX.Element {
  const { closeRun } = useHarnessContext();
  const [open, setOpen] = useState(false);
  const [claim, setClaim] = useState<RunClaim>('delivered');
  const [statement, setStatement] = useState('');

  if (run.outcome !== null && !open) {
    return (
      <div className="rounded-md border border-border px-2 py-1.5">
        <p>
          <span className={cn('font-medium', CLAIM_STYLE[run.outcome.claim])}>
            {CLAIMS.find((entry) => entry.value === run.outcome?.claim)?.label}
          </span>
          <span className="text-[10px] text-muted-foreground"> · claimed by {run.outcome.source}</span>
        </p>
        <p className="break-words">{run.outcome.statement}</p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-[10px] text-muted-foreground underline-offset-2 hover:underline"
        >
          Restate
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[10px] text-muted-foreground underline-offset-2 hover:underline"
      >
        Close this run with an outcome
      </button>
    );
  }

  return (
    <form
      className="space-y-1.5 rounded-md border border-border px-2 py-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (statement.trim() === '') return;
        void closeRun(run.runId, claim, statement.trim());
        setStatement('');
        setOpen(false);
      }}
    >
      <select
        value={claim}
        onChange={(e) => setClaim(e.target.value as RunClaim)}
        aria-label="Outcome"
        className="awos-input w-full py-1 text-xs"
      >
        {CLAIMS.map((entry) => (
          <option key={entry.value} value={entry.value} className="bg-card">
            {entry.label}
          </option>
        ))}
      </select>
      <input
        value={statement}
        onChange={(e) => setStatement(e.target.value)}
        placeholder="What actually came of this run?"
        aria-label="Outcome statement"
        className="awos-input w-full py-1 text-xs"
      />
      <Button type="submit" size="sm" variant="outline" className="h-auto px-2 py-1 text-xs">
        Record the outcome
      </Button>
    </form>
  );
}

/**
 * What supports the claim.
 *
 * Shown as the items themselves — what ran, how it ended, which tree it was against —
 * rather than reduced to a badge. A green tick is a summary of somebody else's reasoning;
 * the point here is to be able to check it.
 */
function Evidence({ run }: { run: RunView }): React.JSX.Element {
  const { recordEvidence, gates } = useHarnessContext();
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [summary, setSummary] = useState('');
  const candidateTree = run.agent === null ? undefined : gates[run.agent]?.candidate.tree;

  const attached = new Set(run.evidence.map((item) => item.ref.eventId));
  const unattached = run.candidates.filter((candidate) => !attached.has(candidate.eventId));

  return (
    <div className="space-y-1">
      {run.evidence.length > 0 && (
          <ul className="space-y-1">
          {run.evidence.map((item) => (
            <EvidenceItemView key={item.id} item={item} candidateTree={candidateTree} />
          ))}
        </ul>
      )}

      {!adding && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="text-[10px] text-muted-foreground underline-offset-2 hover:underline"
        >
          Add evidence
        </button>
      )}

      {adding && (
        <div className="space-y-1.5 rounded-md border border-border px-2 py-1.5">
          {unattached.length > 0 && (
            <ul className="space-y-0.5">
              {unattached.map((candidate) => (
                <li key={candidate.eventId}>
                  <button
                    type="button"
                    onClick={() =>
                      void recordEvidence(
                        run.runId,
                        candidate.kind,
                        { eventId: candidate.eventId, url: null, label: candidate.label },
                        candidate.detail,
                      )
                    }
                    className="flex w-full items-center gap-1 text-left text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    <Plus className="h-3 w-3 shrink-0" />
                    <span className="min-w-0 truncate">{candidate.label}</span>
                    <span className="shrink-0">· {candidate.detail}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form
            className="space-y-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (summary.trim() === '') return;
              const link = url.trim();
              void recordEvidence(
                run.runId,
                link === '' ? 'note' : 'link',
                { eventId: null, url: link === '' ? null : link, label: link === '' ? 'by hand' : link },
                summary.trim(),
              );
              setUrl('');
              setSummary('');
              setAdding(false);
            }}
          >
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://… (optional)"
              aria-label="Evidence link"
              className="awos-input w-full py-1 font-mono text-[10px]"
            />
            <input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="What does it show?"
              aria-label="Evidence summary"
              className="awos-input w-full py-1 text-xs"
            />
            <Button type="submit" size="sm" variant="outline" className="h-auto px-2 py-1 text-xs">
              Attach
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}

const RETAINED_KINDS: Array<{ value: RetainedKind; label: string }> = [
  { value: 'discovery', label: 'Found out' },
  { value: 'decision', label: 'Decided' },
  { value: 'constraint', label: 'Constraint' },
  { value: 'question', label: 'Open question' },
];

/**
 * What earlier work established, and what the next run will be told.
 *
 * Kept against the work item rather than written back to the issue: GitHub owns what was
 * asked for, and what was learned along the way is not an edit to it. Unticking an item
 * leaves it here and stops carrying it forward — the ledger is append-only, so nothing a
 * click does can remove what somebody wrote.
 */
function Retained({ items }: { items: RetainedItem[] }): React.JSX.Element {
  const { retainContext, amendRetained } = useHarnessContext();
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<RetainedKind>('decision');
  const [text, setText] = useState('');

  const standing = items.filter((item) => !item.retired);
  const retired = items.filter((item) => item.retired);

  return (
    <div className="space-y-1.5 border-t border-border pt-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        Kept about this issue
      </p>

      {standing.length === 0 && (
        <p className="text-muted-foreground">
          Nothing kept yet. What is written down here is given to later runs on this issue.
        </p>
      )}

      <ul className="space-y-1">
        {standing.map((item) => (
            <RetainedContextItem
              key={item.id}
              item={item}
              kindLabel={RETAINED_KINDS.find((entry) => entry.value === item.kind)?.label ?? item.kind}
              onSelect={(selected) => void amendRetained(item.id, { selected })}
              onRetire={() => void amendRetained(item.id, { retired: true, selected: false })}
            />
        ))}
      </ul>

      {retired.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[10px] text-muted-foreground">
            {retired.length} retired
          </summary>
          <ul className="mt-1 space-y-1">
            {retired.map((item) => (
              <li key={item.id} className="text-muted-foreground line-through">
                {item.text}
              </li>
            ))}
          </ul>
        </details>
      )}

      {!adding ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="text-[10px] text-muted-foreground underline-offset-2 hover:underline"
        >
          Keep something
        </button>
      ) : (
        <form
          className="space-y-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim() === '') return;
            void retainContext(kind, text.trim(), null);
            setText('');
            setAdding(false);
          }}
        >
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as RetainedKind)}
            aria-label="What kind"
            className="awos-input w-full py-1 text-xs"
          >
            {RETAINED_KINDS.map((entry) => (
              <option key={entry.value} value={entry.value} className="bg-card">
                {entry.label}
              </option>
            ))}
          </select>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What should later work on this issue know?"
            aria-label="What to keep"
            className="awos-input w-full py-1 text-xs"
          />
          <Button type="submit" size="sm" variant="outline" className="h-auto px-2 py-1 text-xs">
            Keep it
          </Button>
        </form>
      )}
    </div>
  );
}

/**
 * What has to hold before each lane's work may be applied.
 *
 * Only shown where there is a lane to integrate: without lanes there is nothing to hand
 * over and nothing to gate. The requirements come from the core's own evaluation rather
 * than from anything worked out here, so the panel cannot show one verdict while the
 * integration acts on another.
 */
function Gates(): React.JSX.Element | null {
  const { runtime } = useHarnessContext();
  const lanes = Object.keys(runtime?.lanes ?? {}) as AgentId[];
  if (lanes.length === 0) return null;

  return (
    <div className="space-y-2 border-t border-border pt-2">
      {lanes.map((agent) => (
        <Gate key={agent} agent={agent} />
      ))}
    </div>
  );
}

function Gate({ agent }: { agent: AgentId }): React.JSX.Element | null {
  const { gates, readGate, runCheck, integrateLane, runs, workspace } = useHarnessContext();
  const gate = gates[agent];
  const [overriding, setOverriding] = useState(false);
  const [reason, setReason] = useState('');
  const overrideAllowed =
    workspace !== null &&
    workspace.resolution.status === 'ok' &&
    workspace.resolution.workspace.integration.allowOverride;

  // Read on open, and again whenever the log grows a run or a result — the two ways the
  // verdict changes without the user having pressed anything here.
  const evidenceCount = runs.reduce((total, run) => total + run.evidence.length, 0);
  useEffect(() => {
    void readGate(agent);
  }, [readGate, agent, evidenceCount, runs.length]);

  if (gate === undefined) return null;
  if (gate.requirements.length === 0) {
    return (
      <p className="text-[10px] text-muted-foreground">
        {agent}&rsquo;s lane: nothing required before integrating.
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        Before integrating {agent}
        {gate.allowed && <span className="text-state-passed">satisfied</span>}
      </p>

      <ul className="space-y-1">
        {gate.requirements.map((requirement) => (
          <GateResult
            key={requirement.name}
            requirement={requirement}
            candidateTree={gate.candidate.tree}
            onRun={() => void runCheck(agent, requirement.name)}
          />
        ))}
      </ul>

      <CandidateSummary candidate={gate.candidate} />

      {gate.allowed ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => void integrateLane(agent)}
          className="h-auto px-2 py-1 text-xs"
        >
          <GitMerge className="mr-1 h-3 w-3" />
          Integrate {agent}
        </Button>
      ) : overriding ? (
        <form
          className="space-y-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim() === '') return;
            void integrateLane(agent, { reason: reason.trim() });
            setReason('');
            setOverriding(false);
          }}
        >
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why integrate without this?"
            aria-label="Override reason"
            className="awos-input w-full py-1 text-xs"
          />
          <Button type="submit" size="sm" variant="outline" className="h-auto px-2 py-1 text-xs">
            Integrate anyway
          </Button>
        </form>
      ) : (
        // Offered whatever the workspace says, and refused by the core when it says no.
        // A button that quietly disappears teaches nobody that the rule exists.
        <div className="space-y-1.5">
          <p className="text-[10px] text-state-blocked">Integration is disabled until every required check passes against this candidate.</p>
          {overrideAllowed ? (
            <button
              type="button"
              onClick={() => setOverriding(true)}
              className="awos-focus-ring text-[10px] text-muted-foreground underline-offset-2 hover:underline"
            >
              Integrate anyway
            </button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled
              title="This workspace does not permit an integration override."
              className="h-auto px-2 py-1 text-[10px]"
            >
              Integrate anyway
            </Button>
          )}
          {!overrideAllowed && <p className="text-[10px] text-muted-foreground">This workspace does not permit an override.</p>}
        </div>
      )}
    </div>
  );
}

/** The composer for a run, kept beside the item it runs against. */
function StartWork(): React.JSX.Element {
  const { startRun, activeThread, runtime } = useHarnessContext();
  const [text, setText] = useState('');
  const agent: AgentId = activeThread?.activeAgent ?? 'claude';
  const busy = runtime?.busy.includes(agent) ?? false;

  return (
    <form
      className="space-y-2 border-t border-border pt-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim() === '' || busy) return;
        void startRun(text.trim(), agent);
        setText('');
      }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What should the agent do about this issue?"
        aria-label="Run instruction"
        className="awos-input w-full py-1.5 text-xs"
      />
      <Button type="submit" size="sm" variant="outline" disabled={busy} className="h-auto px-2 py-1 text-xs">
        <Play className="mr-1 h-3 w-3" />
        {busy ? `${agent} is working` : `Start work with ${agent}`}
      </Button>
    </form>
  );
}

function Problem({ error }: { error: WorkSourceError }): React.JSX.Element {
  const state = error.retryable ? 'waiting' : 'failed';
  return (
    <div className={cn('space-y-0.5 border-l-2 px-2 py-1', state === 'waiting' ? 'border-state-waiting-border bg-state-waiting-surface' : 'border-state-failed-border bg-state-failed-surface')}>
      <ReviewState state={state} label={error.retryable ? 'Waiting to retry' : 'Source error'} />
      <p className="break-words text-[10px] text-muted-foreground">{error.message}</p>
    </div>
  );
}
