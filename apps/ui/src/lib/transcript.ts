import type { AgentId, HarnessEvent, ToolKind } from '@awos/protocol';

/**
 * Folds the raw event log into renderable transcript items.
 *
 * The event stream is append-only and fine-grained — hundreds of deltas per message —
 * while the UI wants a handful of stable blocks. This module is the only place that
 * translation happens, which keeps React components dumb and makes the fold testable
 * on its own.
 *
 * Streaming rule: a `*.delta` opens or extends an item and marks it `streaming`; the
 * matching `*.completed` replaces the accumulated text with the authoritative version
 * and clears the flag. Replacing rather than appending matters — the final message is
 * the source of truth, and any dropped or duplicated delta self-corrects there.
 *
 * The fold state is kept alive between calls by `TranscriptFolder` so a delta costs one
 * event instead of a re-run over the whole log; `foldTranscript` remains the reference
 * implementation both paths must agree with. Items are replaced rather than mutated on
 * update, so an item's identity changes only when its content does — which is what lets
 * the renderer skip the expensive parts (markdown, highlighting) for untouched blocks.
 */

export type TranscriptItem =
  | { kind: 'user'; id: string; seq: number; text: string; ts: number }
  | {
      kind: 'message';
      id: string;
      seq: number;
      agent: AgentId;
      text: string;
      streaming: boolean;
      ts: number;
    }
  | {
      kind: 'reasoning';
      id: string;
      seq: number;
      agent: AgentId;
      text: string;
      streaming: boolean;
      ts: number;
    }
  | {
      kind: 'tool';
      id: string;
      seq: number;
      agent: AgentId;
      name: string;
      toolKind: ToolKind;
      title: string;
      input: unknown;
      output: string;
      status: 'running' | 'ok' | 'error' | 'denied' | 'aborted';
      exitCode: number | null;
      ts: number;
    }
  | {
      kind: 'divider';
      id: string;
      seq: number;
      agent: AgentId;
      ts: number;
    }
  | {
      kind: 'notice';
      id: string;
      seq: number;
      level: 'info' | 'error';
      text: string;
      ts: number;
    };

export interface TranscriptSummary {
  items: TranscriptItem[];
  /** Totals across the whole thread, for the status bar. */
  totals: { inputTokens: number; outputTokens: number; costUsd: number };
}

interface FoldState {
  items: TranscriptItem[];
  /** Item key to its position in `items`, so an update is a lookup rather than a scan. */
  index: Map<string, number>;
  totals: { inputTokens: number; outputTokens: number; costUsd: number };
  /** Which agent each turn belongs to, so a divider only appears when it changes. */
  lastDividerAgent: AgentId | null;
}

/** One line saying where an agent's files are, and whether the user has them yet. */
function laneNotice(
  agent: AgentId | null,
  status: 'provisioned' | 'integrated' | 'refused' | 'removed',
  detail: string | null,
): string {
  const who = agent ?? 'the agent';
  const suffix = detail ? ` — ${detail}` : '';
  switch (status) {
    case 'provisioned':
      return `${who} is working in its own lane${suffix}`;
    case 'integrated':
      return `Integrated ${who}'s lane${suffix}`;
    case 'refused':
      return `${who}'s lane does not apply to your working directory${suffix}`;
    case 'removed':
      return `${who}'s lane was closed${suffix}`;
  }
}

function createFoldState(): FoldState {
  return {
    items: [],
    index: new Map(),
    totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    lastDividerAgent: null,
  };
}

/**
 * A summary is a fresh shell over the items folded so far, so a caller holding an older
 * snapshot keeps seeing exactly what it was handed.
 */
function snapshot(state: FoldState): TranscriptSummary {
  return { items: state.items.slice(), totals: { ...state.totals } };
}

