import { rmSync } from 'node:fs';
import { applyPatch, diffTrees, headTree, snapshotWorkingTree, tryGit } from './git.js';
import { createLogger } from './logger.js';

const log = createLogger('lanes');

/**
 * Per-agent working copies, so two agents can run at once.
 *
 * The thread's own directory is the one the user has open in an editor, and two agents
 * writing into it concurrently is a race the harness cannot referee. A lane gives each
 * agent its own checkout of the same repository — a detached `git worktree`, so no branch
 * appears in the user's repo and nothing is committed on their behalf — and leaves the
 * thread directory alone until they ask for a lane's work.
 *
 * A lane is scratch, not history: the canonical transcript is the record of what happened,
 * and the lane is only where the files were while it did. Deleting one loses nothing that
 * was integrated.
 *
 * ## What a lane starts from
 *
 * `git worktree add` checks out a commit, so a fresh lane would miss whatever is
 * uncommitted in the thread directory — usually the very work being continued. So the lane
 * is seeded in two steps: check out `HEAD`, then apply the diff from `HEAD` to a snapshot
 * of the working tree. The result matches what the user sees, uncommitted work included.
 *
 * Files git ignores are not copied, because the snapshot respects `.gitignore`. For most
 * repos that means `node_modules` and build output: a lane can read and edit the source
 * but cannot run the tests until its dependencies exist. `AWOS_LANE_SETUP` names a command
 * to run once per lane for exactly that, and the harness stays out of the question of what
 * that command should be.
 */

export interface Lane {
  /** Absolute path to the lane's working copy. */
  path: string;
  /** Tree SHA the lane was seeded from — the integration baseline. */
  baseTree: string;
}

export type LaneResult =
  | { ok: true; lane: Lane }
  | { ok: false; reason: string };

export type IntegrateResult =
  | { ok: true; patch: string | null }
  | { ok: false; reason: string };

/**
 * Create a lane at `path` seeded from `baseCwd`'s current working tree.
 *
 * Returns a reason rather than throwing: a thread whose directory is not a git repository
 * is a supported state everywhere else in the harness, and parallel mode simply cannot be
 * offered there.
 */
export async function provisionLane(baseCwd: string, path: string): Promise<LaneResult> {
  const head = await headTree(baseCwd);
  if (head === null) {
    return {
      ok: false,
      reason: 'the thread directory is not a git repository with a commit, so lanes cannot be created',
    };
  }

  const snapshot = await snapshotWorkingTree(baseCwd);
  if (snapshot === null) return { ok: false, reason: 'could not snapshot the working tree' };

  // Detached: a lane is scratch, and a branch per lane would litter the user's repo with
  // refs that outlive the thread.
  const added = await tryGit(baseCwd, ['worktree', 'add', '--detach', path, 'HEAD']);
  if (added.stdout === null) {
    return { ok: false, reason: added.stderr || `could not create a worktree at ${path}` };
  }

  // Carry the uncommitted work across. A lane that silently starts from the last commit
  // would have the agent redo work the user can see in their editor.
  const pending = await diffTrees(baseCwd, head, snapshot);
  if (pending) {
    const applied = await applyPatch(path, pending);
    if (!applied.applied) {
      await removeLane(baseCwd, path);
      return { ok: false, reason: `could not seed the lane with uncommitted work: ${applied.reason}` };
    }
  }

  log.info('lane provisioned', { path, seededFrom: snapshot, hadPendingWork: pending !== null });
  return { ok: true, lane: { path, baseTree: snapshot } };
}

/**
 * Everything the lane changed since it was seeded, as a unified diff.
 *
 * Null means the agent changed nothing, which is a normal outcome for a turn that only
 * read or only answered a question.
 */
export async function laneDiff(lane: Lane): Promise<string | null> {
  const now = await snapshotWorkingTree(lane.path);
  if (now === null) return null;
  return diffTrees(lane.path, lane.baseTree, now);
}

/**
 * Apply a lane's work to the thread directory, all of it or none of it.
 *
 * The baseline advances only on success, so a refused integration can be retried after the
 * user resolves whatever it collided with, and an integration that lands is never offered
 * twice.
 */
export async function integrateLane(lane: Lane, baseCwd: string): Promise<IntegrateResult> {
  const patch = await laneDiff(lane);
  if (patch === null) return { ok: true, patch: null };

  const applied = await applyPatch(baseCwd, patch);
  if (!applied.applied) return { ok: false, reason: applied.reason };

  const now = await snapshotWorkingTree(lane.path);
  if (now !== null) lane.baseTree = now;

  log.info('lane integrated', { lane: lane.path, chars: patch.length });
  return { ok: true, patch };
}

/** Remove a lane's worktree and its registration. Best-effort: a leftover directory is not worth failing a thread over. */
export async function removeLane(baseCwd: string, path: string): Promise<void> {
  const removed = await tryGit(baseCwd, ['worktree', 'remove', '--force', path]);
  if (removed.stdout === null) {
    // The worktree may never have been registered, or the directory may be gone already.
    // Clean up what is left so a later lane at the same path is not blocked by debris.
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Windows will refuse while a child process still holds a handle. The prune below
      // keeps git's view honest either way, and the next provision picks a fresh path.
    }
    await tryGit(baseCwd, ['worktree', 'prune']);
  }
  log.info('lane removed', { path });
}
