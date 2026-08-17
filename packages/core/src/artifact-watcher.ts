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

  #schedule(): void {
    if (this.#stopped || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#sweep();
    }, this.#debounceMs);
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

    const present = new Set<string>();
    for (const name of listArtifactFiles(this.#dir)) {
      const body = readArtifact(this.#dir, name);
      // Unreadable and oversize files stay unknown, so a later shrink or unlock still
      // publishes them.
      if (!body) continue;
      present.add(name);

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
      log.debug('artifact watch failed', { target, message: (err as Error).message });
      this.#detach();
    }
  }

  #detach(): void {
    this.#watcher?.removeAllListeners();
    this.#watcher?.close();
    this.#watcher = null;
    this.#watching = null;
  }
}