function applyEvent(state: FoldState, event: HarnessEvent): void {
  const { items, index, totals } = state;

  const upsert = (
    key: string,
    create: () => TranscriptItem,
    update: (item: TranscriptItem) => TranscriptItem | null,
  ): void => {
    const existing = index.get(key);
    if (existing === undefined) {
      const item = create();
      index.set(key, items.length);
      items.push(item);
      return;
    }
    const item = items[existing];
    if (!item) return;
    const next = update(item);
    if (next) items[existing] = next;
  };

  switch (event.kind) {
    case 'user.message':
      items.push({
        kind: 'user',
        id: event.id,
        seq: event.seq,
        text: event.text,
        ts: event.ts,
      });
      // A user message always reopens the floor; the next agent block gets a divider.
      state.lastDividerAgent = null;
      break;

    case 'turn.started': {
      if (event.agent === null || event.agent === state.lastDividerAgent) break;
      state.lastDividerAgent = event.agent;
      items.push({
        kind: 'divider',
        id: event.id,
        seq: event.seq,
        agent: event.agent,
        ts: event.ts,
      });
      break;
    }

    case 'message.delta': {
      const agent = event.agent;
      if (agent === null) break;
      upsert(
        `msg:${event.itemId}`,
        () => ({
          kind: 'message',
          id: event.itemId,
          seq: event.seq,
          agent,
          text: event.text,
          streaming: true,
          ts: event.ts,
        }),
        (item) =>
          item.kind === 'message'
            ? { ...item, text: item.text + event.text, streaming: true }
            : null,
      );
      break;
    }

    case 'message.completed': {
      const agent = event.agent;
      if (agent === null) break;
      upsert(
        `msg:${event.itemId}`,
        () => ({
          kind: 'message',
          id: event.itemId,
          seq: event.seq,
          agent,
          text: event.text,
          streaming: false,
          ts: event.ts,
        }),
        (item) =>
          item.kind === 'message' ? { ...item, text: event.text, streaming: false } : null,
      );
      break;
    }

    case 'reasoning.delta': {
      const agent = event.agent;
      if (agent === null) break;
      upsert(
        `think:${event.itemId}`,
        () => ({
          kind: 'reasoning',
          id: event.itemId,
          seq: event.seq,
          agent,
          text: event.text,
          streaming: true,
          ts: event.ts,
        }),
        (item) =>
          item.kind === 'reasoning'
            ? { ...item, text: item.text + event.text, streaming: true }
            : null,
      );
      break;
    }

    case 'reasoning.completed': {
      const agent = event.agent;
      if (agent === null) break;
      upsert(
        `think:${event.itemId}`,
        () => ({
          kind: 'reasoning',
          id: event.itemId,
          seq: event.seq,
          agent,
          text: event.text,
          streaming: false,
          ts: event.ts,
        }),
        (item) =>
          item.kind === 'reasoning' ? { ...item, text: event.text, streaming: false } : null,
      );
      break;
    }

    case 'tool.started': {
      const agent = event.agent;
      if (agent === null) break;
      upsert(
        `tool:${event.itemId}`,
        () => ({
          kind: 'tool',
          id: event.itemId,
          seq: event.seq,
          agent,
          name: event.name,
          toolKind: event.toolKind,
          title: event.title,
          input: event.input,
          output: '',
          status: 'running',
          exitCode: null,
          ts: event.ts,
        }),
        (item) =>
          item.kind === 'tool' ? { ...item, title: event.title, input: event.input } : null,
      );
      break;
    }

    case 'tool.output': {
      const at = index.get(`tool:${event.itemId}`);
      if (at === undefined) break;
      const item = items[at];
      if (item?.kind === 'tool') items[at] = { ...item, output: item.output + event.chunk };
      break;
    }

    case 'tool.completed': {
      const agent = event.agent;
      if (agent === null) break;
      upsert(
        `tool:${event.itemId}`,
        () => ({
          kind: 'tool',
          id: event.itemId,
          seq: event.seq,
          agent,
          name: 'tool',
          toolKind: 'other',
          title: 'tool',
          input: null,
          output: event.output,
          status: event.status,
          exitCode: event.exitCode,
          ts: event.ts,
        }),
        (item) => {
          if (item.kind !== 'tool') return null;
          // An agent that streamed output already gave us the full text; a final
          // payload would duplicate it. Only take it when we have nothing.
          const output = event.output && item.output.length === 0 ? event.output : item.output;
          return { ...item, status: event.status, exitCode: event.exitCode, output };
        },
      );
      break;
    }

    case 'usage':
      totals.inputTokens += event.inputTokens ?? 0;
      totals.outputTokens += event.outputTokens ?? 0;
      totals.costUsd += event.costUsd ?? 0;
      break;

    case 'turn.completed':
      if (event.reason === 'error' && event.error) {
        items.push({
          kind: 'notice',
          id: event.id,
          seq: event.seq,
          level: 'error',
          text: event.error,
          ts: event.ts,
        });
      } else if (event.reason === 'interrupted') {
        items.push({
          kind: 'notice',
          id: event.id,
          seq: event.seq,
          level: 'info',
          text: 'Interrupted.',
          ts: event.ts,
        });
      }
      break;

    case 'error':
      items.push({
        kind: 'notice',
        id: event.id,
        seq: event.seq,
        level: 'error',
        text: event.message,
        ts: event.ts,
      });
      break;

    case 'lane.updated':
      // Where an agent's files went is part of the conversation: work that is in a lane
      // and not in the user's directory is the thing they most need not to be surprised by.
      items.push({
        kind: 'notice',
        id: event.id,
        seq: event.seq,
        level: event.status === 'refused' ? 'error' : 'info',
        text: laneNotice(event.agent, event.status, event.detail),
        ts: event.ts,
      });
      break;

    default:
      // agent.status, approval.*, plan.updated, diff.updated, raw: these drive the
      // panels around the transcript, not the transcript itself.
      break;
  }
}

