import { useMemo, useState } from 'react';
import { ChevronRight, GitCompare, Info } from 'lucide-react';
import type { AgentAvailability, AgentCapabilities, AgentId } from '@awos/protocol';
import { parseUnifiedDiff } from '@/lib/diff';
import { DiffView } from './DiffView';
import { AGENT_STYLE } from './AgentBadge';
import { useHarnessContext } from '@/state/HarnessContext';
import { cn } from '@/lib/utils';

export function capabilitiesForTurn(
  availability: AgentAvailability[],
  turnAgent: AgentId | null,
): AgentCapabilities | undefined {
  if (turnAgent === null) return undefined;
  return availability.find((entry) => entry.agent === turnAgent)?.capabilities;
}

/**
 * Cumulative file changes for the current turn.
 *
 * Two states, and the second one matters as much as the first. When the agent reports a
 * turn diff, this shows a real viewer. When it doesn't — Claude today — the panel says so
 * plainly instead of hiding, because a silently absent Changes panel is indistinguishable
 * from "the agent changed nothing".
 *
 * What it deliberately does not do is reconstruct a diff from free tool output. Guessing
 * at file changes by parsing an agent's prose would produce a view that is wrong in ways
 * the user cannot detect, which is worse than admitting the gap.
 */
export function ChangesPanel(): React.JSX.Element | null {
  const h = useHarnessContext();
  const patch = h.runtime?.diff ?? null;
  // The panel describes the last completed/current turn, not the agent selected for the
  // next message. The composer is intentionally still driven by activeAgent.
  const agent = h.runtime?.lastTurnAgent ?? null;
  // Assume support until the probe answers: showing "no diff" for a beat during startup
  // would be a lie that corrects itself, which is worse than showing nothing.
  const supportsTurnDiff = capabilitiesForTurn(h.availability, agent)?.turnDiff ?? true;
  const hasActivity = h.transcript.items.length > 0;

  const [open, setOpen] = useState(false);
  const trimmed = patch?.trim() ?? '';

  const parsed = useMemo(
    () => (trimmed === '' ? null : parseUnifiedDiff(trimmed)),
    [trimmed],
  );

  if (parsed !== null && parsed.files.length > 0) {
    return (
      <PanelShell>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 text-left text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronRight
            className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')}
          />
          <GitCompare className="h-3 w-3 shrink-0" />
          <span className="font-medium">Changes</span>
          <span>
            {parsed.files.length} {parsed.files.length === 1 ? 'file' : 'files'}
          </span>
          {parsed.additions > 0 && (
            <span className="font-mono text-emerald-400">+{parsed.additions}</span>
          )}
          {parsed.deletions > 0 && (
            <span className="font-mono text-red-400">−{parsed.deletions}</span>
          )}
        </button>

        {open && (
          <div className="mt-2">
            <DiffView patch={trimmed} />
          </div>
        )}
      </PanelShell>
    );
  }

  // Nothing to show, and nothing to explain yet.
  if (agent === null || supportsTurnDiff || !hasActivity) return null;

  return (
    <PanelShell>
      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        <p>
          <span className={cn('font-medium', AGENT_STYLE[agent].text)}>
            {AGENT_STYLE[agent].label}
          </span>{' '}
          doesn&rsquo;t report a diff for its turns, so there are no aggregated changes to
          show here. Individual file edits appear as tool blocks in the transcript, and any{' '}
          <code className="font-mono">git diff</code> it runs is rendered in full.
        </p>
      </div>
    </PanelShell>
  );
}

function PanelShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="border-b border-border bg-card/40">
      <div className="mx-auto max-w-3xl px-6 py-2">{children}</div>
    </div>
  );
}
