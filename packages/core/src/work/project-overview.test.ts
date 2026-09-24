import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  CatalogIssue,
  EffectiveWorkspace,
  IssueCatalogSource,
  WorkerDiagnostic,
  WorkerProfileId,
  WorkspaceResolution,
  WorkspaceRoleSelection,
} from '@awos/protocol';
import { testWorkerDiagnostic } from '../testing/worker-diagnostics.js';
import { projectProjectOverview, type ProjectOverviewEntry } from './project-overview.js';

const workspace: Extract<WorkspaceResolution, { status: 'ok' }> = {
  status: 'ok',
  problems: [],
  workspace: {
    root: '/repo',
    name: 'Project',
    repository: { root: '.', github: 'owner/repo' },
    agents: ['claude', 'codex'],
    setup: { command: '', timeoutMs: null },
    verify: [],
    integration: { requires: [], allowOverride: false },
    context: { references: [], notes: '' },
    roles: [
      { id: 'implementer', label: 'Implementer' },
      { id: 'reviewer', label: 'Reviewer' },
    ],
    steps: [
      { id: 'implement', action: 'Implement issue', role: 'implementer', workers: ['claude', 'codex'] },
    ],
    routes: [{ id: 'bug', match: { anyLabels: ['bug'] }, step: 'implement' }],
    guardrails: [],
    origins: {
      name: 'shared', repository: 'shared', agents: 'shared', setup: 'default', verify: 'default',
      integration: 'default', context: 'default', roles: 'shared', steps: 'shared', routes: 'shared', guardrails: 'default',
    },
    sources: ['.awos/workspace.json'],
  },
};

function issue(number: number, labels = ['bug'], state: CatalogIssue['state'] = 'OPEN'): CatalogIssue {
  return {
    number,
    url: `https://github.com/owner/repo/issues/${number}`,
    title: `Issue ${number}`,
    state,
    labels,
    assignees: [],
    updatedAt: '2026-08-24T10:00:00Z',
  };
}

function source(freshness: IssueCatalogSource['freshness'], issues: CatalogIssue[] = [issue(1)]): IssueCatalogSource {
  return {
    workspaceRoot: '/repo',
    repository: 'owner/repo',
    freshness,
    complete: true,
    successfulAt: freshness === 'not-fetched' ? null : 1,
    issues,
    error: freshness === 'current' ? null : { kind: 'offline', message: 'GitHub is unavailable.', retryable: true },
  };
}

function selection(roleId: string | null = 'implementer'): WorkspaceRoleSelection {
  return roleId === null
    ? { status: 'needs-selection', roleId: null, role: null }
    : { status: 'selected', roleId, role: workspace.status === 'ok' ? workspace.workspace.roles.find((role) => role.id === roleId) ?? null : null };
}

function availability(profileId: WorkerProfileId, available: boolean): WorkerDiagnostic {
  return testWorkerDiagnostic(profileId, {
    reachable: available,
    label: profileId === 'claude' ? 'Claude' : 'Codex',
  });
}

function project(
  item: CatalogIssue,
  overrides: Partial<{
    freshness: IssueCatalogSource['freshness'];
    role: WorkspaceRoleSelection;
    workerDiagnostics: WorkerDiagnostic[];
    linkedThreads: ProjectOverviewEntry['linkedThreads'];
    runs: ProjectOverviewEntry['runs'];
    issues: CatalogIssue[];
  }> = {},
) {
  const issues = overrides.issues ?? [item];
  return projectProjectOverview({
    cwd: '/repo',
    workspace,
    source: source(overrides.freshness ?? 'current', issues),
    roleSelection: overrides.role ?? selection(),
    workerDiagnostics: overrides.workerDiagnostics ?? [availability('claude', true), availability('codex', false)],
    entries: [{
      issue: item,
      linkedThreads: overrides.linkedThreads ?? [],
      runs: overrides.runs ?? [],
    }],
  });
}

