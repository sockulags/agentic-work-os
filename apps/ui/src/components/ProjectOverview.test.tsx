import { describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type {
  CatalogIssue,
  IssuePreparation,
  ProjectOverview as ProjectOverviewModel,
  ProjectOverviewItem,
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

  test('waits for the read model and handles no nearest workspace without inventing rows', () => {
    renderWithHarness(<ProjectOverview cwd={CWD} onOpenThread={vi.fn()} />, { projectOverview: null });
    expect(screen.getByRole('status')).toHaveTextContent(/Reading the workspace/);

    cleanup();
    renderWithHarness(<ProjectOverview cwd={null} onOpenThread={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent(/Open or create a thread/);
  });
});
