import type { Density } from '@/state/DisplaySettingsContext';
import { looksLikeUnifiedDiff } from './diff';
import type { TranscriptItem } from './transcript';

/**
 * Turns a tool item into one line a human can read at a glance.
 *
 * The adapters already classify every call into a `ToolKind` and hand us a raw title —
 * `Read C:/very/long/path.ts`, `mcp__supabase__execute_sql(query)`. That is enough to
 * reconstruct the call but it reads like a log line, and a turn produces a dozen of
 * them. Here we spend the classification we were given: per-kind phrasing, the one
 * argument that identifies the call, and the one fact about the result worth knowing
 * before deciding to open the block.
 *
 * Formatting only — nothing in this file guesses what a tool was, and nothing here
 * touches the DOM, so it stays cheap to test.
 */

export type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;

/** The parts of a tool item a summary is allowed to look at. */
export type ToolSummarySource = Pick<
  ToolItem,
  'toolKind' | 'name' | 'title' | 'input' | 'output' | 'status' | 'exitCode'
>;

export interface ToolSummary {
  /** What the call was, e.g. `Read src/lib/foo.ts`. */
  label: string;
  /** What came back, e.g. `120 lines`. Rendered dimmer than the label. */
  facts: string[];
}

const MAX_LABEL_CHARS = 96;
/** A path stops being readable long before it stops being unique. */
const MAX_PATH_SEGMENTS = 3;
const MAX_PATH_CHARS = 40;

export function summarizeTool(item: ToolSummarySource): ToolSummary {
  switch (item.toolKind) {
    case 'command':
      return summarizeCommand(item);
    case 'file_read':
      return summarizeFileRead(item);
    case 'file_edit':
      return summarizeFileEdit(item);
    case 'search':
      return summarizeSearch(item);
    case 'web':
      return summarizeWeb(item);
    case 'task':
      return summarizeTask(item);
    case 'todo':
      return summarizeTodo(item);
    case 'mcp':
      return summarizeMcp(item);
    default:
      return { label: fallbackLabel(item), facts: [] };
  }
}

/** The single string the collapsed row shows, and the one tests read. */
export function formatToolSummary(item: ToolSummarySource): string {
  const { label, facts } = summarizeTool(item);
  return [label, ...facts].join(' · ');
}

/**
 * Whether a finished call still deserves the reader's screen.
 *
 * A failure that has to be clicked open is worse than any amount of noise, so failures
 * ignore the density setting entirely — Compact quiets the successful majority, it does
 * not hide the one thing that went wrong. Diff output gets the same treatment for the
 * opposite reason: it is the answer, not the bookkeeping around it.
 */
export function shouldExpandTool(item: ToolSummarySource, density: Density): boolean {
  if (density === 'verbose') return true;
  if (item.status === 'error' || item.status === 'denied' || item.status === 'aborted') return true;
  if (density === 'compact') return false;
  if (item.status === 'running') return true;
  return looksLikeUnifiedDiff(item.output);
}

// ---------------------------------------------------------------------------
// Per-kind phrasing
// ---------------------------------------------------------------------------

function summarizeCommand(item: ToolSummarySource): ToolSummary {
  const command = field(item.input, 'command') ?? item.title;
  const facts: string[] = [];

  // Claude never reports an exit code, so for it the useful "did something happen"
  // signal is the size of the output instead.
  if (item.exitCode !== null) facts.push(`exit ${item.exitCode}`);
  else if (item.status !== 'running') {
    const lines = countLines(item.output);
    if (lines > 0) facts.push(plural(lines, 'line'));
  }

  return { label: truncate(oneLine(command), MAX_LABEL_CHARS), facts };
}

function summarizeFileRead(item: ToolSummarySource): ToolSummary {
  const path = filePath(item.input);
  const label = path === null ? fallbackLabel(item) : `Read ${shortenPath(path)}`;
  const lines = countLines(item.output);

  return { label, facts: lines > 0 ? [plural(lines, 'line')] : [] };
}

function summarizeFileEdit(item: ToolSummarySource): ToolSummary {
  const paths = changedPaths(item.input);
  const path = paths[0] ?? filePath(item.input);

  const verb = item.name === 'Write' ? 'Wrote' : 'Edited';
  const label =
    paths.length > 1
      ? `${verb} ${plural(paths.length, 'file')}`
      : path !== null
        ? `${verb} ${shortenPath(path)}`
        : fallbackLabel(item);

  const churn = countChurn(item.output);
  return { label, facts: churn === null ? [] : [churn] };
}

