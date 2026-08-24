import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AdapterEvent,
  AgentId,
  HarnessEvent,
  ThreadSummary,
} from '@awos/protocol';
import { AGENT_IDS, isTrustedVisualEventKind } from '@awos/protocol';
import { createLogger } from '../util/logger.js';

const log = createLogger('store');

/**
 * A read-only view of one append-only thread log at one store revision.
 *
 * The structural type is intentionally not the authority. Runtime authority is the
 * module-private brand and state below; only ThreadStore.snapshot can create a value that
 * passes the visual evaluator boundary.
 */
export interface EventLogSnapshot {
  readonly threadId: string;
  readonly revision: number;
  readonly events: readonly HarnessEvent[];
}

const eventLogSnapshotBrand = new WeakSet<object>();
const eventLogSnapshotState = new WeakMap<object, { store: ThreadStore; threadId: string; revision: number }>();
const trustedThreadContextBrand = new WeakSet<object>();
const trustedThreadContextState = new WeakMap<object, {
  store: ThreadStore;
  threadId: string;
  snapshot: EventLogSnapshot;
}>();
let activeTrustedThreadContext: object | null = null;

export function isEventLogSnapshot(value: unknown): value is EventLogSnapshot {
  return typeof value === 'object' && value !== null && eventLogSnapshotBrand.has(value);
}

/** A snapshot is usable for trust decisions only until its store head advances. */
export function isCurrentEventLogSnapshot(value: unknown): value is EventLogSnapshot {
  if (!isEventLogSnapshot(value)) return false;
  const state = eventLogSnapshotState.get(value);
  return state !== undefined &&
    state.store.get(state.threadId) !== undefined &&
    state.store.head(state.threadId) === state.revision;
}

/** Resolve the private owner context used by internal visual evaluation only. */
function trustedSnapshotForThreadContext(value: unknown): EventLogSnapshot | null {
  if (typeof value !== 'object' || value === null || !trustedThreadContextBrand.has(value)) return null;
  const state = trustedThreadContextState.get(value);
  if (
    state === undefined ||
    state.snapshot.threadId !== state.threadId ||
    !isCurrentEventLogSnapshot(state.snapshot) ||
    state.store.get(state.threadId) === undefined
  ) return null;
  return state.snapshot;
}

/** Resolve the context currently held by a synchronous store-owned evaluation. */
export function trustedSnapshotForActiveThreadContext(): EventLogSnapshot | null {
  return trustedSnapshotForThreadContext(activeTrustedThreadContext);
}

function freezeClone<T>(value: T): T {
  const clone = JSON.parse(JSON.stringify(value)) as T;
  return deepFreeze(clone);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

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
    return (this.#events.get(threadId) ?? []).map((event) => freezeClone(event));
  }

  /**
   * Capture the current append-only log through the store-owned trust boundary.
   *
   * Events are cloned before freezing so callers cannot mutate either the snapshot or
   * the store's live records. A later append makes this view stale; callers must fetch a
   * new snapshot before evaluating visual evidence.
   */
  snapshot(threadId: string): EventLogSnapshot {
    if (!this.#summaries.has(threadId)) throw new Error(`Unknown thread ${threadId}`);
    const revision = this.head(threadId);
    const events = Object.freeze((this.#events.get(threadId) ?? []).map((event) => freezeClone(event)));
    const snapshot = Object.freeze({ threadId, revision, events }) as EventLogSnapshot;
    eventLogSnapshotBrand.add(snapshot);
    eventLogSnapshotState.set(snapshot, { store: this, threadId, revision });
    return snapshot;
  }

  /**
   * Run an internal owner-bound evaluation with a fresh, opaque context.
   *
   * The callback receives no snapshot or thread id. Only code holding this module's
   * private context brand can resolve the snapshot, which prevents a caller from pairing
   * a visual request with another store or thread.
   */
  withTrustedThreadContext<T>(threadId: string, callback: () => T): T {
    if (typeof callback !== 'function') throw new TypeError('A trusted thread callback is required.');
    const snapshot = this.snapshot(threadId);
    const context = Object.freeze({});
    trustedThreadContextBrand.add(context);
    trustedThreadContextState.set(context, { store: this, threadId, snapshot });
    const previous = activeTrustedThreadContext;
    activeTrustedThreadContext = context;
    try {
      return callback();
    } finally {
      activeTrustedThreadContext = previous;
    }
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
    return [...this.#events.values()].flatMap((events) => events.map((event) => freezeClone(event)));
  }

  /** Events after `seq`, in order. The basis of replay. */
  eventsSince(threadId: string, seq: number): HarnessEvent[] {
    return this.events(threadId).filter((event) => event.seq > seq);
  }

  head(threadId: string): number {
    const events = this.#events.get(threadId) ?? [];
    return events.length === 0 ? 0 : (events[events.length - 1] as HarnessEvent).seq;
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  create(options: { cwd: string; title?: string; agent?: AgentId; workItemId?: string | null }): ThreadSummary {
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
      watermarks: Object.fromEntries(AGENT_IDS.map((agent) => [agent, 0])) as Record<AgentId, number>,
      eventCount: 0,
      workItemId: options.workItemId ?? null,
      parallel: false,
    };

    try {
      mkdirSync(this.#dir(id), { recursive: true });
      this.#summaries.set(id, summary);
      this.#events.set(id, []);
      this.#writeMeta(summary);
    } catch (error) {
      this.#summaries.delete(id);
      this.#events.delete(id);
      rmSync(this.#dir(id), { recursive: true, force: true });
      throw error;
    }
    return summary;
  }

  /** Stamp identity and ordering onto an adapter event, persist, return it. */
  append(threadId: string, agent: AgentId | null, body: AdapterEvent): HarnessEvent {
    const summary = this.#summaries.get(threadId);
    if (!summary) throw new Error(`Unknown thread ${threadId}`);
    if (agent !== null && (
      (body.kind === 'evidence.recorded' && body.visual !== undefined) ||
      isTrustedVisualEventKind(body.kind)
    )) {
      throw new Error('Visual evidence can only be recorded by a trusted core adapter.');
    }

    const events = this.#events.get(threadId) ?? [];
    const { turnId, ts, ...rest } = body;

    const event = freezeClone({
      ...rest,
      id: randomUUID(),
      seq: this.head(threadId) + 1,
      threadId,
      agent,
      turnId: turnId ?? null,
      ts: ts ?? Date.now(),
    }) as HarnessEvent;

    events.push(event);
    this.#events.set(threadId, events);
    appendFileSync(this.#eventsPath(threadId), `${JSON.stringify(event)}\n`, 'utf8');

    summary.eventCount = events.length;
    summary.updatedAt = this.#tick();
    this.#writeMeta(summary);

    // Never hand out the live object kept by the append-only log. A caller can inspect the
    // stamped result, but cannot mutate what the next branded snapshot will read.
    return freezeClone(event);
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

  /** Drop a proven-stale native session and make the next turn replay from the log head. */
  clearNativeSession(threadId: string, agent: AgentId): void {
    const summary = this.#summaries.get(threadId);
    if (!summary) return;
    const nativeSessions = { ...summary.nativeSessions };
    delete nativeSessions[agent];
    this.update(threadId, {
      nativeSessions,
      watermarks: { ...summary.watermarks, [agent]: 0 },
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
    summary.watermarks ??= Object.fromEntries(AGENT_IDS.map((agent) => [agent, 0])) as Record<AgentId, number>;
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
