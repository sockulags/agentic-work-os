import type { DockTab } from './registry';
import { useHarnessContext } from '@/state/HarnessContext';
import { cn } from '@/lib/utils';

export function dockTabId(id: string): string {
  return `dock-tab-${id}`;
}

export function dockPanelId(id: string): string {
  return `dock-panel-${id}`;
}

/**
 * The dock's tab strip.
 *
 * Reads the harness itself to resolve badge counts, so a tab's registry entry never has
 * to be threaded through the dock's props.
 */
export function DockTabs({
  tabs,
  activeId,
  onSelect,
}: {
  tabs: readonly DockTab[];
  activeId: string;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const harness = useHarnessContext();

  // Roving tabindex: only the selected tab is in the tab order, so arrows have to be the
  // way to reach the others.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0 || tabs.length === 0) return;
    event.preventDefault();

    const current = tabs.findIndex((tab) => tab.id === activeId);
    const nextIndex = (current + step + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    if (next === undefined) return;

    onSelect(next.id);
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons[nextIndex]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Dock panels"
      onKeyDown={handleKeyDown}
      className="awos-scroll flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto"
    >
      {tabs.map((tab) => {
        const selected = tab.id === activeId;
        const count = tab.badge?.(harness);
        const Icon = tab.icon;

        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={dockTabId(tab.id)}
            aria-selected={selected}
            aria-controls={dockPanelId(tab.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            className={cn(
              'awos-focus-ring flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors duration-[var(--motion-fast)]',
              selected
                ? 'bg-surface-selected text-foreground'
                : 'text-muted-foreground hover:bg-surface-interactive hover:text-foreground',
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span>{tab.label}</span>
            {count !== undefined && (
              <span
                className={cn(
                  'rounded-full px-1.5 py-px font-mono text-[10px] tabular-nums',
                  count > 0 ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground',
                )}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
