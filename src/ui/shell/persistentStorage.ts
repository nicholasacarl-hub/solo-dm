/**
 * Whether this browser promises to keep Solo DM's saves. Best-effort site storage can be evicted
 * when the device runs low on space (and Safari clears it for sites not visited in a while), and
 * IndexedDB is the only copy of a campaign unless the player exports it or syncs to GitHub.
 */
import { useCallback, useEffect, useState } from 'react';
import { requestPersistentStorage } from '@/storage';

export type StoragePersistence = 'checking' | 'persistent' | 'best-effort' | 'unknown';

/** The browser's answer without asking anything (never prompts). null = it can't say. */
export async function storagePersisted(): Promise<boolean | null> {
  try {
    const manager = globalThis.navigator?.storage;
    if (typeof manager?.persisted !== 'function') return null;
    return await manager.persisted();
  } catch {
    return null;
  }
}

/**
 * Ask the browser to keep saves (call from a click that creates or opens a campaign). Fire and
 * forget: Chrome decides silently, Firefox may ask, and a refusal changes nothing in the app.
 */
export function askToKeepSaves(): void {
  try {
    void requestPersistentStorage().catch(() => undefined);
  } catch {
    // Not available here; Settings suggests a backup instead.
  }
}

const toStatus = (persisted: boolean | null): StoragePersistence =>
  persisted === null ? 'unknown' : persisted ? 'persistent' : 'best-effort';

/** The current persistence status, plus `request()` for an explicit "keep my saves" button. */
export function useStoragePersistence(): { status: StoragePersistence; request: () => Promise<boolean> } {
  const [status, setStatus] = useState<StoragePersistence>('checking');

  useEffect(() => {
    let live = true;
    void storagePersisted().then((persisted) => {
      if (live) setStatus(toStatus(persisted));
    });
    return () => {
      live = false;
    };
  }, []);

  const request = useCallback(async () => {
    const granted = await requestPersistentStorage().catch(() => false);
    const persisted = await storagePersisted();
    setStatus(toStatus(granted ? true : persisted));
    return granted;
  }, []);

  return { status, request };
}
