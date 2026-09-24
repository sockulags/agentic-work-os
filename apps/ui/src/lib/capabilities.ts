import type { AgentAvailability, AgentCapabilities, AgentId, WorkerDiagnosticReasonCode } from '@awos/protocol';

/**
 * Capabilities of the agent that owns a turn, which is not always the agent selected for
 * the next message. A panel describing what just happened must ask about the former.
 */
export function capabilitiesForTurn(
  availability: AgentAvailability[],
  turnAgent: AgentId | null,
): AgentCapabilities | undefined {
  if (turnAgent === null) return undefined;
  return availability.find((entry) => entry.profileId === turnAgent)?.capabilities;
}

/**
 * The short word a worker row shows for one core-selected reason code.
 *
 * A label, not an explanation: the sentence next to it is the core's `reason`, and the UI
 * adds nothing to it. Switching on the code rather than on a boolean is the point — "not
 * checked" and "unavailable" used to render identically and mean different things.
 */
export function workerStatusLabel(code: WorkerDiagnosticReasonCode): string {
  switch (code) {
    case 'configured': return 'Configured';
    case 'unsupported': return 'Unsupported';
    case 'not-checked': return 'Not checked';
    case 'reachable': return 'Available';
    case 'busy': return 'Busy';
    case 'unavailable': return 'Unavailable';
    case 'stale': return 'Check expired';
  }
}
