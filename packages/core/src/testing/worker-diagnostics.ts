import type { WorkerCapabilities, WorkerDiagnostic, WorkerProfileId } from '@awos/protocol';
import { projectWorkerDiagnostics } from '../work/worker-health.js';

const CAPABILITIES: WorkerCapabilities = {
  streamingToolOutput: false,
  streamingText: false,
  reasoning: false,
  plans: false,
  turnDiff: false,
  approvals: false,
  resumableSessions: false,
};

/**
 * One worker diagnostic for tests about the surfaces that consume them.
 *
 * Built through the real projection rather than written out as a literal, so a test cannot
 * assert against a combination of capability facts and health that the core would never
 * produce — a stale `reachable` reported as current, say.
 */
export function testWorkerDiagnostic(
  profileId: WorkerProfileId,
  options: {
    /** Omitted means no probe has run for this profile. */
    reachable?: boolean;
    configured?: boolean;
    supported?: boolean;
    busy?: boolean;
    checkedAt?: number;
    now?: number;
    label?: string;
    detail?: string;
  } = {},
): WorkerDiagnostic {
  const now = options.now ?? 1_000;
  const supported = options.supported ?? true;
  const configured = options.configured ?? supported;
  const diagnostic = projectWorkerDiagnostics({
    capabilities: [{
      profileId,
      label: options.label ?? profileId,
      adapterId: `${profileId}-adapter`,
      target: { id: `${profileId}-target`, provider: 'claude', model: 'test-model', endpoint: null, authProfile: null },
      capabilities: supported ? CAPABILITIES : null,
      policy: { permissionModes: ['default'], nativeTurnDiff: false },
      configured,
      supported,
      reasonCode: supported ? 'configured' : 'unsupported',
      detail: supported ? null : `Worker profile ${profileId} is incompatible.`,
    }],
    observations: options.reachable === undefined ? [] : [{
      profileId,
      reachable: options.reachable,
      detail: options.detail ?? (options.reachable ? 'version 1.0.0' : 'not installed'),
      checkedAt: options.checkedAt ?? now,
    }],
    busyProfileIds: options.busy === true ? [profileId] : [],
    now,
  })[0];
  if (diagnostic === undefined) throw new Error('The worker diagnostic projection returned nothing.');
  return diagnostic;
}
