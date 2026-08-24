import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  AgentAvailability,
  CatalogIssue,
  EvidenceItem,
  IssueCatalogSource,
  IssueSnapshot,
  ProjectIssueDetailSource,
  ProjectIssueThreadHistory,
  WorkspaceResolution,
  WorkspaceRoleSelection,
} from '@awos/protocol';
import { projectProjectIssueDetail, PROJECT_ISSUE_DETAIL_BODY_MAX_CHARS } from './project-issue.js';

const capabilities = {
  streamingToolOutput: false,
  streamingText: false,
  reasoning: false,
  plans: false,
  turnDiff: false,
  approvals: false,
  resumableSessions: false,
};

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
    roles: [{ id: 'implementer', label: 'Implementer' }],
    steps: [{ id: 'implement', action: 'Implement issue', role: 'implementer', workers: ['claude'] }],
    routes: [{ id: 'bug', match: { anyLabels: ['bug'] }, step: 'implement' }],
    guardrails: [],
    origins: {
      name: 'shared', repository: 'shared', agents: 'shared', setup: 'default', verify: 'default',
      integration: 'default', context: 'default', roles: 'shared', steps: 'shared', routes: 'shared', guardrails: 'default',
    },
    sources: ['.awos/workspace.json'],
  },
};

function issue(number = 1, labels = ['bug']): CatalogIssue {
  return {
    number,
    url: `https://github.com/owner/repo/issues/${number}`,
    title: `Issue ${number}`,
    state: 'OPEN',
    labels,
    assignees: ['lucas'],
    updatedAt: '2026-08-24T10:00:00Z',
  };
}

function source(freshness: IssueCatalogSource['freshness'] = 'current', currentIssue = issue()): IssueCatalogSource {
  return {
    workspaceRoot: '/repo',
    repository: 'owner/repo',
    freshness,
    complete: true,
    successfulAt: 10,
    issues: [currentIssue],
    error: freshness === 'current' ? null : { kind: 'offline', message: 'GitHub is unavailable.', retryable: true },
  };
}

function detailSource(overrides: Partial<ProjectIssueDetailSource> = {}): ProjectIssueDetailSource {
  return {
    kind: 'github',
    freshness: 'current',
    catalogFreshness: 'current',
    fetchedAt: 20,
    checkedAt: 20,
    revision: '2026-08-24T10:00:00Z',
    assigneesKnown: true,
    assigneesSource: 'catalog',
    error: null,
    ...overrides,
  };
}

function roleSelection(): WorkspaceRoleSelection {
  return { status: 'selected', roleId: 'implementer', role: { id: 'implementer', label: 'Implementer' } };
}

function availability(available: boolean): AgentAvailability {
  return {
    agent: 'claude',
    profileId: 'claude',
    label: 'Claude',
    adapterId: 'claude-adapter',
    available,
    detail: available ? 'ready' : 'not installed',
    capabilities,
    model: 'test-model',
  };
}

function snapshot(body: string): IssueSnapshot {
  return {
    title: 'A long issue title that remains source-owned',
    body,
    state: 'OPEN',
    labels: ['bug'],
    author: 'lucas',
    revision: '2026-08-24T10:00:00Z',
  };
}

function evidence(id: string, threadId: string, runId: string, at: number): EvidenceItem {
  return {
    id,
    runId,
    workItemId: 'work-1',
    threadId,
    kind: 'command',
    ref: { eventId: null, url: null, label: 'npm test' },
    summary: `Evidence ${id}`,
    state: { commit: 'commit-1', tree: 'tree-1', dirty: false },
    check: { name: 'test', passed: true, exitCode: 0 },
    source: 'claude',
    at,
  };
}

function project(overrides: Partial<Parameters<typeof projectProjectIssueDetail>[0]> = {}) {
  const currentIssue = overrides.issue ?? issue();
  const currentSource = overrides.routeSource ?? source('current', currentIssue);
  return projectProjectIssueDetail({
    cwd: '/repo',
    workspace,
    issue: currentIssue,
    catalogIssue: currentIssue,
    snapshot: snapshot('body'),
    source: detailSource(),
    routeSource: currentSource,
    roleSelection: roleSelection(),
    availability: [availability(true)],
    workerLabels: { claude: 'Claude' },
    linkedThreads: [],
    ...overrides,
  });
}

