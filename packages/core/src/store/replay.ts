import type { AgentId, HarnessEvent } from '@awos/protocol';

/**
 * Cross-agent handoff by full replay.
 *
 * The harness owns the canonical log; each agent's native session is a cache that may be
 * stale. Before agent A takes a turn, everything it hasn't seen — every event above its
 * watermark that it didn't produce itself — is rendered into a transcript block and
 * prepended to the user's message.
 *
 * See ARCHITECTURE.md §4 for why this uses one mechanism for both agents rather than
 * Codex's native `thread/inject`.
 */

export interface ReplayOptions {
  maxChars: number;
  maxToolOutput: number;
}

export interface ReplayResult {
  /** The block to prepend, or null when the agent is already current. */
  preamble: string | null;
  /** How many foreign turns were rendered. */
  turnCount: number;
  /** How many were dropped to stay inside the budget. */
  elidedTurns: number;
}

const OPEN_TAG = '<harness-replay>';
const CLOSE_TAG = '</harness-replay>';

/**
 * Group events into turns, then render newest-first until the budget runs out.
 *
 * Newest-first matters: when the budget forces a cut, the turns immediately before the
 * user's new message are the ones that make it intelligible. Dropping the oldest is
 * almost always the right trade.
 */
export function buildReplay(
  events: HarnessEvent[],
  forAgent: AgentId,
  options: ReplayOptions,
): ReplayResult {
  const foreign = events.filter((event) => event.agent !== forAgent);
  if (foreign.length === 0) {
    return { preamble: null, turnCount: 0, elidedTurns: 0 };
  }

  const turns = groupIntoTurns(foreign);
  const rendered: string[] = [];
  let used = 0;
  let elided = 0;

  for (let i = turns.length - 1; i >= 0; i--) {
    const block = renderTurn(turns[i] as TurnGroup, options);
    if (block === null) continue;
    if (used + block.length > options.maxChars && rendered.length > 0) {
      elided = i + 1;
      break;
    }
    rendered.unshift(block);
    used += block.length;
  }

  if (rendered.length === 0) {
    return { preamble: null, turnCount: 0, elidedTurns: 0 };
  }

  const agents = [...new Set(turns.map((turn) => turn.agent).filter(Boolean))];
  const header =
    `While you were away, the user worked with ` +
    `${agents.map((a) => `**${a}**`).join(' and ')} ` +
    `(${rendered.length} ${rendered.length === 1 ? 'turn' : 'turns'}). ` +
    `This is a transcript for context — it already happened, do not redo it.`;

  const parts = [OPEN_TAG, header];
  if (elided > 0) parts.push(`_[${elided} earlier ${elided === 1 ? 'turn' : 'turns'} elided]_`);
  parts.push(...rendered, CLOSE_TAG);

  return {
    preamble: parts.join('\n\n'),
    turnCount: rendered.length,
    elidedTurns: elided,
  };
}

/** Prepend a replay block to the user's text. */
export function applyReplay(preamble: string | null, text: string): string {
  return preamble === null ? text : `${preamble}\n\nNow: ${text}`;
}

/** Strip a replay block for display, so the UI shows what the user actually typed. */
export function stripReplay(text: string): string {
  const close = text.lastIndexOf(CLOSE_TAG);
  if (!text.startsWith(OPEN_TAG) || close === -1) return text;
  return text.slice(close + CLOSE_TAG.length).replace(/^\s*Now:\s*/, '').trim();
}

export function hasReplay(text: string): boolean {
  return text.startsWith(OPEN_TAG);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface TurnGroup {
  turnId: string;
  agent: AgentId | null;
  events: HarnessEvent[];
}

export function groupIntoTurns(events: HarnessEvent[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let current: TurnGroup | null = null;

  for (const event of events) {
    // Events outside a turn — spawn, exit — carry no conversational meaning.
    const key = event.turnId ?? (event.kind === 'user.message' ? `user:${event.seq}` : null);
    if (key === null) continue;

    if (!current || current.turnId !== key) {
      current = { turnId: key, agent: event.agent, events: [] };
      groups.push(current);
    }
    current.events.push(event);
  }

  return groups;
}

function renderTurn(turn: TurnGroup, options: ReplayOptions): string | null {
  const lines: string[] = [];

  for (const event of turn.events) {
    switch (event.kind) {
      case 'user.message':
        lines.push(`**user:** ${event.text}`);
        break;

      case 'message.completed':
        lines.push(`**${turn.agent ?? 'agent'}:** ${event.text}`);
        break;

      case 'tool.started':
        lines.push(`  \`${event.title}\``);
        break;

      case 'tool.completed': {
        const status =
          event.status === 'ok'
            ? event.exitCode === null
              ? 'ok'
              : `exit ${event.exitCode}`
            : event.status;
        const output = truncate(event.output, options.maxToolOutput);
        lines.push(output ? `    → ${status}: ${output}` : `    → ${status}`);
        break;
      }

      case 'plan.updated': {
        const done = event.items.filter((item) => item.status === 'completed').length;
        lines.push(`  _plan: ${done}/${event.items.length} complete_`);
        break;
      }

      case 'turn.completed':
        if (event.reason === 'interrupted') lines.push('  _(interrupted by the user)_');
        else if (event.reason === 'error') lines.push(`  _(failed: ${event.error ?? 'unknown'})_`);
        break;

      default:
        // Deltas, status, usage, raw: no conversational content worth spending tokens on.
        break;
    }
  }

  if (lines.length === 0) return null;

  const label = turn.agent === null ? 'user' : turn.agent;
  return [`### ${label}`, ...lines].join('\n');
}

function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed.replace(/\n/g, ' ⏎ ');

  const head = trimmed.slice(0, limit);
  const elidedLines = trimmed.slice(limit).split('\n').length;
  return `${head.replace(/\n/g, ' ⏎ ')}… [${elidedLines} more lines elided]`;
}
