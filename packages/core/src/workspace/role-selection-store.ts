import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface PersistedRoleSelection {
  workspaceRoot: string;
  roleId: string | null;
}

/**
 * The user's role choice is harness data, not workspace configuration.
 *
 * One SHA-256 named file per resolved workspace keeps roots out of filenames and prevents
 * two checkouts from sharing a preference just because their project names match.
 */
export class WorkspaceRoleSelectionStore {
  readonly #root: string;

  constructor(dataDir: string) {
    this.#root = join(dataDir, 'workspace-role-selections');
    mkdirSync(this.#root, { recursive: true });
  }

  read(workspaceRoot: string): string | null {
    const path = workspaceRoleSelectionPath(this.#root, workspaceRoot);
    const backup = `${path}.bak`;
    const candidate = existsSync(path) ? path : existsSync(backup) ? backup : null;
    if (candidate === null) return null;

    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'));
      if (!isPersistedRoleSelection(parsed, workspaceRoot)) return null;
      if (candidate === backup) {
        try {
          renameSync(backup, path);
        } catch {
          // The validated backup is still safe to serve if Windows temporarily holds the file.
        }
      }
      return parsed.roleId;
    } catch {
      // A malformed preference is local cache state. Ignore it and require an explicit choice.
      return null;
    }
  }

  write(workspaceRoot: string, roleId: string | null): void {
    const path = workspaceRoleSelectionPath(this.#root, workspaceRoot);
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify({ workspaceRoot, roleId } satisfies PersistedRoleSelection, null, 2);

    try {
      writeFileSync(temp, payload, 'utf8');
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }

    try {
      renameSync(temp, path);
    } catch {
      // Windows cannot replace an existing destination with rename. Keep the old value
      // recoverable while installing the complete new file.
      const backup = `${path}.bak`;
      try {
        rmSync(backup, { force: true });
        if (existsSync(path)) renameSync(path, backup);
        renameSync(temp, path);
        rmSync(backup, { force: true });
      } catch (error) {
        if (!existsSync(path) && existsSync(backup)) renameSync(backup, path);
        rmSync(temp, { force: true });
        throw error;
      }
    }
  }
}

export function workspaceRoleSelectionPath(storeRoot: string, workspaceRoot: string): string {
  const key = createHash('sha256').update(workspaceRoot).digest('hex');
  return join(storeRoot, `${key}.json`);
}

function isPersistedRoleSelection(value: unknown, workspaceRoot: string): value is PersistedRoleSelection {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PersistedRoleSelection>;
  return (
    candidate.workspaceRoot === workspaceRoot &&
    (candidate.roleId === null || (typeof candidate.roleId === 'string' && candidate.roleId !== ''))
  );
}
