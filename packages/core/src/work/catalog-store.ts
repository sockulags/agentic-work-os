import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  IssueCatalogSnapshot,
  IssueCatalogSource,
  WorkSourceError,
} from '@awos/protocol';
import { createLogger } from '../util/logger.js';
import {
  fetchOpenIssueCatalog,
  OPEN_ISSUE_LIMIT,
  type GitHubOptions,
} from './github.js';

const log = createLogger('issue-catalog');

interface CatalogScope {
  workspaceRoot: string;
  repository: string;
}

interface MemoryState {
  snapshot: IssueCatalogSnapshot | null;
  current: boolean;
  error: WorkSourceError | null;
}

export interface CatalogStoreOptions {
  /** Injectable only at the final file-write boundary for deterministic failure tests. */
  writeFile?: (path: string, content: string) => void;
}

/**
 * Persists successful workspace/repository issue-list snapshots separately from work items.
 *
 * Reads are synchronous and local: startup and ordinary catalog reads never invoke `gh`.
 * Refresh is the only method that crosses the source boundary. A hash keeps the scope out
 * of filenames while retaining one stable file per workspace and repository.
 */
export class CatalogStore {
  readonly #root: string;
  readonly #states = new Map<string, MemoryState>();
  readonly #writeFile: (path: string, content: string) => void;

  constructor(dataDir: string, options: CatalogStoreOptions = {}) {
    this.#root = join(dataDir, 'issue-catalog');
    this.#writeFile = options.writeFile ?? ((path, content) => writeFileSync(path, content, 'utf8'));
    mkdirSync(this.#root, { recursive: true });
  }

  read(scope: CatalogScope): IssueCatalogSource {
    const state = this.#state(scope);
    if (state.snapshot === null) {
      return {
        ...scope,
        freshness: 'not-fetched',
        complete: false,
        successfulAt: null,
        issues: [],
        error: state.error,
      };
    }

    return {
      ...state.snapshot,
      freshness: state.current ? 'current' : 'cached',
      error: state.error,
    };
  }

  async refresh(scope: CatalogScope, options: GitHubOptions): Promise<IssueCatalogSource> {
    const key = this.#key(scope);
    const state = this.#state(scope);
    const result = await fetchOpenIssueCatalog(scope.repository, options);
    if (!result.ok) {
      state.current = false;
      state.error = result.error;
      this.#states.set(key, state);
      return this.read(scope);
    }

    const snapshot: IssueCatalogSnapshot = {
      ...scope,
      complete: result.complete,
      successfulAt: Date.now(),
      issues: result.issues,
    };
    try {
      this.#write(scope, snapshot);
    } catch (err) {
      state.current = false;
      state.error = persistenceError(err);
      this.#states.set(key, state);
      return this.read(scope);
    }
    this.#states.set(key, { snapshot, current: true, error: null });
    return this.read(scope);
  }

  #state(scope: CatalogScope): MemoryState {
    const key = this.#key(scope);
    const existing = this.#states.get(key);
    if (existing) return existing;

    const snapshot = this.#load(scope);
    const state = { snapshot, current: false, error: null };
    this.#states.set(key, state);
    return state;
  }

  #key(scope: CatalogScope): string {
    return createHash('sha256')
      .update(`${scope.workspaceRoot}\0${scope.repository}`)
      .digest('hex');
  }

  #path(scope: CatalogScope): string {
    return join(this.#root, `${this.#key(scope)}.json`);
  }

  #load(scope: CatalogScope): IssueCatalogSnapshot | null {
    const path = this.#path(scope);
    const backup = `${path}.bak`;
    const candidate = existsSync(path) ? path : existsSync(backup) ? backup : null;
    if (candidate === null) return null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'));
      if (!isSnapshot(parsed, scope)) throw new Error('invalid catalog snapshot');
      if (candidate === backup) {
        try {
          renameSync(backup, path);
        } catch (err) {
          // The validated backup is still safe to serve even if restoring its primary
          // filename is temporarily blocked by antivirus or another Windows process.
          log.warn('using issue catalog backup without restoring it', {
            path,
            message: (err as Error).message,
          });
        }
      }
      return parsed;
    } catch (err) {
      log.error('skipping unreadable issue catalog', { path: candidate, message: (err as Error).message });
      return null;
    }
  }

  #write(scope: CatalogScope, snapshot: IssueCatalogSnapshot): void {
    const path = this.#path(scope);
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      this.#writeFile(temp, JSON.stringify(snapshot, null, 2));
    } catch (err) {
      rmSync(temp, { force: true });
      throw err;
    }
    try {
      renameSync(temp, path);
    } catch (err) {
      // Windows does not replace an existing destination with rename. Keep the operation
      // recoverable: move the old snapshot aside, install the complete temp file, then
      // remove the backup. A crash before installation leaves the backup for the next
      // refresh rather than damaging the previous JSON.
      const backup = `${path}.bak`;
      try {
        rmSync(backup, { force: true });
        if (existsSync(path)) renameSync(path, backup);
        renameSync(temp, path);
        rmSync(backup, { force: true });
      } catch (replacementError) {
        if (!existsSync(path) && existsSync(backup)) renameSync(backup, path);
        rmSync(temp, { force: true });
        throw replacementError;
      }
      log.debug('replaced issue catalog using recoverable Windows path', {
        path,
        initialError: (err as Error).message,
      });
    }
  }
}

function isSnapshot(value: unknown, scope: CatalogScope): value is IssueCatalogSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<IssueCatalogSnapshot>;
  return (
    candidate.workspaceRoot === scope.workspaceRoot &&
    candidate.repository === scope.repository &&
    typeof candidate.complete === 'boolean' &&
    typeof candidate.successfulAt === 'number' &&
    Array.isArray(candidate.issues) &&
    candidate.issues.length <= OPEN_ISSUE_LIMIT &&
    (!candidate.complete || candidate.issues.length < OPEN_ISSUE_LIMIT) &&
    candidate.issues.every((issue) => {
      if (typeof issue !== 'object' || issue === null) return false;
      const row = issue as unknown as Record<string, unknown>;
      return (
        Number.isInteger(row['number']) &&
        (row['number'] as number) > 0 &&
        typeof row['url'] === 'string' &&
        typeof row['title'] === 'string' &&
        row['state'] === 'OPEN' &&
        Array.isArray(row['labels']) &&
        row['labels'].every((label) => typeof label === 'string') &&
        Array.isArray(row['assignees']) &&
        row['assignees'].every((assignee) => typeof assignee === 'string') &&
        typeof row['updatedAt'] === 'string'
      );
    })
  );
}

function persistenceError(error: unknown): WorkSourceError {
  const detail = error instanceof Error && error.message !== '' ? ` ${error.message}` : '';
  return {
    kind: 'unknown',
    message:
      `Could not save the refreshed GitHub issue catalog.${detail}` +
      ' Check that AWOS_DATA_DIR is writable and has free space, then try again.',
    retryable: true,
  };
}