describe('project issue detail projection', () => {
  test('keeps source body bounded and projects canonical thread plus full run history', () => {
    const longBody = 'x'.repeat(PROJECT_ISSUE_DETAIL_BODY_MAX_CHARS + 40);
    const olderRun = {
      run: {
        runId: 'run-old', threadId: 'thread-old', agent: 'claude' as const, startedAt: 15,
        state: 'completed' as const, live: false, interruptedByRestart: false, evidenceCount: 1,
      },
      outcome: { runId: 'run-old', claim: 'partial' as const, statement: 'Partial outcome', source: 'claude' as const, at: 16 },
    };
    const newerInterruptedRun = {
      run: {
        runId: 'run-new', threadId: 'thread-new', agent: 'claude' as const, startedAt: 30,
        state: 'interrupted' as const, live: false, interruptedByRestart: true, evidenceCount: 1,
      },
      outcome: null,
    };
    const histories: ProjectIssueThreadHistory[] = [
      {
        thread: { threadId: 'thread-old', workItemId: 'work-1', title: 'Older thread', updatedAt: 20 },
        runs: [olderRun],
        evidence: [evidence('e-old', 'thread-old', 'run-old', 17)],
      },
      {
        thread: { threadId: 'thread-new', workItemId: 'work-1', title: 'Newest thread', updatedAt: 30 },
        runs: [newerInterruptedRun],
        evidence: [evidence('e-new', 'thread-new', 'run-new', 31)],
      },
    ];

    const result = project({ snapshot: snapshot(longBody), linkedThreads: histories });

    assert.equal(result.snapshot?.body.length, PROJECT_ISSUE_DETAIL_BODY_MAX_CHARS + '\n\n_[Body truncated for this detail view.]_'.length);
    assert.equal(result.bodyTruncated, true);
    assert.equal(result.canonicalThreadId, 'thread-new');
    assert.equal(result.action.action, 'continue');
    assert.equal(result.action.reasonCode, 'active-interrupted');
    assert.equal(result.timeline.filter((entry) => entry.kind === 'thread').length, 2);
    assert.equal(result.timeline.filter((entry) => entry.kind === 'run').length, 2);
    assert.equal(result.timeline.filter((entry) => entry.kind === 'outcome').length, 1);
    assert.equal(result.timeline.filter((entry) => entry.kind === 'evidence').length, 2);
  });

  test('keeps no-route, conflict, unavailable-worker, and workspace-precondition refusals structured', () => {
    const noRoute = project({ issue: issue(2, ['other']), routeSource: source('current', issue(2, ['other'])) });
    assert.equal(noRoute.action.action, 'none');
    assert.equal(noRoute.action.reasonCode, 'not-routed');
    assert.equal(noRoute.action.refusal?.code, 'route-unrouted');

    const conflictedWorkspace = {
      ...workspace,
      workspace: {
        ...workspace.workspace,
        routes: [
          { id: 'a', match: { anyLabels: ['bug'] }, step: 'implement' },
          { id: 'b', match: { anyLabels: ['bug'] }, step: 'implement' },
        ],
      },
    } as typeof workspace;
    const conflict = project({
      workspace: conflictedWorkspace,
      routeSource: source('current'),
    });
    assert.equal(conflict.action.reasonCode, 'conflicted-route');
    assert.equal(conflict.action.refusal?.code, 'route-conflict');

    const unavailable = project({ availability: [availability(false)] });
    assert.equal(unavailable.action.reasonCode, 'worker-unavailable');
    assert.equal(unavailable.action.refusal?.code, 'workers-unavailable');
    assert.equal(unavailable.action.workers[0]?.available, false);

    const invalidWorkspace = { status: 'invalid', problems: [{ path: 'routes', message: 'Route is invalid.' }] } as WorkspaceResolution;
    const invalid = project({ workspace: invalidWorkspace });
    assert.equal(invalid.route.route.status, 'invalid-workspace');
    assert.equal(invalid.action.reasonCode, 'invalid-workspace');
    assert.equal(invalid.action.refusal?.code, 'route-invalid');
  });

  test('keeps fetched route diagnosis visible but refuses Take when catalog identity drifted', () => {
    const driftWorkspace = {
      ...workspace,
      workspace: {
        ...workspace.workspace,
        routes: [{ id: 'review', match: { anyLabels: ['review'] }, step: 'implement' }],
      },
    } as typeof workspace;
    const catalogIssue = issue(103, ['other']);
    const fetchedIssue = { ...issue(103, ['review']), updatedAt: '2026-08-24T11:00:00Z' };
    const result = project({
      workspace: driftWorkspace,
      issue: fetchedIssue,
      catalogIssue,
      routeSource: source('current', fetchedIssue),
      source: detailSource({ revision: fetchedIssue.updatedAt }),
      snapshot: { ...snapshot('Fetched detail body'), labels: ['review'], revision: fetchedIssue.updatedAt },
    });

    assert.equal(result.route.route.status, 'routed');
    assert.deepEqual(result.route.route.matchingRouteIds, ['review']);
    assert.equal(result.action.action, 'none');
    assert.equal(result.action.reasonCode, 'refresh-required');
    assert.equal(result.action.refusal?.code, 'route-changed');
    assert.match(result.action.reason, /Refresh the issue catalog/);

    const agreed = project({
      workspace: driftWorkspace,
      issue: fetchedIssue,
      catalogIssue: fetchedIssue,
      routeSource: source('current', fetchedIssue),
      source: detailSource({ revision: fetchedIssue.updatedAt }),
      snapshot: { ...snapshot('Fetched detail body'), labels: ['review'], revision: fetchedIssue.updatedAt },
    });
    assert.equal(agreed.action.action, 'take');
  });

  test('requires refresh for cached source but keeps Continue for linked work', () => {
    const result = project({
      routeSource: source('cached'),
      source: detailSource({ kind: 'work-item-snapshot', freshness: 'cached', catalogFreshness: 'cached', error: { kind: 'offline', message: 'Offline', retryable: true } }),
      linkedThreads: [{
        thread: { threadId: 'thread-1', workItemId: 'work-1', title: 'Existing local thread', updatedAt: 10 },
        runs: [],
        evidence: [],
      }],
    });

    assert.equal(result.action.action, 'continue');
    assert.equal(result.action.reasonCode, 'active');
    assert.equal(result.source.freshness, 'cached');
    assert.equal(result.source.catalogFreshness, 'cached');
  });
});
