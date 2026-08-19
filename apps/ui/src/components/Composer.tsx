import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { AGENT_STYLE } from './AgentBadge';
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
  const agent = h.activeThread?.activeAgent ?? 'claude';
  const busyWith = h.runtime?.busyWith ?? null;
  const availability = h.availability;
  const disabled = h.status !== 'open';

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
    if (trimmed === '' || busyWith !== null || disabled) return;
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
    <div className="border-t border-border bg-background px-6 py-3">
      <div className="mx-auto max-w-3xl space-y-2">
        <div className="flex items-center gap-1.5">
          {(['claude', 'codex'] as const).map((id) => {
            const style = AGENT_STYLE[id];
            const probe = availability.find((a) => a.agent === id);
            const missing = probe !== undefined && !probe.available;
            const selected = agent === id;

            return (
              <button
                key={id}
                type="button"
                onClick={() => void h.setAgent(id)}
                title={probe?.detail ?? ''}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                  selected
                    ? cn(style.bg, style.border, style.text)
                    : 'border-transparent text-muted-foreground hover:bg-accent',
                  missing && 'opacity-50',
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', style.dot)} />
                {style.label}
                {busyWith === id && <span className="text-[10px] opacity-70">working</span>}
                {missing && <span className="text-[10px]">not found</span>}
              </button>
            );
          })}

          {busyWith !== null && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void h.interrupt()}
              className="ml-auto h-7 gap-1.5 text-xs text-muted-foreground"
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
              busyWith !== null
                ? `${AGENT_STYLE[busyWith].label} is working — stop it to send`
                : `Message ${AGENT_STYLE[agent].label}…`
            }
            className="max-h-60 min-h-[44px] py-3 pr-12"
          />
          <Button
            size="icon"
            onClick={submit}
            disabled={text.trim() === '' || busyWith !== null || disabled}
            className="absolute bottom-2 right-2 h-7 w-7"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
