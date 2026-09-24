import type { WorkerProfileId } from './events.js';
import type { WorkerDiagnostic } from './worker-health.js';
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
  /**
   * The core-owned capability and health projection for this allowed profile.
   *
   * Null only when the caller projected routing alone and asked for no worker projection;
   * it never means "healthy" or "missing". A surface that shows workers is given one
   * diagnostic per allowed profile, so absence is never the thing it reads.
   */
  diagnostic: WorkerDiagnostic | null;
  /** Mirrors `diagnostic.dispatchable`. False whenever there is no diagnostic. */
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
  /**
   * Worker diagnostics for the profiles this projection may allow.
   *
   * Empty projects routing only: every allowed worker is then reported without a
   * diagnostic and therefore as not dispatchable, which is what an unchecked worker is.
   */
  workerDiagnostics: readonly WorkerDiagnostic[];
}
