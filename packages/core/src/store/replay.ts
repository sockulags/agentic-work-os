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
  /** Recovery may need to replay the incoming agent's own stale native history. */
  includeSameAgentHistory?: boolean;
}

export interface ReplayResult {
  /** The block to prepend, or null when the agent is already current. */
  preamble: string | null;
  /** How many turns the block covers, in either tier. */
  turnCount: number;
  /** How many of those carry only their brief form because the budget was tight. */
  digestTurns: number;
  /** How many were dropped — only when even the brief forms overflow. */
  elidedTurns: number;
}

const OPEN_TAG = '<harness-replay>';
const CLOSE_TAG = '</harness-replay>';

/** Message text kept per turn in the brief tier. */
const DIGEST_TEXT_CHARS = 240;
/** Successful tool calls listed per turn in the brief tier. Failures are never dropped. */
const DIGEST_OK_TOOLS = 3;

/**
 * Group events into turns, then fit them into the budget in two tiers.
 *
 * Every turn is rendered twice up front: in full, and as a brief form that keeps what a
 * later turn can be wrong about — who asked for what, what the agent decided, which
 * commands ran and how they exited — while dropping prose and tool output. The brief form
 * is roughly an order of magnitude smaller, so it is the floor: turns are admitted as
 * briefs first, newest-first, and only what will not fit even that way is elided. The
 * leftover budget then upgrades turns back to full, newest-first.
 *
 * Why a floor at all. The watermark advances to the head of the log once a turn is sent
 * (see `Thread#send`), so an elided turn is not deferred — it is never replayed to that
 * agent again. Under a single-tier budget the oldest turns are exactly the ones dropped,
 * and those hold the decisions the newer turns assume. A brief costs a few hundred chars
 * and keeps the decision; dropping it saves those chars and loses it permanently.
 *
 * The newest turn is always rendered in full, even when it alone exceeds the budget: it is
 * the one the user's new message continues from.
 *
 * Everything here is derived from events already in the log, with no model in the loop —
 * this is elision, not summarization (ARCHITECTURE.md §12).
 */
