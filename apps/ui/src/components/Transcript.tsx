import { useEffect, useMemo, useRef } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import type { TranscriptItem } from '@/lib/transcript';
import { groupTranscriptItems } from '@/lib/group-items';
import { AGENT_STYLE } from './AgentBadge';
import { Markdown } from './Markdown';
import { ReasoningBlock } from './ReasoningBlock';
import { ToolBlock } from './ToolBlock';
import { ToolGroup } from './ToolGroup';
import { useHarnessContext } from '@/state/HarnessContext';
import { cn } from '@/lib/utils';

/**
 * The conversation surface.
 *
 * Autoscroll follows new content only while the user is already at the bottom. Yanking
 * someone back down while they're reading earlier output is the single most irritating
 * thing a streaming chat UI can do.
 */
export function Transcript({ items }: { items: TranscriptItem[] }): React.JSX.Element {
  const busy = useHarnessContext().runtime?.busyWith != null;
  const rows = useMemo(() => groupTranscriptItems(items), [items]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  const handleScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = distance < 80;
  };

  useEffect(() => {
    if (!pinnedRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items]);

  if (items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center">
        <div className="max-w-md space-y-2">
          <p className="text-sm text-muted-foreground">
            Send a message to start. Switch agents at any point — the other one gets the
            full transcript replayed into its session, so it picks up mid-thought.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="awos-scroll flex-1 overflow-y-auto px-6 py-4"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {rows.map((row, index) =>
          row.type === 'tool-group' ? (
            <ToolGroup key={row.key} items={row.items} />
          ) : (
            <TranscriptRow key={row.key} item={row.item} isLast={index === rows.length - 1} />
          ),
        )}
        {busy && <ThinkingIndicator />}
      </div>
    </div>
  );
}

function TranscriptRow({
  item,
  isLast,
}: {
  item: TranscriptItem;
  isLast: boolean;
}): React.JSX.Element | null {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-secondary px-4 py-2.5 text-sm">
            {item.text}
          </div>
        </div>
      );

    case 'divider': {
      const style = AGENT_STYLE[item.agent];
      return (
        <div className="flex items-center gap-3 pt-2">
          <span className={cn('h-1.5 w-1.5 rounded-full', style.dot)} />
          <span className={cn('text-xs font-medium', style.text)}>{style.label}</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      );
    }

    case 'message':
      return <Markdown text={item.text} streaming={item.streaming} />;

    case 'reasoning':
      return (
        <ReasoningBlock
          text={item.text}
          streaming={item.streaming}
          startedAt={item.ts}
          settled={!isLast}
        />
      );

    case 'tool':
      return <ToolBlock item={item} />;

    case 'notice':
      return (
        <div
          className={cn(
            'flex items-start gap-2 rounded-md border px-3 py-2 text-xs',
            item.level === 'error'
              ? 'border-destructive/40 bg-destructive/10 text-destructive-foreground'
              : 'border-border bg-muted/40 text-muted-foreground',
          )}
        >
          {item.level === 'error' ? (
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <span className="whitespace-pre-wrap break-words">{item.text}</span>
        </div>
      );

    default:
      return null;
  }
}

function ThinkingIndicator(): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5 py-1 text-muted-foreground">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-current"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </div>
  );
}
