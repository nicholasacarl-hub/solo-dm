/**
 * Whether the DM can paint pictures right now, for the controls that offer it (the "Show me the
 * scene" quick action, the gallery's empty state, the sheet's "Paint portrait").
 */
import { useMemo } from 'react';
import type { To } from 'react-router';
import { imagesAvailable } from '@/images';
import { useSettings } from '@/state/settingsStore';
import type { ImageSettings } from '@/types';

export type ImagesAvailability = { ok: true } | { ok: false; reason: string };

/** Why there are no pictures, in the player's words (imagesAvailable's reason is also what the DM is told). */
export function playerReason(images: ImageSettings, reason: string): string {
  if (images.frequency === 'off') return 'Illustrations are turned off in Settings.';
  if (!images.openaiApiKey.trim()) return 'Illustrations need your own OpenAI API key, added in Settings.';
  return reason;
}

/** Live: re-renders when the settings change whether pictures can be made (a key added, images off). */
export function useImagesAvailability(): ImagesAvailability {
  // A primitive from the selector, so the component only re-renders when the answer changes.
  const reason = useSettings((s) => {
    const result = imagesAvailable(s);
    return result.ok ? null : playerReason(s.images, result.reason);
  });
  return useMemo<ImagesAvailability>(() => (reason === null ? { ok: true } : { ok: false, reason }), [reason]);
}

/** Settings → Illustrations. The router scrolls to the section (SettingsSection id "images"). */
export const IMAGE_SETTINGS_LINK: To = { pathname: '/settings', hash: '#settings-section-images' };
