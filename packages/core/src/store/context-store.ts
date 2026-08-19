import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PINNED_CONTEXT_MAX_CHARS } from '@awos/protocol';
import { createLogger } from '../util/logger.js';

const log = createLogger('context');

/**
 * Standing per-thread notes the user writes once and every turn carries.
 *
 * Stored as plain `context.md` beside `events.jsonl` rather than inside the event log,
 * because it is a mutable document rather than something that happened: the log is
 * append-only and would accumulate a full copy per keystroke-batch, and replaying it to
 * find the current text would be the wrong shape for a value that is only ever "latest".
 * A markdown file also means you can edit it from outside the app.
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

  set(threadId: string, text: string): void {
    if (text.length > PINNED_CONTEXT_MAX_CHARS) {
      throw new Error(
        `Pinned context is ${text.length} characters, over the ${PINNED_CONTEXT_MAX_CHARS} limit.`,
      );
    }
    // Refusing rather than truncating: silently dropping the tail would lose the user's
    // words without telling them. The editor caps input, so this is a backstop.
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
 * document, no turn boundaries — so an oversized one is cut at the limit and says so,
 * which only happens when the file was edited outside the app past what `set` allows.
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
