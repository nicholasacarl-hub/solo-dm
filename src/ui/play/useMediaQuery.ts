import { useCallback, useSyncExternalStore } from 'react';

const cache = new Map<string, MediaQueryList>();

function mediaQueryList(query: string): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  let mql = cache.get(query);
  if (!mql) {
    mql = window.matchMedia(query);
    cache.set(query, mql);
  }
  return mql;
}

/** Live media-query match. `fallback` is used where matchMedia is unavailable (SSR, jsdom). */
export function useMediaQuery(query: string, fallback = false): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = mediaQueryList(query);
      if (!mql) return () => {};
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query],
  );
  const getSnapshot = () => mediaQueryList(query)?.matches ?? fallback;
  return useSyncExternalStore(subscribe, getSnapshot, () => fallback);
}

/** The three-column table layout starts at 1024 px (Tailwind `lg`). */
export function useIsDesktop(): boolean {
  return useMediaQuery('(min-width: 1024px)');
}

/** Touch-first devices: Enter inserts a newline in the composer and the Send button sends. */
export function useIsTouch(): boolean {
  return useMediaQuery('(hover: none) and (pointer: coarse)');
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}

/** Clear cached MediaQueryLists (tests swap window.matchMedia between cases). */
export function resetMediaQueryCache(): void {
  cache.clear();
}
