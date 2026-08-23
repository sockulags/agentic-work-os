import type { AgentId } from '@awos/protocol';
import { cn } from '@/lib/utils';

/**
 * A single source of truth for how each agent is styled.
 *
 * Two speakers share one transcript, so colour is doing real work here: it's the fastest
 * way to see who did what when scrolling back through a long thread.
 */
export interface AgentStyle { label: string; text: string; bg: string; border: string; dot: string }

export const AGENT_STYLE: Readonly<Record<string, AgentStyle>> = {
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
  'qwen-local': {
    label: 'Qwen Code · Qwen3.8 local',
    text: 'text-amber-500',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/30',
    dot: 'bg-amber-500',
  },
};

const FALLBACK_STYLES: readonly Omit<AgentStyle, 'label'>[] = [
  { text: 'text-sky-500', bg: 'bg-sky-500/10', border: 'border-sky-500/30', dot: 'bg-sky-500' },
  { text: 'text-emerald-500', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', dot: 'bg-emerald-500' },
  { text: 'text-violet-500', bg: 'bg-violet-500/10', border: 'border-violet-500/30', dot: 'bg-violet-500' },
  { text: 'text-rose-500', bg: 'bg-rose-500/10', border: 'border-rose-500/30', dot: 'bg-rose-500' },
] as const;

/** Server labels win; unknown profile ids receive a stable, safe built-in palette. */
export function getAgentStyle(agent: string, label?: string): AgentStyle {
  const builtIn = AGENT_STYLE[agent];
  if (builtIn) return { ...builtIn, label: label ?? builtIn.label };
  let hash = 0;
  for (const char of agent) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
  const fallback = FALLBACK_STYLES[hash % FALLBACK_STYLES.length] ?? FALLBACK_STYLES[0]!;
  return { ...fallback, label: label ?? agent };
}

export function AgentBadge({
  agent,
  label,
  className,
}: {
  agent: AgentId;
  label?: string;
  className?: string;
}): React.JSX.Element {
  const style = getAgentStyle(agent, label);
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
