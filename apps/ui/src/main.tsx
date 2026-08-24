import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { HarnessProvider } from './state/HarnessContext';
import { DisplaySettingsProvider } from './state/DisplaySettingsContext';
import { RecoveryFixture } from './recovery-fixture';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

const recoveryFixture = new URLSearchParams(window.location.search).get('awos-fixture') === 'recovery';

createRoot(container).render(
  <StrictMode>
    <DisplaySettingsProvider>
      {recoveryFixture ? (
        <RecoveryFixture />
      ) : (
        <HarnessProvider>
          <App />
        </HarnessProvider>
      )}
    </DisplaySettingsProvider>
  </StrictMode>,
);
