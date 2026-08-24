import type {
  AgentCapabilities,
  AgentId,
  PermissionMode,
  RecoveryWorkerContext,
  WorkerAdapterEvent,
} from '@awos/protocol';
import type { HarnessConfig } from '../config.js';
import type { PermissionBridge } from '../permission-bridge.js';

/**
 * The contract every worker adapter satisfies.
 *
 * Kept intentionally narrow. Anything an agent can do that the other cannot is
 * expressed as a capability flag, not as an extra method — the orchestrator branches on
 * data, never on `instanceof`.
 */
export interface WorkerAdapter {
  /** Stable implementation id; distinct from the persisted WorkerProfile/AgentId. */
  readonly id: string;

  /** Static description of what this agent's protocol supports. */
  readonly capabilities: AgentCapabilities;

  /**
   * Native session id, once the agent has told us one. Persisted by the store so a
   * later run can resume rather than replay from scratch.
   */
  readonly nativeSessionId: string | null;

  /** True while a turn is in flight. */
  readonly busy: boolean;

  /** Spawn the process and complete any handshake. Idempotent. */
  start(): Promise<void>;

  /** Send a user turn. Resolves when the turn *completes*, not when it's accepted. */
  sendTurn(text: string, options?: WorkerTurnOptions): Promise<void>;

  /** Best-effort cancel of the in-flight turn. */
  interrupt(): Promise<void>;

  /** Answer an approval this adapter raised. */
  resolveApproval(approvalId: string, optionId: string): void;

  /** Terminate the process. Safe to call when not running. */
  stop(): Promise<void>;
}

/** Compatibility name for callers that still use the pre-WorkerProfile contract. */
export type AgentAdapter = WorkerAdapter;

/** A persisted native session id was rejected before any new turn content was accepted. */
export class NativeResumeNotFoundError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Native session ${sessionId} could not be resumed.`);
    this.name = 'NativeResumeNotFoundError';
    this.sessionId = sessionId;
  }
}

export function isNativeResumeNotFoundError(error: unknown): error is NativeResumeNotFoundError {
  return error instanceof NativeResumeNotFoundError;
}

/** Structured metadata for a bounded correction; adapters must not replace its worker. */
export interface WorkerTurnOptions {
  recoveryContext?: RecoveryWorkerContext;
}

// The capability shape now lives in @awos/protocol, because the UI branches on it too.
export type { AgentCapabilities };

export interface AdapterContext {
  threadId: string;
  cwd: string;
  config: HarnessConfig;
  permissionMode: PermissionMode;
  /** Native session id to resume, when we have one on record. */
  resumeSessionId: string | null;
  /** Only used by the Claude adapter; Codex approvals ride its own protocol. */
  permissionBridge: PermissionBridge;
  /** Every adapter event flows through here; the store stamps seq and identity. */
  emit: (event: WorkerAdapterEvent) => void;
  /** Called when the adapter learns its native session id. */
  onSessionId: (sessionId: string) => void;
  /** Called when a persisted native id is proven unusable before a fresh session starts. */
  onSessionLost?: () => void;
}
