import { ShieldAlert } from 'lucide-react';
import type { ApprovalRequestedBody } from '@awos/protocol';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';

/**
 * Blocking approval prompt.
 *
 * Not dismissible by escape or an outside click: an unanswered approval leaves the agent
 * blocked mid-turn, so the only ways out are the explicit buttons. The full command or
 * patch is always shown — an approval dialog that hides what it's approving is worse
 * than no dialog at all.
 */
export function ApprovalDialog({
  approval,
  onResolve,
}: {
  approval: ApprovalRequestedBody | null;
  onResolve: (approvalId: string, optionId: string) => void;
}): React.JSX.Element | null {
  if (!approval) return null;

  return (
    <Dialog open>
      <DialogContent
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 rounded-md bg-amber-500/15 p-2 text-amber-400">
            <ShieldAlert className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-base font-semibold">{approval.title}</DialogTitle>
            <DialogDescription className="mt-0.5 font-mono text-xs text-muted-foreground">
              {approval.toolName}
            </DialogDescription>
          </div>
        </div>

        <pre className="awos-scroll max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
          {approval.detail}
        </pre>

        <div className="flex justify-end gap-2">
          {approval.options.map((option) => (
            <Button
              key={option.id}
              variant={option.behavior === 'allow' ? 'default' : 'outline'}
              onClick={() => onResolve(approval.approvalId, option.id)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
