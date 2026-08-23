import type { PermissionMode } from './rpc.js';
import type { AgentId } from './events.js';
import type { WorkerCapabilities } from './capabilities.js';

export type ModelProvider = 'claude' | 'codex' | 'openai-compatible';

export interface ModelTarget {
  id: string;
  provider: ModelProvider;
  model: string;
  endpoint: string | null;
  authProfile: string | null;
}

export interface WorkerProfilePolicy {
  permissionModes: readonly PermissionMode[];
  nativeTurnDiff: boolean;
}

/** Static identity and effective target metadata for one selectable worker. */
export interface WorkerProfile {
  id: AgentId;
  label: string;
  adapterId: string;
  target: ModelTarget;
  capabilities: WorkerCapabilities;
  policy: WorkerProfilePolicy;
}
