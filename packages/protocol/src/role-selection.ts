import type { WorkspaceRole } from './workspace.js';

/** The four honest states of a workspace's local role preference. */
export type WorkspaceRoleSelectionStatus =
  | 'unconfigured'
  | 'needs-selection'
  | 'selected'
  | 'stale';

/** A local preference projected against the shared roles in the resolved workspace. */
export interface WorkspaceRoleSelection {
  status: WorkspaceRoleSelectionStatus;
  /** The persisted id, including an id that became stale after a shared config change. */
  roleId: string | null;
  /** The shared role matching roleId, or null when no role is selected/it is stale. */
  role: WorkspaceRole | null;
}
