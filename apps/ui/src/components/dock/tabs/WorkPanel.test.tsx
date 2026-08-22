import { describe, expect, test, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { EvidenceItem, RetainedItem, WorkItem, WorkSourceError } from '@awos/protocol';
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
    outcome: null,
    evidence: [],
    candidates: [],
    ...overrides,
  };
}

function evidence(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: 'ev1',
    runId: 'r1',
    workItemId: 'w1',
    threadId: 't1',
    kind: 'command',
    ref: { eventId: 'e-cmd', url: null, label: 'npm test' },
    summary: '269 passed',
    state: { commit: 'abc1234def', tree: 'tree1', dirty: false },
    check: null,
    source: 'user',
    at: 2,
    ...overrides,
  };
}

function kept(overrides: Partial<RetainedItem> = {}): RetainedItem {
  return {
    id: 'k1',
    workItemId: 'w1',
    kind: 'decision',
    text: 'gh, never a token of our own',
    runId: 'r1',
    threadId: 't1',
    source: 'claude',
    at: 3,
    selected: true,
    retired: false,
    ...overrides,
  };
}

function render(harness: Record<string, unknown> = {}) {
  return renderWithHarness(<WorkPanel />, {
    activeThreadId: 't1',
    work: { threadId: 't1', item: item(), error: null, retained: [], busy: false },
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
    render({ work: { threadId: 't1', item: null, error: null, retained: [], busy: false } });

    expect(screen.getByLabelText('Issue reference')).toBeTruthy();
  });

  test('attaches what was typed', () => {
    const attachWorkItem = vi.fn();
    render({
      work: { threadId: 't1', item: null, error: null, retained: [], busy: false },
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
    render({ work: { threadId: 't1', item: null, error, retained: [], busy: false } });

    expect(screen.getByText(/gh auth login/)).toBeTruthy();
  });

  test('a failed refresh keeps the issue it could not update', () => {
    const error: WorkSourceError = { kind: 'offline', message: 'Could not reach GitHub.', retryable: true };
    render({ work: { threadId: 't1', item: item(), error, retained: [], busy: false } });

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
          retained: [],
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

describe('WorkPanel outcomes', () => {
  test('a run with no claim offers to state one', () => {
    render({ runs: [run()] });

    expect(screen.getByText('Close this run with an outcome')).toBeTruthy();
  });

  test('the claim is shown beside the terminal state, not instead of it', () => {
    render({
      runs: [
        run({
          state: 'completed',
          outcome: {
            runId: 'r1',
            claim: 'partial',
            statement: 'the parser is done, the UI is not',
            source: 'user',
            at: 4,
          },
        }),
      ],
    });

    // How the process ended and what the run achieved are different facts.
    expect(screen.getByText('Finished')).toBeTruthy();
    expect(screen.getByText('Partly done')).toBeTruthy();
    expect(screen.getByText('the parser is done, the UI is not')).toBeTruthy();
    expect(screen.getByText(/claimed by user/)).toBeTruthy();
  });

  test('records what was claimed', () => {
    const closeRun = vi.fn();
    render({ runs: [run()], closeRun });

    fireEvent.click(screen.getByText('Close this run with an outcome'));
    fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'blocked' } });
    fireEvent.change(screen.getByLabelText('Outcome statement'), {
      target: { value: 'waiting on the API key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record the outcome' }));

    expect(closeRun).toHaveBeenCalledWith('r1', 'blocked', 'waiting on the API key');
  });

  test('a stated claim can be restated, because finding out later is normal', () => {
    const closeRun = vi.fn();
    render({
      runs: [
        run({
          outcome: { runId: 'r1', claim: 'delivered', statement: 'done', source: 'claude', at: 4 },
        }),
      ],
      closeRun,
    });

    fireEvent.click(screen.getByText('Restate'));
    fireEvent.change(screen.getByLabelText('Outcome statement'), {
      target: { value: 'the tests were passing for the wrong reason' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record the outcome' }));

    expect(closeRun).toHaveBeenCalledWith('r1', 'delivered', 'the tests were passing for the wrong reason');
  });
});

describe('WorkPanel evidence', () => {
  test('shows the item itself rather than a pass/fail badge', () => {
    render({ runs: [run({ evidence: [evidence()] })] });

    expect(screen.getByText('269 passed')).toBeTruthy();
    expect(screen.getByText('npm test')).toBeTruthy();
    // Which tree the claim is about is part of the claim.
    expect(screen.getByText(/abc1234/)).toBeTruthy();
  });

  test('says when the tree it applies to had uncommitted work in it', () => {
    render({
      runs: [
        run({
          evidence: [evidence({ state: { commit: 'abc1234def', tree: 't', dirty: true } })],
        }),
      ],
    });

    expect(screen.getByText(/with uncommitted changes/)).toBeTruthy();
  });

  test('attaches a fact from the run without retyping it', () => {
    const recordEvidence = vi.fn();
    render({
      runs: [
        run({
          candidates: [
            { eventId: 'e-cmd', kind: 'command', label: 'npm test', detail: 'ok (exit 0)' },
          ],
        }),
      ],
      recordEvidence,
    });

    fireEvent.click(screen.getByText('Add evidence'));
    fireEvent.click(screen.getByText('npm test'));

    expect(recordEvidence).toHaveBeenCalledWith(
      'r1',
      'command',
      { eventId: 'e-cmd', url: null, label: 'npm test' },
      'ok (exit 0)',
    );
  });

  test('does not offer a fact that is already attached', () => {
    render({
      runs: [
        run({
          evidence: [evidence()],
          candidates: [
            { eventId: 'e-cmd', kind: 'command', label: 'npm test', detail: 'ok (exit 0)' },
          ],
        }),
      ],
    });

    fireEvent.click(screen.getByText('Add evidence'));
    // The attached item still shows its label; the candidate button is gone.
    expect(screen.queryByText(/ok \(exit 0\)/)).toBeNull();
  });

  test('takes an external link a person vouches for', () => {
    const recordEvidence = vi.fn();
    render({ runs: [run()], recordEvidence });

    fireEvent.click(screen.getByText('Add evidence'));
    fireEvent.change(screen.getByLabelText('Evidence link'), {
      target: { value: 'https://example.com/ci/9' },
    });
    fireEvent.change(screen.getByLabelText('Evidence summary'), { target: { value: 'green' } });
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));

    expect(recordEvidence).toHaveBeenCalledWith(
      'r1',
      'link',
      { eventId: null, url: 'https://example.com/ci/9', label: 'https://example.com/ci/9' },
      'green',
    );
  });
});

describe('WorkPanel retained context', () => {
  test('shows what earlier work established, and who established it', () => {
    render({
      work: { threadId: 't1', item: item(), error: null, retained: [kept()], busy: false },
    });

    expect(screen.getByText('gh, never a token of our own')).toBeTruthy();
    expect(screen.getByText('Decided')).toBeTruthy();
    // Attribution, not just the words: who believed this changes what it is worth.
    expect(screen.getByText('· claude')).toBeTruthy();
  });

  test('keeps something new against the work item', () => {
    const retainContext = vi.fn();
    render({ retainContext });

    fireEvent.click(screen.getByText('Keep something'));
    fireEvent.change(screen.getByLabelText('What kind'), { target: { value: 'constraint' } });
    fireEvent.change(screen.getByLabelText('What to keep'), {
      target: { value: 'no network in tests' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));

    expect(retainContext).toHaveBeenCalledWith('constraint', 'no network in tests', null);
  });

  test('unticking one stops carrying it forward', () => {
    const amendRetained = vi.fn();
    render({
      work: { threadId: 't1', item: item(), error: null, retained: [kept()], busy: false },
      amendRetained,
    });

    fireEvent.click(screen.getByLabelText(/Carry forward/));

    expect(amendRetained).toHaveBeenCalledWith('k1', { selected: false });
  });

  test('retiring one keeps it, out of the way', () => {
    const amendRetained = vi.fn();
    render({
      work: { threadId: 't1', item: item(), error: null, retained: [kept()], busy: false },
      amendRetained,
    });

    fireEvent.click(screen.getByText('Retire'));

    expect(amendRetained).toHaveBeenCalledWith('k1', { retired: true, selected: false });
  });

  test('retired items are still readable, not gone', () => {
    render({
      work: {
        threadId: 't1',
        item: item(),
        error: null,
        retained: [kept({ retired: true, selected: false, text: 'turned out to be wrong' })],
        busy: false,
      },
    });

    expect(screen.getByText('1 retired')).toBeTruthy();
    expect(screen.getByText('turned out to be wrong')).toBeTruthy();
  });
});

describe('WorkPanel integration gate', () => {
  const lane = idleRuntime({ lanes: { claude: '/lanes/claude' } });

  function gate(overrides: Record<string, unknown> = {}) {
    return {
      claude: {
        agent: 'claude' as const,
        allowed: false,
        requirements: [
          {
            name: 'test',
            command: 'npm test',
            state: 'missing' as const,
            evidenceId: null,
            evidenceTree: null,
          },
        ],
        candidate: { commit: 'abc1234def', tree: 'tree1234567', dirty: false },
        ...overrides,
      },
    };
  }

  test('is not shown when there is no lane to integrate', () => {
    render({ runtime: idleRuntime(), gates: gate() });

    expect(screen.queryByText(/Before integrating/)).toBeNull();
  });

  test('names each requirement, what it runs, and where it stands', () => {
    render({ runtime: lane, gates: gate() });

    expect(screen.getByText('test')).toBeTruthy();
    expect(screen.getByText('npm test')).toBeTruthy();
    expect(screen.getByText('has not been run')).toBeTruthy();
    // Which content is being judged is part of the verdict.
    expect(screen.getByText(/candidate tree123/)).toBeTruthy();
  });

  test('distinguishes stale from failed, because they need different moves', () => {
    render({
      runtime: lane,
      gates: gate({
        requirements: [
          {
            name: 'test',
            command: 'npm test',
            state: 'stale',
            evidenceId: 'ev1',
            evidenceTree: 'older',
          },
        ],
      }),
    });

    expect(screen.getByText('passed against different content')).toBeTruthy();
  });

  test('runs a check in that lane', () => {
    const runCheck = vi.fn();
    render({ runtime: lane, gates: gate(), runCheck });

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    expect(runCheck).toHaveBeenCalledWith('claude', 'test');
  });

  test('offers integration once every requirement holds', () => {
    const integrateLane = vi.fn();
    render({
      runtime: lane,
      gates: gate({
        allowed: true,
        requirements: [
          {
            name: 'test',
            command: 'npm test',
            state: 'satisfied',
            evidenceId: 'ev1',
            evidenceTree: 'tree1234567',
          },
        ],
      }),
      integrateLane,
    });

    fireEvent.click(screen.getByRole('button', { name: /Integrate claude/ }));

    expect(integrateLane).toHaveBeenCalledWith('claude');
  });

  test('an override has to carry a reason', () => {
    const integrateLane = vi.fn();
    render({ runtime: lane, gates: gate(), integrateLane });

    fireEvent.click(screen.getByText('Integrate anyway'));
    fireEvent.click(screen.getByRole('button', { name: 'Integrate anyway' }));
    expect(integrateLane).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Override reason'), {
      target: { value: 'the suite is broken on main' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Integrate anyway' }));

    expect(integrateLane).toHaveBeenCalledWith('claude', { reason: 'the suite is broken on main' });
  });

  test('says plainly when a project requires nothing', () => {
    render({ runtime: lane, gates: gate({ allowed: true, requirements: [] }) });

    expect(screen.getByText(/nothing required before integrating/)).toBeTruthy();
  });
});
