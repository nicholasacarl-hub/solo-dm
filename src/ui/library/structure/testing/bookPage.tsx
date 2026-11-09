/**
 * Test helpers for the book page (not shipped: only *.test.tsx files import this): a viewport for the
 * layout's media queries, and the non-structured names of @/data and @/storage the page also uses,
 * to spread into the shared vi.mock factories.
 */
import { vi } from 'vitest';
import { EXPECTED_MERGED, gloamwoodSource } from '@/test/structuredFixtures';
import { resetMediaQueryCache } from '@/ui/play/useMediaQuery';

/** Make (min-width: Npx) queries match a viewport width (jsdom has no matchMedia; the page then lays out wide). */
export function setViewport(width: number | null): void {
  resetMediaQueryCache();
  if (width === null) {
    Reflect.deleteProperty(window, 'matchMedia');
    return;
  }
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const min = /min-width:\s*(\d+)px/.exec(query);
      const max = /max-width:\s*(\d+)px/.exec(query);
      const matches = min ? width >= Number(min[1]) : max ? width <= Number(max[1]) : false;
      return { matches, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false };
    },
  });
}

/** @/data names the book page uses besides the structured-imports ones. */
export function bookPageDataExtras() {
  return {
    useBuilderData: vi.fn(() => ({ data: EXPECTED_MERGED, error: null, loading: false })),
    invalidateRulesIndex: vi.fn(),
  };
}

/** @/storage names the book page uses besides the structured-imports ones. */
export function bookPageStorageExtras() {
  const source = gloamwoodSource();
  const sources = [source];
  return {
    useLibrarySources: vi.fn(() => sources),
    listLibrarySources: vi.fn(async () => sources),
    listCampaigns: vi.fn(async () => []),
    setLibrarySourceEnabled: vi.fn(async () => undefined),
    deleteLibrarySource: vi.fn(async () => undefined),
  };
}