export function buildReplay(
  events: HarnessEvent[],
  forAgent: AgentId,
  options: ReplayOptions,
): ReplayResult {
  const empty: ReplayResult = { preamble: null, turnCount: 0, digestTurns: 0, elidedTurns: 0 };

  const replayable = events.filter(
    (event) => options.includeSameAgentHistory === true || event.agent !== forAgent,
  );
  if (replayable.length === 0) return empty;

  const turns = groupIntoTurns(replayable);
  const rows: Array<{ full: string; digest: string }> = [];
  for (const turn of turns) {
    const full = renderTurn(turn, options);
    // A turn with nothing conversational in it — deltas and status only — is not content.
    if (full === null) continue;
    // A turn whose brief form comes out empty (a tool started but never completed, say)
    // falls back to its full text, which in that shape is already small.
    rows.push({ full, digest: renderDigest(turn) ?? full });
  }
  if (rows.length === 0) return empty;

  // Floor pass: admit brief forms newest-first. `oldest` walks down to the oldest turn
  // that fits; anything below it is what elision costs.
  let used = 0;
  let oldest = rows.length;
  for (let i = rows.length - 1; i >= 0; i--) {
    const size = (rows[i] as { digest: string }).digest.length;
    if (oldest < rows.length && used + size > options.maxChars) break;
    used += size;
    oldest = i;
  }

  // Detail pass: spend what is left upgrading briefs to full, newest-first. The newest
  // kept turn is upgraded unconditionally. A turn that does not fit is skipped rather
  // than ending the pass, so an older cheap turn can still be restored.
  const tiers: Array<'full' | 'digest'> = rows.map(() => 'digest');
  for (let i = rows.length - 1; i >= oldest; i--) {
    const row = rows[i] as { full: string; digest: string };
    const extra = row.full.length - row.digest.length;
    if (i === rows.length - 1 || extra <= 0 || used + extra <= options.maxChars) {
      used += Math.max(0, extra);
      tiers[i] = 'full';
    }
  }

  const rendered: string[] = [];
  let digested = 0;
  for (let i = oldest; i < rows.length; i++) {
    const row = rows[i] as { full: string; digest: string };
    if (tiers[i] === 'full') {
      rendered.push(row.full);
    } else {
      rendered.push(row.digest);
      digested += 1;
    }
  }

  const agents = [...new Set(turns.map((turn) => turn.agent).filter(Boolean))];
  const header =
    `While you were away, the user worked with ` +
    `${agents.map((a) => `**${a}**`).join(' and ')} ` +
    `(${rendered.length} ${rendered.length === 1 ? 'turn' : 'turns'}` +
    `${digested > 0 ? `, ${digested} in brief` : ''}). ` +
    `This is a transcript for context — it already happened, do not redo it.`;

  const parts = [OPEN_TAG, header];
  const elided = oldest;
  if (elided > 0) parts.push(`_[${elided} earlier ${elided === 1 ? 'turn' : 'turns'} elided]_`);
  if (digested > 0) {
    parts.push(
      '_Turns marked `· brief` are shortened: message text is cut and tool output omitted._',
    );
  }
  parts.push(...rendered, CLOSE_TAG);

  return {
    preamble: parts.join('\n\n'),
    turnCount: rendered.length,
    digestTurns: digested,
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
        const status = toolStatus(event.status, event.exitCode);
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

/**
 * The brief tier: what a later turn can be wrong about if it never sees this one.
 *
 * Kept: who asked for what, what the agent said it did, which tools ran and how they
 * exited, and whether the turn actually finished. Dropped: the body of long messages and
 * all tool output — the expensive parts, and the ones a fresh session can re-derive from
 * the working tree. Failed tools are never dropped, because a later turn that assumes a
 * command succeeded is the failure this tier exists to prevent.
 */
function renderDigest(turn: TurnGroup): string | null {
  const lines: string[] = [];
  const titles = new Map<string, string>();
  const tools: string[] = [];
  let okShown = 0;
  let skipped = 0;

  for (const event of turn.events) {
    switch (event.kind) {
      case 'user.message':
        lines.push(`**user:** ${shorten(event.text, DIGEST_TEXT_CHARS)}`);
        break;

      case 'message.completed':
        lines.push(`**${turn.agent ?? 'agent'}:** ${shorten(event.text, DIGEST_TEXT_CHARS)}`);
        break;

      case 'tool.started':
        titles.set(event.itemId, event.title);
        break;

      case 'tool.completed': {
        const failed = event.status !== 'ok';
        if (!failed && okShown >= DIGEST_OK_TOOLS) {
          skipped += 1;
          break;
        }
        if (!failed) okShown += 1;
        const title = titles.get(event.itemId) ?? event.itemId;
        tools.push(`  \`${title}\` → ${toolStatus(event.status, event.exitCode)}`);
        break;
      }

      case 'turn.completed':
        if (event.reason === 'interrupted') lines.push('  _(interrupted by the user)_');
        else if (event.reason === 'error') lines.push(`  _(failed: ${event.error ?? 'unknown'})_`);
        break;

      default:
        break;
    }
  }

  lines.push(...tools);
  if (skipped > 0) {
    lines.push(`  _+${skipped} more tool ${skipped === 1 ? 'call' : 'calls'}, all ok_`);
  }
  if (lines.length === 0) return null;

  const label = turn.agent === null ? 'user' : turn.agent;
  return [`### ${label} · brief`, ...lines].join('\n');
}

function toolStatus(status: string, exitCode: number | null): string {
  if (status !== 'ok') return status;
  return exitCode === null ? 'ok' : `exit ${exitCode}`;
}

/** One line, hard cut. The brief tier trades the tail of a message for keeping the turn. */
function shorten(text: string, limit: number): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed.replace(/\n/g, ' ⏎ ');

  const head = trimmed.slice(0, limit);
  const elidedLines = trimmed.slice(limit).split('\n').length;
  return `${head.replace(/\n/g, ' ⏎ ')}… [${elidedLines} more lines elided]`;
}