describe('project overview projection', () => {
  test('makes only current, singly routed, role-matched work with an available worker takeable', () => {
    const result = project(issue(1));
    const item = result.items[0]!;

    assert.equal(item.group, 'available');
    assert.equal(item.action, 'take');
    assert.equal(item.reasonCode, 'available');
    assert.deepEqual(
      item.workers.map((worker) => [worker.label, worker.dispatchable, worker.reasonCode]),
      [['Claude', true, 'reachable'], ['Codex', false, 'unavailable']],
    );
  });

  test('keeps a role mismatch visible in the source lens without exposing a Take action', () => {
    const result = project(issue(2), { role: selection('reviewer') });
    const item = result.items[0]!;

    assert.equal(item.group, 'available');
    assert.equal(item.action, 'none');
    assert.equal(item.statusLabel, 'Role mismatch');
    assert.match(item.reason, /selected role is Reviewer/);
  });

  test('uses explicit route, source, and worker preconditions for Blocked', () => {
    const unavailable = project(issue(3), { workerDiagnostics: [availability('claude', false), availability('codex', false)] }).items[0]!;
    assert.equal(unavailable.group, 'blocked');
    assert.equal(unavailable.reasonCode, 'worker-unavailable');
    assert.equal(unavailable.action, 'none');

    const unrouted = project(issue(4, ['other'])).items[0]!;
    assert.equal(unrouted.group, 'blocked');
    assert.equal(unrouted.reasonCode, 'not-routed');

    const cached = project(issue(5), { freshness: 'cached' }).items[0]!;
    assert.equal(cached.group, 'blocked');
    assert.equal(cached.reasonCode, 'refresh-required');
    assert.equal(cached.action, 'none');
  });

  test('keeps linked local work Active through source failure and marks restart interruption', () => {
    const result = project(issue(6), {
      freshness: 'cached',
      workerDiagnostics: [],
      linkedThreads: [{ threadId: 'thread-6', workItemId: 'work-6', title: 'Issue 6 thread', updatedAt: 3 }],
      runs: [{
        runId: 'run-6',
        threadId: 'thread-6',
        agent: 'claude',
        startedAt: 2,
        state: 'interrupted',
        live: false,
        interruptedByRestart: true,
        evidenceCount: 0,
      }],
      issues: [],
    });
    const item = result.items[0]!;

    assert.equal(item.group, 'active');
    assert.equal(item.action, 'continue');
    assert.equal(item.reasonCode, 'active-interrupted');
    assert.equal(item.linkedWork?.thread.threadId, 'thread-6');
    assert.match(item.reason, /same thread/);
  });

  test('marks the canonical thread Working when any parallel run is still live', () => {
    const result = project(issue(8), {
      linkedThreads: [{ threadId: 'thread-8', workItemId: 'work-8', title: 'Parallel work', updatedAt: 8 }],
      runs: [
        {
          runId: 'run-older-live',
          threadId: 'thread-8',
          agent: 'claude',
          startedAt: 2,
          state: 'running',
          live: true,
          interruptedByRestart: false,
          evidenceCount: 0,
        },
        {
          runId: 'run-newer-complete',
          threadId: 'thread-8',
          agent: 'codex',
          startedAt: 3,
          state: 'completed',
          live: false,
          interruptedByRestart: false,
          evidenceCount: 0,
        },
      ],
    });
    const item = result.items[0]!;

    assert.equal(item.statusLabel, 'Working');
    assert.match(item.reason, /currently working/);
    assert.equal(item.linkedWork?.latestRun?.runId, 'run-newer-complete');
  });

  test('does not infer a blocker from issue prose because only labels reach routing', () => {
    const issueWithProse = Object.assign(issue(7), { body: 'Blocked by the deployment dependency.' });
    const result = project(issueWithProse);
    const item = result.items[0]!;
    assert.equal(item.action, 'take');
    assert.equal(item.reasonCode, 'available');
  });
});
