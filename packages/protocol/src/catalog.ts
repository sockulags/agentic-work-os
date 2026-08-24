import type { AgentId } from './events.js';
import type { WorkSourceError } from './work.js';

export type CatalogFreshness = 'not-fetched' | 'cached' | 'current';

/** The source-owned fields retained from one bounded GitHub issue-list response. */
export interface CatalogIssue {
  number: number;
  url: string;
  title: string;
  /** Catalog refreshes contain only open issues; local linked work may be older/closed. */
  state: 'OPEN' | 'CLOSED';
  labels: string[];
  assignees: string[];
  updatedAt: string;
}

/** The immutable successful source snapshot. This is the only catalog data persisted. */
export interface IssueCatalogSnapshot {
  workspaceRoot: string;
  repository: string;
  complete: boolean;
  successfulAt: number;
  issues: CatalogIssue[];
}

/** Source state as presented to a caller; local overlay data is deliberately separate. */
export interface IssueCatalogSource {
  workspaceRoot: string;
  repository: string;
  freshness: CatalogFreshness;
  complete: boolean;
  successfulAt: number | null;
  issues: CatalogIssue[];
  error: WorkSourceError | null;
}

export interface CatalogLinkedThread {
  threadId: string;
  workItemId: string;
  title: string;
  updatedAt: number;
}

export type CatalogRunState = 'running' | 'completed' | 'interrupted' | 'error' | 'unknown';

export interface CatalogRunEvidence {
  runId: string;
  threadId: string;
  agent: AgentId | null;
  startedAt: number;
  state: CatalogRunState;
  /** True only when the matching run is backed by a currently busy in-memory runtime. */
  live: boolean;
  /** True when a persisted start has no terminal event and no matching live runtime. */
  interruptedByRestart: boolean;
  evidenceCount: number;
}

export interface IssueCatalogOverlay {
  linkedThreads: CatalogLinkedThread[];
  runs: CatalogRunEvidence[];
}

export interface WorkspaceIssueCatalog {
  source: IssueCatalogSource;
  overlay: Record<string, IssueCatalogOverlay>;
}
