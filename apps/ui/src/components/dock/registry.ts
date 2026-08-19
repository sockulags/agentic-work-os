import { GitCompare, ListChecks, Shapes, type LucideIcon } from 'lucide-react';
import type { Harness } from '@/hooks/useHarness';
import { parseUnifiedDiff } from '@/lib/diff';
import { PlanPanel } from './tabs/PlanPanel';
import { ChangesPanel } from './tabs/ChangesPanel';
import { ArtifactsTab } from './tabs/ArtifactsTab';

export interface DockTab {
  id: string;
  label: string;
  icon: LucideIcon;
  /**
   * Count shown beside the label. A selector over harness state rather than a value the
   * dock hands down, because that is what keeps registration to a single line: the tab's
   * component reads what it needs from the harness context, and so does its badge.
   *
   * Zero is a legitimate answer and is rendered. Hiding a tab that happens to be empty
   * would move every other tab sideways mid-stream, and a moving target is worse than a
   * quiet one.
   */
  badge?: (harness: Harness) => number;
  Component: () => React.JSX.Element;
}

/**
 * Every panel the dock can show, in tab order. Adding one is a line here plus its file.
 *
 * Typed as a non-empty tuple so the rest of the dock can rely on there always being a tab
 * to fall back to, rather than carrying an "empty dock" branch that can never render.
 */
export const DOCK_TABS: readonly [DockTab, ...DockTab[]] = [
  {
    id: 'plan',
    label: 'Plan',
    icon: ListChecks,
    badge: (h) => h.runtime?.plan?.length ?? 0,
    Component: PlanPanel,
  },
  {
    id: 'changes',
    label: 'Changes',
    icon: GitCompare,
    badge: (h) => countChangedFiles(h.runtime?.diff),
    Component: ChangesPanel,
  },
  {
    id: 'artifacts',
    label: 'Artifacts',
    icon: Shapes,
    badge: (h) => h.artifacts.length,
    Component: ArtifactsTab,
  },
];

/**
 * The tab to show for a stored selection.
 *
 * A stored id can outlive the tab it names — a renamed tab, an older build, a tab behind
 * a capability that went away — so an unknown id falls back to the first tab instead of
 * leaving the dock blank on the reload after an upgrade.
 */
export function resolveActiveTab(
  tabs: readonly [DockTab, ...DockTab[]],
  activeTabId: string | null,
): DockTab {
  return tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
}

/** Counted through the real parser so the badge can never disagree with the panel. */
function countChangedFiles(patch: string | null | undefined): number {
  const trimmed = patch?.trim() ?? '';
  return trimmed === '' ? 0 : parseUnifiedDiff(trimmed).files.length;
}
