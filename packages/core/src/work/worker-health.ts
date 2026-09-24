import type {
  WorkerCapabilityFacts,
  WorkerDiagnostic,
  WorkerDiagnosticReasonCode,
  WorkerHealth,
  WorkerProbeObservation,
  WorkerProfileId,
} from '@awos/protocol';
import { WORKER_HEALTH_STALE_AFTER_MS } from '@awos/protocol';
import { explainWorkerReason } from './worker-health-presentation.js';

export interface WorkerDiagnosticProjectionInput {
  /** One entry per profile the caller asked about, resolved from the effective source. */
  capabilities: readonly WorkerCapabilityFacts[];
  /** Whatever probes have recorded so far. Missing entries are reported as unchecked. */
  observations: readonly WorkerProbeObservation[];
  /** Profiles with a turn in flight right now, which is live evidence of a live process. */
  busyProfileIds: readonly WorkerProfileId[];
  now: number;
  staleAfterMs?: number;
}

/**
 * Project resolution facts and probe observations into one diagnostic per worker profile.
 *
 * Keyed by the profiles the caller asked about rather than by the profiles a probe happened
 * to answer for. That is the whole point: a profile missing from a probe result is reported
 * as unchecked, with its durable capability facts intact, instead of vanishing from a list
 * and leaving the reader to guess what its absence meant.
 *
 * The projection is pure. It reads the effective profile source only through
 * `capabilities`, so replacing the static registry with configured profiles later changes
 * who fills that array and nothing about this contract.
 */
export function projectWorkerDiagnostics(
  input: WorkerDiagnosticProjectionInput,
): WorkerDiagnostic[] {
  const staleAfterMs = input.staleAfterMs ?? WORKER_HEALTH_STALE_AFTER_MS;
  const busy = new Set(input.busyProfileIds);
  return input.capabilities.map((capability) => {
    const observation = input.observations.find((candidate) => candidate.profileId === capability.profileId) ?? null;
    const health = projectHealth({
      capability,
      observation,
      busy: busy.has(capability.profileId),
      now: input.now,
      staleAfterMs,
    });
    const reasonCode: WorkerDiagnosticReasonCode = capability.supported ? health.reasonCode : capability.reasonCode;
    return {
      profileId: capability.profileId,
      label: capability.label,
      capability,
      health,
      reasonCode,
      reason: explainWorkerReason(reasonCode, {
        label: capability.label,
        profileId: capability.profileId,
        configured: capability.configured,
      }),
      dispatchable: capability.supported && !health.stale &&
        (health.state === 'reachable' || health.state === 'busy'),
    };
  });
}

function projectHealth(input: {
  capability: WorkerCapabilityFacts;
  observation: WorkerProbeObservation | null;
  busy: boolean;
  now: number;
  staleAfterMs: number;
}): WorkerHealth {
  // An unsupported profile is never probed, so reporting anything but "unchecked" here
  // would be a claim about a process that was never contacted.
  if (!input.capability.supported) {
    return { state: 'not-checked', reasonCode: 'not-checked', checkedAt: null, stale: false, detail: null };
  }

  // A turn in flight outranks the probe record in both directions: it proves the process is
  // alive without a probe, and it stays true however old the last probe is.
  if (input.busy) {
    return {
      state: 'busy',
      reasonCode: 'busy',
      checkedAt: input.observation?.checkedAt ?? null,
      stale: false,
      detail: input.observation?.detail ?? null,
    };
  }

  if (input.observation === null) {
    return { state: 'not-checked', reasonCode: 'not-checked', checkedAt: null, stale: false, detail: null };
  }

  const state = input.observation.reachable ? 'reachable' : 'unavailable';
  const stale = input.now - input.observation.checkedAt > input.staleAfterMs;
  return {
    state,
    // `state` keeps what was observed; the reason code refuses to repeat it as current.
    reasonCode: stale ? 'stale' : state,
    checkedAt: input.observation.checkedAt,
    stale,
    detail: input.observation.detail === '' ? null : input.observation.detail,
  };
}
