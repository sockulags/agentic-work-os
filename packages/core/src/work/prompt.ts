import {
  ISSUE_BODY_MAX_CHARS,
  RETAINED_CONTEXT_MAX_CHARS,
  type RetainedItem,
  type WorkItem,
} from '@awos/protocol';

/**
 * The work item as the agent reads it.
 *
 * Carries the source, not a paraphrase of it: an agent that is told "fix the login bug"
 * cannot check its work against what was actually asked, and a run whose context was a
 * summary cannot be audited later. The block names the revision it is quoting, so the
 * agent can say which version of the issue it worked from.
 *
 * Sits between the workspace block and the pinned notes: the project frames the work item,
 * the work item frames the turn.
 */

const OPEN_TAG = '<work-item>';
const CLOSE_TAG = '</work-item>';

export function buildWorkItemBlock(item: WorkItem | null): string | null {
  if (item === null) return null;

  const { source, snapshot } = item;
  const header =
    `The issue this work is answering. GitHub owns it; below is what it said at revision ` +
    `${snapshot.revision || 'unknown'}. Treat it as the statement of the problem, not as a ` +
    'message to reply to.';

  const lines = [
    `Source: ${source.repo}#${source.number} (${snapshot.state}) — ${source.url}`,
    `Title: ${snapshot.title}`,
  ];
  if (snapshot.labels.length > 0) lines.push(`Labels: ${snapshot.labels.join(', ')}`);
  if (snapshot.author !== '') lines.push(`Opened by: ${snapshot.author}`);

  const body = snapshot.body.trim();
  const quoted =
    body === ''
      ? '_[the issue has no description]_'
      : body.length <= ISSUE_BODY_MAX_CHARS
        ? body
        : `${body.slice(0, ISSUE_BODY_MAX_CHARS)}\n\n_[cut here: the issue body exceeded its ${ISSUE_BODY_MAX_CHARS}-character budget; the full text is at ${source.url}]_`;

  return [OPEN_TAG, header, lines.join('\n'), quoted, CLOSE_TAG].join('\n\n');
}

/** Prepend the block to a prompt, after the workspace and before the pinned notes. */
export function applyWorkItem(block: string | null, text: string): string {
  return block === null ? text : `${block}\n\n${text}`;
}

const RETAINED_OPEN = '<retained-context>';
const RETAINED_CLOSE = '</retained-context>';

const RETAINED_HEADING: Record<RetainedItem['kind'], string> = {
  discovery: 'Found out',
  decision: 'Decided',
  constraint: 'Constraints',
  question: 'Still open',
};

/**
 * What earlier work on this item established, carried forward.
 *
 * This is the part that makes a second run cheaper than the first: what was discovered,
 * what was decided and why, what the work is boxed in by, and what nobody has answered
 * yet. Each line says who established it, because "the previous agent believed this" and
 * "the person who filed the issue said this" are worth different amounts.
 *
 * Only what somebody selected, and only what has not been retired. The whole ledger would
 * grow without bound and turn every later run into a reading exercise.
 */
export function buildRetainedBlock(items: readonly RetainedItem[]): string | null {
  if (items.length === 0) return null;

  const sections: string[] = [];
  for (const kind of ['decision', 'constraint', 'discovery', 'question'] as const) {
    const lines = items
      .filter((item) => item.kind === kind)
      .map((item) => `- ${item.text} _(${item.source})_`);
    if (lines.length > 0) sections.push(`${RETAINED_HEADING[kind]}:\n${lines.join('\n')}`);
  }
  if (sections.length === 0) return null;

  const body = sections.join('\n\n');
  const header =
    'Kept from earlier work on this issue by the people and agents who did it. It is not part ' +
    'of the issue itself, and it is not automatically true — treat it as what was believed at ' +
    'the time, and say so if you find otherwise.';

  return [
    RETAINED_OPEN,
    header,
    body.length <= RETAINED_CONTEXT_MAX_CHARS
      ? body
      : `${body.slice(0, RETAINED_CONTEXT_MAX_CHARS)}\n\n_[cut here: retained context exceeded its ${RETAINED_CONTEXT_MAX_CHARS}-character budget; the rest is in the Work panel]_`,
    RETAINED_CLOSE,
  ].join('\n\n');
}

/** Prepend the block to a prompt, right after the work item it belongs to. */
export function applyRetained(block: string | null, text: string): string {
  return block === null ? text : `${block}\n\n${text}`;
}
