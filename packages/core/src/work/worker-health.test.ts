import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { WorkerCapabilityFacts, WorkerDiagnosticReasonCode, WorkerProbeObservation } from '@awos/protocol';
import { WORKER_HEALTH_STALE_AFTER_MS } from '@awos/protocol';
import { explainWorkerReason } from './worker-health-presentation.js';
import { projectWorkerDiagnostics } from './worker-health.js';

const NOW = 1_700_000_000_000;

function facts(overrides: Partial<WorkerCapabilityFacts> = {}): WorkerCapabilityFacts {
  return {
    profileId: 'claude',
    label: 'Claude',
    adapterId: 'claude-code-cli',
    target: { id: 'claude-cli', provider: 'claude', model: 'CLI default', endpoint: null, authProfile: null },
    capabilities: {
      streamingToolOutput: false, streamingText: true, reasoning: true, plans: true,
      turnDiff: false, approvals: true, resumableSessions: true,
    },
    policy: { permissionModes: ['default'], nativeTurnDiff: false },
    configured: true,
    supported: true,
    reasonCode: 'configured',
    detail: null,
    ...overrides,
  };
}

function observation(overrides: Partial<WorkerProbeObservation> = {}): WorkerProbeObservation {
  return { profileId: 'claude', reachable: true, detail: 'claude 1.2.3', checkedAt: NOW, ...overrides };
}

function project(input: {
  capabilities?: WorkerCapabilityFacts[];
  observations?: WorkerProbeObservation[];
  busyProfileIds?: ('claude' | 'codex' | 'qwen-local')[];
  now?: number;
}) {
  return projectWorkerDiagnostics({
    capabilities: input.capabilities ?? [facts()],
    observations: input.observations ?? [],
    busyProfileIds: input.busyProfileIds ?? [],
    now: input.now ?? NOW,
  });
}

