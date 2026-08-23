import { Circle, CircleDot, CheckCircle2 } from 'lucide-react';
import { useHarnessContext } from '@/state/HarnessContext';
import { cn } from '@/lib/utils';
import { ReviewState } from '@/components/review/ReviewPatterns';

/**
 * Live checklist, fed by Claude's TodoWrite and Codex's turn/plan/updated.
 *
 * Both agents replace the whole plan on every update rather than patching items, so this
 * renders the latest snapshot and keeps no history of its own.
 */
export function PlanPanel(): React.JSX.Element {
  const items = useHarnessContext().runtime?.plan ?? [];

  if (items.length === 0) {
    return (
      <div className="space-y-1 px-4 py-3 text-xs">
        <ReviewState state="idle" label="No plan" />
        <p className="text-muted-foreground">
          No plan yet. Claude&rsquo;s todo list and Codex&rsquo;s plan updates land here as the
          agent works.
        </p>
      </div>
    );
  }

  const done = items.filter((item) => item.status === 'completed').length;

  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>
          {done}/{items.length} done
        </span>
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-foreground/40 transition-all"
            style={{ width: `${(done / items.length) * 100}%` }}
          />
        </div>
      </div>

      <ul className="space-y-1">
        {items.map((item, i) => (
          <li
            key={`${i}:${item.text}`}
            className={cn(
              'flex items-start gap-2 text-xs',
              item.status === 'completed' && 'text-muted-foreground line-through',
              item.status === 'in_progress' && 'text-foreground',
              item.status === 'pending' && 'text-muted-foreground',
            )}
          >
            {item.status === 'completed' ? (
              <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-state-passed" />
            ) : item.status === 'in_progress' ? (
              <CircleDot className="mt-0.5 h-3 w-3 shrink-0 animate-pulse text-state-busy" />
            ) : (
              <Circle className="mt-0.5 h-3 w-3 shrink-0" />
            )}
            <span className="break-words">{item.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
