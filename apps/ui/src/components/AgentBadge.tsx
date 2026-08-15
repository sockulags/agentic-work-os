import type { AgentId } from '@awos/protocol';
import { cn } from '@/lib/utils';

/**
 * A single source of truth for how each agent is styled.
 *
 * Two speakers share one transcript, so colour is doing real work here: it's the fastest
 * way to see who did what when scrolling back through a long thread.
 */
export const AGENT_STYLE: Record<
  AgentId,
  { label: string; text: string; bg: string; border: string; dot: string }
> = {
  claude: {
    label: 'Claude',
    text: 'text-claude',
    bg: 'bg-claude/10',
    border: 'border-claude/30',
    dot: 'bg-claude',
  },
  codex: {
    label: 'Codex',
    text: 'text-codex',
    bg: 'bg-codex/10',
    border: 'border-codex/30',
    dot: 'bg-codex',
  },
};

export function AgentBadge({
  agent,
  className,
}: {
  agent: AgentId;
  className?: string;
}): React.JSX.Element {
  const style = AGENT_STYLE[agent];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium',
        style.bg,
        style.border,
        style.text,
        className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', style.dot)} />
      {style.label}
    </span>
  );
}
