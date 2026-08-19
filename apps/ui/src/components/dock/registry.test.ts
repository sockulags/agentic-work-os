import { describe, expect, it } from 'vitest';
import { ListChecks } from 'lucide-react';
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
});
