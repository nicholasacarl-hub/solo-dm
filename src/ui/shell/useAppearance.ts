/**
 * Applies appearance settings to <html>: the theme (following the OS when set to "system"),
 * data-text-size and data-narration-font.
 */
import { useEffect } from 'react';
import { applyTheme, useSettings } from '@/state/settingsStore';
import type { AppSettings } from '@/types';

/** Apply appearance settings once, synchronously (call before the first render to avoid a flash). */
export function applyAppearance(settings: Pick<AppSettings, 'theme' | 'textSize' | 'narrationFont'>): void {
  applyTheme(settings.theme);
  const root = document.documentElement;
  root.dataset.textSize = settings.textSize;
  root.dataset.narrationFont = settings.narrationFont;
}

export function useAppearance(): void {
  const theme = useSettings((s) => s.theme);
  const textSize = useSettings((s) => s.textSize);
  const narrationFont = useSettings((s) => s.narrationFont);

  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const follow = () => applyTheme('system');
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.textSize = textSize;
  }, [textSize]);

  useEffect(() => {
    document.documentElement.dataset.narrationFont = narrationFont;
  }, [narrationFont]);
}
