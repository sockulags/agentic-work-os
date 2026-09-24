import type { WorkerCapabilities } from './capabilities.js';
import type { WorkerProfileId } from './events.js';
import type { ModelTarget, WorkerProfilePolicy } from './profiles.js';

/**
 * Worker capability and health, kept as two separate kinds of truth.
 *
 * Whether a worker *can* be used is a resolution fact: the effective profile source either
 * names it and pairs it with an adapter that serves its model target, or it does not. That
 * answer is the same one minute from now. Whether a worker *is* usable is an observation
 * with a timestamp on it, and it expires.
 *
 * Collapsing the two into a single boolean is how a UI ends up claiming a worker is live
 * because it once appeared in a probe list. ARCHITECTURE.md §3 forbids inventing what was
 * never observed; this is that rule applied to worker state rather than to events.
 */

/**
 * How long one observation is allowed to stand for the worker's current state.
 *
 * Past it the observation is reported as stale rather than refreshed: probes here are
 * explicit, and a projection that re-probed on read would be background polling with
 * extra steps.
 */
export const WORKER_HEALTH_STALE_AFTER_MS = 60_000;

/** Durable resolution codes. No probe can change either of them. */
export type WorkerCapabilityReasonCode = 'configured' | 'unsupported';

/** Transient observation codes. Every one of them needs a probe or a live turn to mean anything. */
export type WorkerHealthReasonCode = 'not-checked' | 'reachable' | 'busy' | 'unavailable' | 'stale';

/** The bounded reason vocabulary. UI prose is derived from these, never from probe output. */
export type WorkerDiagnosticReasonCode = WorkerCapabilityReasonCode | WorkerHealthReasonCode;

/**
 * What is believed about the worker process right now.
 *
 * `not-checked` is the only honest value before a probe runs, including immediately after a
 * restart: nothing about a transient process survives one.
 */
export type WorkerHealthState = 'not-checked' | 'reachable' | 'busy' | 'unavailable';

/** One timestamped probe result. Held in memory only; a restart loses it on purpose. */
export interface WorkerProbeObservation {
  profileId: WorkerProfileId;
  reachable: boolean;
  /** Already bounded and stripped of credentials by the probe boundary. */
  detail: string;
  checkedAt: number;
}

/** What the effective profile source resolved for one worker, before anything was probed. */
export interface WorkerCapabilityFacts {
  profileId: WorkerProfileId;
  /** The resolved label, or the profile id when nothing resolved it. */
  label: string;
  adapterId: string | null;
  target: ModelTarget | null;
  capabilities: WorkerCapabilities | null;
  policy: WorkerProfilePolicy | null;
  /** The effective profile source names this profile and resolves its adapter and target. */
  configured: boolean;
  /** The resolved adapter accepts the resolved target. False whenever `configured` is false. */
  supported: boolean;
  reasonCode: WorkerCapabilityReasonCode;
  /** Bounded explanation of a refused resolution. Null when the profile resolved. */
  detail: string | null;
}

/** The transient half: one observation, when it was made, and whether it still counts. */
export interface WorkerHealth {
  state: WorkerHealthState;
  reasonCode: WorkerHealthReasonCode;
  /** When the probe behind `state` ran. Null while nothing has been checked. */
  checkedAt: number | null;
  stale: boolean;
  /**
   * Bounded display detail from the probe — a version line, a missing binary, an endpoint.
   *
   * Deliberately separate from `reasonCode`: the code is stable enough to branch on, this
   * is vendor text that changes with every release and may name a path.
   */
  detail: string | null;
}

/** One worker profile's capability facts and health observation, plus the selected reason. */
export interface WorkerDiagnostic {
  profileId: WorkerProfileId;
  label: string;
  capability: WorkerCapabilityFacts;
  health: WorkerHealth;
  /** `unsupported` wins over any observation; otherwise the health code is the primary one. */
  reasonCode: WorkerDiagnosticReasonCode;
  /** Plain sentence derived from `reasonCode`. Never raw probe output. */
  reason: string;
  /** Whether routing may hand work to this worker now. */
  dispatchable: boolean;
}
