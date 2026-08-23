#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
/**
 * A fake `gh` for tests, speaking the same command line and the same JSON.
 *
 * The point is a boundary that can fail on demand: authentication, a missing issue, a
 * rate limit and an outage all look different to the user and are all invisible in a test
 * that only ever succeeds. Each is selectable, so the recovery paths get exercised without
 * a network or an account.
 *
 * Usage: fake-gh.js issue view <number> --repo <owner/name> --json <fields>
 *
 * Behaviour is chosen by environment variable rather than by flag, because the harness
 * builds the argument list and the test only controls the environment:
 *
 *   FAKE_GH_FAIL=auth|not-found|rate-limit|offline|garbage
 *   FAKE_GH_TITLE, FAKE_GH_BODY, FAKE_GH_STATE, FAKE_GH_UPDATED_AT, FAKE_GH_VIEW_LABELS — override the issue
 */

const issueOpenMode = process.argv.includes('--issue-open-test');
const orchestratorCatalogMode = process.argv.includes('--catalog-orchestrator-test');
const catalogMode = orchestratorCatalogMode || process.argv.includes('--catalog-test');
const argv = process.argv.slice(2).filter(
  (arg) => arg !== '--catalog-test' && arg !== '--catalog-orchestrator-test' && arg !== '--issue-open-test',
);

const callsFile = process.env[issueOpenMode ? 'FAKE_GH_ISSUE_OPEN_CALLS_FILE' : 'FAKE_GH_CALLS_FILE'];
if (callsFile) {
  appendFileSync(callsFile, `${argv[0] ?? ''} ${argv[1] ?? ''}\n`, 'utf8');
}

function flag(name: string): string | null {
  const at = argv.indexOf(name);
  return at === -1 ? null : (argv[at + 1] ?? null);
}

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const mode = orchestratorCatalogMode
  ? ''
  : process.env[issueOpenMode ? 'FAKE_GH_ISSUE_OPEN_FAIL' : catalogMode ? 'FAKE_GH_CATALOG_FAIL' : 'FAKE_GH_FAIL'] ?? '';
switch (mode) {
  case 'auth':
    fail('gh: To get started with GitHub CLI, please run: gh auth login');
    break;
  case 'not-found':
    fail('gh: Could not resolve to an Issue with the number of 4242.');
    break;
  case 'rate-limit':
    fail('gh: API rate limit exceeded for user ID 1. (HTTP 403)');
    break;
  case 'offline':
    fail('gh: error connecting to api.github.com: dial tcp: lookup api.github.com: no such host');
    break;
  case 'garbage':
    // A program by the right name that is not the GitHub CLI.
    process.stdout.write('Usage: gh <command>\n');
    process.exit(0);
    break;
  default:
    break;
}

if (argv[0] === 'issue' && argv[1] === 'list') {
  const supportedFields = 'number,url,title,state,labels,assignees,updatedAt';
  if (flag('--json') !== supportedFields) {
    fail(`fake-gh: unsupported issue list fields ${flag('--json') ?? '(missing)'}`, 2);
  }
  let issues: unknown[];
  try {
    const configured = orchestratorCatalogMode
      ? undefined
      : issueOpenMode
      ? process.env['FAKE_GH_ISSUE_OPEN_ISSUES']
      : catalogMode
      ? process.env['FAKE_GH_CATALOG_ISSUES']
      : process.env['FAKE_GH_ISSUES'];
    issues = configured ? JSON.parse(configured) as unknown[] : [
      {
        number: 14,
        title: 'Execute one GitHub issue as a work item',
        state: 'OPEN',
        labels: [{ name: 'enhancement' }],
        assignees: [{ login: 'sockulags' }],
        updatedAt: '2026-08-22T19:26:05Z',
        url: 'https://github.com/owner/repo/issues/14',
        isPullRequest: false,
      },
    ];
  } catch {
    fail('fake-gh: invalid FAKE_GH_ISSUES', 2);
  }
  process.stdout.write(`${JSON.stringify(issues)}\n`);
  process.exit(0);
}

if (argv[0] !== 'issue' || argv[1] !== 'view') {
  fail(`fake-gh: unsupported command ${argv.join(' ')}`, 2);
}

const number = Number(argv[2]);
const repo = flag('--repo') ?? 'owner/repo';
const envPrefix = issueOpenMode ? 'FAKE_GH_ISSUE_OPEN_' : 'FAKE_GH_';
if (issueOpenMode) {
  const readyFile = process.env['FAKE_GH_ISSUE_OPEN_VIEW_READY_FILE'];
  const releaseFile = process.env['FAKE_GH_ISSUE_OPEN_VIEW_RELEASE_FILE'];
  if (readyFile && releaseFile) {
    writeFileSync(readyFile, 'ready\n', 'utf8');
    while (!existsSync(releaseFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
let labels = [{ name: 'enhancement' }];
if (process.env[`${envPrefix}VIEW_LABELS`] !== undefined) {
  try {
    const parsed = JSON.parse(process.env[`${envPrefix}VIEW_LABELS`]!) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((label) => typeof label === 'string')) {
      fail('fake-gh: invalid FAKE_GH_VIEW_LABELS', 2);
    }
    labels = (parsed as string[]).map((name) => ({ name }));
  } catch {
    fail('fake-gh: invalid FAKE_GH_VIEW_LABELS', 2);
  }
}

process.stdout.write(
  `${JSON.stringify({
    number,
    title: process.env[`${envPrefix}TITLE`] ?? 'Execute one GitHub issue as a work item',
    body: process.env[`${envPrefix}BODY`] ?? 'The issue body, as GitHub has it.',
    state: process.env[`${envPrefix}STATE`] ?? 'OPEN',
    labels,
    author: { login: 'sockulags' },
    updatedAt: process.env[`${envPrefix}UPDATED_AT`] ?? '2026-08-22T19:26:05Z',
    url: `https://github.com/${repo}/issues/${number}`,
  })}\n`,
);
