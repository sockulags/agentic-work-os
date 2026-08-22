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
    origins: {
      name: 'shared',
      repository: 'shared',
      agents: 'shared',
      setup: 'local',
      verify: 'shared',
      integration: 'default',
      context: 'default',
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

  test('says where each value came from', () => {
    render({ status: 'ok', problems: [], workspace: effective() });

    // The override is the one anybody hunting a surprising value needs to find.
    expect(screen.getAllByText('shared').length).toBeGreaterThan(0);
    expect(screen.getByText('local')).toBeTruthy();
    expect(screen.getByText('default')).toBeTruthy();
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
