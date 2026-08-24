import type {
  AgentAvailability,
  CatalogIssue,
  EvidenceItem,
  IssueOpenRefusalCode,
  IssueCatalogSource,
  IssueSnapshot,
  ProjectIssueDetail,
  ProjectIssueDetailSource,
  ProjectIssueThreadHistory,
  ProjectIssueTimelineEntry,
  ProjectOverviewReasonCode,
  ProjectOverviewWorker,
  RunOutcome,
  WorkspaceResolution,
  WorkspaceRoleSelection,
} from '@awos/protocol';
import { explainIssueRoute } from './issue-route-presentation.js';
import { projectIssueRoute } from './issue-route.js';

/** Keep the panel readable without turning a source issue into a second document editor. */
export const PROJECT_ISSUE_DETAIL_BODY_MAX_CHARS = 12_000;
const PROJECT_ISSUE_DETAIL_THREAD_LIMIT = 50;
const PROJECT_ISSUE_DETAIL_TIMELINE_LIMIT = 200;

export interface ProjectIssueDetailProjectionInput {
  cwd: string;
  workspace: WorkspaceResolution;
  issue: CatalogIssue;
  /** The current catalog row kept separate from fetched detail metadata. */
  catalogIssue: CatalogIssue | null;
  snapshot: IssueSnapshot | null;
  source: ProjectIssueDetailSource;
  routeSource: IssueCatalogSource;
  roleSelection: WorkspaceRoleSelection;
  availability: readonly AgentAvailability[];
  workerLabels: Readonly<Record<string, string>>;
  linkedThreads: readonly ProjectIssueThreadHistory[];
}

/**
 * Project one issue into the persistent detail surface.
 *
 * Routing, refusal, canonical-thread selection, restart interpretation, and history folding
 * all arrive here as core-owned facts. The React panel only renders this result.
 */
export function projectProjectIssueDetail(input: ProjectIssueDetailProjectionInput): ProjectIssueDetail {
  const route = projectIssueRoute({
    workspace: input.workspace,
    issue: input.issue,
    source: input.routeSource,
    roleSelection: input.roleSelection,
    availability: input.availability,
  });
  const sortedThreads = [...input.linkedThreads].sort(compareThreads);
  const visibleThreads = sortedThreads.slice(0, PROJECT_ISSUE_DETAIL_THREAD_LIMIT);
  const canonicalThread = visibleThreads[0] ?? null;
  const canonicalLatestRun = canonicalThread === null ? null : latestRun(canonicalThread);
  const interrupted = canonicalLatestRun?.run.interruptedByRestart === true || canonicalLatestRun?.run.state === 'interrupted';
  const workers = projectWorkers(route, input.workerLabels);
  const routingChanged = fetchedRoutingIdentityChanged(input);
  const action = projectAction({
    issue: input.issue,
    route,
    workers,
    roleSelection: input.roleSelection,
    canonicalThread,
    interrupted,
    routingChanged,
  });
  const timeline = buildTimeline(visibleThreads);

  const body = capBody(input.snapshot?.body ?? '');
  return {
    cwd: input.cwd,
    issue: input.issue,
    snapshot: input.snapshot === null ? null : { ...input.snapshot, body: body.text },
    bodyTruncated: input.snapshot !== null && body.truncated,
    source: input.source,
    route,
    action,
    linkedThreads: visibleThreads,
    canonicalThreadId: canonicalThread?.thread.threadId ?? null,
    timeline: timeline.slice(0, PROJECT_ISSUE_DETAIL_TIMELINE_LIMIT),
    historyTruncated:
      sortedThreads.length > visibleThreads.length || timeline.length > PROJECT_ISSUE_DETAIL_TIMELINE_LIMIT,
  };
}

function projectAction(input: {
  issue: CatalogIssue;
  route: ReturnType<typeof projectIssueRoute>;
  workers: readonly ProjectOverviewWorker[];
  roleSelection: WorkspaceRoleSelection;
  canonicalThread: ProjectIssueThreadHistory | null;
  interrupted: boolean;
  routingChanged: boolean;
}): ProjectIssueDetail['action'] {
  const { issue, route, workers, canonicalThread, interrupted, routingChanged } = input;
  const projectAction = route.action.projectAction;
  const responsibleRole = route.action.responsibleRole;

  if (canonicalThread !== null) {
    return {
      action: 'continue',
      reasonCode: interrupted ? 'active-interrupted' : 'active',
      reason: interrupted
        ? 'The last local run was interrupted by restart. Continue reopens the same thread.'
        : 'A linked local thread is ready to continue.',
      projectAction,
      responsibleRole,
      workers,
      refusal: null,
    };
  }

  if (routingChanged) {
    const reason = 'Refresh the issue catalog before taking this issue: fetched detail labels, state, or revision differ from the current catalog row.';
    return {
      action: 'none',
      reasonCode: 'refresh-required',
      reason,
      projectAction: route.action.projectAction,
      responsibleRole: route.action.responsibleRole,
      workers,
      refusal: { code: 'route-changed', message: reason },
    };
  }

  if (issue.state !== 'OPEN') {
    return {
      action: 'none',
      reasonCode: 'closed',
      reason: 'This issue is closed on the source and cannot be taken as new work.',
      projectAction: null,
      responsibleRole: null,
      workers: [],
      refusal: { code: 'issue-not-open', message: 'This issue is closed on the source and cannot be taken as new work.' },
    };
  }

  const reasonCode = route.action.reason as ProjectOverviewReasonCode;
  const reason = explainIssueRoute(route);
  const takeable = reasonCode === 'available';
  return {
    action: takeable ? 'take' : 'none',
    reasonCode,
    reason,
    projectAction,
    responsibleRole,
    workers,
    refusal: takeable ? null : { code: refusalCode(reasonCode), message: reason },
  };
}

