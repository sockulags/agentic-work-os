/**
 * Codex app-server JSON-RPC types.
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio (`codex app-server`).
 * Note the server omits the `"jsonrpc":"2.0"` member; we tolerate it either way.
 *
 * Handshake:  initialize → initialized (notification) → thread/start | thread/resume
 * Driving:    turn/start → notifications until turn/completed
 *
 * The item taxonomy is open-ended and grows between Codex releases, so `CodexItem`
 * keeps an index signature and the adapter falls back to a generic tool rendering
 * for item types it doesn't recognize.
 */

export interface JsonRpcRequest {
  jsonrpc?: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc?: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc?: '2.0';
  id: number | string;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc?: '2.0';
  id: number | string;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function isJsonRpcResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && !('method' in msg);
}

export function isJsonRpcFailure(msg: JsonRpcResponse): msg is JsonRpcFailure {
  return 'error' in msg;
}

export function isJsonRpcRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return 'id' in msg && 'method' in msg;
}

/** Server rejects new requests with this code when its ingress queue is full. */
export const CODEX_OVERLOADED_CODE = -32001;

// ---------------------------------------------------------------------------
// Requests we send
// ---------------------------------------------------------------------------

export interface CodexInitializeParams {
  clientInfo: { name: string; title: string; version: string };
}

export interface CodexThreadStartParams {
  model?: string;
  cwd?: string;
  [k: string]: unknown;
}

export interface CodexThreadResumeParams {
  threadId: string;
  [k: string]: unknown;
}

export interface CodexTurnInputItem {
  type: 'text';
  text: string;
}

export interface CodexTurnStartParams {
  threadId: string;
  input: CodexTurnInputItem[];
  [k: string]: unknown;
}

export interface CodexTurnInterruptParams {
  threadId: string;
  turnId?: string;
}

export interface CodexThreadStartResult {
  thread: { id: string; [k: string]: unknown };
}

export interface CodexTurnStartResult {
  turn?: { id: string; [k: string]: unknown };
}

// ---------------------------------------------------------------------------
// Notifications we receive
// ---------------------------------------------------------------------------

export interface CodexItem {
  id: string;
  /** e.g. `agentMessage`, `reasoning`, `commandExecution`, `fileChange`, `mcpToolCall`. */
  type?: string;
  itemType?: string;
  text?: string;
  command?: string | string[];
  cwd?: string;
  exitCode?: number;
  status?: string;
  aggregatedOutput?: string;
  output?: string;
  changes?: Array<{ path: string; kind?: string; diff?: string }>;
  name?: string;
  server?: string;
  arguments?: unknown;
  result?: unknown;
  [k: string]: unknown;
}

export interface CodexThreadStartedParams {
  thread: { id: string; [k: string]: unknown };
}

export interface CodexTurnStartedParams {
  turn: { id: string; threadId?: string; [k: string]: unknown };
}

export interface CodexTurnCompletedParams {
  turn: {
    id: string;
    status?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
}

export interface CodexItemLifecycleParams {
  item: CodexItem;
  threadId?: string;
  turnId?: string;
}

export interface CodexAgentMessageDeltaParams {
  itemId: string;
  delta: string;
  threadId?: string;
  turnId?: string;
}

export interface CodexExecOutputDeltaParams {
  itemId?: string;
  execId?: string;
  /** Codex sends `stdout` | `stderr`. */
  stream?: string;
  chunk?: string;
  delta?: string;
}

export interface CodexPlanUpdatedParams {
  plan?: Array<{ step?: string; text?: string; status?: string }>;
  steps?: Array<{ step?: string; text?: string; status?: string }>;
  turnId?: string;
}

export interface CodexDiffUpdatedParams {
  diff?: string;
  turnId?: string;
}

/**
 * Server → client *request* (has an id, expects a response). The turn blocks until
 * we answer, so the adapter must always reply, including on shutdown.
 */
export interface CodexApprovalRequestParams {
  itemId?: string;
  threadId?: string;
  turnId?: string;
  /** e.g. `exec`, `patch`. */
  type?: string;
  command?: string | string[];
  cwd?: string;
  reason?: string;
  changes?: Array<{ path: string; diff?: string }>;
  options?: Array<{ id?: string; label?: string; decision?: string }>;
  [k: string]: unknown;
}

export interface CodexApprovalResponse {
  /** Codex accepts `approved` / `approved_for_session` / `denied` / `abort`. */
  decision: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

export const CODEX_METHODS = {
  initialize: 'initialize',
  initialized: 'initialized',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  turnStart: 'turn/start',
  turnInterrupt: 'turn/interrupt',
} as const;

export const CODEX_NOTIFICATIONS = {
  threadStarted: 'thread/started',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  reasoningDelta: 'item/reasoning/delta',
  execOutputDelta: 'exec/outputDelta',
  planUpdated: 'turn/plan/updated',
  diffUpdated: 'turn/diff/updated',
  approvalRequest: 'item/permissions/requestApproval',
} as const;
