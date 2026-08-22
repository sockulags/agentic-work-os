/**
 * The UI ↔ core wire protocol, spoken over a localhost WebSocket.
 *
 * Deliberately small: the UI is a view over the event log plus four verbs
 * (send, interrupt, resolve approval, switch agent). Anything richer belongs in
 * the core, where it can be tested without a browser.
 */

import type { AgentId, ApprovalRequestedBody, HarnessEvent, PlanItem } from './events.js';
import type { AgentCapabilities } from './capabilities.js';
import type { WorkspaceResolution } from './workspace.js';
import type { WorkItem, WorkSourceError } from './work.js';

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'dontAsk'
  | 'bypassPermissions';

export interface ThreadSummary {
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  /** Agent that will take the next turn unless the UI overrides it. */
  activeAgent: AgentId;
  /** Native session ids, present once each agent has run at least once. */
  nativeSessions: Partial<Record<AgentId, string>>;
  /** Highest `seq` each agent has been shown. Drives replay. */
  watermarks: Record<AgentId, number>;
  eventCount: number;
  /**
   * The work item this thread is answering, or null for a free-form thread.
   *
   * A pointer, not a copy: the item itself is workspace-scoped and outlives any one
   * thread. Optional in every sense — threads opened before work items existed, and
   * threads that are just a conversation, both carry null.
   */
  workItemId: string | null;
  /**
   * Whether agents work in their own lanes and may run at the same time.
   *
   * Off by default: in one shared directory only one agent can safely run at a time, and
   * that restriction is what parallel mode trades away. See ARCHITECTURE.md §7.
   */
  parallel: boolean;
}

export interface ThreadRuntimeState {
  threadId: string;
  /**
   * The agent whose turn is in flight, or the first of them in parallel mode.
   *
   * Kept for the single-lane case, which is still the default. `busy` is the authority:
   * with lanes, more than one agent can be working.
   */
  busyWith: AgentId | null;
  /** Every agent with a turn in flight right now. */
  busy: AgentId[];
  /** Where each agent's working copy is, for the agents that have a lane. */
  lanes: Partial<Record<AgentId, string>>;
  currentTurnId: string | null;
  /** Agent that owns the most recently started turn, reconstructed from the event log. */
  lastTurnAgent: AgentId | null;
  plan: PlanItem[];
  /** Latest cumulative diff for the current turn, or null when the agent reports none. */
  diff: string | null;
  pendingApprovals: ApprovalRequestedBody[];
  agents: Record<AgentId, { status: string; model: string | null }>;
}

/**
 * How much pinned context a turn's prompt will carry, in characters.
 *
 * A budget, not a storage limit: the core keeps whatever is written and cuts only what it
 * sends. It lives in the protocol because both ends have to agree on where that cut falls
 * — the core makes it, and the editor has to warn the user before they cross it. A prompt
 * budget the UI can't see is one the user only discovers by wondering why the agent
 * ignored the end of their notes.
 */
export const PINNED_CONTEXT_MAX_CHARS = 8_000;

export interface AgentAvailability {
  agent: AgentId;
  available: boolean;
  /** Version string when detected, else the reason it wasn't. */
  detail: string;
  /**
   * Static protocol capabilities. Reported whether or not the binary was found, because
   * they describe the adapter rather than the installation.
   */
  capabilities: AgentCapabilities;
}

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

export type ClientRequest =
  | { type: 'hello'; token: string }
  | { type: 'thread.list' }
  | { type: 'thread.create'; cwd: string; title?: string; agent?: AgentId }
  | { type: 'thread.open'; threadId: string }
  | { type: 'thread.delete'; threadId: string }
  | { type: 'thread.setAgent'; threadId: string; agent: AgentId }
  | { type: 'thread.setPermissionMode'; threadId: string; mode: PermissionMode }
  | { type: 'thread.setParallel'; threadId: string; parallel: boolean }
  /** Apply one lane's work to the thread directory, all of it or none of it. */
  | { type: 'lane.integrate'; threadId: string; agent: AgentId }
  | { type: 'turn.send'; threadId: string; agent: AgentId; text: string }
  /** Interrupt one agent, or every working agent when none is named. */
  | { type: 'turn.interrupt'; threadId: string; agent?: AgentId }
  | { type: 'approval.resolve'; threadId: string; approvalId: string; optionId: string }
  | { type: 'context.get'; threadId: string }
  | { type: 'context.set'; threadId: string; text: string }
  /**
   * Resolve the workspace for a thread's directory, or for any path at all.
   *
   * Both forms exist because a workspace is a property of a directory, not of a
   * conversation: the new-thread form wants to say what a folder is before a thread
   * exists for it. Naming both is an error rather than a precedence rule to remember.
   */
  | { type: 'workspace.get'; threadId?: string; cwd?: string }
  /** Attach a GitHub issue by URL, `owner/name#12`, or a bare number. */
  | { type: 'work.attach'; threadId: string; reference: string }
  /** Ask the source again. Never rewrites a run that has already happened. */
  | { type: 'work.refresh'; threadId: string }
  | { type: 'work.detach'; threadId: string }
  | { type: 'work.get'; threadId: string }
  /**
   * Start a run against the thread's work item.
   *
   * Separate from `turn.send` because a run is a claim about intent: this turn is the
   * work the issue asked for, and its context and outcome are recorded as such. A
   * message that is merely conversation should not have to pretend otherwise.
   */
  | { type: 'work.start'; threadId: string; agent: AgentId; text: string }
  | { type: 'agents.probe' };

export type ClientMessage = ClientRequest & { requestId: string };

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

export type ServerResponseBody =
  | { type: 'ok' }
  | { type: 'error'; message: string }
  | { type: 'thread.list'; threads: ThreadSummary[] }
  | { type: 'thread.opened'; thread: ThreadSummary; events: HarnessEvent[]; state: ThreadRuntimeState }
  | { type: 'thread.created'; thread: ThreadSummary }
  /** Carries its `threadId` so a reply that arrives after a thread switch can be dropped. */
  | { type: 'context'; threadId: string; text: string }
  /** Carries the directory it resolved, for the same reason `context` carries its thread. */
  | { type: 'workspace'; cwd: string; resolution: WorkspaceResolution }
  /**
   * The thread's work item, the reason it could not be read, or both.
   *
   * Both, because a refresh that fails still has the last known item to show: blanking
   * the panel over a dropped connection would lose the thing the user was reading.
   */
  | { type: 'work'; threadId: string; item: WorkItem | null; error: WorkSourceError | null }
  | { type: 'agents.probe'; agents: AgentAvailability[] };

export type ServerResponse = ServerResponseBody & { requestId: string };

export type ServerPush =
  | { type: 'event'; event: HarnessEvent }
  | { type: 'state'; state: ThreadRuntimeState }
  | { type: 'thread.updated'; thread: ThreadSummary }
  | { type: 'thread.removed'; threadId: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string };

export type ServerMessage = ServerResponse | ServerPush;

export function isServerResponse(msg: ServerMessage): msg is ServerResponse {
  return 'requestId' in msg;
}
