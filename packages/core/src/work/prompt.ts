import { ISSUE_BODY_MAX_CHARS, type WorkItem } from '@awos/protocol';

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
