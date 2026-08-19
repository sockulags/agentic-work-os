import { useState } from 'react';
import {
  ChevronRight,
  Terminal,
  FileText,
  FilePen,
  Search,
  Globe,
  Bot,
  ListChecks,
  Plug,
  Wrench,
  Loader2,
  Check,
  X,
  Ban,
} from 'lucide-react';
import type { ToolKind } from '@awos/protocol';
import { looksLikeUnifiedDiff } from '@/lib/diff';
import { summarizeTool, shouldExpandTool, type ToolItem } from '@/lib/tool-summary';
import { useDisplaySettings } from '@/state/DisplaySettingsContext';
import { DiffView } from './DiffView';
import { cn } from '@/lib/utils';

const ICONS: Record<ToolKind, typeof Terminal> = {
  command: Terminal,
  file_read: FileText,
  file_edit: FilePen,
  search: Search,
  web: Globe,
  task: Bot,
  todo: ListChecks,
  mcp: Plug,
  other: Wrench,
};

/** Collapsed by default: a turn can contain dozens of these. */
const OUTPUT_PREVIEW_LINES = 12;

export function ToolBlock({ item }: { item: ToolItem }): React.JSX.Element {
  const { density } = useDisplaySettings();
  const auto = shouldExpandTool(item, density);
  const [override, setOverride] = useState<boolean | null>(null);
  const [densityAtOverride, setDensityAtOverride] = useState(density);
  const [showAll, setShowAll] = useState(false);

  // Changing density is a statement about the whole transcript, so it outranks whatever
  // the reader opened or shut earlier under the previous setting.
  if (density !== densityAtOverride) {
    setDensityAtOverride(density);
    setOverride(null);
  }

  const expanded = override ?? auto;
  const Icon = ICONS[item.toolKind];
  const summary = summarizeTool(item);

  // `git diff` run through Bash, or a patch a tool printed, deserves the same rendering
  // as a first-class diff event. This is the path that gives Claude diff output too,
  // since it reports no turn-level diff of its own.
  const isDiff = looksLikeUnifiedDiff(item.output);

  const lines = item.output.split('\n');
  // Expanding answers "what did this do"; the rest of a 4000-line log is a different
  // question, and it should not push the next message off screen to answer one nobody asked.
  const truncated = !isDiff && !showAll && lines.length > OUTPUT_PREVIEW_LINES;
  const shown = truncated ? lines.slice(0, OUTPUT_PREVIEW_LINES).join('\n') : item.output;

  return (
    <div
      className={cn(
        'rounded-md border bg-card/50 text-sm',
        item.status === 'error' ? 'border-destructive/40' : 'border-border',
      )}
    >
      <button
        type="button"
        onClick={() => setOverride(!expanded)}
        aria-expanded={expanded}
        // The raw title is the exact call; the summary is the readable one. Keep both.
        title={item.title}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/40"
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90',
          )}
        />
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/90">
          {summary.label}
        </span>
        {summary.facts.length > 0 && (
          <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">
            {summary.facts.join(' · ')}
          </span>
        )}
        <StatusPill status={item.status} exitCode={item.exitCode} />
      </button>

      {expanded && (
        <div className="border-t border-border px-3 py-2">
          {item.input !== null && item.input !== undefined && (
            <details className="mb-2">
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                Input
              </summary>
              <pre className="awos-scroll mt-1 max-h-64 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
                {JSON.stringify(item.input, null, 2)}
              </pre>
            </details>
          )}

          {item.output ? (
            isDiff ? (
              <DiffView patch={item.output} defaultOpen />
            ) : (
              <>
                <pre className="awos-scroll max-h-[32rem] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/80">
                  {shown}
                </pre>
                {truncated && (
                  <button
                    type="button"
                    onClick={() => setShowAll(true)}
                    className="mt-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    Show {lines.length - OUTPUT_PREVIEW_LINES} more lines
                  </button>
                )}
              </>
            )
          ) : (
            <p className="text-xs italic text-muted-foreground">
              {item.status === 'running' ? 'Running…' : 'No output.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function StatusPill({
  status,
  exitCode,
}: {
  status: ToolItem['status'];
  exitCode: number | null;
}): React.JSX.Element {
  if (status === 'running') {
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />;
  }
  if (status === 'ok') {
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs text-emerald-400">
        <Check className="h-3.5 w-3.5" />
        {exitCode !== null && exitCode !== 0 ? exitCode : null}
      </span>
    );
  }
  if (status === 'denied') {
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs text-amber-400">
        <Ban className="h-3.5 w-3.5" />
        denied
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-destructive">
      <X className="h-3.5 w-3.5" />
      {exitCode !== null ? `exit ${exitCode}` : status}
    </span>
  );
}
