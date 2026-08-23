import { useRef } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { useHarnessContext } from '@/state/HarnessContext';

/**
 * Blocking approval prompt.
 *
 * Not dismissible by escape or an outside click: an unanswered approval leaves the agent
 * blocked mid-turn, so the only ways out are the explicit buttons. The full command or
 * patch is always shown — an approval dialog that hides what it's approving is worse
 * than no dialog at all.
 */
export function ApprovalDialog(): React.JSX.Element | null {
  const { runtime, resolveApproval } = useHarnessContext();
  const approval = runtime?.pendingApprovals[0] ?? null;
  const firstDecisionRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  if (!approval) return null;

  const resolve = (optionId: string): void => {
    void Promise.resolve(resolveApproval(approval.approvalId, optionId)).then(() => {
      window.setTimeout(() => {
        if (document.querySelector('[data-awos-approval-dialog]')) return;
        returnFocusRef.current?.focus();
      }, 0);
    });
  };

  return (
    <Dialog open>
      <DialogContent
        data-awos-approval-dialog
        onOpenAutoFocus={(event) => {
          const active = document.activeElement;
          if (active instanceof HTMLElement && active !== document.body) returnFocusRef.current = active;
          event.preventDefault();
          firstDecisionRef.current?.focus();
        }}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 rounded-md border border-state-waiting-border bg-state-waiting-surface p-2 text-state-waiting" aria-hidden="true">
            <ShieldAlert className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-state-waiting">Approval required</p>
            <DialogTitle className="text-base font-semibold">Approval required</DialogTitle>
            <DialogDescription className="mt-0.5 font-mono text-xs text-muted-foreground">
              {approval.toolName}
            </DialogDescription>
          </div>
        </div>

        <div className="grid min-w-0 gap-3 text-xs">
          <section aria-labelledby="approval-action-label">
            <h3 id="approval-action-label" className="mb-1 font-medium text-foreground">Requested action</h3>
            <p className="break-words text-muted-foreground">{approval.title}</p>
          </section>
          <section aria-labelledby="approval-command-label">
            <h3 id="approval-command-label" className="mb-1 font-medium text-foreground">Command or patch</h3>
            <pre className="awos-scroll max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
              {approval.detail}
            </pre>
          </section>
          <section className="rounded-md border border-state-waiting-border bg-state-waiting-surface px-3 py-2 text-state-waiting" aria-labelledby="approval-risk-label">
            <h3 id="approval-risk-label" className="font-medium">Risk and status</h3>
            <p className="mt-0.5">The worker is paused until you choose a decision.</p>
          </section>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3" aria-label="Approval decisions">
          <span className="text-xs text-muted-foreground">Decisions</span>
          <div className="flex flex-wrap justify-end gap-2">
          {approval.options.map((option, index) => (
            <Button
              key={option.id}
              ref={index === 0 ? firstDecisionRef : undefined}
              variant={option.behavior === 'allow' ? 'default' : 'outline'}
              onClick={() => resolve(option.id)}
            >
              {option.label}
            </Button>
          ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
