import type {
  CatalogIssue,
  CatalogLinkedThread,
  CatalogRunEvidence,
  IssueCatalogSource,
} from './catalog.js';
import type { IssueRouteReasonCode } from './issue-route.js';
import type { WorkspaceRole } from './workspace.js';
import type { WorkspaceRoleSelection } from './role-selection.js';
import type { WorkerProfileId } from './events.js';

/** The three user-facing lanes in the project overview. */
export type ProjectOverviewGroup = 'available' | 'active' | 'blocked';

/** The only verbs the overview can expose. None means the row is a refusal. */
export type ProjectOverviewAction = 'take' | 'continue' | 'none';

export type ProjectOverviewReasonCode = IssueRouteReasonCode | 'closed' | 'active' | 'active-interrupted';

/** The worker facts needed for a compact row without exposing adapter/runtime details. */
export interface ProjectOverviewWorker {
  profileId: WorkerProfileId;
  label: string;
  available: boolean;
}

/** The local destination that makes Continue source-independent. */
export interface ProjectOverviewLinkedWork {
  thread: CatalogLinkedThread;
  latestRun: CatalogRunEvidence | null;
}

/** One issue after the core has applied routing, role, source, worker, and local overlay rules. */
export interface ProjectOverviewItem {
  issue: CatalogIssue;
  group: ProjectOverviewGroup;
  statusLabel: string;
  projectAction: string | null;
  responsibleRole: { id: string; label: string } | null;
  workers: readonly ProjectOverviewWorker[];
  action: ProjectOverviewAction;
  reasonCode: ProjectOverviewReasonCode;
  reason: string;
  linkedWork: ProjectOverviewLinkedWork | null;
}

/** The read model for one nearest workspace. */
export interface ProjectOverview {
  cwd: string;
  workspace: {
    root: string;
    name: string;
    repository: string | null;
    roles: readonly WorkspaceRole[];
  };
  roleSelection: WorkspaceRoleSelection;
  source: IssueCatalogSource;
  items: readonly ProjectOverviewItem[];
}
