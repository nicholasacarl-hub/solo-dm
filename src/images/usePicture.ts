/**
 * What an image card in the story log should show, from the entry, the picture stored on this device
 * and whether this tab is still painting it. Robust to the corners: a picture that landed in storage
 * after the player left the table shows even if the entry still says pending; a pending entry nobody
 * is painting any more (the page was closed mid-painting) reads as interrupted, not forever pending.
 */
import { useCallback, useState, useSyncExternalStore } from 'react';
import type { ImageLogEntry } from '@/types';
import { useImageUrlState } from '@/storage';
import { canRetryIllustration, isPainting, retryIllustration, subscribePainting } from './illustrate';

export type PictureView =
  /** Being painted (or waiting its turn). */
  | { status: 'painting' }
  /** Stored here; reading it. */
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  /** The service refused or something went wrong. `retry` is there when this tab can paint it again. */
  | { status: 'failed'; error: string; retry?: () => Promise<void> }
  /** Pending, but nothing is painting it any more (the page was closed or reloaded meanwhile). */
  | { status: 'interrupted' }
  /** Finished, but the picture isn't on this device (deleted, or the story came from another device). */
  | { status: 'missing' };

export const PICTURE_INTERRUPTED = 'This picture was interrupted before it was finished. Ask the DM to paint it again.';
export const PICTURE_MISSING = 'This picture isn’t stored on this device.';

export function usePicture(entry: Pick<ImageLogEntry, 'imageId' | 'status' | 'error'>): PictureView {
  const stored = useImageUrlState(entry.imageId);
  const painting = useSyncExternalStore(subscribePainting, () => isPainting(entry.imageId));
  const [retryError, setRetryError] = useState<string | null>(null);
  const retry = useCallback(async () => {
    const result = await retryIllustration(entry.imageId);
    setRetryError(result.ok ? null : result.reason);
  }, [entry.imageId]);

  if (stored.status === 'ready') return { status: 'ready', url: stored.url };
  if (painting) return { status: 'painting' };
  if (entry.status === 'failed') {
    const error = retryError ?? entry.error ?? 'The picture couldn’t be made.';
    return canRetryIllustration(entry.imageId) ? { status: 'failed', error, retry } : { status: 'failed', error };
  }
  if (stored.status === 'loading') return { status: 'loading' };
  return entry.status === 'pending' ? { status: 'interrupted' } : { status: 'missing' };
}
