/**
 * Work items: the external problem a thread was opened to solve.
 *
 * A thread knows a directory and, since the workspace contract, a project. What it has
 * never known is *why* it exists — which issue authorized the work, which version of that
 * issue the agent read, and whether the issue has moved since. The transcript records what
 * was said and done; none of that reconstructs the intent it was answering.
 *
 * GitHub stays the owner of the issue. What lives here is a stable local identity, a
 * reference back to the source, and the snapshot a run was given — deliberately not an
 * editable copy that would drift into being a second, competing issue tracker.
 *
 * Types only. Fetching, storing and rendering are `@awos/core`'s job.
 */

/** Where an item came from. `repo` is `owner/name`, the form GitHub itself uses. */
export interface IssueRef {
  repo: string;
  number: number;
  url: string;
}

/**
 * The issue as it was at one moment.
 *
 * `revision` is GitHub's own `updatedAt`. Comparing it is how a refresh tells "the same
 * issue, read again" from "the issue changed under us" without diffing prose.
 */
export interface IssueSnapshot {
  title: string;
  body: string;
  state: string;
  labels: string[];
  author: string;
  revision: string;
}

export interface WorkItem {
  /** Ours, stable, and independent of GitHub's numbering. */
  id: string;
  /** The workspace this belongs to, so the same issue is one record across its threads. */
  workspaceRoot: string;
  source: IssueRef;
  snapshot: IssueSnapshot;
  attachedAt: number;
  /** When the snapshot was taken — the age of what you are looking at. */
  fetchedAt: number;
  /** When GitHub was last asked, whether or not anything had changed. */
  lastRefreshedAt: number;
}

/**
 * Why the source could not be reached, in the terms the user has to act in.
 *
 * A kind rather than a bare message because the four failures need four different moves —
 * log in, check the number, wait, reconnect — and a panel that says "try again" to all of
 * them is telling three quarters of its users the wrong thing.
 */
export type WorkSourceErrorKind =
  | 'auth'
  | 'not-found'
  | 'rate-limit'
  | 'offline'
  | 'missing-cli'
  | 'unknown';

export interface WorkSourceError {
  kind: WorkSourceErrorKind;
  message: string;
  /** Whether repeating the same request could plausibly succeed. */
  retryable: boolean;
}

/**
 * How much of a composed context a `run.started` event will carry.
 *
 * The payload is recorded verbatim so the run can be audited against what the agent
 * actually read, which means an issue with a novel in it would otherwise land in the
 * append-only log. Cut with a marker, like every other budget here.
 */
export const RUN_CONTEXT_MAX_CHARS = 64_000;

/** How much of an issue body a work-item prompt block will carry. */
export const ISSUE_BODY_MAX_CHARS = 8_000;
