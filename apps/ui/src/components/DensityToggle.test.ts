import { describe, test, expect } from 'vitest';
import type { Density } from '@/state/DisplaySettingsContext';
import { DENSITY_OPTIONS } from './DensityToggle';

/**
 * The density is persisted, so an option missing from the control is worse than a
 * cosmetic gap: whoever lands on that setting has no way back out of it. The record
 * below is exhaustive by type, which turns "we added a fourth density" into a failure
 * here rather than a dead end in the header.
 */
const EVERY_DENSITY: Record<Density, true> = {
  compact: true,
  normal: true,
  verbose: true,
};

describe('DENSITY_OPTIONS', () => {
  test('offers every density exactly once', () => {
    const offered = DENSITY_OPTIONS.map((option) => option.value);
    expect([...offered].sort()).toEqual(Object.keys(EVERY_DENSITY).sort());
  });

  test('runs quietest to loudest, so the control reads as a scale', () => {
    expect(DENSITY_OPTIONS.map((option) => option.value)).toEqual([
      'compact',
      'normal',
      'verbose',
    ]);
  });

  test('every option explains itself on hover', () => {
    for (const option of DENSITY_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.hint.length).toBeGreaterThan(0);
    }
  });
});
