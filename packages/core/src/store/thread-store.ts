import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  AdapterEvent,
  AgentId,
  HarnessEvent,
  ThreadSummary,
  TransitionEvaluation,
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

export interface ExpectedTransitionAttempt {
  transitionId: string;
  attempt: number;
}

export interface CompareAndAppendEntry {
  agent: AgentId | null;
  body: AdapterEvent;
}

/** The canonical log view supplied to an evaluation CAS builder while the disk lock is held. */
export interface CanonicalThreadLog {
  readonly threadId: string;
  readonly revision: number;
  readonly events: readonly HarnessEvent[];
  readonly latestAttempt: (transitionId: string) => number | null;
}

export interface EvaluationBatchBuild<T> {
  entries: readonly CompareAndAppendEntry[];
  value: T;
}

/** Build and persist one new accepted evaluation from the canonical locked log. */
export interface EvaluationBatchRequest<T> {
  transitionId: string;
  /** The latest accepted attempt before the new evaluation; zero means a new identity. */
  expectedAttempt: number;
  build: (canonical: CanonicalThreadLog) => EvaluationBatchBuild<T>;
}

export interface EvaluationBatchResult<T> {
  events: HarnessEvent[];
  value: T;
}

/** A lock could not be acquired or could not be released safely. */
export class ThreadStoreLockError extends Error {
  constructor(threadId: string, cause?: unknown) {
    super(`The append lock for thread ${threadId} is unavailable; the write was refused.`, { cause });
    this.name = 'ThreadStoreLockError';
  }
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

