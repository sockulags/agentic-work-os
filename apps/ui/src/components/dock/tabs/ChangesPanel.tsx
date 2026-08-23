import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { parseUnifiedDiff, type ParsedDiff } from '@/lib/diff';
import { diffFileToPatch } from '@/lib/file-tree';
import { capabilitiesForTurn } from '@/lib/capabilities';
import { DiffView } from '@/components/DiffView';
import { FileTree } from '@/components/FileTree';
import { getAgentStyle } from '@/components/AgentBadge';
import { useHarnessContext } from '@/state/HarnessContext';
import { cn } from '@/lib/utils';

/** Above this many files, everything starts collapsed so the index stays scannable. */
const AUTO_OPEN_LIMIT = 3;

/**
 * Cumulative file changes for the current turn, as a review surface rather than a dump.
 *
 * Three states, and the middle one matters as much as the first. When the agent reports a
 * turn diff, this shows a real viewer. When it doesn't — Claude today — the panel says so
 * plainly, because "no changes" and "this agent never tells us about changes" are
 * different facts and confusing them costs the user trust in the panel.
 *
 * What it deliberately does not do is reconstruct a diff from free tool output. Guessing
 * at file changes by parsing an agent's prose would produce a view that is wrong in ways
 * the user cannot detect, which is worse than admitting the gap.
 *
 * The review layout is a fixed index over a scrolling diff. Each file gets its own
 * `DiffView` fed a single-file patch, which is what makes a file addressable: the panel
 * owns one element per file, so it has somewhere to scroll to and something to remount
 * open when the index is clicked. `DiffView` and the parser stay untouched.
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
    // Keyed on the patch so a new turn starts from a clean index rather than inheriting
    // scroll position and open files that belonged to a different set of paths.
    return <ChangeReview key={trimmed} parsed={parsed} />;
  }

  if (agent !== null && !supportsTurnDiff) {
    const style = getAgentStyle(agent);
    return (
      <div className="flex items-start gap-2 px-4 py-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        <p>
          <span className={cn('font-medium', style.text)}>
            {style.label}
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

function ChangeReview({ parsed }: { parsed: ParsedDiff }): React.JSX.Element {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  /**
   * Per-file remount counter. `DiffView` owns its collapse state internally, so the only
   * way to honour "jump to this file" for a file the reviewer collapsed — or that started
   * collapsed because the change is large — is to give that one file a new key. Counting
   * per file rather than sharing one nonce keeps the other files as the reviewer left them.
   */
  const [openTicks, setOpenTicks] = useState<ReadonlyMap<number, number>>(() => new Map());
  const rows = useRef(new Map<number, HTMLDivElement>());

  const files = useMemo(
    () => parsed.files.map((file) => ({ file, patch: diffFileToPatch(file) })),
    [parsed],
  );

  const jumpTo = useCallback((index: number) => {
    setActiveIndex(index);
    setOpenTicks((previous) => new Map(previous).set(index, (previous.get(index) ?? 0) + 1));
  }, []);

  // Runs after the remount has laid out, so the target is already at its opened height.
  // The jump is instant rather than smooth: the reviewer clicked a specific file and an
  // animation only delays the thing they asked for.
  useEffect(() => {
    if (activeIndex === null) return;
    rows.current.get(activeIndex)?.scrollIntoView({ block: 'start' });
  }, [activeIndex, openTicks]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
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

      <FileTree
        files={parsed.files}
        activeIndex={activeIndex}
        onSelect={jumpTo}
        className="max-h-[40%] shrink-0 border-b border-border"
      />

      <div className="awos-scroll min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {files.map(({ file, patch }, index) => (
          <div
            key={`${file.path}:${index}:${openTicks.get(index) ?? 0}`}
            ref={(element) => {
              if (element === null) rows.current.delete(index);
              else rows.current.set(index, element);
            }}
            className="scroll-mt-2"
          >
            {/* Split view needs two code columns side by side, which a dock column cannot
                give without horizontal scrolling on every line. */}
            <DiffView
              patch={patch}
              defaultMode="unified"
              defaultOpen={openTicks.has(index) || parsed.files.length <= AUTO_OPEN_LIMIT}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
