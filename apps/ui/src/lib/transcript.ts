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

export function foldTranscript(events: HarnessEvent[]): TranscriptSummary {
  const items: TranscriptItem[] = [];
  const index = new Map<string, number>();
  const totals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  /** Which agent each turn belongs to, so a divider only appears when it changes. */
  let lastDividerAgent: AgentId | null = null;

  const upsert = (key: string, create: () => TranscriptItem, update: (item: TranscriptItem) => void): void => {
    const existing = index.get(key);
    if (existing === undefined) {
      const item = create();
      index.set(key, items.length);
      items.push(item);
      return;
    }
    const item = items[existing];
    if (item) update(item);
  };

  for (const event of events) {
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
        lastDividerAgent = null;
        break;

      case 'turn.started': {
        if (event.agent === null || event.agent === lastDividerAgent) break;
        lastDividerAgent = event.agent;
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
          (item) => {
            if (item.kind !== 'message') return;
            item.text += event.text;
            item.streaming = true;
          },
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
          (item) => {
            if (item.kind !== 'message') return;
            item.text = event.text;
            item.streaming = false;
          },
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
          (item) => {
            if (item.kind !== 'reasoning') return;
            item.text += event.text;
            item.streaming = true;
          },
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
          (item) => {
            if (item.kind !== 'reasoning') return;
            item.text = event.text;
            item.streaming = false;
          },
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
          (item) => {
            if (item.kind !== 'tool') return;
            item.title = event.title;
            item.input = event.input;
          },
        );
        break;
      }

      case 'tool.output': {
        const at = index.get(`tool:${event.itemId}`);
        if (at === undefined) break;
        const item = items[at];
        if (item?.kind === 'tool') item.output += event.chunk;
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
            if (item.kind !== 'tool') return;
            item.status = event.status;
            item.exitCode = event.exitCode;
            // An agent that streamed output already gave us the full text; a final
            // payload would duplicate it. Only take it when we have nothing.
            if (event.output && item.output.length === 0) item.output = event.output;
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

      default:
        // agent.status, approval.*, plan.updated, diff.updated, raw: these drive the
        // panels around the transcript, not the transcript itself.
        break;
    }
  }

  return { items, totals };
}
