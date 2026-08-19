import { useState } from 'react';
import { ChevronRight, Layers, Loader2 } from 'lucide-react';
import { shouldExpandGroup, summarizeToolGroup } from '@/lib/group-items';
import type { ToolItem } from '@/lib/tool-summary';
import { useDisplaySettings } from '@/state/DisplaySettingsContext';
import { ToolBlock } from './ToolBlock';
import { cn, formatDuration } from '@/lib/utils';

/** One row for a run of tool calls, standing in for the stack of blocks inside it. */
export function ToolGroup({ items }: { items: ToolItem[] }): React.JSX.Element {
  const { density } = useDisplaySettings();
  const auto = shouldExpandGroup(items, density);
  const [override, setOverride] = useState<boolean | null>(null);
  const [densityAtOverride, setDensityAtOverride] = useState(density);

  if (density !== densityAtOverride) {
    setDensityAtOverride(density);
    setOverride(null);
  }

  const open = override ?? auto;
  const summary = summarizeToolGroup(items);

  return (
    <div className={cn('rounded-md border', summary.failed > 0 ? 'border-destructive/40' : 'border-border')}>
      <button
        type="button"
        onClick={() => setOverride(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/40"
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs text-foreground/90">
          {summary.steps} steps
          {summary.durationMs !== null && (
            <span className="text-muted-foreground"> · {formatDuration(summary.durationMs)}</span>
          )}
        </span>
        {summary.failed > 0 && (
          <span className="shrink-0 text-[11px] text-destructive">
            {summary.failed} failed
          </span>
        )}
        {summary.running && (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="flex flex-col gap-2 border-t border-border p-2">
          {items.map((item) => (
            <ToolBlock key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
