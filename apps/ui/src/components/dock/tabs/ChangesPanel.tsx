import { useMemo } from 'react';
import { Info } from 'lucide-react';
import { parseUnifiedDiff } from '@/lib/diff';
import { capabilitiesForTurn } from '@/lib/capabilities';
import { DiffView } from '@/components/DiffView';
import { AGENT_STYLE } from '@/components/AgentBadge';
import { useHarnessContext } from '@/state/HarnessContext';
import { cn } from '@/lib/utils';

/**
 * Cumulative file changes for the current turn.
 *
 * Three states, and the middle one matters as much as the first. When the agent reports a
 * turn diff, this shows a real viewer. When it doesn't — Claude today — the panel says so
 * plainly, because "no changes" and "this agent never tells us about changes" are
 * different facts and confusing them costs the user trust in the panel.
 *
 * What it deliberately does not do is reconstruct a diff from free tool output. Guessing
 * at file changes by parsing an agent's prose would produce a view that is wrong in ways
 * the user cannot detect, which is worse than admitting the gap.
 */
export function ChangesPanel(): React.JSX.Element {
  const h = useHarnessContext();
  const trimmed = h.runtime?.diff?.trim() ?? '';
  // The panel describes the last completed/current turn, not the agent selected for the
  // next message. The composer is intentionally still driven by activeAgent.
  const agent = h.runtime?.lastTurnAgent ?? null;
  // Assume support until the probe answers: showing "no diff" for a beat during startup
  // would be a lie that corrects itself, which is worse than showing nothing.
  const supportsTurnDiff = capabilitiesForTurn(h.availability, agent)?.turnDiff ?? true;

  const parsed = useMemo(() => (trimmed === '' ? null : parseUnifiedDiff(trimmed)), [trimmed]);

  if (parsed !== null && parsed.files.length > 0) {
    return (
      <div className="space-y-2 px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>
            {parsed.files.length} {parsed.files.length === 1 ? 'file' : 'files'}
          </span>
          {parsed.additions > 0 && (
            <span className="font-mono text-emerald-400">+{parsed.additions}</span>
          )}
          {parsed.deletions > 0 && (
            <span className="font-mono text-red-400">−{parsed.deletions}</span>
          )}
        </div>
        {/* Split view needs two code columns side by side, which a dock column cannot
            give without horizontal scrolling on every line. */}
        <DiffView patch={trimmed} defaultMode="unified" />
      </div>
    );
  }

  if (agent !== null && !supportsTurnDiff) {
    return (
      <div className="flex items-start gap-2 px-4 py-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        <p>
          <span className={cn('font-medium', AGENT_STYLE[agent].text)}>
            {AGENT_STYLE[agent].label}
          </span>{' '}
          doesn&rsquo;t report a diff for its turns, so there are no aggregated changes to show
          here. Individual file edits appear as tool blocks in the transcript, and any{' '}
          <code className="font-mono">git diff</code> it runs is rendered in full.
        </p>
      </div>
    );
  }

  return (
    <p className="px-4 py-3 text-xs text-muted-foreground">
      No file changes reported for this turn.
    </p>
  );
}
