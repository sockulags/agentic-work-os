import { PINNED_CONTEXT_MAX_CHARS } from '@awos/protocol';
import { useHarnessContext } from '@/state/HarnessContext';
import type { PinnedContextSave } from '@/hooks/useHarness';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { ReviewState } from '@/components/review/ReviewPatterns';

/** Where "you have room" turns into "you are about to run out". */
const WARN_FRACTION = 0.9;

/**
 * Standing notes for the thread, carried into every turn's prompt.
 *
 * The counterpart to the transcript: things worth telling the agent once rather than
 * repeating in each message. Deliberately stateless — the text and how far it has got
 * towards the disk both live in the harness, so switching to another dock tab and back
 * is not an event this panel can lose anything to.
 */
export function ContextTab(): React.JSX.Element {
  const { activeThreadId, pinnedContext, editPinnedContext } = useHarnessContext();

  if (activeThreadId === null) {
    return (
      <div className="space-y-1 px-4 py-3 text-xs">
        <ReviewState state="idle" label="No thread selected" />
        <p className="text-muted-foreground">Open a thread to pin context to it.</p>
      </div>
    );
  }

  // A thread is open but its notes have not arrived. Editing now would mean typing over
  // text we have not seen yet, so the box waits.
  if (pinnedContext === null || pinnedContext.threadId !== activeThreadId) {
    return (
      <div className="space-y-1 px-4 py-3 text-xs">
        <ReviewState state="busy" />
        <p className="text-muted-foreground">Loading notes…</p>
      </div>
    );
  }

  const used = pinnedContext.text.length;
  const over = used - PINNED_CONTEXT_MAX_CHARS;
  const nearLimit = used >= PINNED_CONTEXT_MAX_CHARS * WARN_FRACTION;

  return (
    <div className="flex h-full flex-col gap-2 px-4 py-3">
      <p className="text-xs text-muted-foreground">
        Notes for this thread. Every turn carries them, whichever agent takes it.
      </p>

      {/*
        No `maxLength`: the browser enforces it by silently dropping the tail of a paste.
        Everything typed here is saved whatever its length; going over the budget costs
        the tail of the *prompt*, which the counter below says plainly.
      */}
      <Textarea
        value={pinnedContext.text}
        spellCheck={false}
        aria-label="Pinned context"
        placeholder={
          'Conventions, gotchas, links, names — anything you would otherwise retype every message.'
        }
        onChange={(event) => editPinnedContext(event.target.value)}
        className="awos-scroll min-h-0 flex-1 font-mono text-xs leading-relaxed"
      />

      <div className="flex items-center justify-between gap-2 text-[10px] tabular-nums">
        <span
          className={cn(
            'text-muted-foreground',
            nearLimit && 'text-state-stale',
            over > 0 && 'text-state-failed',
          )}
        >
          {used.toLocaleString()} / {PINNED_CONTEXT_MAX_CHARS.toLocaleString()} characters
          {over > 0
            ? ` — ${over.toLocaleString()} over the prompt budget; the tail is not sent`
            : nearLimit
              ? ' — close to the prompt budget'
              : ''}
        </span>
        <SaveIndicator state={pinnedContext.save} />
      </div>
    </div>
  );
}

function SaveIndicator({ state }: { state: PinnedContextSave }): React.JSX.Element {
  const label =
    state === 'saved'
      ? 'Saved'
      : state === 'saving'
        ? 'Saving…'
        : state === 'unsaved'
          ? 'Unsaved'
          : 'Save failed';

  return (
    <span
      role="status"
      className={cn(
        'shrink-0',
        state === 'saved'
          ? 'text-state-passed'
          : state === 'saving'
            ? 'text-state-busy'
            : state === 'unsaved'
              ? 'text-state-stale'
              : 'text-state-failed',
      )}
    >
      {label}
    </span>
  );
}
