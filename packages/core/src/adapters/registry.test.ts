import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createWorkerAdapter,
  registeredWorkerProfiles,
  workerProfile,
  WORKER_PROFILE_REGISTRY,
  type AdapterFactory,
  type WorkerRegistries,
} from './registry.js';
import type { HarnessConfig } from '../config.js';
import type { AdapterContext, WorkerAdapter } from './agent.js';
import type { AgentId, ModelTarget } from '@awos/protocol';

const config = { claudeModel: '', codexModel: '', qwenModel: 'override-model', qwenBaseUrl: 'http://localhost:9/v1' } as HarnessConfig;

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
