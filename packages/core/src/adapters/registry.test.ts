import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  boundedWorkerDetail,
  createWorkerAdapter,
  probeWorkerHealth,
  registeredWorkerProfiles,
  resolveWorkerCapabilityFacts,
  safeWorkerEndpoint,
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

  test('projects the resolved endpoint without the credential the operator configured in it', () => {
    // `AWOS_QWEN_BASE_URL` is operator config and these facts are serialized to the UI, so the
    // endpoint is sanitized here while the adapter and the probe keep the raw one to connect with.
    const leaky = {
      ...config,
      qwenBaseUrl: 'http://operator:hunter2@gateway.internal:8443/v1?api_key=sk-live-1&model=qwen',
    } as HarnessConfig;
    const facts = resolveWorkerCapabilityFacts('qwen-local', leaky);
    assert.equal(
      facts.target?.endpoint,
      'http://***@gateway.internal:8443/v1?api_key=***&model=qwen',
    );
    assert.equal(
      workerProfile('qwen-local', leaky).target.endpoint,
      'http://operator:hunter2@gateway.internal:8443/v1?api_key=sk-live-1&model=qwen',
      'the connect path keeps the endpoint it was configured with',
    );

    // A refused resolution reports the target it refused, so that branch needs the same cut.
    const target: ModelTarget = {
      id: 'leaky-target', provider: 'openai-compatible', model: 'm',
      endpoint: 'http://operator:hunter2@gateway.internal:8443/v1', authProfile: null,
    };
    const registries: WorkerRegistries = {
      profiles: [{
        id: 'qwen-local', label: 'Qwen', adapterId: 'claude-only', targetId: target.id,
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
    const refused = resolveWorkerCapabilityFacts('qwen-local', config, registries);
    assert.equal(refused.reasonCode, 'unsupported');
    assert.equal(refused.target?.endpoint, 'http://***@gateway.internal:8443/v1');
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

  test('hides compound credential field names, whatever the vendor spelled them', () => {
    // `_` is a word character, so a `\b`-anchored name list cannot see the second half of a
    // compound name. These are the spellings an OAuth-style endpoint actually prints.
    assert.equal(boundedWorkerDetail('rejected: client_secret=abc123'), 'rejected: client_secret=***');
    assert.equal(boundedWorkerDetail('rejected: refresh_token=def456'), 'rejected: refresh_token=***');
    assert.equal(boundedWorkerDetail('access_token=t1 id_token=t2'), 'access_token=*** id_token=***');
    assert.equal(boundedWorkerDetail('session_token: s auth_token: a'), 'session_token: *** auth_token: ***');
    assert.equal(boundedWorkerDetail('private-key=pem secret_key=sk'), 'private-key=*** secret_key=***');
    assert.equal(boundedWorkerDetail('client-id=cid'), 'client-id=***');
    assert.equal(boundedWorkerDetail('x-api-key: sk-live-1'), 'x-api-key: ***');
    assert.equal(boundedWorkerDetail('CLIENT_SECRET=ABC'), 'CLIENT_SECRET=***');
  });

  test('hides the whole credential, not the scheme word in front of it', () => {
    // A credential is written `<scheme> <credentials>`, so a rule that names only `Bearer`
    // spends the marker on the scheme and prints the secret next to it.
    assert.equal(boundedWorkerDetail('Authorization: Basic dXNlcjpwYXNz'), 'Authorization: ***');
    assert.equal(boundedWorkerDetail('authorization: Negotiate YIIZ'), 'authorization: ***');
    assert.equal(boundedWorkerDetail('Authorization: Token abc123'), 'Authorization: ***');
    assert.equal(boundedWorkerDetail('Authorization: NTLM TlRMTVNTUAAB'), 'Authorization: ***');
    assert.equal(boundedWorkerDetail('Authorization: ApiKey k1'), 'Authorization: ***');
    assert.equal(boundedWorkerDetail('x-api-key: Basic zzz'), 'x-api-key: ***');

    // `Digest` puts the secret in `response=`, not in the first parameter, so the comma-separated
    // list counts as one value once a scheme has introduced it.
    assert.equal(
      boundedWorkerDetail('Authorization: Digest username="u", response="abc"'),
      'Authorization: ***',
    );
    assert.equal(
      boundedWorkerDetail('Authorization: Digest realm="r", nonce="n", cnonce="c", response="r2"'),
      'Authorization: ***',
    );

    // A quoted value is one value including its spaces, and the closing quote goes with it.
    assert.equal(boundedWorkerDetail('api_key="secret with spaces"'), 'api_key=***');
    assert.equal(boundedWorkerDetail("api_key='secret with spaces'"), 'api_key=***');
    // An unbalanced quote still has to be consumed rather than skipped as unmatchable.
    assert.equal(boundedWorkerDetail('api_key="abc'), 'api_key=***');

    // Only a scheme makes a comma continue the value; elsewhere the next field is not a secret.
    assert.equal(boundedWorkerDetail('secret=abc, host=foo'), 'secret=*** host=foo');
  });

  test('leaves text that only reads like a credential name alone', () => {
    // Redaction that eats diagnostic detail costs the same reader the answer twice: once
    // because the worker failed, once because the reason came back mangled.
    assert.equal(boundedWorkerDetail('spawn failed: /usr/lib/tokenizer'), 'spawn failed: /usr/lib/tokenizer');
    assert.equal(boundedWorkerDetail('tokens: 42'), 'tokens: 42');
    assert.equal(boundedWorkerDetail('token_count: 5'), 'token_count: 5');
    assert.equal(boundedWorkerDetail('sort key=name'), 'sort key=name');
    assert.equal(boundedWorkerDetail('request_id=42'), 'request_id=42');
  });
});

describe('safeWorkerEndpoint', () => {
  test('keeps the address readable and drops the credential positions', () => {
    assert.equal(safeWorkerEndpoint('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/v1');
    assert.equal(
      safeWorkerEndpoint('http://operator:hunter2@gateway.internal:8443/v1'),
      'http://***@gateway.internal:8443/v1',
    );
    assert.equal(
      safeWorkerEndpoint('https://gateway.internal/v1?api_key=sk-live-1&model=qwen'),
      'https://gateway.internal/v1?api_key=***&model=qwen',
    );
    assert.equal(
      safeWorkerEndpoint('https://gateway.internal/v1?access_token=t&trace_id=9'),
      'https://gateway.internal/v1?access_token=***&trace_id=9',
    );
    // Not a URL at all, so there is no userinfo or query to isolate \u2014 the text rules apply.
    assert.equal(safeWorkerEndpoint('endpoint api_key=sk-live-1'), 'endpoint api_key=***');
  });

  test('hides parameter names that only a query string can read as a secret', () => {
    // `?key=` is the Google APIs spelling of an API key, and a query parameter name carries
    // none of the prose ambiguity that keeps a bare `key` out of the free-text vocabulary.
    assert.equal(
      safeWorkerEndpoint('https://gateway.example/v1?key=sk-live-secret'),
      'https://gateway.example/v1?key=***',
    );
    assert.equal(safeWorkerEndpoint('https://gw/v1?sig=deadbeef'), 'https://gw/v1?sig=***');
    assert.equal(safeWorkerEndpoint('https://gw/v1?auth=xyz'), 'https://gw/v1?auth=***');
    assert.equal(safeWorkerEndpoint('https://gw/v1?signature=abc'), 'https://gw/v1?signature=***');
    assert.equal(safeWorkerEndpoint('https://gw/v1?credential=c'), 'https://gw/v1?credential=***');
    assert.equal(safeWorkerEndpoint('https://gw/v1?credentials=c'), 'https://gw/v1?credentials=***');
    assert.equal(safeWorkerEndpoint('https://gw/v1?pwd=p'), 'https://gw/v1?pwd=***');
    assert.equal(safeWorkerEndpoint('https://gw/v1?session=s'), 'https://gw/v1?session=***');
    assert.equal(safeWorkerEndpoint('https://gw/v1?sid=s'), 'https://gw/v1?sid=***');

    // The free-text vocabulary still applies in full here.
    assert.equal(safeWorkerEndpoint('https://gw/v1?token=abc'), 'https://gw/v1?token=***');
    assert.equal(safeWorkerEndpoint('https://gw/v1?password=p'), 'https://gw/v1?password=***');
    assert.equal(
      safeWorkerEndpoint('https://gw/v1?api_key=k&model=q'),
      'https://gw/v1?api_key=***&model=q',
    );

    // The stricter query vocabulary must not start eating the addressing detail: which model
    // and which host a worker was pointed at is why this field is reported at all.
    assert.equal(
      safeWorkerEndpoint('https://gw/v1?model=qwen&temperature=0.2&api-version=2024-06&region=eu'),
      'https://gw/v1?model=qwen&temperature=0.2&api-version=2024-06&region=eu',
    );
    assert.equal(
      safeWorkerEndpoint('https://gw/v1?key=sk-1&model=qwen&temperature=0.2'),
      'https://gw/v1?key=***&model=qwen&temperature=0.2',
    );

    // The prose vocabulary is the one that must not gain a bare `key`, and it did not.
    assert.equal(boundedWorkerDetail('sort key=name'), 'sort key=name');
  });
});
