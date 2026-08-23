import type {
  CatalogIssue,
  IssueActionProjection,
  IssueRouteAvailabilityFact,
  IssueRouteProjection,
  IssueRouteProjectionInput,
  AgentAvailability,
  WorkspaceRoleSelection,
  WorkspaceRouteMatch,
  WorkerProfileId,
} from '@awos/protocol';

/**
 * Project one catalog issue into route diagnosis and action availability.
 *
 * The action precedence is deliberate and stable: invalid workspace or no unique route,
 * stale source, role requirement or mismatch, unavailable workers, then available.
 * Route diagnosis is calculated independently, so cached source can still show its route
 * while correctly refusing to call the action current.
 */
export function projectIssueRoute(input: IssueRouteProjectionInput): IssueRouteProjection {
  const diagnosis = diagnoseRoute(input.workspace, input.issue);
  const baseAction = emptyAction(input.roleSelection);

  if (diagnosis.status === 'invalid-workspace') {
    return { sourceFreshness: input.source.freshness, route: diagnosis, action: {
      ...baseAction,
      status: 'not-routed',
      reason: 'invalid-workspace',
    } };
  }

  if (diagnosis.status !== 'routed') {
    return { sourceFreshness: input.source.freshness, route: diagnosis, action: {
      ...baseAction,
      status: 'not-routed',
      reason: diagnosis.status === 'conflicted' ? 'conflicted-route' : 'not-routed',
    } };
  }

  if (input.workspace.status !== 'ok') {
    const invalidDiagnosis = {
      ...diagnosis,
      status: 'invalid-workspace' as const,
    };
    return { sourceFreshness: input.source.freshness, route: invalidDiagnosis, action: {
      ...baseAction,
      status: 'not-routed',
      reason: 'invalid-workspace',
    } };
  }
  const workspace = input.workspace.workspace;
  const route = workspace.routes.find((candidate) => candidate.id === diagnosis.routeId);
  const step = workspace.steps.find((candidate) => candidate.id === route?.step);
  const role = workspace.roles.find((candidate) => candidate.id === step?.role);

  // A resolved workspace guarantees these references. Keeping the guard makes the pure
  // projection total if a caller supplies a hand-built resolved value in a test or adapter.
  if (!route || !step || !role) {
    return { sourceFreshness: input.source.freshness, route: {
      ...diagnosis,
      status: 'invalid-workspace',
      workspaceProblems: diagnosis.workspaceProblems,
    }, action: { ...baseAction, status: 'not-routed', reason: 'invalid-workspace' } };
  }

  const availability = buildAvailabilityFacts(step.workers, input.availability);
  const unavailableWorkerProfileIds = availability
    .filter((fact) => !fact.available)
    .map((fact) => fact.profileId);
  const routedAction: IssueActionProjection = {
    ...baseAction,
    projectAction: step.action,
    responsibleRole: { id: role.id, label: role.label },
    allowedWorkerProfileIds: [...step.workers],
    availability,
    unavailableWorkerProfileIds,
  };

  if (input.source.freshness !== 'current') {
    return { sourceFreshness: input.source.freshness, route: diagnosis, action: {
      ...routedAction,
      status: 'refresh-required',
      reason: 'refresh-required',
    } };
  }

  const roleReason = roleSelectionReason(input.roleSelection, role.id);
  if (roleReason !== null) {
    return { sourceFreshness: input.source.freshness, route: diagnosis, action: {
      ...routedAction,
      status: 'role-required-or-mismatch',
      reason: roleReason,
    } };
  }

  if (unavailableWorkerProfileIds.length === step.workers.length) {
    return { sourceFreshness: input.source.freshness, route: diagnosis, action: {
      ...routedAction,
      status: 'worker-unavailable',
      reason: 'worker-unavailable',
    } };
  }

  return { sourceFreshness: input.source.freshness, route: diagnosis, action: {
    ...routedAction,
    status: 'available',
    reason: 'available',
  } };
}

function diagnoseRoute(
  workspaceResolution: IssueRouteProjectionInput['workspace'],
  issue: CatalogIssue,
): IssueRouteProjection['route'] {
  if (workspaceResolution.status !== 'ok') {
    return {
      status: 'invalid-workspace',
      matchingRouteIds: [],
      routeId: null,
      stepId: null,
      workspaceProblems: workspaceResolution.status === 'invalid' ? [...workspaceResolution.problems] : [],
    };
  }

  const workspace = workspaceResolution.workspace;
  const matchingRouteIds = workspace.routes
    .filter((route) => matches(route.match, issue.labels))
    .map((route) => route.id)
    .sort();

  if (matchingRouteIds.length !== 1) {
    return {
      status: matchingRouteIds.length === 0 ? 'unrouted' : 'conflicted',
      matchingRouteIds,
      routeId: null,
      stepId: null,
      workspaceProblems: [...workspaceResolution.problems],
    };
  }

  const routeId = matchingRouteIds[0] as string;
  const route = workspace.routes.find((candidate) => candidate.id === routeId);
  return {
    status: 'routed',
    matchingRouteIds,
    routeId,
    stepId: route?.step ?? null,
    workspaceProblems: [...workspaceResolution.problems],
  };
}

function matches(match: WorkspaceRouteMatch, labels: readonly string[]): boolean {
  const present = new Set(labels);
  return (
    (match.allLabels ?? []).every((label) => present.has(label)) &&
    ((match.anyLabels ?? []).length === 0 || (match.anyLabels ?? []).some((label) => present.has(label))) &&
    (match.noneLabels ?? []).every((label) => !present.has(label))
  );
}

function buildAvailabilityFacts(
  allowedWorkerProfileIds: readonly WorkerProfileId[],
  entries: readonly AgentAvailability[],
): readonly IssueRouteAvailabilityFact[] {
  return allowedWorkerProfileIds.map((profileId) => {
    const matchingEntries = entries.filter((entry) => entry.profileId === profileId);
    return {
      profileId,
      entries: matchingEntries,
      available: matchingEntries.some((entry) => entry.available),
    };
  });
}

function emptyAction(roleSelection: WorkspaceRoleSelection): IssueActionProjection {
  return {
    status: 'not-routed',
    reason: 'not-routed',
    projectAction: null,
    responsibleRole: null,
    allowedWorkerProfileIds: [],
    availability: [],
    unavailableWorkerProfileIds: [],
    roleSelection,
  };
}

function roleSelectionReason(
  selection: WorkspaceRoleSelection,
  requiredRoleId: string,
): 'role-required' | 'role-mismatch' | null {
  if (selection.status !== 'selected' || selection.roleId === null || selection.role?.id !== requiredRoleId) {
    return selection.status === 'selected' ? 'role-mismatch' : 'role-required';
  }
  return null;
}
