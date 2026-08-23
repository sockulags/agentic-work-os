import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IssueRef, IssueSnapshot, WorkItem } from '@awos/protocol';
import { createLogger } from '../util/logger.js';

const log = createLogger('work');

/**
 * The work items a workspace has attached, one JSON file each.
 *
 * Keyed on the workspace rather than on a thread: an issue is worked on, abandoned, picked
 * up again in a new thread, and it is the same issue every time. Threads point at items,
 * never the reverse, so deleting a thread cannot take the record of what it was for with
 * it.
 *
 * The file is a cache of GitHub, not a second copy of the truth. Nothing here is editable
 * — the only writes are "this is what the source said when we asked" — which is what keeps
 * this from quietly becoming a competing issue tracker.
 *
 * Synchronous, like the other stores, and for the same reason: at one human's volume the
 * cost is invisible and the absence of half-written state is worth more.
 */
export class WorkItemStore {
  readonly #root: string;
  readonly #items = new Map<string, WorkItem>();
  readonly #writeFile: typeof writeFileSync;

  constructor(dataDir: string, options: { writeFile?: typeof writeFileSync } = {}) {
    this.#root = join(dataDir, 'work-items');
    this.#writeFile = options.writeFile ?? writeFileSync;
    mkdirSync(this.#root, { recursive: true });
    this.#loadAll();
  }

  get(id: string): WorkItem | undefined {
    return this.#items.get(id);
  }

  /** Find the stable workspace/repository/issue identity without contacting the source. */
  find(workspaceRoot: string, repo: string, number: number): WorkItem | undefined {
    return [...this.#items.values()].find(
      (item) => item.workspaceRoot === workspaceRoot && item.source.repo === repo && item.source.number === number,
    );
  }

  /** Everything attached to one workspace, most recently attached first. */
  list(workspaceRoot: string): WorkItem[] {
    return [...this.#items.values()]
      .filter((item) => item.workspaceRoot === workspaceRoot)
      .sort((a, b) => b.attachedAt - a.attachedAt);
  }

  /**
   * Write down what the source just said.
   *
   * Attaching and refreshing are the same operation: both are "GitHub was asked, here is
   * the answer". The only difference is whether a record already existed, and identity is
   * the workspace plus the issue, so asking twice cannot produce two items for one issue.
   *
   * `fetchedAt` moves only when the content did. That keeps "how old is what I am reading"
   * separate from "when did we last check", which is the pair a refresh has to distinguish
   * for a source that has not changed.
   */
  record(input: {
    workspaceRoot: string;
    ref: IssueRef;
    snapshot: IssueSnapshot;
  }): WorkItem {
    const now = Date.now();
    const existing = this.#find(input.workspaceRoot, input.ref);

    const item: WorkItem = existing
      ? {
          ...existing,
          source: input.ref,
          snapshot: input.snapshot,
          fetchedAt:
            existing.snapshot.revision === input.snapshot.revision ? existing.fetchedAt : now,
          lastRefreshedAt: now,
        }
      : {
          id: randomUUID(),
          workspaceRoot: input.workspaceRoot,
          source: input.ref,
          snapshot: input.snapshot,
          attachedAt: now,
          fetchedAt: now,
          lastRefreshedAt: now,
        };

    this.#persist(item);
    this.#items.set(item.id, item);
    return item;
  }

  /**
   * Forget an item.
   *
   * Only the cached record goes: the runs that used it are events in a thread's log, which
   * is append-only and stays readable — a run that happened is not undone by detaching the
   * issue it answered.
   */
  remove(id: string): void {
    this.#items.delete(id);
    rmSync(this.#path(id), { force: true });
  }

  #find(workspaceRoot: string, ref: IssueRef): WorkItem | undefined {
    return [...this.#items.values()].find(
      (item) =>
        item.workspaceRoot === workspaceRoot &&
        item.source.repo === ref.repo &&
        item.source.number === ref.number,
    );
  }

  #path(id: string): string {
    return join(this.#root, `${id}.json`);
  }

  #persist(item: WorkItem): void {
    const primary = this.#path(item.id);
    const temporary = `${primary}.tmp`;
    const backup = `${primary}.bak`;

    rmSync(temporary, { force: true });
    try {
      this.#writeFile(temporary, JSON.stringify(item, null, 2), 'utf8');
      rmSync(backup, { force: true });
      if (existsSync(primary)) renameSync(primary, backup);
      try {
        renameSync(temporary, primary);
      } catch (error) {
        if (!existsSync(primary) && existsSync(backup)) renameSync(backup, primary);
        throw error;
      }
      try {
        rmSync(backup, { force: true });
      } catch (error) {
        log.error('could not remove committed work item backup', { id: item.id, message: (error as Error).message });
      }
    } catch (error) {
      rmSync(temporary, { force: true });
      if (!existsSync(primary) && existsSync(backup)) renameSync(backup, primary);
      throw error;
    }
  }

  #loadAll(): void {
    let files: string[];
    try {
      const entries = readdirSync(this.#root);
      for (const name of entries.filter((candidate) => candidate.endsWith('.json.tmp'))) {
        rmSync(join(this.#root, name), { force: true });
      }
      for (const name of entries.filter((candidate) => candidate.endsWith('.json.bak'))) {
        const backup = join(this.#root, name);
        const primary = backup.slice(0, -4);
        if (existsSync(primary)) {
          rmSync(backup, { force: true });
          continue;
        }
        try {
          const item = JSON.parse(readFileSync(backup, 'utf8')) as WorkItem;
          if (typeof item.id === 'string' && `${item.id}.json` === name.slice(0, -4)) {
            renameSync(backup, primary);
          }
        } catch (err) {
          log.error('skipping unreadable work item backup', { name, message: (err as Error).message });
        }
      }
      files = readdirSync(this.#root).filter((name) => name.endsWith('.json'));
    } catch {
      return;
    }

    for (const name of files) {
      const path = join(this.#root, name);
      try {
        const item = JSON.parse(readFileSync(path, 'utf8')) as WorkItem;
        if (typeof item.id === 'string' && existsSync(path)) this.#items.set(item.id, item);
      } catch (err) {
        // One unreadable item must not cost the user the other twenty, the same bargain
        // the thread store makes with a corrupt thread.
        log.error('skipping unreadable work item', { name, message: (err as Error).message });
      }
    }
    log.info('loaded work items', { count: this.#items.size });
  }
}
