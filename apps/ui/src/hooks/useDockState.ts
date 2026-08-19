import { useCallback, useEffect, useState } from 'react';

export const DOCK_MIN_WIDTH = 280;
export const DOCK_MAX_VIEWPORT_FRACTION = 0.6;

const DEFAULT_WIDTH = 380;
const STORAGE_KEY = 'awos:dock';

export interface DockState {
  open: boolean;
  width: number;
  /** Null until the user has picked a tab, and after a stored tab id stops existing. */
  activeTabId: string | null;
  setOpen: (open: boolean) => void;
  setWidth: (width: number) => void;
  setActiveTabId: (id: string) => void;
}

interface StoredDock {
  open: boolean;
  width: number;
  activeTabId: string | null;
}

const DEFAULTS: StoredDock = { open: true, width: DEFAULT_WIDTH, activeTabId: null };

/**
 * Bounds shared by the drag handler and the panel's CSS.
 *
 * Below ~470px of viewport the two limits cross; the minimum wins there, matching the
 * CSS cascade where `min-width` beats `max-width`. Any other resolution would let the
 * dragged width and the rendered width drift apart.
 */
export function clampDockWidth(width: number, viewportWidth: number): number {
  const max = viewportWidth * DOCK_MAX_VIEWPORT_FRACTION;
  return Math.max(DOCK_MIN_WIDTH, Math.min(width, max));
}

export function parseStoredDock(raw: string | null): StoredDock {
  if (raw === null) return DEFAULTS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULTS;
    const value = parsed as Partial<StoredDock>;
    return {
      open: typeof value.open === 'boolean' ? value.open : DEFAULTS.open,
      width:
        typeof value.width === 'number' && Number.isFinite(value.width)
          ? Math.max(DOCK_MIN_WIDTH, value.width)
          : DEFAULTS.width,
      activeTabId: typeof value.activeTabId === 'string' ? value.activeTabId : null,
    };
  } catch {
    return DEFAULTS;
  }
}

function readStored(): StoredDock {
  try {
    return parseStoredDock(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage can be denied outright (private mode, blocked third-party context), which
    // is not worth failing the app boot over.
    return DEFAULTS;
  }
}

/**
 * Dock geometry and tab selection, persisted across reloads.
 *
 * The stored width is a raw pixel figure rather than a pre-clamped one: a dock dragged
 * wide on a large display should come back wide there, even after a session on a laptop
 * screen squeezed it. Clamping happens at render, not at rest.
 */
export function useDockState(): DockState {
  const [state, setState] = useState<StoredDock>(readStored);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Same as reading: the layout just won't survive a reload.
    }
  }, [state]);

  const setOpen = useCallback((open: boolean) => {
    setState((prev) => (prev.open === open ? prev : { ...prev, open }));
  }, []);

  const setWidth = useCallback((width: number) => {
    setState((prev) => (prev.width === width ? prev : { ...prev, width }));
  }, []);

  const setActiveTabId = useCallback((activeTabId: string) => {
    setState((prev) => (prev.activeTabId === activeTabId ? prev : { ...prev, activeTabId }));
  }, []);

  return { ...state, setOpen, setWidth, setActiveTabId };
}
