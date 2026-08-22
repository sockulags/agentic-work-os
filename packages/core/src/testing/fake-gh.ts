#!/usr/bin/env node
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
 *   FAKE_GH_TITLE, FAKE_GH_BODY, FAKE_GH_STATE, FAKE_GH_UPDATED_AT — override the issue
 */

const argv = process.argv.slice(2);

function flag(name: string): string | null {
  const at = argv.indexOf(name);
  return at === -1 ? null : (argv[at + 1] ?? null);
}

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const mode = process.env['FAKE_GH_FAIL'] ?? '';
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

if (argv[0] !== 'issue' || argv[1] !== 'view') {
  fail(`fake-gh: unsupported command ${argv.join(' ')}`, 2);
}

const number = Number(argv[2]);
const repo = flag('--repo') ?? 'owner/repo';

process.stdout.write(
  `${JSON.stringify({
    number,
    title: process.env['FAKE_GH_TITLE'] ?? 'Execute one GitHub issue as a work item',
    body: process.env['FAKE_GH_BODY'] ?? 'The issue body, as GitHub has it.',
    state: process.env['FAKE_GH_STATE'] ?? 'OPEN',
    labels: [{ name: 'enhancement' }],
    author: { login: 'sockulags' },
    updatedAt: process.env['FAKE_GH_UPDATED_AT'] ?? '2026-08-22T19:26:05Z',
    url: `https://github.com/${repo}/issues/${number}`,
  })}\n`,
);
