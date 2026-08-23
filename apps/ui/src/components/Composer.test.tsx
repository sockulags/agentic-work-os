import { describe, expect, test, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { AgentAvailability, ThreadSummary } from '@awos/protocol';
import { Composer } from './Composer';
import { getAgentStyle } from './AgentBadge';
import { idleRuntime, renderWithHarness } from '@/test-harness';
import type { Harness } from '@/hooks/useHarness';

/**
 * The composer decides who may be sent to while someone is already working, which is the
 * whole user-visible difference lanes make. Getting it wrong in either direction is bad:
 * too strict and parallel mode does nothing, too loose and two agents race on one
 * directory — and neither shows up as an error, only as behaviour.
 */

function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: 't1',
    title: 'A thread',
    cwd: '/repo',
    createdAt: 0,
    updatedAt: 0,
    activeAgent: 'codex',
    nativeSessions: {},
    watermarks: { claude: 0, codex: 0, 'qwen-local': 0 },
    eventCount: 0,
    workItemId: null,
    parallel: false,
    ...overrides,
  };
}

const input = (): HTMLTextAreaElement => screen.getByRole('textbox') as HTMLTextAreaElement;
const sendButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /send/i }) as HTMLButtonElement;

/** Type something, so the send button's state reflects the agent rather than an empty box. */
function type(text: string): void {
  fireEvent.change(input(), { target: { value: text } });
}

describe('Composer — who can be sent to', () => {
  test('renders the server-provided profile list, including Qwen', () => {
    const profile: AgentAvailability = {
      agent: 'qwen-local', profileId: 'qwen-local', label: 'Qwen Code · Qwen3.8 local',
      adapterId: 'qwen-code-sdk', model: 'qwen3.8-27b-local', available: true, detail: 'reachable',
      capabilities: { streamingToolOutput: false, streamingText: true, reasoning: true, plans: false, turnDiff: false, approvals: true, resumableSessions: true },
    };
    renderWithHarness(<Composer />, { activeThread: thread({ activeAgent: 'qwen-local' }), availability: [profile] });
    expect(screen.getByRole('button', { name: /Qwen Code/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Claude$/ })).toBeNull();
  });

  test('only offers profiles allowed by the resolved workspace', () => {
    const availability: AgentAvailability[] = [
      {
        agent: 'claude', profileId: 'claude', label: 'Claude', adapterId: 'claude-code-cli', model: 'default', available: true, detail: 'ok',
        capabilities: { streamingToolOutput: true, streamingText: true, reasoning: true, plans: true, turnDiff: true, approvals: true, resumableSessions: true },
      },
      {
        agent: 'qwen-local', profileId: 'qwen-local', label: 'Qwen Code · Qwen3.8 local', adapterId: 'qwen-code-sdk', model: 'local', available: true, detail: 'ok',
        capabilities: { streamingToolOutput: false, streamingText: true, reasoning: true, plans: false, turnDiff: false, approvals: true, resumableSessions: true },
      },
    ];
    const workspace = {
      cwd: '/repo', resolution: { status: 'ok', workspace: { agents: ['claude'] }, problems: [] },
    } as unknown as NonNullable<Harness['workspace']>;
    renderWithHarness(<Composer />, { activeThread: thread({ activeAgent: 'qwen-local' }), availability, workspace });
    expect(screen.getByRole('button', { name: /^Claude$/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Qwen Code/ })).toBeNull();
    expect(input().placeholder).toContain('Claude');
  });

  test('uses the server label and a safe fallback for an unknown profile style', () => {
    const profile = {
      agent: 'claude', profileId: 'future-profile', label: 'Future Worker', adapterId: 'future', model: 'future',
      available: true, detail: 'ok', capabilities: { streamingToolOutput: false, streamingText: true, reasoning: false, plans: false, turnDiff: false, approvals: false, resumableSessions: false },
    } as unknown as AgentAvailability;
    renderWithHarness(<Composer />, { activeThread: thread(), availability: [profile] });
    expect(screen.getByRole('button', { name: 'Future Worker' })).toBeTruthy();
    expect(input().placeholder).toContain('Future Worker');
    expect(getAgentStyle('future-profile', 'Future Worker')).toEqual(getAgentStyle('future-profile', 'Future Worker'));
  });

  test('sharing one directory, any working agent blocks sending', () => {
    renderWithHarness(<Composer />, {
      activeThread: thread({ parallel: false }),
      runtime: idleRuntime({ busy: ['claude'], busyWith: 'claude' }),
    });

    type('hello');
    expect(sendButton()).toBeDisabled();
    expect(input().placeholder).toContain('is working');
  });

  test('with lanes, the idle agent can still be sent to while the other works', () => {
    const send = vi.fn();
    renderWithHarness(<Composer />, {
      activeThread: thread({ parallel: true, activeAgent: 'codex' }),
      runtime: idleRuntime({ busy: ['claude'], busyWith: 'claude' }),
      send,
    });

    // Claude is working in its own lane; Codex is free, and it is the one selected.
    expect(input().placeholder).toContain('Message');
    type('meanwhile');
    expect(sendButton()).not.toBeDisabled();
    sendButton().click();
    expect(send).toHaveBeenCalledWith('meanwhile', 'codex');
  });

  test('with lanes, the agent that is working is still blocked from a second turn', () => {
    renderWithHarness(<Composer />, {
      activeThread: thread({ parallel: true, activeAgent: 'claude' }),
      runtime: idleRuntime({ busy: ['claude'], busyWith: 'claude' }),
    });

    type('again');
    expect(sendButton()).toBeDisabled();
  });

  test('with lanes, Stop interrupts the selected agent rather than everything', async () => {
    const interrupt = vi.fn();
    renderWithHarness(<Composer />, {
      activeThread: thread({ parallel: true, activeAgent: 'codex' }),
      runtime: idleRuntime({ busy: ['claude', 'codex'], busyWith: 'claude' }),
      interrupt,
    });

    screen.getByRole('button', { name: /stop/i }).click();
    expect(interrupt).toHaveBeenCalledWith('codex');
  });

  test('sharing one directory, Stop names no agent because there is only one turn', () => {
    const interrupt = vi.fn();
    renderWithHarness(<Composer />, {
      activeThread: thread({ parallel: false }),
      runtime: idleRuntime({ busy: ['claude'], busyWith: 'claude' }),
      interrupt,
    });

    screen.getByRole('button', { name: /stop/i }).click();
    expect(interrupt).toHaveBeenCalledWith(undefined);
  });
});
