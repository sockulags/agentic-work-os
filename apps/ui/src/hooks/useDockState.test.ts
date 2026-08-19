import { describe, expect, it } from 'vitest';
import { DOCK_MIN_WIDTH, clampDockWidth, parseStoredDock } from './useDockState';

describe('clampDockWidth', () => {
  it('keeps a width that is already within bounds', () => {
    expect(clampDockWidth(400, 1600)).toBe(400);
  });

  it('raises a too-narrow width to the minimum', () => {
    expect(clampDockWidth(100, 1600)).toBe(DOCK_MIN_WIDTH);
  });

  it('caps at 60% of the viewport', () => {
    expect(clampDockWidth(1400, 1600)).toBe(960);
  });

  it('lets the minimum win on viewports too narrow for both bounds', () => {
    // 60% of 400 is below the 280px floor. CSS resolves this the same way, and the drag
    // handler has to agree or the dragged width and the rendered width drift apart.
    expect(clampDockWidth(300, 400)).toBe(DOCK_MIN_WIDTH);
  });
});

describe('parseStoredDock', () => {
  it('falls back to defaults with nothing stored', () => {
    expect(parseStoredDock(null)).toEqual({ open: true, width: 380, activeTabId: null });
  });

  it('falls back to defaults on unparseable storage', () => {
    expect(parseStoredDock('{')).toEqual({ open: true, width: 380, activeTabId: null });
    expect(parseStoredDock('null')).toEqual({ open: true, width: 380, activeTabId: null });
  });

  it('restores a stored layout', () => {
    const raw = JSON.stringify({ open: false, width: 520, activeTabId: 'changes' });
    expect(parseStoredDock(raw)).toEqual({ open: false, width: 520, activeTabId: 'changes' });
  });

  it('replaces individually malformed fields without discarding the rest', () => {
    const raw = JSON.stringify({ open: 'yes', width: 'wide', activeTabId: 7 });
    expect(parseStoredDock(raw)).toEqual({ open: true, width: 380, activeTabId: null });
  });

  it('lifts a stored width below the floor', () => {
    const raw = JSON.stringify({ open: true, width: 10, activeTabId: null });
    expect(parseStoredDock(raw).width).toBe(DOCK_MIN_WIDTH);
  });
});
