import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CircleSlash,
  ExternalLink,
  RefreshCw,
  Unlink,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type {
  EvidenceItem as EvidenceRecord,
  RequirementResult,
  RetainedItem,
  WorkItem,
} from '@awos/protocol';
import { getAgentStyle } from '@/components/AgentBadge';
import { Button } from '@/components/ui/button';
import type { RunView } from '@/lib/runs';
import { cn, formatRelative } from '@/lib/utils';

export type ReviewStateName =
  | 'idle'
  | 'busy'
  | 'waiting'
  | 'blocked'
  | 'passed'
  | 'failed'
  | 'interrupted'
  | 'stale';

const STATE_META: Record<
  ReviewStateName,
  { label: string; Icon: LucideIcon; text: string; surface: string; border: string }
> = {
  idle: { label: 'Idle', Icon: CircleSlash, text: 'text-state-idle', surface: 'bg-state-idle-surface', border: 'border-state-idle-border' },
  busy: { label: 'Running', Icon: RefreshCw, text: 'text-state-busy', surface: 'bg-state-busy-surface', border: 'border-state-busy-border' },
  waiting: { label: 'Waiting', Icon: AlertTriangle, text: 'text-state-waiting', surface: 'bg-state-waiting-surface', border: 'border-state-waiting-border' },
  blocked: { label: 'Blocked', Icon: XCircle, text: 'text-state-blocked', surface: 'bg-state-blocked-surface', border: 'border-state-blocked-border' },
  passed: { label: 'Passed', Icon: CheckCircle2, text: 'text-state-passed', surface: 'bg-state-passed-surface', border: 'border-state-passed-border' },
  failed: { label: 'Failed', Icon: XCircle, text: 'text-state-failed', surface: 'bg-state-failed-surface', border: 'border-state-failed-border' },
  interrupted: { label: 'Interrupted', Icon: AlertTriangle, text: 'text-state-interrupted', surface: 'bg-state-interrupted-surface', border: 'border-state-interrupted-border' },
  stale: { label: 'Stale', Icon: AlertTriangle, text: 'text-state-stale', surface: 'bg-state-stale-surface', border: 'border-state-stale-border' },
};

export function ReviewState({
  state,
  label,
  detail,
  className,
}: {
  state: ReviewStateName;
  label?: string;
  detail?: string;
  className?: string;
}): React.JSX.Element {
  const meta = STATE_META[state];
  const Icon = meta.Icon;
  return (
    <span
      role="status"
      className={cn('inline-flex min-w-0 items-center gap-1 text-[10px]', meta.text, className)}
      aria-label={[label ?? meta.label, detail].filter(Boolean).join(', ')}
    >
      <Icon className={cn('h-3 w-3 shrink-0', state === 'busy' && 'animate-spin')} aria-hidden="true" />
      <span className="min-w-0 break-words">{label ?? meta.label}{detail ? ` · ${detail}` : ''}</span>
    </span>
  );
}

export function WorkItemHeader({
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
    <header className="space-y-2 border-b border-border pb-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="break-all font-mono text-[11px] text-muted-foreground">
            {item.source.repo}#{item.source.number}
          </p>
          <p className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="font-medium text-foreground">Source {item.snapshot.state}</span>
            <span aria-hidden="true">·</span>
            <span title={item.snapshot.revision}>revision {item.snapshot.revision}</span>
          </p>
        </div>
        <a
          href={item.source.url}
          target="_blank"
          rel="noreferrer"
          title="Open on GitHub"
          aria-label="Open on GitHub"
          className="awos-focus-ring shrink-0 rounded-md border border-input p-1.5 text-muted-foreground transition-colors hover:bg-accent"
        >
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          title="Ask GitHub again"
          aria-label="Ask GitHub again"
          className="awos-focus-ring shrink-0 rounded-md border border-input p-1.5 text-muted-foreground transition-colors hover:bg-accent disabled:opacity-40"
        >
          <RefreshCw className={cn('h-3 w-3', busy && 'animate-spin')} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onDetach}
          title="Unlink this issue from the thread"
          aria-label="Unlink this issue from the thread"
          className="awos-focus-ring shrink-0 rounded-md border border-input p-1.5 text-muted-foreground transition-colors hover:bg-accent"
        >
          <Unlink className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>

      <h2 className="break-words text-sm font-medium">{item.snapshot.title}</h2>
      {item.snapshot.labels.length > 0 && (
        <p className="break-words text-[10px] text-muted-foreground">{item.snapshot.labels.join(' · ')}</p>
      )}
      <p className="text-[10px] text-muted-foreground">
        Read {formatRelative(item.fetchedAt)}
        {item.lastRefreshedAt > item.fetchedAt && `, checked ${formatRelative(item.lastRefreshedAt)}`}
      </p>
    </header>
  );
}

