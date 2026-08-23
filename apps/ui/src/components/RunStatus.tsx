import { Ban, Check, CircleAlert, Loader2, OctagonX } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Operational states shared by tool execution and the terminal state of a run. */
export type RunTerminalState = 'running' | 'completed' | 'failed' | 'denied' | 'interrupted';

const STATE_META: Record<
  RunTerminalState,
  { label: string; className: string; Icon: typeof Check }
> = {
  running: { label: 'Running', className: 'text-state-busy', Icon: Loader2 },
  completed: { label: 'Completed', className: 'text-state-passed', Icon: Check },
  failed: { label: 'Failed', className: 'text-state-failed', Icon: CircleAlert },
  denied: { label: 'Denied', className: 'text-state-blocked', Icon: Ban },
  interrupted: { label: 'Interrupted', className: 'text-state-interrupted', Icon: OctagonX },
};

export function RunStatus({
  state,
  detail,
  className,
}: {
  state: RunTerminalState;
  detail?: string | null;
  className?: string;
}): React.JSX.Element {
  const meta = STATE_META[state];
  const Icon = meta.Icon;

  return (
    <span
      role="status"
      aria-label={detail ? `${meta.label}, ${detail}` : meta.label}
      className={cn('flex shrink-0 items-center gap-1 text-xs', meta.className, className)}
    >
      <Icon className={cn('h-3.5 w-3.5', state === 'running' && 'animate-spin')} aria-hidden="true" />
      <span>{detail ? `${meta.label} · ${detail}` : meta.label}</span>
    </span>
  );
}

