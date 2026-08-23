import type { AgentAvailability, AgentId, ModelTarget, WorkerProfile } from '@awos/protocol';
import type { HarnessConfig } from '../config.js';
import { runCapture } from '../util/spawn.js';
import type { AdapterContext, AgentCapabilities, WorkerAdapter } from './agent.js';
import { ClaudeAdapter, CLAUDE_CAPABILITIES } from './claude.js';
import { CodexAdapter, CODEX_CAPABILITIES } from './codex.js';
import { QwenCodeAdapter, QWEN_CAPABILITIES, probeQwenEndpoint } from './qwen-code.js';

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'] as const;

export interface AdapterFactory {
  readonly id: string;
  readonly capabilities: AgentCapabilities;
  supports(target: ModelTarget): boolean;
  create(context: AdapterContext, target: ModelTarget): WorkerAdapter;
}

export interface WorkerProfileDefinition {
  readonly id: AgentId;
  readonly label: string;
  readonly adapterId: string;
  readonly targetId: string;
  readonly policy: WorkerProfile['policy'];
  readonly probe: (config: HarnessConfig, target: ModelTarget) => Promise<{ available: boolean; detail: string }>;
}

export interface ModelTargetDefinition {
  readonly target: ModelTarget;
  readonly resolve: (config: HarnessConfig) => ModelTarget;
}

export interface WorkerRegistries {
  readonly profiles: readonly WorkerProfileDefinition[];
  readonly targets: readonly ModelTargetDefinition[];
  readonly factories: readonly AdapterFactory[];
}

function cliProbe(
  bin: (config: HarnessConfig) => string,
  args: (config: HarnessConfig) => string[],
): WorkerProfileDefinition['probe'] {
  return async (config) => {
    const executable = bin(config);
    const result = await runCapture(executable, args(config));
    const output = `${result.stdout}${result.stderr}`.trim();
    return result.code === 0 && output
      ? { available: true, detail: output.split('\n')[0] ?? output }
      : { available: false, detail: output || `\`${executable}\` not found on PATH` };
  };
}

/** Static model targets, independent from profiles so more than one profile can reuse one. */
export const MODEL_TARGET_REGISTRY: readonly ModelTargetDefinition[] = [
  {
    target: { id: 'claude-cli', provider: 'claude', model: '', endpoint: null, authProfile: null },
    resolve: (config) => ({ id: 'claude-cli', provider: 'claude', model: config.claudeModel || 'CLI default', endpoint: null, authProfile: null }),
  },
  {
    target: { id: 'codex-cli', provider: 'codex', model: '', endpoint: null, authProfile: null },
    resolve: (config) => ({ id: 'codex-cli', provider: 'codex', model: config.codexModel || 'CLI default', endpoint: null, authProfile: null }),
  },
  {
    target: {
      id: 'qwen38-local', provider: 'openai-compatible', model: 'qwen3.8-27b-local',
      endpoint: 'http://127.0.0.1:1234/v1', authProfile: 'local-placeholder',
    },
    resolve: (config) => ({
      id: 'qwen38-local', provider: 'openai-compatible', model: config.qwenModel ?? 'qwen3.8-27b-local',
      endpoint: config.qwenBaseUrl ?? 'http://127.0.0.1:1234/v1', authProfile: 'local-placeholder',
    }),
  },
] as const;

/** Static adapter factories. There is intentionally no plugin discovery. */
export const ADAPTER_FACTORY_REGISTRY: readonly AdapterFactory[] = [
  { id: 'claude-code-cli', capabilities: CLAUDE_CAPABILITIES, supports: (target) => target.provider === 'claude', create: (context) => new ClaudeAdapter(context) },
  { id: 'codex-app-server', capabilities: CODEX_CAPABILITIES, supports: (target) => target.provider === 'codex', create: (context) => new CodexAdapter(context) },
  { id: 'qwen-code-sdk', capabilities: QWEN_CAPABILITIES, supports: (target) => target.provider === 'openai-compatible', create: (context, target) => new QwenCodeAdapter(context, target) },
] as const;

