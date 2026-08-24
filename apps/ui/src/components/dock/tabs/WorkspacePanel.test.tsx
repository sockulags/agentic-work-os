import { describe, expect, test, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { EffectiveWorkspace, WorkspaceResolution } from '@awos/protocol';
import { renderWithHarness } from '@/test-harness';
import { WorkspacePanel } from './WorkspacePanel';

const CWD = '/repo';

function effective(overrides: Partial<EffectiveWorkspace> = {}): EffectiveWorkspace {
  return {
    root: CWD,
    name: 'agentic-work-os',
    repository: { root: '.', github: 'sockulags/agentic-work-os' },
    agents: ['claude', 'codex'],
    setup: { command: 'npm install', timeoutMs: null },
    verify: [{ name: 'test', command: 'npm test' }],
    integration: { requires: [], allowOverride: false },
    context: { references: ['ARCHITECTURE.md'], notes: '' },
    roles: [],
    steps: [],
    routes: [],
    guardrails: [],
    origins: {
      name: 'shared',
      repository: 'shared',
      agents: 'shared',
      setup: 'local',
      verify: 'shared',
      integration: 'default',
      context: 'default',
      roles: 'default',
      steps: 'default',
      routes: 'default',
      guardrails: 'default',
    },
    sources: ['.awos/workspace.json', '.awos/local/workspace.json'],
    ...overrides,
  };
}

function render(resolution: WorkspaceResolution, harness = {}) {
  return renderWithHarness(<WorkspacePanel />, {
    activeThreadId: 't1',
    workspace: { cwd: CWD, resolution },
    ...harness,
  });
}

describe('WorkspacePanel', () => {
  test('shows the effective settings, not the file', () => {
    render({ status: 'ok', problems: [], workspace: effective() });

    expect(screen.getByText('agentic-work-os')).toBeTruthy();
    expect(screen.getByText('claude, codex')).toBeTruthy();
    expect(screen.getByText('npm install')).toBeTruthy();
    expect(screen.getByText(/npm test/)).toBeTruthy();
    expect(screen.getByText(/Read from/)).toBeTruthy();
  });

  test('omits the role selector when the shared workspace declares no roles', () => {
    render({ status: 'ok', problems: [], workspace: effective() });

    expect(screen.queryByLabelText('Project role')).toBeNull();
  });

  test('shows a semantic role selector for the shared roles and persists changes', () => {
    const setWorkspaceRole = vi.fn();
    render(
      {
        status: 'ok',
        problems: [],
        workspace: effective({
          roles: [
            { id: 'maintainer', label: 'Maintainer' },
            { id: 'reviewer', label: 'Reviewer' },
          ],
        }),
      },
      {
        roleSelection: { status: 'needs-selection', roleId: null, role: null },
        setWorkspaceRole,
      },
    );

    const select = screen.getByLabelText('Project role');
    expect(select).toHaveValue('');
    expect(screen.getByText(/No role selected yet/)).toBeTruthy();
    fireEvent.change(select, { target: { value: 'reviewer' } });
    expect(setWorkspaceRole).toHaveBeenCalledWith('reviewer');
  });

  test('shows a role load error without inventing an interactive selection', () => {
    render(
      {
        status: 'ok',
        problems: [],
        workspace: effective({ roles: [{ id: 'maintainer', label: 'Maintainer' }] }),
      },
      {
        roleSelection: null,
        roleSelectionError: 'Could not load the local role preference. Re-read the workspace to try again.',
      },
    );

    expect(screen.queryByLabelText('Project role')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the local role preference.');
    expect(screen.getByTitle('Read the declaration again')).toBeTruthy();
  });

  test('explains stale selections and exposes saving errors', () => {
    render(
      {
        status: 'ok',
        problems: [],
        workspace: effective({ roles: [{ id: 'reviewer', label: 'Reviewer' }] }),
      },
      {
        roleSelection: { status: 'stale', roleId: 'maintainer', role: null },
        roleSelectionSave: 'failed',
        roleSelectionError: 'Could not save the role preference.',
      },
    );

    expect(screen.getByLabelText('Project role')).toHaveValue('');
    expect(screen.getByText(/saved role.*stale/i)).toBeTruthy();
    expect(screen.getByText(/no longer declared/i)).toBeTruthy();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save the role preference.');
  });

  test('says where each value came from', () => {
    render({ status: 'ok', problems: [], workspace: effective() });

    // The override is the one anybody hunting a surprising value needs to find.
    expect(screen.getAllByText('shared').length).toBeGreaterThan(0);
    expect(screen.getByText('local')).toBeTruthy();
    expect(screen.getAllByText('default').length).toBeGreaterThan(0);
  });

  test('shows guardrail ids, attachments, references, and shared origin without an editor', () => {
    render({
      status: 'ok',
      problems: [],
      workspace: effective({
        guardrails: [{
          id: 'visual-rubric',
          kind: 'model-rubric',
          attach: { from: 'implement', to: 'review' },
          enforcement: 'required',
          allowOverride: false,
          parameters: { expectationItem: 'prototype.dashboard', evaluatorProfile: 'independent-model-rubric' },
          correction: { maxRuns: 2, onExhausted: 'waiting-for-human' },
        }],
        origins: { ...effective().origins, guardrails: 'shared' },
      }),
    });

    expect(screen.getByText('visual-rubric')).toBeTruthy();
    expect(screen.getByText(/implement → review/)).toBeTruthy();
    expect(screen.getByText(/prototype\.dashboard/)).toBeTruthy();
    expect(screen.getByText(/evaluator capability: independent-model-rubric/)).toBeTruthy();
    expect(screen.getAllByText('shared').length).toBeGreaterThan(0);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  test('shows unresolved values without hiding the settings that did resolve', () => {
    render({
      status: 'ok',
      workspace: effective(),
      problems: [
        {
          severity: 'warning',
          file: '.awos/workspace.json',
          path: 'context.references[0]',
          message: 'No file at "ARCHITECTURE.md" inside the workspace.',
        },
      ],
    });

    expect(screen.getByText(/No file at/)).toBeTruthy();
    expect(screen.getByText('agentic-work-os')).toBeTruthy();
  });

  test('a declaration that does not load shows what is wrong with it', () => {
    render({
      status: 'invalid',
      root: CWD,
      problems: [
        {
          severity: 'error',
          file: '.awos/workspace.json',
          path: 'version',
          message: 'Schema version 99 is not supported.',
        },
      ],
    });

    expect(screen.getByText(/does not load/)).toBeTruthy();
    expect(screen.getByText(/Schema version 99/)).toBeTruthy();
    // The location is half the fix: which file, and where in it.
    expect(screen.getByText(/\.awos\/workspace\.json · version/)).toBeTruthy();
  });

  test('keeps invalid schema-v3 guardrails visible instead of silently resolving', () => {
    render({
      status: 'invalid',
      root: CWD,
      problems: [{
        severity: 'error',
        file: '.awos/workspace.json',
        path: 'guardrails[0].parameters.expectationItem',
        message: 'No pinned expectation registry is available to validate "scope". Supply the concrete expectation item registry before resolving this guardrail.',
      }],
    });

    expect(screen.getByText(/does not load/)).toBeTruthy();
    expect(screen.getByText(/guardrails\[0\]\.parameters\.expectationItem/)).toBeTruthy();
    expect(screen.getByText(/No pinned expectation registry/)).toBeTruthy();
  });

  test('an undeclared directory is told what a declaration looks like', () => {
    render({ status: 'none', searchedFrom: CWD });

    expect(screen.getByText(/not a workspace/)).toBeTruthy();
    expect(screen.getByText(/"my-project"/)).toBeTruthy();
  });

  test('re-reads the declaration on request, because nothing watches the file', () => {
    const refreshWorkspace = vi.fn();
    render({ status: 'ok', problems: [], workspace: effective() }, { refreshWorkspace });

    fireEvent.click(screen.getByTitle('Read the declaration again'));

    expect(refreshWorkspace).toHaveBeenCalledWith(CWD);
  });

  test('waits rather than guessing before the declaration has arrived', () => {
    renderWithHarness(<WorkspacePanel />, { activeThreadId: 't1', workspace: null });

    expect(screen.getByText(/Reading the declaration/)).toBeTruthy();
  });
});
