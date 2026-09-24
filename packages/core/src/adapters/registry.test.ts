import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  boundedWorkerDetail,
  createWorkerAdapter,
  probeWorkerHealth,
  registeredWorkerProfiles,
  resolveWorkerCapabilityFacts,
  workerProfile,
  WORKER_PROFILE_REGISTRY,
  type AdapterFactory,
  type WorkerProfileDefinition,
  type WorkerRegistries,
} from './registry.js';
import type { HarnessConfig } from '../config.js';
import type { AdapterContext, WorkerAdapter } from './agent.js';
import type { AgentId, ModelTarget } from '@awos/protocol';

const config = { claudeModel: '', codexModel: '', qwenModel: 'override-model', qwenBaseUrl: 'http://localhost:9/v1' } as HarnessConfig;

const emptyCapabilities = {
  streamingToolOutput: false, streamingText: false, reasoning: false, plans: false,
  turnDiff: false, approvals: false, resumableSessions: false,
};

describe('worker profile registry', () => {
  test('keeps persisted Claude/Codex ids and adds the static Qwen target', () => {
    assert.deepEqual(WORKER_PROFILE_REGISTRY.map((entry) => entry.id), ['claude', 'codex', 'qwen-local']);
    assert.deepEqual(
      registeredWorkerProfiles(config).map((profile) => profile.adapterId),
      ['claude-code-cli', 'codex-app-server', 'qwen-code-sdk'],
    );
    const qwen = workerProfile('qwen-local', config);
    assert.equal(qwen.adapterId, 'qwen-code-sdk');
    assert.equal(qwen.target.id, 'qwen38-local');
    assert.equal(qwen.target.provider, 'openai-compatible');
    assert.equal(qwen.target.model, 'override-model');
    assert.equal(qwen.target.endpoint, 'http://localhost:9/v1');
    assert.equal(qwen.target.authProfile, 'local-placeholder');
  });

  test('resolves profiles from the registry rather than a conditional list', () => {
    assert.deepEqual(registeredWorkerProfiles(config).map((profile) => profile.label), [
      'Claude', 'Codex', 'Qwen Code · Qwen3.8 local',
    ]);
  });

  test('checks factory support before construction and permits profiles to reuse a target', () => {
    const capabilities = {
      streamingToolOutput: false, streamingText: true, reasoning: false, plans: false,
      turnDiff: false, approvals: false, resumableSessions: false,
    };
    const target: ModelTarget = {
      id: 'shared-target', provider: 'openai-compatible', model: 'shared-model', endpoint: null, authProfile: null,
    };
    let creates = 0;
    const adapter = { id: 'test-factory', capabilities } as WorkerAdapter;
    const factory: AdapterFactory = {
      id: 'test-factory', capabilities, supports: () => true,
      create: () => { creates += 1; return adapter; },
    };
    const profile = (id: AgentId) => ({
      id, label: id, adapterId: factory.id, targetId: target.id,
      policy: { permissionModes: ['default'] as const, nativeTurnDiff: false },
      probe: async () => ({ available: true, detail: 'ok' }),
    });
    const registries: WorkerRegistries = {
      profiles: [profile('claude'), profile('codex')],
      targets: [{ target, resolve: () => target }],
      factories: [factory],
    };
    assert.equal(workerProfile('claude', config, registries).target.id, 'shared-target');
    assert.equal(workerProfile('codex', config, registries).target.id, 'shared-target');
    assert.equal(createWorkerAdapter('codex', { config } as AdapterContext, registries), adapter);
    assert.equal(creates, 1);

    const incompatible: WorkerRegistries = {
      ...registries,
      factories: [{ ...factory, supports: () => false, create: () => { creates += 1; return adapter; } }],
    };
    assert.throws(
      () => createWorkerAdapter('claude', { config } as AdapterContext, incompatible),
      /does not support model target shared-target/,
    );
    assert.equal(creates, 1);
  });
});

