import { useEffect } from 'react';
import { X } from 'lucide-react';
import type { AgentCapabilities, AgentAvailability, AgentId, PermissionMode } from '@awos/protocol';
import { useHarness } from '@/hooks/useHarness';
import { ThreadSidebar } from '@/components/ThreadSidebar';
import { Transcript } from '@/components/Transcript';
import { Composer } from '@/components/Composer';
import { PlanPanel } from '@/components/PlanPanel';
import { ChangesPanel } from '@/components/ChangesPanel';
import { ApprovalDialog } from '@/components/ApprovalDialog';
import { AGENT_STYLE } from '@/components/AgentBadge';
import { cn, formatTokens } from '@/lib/utils';

const PERMISSION_MODES: Array<{ value: PermissionMode; label: string }> = [
  { value: 'default', label: 'Ask' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan' },
  { value: 'bypassPermissions', label: 'Bypass' },
];

export function capabilitiesForTurn(
  availability: AgentAvailability[],
  turnAgent: AgentId | null,
): AgentCapabilities | undefined {
  if (turnAgent === null) return undefined;
  return availability.find((entry) => entry.agent === turnAgent)?.capabilities;
}

export default function App(): React.JSX.Element {
  const h = useHarness();
  const busyWith = h.runtime?.busyWith ?? null;
  const activeAgent = h.activeThread?.activeAgent ?? 'claude';
  const lastTurnAgent = h.runtime?.lastTurnAgent ?? null;
  const pendingApproval = h.runtime?.pendingApprovals[0] ?? null;

  // The Changes panel describes the last completed/current turn, not the agent selected
  // for the next message. The composer is intentionally still driven by activeAgent.
  const lastTurnCapabilities = capabilitiesForTurn(h.availability, lastTurnAgent);

  // Notices are transient; they shouldn't linger after the user has moved on.
  useEffect(() => {
    if (!h.notice) return;
    const timer = window.setTimeout(h.dismissNotice, 8000);
    return () => window.clearTimeout(timer);
  }, [h.notice, h.dismissNotice]);

  return (
    <div className="flex h-full">
      <ThreadSidebar
        threads={h.threads}
        activeThreadId={h.activeThreadId}
        onOpen={(id) => void h.openThread(id)}
        onCreate={(cwd, agent) => h.createThread(cwd, agent)}
        onDelete={(id) => void h.deleteThread(id)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <Header
          title={h.activeThread?.title ?? 'Agentic Work OS'}
          cwd={h.activeThread?.cwd ?? null}
          status={h.status}
          totals={h.transcript.totals}
          onPermissionMode={(mode) => void h.setPermissionMode(mode)}
          hasThread={h.activeThread !== null}
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
          <EmptyState connected={h.status === 'open'} />
        ) : (
          <>
            <PlanPanel items={h.runtime?.plan ?? []} />
            <ChangesPanel
              patch={h.runtime?.diff ?? null}
              agent={lastTurnAgent}
              // Assume support until the probe answers: showing "no diff" for a beat
              // during startup would be a lie that corrects itself, which is worse than
              // showing nothing.
              supportsTurnDiff={lastTurnCapabilities?.turnDiff ?? true}
              hasActivity={h.transcript.items.length > 0}
            />
            <Transcript items={h.transcript.items} busy={busyWith !== null} />
            <Composer
              agent={activeAgent}
              onAgentChange={(agent) => void h.setAgent(agent)}
              onSend={(text) => void h.send(text, activeAgent)}
              onInterrupt={() => void h.interrupt()}
              busyWith={busyWith}
              availability={h.availability}
              disabled={h.status !== 'open'}
            />
          </>
        )}
      </main>

      <ApprovalDialog
        approval={pendingApproval}
        onResolve={(approvalId, optionId) => void h.resolveApproval(approvalId, optionId)}
      />
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
}: {
  title: string;
  cwd: string | null;
  status: string;
  totals: { inputTokens: number; outputTokens: number; costUsd: number };
  onPermissionMode: (mode: PermissionMode) => void;
  hasThread: boolean;
}): React.JSX.Element {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-border px-6 py-2.5">
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-medium">{title}</h2>
        {cwd && <p className="truncate font-mono text-[11px] text-muted-foreground">{cwd}</p>}
      </div>

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

function EmptyState({ connected }: { connected: boolean }): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-sm space-y-3 text-center">
        <div className="flex justify-center gap-2">
          {(['claude', 'codex'] as const).map((agent) => (
            <span
              key={agent}
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs font-medium',
                AGENT_STYLE[agent].bg,
                AGENT_STYLE[agent].border,
                AGENT_STYLE[agent].text,
              )}
            >
              {AGENT_STYLE[agent].label}
            </span>
          ))}
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
