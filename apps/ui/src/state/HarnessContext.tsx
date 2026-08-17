import { createContext, useContext } from 'react';
import { useHarness, type Harness } from '@/hooks/useHarness';

/**
 * One live harness for the whole tree.
 *
 * `useHarness` owns a socket, so it can only ever be called once — prop-drilling its
 * result was the mechanism enforcing that. A provider keeps the single-instance
 * guarantee while letting panels reach the parts they need directly.
 */
const HarnessContext = createContext<Harness | null>(null);

export function HarnessProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const harness = useHarness();
  return <HarnessContext.Provider value={harness}>{children}</HarnessContext.Provider>;
}

export function useHarnessContext(): Harness {
  const harness = useContext(HarnessContext);
  if (harness === null) {
    throw new Error('useHarnessContext must be used within a HarnessProvider');
  }
  return harness;
}
