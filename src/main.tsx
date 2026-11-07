import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource/spectral/400.css';
import '@fontsource/spectral/400-italic.css';
import '@fontsource/spectral/600.css';
import '@fontsource/cinzel/600.css';
import './index.css';
import { App } from './App';
import { useSettings } from './state/settingsStore';
import { applyAppearance } from './ui/shell/useAppearance';

// Apply the saved theme before the first paint so there is no light/dark flash.
applyAppearance(useSettings.getState());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
