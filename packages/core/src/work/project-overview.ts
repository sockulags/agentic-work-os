import type {
  AgentAvailability,
  CatalogIssue,
  CatalogLinkedThread,
  CatalogRunEvidence,
  IssueCatalogSource,
  ProjectOverview,
  ProjectOverviewItem,
  ProjectOverviewLinkedWork,
  ProjectOverviewReasonCode,
  ProjectOverviewWorker,
  WorkspaceResolution,
  WorkspaceRoleSelection,
  WorkerProfileId,
} from '@awos/protocol';
import { projectIssueRoute } from './issue-route.js';

export interface ProjectOverviewEntry {
  issue: CatalogIssue;
  linkedThreads: readonly CatalogLinkedThread[];
  runs: readonly CatalogRunEvidence[];
}

export interface ProjectOverviewProjectionInput {
  cwd: string;
  workspace: Extract<WorkspaceResolution, { status: 'ok' }>;
  source: IssueCatalogSource;
  roleSelection: WorkspaceRoleSelection;
  availability: readonly AgentAvailability[];
  workerLabels: Readonly<Record<string, string>>;
  entries: readonly ProjectOverviewEntry[];
}

/**
 * Project the source catalog and local overlay into the compact product read model.
 *
 * This is intentionally separate from the RPC and the React surface. Route precedence,
 * source freshness, role selection, worker facts, and local continuation all meet here;
 * the UI receives plain actions and explanations rather than rebuilding those rules.
 */
export function projectProjectOverview(input: ProjectOverviewProjectionInput): ProjectOverview {
  const items = input.entries.map((entry) => projectItem(input, entry));

  return {
    cwd: input.cwd,
    workspace: {
      root: input.workspace.workspace.root,
      name: input.workspace.workspace.name,
      repository: input.workspace.workspace.repository.github,
      roles: input.workspace.workspace.roles,
    },
    roleSelection: input.roleSelection,
    source: input.source,
    items,
  };
}

function projectItem(
  input: ProjectOverviewProjectionInput,
  entry: ProjectOverviewEntry,
): ProjectOverviewItem {
  const projection = entry.issue.state === 'OPEN'
    ? projectIssueRoute({
        workspace: input.workspace,
        issue: entry.issue,
        source: input.source,
        roleSelection: input.roleSelection,
        availability: input.availability,
      })
    : null;
  const linkedWork = canonicalLinkedWork(entry.linkedThreads, entry.runs);
  if (linkedWork !== null) {
    const canonicalRuns = entry.runs.filter((run) => run.threadId === linkedWork.thread.threadId);
    const working = canonicalRuns.some((run) => run.live);
    const interrupted = !working && (linkedWork.latestRun?.interruptedByRestart === true ||
      linkedWork.latestRun?.state === 'interrupted');
    return {
      issue: entry.issue,
      group: 'active',
      statusLabel: interrupted ? 'Interrupted' : working ? 'Working' : 'Active',
      projectAction: projection?.action.projectAction ?? null,
      responsibleRole: projection?.action.responsibleRole ?? null,
      workers: projection === null
        ? []
        : projectWorkers(projection.action.allowedWorkerProfileIds, projection.action.availability, input.workerLabels),
      action: 'continue',
      reasonCode: interrupted ? 'active-interrupted' : 'active',
      reason: interrupted
        ? 'The last local run was interrupted by restart. Continue reopens the same thread.'
        : working
          ? 'A linked local thread is currently working. Continue reopens the same thread.'
          : 'A linked local thread is ready to continue.',
      linkedWork,
    };
  }

  if (entry.issue.state !== 'OPEN') {
    return {
      issue: entry.issue,
      group: 'blocked',
      statusLabel: 'Closed',
      projectAction: null,
      responsibleRole: null,
      workers: [],
      action: 'none',
      reasonCode: 'closed',
      reason: 'This issue is closed on the source and cannot be taken as new work.',
      linkedWork: null,
    };
  }

  // The non-local branch always has an open issue and therefore a route projection above.
  if (projection === null) throw new Error('An open project overview issue needs a route projection.');
  const workers = projectWorkers(projection.action.allowedWorkerProfileIds, projection.action.availability, input.workerLabels);
  const reasonCode = projectReasonCode(projection.action.reason);
  const roleLensRefusal = reasonCode === 'role-required' || reasonCode === 'role-mismatch';
  const isTakeable = reasonCode === 'available';

  return {
    issue: entry.issue,
    // Role mismatch remains in the available source lens, as in the accepted prototype:
    // it is visible work that becomes takeable when the local role changes, not a project
    // dependency or a generic blocked outcome.
    group: isTakeable || roleLensRefusal ? 'available' : 'blocked',
    statusLabel: statusLabel(reasonCode),
    projectAction: projection.action.projectAction,
    responsibleRole: projection.action.responsibleRole,
    workers,
    action: isTakeable ? 'take' : 'none',
    reasonCode,
    reason: explainProjectItem(projection.action.reason, projection.action.projectAction, projection.action.responsibleRole?.label, projection.action.roleSelection),
    linkedWork: null,
  };
}

