import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  AgentAvailability,
  CatalogIssue,
  EffectiveWorkspace,
  IssueCatalogSource,
  WorkspaceRole,
  WorkspaceRoleSelection,
  WorkspaceProblem,
  WorkspaceResolution,
} from '@awos/protocol';
import { explainIssueRoute } from './issue-route-presentation.js';
import { projectIssueRoute } from './issue-route.js';

const capabilities = {
  streamingToolOutput: false,
  streamingText: false,
  reasoning: false,
  plans: false,
  turnDiff: false,
  approvals: false,
  resumableSessions: false,
};

const roles: WorkspaceRole[] = [
  { id: 'maintainer', label: 'Maintainer' },
  { id: 'reviewer', label: 'Reviewer' },
];

function workspace(
  routes: EffectiveWorkspace['routes'],
  steps: EffectiveWorkspace['steps'] = [
    { id: 'implement', action: 'Implement the issue', role: 'maintainer', workers: ['claude', 'codex'] },
  ],
  problems: WorkspaceProblem[] = [],
): WorkspaceResolution {
  const value: EffectiveWorkspace = {
    root: '/repo',
    name: 'Test project',
    repository: { root: '.', github: 'owner/repo' },
    agents: ['claude', 'codex', 'qwen-local'],
    setup: { command: '', timeoutMs: null },
    verify: [],
    integration: { requires: [], allowOverride: false },
    context: { references: [], notes: '' },
    roles,
    steps,
    routes,
    guardrails: [],
    origins: {
      name: 'shared', repository: 'shared', agents: 'shared', setup: 'default', verify: 'default',
      integration: 'default', context: 'default', roles: 'shared', steps: 'shared', routes: 'shared', guardrails: 'default',
    },
    sources: ['.awos/workspace.json'],
  };
  return { status: 'ok', workspace: value, problems };
}

function invalidWorkspace(): WorkspaceResolution {
  return {
    status: 'invalid',
    root: '/repo',
    problems: [{ severity: 'error', file: '.awos/workspace.json', path: 'routes', message: 'Fix the route declaration.' }],
  };
}

function issue(labels: string[]): CatalogIssue {
  return {
    number: 49,
    url: 'https://github.com/owner/repo/issues/49',
    title: 'Route this issue',
    state: 'OPEN',
    labels,
    assignees: [],
    updatedAt: '2026-08-24T10:00:00Z',
  };
}

function source(freshness: IssueCatalogSource['freshness']): IssueCatalogSource {
  return {
    workspaceRoot: '/repo',
    repository: 'owner/repo',
    freshness,
    complete: true,
    successfulAt: freshness === 'not-fetched' ? null : 1,
    issues: [issue(['bug'])],
    error: null,
  };
}

function selection(
  status: WorkspaceRoleSelection['status'],
  roleId: string | null = null,
  role: WorkspaceRole | null = null,
): WorkspaceRoleSelection {
  return { status, roleId, role };
}

function availability(profileId: AgentAvailability['profileId'], available: boolean): AgentAvailability {
  return {
    agent: profileId,
    profileId,
    label: profileId,
    adapterId: `${profileId}-adapter`,
    available,
    detail: available ? 'ready' : 'not installed',
    capabilities,
    model: 'test-model',
  };
}

function project(
  routes: EffectiveWorkspace['routes'],
  labels = ['bug'],
  freshness: IssueCatalogSource['freshness'] = 'current',
  role = selection('selected', 'maintainer', roles[0]),
  probes: readonly AgentAvailability[] = [availability('claude', true)],
): ReturnType<typeof projectIssueRoute> {
  return projectIssueRoute({
    workspace: workspace(routes),
    issue: issue(labels),
    source: source(freshness),
    roleSelection: role,
    availability: probes,
  });
}

