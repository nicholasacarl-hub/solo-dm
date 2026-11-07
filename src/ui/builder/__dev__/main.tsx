/** DEV ONLY entry for preview.html (see CharacterPreview.tsx). Not referenced by the app build. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource/spectral/400.css';
import '@fontsource/spectral/600.css';
import '@fontsource/cinzel/600.css';
import '@/index.css';
import { CharacterPreviewApp } from './CharacterPreview';

if (import.meta.env.DEV) {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <CharacterPreviewApp />
    </StrictMode>,
  );
}
