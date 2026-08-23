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
import { Button } from '@/components/ui/button';
import { getAgentStyle } from '@/components/AgentBadge';
import { cn, formatTokens } from '@/lib/utils';
import { useDisplaySettings } from '@/state/DisplaySettingsContext';

const PERMISSION_MODES: Array<{ value: PermissionMode; label: string }> = [
  { value: 'default', label: 'Ask' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan' },
  { value: 'bypassPermissions', label: 'Bypass' },
];

export default function App(): React.JSX.Element {
  const h = useHarnessContext();
  const { density } = useDisplaySettings();

  // Notices are transient; they shouldn't linger after the user has moved on.
  useEffect(() => {
    if (!h.notice) return;
    const timer = window.setTimeout(h.dismissNotice, 8000);
    return () => window.clearTimeout(timer);
  }, [h.notice, h.dismissNotice]);

  return (
    <div
      data-density={density === 'compact' ? 'compact' : 'comfortable'}
      className="awos-shell flex h-full bg-surface-canvas"
    >
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
              'flex items-start gap-2 border-b px-[var(--density-shell-gutter)] py-2 text-xs',
              h.notice.level === 'error'
                ? 'border-state-failed-border bg-state-failed-surface text-state-failed'
                : 'border-border bg-surface-subtle text-muted-foreground',
            )}
          >
            <span className="flex-1">{h.notice.message}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={h.dismissNotice}
              aria-label="Dismiss notice"
              className="-my-1 -mr-1 opacity-70 hover:opacity-100"
            >
              <X data-icon="inline-start" />
            </Button>
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
    <header className="awos-header flex shrink-0 items-center gap-[var(--density-shell-gap)] border-b border-border bg-surface-rail px-[var(--density-shell-gutter)] py-[var(--density-shell-header-padding)]">
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-medium">{title}</h2>
        {cwd && <p className="truncate font-mono text-[11px] text-muted-foreground">{cwd}</p>}
      </div>

      {hasThread && (
        <div className="flex shrink-0 items-center gap-1.5">
          {/* One button per lane with work to hand over. Integration is explicit because
              the thread directory is the user's, and files arriving in it unasked is the
              surprise this whole mode has to avoid. */}
          {parallel &&
            (Object.keys(lanes) as AgentId[]).map((agent) => (
              <Button
                key={agent}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onIntegrate(agent)}
                disabled={busy.includes(agent)}
                title={`Apply ${agent}'s lane to ${cwd ?? 'the thread directory'}`}
                className="text-xs text-muted-foreground disabled:opacity-40"
              >
                <GitMerge data-icon="inline-start" />
                {agent}
              </Button>
            ))}

          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onParallel(!parallel)}
            aria-pressed={parallel}
            title={
              parallel
                ? 'Agents each work in their own copy of the repository and can run at the same time'
                : 'Agents share this directory, so only one can work at a time'
            }
            className={cn(
              'text-xs',
              parallel
                ? 'border-state-passed-border bg-state-passed-surface text-state-passed hover:bg-state-passed-surface'
                : 'text-muted-foreground',
            )}
          >
            {parallel ? 'Lanes on' : 'Lanes off'}
          </Button>
        </div>
      )}

      {hasThread && <DensityToggle />}

      {hasThread && (
        <select
          onChange={(e) => onPermissionMode(e.target.value as PermissionMode)}
          defaultValue="default"
          title="Applies the next time an agent process starts"
          className="awos-input shrink-0 text-xs"
        >
          {PERMISSION_MODES.map((mode) => (
            <option key={mode.value} value={mode.value} className="bg-card">
              {mode.label}
            </option>
          ))}
        </select>
      )}

      {(totals.inputTokens > 0 || totals.outputTokens > 0) && (
        <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">
          {formatTokens(totals.inputTokens)} in · {formatTokens(totals.outputTokens)} out
          {totals.costUsd > 0 && ` · $${totals.costUsd.toFixed(3)}`}
        </span>
      )}

      <span
        role="status"
        aria-label={`Harness ${status}`}
        className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          status === 'open'
            ? 'bg-state-passed'
            : status === 'connecting'
              ? 'animate-pulse bg-state-busy'
              : 'bg-state-failed',
        )}
        title={`Harness ${status}`}
      >
        <span className="sr-only">Harness {status}</span>
      </span>
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
                style={style.cssVars}
                className={cn(style.root, 'rounded-md border px-2.5 py-1 text-xs font-medium', style.bg, style.border, style.text)}
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
