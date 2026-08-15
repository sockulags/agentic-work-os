/**
 * The UI ↔ core wire protocol, spoken over a localhost WebSocket.
 *
 * Deliberately small: the UI is a view over the event log plus four verbs
 * (send, interrupt, resolve approval, switch agent). Anything richer belongs in
 * the core, where it can be tested without a browser.
 */

import type { AgentId, ApprovalRequestedBody, HarnessEvent, PlanItem } from './events.js';
import type { AgentCapabilities } from './capabilities.js';

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
}

export interface ThreadRuntimeState {
  threadId: string;
  /** Non-null while a turn is in flight. */
  busyWith: AgentId | null;
  currentTurnId: string | null;
  /** Agent that owns the most recently started turn, reconstructed from the event log. */
  lastTurnAgent: AgentId | null;
  plan: PlanItem[];
  /** Latest cumulative diff for the current turn, or null when the agent reports none. */
  diff: string | null;
  pendingApprovals: ApprovalRequestedBody[];
  agents: Record<AgentId, { status: string; model: string | null }>;
}

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
  | { type: 'turn.send'; threadId: string; agent: AgentId; text: string }
  | { type: 'turn.interrupt'; threadId: string }
  | { type: 'approval.resolve'; threadId: string; approvalId: string; optionId: string }
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
