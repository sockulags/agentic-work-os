import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { EvidenceItem as EvidenceRecord, RequirementResult, WorkItem } from '@awos/protocol';
import { EvidenceItem, GateResult, VerifyAction, WorkItemHeader } from './ReviewPatterns';

afterEach(() => {
  document.body.innerHTML = '';
});

const candidate = {
  commit: 'commit-0123456789abcdef',
  tree: 'tree-0123456789abcdef',
  dirty: false,
};

function requirement(state: RequirementResult['state']): RequirementResult {
  return {
    name: 'typecheck',
    command: 'npm run typecheck -- --pretty false',
    state,
    evidenceId: state === 'missing' ? null : 'evidence-1',
    evidenceTree: state === 'stale' ? 'old-tree-0123456789abcdef' : state === 'missing' ? null : candidate.tree,
  };
}

function evidence(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: 'evidence-1',
    runId: 'run-1',
    workItemId: 'work-1',
    threadId: 'thread-1',
    kind: 'command',
    ref: { eventId: 'event-1', url: null, label: 'npm run typecheck -- --pretty false' },
    summary: 'A very long verification output that must remain readable instead of disappearing behind a tooltip.',
    state: { ...candidate },
    check: { name: 'typecheck', passed: true, exitCode: 0 },
    source: 'user',
    at: 2,
    ...overrides,
  };
}

describe('review patterns', () => {
  test.each([
    ['satisfied', 'passed against this content'],
    ['missing', 'has not been run'],
    ['failed', 'failed'],
    ['stale', 'passed against different content'],
  ] as const)('renders the %s gate state with its candidate', (state, label) => {
    render(<GateResult requirement={requirement(state)} candidateTree={candidate.tree} onRun={vi.fn()} />);

    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText('typecheck').parentElement?.textContent).toContain(candidate.tree);
  });

  test('makes stale evidence distinct and keeps long identifiers and output visible', () => {
    const item = evidence({
      ref: { eventId: 'event-with-a-long-identifier-0123456789', url: null, label: 'long-output-reference-0123456789' },
      state: { ...candidate, tree: 'old-tree-0123456789abcdef' },
    });
    render(<EvidenceItem item={item} candidateTree={candidate.tree} />);

    expect(screen.getByText('Stale evidence')).toBeTruthy();
    expect(screen.getByText(item.summary)).toBeTruthy();
    expect(screen.getByText(item.ref.label)).toBeTruthy();
    expect(screen.getByText(/old-tree-0123456789abcdef/)).toBeTruthy();
  });

  test('explains why a verification action is disabled', () => {
    render(
      <VerifyAction
        label="Run"
        command="npm test"
        onClick={vi.fn()}
        disabled
        disabledReason="A verification check is already running."
      />,
    );

    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
    expect(screen.getByTitle('A verification check is already running.')).toBeTruthy();
  });

  test('keeps work-item controls in keyboard reading order', () => {
    const item: WorkItem = {
      id: 'work-1',
      workspaceRoot: '/repo',
      source: { repo: 'sockulags/agentic-work-os', number: 26, url: 'https://github.com/sockulags/agentic-work-os/issues/26' },
      snapshot: {
        title: 'Unify work, evidence, and change-review patterns',
        body: 'body',
        state: 'OPEN',
        labels: [],
        author: 'sockulags',
        revision: 'revision-0123456789abcdef',
      },
      attachedAt: 1,
      fetchedAt: 1,
      lastRefreshedAt: 1,
    };
    render(<WorkItemHeader item={item} busy={false} onRefresh={vi.fn()} onDetach={vi.fn()} />);

    const controls = screen.getAllByRole('button');
    expect(controls.map((control) => control.getAttribute('aria-label'))).toEqual([
      'Ask GitHub again',
      'Unlink this issue from the thread',
    ]);
    controls[0]?.focus();
    expect(document.activeElement).toBe(controls[0]);
    fireEvent.keyDown(controls[0]!, { key: 'Tab' });
    controls[1]?.focus();
    expect(document.activeElement).toBe(controls[1]);
  });
});
