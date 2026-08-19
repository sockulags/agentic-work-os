import { describe, expect, test, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { ApprovalRequestedBody } from '@awos/protocol';
import { ApprovalDialog } from './ApprovalDialog';
import { idleRuntime, renderWithHarness } from '@/test-harness';

const approval = (overrides: Partial<ApprovalRequestedBody> = {}): ApprovalRequestedBody => ({
  kind: 'approval.requested',
  approvalId: 'appr-1',
  toolName: 'Bash',
  toolKind: 'command',
  title: 'Run a shell command',
  detail: 'rm -rf ./build',
  input: { command: 'rm -rf ./build' },
  options: [
    { id: 'allow', label: 'Allow', behavior: 'allow', persistent: false },
    { id: 'allow-always', label: 'Always allow', behavior: 'allow', persistent: true },
    { id: 'deny', label: 'Deny', behavior: 'deny', persistent: false },
  ],
  ...overrides,
});

describe('ApprovalDialog', () => {
  test('renders nothing without a pending approval', () => {
    const { container } = renderWithHarness(<ApprovalDialog />, { runtime: idleRuntime() });

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('shows what is being approved, in full', () => {
    renderWithHarness(<ApprovalDialog />, {
      runtime: idleRuntime({ pendingApprovals: [approval()] }),
    });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Run a shell command')).toBeInTheDocument();
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByText('rm -rf ./build')).toBeInTheDocument();
  });

  test('renders one button per option, in the order given', () => {
    renderWithHarness(<ApprovalDialog />, {
      runtime: idleRuntime({ pendingApprovals: [approval()] }),
    });

    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['Allow', 'Always allow', 'Deny']);
  });

  test('deny options are visually secondary to allow options', () => {
    renderWithHarness(<ApprovalDialog />, {
      runtime: idleRuntime({ pendingApprovals: [approval()] }),
    });

    expect(screen.getByRole('button', { name: 'Allow' })).toHaveClass('bg-primary');
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveClass('border-input');
  });

  test('choosing an option reports the approval and option ids', () => {
    const onResolve = vi.fn();
    renderWithHarness(<ApprovalDialog />, {
      runtime: idleRuntime({ pendingApprovals: [approval()] }),
      resolveApproval: onResolve,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }));

    expect(onResolve).toHaveBeenCalledWith('appr-1', 'allow-always');
  });

  // This pins the user-visible guarantee, not the mechanism: `open` is hard-coded with no
  // `onOpenChange`, so escape stays inert even if the explicit `onEscapeKeyDown` guard is
  // removed. Anything that makes the dialog dismissible has to break both to get past here.
  test('escape does not dismiss the dialog: an unanswered approval blocks the turn', () => {
    const onResolve = vi.fn();
    renderWithHarness(<ApprovalDialog />, {
      runtime: idleRuntime({ pendingApprovals: [approval()] }),
      resolveApproval: onResolve,
    });

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape' });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onResolve).not.toHaveBeenCalled();
  });
});
