import { cn } from '@/lib/utils';

type WorkerStyleVars = React.CSSProperties & { '--worker-hue': string };

/**
 * Shared class roles for a profile-provided worker identity.
 *
 * The profile id is the only styling input. A stable hash picks a hue and the CSS token
 * layer derives its light/dark foreground, surface, border, and dot treatments. There is
 * intentionally no profile-name branch here: a new registered worker gets the same
 * mechanism as every existing worker.
 */
export interface AgentStyle {
  label: string;
  root: 'awos-worker';
  text: 'awos-worker-text';
  bg: 'awos-worker-surface';
  border: 'awos-worker-border';
  dot: 'awos-worker-dot';
  cssVars: WorkerStyleVars;
}

const WORKER_HUES = [34, 164, 205, 270, 320, 12, 92, 236] as const;

/** Server labels win; every profile id receives a stable, token-derived identity. */
export function getAgentStyle(agent: string, label?: string): AgentStyle {
  let hash = 0;
  for (const char of agent) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  // A profile that has not arrived in the server metadata is still readable, but does not
  // pretend that its generated hue is an established identity. Known profiles keep their
  // stable generic palette treatment; unknown profiles use the neutral worker hue.
  const hue = label === undefined ? 220 : WORKER_HUES[hash % WORKER_HUES.length] ?? WORKER_HUES[0];

  return {
    label: label ?? humanizeProfileId(agent),
    root: 'awos-worker',
    text: 'awos-worker-text',
    bg: 'awos-worker-surface',
    border: 'awos-worker-border',
    dot: 'awos-worker-dot',
    cssVars: { '--worker-hue': String(hue) },
  };
}

function humanizeProfileId(profileId: string): string {
  return profileId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

export function WorkerBadge({
  agent,
  label,
  className,
}: {
  agent: string;
  label?: string;
  className?: string;
}): React.JSX.Element {
  const style = getAgentStyle(agent, label);
  return (
    <span
      style={style.cssVars}
      className={cn(
        style.root,
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

/** Compatibility name for callers that still use the pre-worker-profile terminology. */
export const AgentBadge = WorkerBadge;