function summarizeSearch(item: ToolSummarySource): ToolSummary {
  const pattern = field(item.input, 'pattern', 'query', 'regex');
  const label = pattern === null ? fallbackLabel(item) : `Searched ${quote(pattern)}`;
  const hits = countLines(item.output);
  if (hits === 0 || item.status === 'running') return { label, facts: [] };

  // Glob answers with paths, Grep with matching lines; naming them differently is the
  // difference between a number that means something and one that doesn't.
  const noun = item.name === 'Glob' ? 'file' : 'match';
  return { label, facts: [plural(hits, noun)] };
}

function summarizeWeb(item: ToolSummarySource): ToolSummary {
  const url = field(item.input, 'url');
  if (url !== null) return { label: `Fetched ${hostOf(url)}`, facts: [] };

  const query = field(item.input, 'query');
  if (query !== null) return { label: `Searched the web for ${quote(query)}`, facts: [] };

  return { label: fallbackLabel(item), facts: [] };
}

function summarizeTask(item: ToolSummarySource): ToolSummary {
  const description = field(item.input, 'description', 'prompt') ?? item.title;
  return { label: `Subagent: ${truncate(oneLine(description), MAX_LABEL_CHARS)}`, facts: [] };
}

function summarizeTodo(item: ToolSummarySource): ToolSummary {
  const todos = property(item.input, 'todos');
  const count = Array.isArray(todos) ? todos.length : 0;
  return { label: 'Updated the plan', facts: count > 0 ? [plural(count, 'item')] : [] };
}

function summarizeMcp(item: ToolSummarySource): ToolSummary {
  const parts = item.name.split('__');
  if (parts.length < 3) return { label: fallbackLabel(item), facts: [] };

  const server = parts[1] ?? '';
  const tool = parts.slice(2).join('__');
  return { label: `${tool} via ${server}`, facts: [] };
}

function fallbackLabel(item: ToolSummarySource): string {
  const title = oneLine(item.title);
  return truncate(title.length > 0 ? title : item.name, MAX_LABEL_CHARS);
}

// ---------------------------------------------------------------------------
// Extraction — deliberately forgiving, since `input` is whatever the agent sent
// ---------------------------------------------------------------------------

function property(input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null) return undefined;
  return (input as Record<string, unknown>)[key];
}

function field(input: unknown, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = property(input, key);
    if (typeof value === 'string' && value.length > 0) return value;
    // Codex sends argv as an array; a command line is the readable form of it.
    if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
      const joined = (value as string[]).join(' ');
      if (joined.length > 0) return joined;
    }
  }
  return null;
}

function filePath(input: unknown): string | null {
  return field(input, 'file_path', 'path', 'notebook_path', 'filePath');
}

/** Codex reports an edit as a `changes` array rather than a single path. */
function changedPaths(input: unknown): string[] {
  const changes = property(input, 'changes');
  if (!Array.isArray(changes)) return [];
  return changes
    .map((change) => property(change, 'path'))
    .filter((path): path is string => typeof path === 'string' && path.length > 0);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.replace(/\n+$/, '').split('\n').length;
}

/** `+12 -3` for output that is a patch, `null` for output that isn't. */
export function countChurn(output: string): string | null {
  let added = 0;
  let removed = 0;

  for (const line of output.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }

  return added === 0 && removed === 0 ? null : `+${added} -${removed}`;
}

export function shortenPath(path: string): string {
  const segments = path.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.length === 0) return path;

  const kept: string[] = [];
  let length = -1;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i] as string;
    const next = length + 1 + segment.length;
    if (kept.length > 0 && (kept.length >= MAX_PATH_SEGMENTS || next > MAX_PATH_CHARS)) break;
    kept.unshift(segment);
    length = next;
  }

  const joined = kept.join('/');
  return kept.length === segments.length ? joined : `…/${joined}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return truncate(url, MAX_PATH_CHARS);
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function quote(text: string): string {
  return `"${truncate(oneLine(text), 48)}"`;
}

function plural(count: number, noun: string): string {
  if (count === 1) return `1 ${noun}`;
  return `${count} ${noun}${/(?:s|x|z|ch|sh)$/.test(noun) ? 'es' : 's'}`;
}
