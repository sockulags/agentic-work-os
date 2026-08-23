import type { AgentAvailability, AgentCapabilities, AgentId } from '@awos/protocol';

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
