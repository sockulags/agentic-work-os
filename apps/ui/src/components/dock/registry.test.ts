import { describe, expect, it } from 'vitest';
import { ListChecks } from 'lucide-react';
import type { Harness } from '@/hooks/useHarness';
import { DOCK_TABS, resolveActiveTab, type DockTab } from './registry';

const tabs: readonly [DockTab, ...DockTab[]] = [
  { id: 'first', label: 'First', icon: ListChecks, Component: () => null as never },
  { id: 'second', label: 'Second', icon: ListChecks, Component: () => null as never },
];

describe('resolveActiveTab', () => {
  it('picks the stored tab', () => {
    expect(resolveActiveTab(tabs, 'second').id).toBe('second');
  });

  it('falls back to the first tab when nothing is stored', () => {
    expect(resolveActiveTab(tabs, null).id).toBe('first');
  });

  it('falls back to the first tab when the stored id no longer exists', () => {
    expect(resolveActiveTab(tabs, 'removed-in-an-earlier-build').id).toBe('first');
  });
});

describe('DOCK_TABS', () => {
  it('has unique ids, which the persisted selection depends on', () => {
    const ids = DOCK_TABS.map((tab) => tab.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe('the workspace badge', () => {
    const badge = (workspace: unknown): number => {
      const tab = DOCK_TABS.find((entry) => entry.id === 'workspace');
      return tab?.badge?.({ workspace } as Harness) ?? -1;
    };

    it('counts what needs attention', () => {
      expect(
        badge({
          cwd: '/repo',
          resolution: {
            status: 'invalid',
            root: '/repo',
            problems: [{ severity: 'error', file: '.awos/workspace.json', path: '', message: 'x' }],
          },
        }),
      ).toBe(1);
    });

    it('stays quiet for a directory that is not a workspace, which is not a fault', () => {
      expect(badge({ cwd: '/repo', resolution: { status: 'none', searchedFrom: '/repo' } })).toBe(0);
    });

    it('stays quiet before the declaration has been read', () => {
      expect(badge(null)).toBe(0);
    });
  });
});
