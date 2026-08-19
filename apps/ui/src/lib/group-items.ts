import type { Density } from '@/state/DisplaySettingsContext';
import type { TranscriptItem } from './transcript';
import type { ToolItem } from './tool-summary';

/**
 * Collapses runs of tool calls into a single row before anything renders.
 *
 * A turn that reads six files and greps twice is one thought, not eight; giving each
 * call its own row spends the reader's attention at the same rate as the answer does.
 * Grouping is a view concern rather than a fold concern — the event fold stays the
 * canonical, ungrouped record and this runs on top of it — which also keeps it a pure
 * array-to-array function that needs no React to test.
 */

/** Two calls in a row is already a run; a lone call reads better as itself. */
const MIN_GROUP_SIZE = 2;

export type TranscriptRow =
  | { type: 'item'; key: string; item: TranscriptItem }
  | { type: 'tool-group'; key: string; items: ToolItem[] };

export function groupTranscriptItems(items: TranscriptItem[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let run: ToolItem[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    if (run.length >= MIN_GROUP_SIZE) {
      const first = run[0] as ToolItem;
      rows.push({ type: 'tool-group', key: `group:${first.id}`, items: run });
    } else {
      for (const tool of run) rows.push({ type: 'item', key: rowKey(tool), item: tool });
    }
    run = [];
  };

  for (const item of items) {
    if (item.kind !== 'tool') {
      flush();
      rows.push({ type: 'item', key: rowKey(item), item });
      continue;
    }

    // A divider already separates agents, but only when the fold emitted one. Breaking
    // on the agent too means a group never claims work two agents did.
    const previous = run[run.length - 1];
    if (previous && previous.agent !== item.agent) flush();
    run.push(item);
  }

  flush();
  return rows;
}

export interface ToolGroupSummary {
  steps: number;
  /** Span from the first call starting to the last one starting; `null` when instant. */
  durationMs: number | null;
  failed: number;
  running: boolean;
}

export function summarizeToolGroup(items: ToolItem[]): ToolGroupSummary {
  const first = items[0];
  const last = items[items.length - 1];
  const span = first && last ? last.ts - first.ts : 0;

  return {
    steps: items.length,
    durationMs: span > 0 ? span : null,
    failed: items.filter((item) => item.status === 'error' || item.status === 'aborted').length,
    running: items.some((item) => item.status === 'running'),
  };
}

/** Same bargain as a single call: quiet once it worked, open while it matters. */
export function shouldExpandGroup(items: ToolItem[], density: Density): boolean {
  const summary = summarizeToolGroup(items);
  if (density === 'verbose') return true;
  if (summary.failed > 0) return true;
  if (density === 'compact') return false;
  return summary.running;
}

function rowKey(item: TranscriptItem): string {
  return `${item.kind}:${item.id}`;
}
