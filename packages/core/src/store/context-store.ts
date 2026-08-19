import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../util/logger.js';

const log = createLogger('context');

/**
 * Standing per-thread notes the user writes once and every turn carries.
 *
 * Stored as plain `context.md` beside `events.jsonl` rather than inside the event log,
 * because it is a mutable document rather than something that happened: the log is
 * append-only and would accumulate a full copy per keystroke-batch, and replaying it to
 * find the current text would be the wrong shape for a value that is only ever "latest".
 * A markdown file also means you can edit it from outside the app: every turn re-reads
 * the file, and reopening the thread pulls the new text into the editor. Writes are
 * last-one-wins, so an outside edit made while the editor holds unsaved text is the one
 * case that loses — a single-writer document with a single-user app behind it.
 *
 * Writes are synchronous, for the same reason `ThreadStore`'s are.
 */
export class ContextStore {
  readonly #root: string;

  constructor(dataDir: string) {
    this.#root = join(dataDir, 'threads');
  }

  /** The thread's pinned text, or empty when it has none. */
  get(threadId: string): string {
    const path = this.#path(threadId);
    if (!existsSync(path)) return '';
    try {
      return readFileSync(path, 'utf8');
    } catch (err) {
      // An unreadable notes file must not take the thread down with it; the transcript is
      // the part that matters and it lives in a different file. Logged because the file is
      // meant to be editable from outside the app, and an editor holding a lock on Windows
      // otherwise looks exactly like having written nothing.
      log.error('unreadable pinned context', { threadId, message: (err as Error).message });
      return '';
    }
  }

  /**
   * Store the text verbatim, however long it is.
   *
   * Deliberately not budget-checked: the prompt is protected where it is actually at
   * risk, in `buildPinnedContext`, which cuts an oversized document and says so. Refusing
   * the write instead would leave the user holding text the app won't keep — and every
   * way out of the editor (another tab, another thread, a reload) would then lose it.
   * Saving everything and sending what fits loses nothing and hides nothing.
   */
  set(threadId: string, text: string): void {
    mkdirSync(join(this.#root, threadId), { recursive: true });
    writeFileSync(this.#path(threadId), text, 'utf8');
  }

  #path(threadId: string): string {
    return join(this.#root, threadId, 'context.md');
  }
}

// ---------------------------------------------------------------------------
// Prompt injection
// ---------------------------------------------------------------------------

const OPEN_TAG = '<pinned-context>';
const CLOSE_TAG = '</pinned-context>';

const HEADER =
  'Notes the user pinned to this thread. They apply to every turn, this one included. ' +
  'Treat them as standing instructions and context — not as something to acknowledge or ' +
  'summarize back.';

export interface PinnedContextOptions {
  maxChars: number;
}

/**
 * Render the block that goes at the top of the prompt, or null when there is nothing
 * pinned.
 *
 * Budgeted by characters like the replay block, and for the same reason: this rides on
 * *every* turn, so an unbounded blob would quietly eat the context window that the
 * conversation itself needs. Unlike replay there is nothing to drop selectively — one
 * document, no turn boundaries — so an oversized one is cut at the limit and says so, in
 * the block itself so the agent knows it is reading a fragment. This is the only place
 * the budget is enforced: the store keeps whatever the user wrote, and the editor warns
 * long before the tail starts going missing.
 */
export function buildPinnedContext(
  text: string,
  options: PinnedContextOptions,
): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  const body =
    trimmed.length <= options.maxChars
      ? trimmed
      : `${trimmed.slice(0, options.maxChars)}\n\n_[cut here: pinned context exceeded its ${options.maxChars}-character budget]_`;

  return [OPEN_TAG, HEADER, body, CLOSE_TAG].join('\n\n');
}

/**
 * Prepend the block to a prompt.
 *
 * Ahead of the replay preamble, because it frames how everything after it should be
 * read — including the replayed history.
 */
export function applyPinnedContext(block: string | null, text: string): string {
  return block === null ? text : `${block}\n\n${text}`;
}