describe('worker capability facts', () => {
  test('separates a resolved profile from an unsupported target and an unconfigured id', () => {
    const resolved = resolveWorkerCapabilityFacts('claude', config);
    assert.equal(resolved.configured, true);
    assert.equal(resolved.supported, true);
    assert.equal(resolved.reasonCode, 'configured');
    assert.equal(resolved.adapterId, 'claude-code-cli');
    assert.equal(resolved.detail, null);
    assert.equal(resolved.capabilities?.approvals, true);

    // A profile whose adapter cannot serve its resolved target is configured and still
    // unusable, and no probe can change that — so the two facts are reported separately.
    const target: ModelTarget = {
      id: 'wrong-provider', provider: 'openai-compatible', model: 'm', endpoint: null, authProfile: null,
    };
    const registries: WorkerRegistries = {
      profiles: [{
        id: 'claude', label: 'Claude', adapterId: 'claude-only', targetId: target.id,
        policy: { permissionModes: ['default'], nativeTurnDiff: false },
        probe: async () => ({ available: true, detail: 'never called' }),
      }],
      targets: [{ target, resolve: () => target }],
      factories: [{
        id: 'claude-only', capabilities: emptyCapabilities,
        supports: (candidate) => candidate.provider === 'claude',
        create: () => ({ id: 'claude-only' } as WorkerAdapter),
      }],
    };
    const unsupported = resolveWorkerCapabilityFacts('claude', config, registries);
    assert.equal(unsupported.configured, true);
    assert.equal(unsupported.supported, false);
    assert.equal(unsupported.reasonCode, 'unsupported');
    assert.equal(unsupported.capabilities, null);
    assert.match(unsupported.detail ?? '', /does not support model target wrong-provider/);

    const unconfigured = resolveWorkerCapabilityFacts('codex', config, registries);
    assert.equal(unconfigured.configured, false);
    assert.equal(unconfigured.supported, false);
    assert.equal(unconfigured.label, 'codex');
    assert.equal(unconfigured.adapterId, null);
    assert.match(unconfigured.detail ?? '', /No worker profile is registered for codex\./);
  });
});

describe('targeted worker probes', () => {
  test('contacts only the named profile and skips the ones that do not resolve', async () => {
    const started: string[] = [];
    const target: ModelTarget = {
      id: 'shared-target', provider: 'openai-compatible', model: 'm', endpoint: null, authProfile: null,
    };
    const profile = (id: AgentId, available: boolean): WorkerProfileDefinition => ({
      id, label: id, adapterId: 'test-factory', targetId: target.id,
      policy: { permissionModes: ['default'], nativeTurnDiff: false },
      probe: async () => {
        started.push(id);
        return { available, detail: available ? `${id} 1.0.0` : `\`${id}\` not found on PATH` };
      },
    });
    const registries: WorkerRegistries = {
      profiles: [profile('claude', true), profile('codex', false)],
      targets: [{ target, resolve: () => target }],
      factories: [{
        id: 'test-factory', capabilities: emptyCapabilities, supports: () => true,
        create: () => ({ id: 'test-factory' } as WorkerAdapter),
      }],
    };

    const before = Date.now();
    const observations = await probeWorkerHealth(config, ['claude'], registries);
    // Asking about one worker must not start another one's binary: a health check is not a
    // reason to wake every configured process.
    assert.deepEqual(started, ['claude']);
    assert.equal(observations.length, 1);
    assert.equal(observations[0]?.reachable, true);
    assert.equal(observations[0]?.detail, 'claude 1.0.0');
    assert.ok((observations[0]?.checkedAt ?? 0) >= before, 'an observation carries the time it was made');

    const unavailable = await probeWorkerHealth(config, ['codex', 'codex'], registries);
    assert.deepEqual(started, ['claude', 'codex'], 'a repeated id is probed once');
    assert.equal(unavailable[0]?.reachable, false);
    assert.equal(unavailable[0]?.detail, '`codex` not found on PATH');

    // An unregistered profile was never contacted, so it produces no observation rather
    // than one that reports it unreachable.
    assert.deepEqual(await probeWorkerHealth(config, ['qwen-local'], registries), []);
    assert.deepEqual(started, ['claude', 'codex']);
  });
});

describe('boundedWorkerDetail', () => {
  test('keeps one line, hides credentials, and caps the length', () => {
    assert.equal(boundedWorkerDetail('claude 1.2.3\nextra line'), 'claude 1.2.3');
    assert.equal(boundedWorkerDetail('  spaced\t out  '), 'spaced out');
    assert.equal(
      boundedWorkerDetail('connect failed for http://user:hunter2@127.0.0.1:1234/v1'),
      'connect failed for http://***@127.0.0.1:1234/v1',
    );
    // The key name stays so the reader knows what was hidden; the value does not.
    assert.equal(boundedWorkerDetail('refused: api-key=sk-live-1234'), 'refused: api-key=***');
    assert.equal(boundedWorkerDetail('Authorization: Bearer abcdef'), 'Authorization: ***');
    assert.equal(boundedWorkerDetail('rejected bearer abcdef'), 'rejected bearer ***');

    const long = boundedWorkerDetail(`x${'y'.repeat(400)}`);
    assert.equal(long.length, 200);
    assert.ok(long.endsWith('\u2026'));
  });
});
