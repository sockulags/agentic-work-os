import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AdapterEvent,
  AgentId,
  HarnessEvent,
  ThreadSummary,
} from '@awos/protocol';
import { AGENT_IDS } from '@awos/protocol';
import { createLogger } from '../util/logger.js';

const log = createLogger('store');

/**
 * Append-only transcript store.
 *
 * The canonical record is `events.jsonl`: one HarnessEvent per line, never rewritten.
 * That choice buys three things — crash safety without a transaction log, an ordering
 * authority independent of two concurrent child processes, and a file you can `tail -f`
 * or diff when an adapter misbehaves.
 *
 * Writes are synchronous. At the volume a single human generates this is irrelevant, and
 * it removes a whole class of interleaving bug where two adapters' events land out of
 * order because their write callbacks resolved in the wrong sequence.
 */
export class ThreadStore {
  readonly #root: string;
  readonly #summaries = new Map<string, ThreadSummary>();
  readonly #events = new Map<string, HarnessEvent[]>();
  #lastStamp = 0;

  constructor(dataDir: string) {
    this.#root = join(dataDir, 'threads');
    mkdirSync(this.#root, { recursive: true });
    this.#loadAll();
  }

  /**
   * A strictly increasing wall-clock stamp.
   *
   * `updatedAt` doubles as the sort key for the thread list, and two threads touched in
   * the same millisecond would otherwise tie and order arbitrarily — which shows up as a
   * sidebar that reshuffles when you look away. Nudging forward on collision keeps the
   * value honest as a timestamp while making the ordering total.
   */
  #tick(): number {
    this.#lastStamp = Math.max(Date.now(), this.#lastStamp + 1);
    return this.#lastStamp;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  list(): ThreadSummary[] {
    return [...this.#summaries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(threadId: string): ThreadSummary | undefined {
    return this.#summaries.get(threadId);
  }

  events(threadId: string): HarnessEvent[] {
    return this.#events.get(threadId) ?? [];
  }

  /**
   * Every event in every thread.
   *
   * For the folds that are about something a thread does not own — a work item is picked
   * up again in a new thread, and what earlier ones learned about it has to be findable.
   * The store already holds all of this in memory, so this is a concatenation rather than
   * a read; at one human's volume that is the cheaper half of any alternative index.
   */
  allEvents(): HarnessEvent[] {
    return [...this.#events.values()].flat();
  }

  /** Events after `seq`, in order. The basis of replay. */
  eventsSince(threadId: string, seq: number): HarnessEvent[] {
    return this.events(threadId).filter((event) => event.seq > seq);
  }

  head(threadId: string): number {
    const events = this.events(threadId);
    return events.length === 0 ? 0 : (events[events.length - 1] as HarnessEvent).seq;
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  create(options: { cwd: string; title?: string; agent?: AgentId }): ThreadSummary {
    const id = randomUUID();
    const now = this.#tick();
    const summary: ThreadSummary = {
      id,
      title: options.title?.trim() || 'New thread',
      cwd: options.cwd,
      createdAt: now,
      updatedAt: now,
      activeAgent: options.agent ?? 'claude',
      nativeSessions: {},
      watermarks: { claude: 0, codex: 0 },
      eventCount: 0,
      workItemId: null,
      parallel: false,
    };

    mkdirSync(this.#dir(id), { recursive: true });
    this.#summaries.set(id, summary);
    this.#events.set(id, []);
    this.#writeMeta(summary);
    return summary;
  }

  /** Stamp identity and ordering onto an adapter event, persist, return it. */
  append(threadId: string, agent: AgentId | null, body: AdapterEvent): HarnessEvent {
    const summary = this.#summaries.get(threadId);
    if (!summary) throw new Error(`Unknown thread ${threadId}`);

    const events = this.#events.get(threadId) ?? [];
    const { turnId, ts, ...rest } = body;

    const event = {
      ...rest,
      id: randomUUID(),
      seq: this.head(threadId) + 1,
      threadId,
      agent,
      turnId: turnId ?? null,
      ts: ts ?? Date.now(),
    } as HarnessEvent;

    events.push(event);
    this.#events.set(threadId, events);
    appendFileSync(this.#eventsPath(threadId), `${JSON.stringify(event)}\n`, 'utf8');

    summary.eventCount = events.length;
    summary.updatedAt = this.#tick();
    this.#writeMeta(summary);

    return event;
  }

  update(threadId: string, patch: Partial<ThreadSummary>): ThreadSummary {
    const summary = this.#summaries.get(threadId);
    if (!summary) throw new Error(`Unknown thread ${threadId}`);
    const next: ThreadSummary = { ...summary, ...patch, id: threadId, updatedAt: this.#tick() };
    this.#summaries.set(threadId, next);
    this.#writeMeta(next);
    return next;
  }

  setNativeSession(threadId: string, agent: AgentId, sessionId: string): void {
    const summary = this.#summaries.get(threadId);
    if (!summary) return;
    if (summary.nativeSessions[agent] === sessionId) return;
    this.update(threadId, {
      nativeSessions: { ...summary.nativeSessions, [agent]: sessionId },
    });
  }

  setWatermark(threadId: string, agent: AgentId, seq: number): void {
    const summary = this.#summaries.get(threadId);
    if (!summary) return;
    this.update(threadId, { watermarks: { ...summary.watermarks, [agent]: seq } });
  }

  delete(threadId: string): void {
    this.#summaries.delete(threadId);
    this.#events.delete(threadId);
    rmSync(this.#dir(threadId), { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Disk
  // -------------------------------------------------------------------------

  #dir(threadId: string): string {
    return join(this.#root, threadId);
  }

  #metaPath(threadId: string): string {
    return join(this.#dir(threadId), 'meta.json');
  }

  #eventsPath(threadId: string): string {
    return join(this.#dir(threadId), 'events.jsonl');
  }

  #writeMeta(summary: ThreadSummary): void {
    writeFileSync(this.#metaPath(summary.id), JSON.stringify(summary, null, 2), 'utf8');
  }

  #loadAll(): void {
    let entries: string[];
    try {
      entries = readdirSync(this.#root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return;
    }

    for (const id of entries) {
      try {
        this.#loadThread(id);
      } catch (err) {
        // One corrupt thread must not stop the app from opening the other twenty.
        log.error('skipping unreadable thread', { id, message: (err as Error).message });
      }
    }
    log.info('loaded threads', { count: this.#summaries.size });
  }

  #loadThread(id: string): void {
    const metaPath = this.#metaPath(id);
    if (!existsSync(metaPath)) return;

    const summary = JSON.parse(readFileSync(metaPath, 'utf8')) as ThreadSummary;
    // Defend against meta written by an older build.
    summary.watermarks ??= { claude: 0, codex: 0 };
    for (const agent of AGENT_IDS) summary.watermarks[agent] ??= 0;
    summary.nativeSessions ??= {};
    // Written by a build that had no work items. Null is the same answer as "this thread
    // is not about an issue", so an older thread needs no migration to be readable.
    summary.workItemId ??= null;
    // Lanes are scratch directories that do not survive a restart, so a thread always
    // reopens in the shared directory and the user turns parallel mode back on if they
    // want it. Reopening straight into lanes would point agents at paths that may be gone.
    summary.parallel = false;

    const events: HarnessEvent[] = [];
    const eventsPath = this.#eventsPath(id);
    if (existsSync(eventsPath)) {
      const raw = readFileSync(eventsPath, 'utf8');
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue;
        try {
          events.push(JSON.parse(line) as HarnessEvent);
        } catch {
          // A torn final line is the expected shape of a crash mid-append. Drop it and
          // keep every complete event before it.
          log.warn('dropping malformed event line', { id });
        }
      }
    }

    summary.eventCount = events.length;
    // Carry the clock past anything already on disk, so a restart can't hand out a
    // stamp that sorts below an existing thread.
    this.#lastStamp = Math.max(this.#lastStamp, summary.updatedAt);
    this.#summaries.set(id, summary);
    this.#events.set(id, events);
  }
}
