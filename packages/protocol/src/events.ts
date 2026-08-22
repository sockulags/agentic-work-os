/**
 * The normalized event model.
 *
 * Both adapters translate their native wire format into this union and never leak
 * native shapes upward. The UI knows about `HarnessEvent` and nothing else.
 *
 * Two invariants:
 *   1. Adapters never synthesize an event for a capability the agent lacks. If Claude
 *      doesn't stream incremental command output, it emits no `tool.output`. The UI
 *      degrades; it does not lie.
 *   2. `seq` is assigned by the ThreadStore, never by an adapter. It is the single
 *      ordering authority across two concurrently running processes.
 */

import type {
  CheckResult,
  EvidenceKind,
  EvidenceRef,
  GateOverride,
  RequirementResult,
  RetainedKind,
  RunClaim,
  WorkingState,
} from './evidence.js';

export type AgentId = 'claude' | 'codex';

export const AGENT_IDS: readonly AgentId[] = ['claude', 'codex'] as const;

export function isAgentId(value: unknown): value is AgentId {
  return value === 'claude' || value === 'codex';
}

/** Envelope fields present on every event. */
export interface HarnessEventMeta {
  /** uuid, unique across all threads */
  id: string;
  /** monotonic within a thread, assigned by the store; the canonical ordering */
  seq: number;
  threadId: string;
  /** which agent produced this; `null` for harness-level events (e.g. user input) */
  agent: AgentId | null;
  /** harness turn id, `null` for events outside a turn (spawn, exit) */
  turnId: string | null;
  /** epoch ms */
  ts: number;
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/** The user's own message, recorded before dispatch so replay can render it. */
export interface UserMessageBody {
  kind: 'user.message';
  text: string;
  /** True when this text carried a replay preamble that we stripped for display. */
  hadReplay: boolean;
}

export interface TurnStartedBody {
  kind: 'turn.started';
  /** Native session id of the agent taking the turn, once known. */
  nativeSessionId: string | null;
}

export type TurnStopReason =
  | 'completed'
  | 'interrupted'
  | 'error'
  | 'max_turns'
  | 'max_budget';

export interface TurnCompletedBody {
  kind: 'turn.completed';
  reason: TurnStopReason;
  /** Human-readable failure text when `reason` is `error`. */
  error: string | null;
  durationMs: number | null;
}

export interface MessageDeltaBody {
  kind: 'message.delta';
  /** Stable id for the message being built, so the UI can append in place. */
  itemId: string;
  text: string;
}

export interface MessageCompletedBody {
  kind: 'message.completed';
  itemId: string;
  text: string;
}

export interface ReasoningDeltaBody {
  kind: 'reasoning.delta';
  itemId: string;
  text: string;
}

export interface ReasoningCompletedBody {
  kind: 'reasoning.completed';
  itemId: string;
  text: string;
}

/**
 * Coarse classification so the UI can pick an icon and a renderer without
 * knowing every tool name either agent might invent.
 */
export type ToolKind =
  | 'command'
  | 'file_read'
  | 'file_edit'
  | 'search'
  | 'web'
  | 'task'
  | 'todo'
  | 'mcp'
  | 'other';

export interface ToolStartedBody {
  kind: 'tool.started';
  itemId: string;
  /** Native tool name, e.g. `Bash`, `Edit`, `command_execution`. */
  name: string;
  toolKind: ToolKind;
  /** One-line summary for the collapsed view, e.g. the command line. */
  title: string;
  /** Raw input, rendered when expanded. */
  input: unknown;
}

export interface ToolOutputBody {
  kind: 'tool.output';
  itemId: string;
  stream: 'stdout' | 'stderr';
  chunk: string;
}

export interface ToolCompletedBody {
  kind: 'tool.completed';
  itemId: string;
  status: 'ok' | 'error' | 'denied' | 'aborted';
  /** Final output text; may be empty when the agent streamed it via `tool.output`. */
  output: string;
  exitCode: number | null;
}

export type PlanItemStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanItem {
  text: string;
  status: PlanItemStatus;
}

export interface PlanUpdatedBody {
  kind: 'plan.updated';
  items: PlanItem[];
}

/**
 * A cumulative unified diff of everything the current turn has changed so far.
 *
 * Like the plan, this is a snapshot rather than an increment: each event supersedes the
 * previous one, and a new turn resets it. Only agents that report a turn-level diff emit
 * this — for the others the panel simply stays closed rather than showing a guess
 * assembled from individual edits.
 */
export interface DiffUpdatedBody {
  kind: 'diff.updated';
  patch: string;
}

/**
 * Something happened to an agent's lane — its own working copy in parallel mode.
 *
 * Lanes are where the files were while the work happened, and the transcript is the
 * record that it happened. So provisioning, integrating and refusing all land in the log:
 * "the agent changed these files but they are not in your tree yet" is a fact about the
 * conversation, and a user reading the thread back later needs it as much as the messages
 * around it. See ARCHITECTURE.md §7.
 */
export interface LaneUpdatedBody {
  kind: 'lane.updated';
  status: 'provisioned' | 'integrated' | 'refused' | 'removed';
  /** Absolute path to the lane's working copy. */
  path: string;
  /** Why it was refused, or what landed. Null when the status says everything. */
  detail: string | null;
}

/**
 * A run began: one agent, one work item, one composed context.
 *
 * A run is the unit that answers "what authorized this work and what did the agent
 * actually read". It lives in the event log rather than in a register of its own because
 * the log is already the canonical, append-only, restart-proof record — a second store
 * would be a second truth to keep in sync, and the interesting question about a run is
 * exactly the question the log exists to answer.
 *
 * `context` is the payload as sent, verbatim. That is what makes the record auditable:
 * a summary of what the agent was given is not evidence of what it was given.
 *
 * `revision` is the source's `updatedAt` at the moment the run started, frozen here. It
 * is what lets a later refresh say "the issue moved since this run" without anything
 * rewriting the run — an event that has been appended cannot change.
 */
export interface RunStartedBody {
  kind: 'run.started';
  runId: string;
  workItemId: string;
  /** `owner/name#number`, denormalized so the log reads on its own. */
  source: string;
  revision: string;
  context: string;
  /** What the user asked for in this run, without the surrounding context blocks. */
  instruction: string;
}

/** How a run ended. A narrowing of `TurnStopReason` to what a run can be. */
export type RunState = 'completed' | 'interrupted' | 'error';

/** A run reached a terminal state. */
export interface RunCompletedBody {
  kind: 'run.completed';
  runId: string;
  state: RunState;
  /** Why it ended that way, when the state alone does not say. */
  detail: string | null;
}

/**
 * What a run claims to have achieved, stated by a person or an agent.
 *
 * Separate from `run.completed`, which says how the *process* ended. An agent that exits
 * cleanly having done the wrong thing produces `completed` and `abandoned`, and a log that
 * cannot express that difference cannot be used to decide anything.
 *
 * A correction is another `run.closed` with the same `runId`: the fold takes the last one,
 * and every earlier claim stays in the log with its author and its time.
 */
export interface RunClosedBody {
  kind: 'run.closed';
  runId: string;
  claim: RunClaim;
  statement: string;
}

/**
 * Something offered in support of a run's claim.
 *
 * Points at a fact rather than restating one: `ref.eventId` names a command, diff,
 * artifact or approval already in this log, so the evidence cannot drift from what
 * happened. `ref.url` covers what is only true outside the harness, which a person has to
 * vouch for.
 *
 * `state` is captured when the evidence is recorded, not when it is read. "The tests
 * passed" is a claim about a particular tree, and a tree that has moved on since is
 * exactly what a reader needs to know.
 */
export interface EvidenceRecordedBody {
  kind: 'evidence.recorded';
  evidenceId: string;
  /** The run it came out of, or null for a check run outside one. */
  runId: string | null;
  /** The work item it is about, or null when the thread has none. */
  workItemId: string | null;
  /** Named around `kind`, which the union has already claimed as its discriminant. */
  evidenceKind: EvidenceKind;
  ref: EvidenceRef;
  summary: string;
  state: WorkingState;
  /** Set when this came from running a check the workspace names. */
  check: CheckResult | null;
}

/**
 * A rule was evaluated against a candidate, and here is what it decided.
 *
 * Recorded whether it allowed or refused, because "we checked and it was fine" is as much
 * a fact about the thread as a refusal is — and a gate that only leaves a trace when it
 * says no cannot be audited for the times it said yes.
 *
 * The candidate is named by its tree, so the record says exactly which content was
 * evaluated rather than "the lane, at some point".
 */
export interface GateEvaluatedBody {
  kind: 'gate.evaluated';
  /** The only gate there is for now. Named so a second one does not need a new event. */
  gate: 'lane.integration';
  allowed: boolean;
  /** The working tree that was up for integration. */
  candidate: WorkingState;
  requirements: RequirementResult[];
  /** Present only when the project permits an override and somebody used one. */
  override: GateOverride | null;
}

/**
 * A discovery, decision, constraint or open question worth outliving the transcript.
 *
 * Kept here rather than written back to the issue: GitHub owns the issue, and what was
 * learned while working is not an edit to what was asked. `selected` decides whether a
 * later run on the same work item is given it — toggling is another record with the same
 * `retainedId`, so a change of mind is history rather than an overwrite.
 */
export interface ContextRetainedBody {
  kind: 'context.retained';
  retainedId: string;
  workItemId: string;
  retainedKind: RetainedKind;
  text: string;
  /** The run it came out of, or null when it was written down outside one. */
  runId: string | null;
  selected: boolean;
  /** Kept, but no longer true or no longer useful. Nothing is ever deleted. */
  retired: boolean;
}

/**
 * How the dock should render an artifact. Derived from the file extension, because the
 * publishing agent has no channel to declare it — it just writes a file.
 */
export type ArtifactKind =
  | 'markdown'
  | 'mermaid'
  | 'html'
  | 'json'
  | 'csv'
  | 'image'
  | 'text';

/**
 * A file appeared or changed in `<cwd>/.awos/artifacts/`.
 *
 * Agents publish rich content by writing files there with the file-write tool they
 * already have; the harness watches the directory and turns each write into this event.
 * See ARCHITECTURE.md §9 for why publishing is a file convention rather than a tool.
 *
 * Like `plan.updated`, each event supersedes the previous one for the same `artifactId`
 * rather than adding to it — the file has one current content, and the event carries it.
 */
export interface ArtifactUpdatedBody {
  kind: 'artifact.updated';
  /** The file name inside the artifacts directory; stable across rewrites. */
  artifactId: string;
  title: string;
  /** Named around `kind`, which the union has already claimed as its discriminant. */
  artifactKind: ArtifactKind;
  /** File text, or a `data:` URI when `artifactKind` is `image`. Empty means deleted. */
  content: string;
  /** Absolute path, so the UI can offer to open the real file. */
  path: string;
  /** File mtime, which is when the agent wrote it rather than when we noticed. */
  updatedAt: number;
}

export interface ApprovalOption {
  /** Value echoed back in `ApprovalDecision.optionId`. */
  id: string;
  label: string;
  /** `allow` variants proceed, `deny` variants block. */
  behavior: 'allow' | 'deny';
  /** Remember the decision for the rest of the session. */
  persistent: boolean;
}

export interface ApprovalRequestedBody {
  kind: 'approval.requested';
  approvalId: string;
  /** What is being requested, e.g. `Bash`, `apply_patch`. */
  toolName: string;
  toolKind: ToolKind;
  title: string;
  /** Command line, patch, or serialized input — shown in the dialog body. */
  detail: string;
  input: unknown;
  options: ApprovalOption[];
}

export interface ApprovalResolvedBody {
  kind: 'approval.resolved';
  approvalId: string;
  optionId: string;
  behavior: 'allow' | 'deny';
  /** True when resolved by shutdown/timeout rather than the user. */
  auto: boolean;
}

export interface UsageBody {
  kind: 'usage';
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
}

export type AgentStatus = 'spawning' | 'ready' | 'busy' | 'idle' | 'exited' | 'failed';

export interface AgentStatusBody {
  kind: 'agent.status';
  status: AgentStatus;
  /** Model in use, when the agent reports one. */
  model: string | null;
  detail: string | null;
}

export interface ErrorBody {
  kind: 'error';
  message: string;
  /** `fatal` tears down the agent process; `turn` fails only the current turn. */
  severity: 'turn' | 'fatal';
}

/** Escape hatch: a native event we chose not to model. Hidden by default in the UI. */
export interface RawBody {
  kind: 'raw';
  label: string;
  payload: unknown;
}

export type HarnessEventBody =
  | UserMessageBody
  | TurnStartedBody
  | TurnCompletedBody
  | MessageDeltaBody
  | MessageCompletedBody
  | ReasoningDeltaBody
  | ReasoningCompletedBody
  | ToolStartedBody
  | ToolOutputBody
  | ToolCompletedBody
  | PlanUpdatedBody
  | DiffUpdatedBody
  | LaneUpdatedBody
  | RunStartedBody
  | RunCompletedBody
  | RunClosedBody
  | EvidenceRecordedBody
  | GateEvaluatedBody
  | ContextRetainedBody
  | ArtifactUpdatedBody
  | ApprovalRequestedBody
  | ApprovalResolvedBody
  | UsageBody
  | AgentStatusBody
  | ErrorBody
  | RawBody;

export type HarnessEventKind = HarnessEventBody['kind'];

export type HarnessEvent = HarnessEventMeta & HarnessEventBody;

/** What an adapter emits, before the store stamps identity and ordering. */
export type AdapterEvent = HarnessEventBody & {
  turnId?: string | null;
  ts?: number;
};

/** Narrow a `HarnessEvent` to one body kind. */
export function isKind<K extends HarnessEventKind>(
  event: HarnessEvent,
  kind: K,
): event is HarnessEvent & Extract<HarnessEventBody, { kind: K }> {
  return event.kind === kind;
}