/**
 * Folds a whole log in one pass — the reference implementation. Every other path through
 * this module has to produce exactly what this returns, and the tests hold them to it.
 */
export function foldTranscript(events: HarnessEvent[]): TranscriptSummary {
  const state = createFoldState();
  for (const event of events) applyEvent(state, event);
  return snapshot(state);
}

/**
 * A fold that survives across renders.
 *
 * Re-folding the log on every delta is quadratic over a turn, and the per-item cost is
 * about to rise sharply now that messages render as markdown. So the state lives here and
 * only the events that actually arrived get applied.
 *
 * The array the UI hands over is the only evidence of what happened to it: React state is
 * replaced wholesale, so a log that still starts and continues with the same events is an
 * append, and anything else — a different thread, a cleared transcript, a shorter log — is
 * a replacement that has to be folded from scratch. Event ids are UUIDs stamped by the
 * store, so matching ids at both ends of the already-applied prefix mean the same log.
 * A full re-fold is always correct, so the check errs towards taking it.
 */
export class TranscriptFolder {
  #state = createFoldState();
  #summary: TranscriptSummary = {
    items: [],
    totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };
  /** The exact array behind `#summary`, so a repeated render costs one comparison. */
  #source: HarnessEvent[] | null = null;
  #applied = 0;
  #firstId: string | null = null;
  #lastId: string | null = null;

  fold(events: HarnessEvent[]): TranscriptSummary {
    if (events === this.#source) return this.#summary;

    if (!this.#continues(events)) {
      this.#state = createFoldState();
      this.#summary = snapshot(this.#state);
      this.#applied = 0;
      this.#firstId = null;
      this.#lastId = null;
    }

    this.#source = events;
    if (this.#applied === events.length) return this.#summary;

    for (let i = this.#applied; i < events.length; i += 1) {
      const event = events[i];
      if (event) applyEvent(this.#state, event);
    }

    this.#applied = events.length;
    this.#firstId = events[0]?.id ?? null;
    this.#lastId = events[events.length - 1]?.id ?? null;
    this.#summary = snapshot(this.#state);
    return this.#summary;
  }

  /** Whether `events` is the log already folded, possibly with more events on the end. */
  #continues(events: HarnessEvent[]): boolean {
    if (this.#applied === 0) return true;
    if (events.length < this.#applied) return false;
    return events[0]?.id === this.#firstId && events[this.#applied - 1]?.id === this.#lastId;
  }
}
