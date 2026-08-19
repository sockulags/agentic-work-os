import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

/**
 * Unmounting has to be wired up by hand: React Testing Library only registers its own
 * cleanup when the runner exposes a global `afterEach`, and this suite runs without
 * vitest globals. Without it, every render would stack up in the same document and
 * `getByText` would start reporting ambiguous matches across unrelated tests.
 */
afterEach(cleanup);
