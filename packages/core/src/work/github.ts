import type { CatalogIssue, IssueRef, IssueSnapshot, WorkSourceError } from '@awos/protocol';
import { runCapture } from '../util/spawn.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('github');

/**
 * The GitHub boundary, spoken through the user's own `gh` CLI.
 *
 * Not an HTTPS client against api.github.com, and the difference is the point: `gh` is
 * already authenticated as the user, so the harness never asks for a token, never stores
 * one, and never has one to leak. It also inherits enterprise hosts, SSO and whatever
 * else that install has been taught, none of which we would want to reimplement.
 *
 * The cost is a process per call and a dependency on `gh` being installed, which the
 * error taxonomy below treats as one of the ordinary failures rather than a crash.
 *
 * Shaped like the agent adapters — a binary plus injectable arguments — so the tests can
 * point it at a fake that speaks the same JSON without touching the network.
 */

export interface GitHubOptions {
  bin: string;
  binArgs: string[];
  timeoutMs: number;
}

export const OPEN_ISSUE_LIMIT = 50;
export const OPEN_ISSUE_FIELDS = 'number,url,title,state,labels,assignees,updatedAt';

export type IssueResult =
  | { ok: true; ref: IssueRef; snapshot: IssueSnapshot }
  | { ok: false; error: WorkSourceError };

export type OpenIssueCatalogResult =
  | { ok: true; issues: CatalogIssue[]; complete: boolean }
  | { ok: false; error: WorkSourceError };

/** The fields we ask for, and therefore the ones the fake has to know about. */
const FIELDS = 'number,title,body,state,labels,author,updatedAt,url';

interface GhIssue {
  number?: number;
  title?: string;
  body?: string;
  state?: string;
  labels?: Array<{ name?: string }>;
  author?: { login?: string };
  updatedAt?: string;
  url?: string;
  isPullRequest?: boolean;
  assignees?: Array<{ login?: string }>;
}

/**
 * Fetch the bounded set used by the workspace issue catalog.
 *
 * `issue list` excludes pull requests at the GitHub CLI boundary, while the explicit
 * field and state checks below keep the adapter honest if a wrapper or fixture returns
 * mixed data. Bodies are intentionally not requested.
 */
export async function fetchOpenIssueCatalog(
  repo: string,
  options: GitHubOptions,
): Promise<OpenIssueCatalogResult> {
  const args = [
    ...options.binArgs,
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--limit',
    String(OPEN_ISSUE_LIMIT),
    '--json',
    OPEN_ISSUE_FIELDS,
  ];

  const result = await runCapture(options.bin, args, options.timeoutMs);
  if (result.code !== 0) {
    return { ok: false, error: classifyGitHubFailure(result.code, `${result.stderr}${result.stdout}`, options.bin) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { ok: false, error: invalidGitHubJson(options.bin) };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: invalidGitHubJson(options.bin) };

  const issues: CatalogIssue[] = [];
  for (const raw of parsed) {
    if (!isRecord(raw)) return { ok: false, error: invalidGitHubJson(options.bin) };
    if (raw['isPullRequest'] === true) continue;
    if (typeof raw['state'] !== 'string') return { ok: false, error: invalidGitHubJson(options.bin) };
    if (raw['state'].toUpperCase() !== 'OPEN') continue;

    const number = raw['number'];
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
      return { ok: false, error: invalidGitHubJson(options.bin) };
    }

    const title = requiredString(raw['title']);
    const url = requiredString(raw['url']);
    const updatedAt = requiredString(raw['updatedAt']);
    const labels = names(raw['labels'], 'name');
    const assignees = names(raw['assignees'], 'login');
    if (title === null || url === null || updatedAt === null || labels === null || assignees === null) {
      return { ok: false, error: invalidGitHubJson(options.bin) };
    }
    issues.push({
      number,
      url,
      title,
      state: 'OPEN',
      labels,
      assignees,
      updatedAt,
    });
  }

  return {
    ok: true,
    issues: issues.slice(0, OPEN_ISSUE_LIMIT),
    complete: parsed.length < OPEN_ISSUE_LIMIT,
  };
}

