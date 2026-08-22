import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  ExternalLink,
  GitMerge,
  Play,
  Plus,
  RefreshCw,
  Unlink,
} from 'lucide-react';
import type {
  AgentId,
  EvidenceItem,
  RequirementResult,
  RetainedItem,
  RetainedKind,
  RunClaim,
  WorkItem,
  WorkSourceError,
} from '@awos/protocol';
import { useHarnessContext } from '@/state/HarnessContext';
import { AGENT_STYLE } from '@/components/AgentBadge';
import { Button } from '@/components/ui/button';
import type { RunView } from '@/lib/runs';
import { cn, formatRelative } from '@/lib/utils';

/**
 * The issue this thread is answering, and what has been run against it.
 *
 * The panel exists to make three things checkable that the transcript cannot answer on
 * its own: what authorized the work, exactly what the agent was handed, and whether the
 * source has moved since. Everything here is read from the harness — the item from the
 * core, the runs from the event log the transcript already has — so nothing on screen is
 * a second copy that can disagree with the record.
 */
export function WorkPanel(): React.JSX.Element {
  const { activeThreadId, work, attachWorkItem, refreshWorkItem, detachWorkItem } =
    useHarnessContext();

  if (activeThreadId === null) {
    return (
      <p className="px-4 py-3 text-xs text-muted-foreground">
        Open a thread to give it a work item.
      </p>
    );
  }

  if (work === null || work.threadId !== activeThreadId) {
    return <p className="px-4 py-3 text-xs text-muted-foreground">Loading the work item…</p>;
  }

  return (
    <div className="awos-scroll h-full space-y-3 overflow-y-auto px-4 py-3 text-xs">
      {work.item === null ? (
        <AttachForm busy={work.busy} error={work.error} onAttach={attachWorkItem} />
      ) : (
        <>
          <Issue
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
        className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      {error && <Problem error={error} />}
      <Button type="submit" size="sm" variant="outline" disabled={busy} className="h-auto px-2 py-1 text-xs">
        {busy ? 'Reading GitHub…' : 'Attach'}
      </Button>
    </form>
  );
}

function Issue({
  item,
  busy,
  onRefresh,
  onDetach,
}: {
  item: WorkItem;
  busy: boolean;
  onRefresh: () => void;
  onDetach: () => void;
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 font-mono text-[11px] text-muted-foreground">
          {item.source.repo}#{item.source.number} · {item.snapshot.state}
        </span>
        <a
          href={item.source.url}
          target="_blank"
          rel="noreferrer"
          title="Open on GitHub"
          className="shrink-0 rounded-md border border-input px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          title="Ask GitHub again"
          className="shrink-0 rounded-md border border-input px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent disabled:opacity-40"
        >
          <RefreshCw className={cn('h-3 w-3', busy && 'animate-spin')} />
        </button>
        <button
          type="button"
          onClick={onDetach}
          title="Unlink this issue from the thread"
          className="shrink-0 rounded-md border border-input px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent"
        >
          <Unlink className="h-3 w-3" />
        </button>
      </div>

      <p className="font-medium">{item.snapshot.title}</p>

      {item.snapshot.labels.length > 0 && (
        <p className="text-[10px] text-muted-foreground">{item.snapshot.labels.join(' · ')}</p>
      )}

      <p className="text-[10px] text-muted-foreground">
        Read {formatRelative(item.fetchedAt)}
        {item.lastRefreshedAt > item.fetchedAt && `, checked ${formatRelative(item.lastRefreshedAt)}`}
      </p>
    </div>
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
  // The comparison the whole revision-freezing exists for: what this run read against what
  // the issue says now.
  const sourceMoved = run.revision !== '' && run.revision !== currentRevision;

  return (
    <li className="space-y-1">
      <div className="flex items-center gap-1.5">
        {run.agent && (
          <span className={cn('rounded px-1 py-px text-[9px]', AGENT_STYLE[run.agent].bg, AGENT_STYLE[run.agent].text)}>
            {AGENT_STYLE[run.agent].label}
          </span>
        )}
        <span className={cn('text-[10px]', STATE_STYLE[run.state])}>{STATE_LABEL[run.state]}</span>
        <span className="text-[10px] text-muted-foreground">{formatRelative(run.ts)}</span>
      </div>

      <p className="break-words">{run.instruction}</p>

      {run.detail && <p className="text-[10px] text-muted-foreground">{run.detail}</p>}

      {sourceMoved && (
        <p className="flex items-start gap-1 text-[10px] text-amber-500">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          The issue has changed since this run. Its context is kept as it was.
        </p>
      )}

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
  delivered: 'text-emerald-500',
  partial: 'text-amber-500',
  blocked: 'text-destructive',
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
        className="w-full rounded-md border border-input bg-transparent px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
        className="w-full rounded-md border border-input bg-transparent px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
  const { recordEvidence } = useHarnessContext();
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [summary, setSummary] = useState('');

  const attached = new Set(run.evidence.map((item) => item.ref.eventId));
  const unattached = run.candidates.filter((candidate) => !attached.has(candidate.eventId));

  return (
    <div className="space-y-1">
      {run.evidence.length > 0 && (
        <ul className="space-y-1">
          {run.evidence.map((item) => (
            <EvidenceRow key={item.id} item={item} />
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
              className="w-full rounded-md border border-input bg-transparent px-2 py-1 font-mono text-[10px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="What does it show?"
              aria-label="Evidence summary"
              className="w-full rounded-md border border-input bg-transparent px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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

function EvidenceRow({ item }: { item: EvidenceItem }): React.JSX.Element {
  return (
    <li className="rounded-md bg-muted/40 px-2 py-1">
      <p className="flex items-baseline gap-1">
        <span className="text-[9px] uppercase tracking-wide text-muted-foreground">{item.kind}</span>
        <span className="min-w-0 break-words">{item.summary}</span>
      </p>
      {item.ref.url === null ? (
        <p className="truncate font-mono text-[10px] text-muted-foreground">{item.ref.label}</p>
      ) : (
        <a
          href={item.ref.url}
          target="_blank"
          rel="noreferrer"
          className="block truncate font-mono text-[10px] text-muted-foreground underline-offset-2 hover:underline"
        >
          {item.ref.label}
        </a>
      )}
      <p className="text-[10px] text-muted-foreground">
        {item.source}
        {item.state.commit !== null && ` · ${item.state.commit.slice(0, 7)}`}
        {item.state.dirty && ', with uncommitted changes'}
      </p>
    </li>
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
          <li key={item.id} className="flex items-start gap-1.5">
            <input
              type="checkbox"
              checked={item.selected}
              onChange={(e) => void amendRetained(item.id, { selected: e.target.checked })}
              aria-label={`Carry forward: ${item.text}`}
              className="mt-0.5 shrink-0"
            />
            <span className="min-w-0 flex-1">
              <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                {RETAINED_KINDS.find((entry) => entry.value === item.kind)?.label}
              </span>{' '}
              <span className="break-words">{item.text}</span>
              <span className="text-[10px] text-muted-foreground"> · {item.source}</span>
            </span>
            <button
              type="button"
              onClick={() => void amendRetained(item.id, { retired: true, selected: false })}
              title="No longer true — keep it, stop carrying it"
              className="shrink-0 text-[10px] text-muted-foreground underline-offset-2 hover:underline"
            >
              Retire
            </button>
          </li>
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
            className="w-full rounded-md border border-input bg-transparent px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
            className="w-full rounded-md border border-input bg-transparent px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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

const REQUIREMENT_ICON: Record<RequirementResult['state'], React.JSX.Element> = {
  satisfied: <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />,
  missing: <CircleSlash className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />,
  failed: <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />,
  stale: <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />,
};

const REQUIREMENT_TEXT: Record<RequirementResult['state'], string> = {
  satisfied: 'passed against this content',
  missing: 'has not been run',
  failed: 'failed',
  stale: 'passed against different content',
};

function Gate({ agent }: { agent: AgentId }): React.JSX.Element | null {
  const { gates, readGate, runCheck, integrateLane, runs } = useHarnessContext();
  const gate = gates[agent];
  const [overriding, setOverriding] = useState(false);
  const [reason, setReason] = useState('');

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
        {gate.allowed && <CheckCircle2 className="h-3 w-3 text-emerald-500" />}
      </p>

      <ul className="space-y-1">
        {gate.requirements.map((requirement) => (
          <li key={requirement.name} className="flex items-start gap-1.5">
            {REQUIREMENT_ICON[requirement.state]}
            <span className="min-w-0 flex-1">
              <span className="font-medium">{requirement.name}</span>{' '}
              <span className="text-muted-foreground">{REQUIREMENT_TEXT[requirement.state]}</span>
              <br />
              <span className="font-mono text-[10px] text-muted-foreground">{requirement.command}</span>
            </span>
            <button
              type="button"
              onClick={() => void runCheck(agent, requirement.name)}
              title={`Run ${requirement.name} in ${agent}'s lane`}
              className="shrink-0 rounded-md border border-input px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent"
            >
              Run
            </button>
          </li>
        ))}
      </ul>

      <p className="font-mono text-[10px] text-muted-foreground">
        candidate {gate.candidate.tree?.slice(0, 7) ?? 'unknown'}
        {gate.candidate.dirty && ' · uncommitted'}
      </p>

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
            className="w-full rounded-md border border-input bg-transparent px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <Button type="submit" size="sm" variant="outline" className="h-auto px-2 py-1 text-xs">
            Integrate anyway
          </Button>
        </form>
      ) : (
        // Offered whatever the workspace says, and refused by the core when it says no.
        // A button that quietly disappears teaches nobody that the rule exists.
        <button
          type="button"
          onClick={() => setOverriding(true)}
          className="text-[10px] text-muted-foreground underline-offset-2 hover:underline"
        >
          Integrate anyway
        </button>
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
        className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <Button type="submit" size="sm" variant="outline" disabled={busy} className="h-auto px-2 py-1 text-xs">
        <Play className="mr-1 h-3 w-3" />
        {busy ? `${agent} is working` : `Start work with ${agent}`}
      </Button>
    </form>
  );
}

function Problem({ error }: { error: WorkSourceError }): React.JSX.Element {
  return (
    <p
      role="status"
      className={cn(
        'flex items-start gap-1.5',
        error.retryable ? 'text-amber-500' : 'text-destructive',
      )}
    >
      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
      <span>{error.message}</span>
    </p>
  );
}

// ---------------------------------------------------------------------------

const STATE_LABEL: Record<RunView['state'], string> = {
  running: 'Running',
  completed: 'Finished',
  interrupted: 'Interrupted',
  error: 'Failed',
};

const STATE_STYLE: Record<RunView['state'], string> = {
  running: 'text-amber-500',
  completed: 'text-emerald-500',
  interrupted: 'text-muted-foreground',
  error: 'text-destructive',
};
