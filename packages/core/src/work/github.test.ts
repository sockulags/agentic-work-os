import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, test } from 'node:test';
import { fetchIssue, parseIssueRef, type GitHubOptions } from './github.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_GH = join(here, '..', 'testing', 'fake-gh.js');

/** The fake stands in for `gh`, so the real argument building and parsing are exercised. */
const options: GitHubOptions = {
  bin: process.execPath,
  binArgs: [FAKE_GH],
  timeoutMs: 10_000,
};

afterEach(() => {
  delete process.env['FAKE_GH_FAIL'];
  delete process.env['FAKE_GH_UPDATED_AT'];
  delete process.env['FAKE_GH_TITLE'];
});

describe('fetchIssue', () => {
  test('reads an issue into a snapshot', async () => {
    const result = await fetchIssue({ repo: 'sockulags/agentic-work-os', number: 14 }, options);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.ref.number, 14);
    assert.equal(result.ref.repo, 'sockulags/agentic-work-os');
    assert.match(result.ref.url, /agentic-work-os\/issues\/14$/);
    assert.equal(result.snapshot.state, 'OPEN');
    assert.deepEqual(result.snapshot.labels, ['enhancement']);
    assert.equal(result.snapshot.author, 'sockulags');
    assert.equal(result.snapshot.revision, '2026-08-22T19:26:05Z');
  });

  test('carries the revision the source reported, which is what a refresh compares', async () => {
    process.env['FAKE_GH_UPDATED_AT'] = '2026-09-01T08:00:00Z';
    const result = await fetchIssue({ repo: 'owner/repo', number: 1 }, options);

    assert.equal(result.ok && result.snapshot.revision, '2026-09-01T08:00:00Z');
  });

  describe('failures', () => {
    /** Each of these needs a different move from the user, so each gets its own kind. */
    const cases: Array<[string, string, boolean]> = [
      ['auth', 'auth', true],
      ['not-found', 'not-found', false],
      ['rate-limit', 'rate-limit', true],
      ['offline', 'offline', true],
    ];

    for (const [mode, kind, retryable] of cases) {
      test(`${mode} is reported as ${kind}`, async () => {
        process.env['FAKE_GH_FAIL'] = mode;
        const result = await fetchIssue({ repo: 'owner/repo', number: 1 }, options);

        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.error.kind, kind);
        assert.equal(result.error.retryable, retryable);
        assert.ok(result.error.message.length > 0, 'a failure has to say what to do about it');
      });
    }

    test('a binary that is not the GitHub CLI is reported rather than parsed', async () => {
      process.env['FAKE_GH_FAIL'] = 'garbage';
      const result = await fetchIssue({ repo: 'owner/repo', number: 1 }, options);

      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.error.kind, 'unknown');
    });

    test('a missing binary says how to point at one', async () => {
      const result = await fetchIssue(
        { repo: 'owner/repo', number: 1 },
        { bin: 'definitely-not-installed-awos', binArgs: [], timeoutMs: 5_000 },
      );

      assert.equal(result.ok, false);
      if (result.ok) return;
      // Windows and POSIX report a missing program differently; both must land somewhere
      // actionable rather than in a stack trace.
      assert.ok(['missing-cli', 'unknown', 'not-found'].includes(result.error.kind));
      assert.ok(result.error.message.length > 0);
    });
  });
});

describe('parseIssueRef', () => {
  const repo = 'sockulags/agentic-work-os';

  test('reads a full issue URL', () => {
    assert.deepEqual(parseIssueRef('https://github.com/sockulags/agentic-work-os/issues/14', null), {
      repo,
      number: 14,
    });
  });

  test('reads a URL with a trailing fragment', () => {
    assert.deepEqual(
      parseIssueRef('https://github.com/sockulags/agentic-work-os/issues/14#issuecomment-1', null),
      { repo, number: 14 },
    );
  });

  test('reads owner/name#number', () => {
    assert.deepEqual(parseIssueRef('sockulags/agentic-work-os#14', null), { repo, number: 14 });
  });

  test('reads a bare number against the workspace repository', () => {
    assert.deepEqual(parseIssueRef('#14', repo), { repo, number: 14 });
    assert.deepEqual(parseIssueRef('14', repo), { repo, number: 14 });
  });

  test('a bare number without a declared repository says what is missing', () => {
    const result = parseIssueRef('#14', null);

    assert.ok('error' in result);
    assert.match((result as { error: string }).error, /repository\.github/);
  });

  test('rejects anything else with what was typed', () => {
    const result = parseIssueRef('the login bug', repo);

    assert.ok('error' in result);
    assert.match((result as { error: string }).error, /the login bug/);
  });
});
