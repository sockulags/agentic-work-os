import { describe, expect, test } from 'vitest';
import type { AgentAvailability, AgentCapabilities } from '@awos/protocol';
import { capabilitiesForTurn } from './ChangesPanel';

const capabilities = (turnDiff: boolean): AgentCapabilities => ({
  streamingToolOutput: true,
  streamingText: true,
  reasoning: true,
  plans: true,
  turnDiff,
  approvals: true,
  resumableSessions: true,
});

const availability: AgentAvailability[] = [
  { agent: 'claude', available: true, detail: 'test', capabilities: capabilities(false) },
  { agent: 'codex', available: true, detail: 'test', capabilities: capabilities(true) },
];

describe('capabilitiesForTurn', () => {
  test('uses the last turn owner rather than the next composer agent', () => {
    expect(capabilitiesForTurn(availability, 'claude')?.turnDiff).toBe(false);
    expect(capabilitiesForTurn(availability, 'codex')?.turnDiff).toBe(true);
  });

  test('does not infer a capability before a turn has started', () => {
    expect(capabilitiesForTurn(availability, null)).toBeUndefined();
  });
});