/** Static selectable profiles. Entries reference factories and targets by stable id. */
export const WORKER_PROFILE_REGISTRY: readonly WorkerProfileDefinition[] = [
  {
    id: 'claude', label: 'Claude', adapterId: 'claude-code-cli', targetId: 'claude-cli',
    policy: { permissionModes: PERMISSION_MODES, nativeTurnDiff: CLAUDE_CAPABILITIES.turnDiff },
    probe: cliProbe((config) => config.claudeBin, (config) => [...config.claudeBinArgs, '--version']),
  },
  {
    id: 'codex', label: 'Codex', adapterId: 'codex-app-server', targetId: 'codex-cli',
    policy: { permissionModes: PERMISSION_MODES, nativeTurnDiff: CODEX_CAPABILITIES.turnDiff },
    probe: cliProbe((config) => config.codexBin, (config) => [...config.codexBinArgs, '--version']),
  },
  {
    id: 'qwen-local', label: 'Qwen Code · Qwen3.8 local', adapterId: 'qwen-code-sdk', targetId: 'qwen38-local',
    policy: { permissionModes: PERMISSION_MODES, nativeTurnDiff: false },
    probe: async (_config, target) => probeQwenEndpoint(target.endpoint ?? 'http://127.0.0.1:1234/v1'),
  },
] as const;

const DEFAULT_REGISTRIES: WorkerRegistries = {
  profiles: WORKER_PROFILE_REGISTRY,
  targets: MODEL_TARGET_REGISTRY,
  factories: ADAPTER_FACTORY_REGISTRY,
};

function resolveParts(id: AgentId, config: HarnessConfig, registries: WorkerRegistries): {
  definition: WorkerProfileDefinition;
  target: ModelTarget;
  factory: AdapterFactory;
} {
  const definition = registries.profiles.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`No worker profile is registered for ${id}.`);
  const targetDefinition = registries.targets.find((candidate) => candidate.target.id === definition.targetId);
  if (!targetDefinition) throw new Error(`Worker profile ${id} references unknown model target ${definition.targetId}.`);
  const factory = registries.factories.find((candidate) => candidate.id === definition.adapterId);
  if (!factory) throw new Error(`Worker profile ${id} references unknown adapter factory ${definition.adapterId}.`);
  const target = targetDefinition.resolve(config);
  if (!factory.supports(target)) {
    throw new Error(`Worker profile ${id} is incompatible: adapter ${factory.id} does not support model target ${target.id} (${target.provider}).`);
  }
  return { definition, target, factory };
}

export function workerProfile(id: AgentId, config: HarnessConfig, registries: WorkerRegistries = DEFAULT_REGISTRIES): WorkerProfile {
  const { definition, target, factory } = resolveParts(id, config, registries);
  return { id: definition.id, label: definition.label, adapterId: factory.id, target, capabilities: factory.capabilities, policy: definition.policy };
}

export function createWorkerAdapter(id: AgentId, context: AdapterContext, registries: WorkerRegistries = DEFAULT_REGISTRIES): WorkerAdapter {
  const { target, factory } = resolveParts(id, context.config, registries);
  return factory.create(context, target);
}

export async function probeWorkerProfiles(config: HarnessConfig): Promise<AgentAvailability[]> {
  return Promise.all(WORKER_PROFILE_REGISTRY.map(async (definition) => {
    const profile = workerProfile(definition.id, config);
    const result = await definition.probe(config, profile.target);
    return {
      agent: profile.id, profileId: profile.id, label: profile.label, adapterId: profile.adapterId,
      available: result.available, detail: result.detail, capabilities: profile.capabilities, model: profile.target.model,
    };
  }));
}

export function registeredWorkerProfiles(config: HarnessConfig): WorkerProfile[] {
  return WORKER_PROFILE_REGISTRY.map((definition) => workerProfile(definition.id, config));
}