function canonicalLinkedWork(
  linkedThreads: readonly CatalogLinkedThread[],
  runs: readonly CatalogRunEvidence[],
): ProjectOverviewLinkedWork | null {
  const thread = [...linkedThreads].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.threadId.localeCompare(b.threadId),
  )[0];
  if (thread === undefined) return null;

  const threadRuns = runs.filter((run) => run.threadId === thread.threadId);
  const latestRun = [...threadRuns]
    .sort((a, b) => b.startedAt - a.startedAt || a.runId.localeCompare(b.runId))[0] ?? null;
  return { thread, latestRun };
}

function projectWorkers(
  allowed: readonly WorkerProfileId[],
  availability: readonly {
    profileId: WorkerProfileId;
    entries: readonly AgentAvailability[];
    available: boolean;
  }[],
  labels: Readonly<Record<string, string>>,
): readonly ProjectOverviewWorker[] {
  return allowed.map((profileId) => {
    const fact = availability.find((candidate) => candidate.profileId === profileId);
    const label = fact?.entries[0]?.label ?? labels[profileId] ?? profileId;
    return { profileId, label, available: fact?.available === true };
  });
}

function projectReasonCode(reason: string): ProjectOverviewReasonCode {
  return reason as ProjectOverviewReasonCode;
}

function statusLabel(reason: ProjectOverviewReasonCode): string {
  switch (reason) {
    case 'available': return 'Ready';
    case 'role-required': return 'Role required';
    case 'role-mismatch': return 'Role mismatch';
    case 'refresh-required': return 'Refresh required';
    case 'worker-unavailable': return 'Worker unavailable';
    case 'not-routed': return 'No route';
    case 'conflicted-route': return 'Route conflict';
    case 'invalid-workspace': return 'Workspace needs attention';
    case 'closed': return 'Closed';
    case 'active': return 'Active';
    case 'active-interrupted': return 'Interrupted';
  }
}

function explainProjectItem(
  reason: string,
  action: string | null,
  roleLabel: string | undefined,
  selection: WorkspaceRoleSelection,
): string {
  switch (reason) {
    case 'available':
      return `Ready to take${action === null ? '' : `: ${action}`}.`;
    case 'refresh-required':
      return `Refresh GitHub before taking${action === null ? ' new work' : ` ${action}`}.`;
    case 'role-required':
      return `Select the ${roleLabel ?? 'required'} role before taking${action === null ? ' this work' : ` ${action}`}.`;
    case 'role-mismatch': {
      const selected = selection.role?.label ?? selection.roleId ?? 'another role';
      return `This work belongs to ${roleLabel ?? 'another role'}; the selected role is ${selected}.`;
    }
    case 'worker-unavailable':
      return `No allowed worker is available for the ${roleLabel ?? 'responsible'} role.`;
    case 'not-routed':
      return 'No project action matches this issue.';
    case 'conflicted-route':
      return 'More than one project action matches this issue, so no action was selected.';
    case 'invalid-workspace':
      return 'The workspace declaration needs attention before this issue can be taken.';
    default:
      return 'This issue cannot be taken as new work.';
  }
}
