import { createContext, useCallback, useContext, useMemo, useState } from 'react';

export type Density = 'compact' | 'normal' | 'verbose';

export type DisplaySettings = {
  density: Density;
  setDensity: (density: Density) => void;
};

const STORAGE_KEY = 'awos:density';

const DisplaySettingsContext = createContext<DisplaySettings | null>(null);

function isDensity(value: unknown): value is Density {
  return value === 'compact' || value === 'normal' || value === 'verbose';
}

function readStoredDensity(): Density {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isDensity(stored) ? stored : 'normal';
  } catch {
    // Storage can be denied outright (private mode, blocked third-party context). A
    // display preference is not worth failing the app boot over.
    return 'normal';
  }
}

/**
 * How much of the transcript to show, kept deliberately apart from the harness.
 *
 * Separate provider, not a slice of the harness context: this changes a few times a
 * session while harness state changes many times a second, and neither should drag the
 * other's consumers into a re-render.
 */
export function DisplaySettingsProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [density, setDensityState] = useState<Density>(readStoredDensity);

  const setDensity = useCallback((next: Density) => {
    setDensityState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Same as reading: the preference just won't survive a reload.
    }
  }, []);

  const value = useMemo(() => ({ density, setDensity }), [density, setDensity]);

  return (
    <DisplaySettingsContext.Provider value={value}>{children}</DisplaySettingsContext.Provider>
  );
}

export function useDisplaySettings(): DisplaySettings {
  const settings = useContext(DisplaySettingsContext);
  if (settings === null) {
    throw new Error('useDisplaySettings must be used within a DisplaySettingsProvider');
  }
  return settings;
}
