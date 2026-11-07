/**
 * Notifications for changes made behind the game store's back: a campaign replaced by an import or a
 * GitHub pull, or deleted from the save slots. The game store listens so it never keeps writing a
 * stale copy over fresh data.
 *
 * Kept in its own dependency-free module so subscribing at import time is always safe.
 */

export type CampaignChange = { type: 'replaced' | 'deleted'; campaignId: string };

type Listener = (change: CampaignChange) => void;

const listeners = new Set<Listener>();

/** Subscribe to campaign replacements and deletions. Returns an unsubscribe function. */
export function onCampaignChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitCampaignChange(change: CampaignChange): void {
  for (const listener of [...listeners]) {
    try {
      listener(change);
    } catch (error) {
      console.error('[storage] campaign change listener failed:', error);
    }
  }
}