export function RunSummary({ run, currentRevision }: { run: RunView; currentRevision: string }): React.JSX.Element {
  const agentStyle = run.agent ? getAgentStyle(run.agent) : null;
  const sourceMoved = run.revision !== '' && run.revision !== currentRevision;
  const state = run.interruptedByRestart
    ? 'interrupted'
    : run.state === 'running'
      ? 'busy'
      : run.state === 'completed'
        ? 'passed'
        : run.state === 'interrupted'
          ? 'interrupted'
          : 'failed';
  const label = run.interruptedByRestart
    ? 'Interrupted by restart'
    : run.state === 'running'
      ? 'Running'
      : run.state === 'completed'
        ? 'Finished'
        : run.state === 'interrupted'
          ? 'Interrupted'
          : 'Failed';

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {agentStyle && (
          <span
            style={agentStyle.cssVars}
            className={cn(agentStyle.root, 'rounded border px-1 py-px text-[9px]', agentStyle.bg, agentStyle.border, agentStyle.text)}
          >
            {agentStyle.label}
          </span>
        )}
        <ReviewState state={state} label={label} />
        <span className="text-[10px] text-muted-foreground">{formatRelative(run.ts)}</span>
      </div>
      <p className="break-words">{run.instruction}</p>
      {run.detail && <p className="break-words text-[10px] text-muted-foreground">{run.detail}</p>}
      {sourceMoved && (
        <ReviewState
          state="stale"
          label="Source changed since this run"
          detail="The issue changed; its context is kept as it was."
          className="max-w-full"
        />
      )}
    </div>
  );
}

