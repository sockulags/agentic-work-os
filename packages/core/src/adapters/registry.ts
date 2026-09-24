import type {
  AgentAvailability,
  AgentId,
  ModelTarget,
  WorkerCapabilityFacts,
  WorkerProbeObservation,
  WorkerProfile,
  WorkerProfileId,
} from '@awos/protocol';
import { AGENT_IDS } from '@awos/protocol';
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

/** The effective profile source. Issue #152 replaces what fills it, not who reads it. */
export const DEFAULT_WORKER_REGISTRIES: WorkerRegistries = {
  profiles: WORKER_PROFILE_REGISTRY,
  targets: MODEL_TARGET_REGISTRY,
  factories: ADAPTER_FACTORY_REGISTRY,
};

/** How much probe or resolution text may reach a display surface. */
const WORKER_DETAIL_MAX_CHARS = 200;

type ResolvedProfileParts =
  | { ok: true; definition: WorkerProfileDefinition; target: ModelTarget; factory: AdapterFactory }
  | {
      ok: false;
      /** Whether the source named this profile at all, as opposed to failing to serve it. */
      configured: boolean;
      message: string;
      definition: WorkerProfileDefinition | null;
      target: ModelTarget | null;
    };

/**
 * Resolve one profile without throwing.
 *
 * The capability projection needs the refusal as a value: "this profile does not resolve" is
 * an answer it has to report, not an exception it should convert back into one.
 * `resolveParts` keeps the throwing contract for the call paths that cannot continue.
 */
function tryResolveParts(id: AgentId, config: HarnessConfig, registries: WorkerRegistries): ResolvedProfileParts {
  const definition = registries.profiles.find((candidate) => candidate.id === id) ?? null;
  if (definition === null) {
    return { ok: false, configured: false, message: `No worker profile is registered for ${id}.`, definition: null, target: null };
  }
  const targetDefinition = registries.targets.find((candidate) => candidate.target.id === definition.targetId);
  if (!targetDefinition) {
    return {
      ok: false, configured: false, definition, target: null,
      message: `Worker profile ${id} references unknown model target ${definition.targetId}.`,
    };
  }
  const factory = registries.factories.find((candidate) => candidate.id === definition.adapterId);
  if (!factory) {
    return {
      ok: false, configured: false, definition, target: null,
      message: `Worker profile ${id} references unknown adapter factory ${definition.adapterId}.`,
    };
  }
  const target = targetDefinition.resolve(config);
  if (!factory.supports(target)) {
    return {
      ok: false, configured: true, definition, target,
      message: `Worker profile ${id} is incompatible: adapter ${factory.id} does not support model target ${target.id} (${target.provider}).`,
    };
  }
  return { ok: true, definition, target, factory };
}

function resolveParts(id: AgentId, config: HarnessConfig, registries: WorkerRegistries): {
  definition: WorkerProfileDefinition;
  target: ModelTarget;
  factory: AdapterFactory;
} {
  const parts = tryResolveParts(id, config, registries);
  if (!parts.ok) throw new Error(parts.message);
  return { definition: parts.definition, target: parts.target, factory: parts.factory };
}

export function workerProfile(id: AgentId, config: HarnessConfig, registries: WorkerRegistries = DEFAULT_WORKER_REGISTRIES): WorkerProfile {
  const { definition, target, factory } = resolveParts(id, config, registries);
  return { id: definition.id, label: definition.label, adapterId: factory.id, target, capabilities: factory.capabilities, policy: definition.policy };
}

export function createWorkerAdapter(id: AgentId, context: AdapterContext, registries: WorkerRegistries = DEFAULT_WORKER_REGISTRIES): WorkerAdapter {
  const { target, factory } = resolveParts(id, context.config, registries);
  return factory.create(context, target);
}

/**
 * Cut probe and resolution text down to one bounded, credential-free line.
 *
 * A probe runs a vendor CLI or calls an endpoint, and what comes back is whatever that
 * program decided to print: a version, a stack trace, a path, or a URL with the endpoint's
 * userinfo still attached. That text is useful next to a reason code and unfit to be one,
 * so it is bounded here, at the boundary that produced it.
 */
