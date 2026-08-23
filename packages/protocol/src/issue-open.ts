import type { IssueRouteProjection } from './issue-route.js';
import type { WorkSourceError } from './work.js';
import type { WorkerProfileId } from './events.js';

export type IssueOpenMode = 'taken' | 'continued';

/** The source details a later command needs in order to build the first instruction. */
export interface IssueInstructionInput {
  kind: 'github-issue';
  repository: string;
  issueNumber: number;
  url: string;
  title: string;
  revision: string;
}

export interface IssuePreparation {
  threadId: string;
  workItemId: string;
  mode: IssueOpenMode;
  route: {
    routeId: string | null;
    stepId: string | null;
    action: string | null;
    role: { id: string; label: string } | null;
  } | null;
  /** The order declared by the uniquely routed workspace step. */
  allowedWorkerProfileIds: readonly WorkerProfileId[];
  /** Ordered like `allowedWorkerProfileIds`; empty when continuation did not probe. */
  currentlyAvailableWorkerProfileIds: readonly WorkerProfileId[];
  workerAvailability: 'checked' | 'not-checked';
  instruction: IssueInstructionInput;
}

export type IssueOpenRefusalCode =
  | 'invalid-request'
  | 'thread-not-found'
  | 'workspace-not-found'
  | 'workspace-invalid'
  | 'repository-not-configured'
  | 'catalog-not-current'
  | 'issue-absent'
  | 'issue-not-open'
  | 'route-invalid'
  | 'route-unrouted'
  | 'route-conflict'
  | 'route-changed'
  | 'role-required'
  | 'role-mismatch'
  | 'workers-unavailable'
  | 'source-fetch-failed'
  | 'persistence-failed';

export interface IssueOpenRefusal {
  ok: false;
  code: IssueOpenRefusalCode;
  message: string;
  /** The core's route diagnosis when an issue row was available. */
  route?: IssueRouteProjection;
  sourceError?: WorkSourceError;
}

export interface IssueOpenSuccess {
  ok: true;
  preparation: IssuePreparation;
}

export type IssueOpenResult = IssueOpenSuccess | IssueOpenRefusal;