export async function fetchIssue(
  ref: { repo: string; number: number },
  options: GitHubOptions,
): Promise<IssueResult> {
  const args = [
    ...options.binArgs,
    'issue',
    'view',
    String(ref.number),
    '--repo',
    ref.repo,
    '--json',
    FIELDS,
  ];

  const result = await runCapture(options.bin, args, options.timeoutMs);
  if (result.code !== 0) {
    const error = classifyGitHubFailure(result.code, `${result.stderr}${result.stdout}`, options.bin);
    log.warn('issue fetch failed', { repo: ref.repo, number: ref.number, kind: error.kind });
    return { ok: false, error };
  }

  let parsed: GhIssue;
  try {
    parsed = JSON.parse(result.stdout) as GhIssue;
  } catch {
    return {
      ok: false,
      error: invalidGitHubJson(options.bin),
    };
  }

  const number = parsed.number ?? ref.number;
  return {
    ok: true,
    ref: {
      repo: ref.repo,
      number,
      url: parsed.url ?? `https://github.com/${ref.repo}/issues/${number}`,
    },
    snapshot: {
      title: parsed.title ?? '',
      body: parsed.body ?? '',
      state: parsed.state ?? 'UNKNOWN',
      labels: (parsed.labels ?? []).map((label) => label.name ?? '').filter((name) => name !== ''),
      author: parsed.author?.login ?? '',
      // No `updatedAt` means nothing to compare, so refresh would report every check as a
      // change. An empty revision is honest about that; the UI reads it as "unknown".
      revision: parsed.updatedAt ?? '',
    },
  };
}

/**
 * Turn a failed `gh` invocation into a failure the user can act on.
 *
 * Matched on the message rather than the exit code, because `gh` exits 1 for everything
 * from a typo to an outage. Matching prose is fragile in principle; the fallback is a
 * plain "unknown" that still shows what `gh` said, so a wording change downgrades the
 * message rather than breaking the feature.
 */
export function classifyGitHubFailure(code: number | null, output: string, bin: string): WorkSourceError {
  const text = output.toLowerCase();

  if (code === null && text.includes('enoent')) {
    return {
      kind: 'missing-cli',
      message: `\`${bin}\` was not found. Install the GitHub CLI, or point AWOS_GH_BIN at it.`,
      retryable: false,
    };
  }
  if (text.includes('not found') || text.includes('could not resolve to an issue')) {
    return {
      kind: 'not-found',
      message: 'No issue by that number in that repository. Check the number and the repo.',
      retryable: false,
    };
  }
  if (text.includes('rate limit') || text.includes('secondary rate')) {
    return {
      kind: 'rate-limit',
      message: 'GitHub is rate-limiting this account. Wait a few minutes and try again.',
      retryable: true,
    };
  }
  if (
    text.includes('authentication') ||
    text.includes('gh auth login') ||
    text.includes('not logged') ||
    text.includes('bad credentials')
  ) {
    return {
      kind: 'auth',
      message: 'GitHub refused the request. Run `gh auth login` and try again.',
      retryable: true,
    };
  }
  if (
    text.includes('dial tcp') ||
    text.includes('no such host') ||
    text.includes('network is unreachable') ||
    text.includes('connection refused') ||
    text.includes('timeout')
  ) {
    return {
      kind: 'offline',
      message: 'Could not reach GitHub. Check the connection and try again.',
      retryable: true,
    };
  }
  if (code === null) {
    return {
      kind: 'offline',
      message: `\`${bin}\` did not finish in time. Try again.`,
      retryable: true,
    };
  }

  return {
    kind: 'unknown',
    message: firstLine(output) || `\`${bin}\` failed with exit code ${code}.`,
    retryable: true,
  };
}

function invalidGitHubJson(bin: string): WorkSourceError {
  return {
    kind: 'unknown',
    message: `\`${bin}\` returned something that is not the expected GitHub JSON. Check that it is the GitHub CLI and not another program by that name.`,
    retryable: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function names(value: unknown, field: 'name' | 'login'): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const name = requiredString(entry[field]);
    if (name === null) return null;
    result.push(name);
  }
  return result;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? '';
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

const ISSUE_URL_RE = /^https?:\/\/[^/]+\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)/i;
const NUMBER_RE = /^#?(\d+)$/;
const REPO_NUMBER_RE = /^([^/\s]+\/[^/\s#]+)#(\d+)$/;

/**
 * Read what the user typed as an issue reference.
 *
 * Three forms, because three are what people actually paste: a full URL, `owner/name#12`,
 * and a bare `#12` — which only means something with a repository to resolve it against,
 * and that is what the workspace declaration is for.
 */
export function parseIssueRef(
  input: string,
  defaultRepo: string | null,
): { repo: string; number: number } | { error: string } {
  const text = input.trim();
  if (text === '') return { error: 'Paste an issue URL, or type its number.' };

  const url = ISSUE_URL_RE.exec(text);
  if (url) return { repo: url[1] as string, number: Number(url[2]) };

  const qualified = REPO_NUMBER_RE.exec(text);
  if (qualified) return { repo: qualified[1] as string, number: Number(qualified[2]) };

  const bare = NUMBER_RE.exec(text);
  if (bare) {
    if (defaultRepo === null) {
      return {
        error:
          'A bare issue number needs a repository. Declare repository.github in .awos/workspace.json, or paste the full URL.',
      };
    }
    return { repo: defaultRepo, number: Number(bare[1]) };
  }

  return { error: `Not an issue reference: "${text}". Use a URL, owner/name#12, or #12.` };
}
