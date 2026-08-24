import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import type { ProjectIssueDetail, ProjectOverviewItem } from '@awos/protocol';
import { ProjectIssueDetail as ProjectIssueDetailPanel } from './ProjectIssueDetail';

const item: ProjectOverviewItem = {
  issue: {
    number: 145,
    url: 'https://github.com/owner/repo/issues/145',
    title: 'A title that remains readable when it is long enough to wrap across the narrow panel',
    state: 'OPEN',
    labels: ['bug', 'long-label-that-must-wrap-without-widening-the-panel'],
    assignees: ['lucas'],
    updatedAt: '2026-08-24T10:00:00Z',
  },
  group: 'blocked',
  statusLabel: 'Worker unavailable',
  projectAction: 'Implement issue',
  responsibleRole: { id: 'implementer', label: 'Implementer' },
  workers: [{ profileId: 'claude', label: 'Claude', available: false }],
  action: 'none',
  reasonCode: 'worker-unavailable',
  reason: 'No allowed worker is currently available.',
  linkedWork: null,
};

const detail: ProjectIssueDetail = {
  cwd: '/repo',
  issue: item.issue,
  snapshot: {
    title: item.issue.title,
    body: `${'Long source body '.repeat(100)}\n\n## Source heading`,
    state: 'OPEN',
    labels: item.issue.labels,
    author: 'lucas',
    revision: item.issue.updatedAt,
  },
  bodyTruncated: true,
  source: {
    kind: 'work-item-snapshot',
    freshness: 'cached',
    catalogFreshness: 'current',
    fetchedAt: 1,
    checkedAt: 2,
    revision: '2026-08-23T10:00:00Z',
    assigneesKnown: false,
    assigneesSource: 'work-item-snapshot',
    error: { kind: 'offline', message: 'GitHub is unavailable.', retryable: true },
  },
  route: {
    sourceFreshness: 'cached',
    route: {
      status: 'routed',
      matchingRouteIds: ['bug'],
      routeId: 'bug',
      stepId: 'implement',
      workspaceProblems: [],
    },
    action: {
      status: 'worker-unavailable',
      reason: 'worker-unavailable',
      projectAction: 'Implement issue',
      responsibleRole: { id: 'implementer', label: 'Implementer' },
      allowedWorkerProfileIds: ['claude'],
      availability: [{ profileId: 'claude', entries: [], available: false }],
      unavailableWorkerProfileIds: ['claude'],
      roleSelection: { status: 'selected', roleId: 'implementer', role: { id: 'implementer', label: 'Implementer' } },
    },
  },
  action: {
    action: 'none',
    reasonCode: 'worker-unavailable',
    reason: 'No allowed worker is currently available.',
    projectAction: 'Implement issue',
    responsibleRole: { id: 'implementer', label: 'Implementer' },
    workers: [{ profileId: 'claude', label: 'Claude', available: false }],
    refusal: { code: 'workers-unavailable', message: 'No allowed worker is currently available.' },
  },
  linkedThreads: [{
    thread: { threadId: 'thread-new', workItemId: 'work-1', title: 'Newest historical thread', updatedAt: 4 },
    runs: [{
      run: { runId: 'run-1', threadId: 'thread-new', agent: 'claude', startedAt: 3, state: 'interrupted', live: false, interruptedByRestart: true, evidenceCount: 1 },
      outcome: { runId: 'run-1', claim: 'blocked', statement: 'The run stopped at the dependency gate.', source: 'claude', at: 5 },
    }],
    evidence: [{
      id: 'evidence-1', runId: 'run-1', workItemId: 'work-1', threadId: 'thread-new', kind: 'command',
      ref: { eventId: null, url: null, label: 'npm test' }, summary: 'The check was recorded.',
      state: { commit: null, tree: 'tree-1', dirty: false }, check: { name: 'test', passed: false, exitCode: 1 }, source: 'claude', at: 6,
    }],
  }],
  canonicalThreadId: 'thread-new',
  timeline: [
    { id: 'thread:thread-new', kind: 'thread', at: 4, threadId: 'thread-new', threadTitle: 'Newest historical thread', runId: null, run: null, outcome: null, evidence: null },
    { id: 'run:run-1', kind: 'run', at: 3, threadId: 'thread-new', threadTitle: 'Newest historical thread', runId: 'run-1', run: { runId: 'run-1', threadId: 'thread-new', agent: 'claude', startedAt: 3, state: 'interrupted', live: false, interruptedByRestart: true, evidenceCount: 1 }, outcome: null, evidence: null },
    { id: 'outcome:run-1', kind: 'outcome', at: 5, threadId: 'thread-new', threadTitle: 'Newest historical thread', runId: 'run-1', run: null, outcome: { runId: 'run-1', claim: 'blocked', statement: 'The run stopped at the dependency gate.', source: 'claude', at: 5 }, evidence: null },
    { id: 'evidence:evidence-1', kind: 'evidence', at: 6, threadId: 'thread-new', threadTitle: 'Newest historical thread', runId: 'run-1', run: null, outcome: null, evidence: { id: 'evidence-1', runId: 'run-1', workItemId: 'work-1', threadId: 'thread-new', kind: 'command', ref: { eventId: null, url: null, label: 'npm test' }, summary: 'The check was recorded.', state: { commit: null, tree: 'tree-1', dirty: false }, check: { name: 'test', passed: false, exitCode: 1 }, source: 'claude', at: 6 } },
  ],
  historyTruncated: false,
};

describe('ProjectIssueDetail', () => {
  test('renders bounded source fallback, structured refusal, historical thread, restart, outcome, and evidence patterns', () => {
    const headingRef = createRef<HTMLHeadingElement>();
    render(
      <ProjectIssueDetailPanel
        detail={detail}
        selectedItem={item}
        error={detail.source.error}
        loading={false}
        actionBusy={false}
        headingRef={headingRef}
        onClose={vi.fn()}
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: /#145/ })).toBeTruthy();
    expect(screen.getByText(/Local WorkItem snapshot/)).toBeTruthy();
    expect(screen.getByText('Not available')).toBeTruthy();
    expect(screen.getByText(/assignees not retained/i)).toBeTruthy();
    expect(screen.getAllByRole('alert').some((alert) => alert.textContent?.includes('Structured refusal'))).toBe(true);
    expect(screen.getByText('workers-unavailable')).toBeTruthy();
    expect(screen.getByText('Body is capped for this view', { exact: false })).toBeTruthy();
    expect(screen.getAllByText('Newest historical thread').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Interrupted by restart')).toBeTruthy();
    expect(screen.getByText('The run stopped at the dependency gate.')).toBeTruthy();
    expect(screen.getByText('The check was recorded.')).toBeTruthy();
    expect(document.querySelector('.project-issue-detail-body')).toBeTruthy();
  });

  test('keeps Continue/Take actions owned by the overview item instead of recomputing them in the panel', () => {
    const onAction = vi.fn();
    render(
      <ProjectIssueDetailPanel
        detail={{ ...detail, action: { ...detail.action, action: 'continue', reasonCode: 'active', refusal: null } }}
        selectedItem={{ ...item, action: 'continue', reasonCode: 'active' }}
        error={null}
        loading={false}
        actionBusy={false}
        headingRef={createRef<HTMLHeadingElement>()}
        onClose={vi.fn()}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
