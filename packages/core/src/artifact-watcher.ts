import { existsSync, watch, type FSWatcher } from 'node:fs';
import { dirname } from 'node:path';
import type { ArtifactUpdatedBody } from '@awos/protocol';
import {
  artifactsDir,
  contentHash,
  deletedArtifact,
  listArtifactFiles,
  readArtifact,
} from './store/artifact-store.js';
import { createLogger } from './util/logger.js';

/**
 * Turns writes in `<thread.cwd>/.awos/artifacts/` into `artifact.updated` events.
 *
 * This is harness-level, not adapter-level: the watcher cannot tell which agent — or
 * whether a human with an editor — wrote the file, so the events it produces carry
 * `agent: null` like the user's own messages do. That is also what makes the mechanism
 * symmetric across both CLIs without either adapter knowing it exists.
 *
 * Emission is keyed on content, not on file-system activity. `fs.watch` fires two or
 * three times for a single save on Windows, editors touch files they did not change, and
 * a restart re-reads a directory the transcript already describes — hashing what we last
 * emitted collapses all three into silence.
 */

const log = createLogger('artifacts');

/**
 * Long enough to coalesce the burst of events one save produces and to let a large write
 * finish, short enough that the dock feels live. A partial read is self-correcting: the
 * write's own trailing event triggers another sweep, and the final content differs from
 * the partial one, so it is emitted.
 */
const DEBOUNCE_MS = 120;

/**
 * How long to wait before trying again when `fs.watch` itself refuses to attach.
 *
 * Failures like ENOSPC from the inotify watch limit clear up on their own, but only after
 * something else lets go of a handle, so retrying at the debounce interval would spin.
 */
const ATTACH_RETRY_MS = 2_000;

export interface ArtifactWatcherOptions {
  /** The thread's working directory; the artifacts directory hangs off it. */
  cwd: string;
  emit: (body: ArtifactUpdatedBody) => void;
  /**
   * Content hashes already in the transcript, by artifact id. Seeding this is what stops
   * a restart from re-publishing every artifact it finds on disk.
   */
  known?: Map<string, string>;
  debounceMs?: number;
}

export class ArtifactWatcher {
  readonly #dir: string;
  /**
   * Directories to fall back to, nearest first, while the artifacts directory does not
   * exist yet. Watching the closest existing ancestor means the watcher wakes up when
   * the directory is finally created instead of polling for it.
   */
  readonly #ladder: string[];
  readonly #emit: (body: ArtifactUpdatedBody) => void;
  readonly #known: Map<string, string>;
  readonly #debounceMs: number;

  #watcher: FSWatcher | null = null;
  #watching: string | null = null;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(options: ArtifactWatcherOptions) {
    this.#dir = artifactsDir(options.cwd);
    this.#ladder = [this.#dir, dirname(this.#dir), options.cwd];
    this.#emit = options.emit;
    this.#known = options.known ?? new Map();
    this.#debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  }

  /** Attach and sweep once, so artifacts written while the harness was down are picked up. */
  start(): void {
    this.#stopped = false;
    this.#schedule();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#detach();
  }

  // -------------------------------------------------------------------------

  #schedule(delayMs = this.#debounceMs): void {
    if (this.#stopped || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#sweep();
    }, delayMs);
  }

  /**
   * Re-read the whole directory rather than trusting the changed file name.
   *
   * `fs.watch` reports a name on some platforms and null on others, coalesces renames
   * into a single event, and never reports a file removed while the process was busy. A
   * full listing of a directory holding a handful of documents costs nothing and is the
   * only version that cannot drift from what is on disk.
   */
  #sweep(): void {
    if (this.#stopped) return;
    this.#attach();
    if (this.#watching !== this.#dir) return;

    const names = listArtifactFiles(this.#dir);
    // A directory we failed to read is not an empty directory. Treating it as one would
    // append a deletion for every artifact at once, and the log cannot take that back.
    if (names === null) return;

    const present = new Set<string>();
    for (const name of names) {
      // Presence is decided by the listing, not by the read: a file we cannot read is
      // still on disk, and retiring it would tell consumers a document was deleted while
      // it sits there. Unreadable and oversize files stay unknown instead, so a later
      // shrink or unlock still publishes them.
      present.add(name);

      const body = readArtifact(this.#dir, name);
      if (!body) continue;

      if (body.content === '') {
        // Empty content is how a deletion is spelled, so an empty file cannot be
        // published as itself: consumers would fold it as deleted, and because the fold
        // retires tombstoned ids, every restart would emit the event again. Emptying an
        // artifact we did publish is a real retirement, and that one is worth an event.
        if (this.#known.delete(name)) this.#emit(deletedArtifact(this.#dir, name));
        continue;
      }

      const hash = contentHash(body.content);
      if (this.#known.get(name) === hash) continue;
      this.#known.set(name, hash);
      this.#emit(body);
    }

    for (const name of [...this.#known.keys()]) {
      if (present.has(name)) continue;
      this.#known.delete(name);
      this.#emit(deletedArtifact(this.#dir, name));
    }
  }

  #attach(): void {
    const target = this.#ladder.find((candidate) => existsSync(candidate)) ?? null;
    if (target === null || target === this.#watching) return;

    this.#detach();
    try {
      // `persistent: false` because artifacts must never be the reason the daemon stays
      // alive; the socket server owns process lifetime.
      this.#watcher = watch(target, { persistent: false }, () => this.#schedule());
      this.#watcher.on('error', (err) => {
        // The directory was removed or replaced underneath us. Drop down the ladder.
        log.debug('artifact watch failed', { target, message: err.message });
        this.#detach();
        this.#schedule();
      });
      this.#watching = target;
      log.debug('watching for artifacts', { target, live: target === this.#dir });
    } catch (err) {
      // Retry rather than just giving up: the failed attach left no handle to wake us,
      // and the sweep that called this has already cleared its timer, so returning here
      // would make the thread deaf to artifacts for the rest of the process lifetime.
      log.debug('artifact watch failed', { target, message: (err as Error).message });
      this.#detach();
      this.#schedule(ATTACH_RETRY_MS);
    }
  }

  #detach(): void {
    this.#watcher?.removeAllListeners();
    this.#watcher?.close();
    this.#watcher = null;
    this.#watching = null;
  }
}
