import { useEffect, useMemo, useRef } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import type { AgentAvailability } from '@awos/protocol';
import type { TranscriptItem } from '@/lib/transcript';
import { groupTranscriptItems } from '@/lib/group-items';
import { WorkerBadge } from './AgentBadge';
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
export function Transcript({
  items,
  profiles = [],
}: {
  items: TranscriptItem[];
  profiles?: Pick<AgentAvailability, 'agent' | 'profileId' | 'label'>[];
}): React.JSX.Element {
  const busy = useHarnessContext().runtime?.busyWith != null;
  const rows = useMemo(() => groupTranscriptItems(items), [items]);
  const profileLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const profile of profiles) {
      labels.set(profile.profileId, profile.label);
      labels.set(profile.agent, profile.label);
    }
    return labels;
  }, [profiles]);
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
      className="awos-scroll flex-1 overflow-y-auto px-[var(--density-shell-gutter)] py-4"
    >
      <div className="mx-auto flex min-w-0 w-full max-w-3xl flex-col gap-[var(--density-shell-gap)]">
        {rows.map((row, index) =>
          row.type === 'tool-group' ? (
            <ToolGroup key={row.key} items={row.items} profileLabel={profileLabels.get(row.items[0]?.agent ?? '')} />
          ) : (
            <TranscriptRow
              key={row.key}
              item={row.item}
              isLast={index === rows.length - 1}
              profileLabel={row.item.kind !== 'user' && 'agent' in row.item ? profileLabels.get(row.item.agent) : undefined}
            />
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
  profileLabel,
}: {
  item: TranscriptItem;
  isLast: boolean;
  profileLabel?: string;
}): React.JSX.Element | null {
  switch (item.kind) {
    case 'user':
      return (
        <div className="min-w-0 border-l-2 border-border py-[var(--density-transcript-row-padding)] pl-3">
          <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">You</span>
            <span aria-hidden="true">·</span>
            <span>Message</span>
          </div>
          <p className="max-w-full whitespace-pre-wrap break-words text-sm">{item.text}</p>
        </div>
      );

    case 'divider': {
      return (
        <div className="flex items-center gap-3 pt-2" data-transcript-divider>
          <WorkerBadge agent={item.agent} label={profileLabel} />
          <span className="h-px flex-1 bg-border" />
        </div>
      );
    }

    case 'message':
      return (
        <article className="min-w-0 border-l-2 border-border py-[var(--density-transcript-row-padding)] pl-3">
          <header className="mb-1.5 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
            <WorkerBadge agent={item.agent} label={profileLabel} />
            <span aria-hidden="true">·</span>
            <span>{item.streaming ? 'Streaming' : 'Completed'}</span>
          </header>
          <Markdown text={item.text} streaming={item.streaming} />
        </article>
      );

    case 'reasoning':
      return (
        <div className="min-w-0 py-[var(--density-transcript-row-padding)]" data-transcript-reasoning>
          <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            <WorkerBadge agent={item.agent} label={profileLabel} />
            <span aria-hidden="true">·</span>
            <span>Reasoning</span>
          </div>
          <ReasoningBlock
            text={item.text}
            streaming={item.streaming}
            startedAt={item.ts}
            settled={!isLast}
          />
        </div>
      );

    case 'tool':
      return (
        <div className="min-w-0 py-[var(--density-transcript-row-padding)]" data-transcript-tool>
          <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            <WorkerBadge agent={item.agent} label={profileLabel} />
            <span aria-hidden="true">·</span>
            <span>Tool activity</span>
          </div>
          <ToolBlock item={item} />
        </div>
      );

    case 'notice':
      return (
        <div
          className={cn(
            'flex min-w-0 items-start gap-2 rounded-md border px-3 py-[var(--density-transcript-row-padding)] text-xs',
            item.level === 'error'
              ? 'border-state-failed-border bg-state-failed-surface text-state-failed'
              : 'border-border bg-surface-subtle text-muted-foreground',
          )}
        >
          {item.level === 'error' ? (
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <span className="min-w-0 whitespace-pre-wrap break-words">{item.text}</span>
        </div>
      );

    default:
      return null;
  }
}

function ThinkingIndicator(): React.JSX.Element {
  return (
    <div role="status" className="flex items-center gap-1.5 py-1 text-state-busy">
      <span className="sr-only">Working</span>
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
