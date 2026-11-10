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

// Once, after the first render: structuring jobs a closed page left unfinished are paused (spec §3.10),
// never resumed by themselves. It only acts when this tab can take the runner's Web Lock, so it leaves
// alone a job another open tab is running. No API call is made.
const afterFirstRender = (work: () => void) =>
  typeof window.requestIdleCallback === 'function' ? window.requestIdleCallback(work, { timeout: 5000 }) : window.setTimeout(work, 1000);
afterFirstRender(() => {
  import('@/dm/extract')
    .then((extract) => extract.recoverJobsOnStartup())
    .catch((err: unknown) => console.warn('Could not check for interrupted structuring jobs.', err));
  // Entry kinds an older import guessed wrongly (a stronghold room stored as a feat) are corrected quietly.
  import('@/data/structured/staleKinds')
    .then((kinds) => kinds.correctStaleKinds())
    .catch((err: unknown) => console.warn('Could not check the kinds of imported entries.', err));
});
