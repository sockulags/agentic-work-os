import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { getAgentStyle } from './AgentBadge';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { useHarnessContext } from '@/state/HarnessContext';
import { cn } from '@/lib/utils';

/**
 * Message input with the agent switcher attached.
 *
 * The switcher lives here rather than in a settings panel deliberately: choosing who
 * answers is part of composing the message, and it's the one control this whole app
 * exists for.
 */
export function Composer(): React.JSX.Element {
  const h = useHarnessContext();
  const activeAgent = h.activeThread?.activeAgent ?? 'claude';
  const busy = h.runtime?.busy ?? [];
  const parallel = h.activeThread?.parallel ?? false;
  const workspaceAgents = h.workspace?.resolution.status === 'ok'
    ? new Set(h.workspace.resolution.workspace.agents)
    : null;
  const profiles = workspaceAgents === null
    ? h.availability
    : h.availability.filter((profile) => workspaceAgents.has(profile.profileId));
  const selectedProfile = profiles.find((profile) => profile.profileId === activeAgent) ?? profiles[0];
  const agent = selectedProfile?.profileId ?? activeAgent;
  const disabled = h.status !== 'open' || (workspaceAgents !== null && selectedProfile === undefined);

  // With lanes, only the agent you are writing to has to be free. Sharing one directory,
  // any working agent blocks the composer, because the second turn would race the first.
  const blockedBy = parallel
    ? busy.includes(agent)
      ? agent
      : null
    : (busy[0] ?? null);

  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with content up to a ceiling, then scroll.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const submit = (): void => {
    const trimmed = text.trim();
    if (trimmed === '' || blockedBy !== null || disabled) return;
    void h.send(trimmed, agent);
    setText('');
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends, Shift+Enter newlines — the convention every chat client uses.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-t border-border bg-surface-sunken px-[var(--density-shell-gutter)] py-[var(--density-composer-padding)]">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        <div className="awos-scroll flex min-w-0 items-center gap-1.5 overflow-x-auto pb-px">
          {profiles.map((probe) => {
            const id = probe.profileId;
            const style = getAgentStyle(id, probe.label);
            const missing = probe !== undefined && !probe.available;
            const selected = agent === id;

            return (
              <button
                key={id}
                type="button"
                onClick={() => void h.setAgent(id)}
                title={probe?.detail ?? ''}
                style={style.cssVars}
                className={cn(
                  style.root,
                  'awos-focus-ring flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1 text-xs font-medium transition-colors duration-[var(--motion-fast)]',
                  selected
                    ? cn(style.bg, style.border, style.text)
                    : 'border-transparent text-muted-foreground hover:bg-surface-interactive',
                  missing && 'opacity-50',
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', style.dot)} />
                {probe.label}
                {busy.includes(id) && <span className="text-[10px] opacity-70">working</span>}
                {missing && <span className="text-[10px]">not found</span>}
              </button>
            );
          })}

          {busy.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              // In parallel mode Stop means "stop the one I am looking at"; sharing a
              // directory there is only ever one turn to stop anyway.
              onClick={() => void h.interrupt(parallel ? agent : undefined)}
              className="ml-auto shrink-0 gap-1.5 text-xs text-muted-foreground"
            >
              <Square className="h-3 w-3 fill-current" />
              Stop
            </Button>
          )}
        </div>

        <div className="relative">
          <Textarea
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={disabled}
            placeholder={
              blockedBy !== null
                ? `${getAgentStyle(blockedBy).label} is working — stop it to send`
                : `Message ${getAgentStyle(agent, selectedProfile?.label).label}…`
            }
            className="max-h-60 py-[var(--density-composer-padding)] pr-12"
          />
          <Button
            size="icon"
            aria-label="Send"
            onClick={submit}
            disabled={text.trim() === '' || blockedBy !== null || disabled}
            className="absolute bottom-2 right-2"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
