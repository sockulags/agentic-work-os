/**
 * Claude Code CLI `--output-format stream-json` wire types.
 *
 * Invocation the harness uses:
 *
 *   claude -p \
 *     --input-format stream-json --output-format stream-json --verbose \
 *     --include-partial-messages --replay-user-messages \
 *     --session-id <uuid>            (first run; --resume <uuid> afterwards) \
 *     --permission-prompt-tool mcp__harness_permissions__request_permission \
 *     --mcp-config <inline json>
 *
 * These types cover the events the harness consumes. The CLI emits more than this;
 * anything unrecognized becomes a `raw` HarnessEvent rather than an error, because the
 * stream format grows between Claude Code releases and an unknown event is not a fault.
 */

export interface ClaudeTextBlock {
  type: 'text';
  text: string;
}

export interface ClaudeThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export interface ClaudeToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ClaudeToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

export type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeThinkingBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock
  | { type: string; [k: string]: unknown };

export interface ClaudeSystemInitEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model?: string;
  tools?: string[];
  mcp_servers?: Array<{ name: string; status: string }>;
  mcp_server_errors?: Array<{ name: string; type: string; message: string }>;
  plugins?: Array<{ name: string; path: string }>;
  plugin_errors?: Array<{ plugin: string; type: string; message: string }>;
  capabilities?: string[];
  permissionMode?: string;
  cwd?: string;
  uuid?: string;
}

export interface ClaudeSystemApiRetryEvent {
  type: 'system';
  subtype: 'api_retry';
  attempt: number;
  max_retries: number;
  retry_delay_ms: number;
  error_status: number | null;
  error: string;
  session_id: string;
  uuid: string;
}

export interface ClaudeSystemOtherEvent {
  type: 'system';
  subtype: string;
  session_id?: string;
  [k: string]: unknown;
}

export type ClaudeSystemEvent =
  | ClaudeSystemInitEvent
  | ClaudeSystemApiRetryEvent
  | ClaudeSystemOtherEvent;

export interface ClaudeAssistantEvent {
  type: 'assistant';
  message: {
    id?: string;
    role: 'assistant';
    model?: string;
    content: ClaudeContentBlock[];
    stop_reason?: string | null;
    usage?: ClaudeUsage;
  };
  /** Non-null when the message came from a subagent. */
  parent_tool_use_id: string | null;
  session_id: string;
  uuid?: string;
}

export interface ClaudeUserEvent {
  type: 'user';
  message: {
    role: 'user';
    content: string | ClaudeContentBlock[];
  };
  parent_tool_use_id: string | null;
  session_id: string;
  uuid?: string;
}

/** Emitted only with `--include-partial-messages`. Mirrors the Messages API SSE shape. */
export interface ClaudeStreamEvent {
  type: 'stream_event';
  event: {
    type: string;
    index?: number;
    delta?: {
      type: string;
      text?: string;
      thinking?: string;
      partial_json?: string;
    };
    content_block?: { type: string; id?: string; name?: string };
    message?: { id?: string };
  };
  parent_tool_use_id: string | null;
  session_id: string;
  uuid?: string;
}

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ClaudeResultEvent {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution' | string;
  is_error: boolean;
  result?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: ClaudeUsage;
  session_id: string;
  uuid?: string;
}

/**
 * Bidirectional control channel carried on the same stdio pipes.
 * Used here for `interrupt`; the CLI also uses it for its own requests.
 */
export interface ClaudeControlRequest {
  type: 'control_request';
  request_id: string;
  request: { subtype: string; [k: string]: unknown };
}

export interface ClaudeControlResponse {
  type: 'control_response';
  response: {
    request_id: string;
    subtype: 'success' | 'error';
    error?: string;
    [k: string]: unknown;
  };
}

export type ClaudeOutputEvent =
  | ClaudeSystemEvent
  | ClaudeAssistantEvent
  | ClaudeUserEvent
  | ClaudeStreamEvent
  | ClaudeResultEvent
  | ClaudeControlRequest
  | ClaudeControlResponse
  | { type: string; [k: string]: unknown };

/** What we write to the CLI's stdin. */
export interface ClaudeUserInput {
  type: 'user';
  message: {
    role: 'user';
    content: Array<{ type: 'text'; text: string }>;
  };
  parent_tool_use_id: null;
  session_id?: string;
}

// ---------------------------------------------------------------------------
// `--permission-prompt-tool` contract
// ---------------------------------------------------------------------------

/** Arguments Claude passes to the permission-prompt MCP tool. */
export interface ClaudePermissionToolInput {
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id?: string;
}

/** What the tool must return, JSON-stringified, as its text content. */
export type ClaudePermissionToolResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export const CLAUDE_PERMISSION_SERVER_NAME = 'harness_permissions';
export const CLAUDE_PERMISSION_TOOL_NAME = 'request_permission';
export const CLAUDE_PERMISSION_TOOL_FQN = `mcp__${CLAUDE_PERMISSION_SERVER_NAME}__${CLAUDE_PERMISSION_TOOL_NAME}`;
