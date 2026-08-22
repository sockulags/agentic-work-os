import { useState } from 'react';
import { AlertTriangle, ExternalLink, Play, RefreshCw, Unlink } from 'lucide-react';
import type { AgentId, WorkItem, WorkSourceError } from '@awos/protocol';
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
