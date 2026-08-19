import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { HarnessProvider } from './state/HarnessContext';
import { DisplaySettingsProvider } from './state/DisplaySettingsContext';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <DisplaySettingsProvider>
      <HarnessProvider>
        <App />
      </HarnessProvider>
    </DisplaySettingsProvider>
  </StrictMode>,
);
