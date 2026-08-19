import { useRef } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { DockTabs, dockPanelId, dockTabId } from './DockTabs';
import { DOCK_TABS, resolveActiveTab, type DockTab } from './registry';
import {
  DOCK_MAX_VIEWPORT_FRACTION,
  DOCK_MIN_WIDTH,
  clampDockWidth,
  useDockState,
} from '@/hooks/useDockState';
import { cn } from '@/lib/utils';

/** One arrow key press, big enough to be useful and small enough to aim with. */
const KEYBOARD_STEP = 24;

/**
 * The right-hand dock: everything worth looking at that isn't the conversation.
 *
 * Tabs come from the registry rather than being spelled out here, so a new panel is one
 * entry in `registry.ts` and a component that reads the harness context — the dock itself
 * never learns what any tab contains.
 *
 * Width is applied as an inline pixel value bounded by CSS `min-width`/`max-width`, and
 * the drag handler clamps to the same bounds. Letting CSS own the ceiling means a window
 * resize narrows the dock on its own, with no resize listener and no state write.
 */
export function Dock(): React.JSX.Element {
  const dock = useDockState();
  const activeTab = resolveActiveTab(DOCK_TABS, dock.activeTabId);

  if (!dock.open) {
    return (
      <CollapsedRail
        tabs={DOCK_TABS}
        onExpand={() => dock.setOpen(true)}
        onOpenTab={(id) => {
          dock.setActiveTabId(id);
          dock.setOpen(true);
        }}
      />
    );
  }

  const ActivePanel = activeTab.Component;

  return (
    <aside
      style={{
        width: dock.width,
        minWidth: DOCK_MIN_WIDTH,
        maxWidth: `${DOCK_MAX_VIEWPORT_FRACTION * 100}vw`,
      }}
      className="relative flex shrink-0 flex-col border-l border-border bg-card/30"
    >
      <ResizeHandle width={dock.width} onWidth={dock.setWidth} />

      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <DockTabs tabs={DOCK_TABS} activeId={activeTab.id} onSelect={dock.setActiveTabId} />
        <button
          type="button"
          onClick={() => dock.setOpen(false)}
          title="Collapse dock"
          aria-label="Collapse dock"
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>

      <div
        role="tabpanel"
        id={dockPanelId(activeTab.id)}
        aria-labelledby={dockTabId(activeTab.id)}
        className="awos-scroll min-h-0 flex-1 overflow-y-auto"
      >
        <ActivePanel />
      </div>
    </aside>
  );
}

/**
 * Collapsed, the dock keeps its tabs as icons instead of disappearing into a single
 * button: the badge counts stay readable, and reopening lands on the panel that was
 * clicked rather than on whatever was last selected.
 */
function CollapsedRail({
  tabs,
  onExpand,
  onOpenTab,
}: {
  tabs: readonly DockTab[];
  onExpand: () => void;
  onOpenTab: (id: string) => void;
}): React.JSX.Element {
  return (
    <aside className="flex w-10 shrink-0 flex-col items-center gap-1 border-l border-border bg-card/30 py-1.5">
      <button
        type="button"
        onClick={onExpand}
        title="Expand dock"
        aria-label="Expand dock"
        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <PanelRightOpen className="h-4 w-4" />
      </button>

      {tabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onOpenTab(tab.id)}
            title={tab.label}
            aria-label={tab.label}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Icon className="h-4 w-4" />
          </button>
        );
      })}
    </aside>
  );
}

function ResizeHandle({
  width,
  onWidth,
}: {
  width: number;
  onWidth: (width: number) => void;
}): React.JSX.Element {
  const draggingRef = useRef(false);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize dock"
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      // Pointer capture keeps the drag alive over the transcript and past the window edge,
      // which a plain mousemove on the handle would lose.
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        draggingRef.current = true;
      }}
      onPointerMove={(event) => {
        if (!draggingRef.current) return;
        onWidth(clampDockWidth(window.innerWidth - event.clientX, window.innerWidth));
      }}
      onPointerUp={(event) => {
        draggingRef.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onKeyDown={(event) => {
        const step =
          event.key === 'ArrowLeft' ? KEYBOARD_STEP : event.key === 'ArrowRight' ? -KEYBOARD_STEP : 0;
        if (step === 0) return;
        event.preventDefault();
        onWidth(clampDockWidth(width + step, window.innerWidth));
      }}
      className={cn(
        'absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none',
        'after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors',
        'hover:after:bg-ring/50 focus-visible:outline-none focus-visible:after:bg-ring',
      )}
    />
  );
}
