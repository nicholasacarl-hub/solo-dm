/**
 * DEV-ONLY entry for the Play screen preview: open /src/ui/play/__dev__/index.html?preview=play on
 * the Vite dev server. Not part of the production build (only the root index.html is).
 */
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource/spectral/400.css';
import '@fontsource/spectral/400-italic.css';
import '@fontsource/spectral/600.css';
import '@fontsource/cinzel/600.css';
import '@/index.css';
import { applyTheme } from '@/state/settingsStore';

const params = new URLSearchParams(window.location.search);
const container = document.getElementById('root');

if (container && import.meta.env.DEV && params.get('preview') === 'play') {
  applyTheme(params.get('theme') === 'light' ? 'light' : 'dark');
  const PlayPreview = lazy(() => import('./PlayPreview'));
  createRoot(container).render(
    <StrictMode>
      <Suspense fallback={null}>
        <PlayPreview />
      </Suspense>
    </StrictMode>,
  );
} else if (container) {
  container.textContent = 'Add ?preview=play to the URL to preview the Play screen.';
}
