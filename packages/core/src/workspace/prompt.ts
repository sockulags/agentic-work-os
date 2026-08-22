import { WORKSPACE_FILE, WORKSPACE_NOTES_MAX_CHARS } from '@awos/protocol';
import type { WorkspaceResolution } from '@awos/protocol';

/**
 * The workspace as the agents see it.
 *
 * Rendered into every turn for the same reason pinned context is: it is standing truth
 * about where the work happens, and an agent that has to ask which command verifies this
 * project will ask again in the next session. It rides ahead of the pinned notes, because
 * the project frames the thread rather than the other way round.
 *
 * Deliberately a summary and not the file. Reference files are named, never inlined — the
 * agent can open what it needs, and a prompt that carried ARCHITECTURE.md on every turn
 * would spend the context window on something already on disk beside it.
 */

const OPEN_TAG = '<workspace>';
const CLOSE_TAG = '</workspace>';

export function buildWorkspaceBlock(resolution: WorkspaceResolution): string | null {
  if (resolution.status === 'none') return null;

  // A declaration that failed to load is told rather than hidden. It explains, in the one
  // place the agent will read, why the project's own rules are not in effect.
  if (resolution.status === 'invalid') {
    return [
      OPEN_TAG,
      `This project has a ${WORKSPACE_FILE} that could not be read, so its settings are not in ` +
        'effect. Treat the fault as worth reporting; the harness is running without a workspace.',
      CLOSE_TAG,
    ].join('\n\n');
  }

  const { workspace } = resolution;
  const lines = [
    `Workspace: ${workspace.name}`,
    `Root: ${workspace.root}`,
  ];

  if (workspace.repository.github) lines.push(`GitHub: ${workspace.repository.github}`);
  lines.push(`Agents allowed here: ${workspace.agents.join(', ')}`);
  if (workspace.setup.command) {
    lines.push(`A fresh checkout is made usable with: ${workspace.setup.command}`);
  }
  if (workspace.verify.length > 0) {
    const named = workspace.verify.map((entry) => `${entry.name} — ${entry.command}`).join('; ');
    lines.push(`Verification commands, to run when checking your work: ${named}`);
  }
  if (workspace.context.references.length > 0) {
    lines.push(`Worth reading before you change things: ${workspace.context.references.join(', ')}`);
  }

  const notes = workspace.context.notes.trim();
  if (notes !== '') {
    lines.push(
      'Project notes:',
      notes.length <= WORKSPACE_NOTES_MAX_CHARS
        ? notes
        : `${notes.slice(0, WORKSPACE_NOTES_MAX_CHARS)}\n\n_[cut here: project notes exceeded their ${WORKSPACE_NOTES_MAX_CHARS}-character budget]_`,
    );
  }

  const header =
    `Settings this project declares in ${WORKSPACE_FILE}, versioned with the repository. They ` +
    'apply to every turn here, whichever agent takes it, and they are the project\'s rules ' +
    'rather than something to acknowledge back.';

  return [OPEN_TAG, header, lines.join('\n'), CLOSE_TAG].join('\n\n');
}

/** Prepend the block to a prompt, ahead of the pinned notes. */
export function applyWorkspace(block: string | null, text: string): string {
  return block === null ? text : `${block}\n\n${text}`;
}