describe('projectWorkerDiagnostics', () => {
  test('reports a resolved profile as configured and supported before anything is probed', () => {
    const [diagnostic] = project({});

    assert.equal(diagnostic?.capability.configured, true);
    assert.equal(diagnostic?.capability.supported, true);
    assert.equal(diagnostic?.capability.reasonCode, 'configured');
    assert.equal(diagnostic?.capability.target?.id, 'claude-cli');
    // Configuration is durable; liveness is not. Nothing has been checked, so nothing is
    // claimed about the process, and the worker is not dispatchable on the strength of
    // being configured alone.
    assert.equal(diagnostic?.health.state, 'not-checked');
    assert.equal(diagnostic?.reasonCode, 'not-checked');
    assert.equal(diagnostic?.health.checkedAt, null);
    assert.equal(diagnostic?.dispatchable, false);
  });

  test('reports a reachable probe with the time it was made', () => {
    const [diagnostic] = project({ observations: [observation({ checkedAt: NOW - 1_000 })] });

    assert.equal(diagnostic?.health.state, 'reachable');
    assert.equal(diagnostic?.reasonCode, 'reachable');
    assert.equal(diagnostic?.health.checkedAt, NOW - 1_000);
    assert.equal(diagnostic?.health.stale, false);
    assert.equal(diagnostic?.health.detail, 'claude 1.2.3');
    assert.equal(diagnostic?.dispatchable, true);
  });

  test('separates a missing binary from a worker that was never checked', () => {
    const [missing] = project({
      observations: [observation({ reachable: false, detail: '`claude` not found on PATH' })],
    });
    const [unchecked] = project({});

    assert.equal(missing?.health.state, 'unavailable');
    assert.equal(missing?.reasonCode, 'unavailable');
    assert.equal(missing?.health.detail, '`claude` not found on PATH');
    assert.equal(missing?.dispatchable, false);
    // Both refuse dispatch, and they are still different answers: one needs an install,
    // the other needs a check.
    assert.equal(unchecked?.reasonCode, 'not-checked');
    assert.notEqual(missing?.reason, unchecked?.reason);
  });

  test('refuses an unsupported target durably and never probes it', () => {
    const [diagnostic] = project({
      capabilities: [facts({
        configured: true,
        supported: false,
        reasonCode: 'unsupported',
        capabilities: null,
        detail: 'Worker profile claude is incompatible: adapter claude-code-cli does not support model target qwen38-local (openai-compatible).',
      })],
      // A stray observation cannot promote an unsupported profile: the resolution refusal
      // is the answer, and no probe result changes it.
      observations: [observation()],
    });

    assert.equal(diagnostic?.reasonCode, 'unsupported');
    assert.equal(diagnostic?.health.state, 'not-checked');
    assert.equal(diagnostic?.health.checkedAt, null);
    assert.equal(diagnostic?.dispatchable, false);
  });

  test('names an unconfigured profile as unconfigured rather than as a missing binary', () => {
    const [diagnostic] = project({
      capabilities: [facts({
        profileId: 'qwen-local',
        label: 'qwen-local',
        adapterId: null,
        target: null,
        capabilities: null,
        policy: null,
        configured: false,
        supported: false,
        reasonCode: 'unsupported',
        detail: 'No worker profile is registered for qwen-local.',
      })],
    });

    assert.equal(diagnostic?.reasonCode, 'unsupported');
    assert.match(diagnostic?.reason ?? '', /No worker profile named qwen-local is configured\./);
  });

  test('treats a turn in flight as live evidence that outranks the probe record', () => {
    const [fresh] = project({ observations: [observation()], busyProfileIds: ['claude'] });
    const [withoutProbe] = project({ busyProfileIds: ['claude'] });
    const [staleProbe] = project({
      observations: [observation({ checkedAt: NOW - WORKER_HEALTH_STALE_AFTER_MS - 1 })],
      busyProfileIds: ['claude'],
    });

    assert.equal(fresh?.reasonCode, 'busy');
    assert.equal(fresh?.dispatchable, true, 'a busy profile still accepts a new thread');
    // A running turn proves the process answered, with or without a probe behind it, and
    // however old that probe is.
    assert.equal(withoutProbe?.reasonCode, 'busy');
    assert.equal(withoutProbe?.health.checkedAt, null);
    assert.equal(staleProbe?.reasonCode, 'busy');
    assert.equal(staleProbe?.health.stale, false);
  });

  test('refuses to repeat an expired check as the current state', () => {
    const [stale] = project({ observations: [observation({ checkedAt: NOW - WORKER_HEALTH_STALE_AFTER_MS - 1 })] });
    const [edge] = project({ observations: [observation({ checkedAt: NOW - WORKER_HEALTH_STALE_AFTER_MS })] });

    // What was observed is retained; what is claimed about now is not.
    assert.equal(stale?.health.state, 'reachable');
    assert.equal(stale?.health.stale, true);
    assert.equal(stale?.reasonCode, 'stale');
    assert.equal(stale?.dispatchable, false);
    assert.equal(edge?.reasonCode, 'reachable');
  });

  test('keys the answer by the profiles asked about, not by the ones a probe answered for', () => {
    const diagnostics = projectWorkerDiagnostics({
      capabilities: [facts(), facts({ profileId: 'codex', label: 'Codex' })],
      observations: [observation()],
      busyProfileIds: [],
      now: NOW,
    });

    assert.deepEqual(diagnostics.map((diagnostic) => [diagnostic.profileId, diagnostic.reasonCode]), [
      ['claude', 'reachable'], ['codex', 'not-checked'],
    ]);
  });

  test('loses every observation across a restart rather than reloading a liveness claim', () => {
    // A restart is an orchestrator with an empty health record: whatever was reachable a
    // moment ago belonged to a process that no longer exists.
    const beforeRestart = project({ observations: [observation()] });
    const afterRestart = project({ observations: [] });

    assert.equal(beforeRestart[0]?.reasonCode, 'reachable');
    assert.equal(afterRestart[0]?.reasonCode, 'not-checked');
    assert.equal(afterRestart[0]?.health.checkedAt, null);
    assert.equal(afterRestart[0]?.capability.supported, true, 'configuration survives a restart');
  });

  test('keeps probe output out of the reason sentence', () => {
    const [diagnostic] = project({
      observations: [observation({
        reachable: false,
        detail: 'connect ECONNREFUSED http://127.0.0.1:1234/v1 for C:\\Users\\someone\\bin\\qwen',
      })],
    });

    assert.equal(diagnostic?.health.detail, 'connect ECONNREFUSED http://127.0.0.1:1234/v1 for C:\\Users\\someone\\bin\\qwen');
    assert.equal(diagnostic?.reason, 'Claude did not answer the last check.');
  });
});

describe('explainWorkerReason', () => {
  test('gives every reason code one plain sentence', () => {
    const codes: WorkerDiagnosticReasonCode[] = [
      'configured', 'unsupported', 'not-checked', 'reachable', 'busy', 'unavailable', 'stale',
    ];
    const sentences = codes.map((code) => explainWorkerReason(code, {
      label: 'Claude', profileId: 'claude', configured: true,
    }));

    assert.equal(new Set(sentences).size, codes.length);
    for (const sentence of sentences) {
      assert.match(sentence, /Claude/);
      assert.match(sentence, /\.$/);
    }
  });
});
