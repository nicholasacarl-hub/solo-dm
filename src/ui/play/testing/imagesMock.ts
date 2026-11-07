/**
 * Stand-in for '@/images' in UI tests: vi.mock('@/images', () => import('@/ui/play/testing/imagesMock')).
 *
 * Availability follows the settings store like the real module (an OpenAI key and a frequency other
 * than "off"), so tests switch pictures on with withImages(). Call resetImagesMock() in beforeEach.
 */
import { vi } from 'vitest';
import type * as Images from '@/images';
import { useSettings } from '@/state/settingsStore';
import { DEFAULT_IMAGE_SETTINGS, type AppSettings } from '@/types';

/** A tiny portrait, as generatePortrait returns it (a small JPEG data: URL). */
export const PAINTED_PORTRAIT = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U';

function available(settings: AppSettings = useSettings.getState()): { ok: true } | { ok: false; reason: string } {
  if (settings.images.frequency === 'off') return { ok: false, reason: 'Illustrations are turned off (Settings → Illustrations).' };
  if (!settings.images.openaiApiKey.trim()) {
    return { ok: false, reason: 'Pictures need an OpenAI API key: the player can add one in Settings → Illustrations.' };
  }
  return { ok: true };
}

export const imagesAvailable = vi.fn<typeof Images.imagesAvailable>(available);
export const requestIllustration = vi.fn<typeof Images.requestIllustration>(async () => ({ ok: false, reason: 'Not in tests.' }));
export const generatePortrait = vi.fn<typeof Images.generatePortrait>(async () => ({ portrait: PAINTED_PORTRAIT, imageId: 'img-portrait' }));
export const testOpenAiKey = vi.fn<typeof Images.testOpenAiKey>(async () => ({ ok: true }));
export const buildImagePrompt = vi.fn<typeof Images.buildImagePrompt>((input) => input.prompt);
export const usePicture = vi.fn<typeof Images.usePicture>(() => ({ status: 'loading' }));

/** Pictures on: an OpenAI key in the settings store (frequency as given). */
export function withImages(frequency: AppSettings['images']['frequency'] = 'request'): void {
  useSettings.setState({ images: { ...DEFAULT_IMAGE_SETTINGS, openaiApiKey: 'sk-test', frequency } });
}

export function resetImagesMock(): void {
  useSettings.setState({ images: { ...DEFAULT_IMAGE_SETTINGS } });
  imagesAvailable.mockReset().mockImplementation(available);
  requestIllustration.mockReset().mockImplementation(async () => ({ ok: false, reason: 'Not in tests.' }));
  generatePortrait.mockReset().mockImplementation(async () => ({ portrait: PAINTED_PORTRAIT, imageId: 'img-portrait' }));
  testOpenAiKey.mockReset().mockImplementation(async () => ({ ok: true }));
  buildImagePrompt.mockReset().mockImplementation((input) => input.prompt);
  usePicture.mockReset().mockImplementation(() => ({ status: 'loading' }));
}