function refusalCode(reason: ProjectOverviewReasonCode): IssueOpenRefusalCode {
  switch (reason) {
    case 'invalid-workspace': return 'route-invalid';
    case 'not-routed': return 'route-unrouted';
    case 'conflicted-route': return 'route-conflict';
    case 'refresh-required': return 'catalog-not-current';
    case 'role-required': return 'role-required';
    case 'role-mismatch': return 'role-mismatch';
    case 'worker-unavailable': return 'workers-unavailable';
    case 'closed': return 'issue-not-open';
    case 'available': return 'route-invalid';
    case 'active':
    case 'active-interrupted':
      return 'route-invalid';
  }
}

function fetchedRoutingIdentityChanged(input: ProjectIssueDetailProjectionInput): boolean {
  if (input.source.kind !== 'github' || input.catalogIssue === null) return false;
  const fetchedRevision = input.snapshot?.revision ?? '';
  const fetchedState = normalizeState(input.issue.state);
  return (
    fetchedState === null ||
    input.catalogIssue.state !== fetchedState ||
    !sameLabels(input.catalogIssue.labels, input.issue.labels) ||
    fetchedRevision === '' ||
    input.catalogIssue.updatedAt !== fetchedRevision
  );
}

function normalizeState(state: string): CatalogIssue['state'] | null {
  const normalized = state.toUpperCase();
  return normalized === 'OPEN' || normalized === 'CLOSED' ? normalized : null;
}

function sameLabels(left: readonly string[], right: readonly string[]): boolean {
  return [...new Set(left)].sort().join('\u0000') === [...new Set(right)].sort().join('\u0000');
}

function projectWorkers(
  route: ReturnType<typeof projectIssueRoute>,
  labels: Readonly<Record<string, string>>,
): readonly ProjectOverviewWorker[] {
  return route.action.allowedWorkerProfileIds.map((profileId) => {
    const fact = route.action.availability.find((candidate) => candidate.profileId === profileId);
    return {
      profileId,
      label: fact?.entries[0]?.label ?? labels[profileId] ?? profileId,
      // This is a core-projected display fact, not a client-side routing authority.
      available: fact?.available === true,
    };
  });
}

function compareThreads(a: ProjectIssueThreadHistory, b: ProjectIssueThreadHistory): number {
  return b.thread.updatedAt - a.thread.updatedAt || a.thread.threadId.localeCompare(b.thread.threadId);
}

function latestRun(thread: ProjectIssueThreadHistory): ProjectIssueThreadHistory['runs'][number] | null {
  return [...thread.runs].sort(
    (a, b) => b.run.startedAt - a.run.startedAt || a.run.runId.localeCompare(b.run.runId),
  )[0] ?? null;
}

function buildTimeline(threads: readonly ProjectIssueThreadHistory[]): ProjectIssueTimelineEntry[] {
  const entries: ProjectIssueTimelineEntry[] = [];
  for (const history of threads) {
    entries.push({
      id: `thread:${history.thread.threadId}`,
      kind: 'thread',
      at: history.thread.updatedAt,
      threadId: history.thread.threadId,
      threadTitle: history.thread.title,
      runId: null,
      run: null,
      outcome: null,
      evidence: null,
    });
    for (const runHistory of history.runs) {
      entries.push({
        id: `run:${runHistory.run.runId}`,
        kind: 'run',
        at: runHistory.run.startedAt,
        threadId: history.thread.threadId,
        threadTitle: history.thread.title,
        runId: runHistory.run.runId,
        run: runHistory.run,
        outcome: null,
        evidence: null,
      });
      if (runHistory.outcome !== null) entries.push(outcomeEntry(history, runHistory.outcome));
    }
    for (const evidence of history.evidence) entries.push(evidenceEntry(history, evidence));
  }
  return entries.sort((a, b) => b.at - a.at || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

function outcomeEntry(
  history: ProjectIssueThreadHistory,
  outcome: RunOutcome,
): ProjectIssueTimelineEntry {
  return {
    id: `outcome:${outcome.runId}:${outcome.at}`,
    kind: 'outcome',
    at: outcome.at,
    threadId: history.thread.threadId,
    threadTitle: history.thread.title,
    runId: outcome.runId,
    run: null,
    outcome,
    evidence: null,
  };
}

function evidenceEntry(
  history: ProjectIssueThreadHistory,
  evidence: EvidenceItem,
): ProjectIssueTimelineEntry {
  return {
    id: `evidence:${evidence.id}`,
    kind: 'evidence',
    at: evidence.at,
    threadId: history.thread.threadId,
    threadTitle: history.thread.title,
    runId: evidence.runId,
    run: null,
    outcome: null,
    evidence,
  };
}

function capBody(body: string): { text: string; truncated: boolean } {
  if (body.length <= PROJECT_ISSUE_DETAIL_BODY_MAX_CHARS) return { text: body, truncated: false };
  return {
    text: `${body.slice(0, PROJECT_ISSUE_DETAIL_BODY_MAX_CHARS)}\n\n_[Body truncated for this detail view.]_`,
    truncated: true,
  };
}
