import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * Working-tree snapshots for turn-level diffs.
 *
 * Some agents report a cumulative diff for a turn (Codex, via `turn/diff/updated`);
 * others don't (Claude — its edits arrive as individual tool results with no patch).
 * Rather than reconstruct a diff by parsing an agent's prose — which would be wrong in
 * ways the user cannot detect — the orchestrator captures the working tree from git
 * ground truth around the turn and diffs the two snapshots. See ARCHITECTURE.md §9: the
 * proper fix for the gap is "capturing the working tree around the turn, not interpreting
 * tool output".
 *
 * Every function degrades to `null` when git is missing or the directory is not a repo,
 * so the caller simply skips synthesis and the UI explains the absence as before.
 */

const execFileAsync = promisify(execFile);

/** Run git, returning stdout on success or null on any failure. Never throws. */
async function runGit(
  cwd: string,
  args: string[],
  extraEnv?: NodeJS.ProcessEnv,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      // A turn can touch a lot of files; a unified diff for all of them is bounded only
      // by the tree size, so give it real headroom rather than truncating mid-patch.
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch {
    // Not a repo, git not installed, detached weirdness — all "no snapshot available".
    return null;
  }
}

/**
 * Capture the full state of the working tree as a git tree object, returning its SHA.
 *
 * The snapshot is built in a throwaway index file (`GIT_INDEX_FILE`) so the user's real
 * index is never touched. Staging `-A` into an empty index turns every working-tree file
 * into an addition, yielding a tree that mirrors the directory exactly — untracked files
 * included, `.gitignore` respected (so `node_modules`, `dist`, `target` stay out).
 *
 * Returns null if the directory is not a git repository or git is unavailable.
 */
export async function snapshotWorkingTree(cwd: string): Promise<string | null> {
  let scratch: string | null = null;
  try {
    scratch = mkdtempSync(join(tmpdir(), 'awos-git-'));
    const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: join(scratch, 'index') };

    // Stage the entire working tree into the scratch index, then hash it into a tree.
    const staged = await runGit(cwd, ['add', '-A'], env);
    if (staged === null) return null;

    const tree = await runGit(cwd, ['write-tree'], env);
    const sha = tree?.trim();
    return sha && sha.length > 0 ? sha : null;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Unified diff between two tree snapshots, or null when they're identical or unavailable.
 *
 * The output is a standard unified diff — the same shape the UI already parses for
 * Codex's native turn diff — so no rendering code needs to know where it came from.
 */
export async function diffTrees(
  cwd: string,
  before: string,
  after: string,
): Promise<string | null> {
  if (before === after) return null;

  const patch = await runGit(cwd, [
    'diff',
    '--no-color',
    // Detect renames so a moved file reads as a rename, not a delete + add.
    '--find-renames',
    before,
    after,
  ]);

  const trimmed = patch?.trim();
  return trimmed && trimmed.length > 0 ? patch : null;
}
