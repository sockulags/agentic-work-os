import { useDisplaySettings, type Density } from '@/state/DisplaySettingsContext';
import { Button } from './ui/button';

/**
 * The hints describe what the setting does today, not what it is meant to reach: tool
 * blocks read the same density in their own change, and the wording widens when they do.
 * A tooltip promising something the reader can watch not happen is worse than a narrow one.
 */
export const DENSITY_OPTIONS: Array<{ value: Density; label: string; hint: string }> = [
  { value: 'compact', label: 'Compact', hint: 'Hide reasoning entirely' },
  { value: 'normal', label: 'Normal', hint: 'Keep reasoning folded away' },
  { value: 'verbose', label: 'Verbose', hint: 'Show reasoning in full' },
];

/**
 * How much of the transcript to show.
 *
 * A segmented control rather than a select: three options that the reader flips between
 * while scanning output, where seeing the current one without opening anything is worth
 * the extra header width.
 */
export function DensityToggle(): React.JSX.Element {
  const { density, setDensity } = useDisplaySettings();

  return (
    <div
      role="group"
      aria-label="Transcript density"
      className="flex items-center gap-0.5 rounded-md border border-input p-0.5"
    >
      {DENSITY_OPTIONS.map((option) => {
        const active = option.value === density;
        return (
          <Button
            key={option.value}
            type="button"
            size="sm"
            variant={active ? 'secondary' : 'ghost'}
            aria-pressed={active}
            title={option.hint}
            onClick={() => setDensity(option.value)}
            className="h-[var(--density-control-height-sm)] rounded-sm px-2 py-0.5 text-[11px]"
          >
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}
