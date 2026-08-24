import { describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type {
  CatalogIssue,
  IssuePreparation,
  ProjectOverview as ProjectOverviewModel,
  ProjectOverviewItem,
  ProjectIssueDetail,
} from '@awos/protocol';
import { renderWithHarness } from '@/test-harness';
import { ProjectOverview } from './ProjectOverview';

const CWD = '/repo';

function issue(number: number, title = `Issue ${number}`): CatalogIssue {
  return {
    number,
    url: `https://github.com/owner/repo/issues/${number}`,
    title,
    state: 'OPEN',
    labels: ['bug'],
    assignees: [],
    updatedAt: '2026-08-24T10:00:00Z',
  };
}

function source(overrides: Partial<ProjectOverviewModel['source']> = {}): ProjectOverviewModel['source'] {
  return {
    workspaceRoot: CWD,
    repository: 'owner/repo',
    freshness: 'current',
    complete: true,
    successfulAt: Date.now(),
    issues: [],
    error: null,
    ...overrides,
  };
}

function item(overrides: Partial<ProjectOverviewItem> = {}): ProjectOverviewItem {
  return {
    issue: issue(1, 'Fix the worker status'),
    group: 'available',
    statusLabel: 'Ready',
    projectAction: 'Implement issue',
    responsibleRole: { id: 'implementer', label: 'Implementer' },
    workers: [{ profileId: 'claude', label: 'Claude', available: true }],
    action: 'take',
    reasonCode: 'available',
    reason: 'Ready to take: Implement issue.',
    linkedWork: null,
    ...overrides,
  };
}

function model(items: readonly ProjectOverviewItem[] = [item()]): ProjectOverviewModel {
  return {
    cwd: CWD,
    workspace: {
      root: CWD,
      name: 'Project',
      repository: 'owner/repo',
      roles: [
        { id: 'implementer', label: 'Implementer' },
        { id: 'reviewer', label: 'Reviewer' },
      ],
    },
    roleSelection: {
      status: 'selected',
      roleId: 'implementer',
      role: { id: 'implementer', label: 'Implementer' },
    },
    source: source({ issues: items.map((entry) => entry.issue) }),
    items,
  };
}

function detailFor(
  entry: ProjectOverviewItem,
  body = 'Source body with **detail**.',
  actionOverride: ProjectIssueDetail['action']['action'] | null = null,
): ProjectIssueDetail {
  const detailAction = actionOverride ?? entry.action;
  const detailReasonCode = detailAction === 'take' ? 'available' : entry.reasonCode;
  const detailReason = detailAction === 'take' ? 'The current detail projection is ready to take.' : entry.reason;
  return {
    cwd: CWD,
    issue: entry.issue,
    snapshot: {
      title: entry.issue.title,
      body,
      state: entry.issue.state,
      labels: entry.issue.labels,
      author: 'lucas',
      revision: entry.issue.updatedAt,
    },
    bodyTruncated: false,
    source: {
      kind: 'github',
      freshness: 'current',
      catalogFreshness: 'current',
      fetchedAt: Date.now(),
      checkedAt: Date.now(),
      revision: entry.issue.updatedAt,
      assigneesKnown: true,
      assigneesSource: 'catalog',
      error: null,
    },
    route: {
      sourceFreshness: 'current',
      route: {
        status: 'routed',
        matchingRouteIds: ['bug'],
        routeId: 'bug',
        stepId: 'implement',
        workspaceProblems: [],
      },
      action: {
        status: detailAction === 'take' ? 'available' : 'not-routed',
        reason: detailAction === 'take' ? 'available' : 'not-routed',
        projectAction: entry.projectAction,
        responsibleRole: entry.responsibleRole,
        allowedWorkerProfileIds: entry.workers.map((worker) => worker.profileId),
        availability: entry.workers.map((worker) => ({ profileId: worker.profileId, entries: [], available: worker.available })),
        unavailableWorkerProfileIds: entry.workers.filter((worker) => !worker.available).map((worker) => worker.profileId),
        roleSelection: model().roleSelection,
      },
    },
    action: {
      action: detailAction,
      reasonCode: detailReasonCode,
      reason: detailReason,
      projectAction: entry.projectAction,
      responsibleRole: entry.responsibleRole,
      workers: entry.workers,
      refusal: detailAction === 'none' ? { code: 'workers-unavailable', message: detailReason } : null,
    },
    linkedThreads: [],
    canonicalThreadId: null,
    timeline: [],
    historyTruncated: false,
  };
}

function preparation(
  mode: IssuePreparation['mode'] = 'taken',
  workers: IssuePreparation['allowedWorkerProfileIds'] = ['claude'],
): IssuePreparation {
  return {
    threadId: 'thread-1',
    workItemId: 'work-1',
    mode,
    route: { routeId: 'bug', stepId: 'implement', action: 'Implement issue', role: { id: 'implementer', label: 'Implementer' } },
    allowedWorkerProfileIds: workers,
    currentlyAvailableWorkerProfileIds: mode === 'taken' ? workers : [],
    workerAvailability: mode === 'taken' ? 'checked' : 'not-checked',
    instruction: {
      kind: 'github-issue',
      repository: 'owner/repo',
      issueNumber: 1,
      url: issue(1).url,
      title: issue(1).title,
      revision: issue(1).updatedAt,
    },
  };
}

function renderOverview(
  overview: ProjectOverviewModel | null,
  overrides: Record<string, unknown> = {},
  onOpenThread: () => void = vi.fn(),
): void {
  renderWithHarness(
    <ProjectOverview cwd={CWD} onOpenThread={onOpenThread} />,
    {
      projectOverview: overview === null ? null : { cwd: CWD, overview, error: null, busy: false },
      ...overrides,
    },
  );
}

describe('ProjectOverview', () => {
  test('renders the three semantic groups, compact row fields, and inline reason', () => {
    renderOverview(
      model([
        item(),
        item({ issue: issue(2, 'Continue local work'), group: 'active', action: 'continue', statusLabel: 'Interrupted', reasonCode: 'active-interrupted', reason: 'The last local run was interrupted by restart.', linkedWork: { thread: { threadId: 'thread-2', workItemId: 'work-2', title: 'Local', updatedAt: 2 }, latestRun: null } }),
        item({ issue: issue(3, 'No worker'), group: 'blocked', action: 'none', statusLabel: 'Worker unavailable', reasonCode: 'worker-unavailable', reason: 'No allowed worker is available for the Implementer role.', workers: [{ profileId: 'claude', label: 'Claude', available: false }] }),
      ]),
    );

    expect(screen.getByRole('heading', { name: 'Available' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Active' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Blocked' })).toBeTruthy();
    expect(screen.getByText('#1')).toBeTruthy();
    expect(screen.getAllByText('Implement issue')).not.toHaveLength(0);
    expect(screen.getAllByText('Claude available')).not.toHaveLength(0);
    expect(screen.getByText('No allowed worker is available for the Implementer role.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Take issue' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    expect(screen.getByText('No action available')).toBeTruthy();
  });

  test('changes the local active role through the shared role RPC seam', () => {
    const setProjectOverviewRole = vi.fn();
    renderOverview(model(), { setProjectOverviewRole });

    fireEvent.change(screen.getByLabelText('Active role'), { target: { value: 'reviewer' } });

    expect(setProjectOverviewRole).toHaveBeenCalledWith(CWD, 'reviewer');
  });

  test('keeps Continue during a dated source failure and does not start a worker', async () => {
    const openIssue = vi.fn().mockResolvedValue({ ok: true, preparation: preparation('continued') });
    const startRun = vi.fn();
    const onOpenThread = vi.fn();
    renderWithHarness(
      <ProjectOverview cwd={CWD} onOpenThread={onOpenThread} />,
      {
        projectOverview: {
          cwd: CWD,
          overview: model([
            item({
              issue: issue(2, 'Continue local work'),
              group: 'active',
              action: 'continue',
              statusLabel: 'Interrupted',
              reasonCode: 'active-interrupted',
              reason: 'The last local run was interrupted by restart.',
              linkedWork: { thread: { threadId: 'thread-2', workItemId: 'work-2', title: 'Local', updatedAt: 2 }, latestRun: null },
            }),
          ]),
          error: { kind: 'offline', message: 'GitHub is unavailable.', retryable: true },
          busy: false,
        },
        openIssue,
        startRun,
      },
    );

    expect(screen.getByText(/cached from|Last refreshed/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(screen.getByText(/same local destination/i)).toBeTruthy();
    expect(startRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open same thread' }));
    expect(openIssue).toHaveBeenCalledWith(CWD, 2);
    expect(onOpenThread).toHaveBeenCalledWith('thread-1');
  });

  test('Take uses issue.open, shows preparation, and only opens the thread after confirmation', async () => {
    const openIssue = vi.fn().mockResolvedValue({ ok: true, preparation: preparation() });
    const startRun = vi.fn();
    const onOpenThread = vi.fn();
    renderOverview(model(), { openIssue, startRun }, onOpenThread);

    fireEvent.click(screen.getByRole('button', { name: 'Take issue' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(screen.getByText('Choose worker')).toBeTruthy();
    expect(screen.getByText(/Confirming this does not start a worker/)).toBeTruthy();
    expect(startRun).not.toHaveBeenCalled();
    expect(onOpenThread).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Confirm preparation only' }).closest('.project-overview-dialog-footer')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm preparation only' }));
    await waitFor(() => expect(onOpenThread).toHaveBeenCalledWith('thread-1'));
    expect(openIssue).toHaveBeenCalledWith(CWD, 1);
  });

  test('persists a selected non-default worker before opening Take and never starts a run', async () => {
    const openIssue = vi.fn().mockResolvedValue({ ok: true, preparation: preparation('taken', ['claude', 'codex']) });
    const setThreadAgent = vi.fn().mockResolvedValue(undefined);
    const startRun = vi.fn();
    const onOpenThread = vi.fn();
    renderOverview(
      model([item({ workers: [
        { profileId: 'claude', label: 'Claude', available: true },
        { profileId: 'codex', label: 'Codex', available: true },
      ] })]),
      { openIssue, setThreadAgent, startRun },
      onOpenThread,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Take issue' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    fireEvent.click(screen.getByRole('radio', { name: /Codex/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm preparation only' }));

    await waitFor(() => expect(setThreadAgent).toHaveBeenCalledWith('thread-1', 'codex'));
    expect(startRun).not.toHaveBeenCalled();
    expect(onOpenThread).toHaveBeenCalledWith('thread-1');
  });

  test('keeps Take closed and shows a worker-save failure', async () => {
    const openIssue = vi.fn().mockResolvedValue({ ok: true, preparation: preparation('taken', ['claude', 'codex']) });
    const setThreadAgent = vi.fn().mockRejectedValue(new Error('Worker preference could not be saved.'));
    const onOpenThread = vi.fn();
    renderOverview(
      model([item({ workers: [
        { profileId: 'claude', label: 'Claude', available: true },
        { profileId: 'codex', label: 'Codex', available: true },
      ] })]),
      { openIssue, setThreadAgent },
      onOpenThread,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Take issue' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    fireEvent.click(screen.getByRole('radio', { name: /Codex/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm preparation only' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Worker preference could not be saved.');
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  test('uses the fetched detail action when the overview row is currently none', async () => {
    const blocked = item({
      issue: issue(4, 'Detail becomes takeable'),
      group: 'blocked',
      action: 'none',
      reasonCode: 'worker-unavailable',
      statusLabel: 'Worker unavailable',
      reason: 'The overview has not observed the current worker state yet.',
      workers: [{ profileId: 'claude', label: 'Claude', available: false }],
    });
    const openProjectIssueDetail = vi.fn().mockResolvedValue({ detail: detailFor(blocked, 'Current detail body.', 'take'), error: null });
    const openIssue = vi.fn().mockResolvedValue({ ok: false, code: 'workers-unavailable', message: 'Core refusal' });
    renderOverview(model([blocked]), { openProjectIssueDetail, openIssue });

    expect(screen.queryByRole('button', { name: 'Take issue' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View details for issue #4' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Take issue' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Take issue' }));

    await waitFor(() => expect(openIssue).toHaveBeenCalledWith(CWD, 4));
  });

  test('does not offer Take when core detail reports route-changed refresh required', async () => {
    const current = item({
      issue: issue(103, 'Catalog/detail drift'),
      group: 'blocked',
      action: 'none',
      reasonCode: 'not-routed',
      statusLabel: 'No route',
      reason: 'No project action matches the current catalog labels.',
      workers: [],
    });
    const detail = detailFor(current, 'Fetched detail body.');
    detail.action = {
      ...detail.action,
      reasonCode: 'refresh-required',
      reason: 'Refresh the issue catalog before taking this issue: fetched detail differs from the current catalog row.',
      refusal: {
        code: 'route-changed',
        message: 'Refresh the issue catalog before taking this issue: fetched detail differs from the current catalog row.',
      },
    };
    const openProjectIssueDetail = vi.fn().mockResolvedValue({ detail, error: null });
    renderOverview(model([current]), { openProjectIssueDetail });

    fireEvent.click(screen.getByRole('button', { name: 'View details for issue #103' }));
    await waitFor(() => expect(screen.getAllByText(/Refresh the issue catalog/).length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: 'Take issue' })).toBeNull();
    expect(screen.getByText('route-changed')).toBeTruthy();
  });

  test('refreshes selected detail after an overview role/model update without refocusing it', async () => {
    const first = item({ issue: issue(5, 'Role-sensitive detail') });
    const refreshed = item({
      ...first,
      group: 'blocked',
      action: 'none',
      reasonCode: 'role-mismatch',
      statusLabel: 'Role mismatch',
      reason: 'The selected role changed.',
    });
    const refreshedModel = model([refreshed]);
    refreshedModel.roleSelection = { status: 'selected', roleId: 'reviewer', role: { id: 'reviewer', label: 'Reviewer' } };
    const projectOverview = { cwd: CWD, overview: model([first]), error: null, busy: false };
    const openProjectIssueDetail = vi.fn()
      .mockResolvedValueOnce({ detail: detailFor(first, 'Initial detail body.'), error: null })
      .mockResolvedValueOnce({ detail: detailFor(refreshed, 'Refreshed detail body.'), error: null });
    const view = renderWithHarness(<ProjectOverview cwd={CWD} onOpenThread={vi.fn()} />, {
      projectOverview,
      openProjectIssueDetail,
    });

    fireEvent.click(screen.getByRole('button', { name: 'View details for issue #5' }));
    await waitFor(() => expect(screen.getByText('Initial detail body.')).toBeTruthy());
    expect(screen.getByRole('heading', { name: /#5/ })).toHaveFocus();

    projectOverview.overview = refreshedModel;
    view.rerender(<ProjectOverview cwd={CWD} onOpenThread={vi.fn()} />);
    await waitFor(() => expect(openProjectIssueDetail).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('Refreshed detail body.')).toBeTruthy());
    expect(openProjectIssueDetail).toHaveBeenLastCalledWith(CWD, 5);
    expect(screen.getByRole('heading', { name: /#5/ })).toHaveFocus();
  });

  test('waits for the read model and handles no nearest workspace without inventing rows', () => {
    renderWithHarness(<ProjectOverview cwd={CWD} onOpenThread={vi.fn()} />, { projectOverview: null });
    expect(screen.getByRole('status')).toHaveTextContent(/Reading the workspace/);

    cleanup();
    renderWithHarness(<ProjectOverview cwd={null} onOpenThread={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent(/Open or create a thread/);
  });

  test('opens the selected detail heading, ignores a late response, and returns focus to the invoking control', async () => {
    const first = item({ issue: issue(1, 'First detail') });
    const second = item({ issue: issue(2, 'Second detail') });
    let resolveFirst!: (value: { detail: ProjectIssueDetail; error: null }) => void;
    let resolveSecond!: (value: { detail: ProjectIssueDetail; error: null }) => void;
    const firstPromise = new Promise<{ detail: ProjectIssueDetail; error: null }>((resolve) => { resolveFirst = resolve; });
    const secondPromise = new Promise<{ detail: ProjectIssueDetail; error: null }>((resolve) => { resolveSecond = resolve; });
    const openProjectIssueDetail = vi.fn()
      .mockImplementationOnce(() => firstPromise)
      .mockImplementationOnce(() => secondPromise);
    renderOverview(model([first, second]), { openProjectIssueDetail });

    const firstInvoker = screen.getByRole('button', { name: 'View details for issue #1' });
    const secondInvoker = screen.getByRole('button', { name: 'View details for issue #2' });
    fireEvent.click(firstInvoker);
    fireEvent.click(secondInvoker);

    await act(async () => resolveFirst({ detail: detailFor(first), error: null }));
    expect(screen.getByRole('heading', { name: /#2/ })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /#1/ })).toBeNull();

    await act(async () => resolveSecond({ detail: detailFor(second), error: null }));
    await waitFor(() => expect(screen.getByRole('heading', { name: /#2/ })).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: 'Close issue details' }));
    await waitFor(() => expect(secondInvoker).toHaveFocus());
  });

  test('returns focus to the current Details control when the row moves groups', async () => {
    const first = item({ issue: issue(6, 'Moving row') });
    const moved = item({
      ...first,
      group: 'active',
      action: 'continue',
      reasonCode: 'active',
      statusLabel: 'Local work',
      reason: 'The row moved to active work.',
    });
    const projectOverview = { cwd: CWD, overview: model([first]), error: null, busy: false };
    const openProjectIssueDetail = vi.fn().mockResolvedValue({ detail: detailFor(first), error: null });
    const view = renderWithHarness(<ProjectOverview cwd={CWD} onOpenThread={vi.fn()} />, { projectOverview, openProjectIssueDetail });

    fireEvent.click(screen.getByRole('button', { name: 'View details for issue #6' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: /#6/ })).toHaveFocus());
    const oldInvoker = screen.getByRole('button', { name: 'View details for issue #6' });

    projectOverview.overview = model([moved]);
    view.rerender(<ProjectOverview cwd={CWD} onOpenThread={vi.fn()} />);
    await waitFor(() => expect(openProjectIssueDetail).toHaveBeenCalledTimes(2));
    const currentInvoker = screen.getByRole('button', { name: 'View details for issue #6' });
    expect(currentInvoker).not.toBe(oldInvoker);
    fireEvent.click(screen.getByRole('button', { name: 'Close issue details' }));
    await waitFor(() => expect(currentInvoker).toHaveFocus());
  });

  test('refetches a disappeared issue, removes stale Take after not-found, and returns focus to the overview heading', async () => {
    const selected = item({ issue: issue(7, 'Disappearing row') });
    const projectOverview = { cwd: CWD, overview: model([selected]), error: null, busy: false };
    const openProjectIssueDetail = vi.fn()
      .mockResolvedValueOnce({ detail: detailFor(selected), error: null })
      .mockResolvedValueOnce({
        detail: null,
        error: { kind: 'not-found', message: 'Issue #7 is no longer in the current overview source.', retryable: false },
      });
    const view = renderWithHarness(<ProjectOverview cwd={CWD} onOpenThread={vi.fn()} />, { projectOverview, openProjectIssueDetail });

    fireEvent.click(screen.getByRole('button', { name: 'View details for issue #7' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: /#7/ })).toHaveFocus());
    expect(screen.getAllByRole('button', { name: 'Take issue' }).length).toBeGreaterThanOrEqual(2);

    projectOverview.overview = model([]);
    view.rerender(<ProjectOverview cwd={CWD} onOpenThread={vi.fn()} />);
    await waitFor(() => expect(openProjectIssueDetail).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Take issue' })).toBeNull());
    expect(screen.getByText('Issue #7 is no longer in the current overview source.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close issue details' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close issue details' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: /^Project$/ })).toHaveFocus());
  });
});