export function EvidenceItem({
  item,
  candidateTree,
}: {
  item: EvidenceRecord;
  candidateTree?: string | null;
}): React.JSX.Element {
  const stale = candidateTree !== undefined && item.state.tree !== candidateTree;
  const state = stale ? 'stale' : item.state.dirty ? 'waiting' : 'passed';
  const stateLabel = stale
    ? 'Stale evidence'
    : item.state.dirty
      ? 'Dirty candidate · with uncommitted changes'
      : 'Candidate recorded';
  return (
    <li className={cn('space-y-1 border-l-2 px-2 py-1.5', STATE_META[state].surface, STATE_META[state].border)}>
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">{item.kind}</span>
        <span className="min-w-0 flex-1 break-words">{item.summary}</span>
      </div>
      <p className="break-words text-[10px] text-muted-foreground">
        {item.ref.url === null ? (
          <span className="font-mono">{item.ref.label}</span>
        ) : (
          <a href={item.ref.url} target="_blank" rel="noreferrer" className="font-mono underline-offset-2 hover:underline">
            {item.ref.label}
          </a>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
        <span>from {item.source}</span>
        <span>{formatRelative(item.at)}</span>
        <ReviewState state={state} label={stateLabel} />
      </div>
      <p className="break-all font-mono text-[10px] text-muted-foreground" title={item.state.tree ?? undefined}>
        candidate {item.state.tree ?? 'unknown'}
        {item.state.commit !== null && <> · commit {item.state.commit}</>}
        {item.state.dirty && ' · uncommitted changes'}
      </p>
      {item.check && (
        <p className="break-words text-[10px] text-muted-foreground">
          check {item.check.name} · {item.check.passed ? 'passed' : `failed (exit ${item.check.exitCode ?? 'unknown'})`}
        </p>
      )}
    </li>
  );
}

export function RetainedContextItem({
  item,
  onSelect,
  onRetire,
  kindLabel,
}: {
  item: RetainedItem;
  onSelect: (selected: boolean) => void;
  onRetire: () => void;
  kindLabel: string;
}): React.JSX.Element {
  return (
    <li className="flex items-start gap-1.5">
      <input
        type="checkbox"
        checked={item.selected}
        onChange={(event) => onSelect(event.target.checked)}
        aria-label={`Carry forward: ${item.text}`}
        className="mt-0.5 shrink-0"
      />
      <span className="min-w-0 flex-1 break-words">
        <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">{kindLabel}</span>{' '}
        <span>{item.text}</span>
        <span className="text-[10px] text-muted-foreground">· {item.source}</span>
        <span className="text-[10px] text-muted-foreground">· {formatRelative(item.at)}</span>
      </span>
      <button
        type="button"
        onClick={onRetire}
        title="No longer true — keep it, stop carrying it"
        className="awos-focus-ring shrink-0 text-[10px] text-muted-foreground underline-offset-2 hover:underline"
      >
        Retire
      </button>
    </li>
  );
}

const REQUIREMENT_META: Record<RequirementResult['state'], { state: ReviewStateName; label: string }> = {
  satisfied: { state: 'passed', label: 'passed against this content' },
  missing: { state: 'idle', label: 'has not been run' },
  failed: { state: 'failed', label: 'failed' },
  stale: { state: 'stale', label: 'passed against different content' },
};

export function GateResult({
  requirement,
  candidateTree,
  onRun,
  busy = false,
}: {
  requirement: RequirementResult;
  candidateTree: string | null;
  onRun: () => void;
  busy?: boolean;
}): React.JSX.Element {
  const meta = REQUIREMENT_META[requirement.state];
  return (
    <li className={cn('flex items-start gap-2 border-l-2 px-2 py-1.5', STATE_META[meta.state].surface, STATE_META[meta.state].border)}>
      <ReviewState state={meta.state} label={meta.label} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{requirement.name}</span>
        <span className="block break-all font-mono text-[10px] text-muted-foreground">{requirement.command || 'No command configured'}</span>
        <span className="block break-all font-mono text-[10px] text-muted-foreground">
          candidate {candidateTree ?? 'unknown'}
          {requirement.evidenceTree !== null && ` · evidence ${requirement.evidenceTree}`}
        </span>
      </span>
      <VerifyAction label="Run" command={requirement.command} onClick={onRun} disabled={busy} disabledReason={busy ? 'A verification check is already running.' : undefined} />
    </li>
  );
}

export function VerifyAction({
  label,
  command,
  onClick,
  disabled = false,
  disabledReason,
}: {
  label: string;
  command?: string;
  onClick: () => void;
  disabled?: boolean;
  disabledReason?: string;
}): React.JSX.Element {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? disabledReason : command ? `Run ${command}` : label}
      aria-label={label}
      className="h-auto shrink-0 px-2 py-1 text-[10px]"
    >
      {disabled ? <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Check className="h-3 w-3" aria-hidden="true" />}
      {label}
    </Button>
  );
}

export function CandidateSummary({
  candidate,
}: {
  candidate: { commit: string | null; tree: string | null; dirty: boolean };
}): React.JSX.Element {
  return (
    <p className="break-all font-mono text-[10px] text-muted-foreground">
      candidate tree {candidate.tree ?? 'unknown'}
      {candidate.commit !== null && <> · commit {candidate.commit}</>}
      {candidate.dirty && ' · uncommitted changes'}
    </p>
  );
}
