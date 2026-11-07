import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// vitest runs with globals: false, so Testing Library can't register its own auto-cleanup.
afterEach(() => {
  cleanup();
});
