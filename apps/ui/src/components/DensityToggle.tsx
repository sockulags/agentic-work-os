import { useDisplaySettings, type Density } from '@/state/DisplaySettingsContext';
import { cn } from '@/lib/utils';

export const DENSITY_OPTIONS: Array<{ value: Density; label: string; hint: string }> = [
  { value: 'compact', label: 'Compact', hint: 'Hide reasoning, collapse tool calls' },
  { value: 'normal', label: 'Normal', hint: 'Reasoning and tool calls collapsed' },
  { value: 'verbose', label: 'Verbose', hint: 'Expand reasoning and tool output' },
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
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            title={option.hint}
            onClick={() => setDensity(option.value)}
            className={cn(
              'rounded px-2 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              active
                ? 'bg-secondary text-secondary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
