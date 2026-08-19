import { useEffect, useRef, useState } from 'react';
import { Brain, ChevronRight } from 'lucide-react';
import { useDisplaySettings, type Density } from '@/state/DisplaySettingsContext';
import { cn } from '@/lib/utils';

/**
 * What density says about reasoning, kept apart from the component so the contract can
 * be read — and tested — without a DOM.
 */
export function reasoningVisibility(density: Density): 'hidden' | 'collapsed' | 'expanded' {
  if (density === 'compact') return 'hidden';
  return density === 'verbose' ? 'expanded' : 'collapsed';
}

export function formatThinkingLabel(durationMs: number | null): string {
  if (durationMs === null) return 'Thought';
  if (durationMs < 1000) return 'Thought for <1s';
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `Thought for ${seconds}s`;
  return `Thought for ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * Reasoning, reduced to one discreet line.
 *
 * Deliberately quieter than an answer: it is context for how the agent got somewhere,
 * not the thing the reader came for. The duration is measured here rather than carried
 * on the event stream — the fold gives us the first delta's timestamp and a streaming
 * flag, and the moment the flag clears is the completion. A block that was already
 * complete when it first rendered (a thread replayed after a reload) has no measurable
 * end, so it drops the duration instead of inventing one.
 */
export function ReasoningBlock({
  text,
  streaming,
  startedAt,
}: {
  text: string;
  streaming: boolean;
  startedAt: number;
}): React.JSX.Element | null {
  const { density } = useDisplaySettings();
  const visibility = reasoningVisibility(density);

  // Clamped against the client clock: the timestamp is stamped by the core process, and
  // a skewed clock would otherwise report a thought that started in the future.
  const startRef = useRef(Math.min(startedAt, Date.now()));
  const observedStreamingRef = useRef(false);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [open, setOpen] = useState(visibility === 'expanded');

  useEffect(() => {
    if (streaming) {
      observedStreamingRef.current = true;
      return;
    }
    if (!observedStreamingRef.current) return;
    observedStreamingRef.current = false;
    setDurationMs(Date.now() - startRef.current);
  }, [streaming]);

  // Changing density is an explicit instruction about the whole transcript, so it wins
  // over an earlier toggle on this one block.
  useEffect(() => {
    setOpen(visibility === 'expanded');
  }, [visibility]);

  if (visibility === 'hidden') return null;

  return (
    <div className="text-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="group flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
      >
        <Brain className="h-3 w-3 shrink-0" />
        <span>{streaming ? 'Thinking…' : formatThinkingLabel(durationMs)}</span>
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 opacity-0 transition-all group-hover:opacity-70',
            open && 'rotate-90 opacity-70',
          )}
        />
      </button>
      {open && (
        <pre className="awos-scroll mt-1.5 max-h-80 overflow-auto whitespace-pre-wrap break-words border-l border-border pl-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {text}
        </pre>
      )}
    </div>
  );
}
