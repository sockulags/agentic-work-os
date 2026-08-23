import type { AgentAvailability } from './rpc.js';
import type { WorkerProfileId } from './events.js';
import type { CatalogFreshness, CatalogIssue, IssueCatalogSource } from './catalog.js';
import type { WorkspaceRoleSelection } from './role-selection.js';
import type {
  WorkspaceProblem,
  WorkspaceResolution,
} from './workspace.js';

export type IssueRouteStatus = 'routed' | 'unrouted' | 'conflicted' | 'invalid-workspace';

export type IssueActionStatus =
  | 'available'
  | 'refresh-required'
  | 'role-required-or-mismatch'
  | 'worker-unavailable'
  | 'not-routed';

/** The structured primary reason selected by the deterministic precedence rules. */
export type IssueRouteReasonCode =
  | 'invalid-workspace'
  | 'not-routed'
  | 'conflicted-route'
  | 'refresh-required'
  | 'role-required'
  | 'role-mismatch'
  | 'worker-unavailable'
  | 'available';

export interface IssueRouteAvailabilityFact {
  profileId: WorkerProfileId;
  /** Zero entries means the current probe did not report this allowed profile. */
  entries: readonly AgentAvailability[];
  available: boolean;
}

export interface IssueRouteDiagnosis {
  status: IssueRouteStatus;
  /** Sorted so the diagnosis does not depend on declaration order when routes conflict. */
  matchingRouteIds: readonly string[];
  routeId: string | null;
  stepId: string | null;
  workspaceProblems: readonly WorkspaceProblem[];
}

export interface IssueActionProjection {
  status: IssueActionStatus;
  reason: IssueRouteReasonCode;
  projectAction: string | null;
  responsibleRole: { id: string; label: string } | null;
  allowedWorkerProfileIds: readonly WorkerProfileId[];
  availability: readonly IssueRouteAvailabilityFact[];
  unavailableWorkerProfileIds: readonly WorkerProfileId[];
  roleSelection: WorkspaceRoleSelection;
}

export interface IssueRouteProjection {
  sourceFreshness: CatalogFreshness;
  route: IssueRouteDiagnosis;
  action: IssueActionProjection;
}

export interface IssueRouteProjectionInput {
  workspace: WorkspaceResolution;
  issue: CatalogIssue;
  source: IssueCatalogSource;
  roleSelection: WorkspaceRoleSelection;
  /** Entries from one current worker-availability probe. */
  availability: readonly AgentAvailability[];
}