export function boundedWorkerDetail(raw: string): string {
  const line = (raw.split('\n').find((candidate) => candidate.trim() !== '') ?? '').replace(/\s+/g, ' ').trim();
  const redacted = line
    .replace(/(:\/\/)[^/\s@]+@/g, '$1***@')
    .replace(/\b(authorization|api[-_]?key|access[-_]?key|secret|password|passwd|token)\b([\s:=]+)(?:bearer\s+)?\S+/gi, '$1$2***')
    .replace(/\b(bearer)\s+\S+/gi, '$1 ***');
  return redacted.length <= WORKER_DETAIL_MAX_CHARS ? redacted : `${redacted.slice(0, WORKER_DETAIL_MAX_CHARS - 1)}\u2026`;
}

/**
 * The durable half of one worker's state, read from the effective profile source alone.
 *
 * Nothing here is contacted, so the answer is the same whether or not a probe ever runs.
 */
export function resolveWorkerCapabilityFacts(
  id: WorkerProfileId,
  config: HarnessConfig,
  registries: WorkerRegistries = DEFAULT_WORKER_REGISTRIES,
): WorkerCapabilityFacts {
  const parts = tryResolveParts(id, config, registries);
  if (!parts.ok) {
    return {
      profileId: id,
      label: parts.definition?.label ?? id,
      adapterId: parts.definition?.adapterId ?? null,
      target: parts.target,
      capabilities: null,
      policy: parts.definition?.policy ?? null,
      configured: parts.configured,
      supported: false,
      reasonCode: 'unsupported',
      detail: boundedWorkerDetail(parts.message),
    };
  }
  return {
    profileId: parts.definition.id,
    label: parts.definition.label,
    adapterId: parts.factory.id,
    target: parts.target,
    capabilities: parts.factory.capabilities,
    policy: parts.definition.policy,
    configured: true,
    supported: true,
    reasonCode: 'configured',
    detail: null,
  };
}

/**
 * Contact exactly the named profiles and timestamp what they answered.
 *
 * Targeted on purpose: asking about one worker must not start the others' binaries. A
 * profile that does not resolve is left out rather than reported unreachable — it was never
 * contacted, and its refusal is already a capability fact.
 */
export async function probeWorkerHealth(
  config: HarnessConfig,
  profileIds: readonly WorkerProfileId[],
  registries: WorkerRegistries = DEFAULT_WORKER_REGISTRIES,
): Promise<WorkerProbeObservation[]> {
  const probes = [...new Set(profileIds)].flatMap((profileId) => {
    const parts = tryResolveParts(profileId, config, registries);
    return parts.ok ? [{ profileId, definition: parts.definition, target: parts.target }] : [];
  });
  return Promise.all(probes.map(async ({ profileId, definition, target }) => {
    const result = await definition.probe(config, target);
    return {
      profileId,
      reachable: result.available,
      detail: boundedWorkerDetail(result.detail),
      checkedAt: Date.now(),
    };
  }));
}

export async function probeWorkerProfiles(
  config: HarnessConfig,
  profileIds: readonly WorkerProfileId[] = AGENT_IDS,
  registries: WorkerRegistries = DEFAULT_WORKER_REGISTRIES,
): Promise<AgentAvailability[]> {
  const observations = await probeWorkerHealth(config, profileIds, registries);
  return observations.flatMap((observation) => {
    const facts = resolveWorkerCapabilityFacts(observation.profileId, config, registries);
    if (facts.adapterId === null || facts.capabilities === null || facts.target === null) return [];
    return [{
      agent: facts.profileId, profileId: facts.profileId, label: facts.label, adapterId: facts.adapterId,
      available: observation.reachable, detail: observation.detail, capabilities: facts.capabilities,
      model: facts.target.model, checkedAt: observation.checkedAt,
    }];
  });
}

export function registeredWorkerProfiles(
  config: HarnessConfig,
  registries: WorkerRegistries = DEFAULT_WORKER_REGISTRIES,
): WorkerProfile[] {
  return registries.profiles.map((definition) => workerProfile(definition.id, config, registries));
}