  /** Reload one canonical thread under the same lock used for writes. */
  refresh(threadId: string): number {
    return this.#withThreadLock(threadId, () => {
      this.#reloadThreadFromDisk(threadId);
      return this.head(threadId);
    });
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
    return this.#withThreadLock(threadId, () => {
      // Ordinary events also cross process boundaries. Do not let a stale instance reuse
      // the last sequence it saw before acquiring the reservation.
      this.#reloadThreadFromDisk(threadId);
      return this.#appendUnlocked(threadId, agent, body);
    });
  }

  #appendUnlocked(threadId: string, agent: AgentId | null, body: AdapterEvent): HarnessEvent {
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

    this.#appendDurably(this.#eventsPath(threadId), `${JSON.stringify(event)}\n`);
    events.push(event);
    this.#events.set(threadId, events);

    summary.eventCount = events.length;
    summary.updatedAt = this.#tick();
    this.#writeMeta(summary);

    // Never hand out the live object kept by the append-only log. A caller can inspect the
    // stamped result, but cannot mutate what the next branded snapshot will read.
    return freezeClone(event);
  }

  /**
   * Compare-and-append one event against the current log head.
   *
   * Recovery reservations use this synchronous boundary instead of a process-local
   * register: two callers can both read the same refusal, but only the caller whose
   * expected head still matches may append the correction reservation.
   */
  compareAndAppend(
    threadId: string,
    expectedHead: number,
    agent: AgentId | null,
    body: AdapterEvent,
    expectedAttempt?: ExpectedTransitionAttempt,
  ): HarnessEvent | null {
    const events = this.compareAndAppendBatch(threadId, expectedHead, [{ agent, body }], expectedAttempt);
    return events?.[0] ?? null;
  }

  /**
   * Compare-and-append one or more events under one same-filesystem exclusive lock.
   *
   * The lock is coordination only. The event log remains the recovery truth. Reloading
   * from disk while holding it is required because another process may have advanced the
   * log since this store instance last read it.
   */
  compareAndAppendBatch(
    threadId: string,
    expectedHead: number,
    entries: readonly CompareAndAppendEntry[],
    expectedAttempt?: ExpectedTransitionAttempt,
  ): HarnessEvent[] | null;
  compareAndAppendBatch<T>(
    threadId: string,
    expectedHead: number,
    request: EvaluationBatchRequest<T>,
  ): EvaluationBatchResult<T> | null;
  compareAndAppendBatch(
    threadId: string,
    expectedHead: number,
    entries: readonly CompareAndAppendEntry[] | EvaluationBatchRequest<unknown>,
    expectedAttempt?: ExpectedTransitionAttempt,
  ): HarnessEvent[] | EvaluationBatchResult<unknown> | null {
    return this.#withThreadLock(threadId, () => {
      this.#reloadThreadFromDisk(threadId);
      if (this.head(threadId) !== expectedHead) return null;
      if (isEvaluationBatchRequest(entries)) {
        const request = entries;
        if (
          request.transitionId.trim() === '' ||
          !Number.isInteger(request.expectedAttempt) ||
          request.expectedAttempt < 0 ||
          typeof request.build !== 'function'
        ) return null;
        const canonical = this.#canonicalLog(threadId);
        if (canonical.latestAttempt(request.transitionId) !== (request.expectedAttempt === 0 ? null : request.expectedAttempt)) {
          return null;
        }
        const built = request.build(canonical);
        if (!this.#validEvaluationBatch(canonical, request, built.entries)) return null;
        const events = built.entries.map((entry) => this.#appendUnlocked(threadId, entry.agent, entry.body));
        return { events, value: built.value };
      }
      if (expectedAttempt !== undefined && !this.#matchesExpectedAttempt(threadId, expectedAttempt)) return null;
      const canonical = this.#canonicalLog(threadId);
      if (this.#containsEvaluation(entries)) {
        if (expectedAttempt === undefined || !this.#validPrebuiltEvaluationBatch(canonical, entries, expectedAttempt)) {
          return null;
        }
      }
      return entries.map((entry) => this.#appendUnlocked(threadId, entry.agent, entry.body));
    });
  }

  update(threadId: string, patch: Partial<ThreadSummary>): ThreadSummary {
    return this.#withThreadLock(threadId, () => {
      this.#reloadThreadFromDisk(threadId);
      const summary = this.#summaries.get(threadId);
      if (!summary) throw new Error(`Unknown thread ${threadId}`);
      const next: ThreadSummary = { ...summary, ...patch, id: threadId, updatedAt: this.#tick() };
      this.#summaries.set(threadId, next);
      this.#writeMeta(next);
      return next;
    });
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

  #lockPath(threadId: string): string {
    return join(this.#dir(threadId), '.events.lock');
  }

  #withThreadLock<T>(threadId: string, callback: () => T): T {
    if (!this.#summaries.has(threadId) && !existsSync(this.#metaPath(threadId))) {
      throw new Error(`Unknown thread ${threadId}`);
    }

    const lockPath = this.#lockPath(threadId);
    let acquired = false;
    try {
      // mkdir is an atomic same-filesystem operation. We intentionally do not reclaim an
      // existing directory: a stale or uncertain owner must fail closed, not fork history.
      mkdirSync(lockPath);
      acquired = true;
      const ownerPath = join(lockPath, 'owner');
      const fd = openSync(ownerPath, 'wx');
      try {
        writeSync(fd, `${process.pid}\n`, undefined, 'utf8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return callback();
    } catch (error) {
      if (!acquired) throw new ThreadStoreLockError(threadId, error);
      throw error;
    } finally {
      if (acquired) {
        try {
          rmSync(lockPath, { recursive: true, force: false });
        } catch (error) {
          throw new ThreadStoreLockError(threadId, error);
        }
      }
    }
  }

  #appendDurably(path: string, content: string): void {
    const fd = openSync(path, 'a');
    try {
      writeSync(fd, content, undefined, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  #matchesExpectedAttempt(threadId: string, expected: ExpectedTransitionAttempt): boolean {
    const attempts = this.#attempts(this.#events.get(threadId) ?? [], expected.transitionId);
    return expected.attempt === 0
      ? attempts.length === 0
      : attempts.length === expected.attempt && attempts.every((attempt, index) => attempt === index + 1);
  }

  #canonicalLog(threadId: string): CanonicalThreadLog {
    const events = Object.freeze((this.#events.get(threadId) ?? []).map((event) => freezeClone(event)));
    return {
      threadId,
      revision: this.head(threadId),
      events,
      latestAttempt: (transitionId) => this.#latestAttempt(events, transitionId),
    };
  }

  #latestAttempt(events: readonly HarnessEvent[], transitionId: string): number | null {
    const attempts = this.#attempts(events, transitionId);
    if (attempts.some((attempt, index) => attempt !== index + 1)) return null;
    return attempts.at(-1) ?? null;
  }

  #containsEvaluation(entries: readonly CompareAndAppendEntry[]): boolean {
    return entries.some((entry) => evaluationFromBody(entry.body) !== null);
  }

  #validPrebuiltEvaluationBatch(
    canonical: CanonicalThreadLog,
    entries: readonly CompareAndAppendEntry[],
    expected: ExpectedTransitionAttempt,
  ): boolean {
    const evaluations = entries
      .map((entry) => evaluationFromBody(entry.body))
      .filter((evaluation): evaluation is TransitionEvaluation => evaluation !== null);
    return evaluations.length === 1 && this.#validEvaluation(canonical, evaluations[0]!, expected.transitionId, expected.attempt);
  }

  #validEvaluationBatch<T>(
    canonical: CanonicalThreadLog,
    request: EvaluationBatchRequest<T>,
    entries: readonly CompareAndAppendEntry[],
  ): boolean {
    const evaluations = entries
      .map((entry) => evaluationFromBody(entry.body))
      .filter((evaluation): evaluation is TransitionEvaluation => evaluation !== null);
    return evaluations.length === 1 && this.#validEvaluation(
      canonical,
      evaluations[0]!,
      request.transitionId,
      request.expectedAttempt,
    );
  }

  #validEvaluation(
    canonical: CanonicalThreadLog,
    evaluation: TransitionEvaluation,
    transitionId: string,
    expectedAttempt: number,
  ): boolean {
    if (evaluation.transitionId !== transitionId) return false;
    if (evaluation.attempt !== expectedAttempt + 1) return false;
    const priorAttempts = this.#attempts(canonical.events, transitionId);
    if (
      (expectedAttempt === 0 && priorAttempts.length !== 0) ||
      (expectedAttempt > 0 && (
        priorAttempts.length !== expectedAttempt ||
        priorAttempts.some((attempt, index) => attempt !== index + 1)
      ))
    ) return false;
    if (canonical.latestAttempt(transitionId) !== (expectedAttempt === 0 ? null : expectedAttempt)) return false;
    for (const event of canonical.events) {
      const prior = evaluationFromEvent(event);
      if (prior?.transitionId === transitionId && prior.attempt === evaluation.attempt) return false;
    }
    return true;
  }

  #attempts(events: readonly HarnessEvent[], transitionId: string): number[] {
    return events
      .map((event) => evaluationFromEvent(event))
      .filter((evaluation): evaluation is TransitionEvaluation => evaluation?.transitionId === transitionId)
      .map((evaluation) => evaluation.attempt);
  }

  #writeMeta(summary: ThreadSummary): void {
    const target = this.#metaPath(summary.id);
    const temporary = join(this.#dir(summary.id), `.meta-${process.pid}-${randomUUID()}.tmp`);
    let fd: number | null = null;
    try {
      fd = openSync(temporary, 'wx');
      writeSync(fd, JSON.stringify(summary, null, 2), undefined, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(temporary, target);
    } finally {
      if (fd !== null) closeSync(fd);
      if (existsSync(temporary)) rmSync(temporary, { force: true });
    }
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

  #loadThread(id: string, strict = false): void {
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
    if (!strict) summary.parallel = false;

    const events: HarnessEvent[] = [];
    const eventsPath = this.#eventsPath(id);
    if (existsSync(eventsPath)) {
      const raw = readFileSync(eventsPath, 'utf8');
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue;
        try {
          events.push(JSON.parse(line) as HarnessEvent);
        } catch {
          if (strict) throw new Error(`Thread ${id} has an incomplete or corrupt event line.`);
          // A torn final line is the expected shape of a crash mid-append. Drop it and
          // keep every complete event before it.
          log.warn('dropping malformed event line', { id });
        }
      }
    }

    if (strict) {
      let previousSeq = 0;
      const ids = new Set<string>();
      for (const event of events) {
        if (event.threadId !== id || !Number.isInteger(event.seq) || event.seq <= previousSeq || ids.has(event.id)) {
          throw new Error(`Thread ${id} has a non-canonical event sequence.`);
        }
        previousSeq = event.seq;
        ids.add(event.id);
      }
    }

    summary.eventCount = events.length;
    // Carry the clock past anything already on disk, so a restart can't hand out a
    // stamp that sorts below an existing thread.
    this.#lastStamp = Math.max(this.#lastStamp, summary.updatedAt);
    this.#summaries.set(id, summary);
    this.#events.set(id, events);
  }

  #reloadThreadFromDisk(threadId: string): void {
    this.#loadThread(threadId, true);
    if (!this.#summaries.has(threadId)) throw new Error(`Unknown thread ${threadId}`);
  }
}

function evaluationFromBody(body: AdapterEvent): TransitionEvaluation | null {
  if (body.kind === 'transition.evaluated') return body.evaluation;
  if (body.kind === 'gate.evaluated') return body.evaluation ?? null;
  return null;
}

function isEvaluationBatchRequest(
  value: readonly CompareAndAppendEntry[] | EvaluationBatchRequest<unknown>,
): value is EvaluationBatchRequest<unknown> {
  return !Array.isArray(value);
}

function evaluationFromEvent(event: HarnessEvent): TransitionEvaluation | null {
  if (event.kind === 'transition.evaluated') return event.evaluation;
  if (event.kind === 'gate.evaluated') return event.evaluation ?? null;
  return null;
}
