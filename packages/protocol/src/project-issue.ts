import type { CatalogFreshness, CatalogIssue, CatalogLinkedThread, CatalogRunEvidence } from './catalog.js';
import type { EvidenceItem, RunOutcome } from './evidence.js';
import type { IssueOpenRefusalCode } from './issue-open.js';
import type { IssueRouteProjection } from './issue-route.js';
import type { ProjectOverviewAction, ProjectOverviewReasonCode, ProjectOverviewWorker } from './project-overview.js';
import type { IssueSnapshot, WorkSourceError } from './work.js';

/** Where the detail body and metadata came from. No value here implies an editable copy. */
export type ProjectIssueDetailSourceKind = 'github' | 'work-item-snapshot' | 'catalog-metadata';
export type ProjectIssueAssigneeSource = 'catalog' | 'work-item-snapshot' | 'unavailable';

export interface ProjectIssueDetailSource {
  kind: ProjectIssueDetailSourceKind;
  /** Freshness of the body/metadata shown in `snapshot`. */
  freshness: CatalogFreshness;
  /** Freshness of the catalog used for route/action projection. */
  catalogFreshness: CatalogFreshness;
  fetchedAt: number | null;
  checkedAt: number | null;
  revision: string | null;
  /** Whether the assignee list is authoritative; WorkItem snapshots do not retain it. */
  assigneesKnown: boolean;
  assigneesSource: ProjectIssueAssigneeSource;
  error: WorkSourceError | null;
}

export interface ProjectIssueDetailAction {
  /** Core-owned action; the UI may render it but must not derive it from route fields. */
  action: ProjectOverviewAction;
  reasonCode: ProjectOverviewReasonCode;
  reason: string;
  projectAction: string | null;
  responsibleRole: { id: string; label: string } | null;
  workers: readonly ProjectOverviewWorker[];
  refusal: {
    code: IssueOpenRefusalCode;
    message: string;
  } | null;
}

export interface ProjectIssueRunHistory {
  run: CatalogRunEvidence;
  outcome: RunOutcome | null;
}

/** All local history for one linked thread, folded from its append-only event log. */
export interface ProjectIssueThreadHistory {
  thread: CatalogLinkedThread;
  runs: readonly ProjectIssueRunHistory[];
  evidence: readonly EvidenceItem[];
}

export type ProjectIssueTimelineKind = 'thread' | 'run' | 'outcome' | 'evidence';

/** A bounded, display-ready event in the issue's run/outcome/evidence history. */
export interface ProjectIssueTimelineEntry {
  id: string;
  kind: ProjectIssueTimelineKind;
  at: number;
  threadId: string;
  threadTitle: string;
  runId: string | null;
  run: CatalogRunEvidence | null;
  outcome: RunOutcome | null;
  evidence: EvidenceItem | null;
}

/** Core-owned detail projection for the persistent project-overview panel. */
export interface ProjectIssueDetail {
  cwd: string;
  issue: CatalogIssue;
  /** Null when GitHub detail could not be read and no linked WorkItem snapshot exists. */
  snapshot: IssueSnapshot | null;
  bodyTruncated: boolean;
  source: ProjectIssueDetailSource;
  route: IssueRouteProjection;
  action: ProjectIssueDetailAction;
  linkedThreads: readonly ProjectIssueThreadHistory[];
  canonicalThreadId: string | null;
  timeline: readonly ProjectIssueTimelineEntry[];
  historyTruncated: boolean;
}
