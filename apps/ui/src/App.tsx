import { useEffect } from 'react';
import { GitMerge, X } from 'lucide-react';
import type { AgentAvailability, AgentId, PermissionMode } from '@awos/protocol';
import { useHarnessContext } from '@/state/HarnessContext';
import { ThreadSidebar } from '@/components/ThreadSidebar';
import { Transcript } from '@/components/Transcript';
import { Composer } from '@/components/Composer';
import { Dock } from '@/components/dock/Dock';
import { ApprovalDialog } from '@/components/ApprovalDialog';
import { DensityToggle } from '@/components/DensityToggle';
import { getAgentStyle } from '@/components/AgentBadge';
import { cn, formatTokens } from '@/lib/utils';

const PERMISSION_MODES: Array<{ value: PermissionMode; label: string }> = [
  { value: 'default', label: 'Ask' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan' },
  { value: 'bypassPermissions', label: 'Bypass' },
];

export default function App(): React.JSX.Element {
  const h = useHarnessContext();

  // Notices are transient; they shouldn't linger after the user has moved on.
  useEffect(() => {
    if (!h.notice) return;
    const timer = window.setTimeout(h.dismissNotice, 8000);
    return () => window.clearTimeout(timer);
  }, [h.notice, h.dismissNotice]);

  return (
    <div className="flex h-full">
      <ThreadSidebar />

      <main className="flex min-w-0 flex-1 flex-col">
        <Header
          title={h.activeThread?.title ?? 'Agentic Work OS'}
          cwd={h.activeThread?.cwd ?? null}
          status={h.status}
          totals={h.transcript.totals}
          onPermissionMode={(mode) => void h.setPermissionMode(mode)}
          hasThread={h.activeThread !== null}
          parallel={h.activeThread?.parallel ?? false}
          lanes={h.runtime?.lanes ?? {}}
          busy={h.runtime?.busy ?? []}
          onParallel={(on) => void h.setParallel(on)}
          onIntegrate={(agent) => void h.integrateLane(agent)}
        />

        {h.notice && (
          <div
            className={cn(
              'flex items-start gap-2 border-b px-6 py-2 text-xs',
              h.notice.level === 'error'
                ? 'border-destructive/40 bg-destructive/10'
                : 'border-border bg-muted/40',
            )}
          >
            <span className="flex-1">{h.notice.message}</span>
            <button type="button" onClick={h.dismissNotice} className="opacity-60 hover:opacity-100">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {h.activeThread === null ? (
          <EmptyState connected={h.status === 'open'} profiles={h.availability} />
        ) : (
          <>
            <Transcript items={h.transcript.items} />
            <Composer />
          </>
        )}
      </main>

      {/* Outside <main> so the dock spans the full window height rather than sitting
          under the thread header, and so it never competes with the transcript for
          vertical space the way the old strips did. */}
      {h.activeThread !== null && <Dock />}

      <ApprovalDialog />
    </div>
  );
}

function Header({
  title,
  cwd,
  status,
  totals,
  onPermissionMode,
  hasThread,
  parallel,
  lanes,
  busy,
  onParallel,
  onIntegrate,
}: {
  title: string;
  cwd: string | null;
  status: string;
  totals: { inputTokens: number; outputTokens: number; costUsd: number };
  onPermissionMode: (mode: PermissionMode) => void;
  hasThread: boolean;
  parallel: boolean;
  lanes: Partial<Record<AgentId, string>>;
  busy: AgentId[];
  onParallel: (on: boolean) => void;
  onIntegrate: (agent: AgentId) => void;
}): React.JSX.Element {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-border px-6 py-2.5">
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-medium">{title}</h2>
        {cwd && <p className="truncate font-mono text-[11px] text-muted-foreground">{cwd}</p>}
      </div>

      {hasThread && (
        <div className="flex items-center gap-1.5">
          {/* One button per lane with work to hand over. Integration is explicit because
              the thread directory is the user's, and files arriving in it unasked is the
              surprise this whole mode has to avoid. */}
          {parallel &&
            (Object.keys(lanes) as AgentId[]).map((agent) => (
              <button
                key={agent}
                type="button"
                onClick={() => onIntegrate(agent)}
                disabled={busy.includes(agent)}
                title={`Apply ${agent}'s lane to ${cwd ?? 'the thread directory'}`}
                className="rounded-md border border-input px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent disabled:opacity-40"
              >
                <GitMerge className="mr-1 inline h-3 w-3" />
                {agent}
              </button>
            ))}

          <button
            type="button"
            onClick={() => onParallel(!parallel)}
            title={
              parallel
                ? 'Agents each work in their own copy of the repository and can run at the same time'
                : 'Agents share this directory, so only one can work at a time'
            }
            className={cn(
              'rounded-md border px-2 py-1 text-xs transition-colors',
              parallel
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                : 'border-input text-muted-foreground hover:bg-accent',
            )}
          >
            {parallel ? 'Lanes on' : 'Lanes off'}
          </button>
        </div>
      )}

      {hasThread && <DensityToggle />}

      {hasThread && (
        <select
          onChange={(e) => onPermissionMode(e.target.value as PermissionMode)}
          defaultValue="default"
          title="Applies the next time an agent process starts"
          className="rounded-md border border-input bg-transparent px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {PERMISSION_MODES.map((mode) => (
            <option key={mode.value} value={mode.value} className="bg-card">
              {mode.label}
            </option>
          ))}
        </select>
      )}

      {(totals.inputTokens > 0 || totals.outputTokens > 0) && (
        <span className="whitespace-nowrap text-[11px] text-muted-foreground">
          {formatTokens(totals.inputTokens)} in · {formatTokens(totals.outputTokens)} out
          {totals.costUsd > 0 && ` · $${totals.costUsd.toFixed(3)}`}
        </span>
      )}

      <span
        className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          status === 'open'
            ? 'bg-emerald-500'
            : status === 'connecting'
              ? 'animate-pulse bg-amber-500'
              : 'bg-destructive',
        )}
        title={`Harness ${status}`}
      />
    </header>
  );
}

function EmptyState({ connected, profiles }: { connected: boolean; profiles: AgentAvailability[] }): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-sm space-y-3 text-center">
        <div className="flex justify-center gap-2">
          {profiles.map((profile) => {
            const style = getAgentStyle(profile.profileId, profile.label);
            return (
              <span
                key={profile.profileId}
                className={cn('rounded-md border px-2.5 py-1 text-xs font-medium', style.bg, style.border, style.text)}
              >
                {style.label}
              </span>
            );
          })}
        </div>
        <p className="text-sm text-muted-foreground">
          {connected
            ? 'Create a thread to get started. Both agents work in it, and either can pick up where the other left off.'
            : 'Waiting for the harness core to come up…'}
        </p>
      </div>
    </div>
  );
}