describe('projectIssueRoute', () => {
  test('matches all, any, and none labels exactly', () => {
    const routes = [{
      id: 'bug-route',
      match: { allLabels: ['bug', 'backend'], anyLabels: ['urgent', 'customer'], noneLabels: ['blocked'] },
      step: 'implement',
    }];

    assert.equal(project(routes, ['bug', 'backend', 'customer']).route.status, 'routed');
    assert.equal(project(routes, ['bug', 'backend', 'urgent', 'blocked']).route.status, 'unrouted');
    assert.equal(project(routes, ['bug', 'backend', 'internal']).route.status, 'unrouted');
    assert.equal(project(routes, ['bug', 'customer']).route.status, 'unrouted');
  });

  test('evaluates zero, one, and multiple routes without choosing by array order', () => {
    const first = { id: 'first', match: { anyLabels: ['bug'] }, step: 'implement' };
    const second = { id: 'second', match: { anyLabels: ['bug'] }, step: 'implement' };
    const one = project([first], ['bug']);
    const many = project([first, second], ['bug']);
    const reversed = project([second, first], ['bug']);

    assert.equal(project([], ['bug']).route.status, 'unrouted');
    assert.deepEqual(one.route, {
      status: 'routed', matchingRouteIds: ['first'], routeId: 'first', stepId: 'implement', workspaceProblems: [],
    });
    assert.equal(many.route.status, 'conflicted');
    assert.deepEqual(many.route.matchingRouteIds, ['first', 'second']);
    assert.deepEqual(reversed.route, many.route);
  });

  test('retains invalid workspace problems', () => {
    const invalid = invalidWorkspace();
    const result = projectIssueRoute({
      workspace: invalid, issue: issue(['bug']), source: source('current'),
      roleSelection: selection('needs-selection'), availability: [],
    });

    assert.equal(result.route.status, 'invalid-workspace');
    assert.equal(invalid.status, 'invalid');
    assert.deepEqual(result.route.workspaceProblems, invalid.problems);
    assert.equal(result.action.status, 'not-routed');
    assert.equal(result.action.reason, 'invalid-workspace');
  });

  test('keeps route diagnosis while cached or unfetched source requires refresh', () => {
    for (const freshness of ['cached', 'not-fetched'] as const) {
      const result = project([{ id: 'bug', match: { anyLabels: ['bug'] }, step: 'implement' }], ['bug'], freshness);
      assert.equal(result.route.status, 'routed');
      assert.equal(result.route.routeId, 'bug');
      assert.equal(result.action.status, 'refresh-required');
      assert.equal(result.sourceFreshness, freshness);
    }
    assert.equal(project([{ id: 'bug', match: { anyLabels: ['bug'] }, step: 'implement' }]).action.status, 'available');
  });

  test('requires the exact responsible role and never guesses selection states', () => {
    const route = [{ id: 'bug', match: { anyLabels: ['bug'] }, step: 'implement' }];
    for (const status of ['needs-selection', 'stale', 'unconfigured'] as const) {
      const result = project(route, ['bug'], 'current', selection(status, status === 'stale' ? 'old-role' : null), []);
      assert.equal(result.action.status, 'role-required-or-mismatch');
      assert.equal(result.action.reason, 'role-required');
      assert.equal(result.action.roleSelection.status, status);
      assert.equal(result.action.responsibleRole?.id, 'maintainer');
    }
    const mismatch = project(route, ['bug'], 'current', selection('selected', 'reviewer', roles[1]), []);
    assert.equal(mismatch.action.reason, 'role-mismatch');
    assert.equal(project(route).action.status, 'available');
  });

  test('requires one current allowed worker and preserves missing or unavailable profiles', () => {
    const route = [{ id: 'bug', match: { anyLabels: ['bug'] }, step: 'implement' }];
    const available = project(route, ['bug'], 'current', undefined, [availability('codex', true)]);
    assert.equal(available.action.status, 'available');
    assert.deepEqual(available.action.allowedWorkerProfileIds, ['claude', 'codex']);
    assert.deepEqual(available.action.unavailableWorkerProfileIds, ['claude']);
    assert.deepEqual(available.action.availability.map((fact) => [fact.profileId, fact.available, fact.entries.length]), [
      ['claude', false, 0], ['codex', true, 1],
    ]);

    const unavailable = project(route, ['bug'], 'current', undefined, [availability('claude', false)]);
    assert.equal(unavailable.action.status, 'worker-unavailable');
    assert.deepEqual(unavailable.action.unavailableWorkerProfileIds, ['claude', 'codex']);
  });

  test('uses route, freshness, role, worker, then available precedence', () => {
    const route = [{ id: 'bug', match: { anyLabels: ['bug'] }, step: 'implement' }];
    assert.equal(project(route, ['other'], 'cached', selection('needs-selection'), []).action.reason, 'not-routed');
    assert.equal(project(route, ['bug'], 'cached', selection('needs-selection'), []).action.reason, 'refresh-required');
    assert.equal(project(route, ['bug'], 'current', selection('needs-selection'), []).action.reason, 'role-required');
    assert.equal(project(route, ['bug'], 'current', selection('selected', 'maintainer', roles[0]), []).action.reason, 'worker-unavailable');
    assert.equal(project(route).action.reason, 'available');
  });

  test('ignores body-like prose and uses labels only', () => {
    const issueWithProse = Object.assign(issue(['bug']), { body: 'blocked by an unrelated sentence' });
    const result = projectIssueRoute({
      workspace: workspace([{ id: 'bug', match: { anyLabels: ['bug'] }, step: 'implement' }]),
      issue: issueWithProse,
      source: source('current'),
      roleSelection: selection('selected', 'maintainer', roles[0]),
      availability: [availability('claude', true)],
    });
    assert.equal(result.route.status, 'routed');
  });
});

describe('explainIssueRoute', () => {
  test('keeps every structured reason explainable in plain language', () => {
    const route = [{ id: 'bug', match: { anyLabels: ['bug'] }, step: 'implement' }];
    const projections = [
      projectIssueRoute({ workspace: invalidWorkspace(), issue: issue(['bug']), source: source('current'), roleSelection: selection('needs-selection'), availability: [] }),
      project(route, ['other']),
      project([{ id: 'a', match: { anyLabels: ['bug'] }, step: 'implement' }, { id: 'b', match: { anyLabels: ['bug'] }, step: 'implement' }]),
      project(route, ['bug'], 'cached'),
      project(route, ['bug'], 'current', selection('needs-selection'), []),
      project(route, ['bug'], 'current', selection('selected', 'reviewer', roles[1]), []),
      project(route, ['bug'], 'current', undefined, []),
      project(route),
    ];

    assert.deepEqual(
      projections.map((projection) => projection.action.reason),
      ['invalid-workspace', 'not-routed', 'conflicted-route', 'refresh-required', 'role-required', 'role-mismatch', 'worker-unavailable', 'available'],
    );
    for (const projection of projections) {
      assert.ok(explainIssueRoute(projection).length > 0);
    }
    assert.match(explainIssueRoute(projections[3]!), /Refresh the issue catalog/);
    assert.match(explainIssueRoute(projections[4]!), /needs-selection/);
    assert.match(explainIssueRoute(projections[6]!), /No allowed worker/);
  });
});
