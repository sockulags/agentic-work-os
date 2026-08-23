import { describe, expect, test } from 'vitest';
import type { AgentAvailability, AgentCapabilities } from '@awos/protocol';
import { capabilitiesForTurn } from './capabilities';

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
  { agent: 'claude', profileId: 'claude', label: 'Claude', adapterId: 'claude-code-cli', model: 'CLI default', available: true, detail: 'test', capabilities: capabilities(false) },
  { agent: 'codex', profileId: 'codex', label: 'Codex', adapterId: 'codex-app-server', model: 'CLI default', available: true, detail: 'test', capabilities: capabilities(true) },
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
