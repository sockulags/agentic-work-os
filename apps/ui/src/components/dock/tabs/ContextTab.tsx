import { useCallback, useEffect, useRef, useState } from 'react';
import { PINNED_CONTEXT_MAX_CHARS } from '@awos/protocol';
import { useHarnessContext } from '@/state/HarnessContext';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * Long enough that a burst of typing is one write, short enough that you never wonder
 * whether it took.
 *
 * Saving per keystroke would put a socket round trip and a synchronous file write behind
 * every character; a save button is a thing you forget and then lose. Debounce plus a
 * visible state is the pair that has neither failure mode — and because the indicator
 * would be a lie if it could go stale, the same save also fires on blur and when the tab
 * stops looking at this thread.
 */
const SAVE_DEBOUNCE_MS = 600;

/** Where "you have room" turns into "you are about to run out". */
const WARN_FRACTION = 0.9;

type SaveState = 'saved' | 'unsaved' | 'saving' | 'failed';

/**
 * Standing notes for the thread, carried into every turn's prompt.
 *
 * The counterpart to the transcript: things worth telling the agent once rather than
 * repeating in each message.
 */
export function ContextTab(): React.JSX.Element {
  const { pinnedContext, savePinnedContext } = useHarnessContext();
  const threadId = pinnedContext?.threadId ?? null;

  const [draft, setDraft] = useState('');
  const [state, setState] = useState<SaveState>('saved');

  const remoteRef = useRef(pinnedContext);
  remoteRef.current = pinnedContext;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const stateRef = useRef(state);
  stateRef.current = state;

  const flush = useCallback(
    async (target: string) => {
      // A failed save is retryable, not final: blur, leaving the thread, and the next
      // keystroke all get another go, so one dropped socket doesn't strand the text.
      if (stateRef.current !== 'unsaved' && stateRef.current !== 'failed') return;
      const text = draftRef.current;
      if (text.length > PINNED_CONTEXT_MAX_CHARS) return;

      setState('saving');
      try {
        await savePinnedContext(target, text);
      } catch {
        if (remoteRef.current?.threadId === target) setState('failed');
        return;
      }
      // A save can outlive the thread it belonged to. Once the editor has moved on, the
      // new thread owns the indicator and this result says nothing about it.
      if (remoteRef.current?.threadId !== target) return;
      // Anything typed while the write was in flight is still unsaved, so the indicator
      // must not claim otherwise.
      setState(draftRef.current === text ? 'saved' : 'unsaved');
    },
    [savePinnedContext],
  );

  /**
   * Adopt the thread's stored text when the thread changes — and only then. A reply for
   * the thread already on screen (a reconnect refetch, or our own save echoing back)
   * must leave the cursor and any unsaved keystrokes alone.
   */
  useEffect(() => {
    setDraft(remoteRef.current?.text ?? '');
    setState('saved');
    return () => {
      if (threadId !== null) void flush(threadId);
    };
  }, [threadId, flush]);

  useEffect(() => {
    if (state !== 'unsaved' || threadId === null) return;
    const timer = window.setTimeout(() => void flush(threadId), SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, state, threadId, flush]);

  if (pinnedContext === null) {
    return (
      <p className="px-4 py-3 text-xs text-muted-foreground">
        Open a thread to pin context to it.
      </p>
    );
  }

  const used = draft.length;
  const over = used - PINNED_CONTEXT_MAX_CHARS;
  const nearLimit = used >= PINNED_CONTEXT_MAX_CHARS * WARN_FRACTION;

  return (
    <div className="flex h-full flex-col gap-2 px-4 py-3">
      <p className="text-xs text-muted-foreground">
        Notes for this thread. Every turn carries them, whichever agent takes it.
      </p>

      {/*
        No `maxLength`: the browser enforces it by silently dropping the tail of a paste,
        which is exactly the "lose the user's words without telling them" the store
        refuses to do. Over-budget text stays in the box, visibly unsaved, until trimmed.
      */}
      <Textarea
        value={draft}
        spellCheck={false}
        aria-label="Pinned context"
        placeholder={
          'Conventions, gotchas, links, names — anything you would otherwise retype every message.'
        }
        onChange={(event) => {
          setDraft(event.target.value);
          setState('unsaved');
        }}
        onBlur={() => void flush(pinnedContext.threadId)}
        className="awos-scroll min-h-0 flex-1 font-mono text-xs leading-relaxed"
      />

      <div className="flex items-center justify-between gap-2 text-[10px] tabular-nums">
        <span
          className={cn(
            'text-muted-foreground',
            nearLimit && 'text-amber-500',
            over > 0 && 'text-destructive',
          )}
        >
          {used.toLocaleString()} / {PINNED_CONTEXT_MAX_CHARS.toLocaleString()} characters
          {over > 0
            ? ` — ${over.toLocaleString()} over the prompt budget, trim to save`
            : nearLimit
              ? ' — close to the prompt budget'
              : ''}
        </span>
        <SaveIndicator state={over > 0 ? 'unsaved' : state} />
      </div>
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }): React.JSX.Element {
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
        state === 'failed' ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      {label}
    </span>
  );
}
