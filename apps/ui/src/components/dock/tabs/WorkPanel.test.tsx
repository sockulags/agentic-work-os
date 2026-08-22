import { describe, expect, test, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { WorkItem, WorkSourceError } from '@awos/protocol';
import { renderWithHarness, idleRuntime } from '@/test-harness';
import type { RunView } from '@/lib/runs';
import { WorkPanel } from './WorkPanel';

const REVISION = '2026-08-22T19:26:05Z';

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'w1',
    workspaceRoot: '/repo',
    source: {
      repo: 'sockulags/agentic-work-os',
      number: 14,
      url: 'https://github.com/sockulags/agentic-work-os/issues/14',
    },
    snapshot: {
      title: 'Execute one GitHub issue as a work item',
      body: 'The body.',
      state: 'OPEN',
      labels: ['enhancement'],
      author: 'sockulags',
      revision: REVISION,
    },
    attachedAt: 1,
    fetchedAt: 1,
    lastRefreshedAt: 1,
    ...overrides,
  };
}

function run(overrides: Partial<RunView> = {}): RunView {
  return {
    runId: 'r1',
    agent: 'claude',
    instruction: 'start on this',
    context: '<work-item>the issue as it was</work-item>',
    revision: REVISION,
    state: 'completed',
    detail: null,
    ts: 1,
    ...overrides,
  };
}

function render(harness: Record<string, unknown> = {}) {
  return renderWithHarness(<WorkPanel />, {
    activeThreadId: 't1',
    work: { threadId: 't1', item: item(), error: null, busy: false },
    runs: [],
    ...harness,
  });
}

describe('WorkPanel', () => {
  test('shows the issue the thread is answering', () => {
    render();

    expect(screen.getByText(/sockulags\/agentic-work-os#14/)).toBeTruthy();
    expect(screen.getByText('Execute one GitHub issue as a work item')).toBeTruthy();
  });

  test('offers to attach one when the thread has none', () => {
    render({ work: { threadId: 't1', item: null, error: null, busy: false } });

    expect(screen.getByLabelText('Issue reference')).toBeTruthy();
  });

  test('attaches what was typed', () => {
    const attachWorkItem = vi.fn();
    render({
      work: { threadId: 't1', item: null, error: null, busy: false },
      attachWorkItem,
    });

    fireEvent.change(screen.getByLabelText('Issue reference'), { target: { value: '#14' } });
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));

    expect(attachWorkItem).toHaveBeenCalledWith('#14');
  });

  test('a failure says what to do about it', () => {
    const error: WorkSourceError = {
      kind: 'auth',
      message: 'GitHub refused the request. Run `gh auth login` and try again.',
      retryable: true,
    };
    render({ work: { threadId: 't1', item: null, error, busy: false } });

    expect(screen.getByText(/gh auth login/)).toBeTruthy();
  });

  test('a failed refresh keeps the issue it could not update', () => {
    const error: WorkSourceError = { kind: 'offline', message: 'Could not reach GitHub.', retryable: true };
    render({ work: { threadId: 't1', item: item(), error, busy: false } });

    expect(screen.getByText(/Could not reach GitHub/)).toBeTruthy();
    expect(screen.getByText('Execute one GitHub issue as a work item')).toBeTruthy();
  });

  test('asks GitHub again on request', () => {
    const refreshWorkItem = vi.fn();
    render({ refreshWorkItem });

    fireEvent.click(screen.getByTitle('Ask GitHub again'));

    expect(refreshWorkItem).toHaveBeenCalled();
  });

  describe('runs', () => {
    test('says what happens when there are none rather than showing an empty list', () => {
      render();

      expect(screen.getByText(/No runs yet/)).toBeTruthy();
    });

    test('shows what a run asked for and how it ended', () => {
      render({ runs: [run({ state: 'error', detail: 'the CLI died' })] });

      expect(screen.getByText('start on this')).toBeTruthy();
      expect(screen.getByText('Failed')).toBeTruthy();
      expect(screen.getByText('the CLI died')).toBeTruthy();
    });

    test('the context sent is inspectable, which is the point of recording it', () => {
      render({ runs: [run()] });

      expect(screen.queryByText(/the issue as it was/)).toBeNull();
      fireEvent.click(screen.getByText('Inspect the context sent'));

      expect(screen.getByText(/the issue as it was/)).toBeTruthy();
    });

    test('flags a run whose source has moved since, without changing the run', () => {
      render({
        work: {
          threadId: 't1',
          item: item({
            snapshot: { ...item().snapshot, revision: '2026-09-01T08:00:00Z', title: 'Rewritten' },
          }),
          error: null,
          busy: false,
        },
        runs: [run()],
      });

      expect(screen.getByText(/changed since this run/)).toBeTruthy();
      fireEvent.click(screen.getByText('Inspect the context sent'));
      expect(screen.getByText(/the issue as it was/)).toBeTruthy();
    });

    test('leaves a run alone when the source has not moved', () => {
      render({ runs: [run()] });

      expect(screen.queryByText(/changed since this run/)).toBeNull();
    });
  });

  describe('starting work', () => {
    test('sends the instruction to the thread agent', () => {
      const startRun = vi.fn();
      render({
        startRun,
        activeThread: { activeAgent: 'codex' },
        runtime: idleRuntime(),
      });

      fireEvent.change(screen.getByLabelText('Run instruction'), {
        target: { value: 'do the first slice' },
      });
      fireEvent.click(screen.getByRole('button', { name: /Start work with codex/ }));

      expect(startRun).toHaveBeenCalledWith('do the first slice', 'codex');
    });

    test('will not start a second run while that agent is working', () => {
      const startRun = vi.fn();
      render({
        startRun,
        activeThread: { activeAgent: 'claude' },
        runtime: idleRuntime({ busy: ['claude'] }),
      });

      fireEvent.change(screen.getByLabelText('Run instruction'), { target: { value: 'again' } });
      fireEvent.click(screen.getByRole('button', { name: /claude is working/ }));

      expect(startRun).not.toHaveBeenCalled();
    });
  });

  test('waits rather than guessing before the item has arrived', () => {
    renderWithHarness(<WorkPanel />, { activeThreadId: 't1', work: null, runs: [] });

    expect(screen.getByText(/Loading the work item/)).toBeTruthy();
  });
});
