/**
 * Notifications for changes made behind the game store's back: a campaign replaced by an import or a
 * GitHub pull, or deleted from the save slots. The game store listens so it never keeps writing a
 * stale copy over fresh data. Changes are relayed to the app's other tabs too (BroadcastChannel),
 * so a tab with the campaign loaded reloads or lets go of it instead of overwriting it.
 *
 * Kept in its own dependency-free module so subscribing at import time is always safe.
 */

export type CampaignChange = { type: 'replaced' | 'deleted'; campaignId: string };

type Listener = (change: CampaignChange) => void;

const listeners = new Set<Listener>();

const CHANNEL_NAME = 'solo-dm:campaign-changes';

/** undefined = not opened yet; null = unavailable. */
let channel: BroadcastChannel | null | undefined;

function isChange(value: unknown): value is CampaignChange {
  if (typeof value !== 'object' || value === null) return false;
  const { type, campaignId } = value as Partial<CampaignChange>;
  return (type === 'replaced' || type === 'deleted') && typeof campaignId === 'string' && campaignId !== '';
}

function notify(change: CampaignChange): void {
  for (const listener of [...listeners]) {
    try {
      listener(change);
    } catch (error) {
      console.error('[storage] campaign change listener failed:', error);
    }
  }
}

/** The channel to this app's other tabs (a tab never receives its own messages). */
function otherTabs(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  channel = null;
  try {
    if (typeof BroadcastChannel !== 'function') return null;
    const opened = new BroadcastChannel(CHANNEL_NAME);
    opened.onmessage = (event: MessageEvent<unknown>) => {
      if (isChange(event.data)) notify({ type: event.data.type, campaignId: event.data.campaignId });
    };
    // Outside browsers (tests run in Node) an open channel would keep the process alive.
    (opened as BroadcastChannel & { unref?: () => void }).unref?.();
    channel = opened;
  } catch {
    channel = null;
  }
  return channel;
}

/** Subscribe to campaign replacements and deletions (in this tab or another). Returns an unsubscribe function. */
export function onCampaignChange(listener: Listener): () => void {
  otherTabs();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitCampaignChange(change: CampaignChange): void {
  notify(change);
  try {
    otherTabs()?.postMessage({ type: change.type, campaignId: change.campaignId });
  } catch (error) {
    console.warn('[storage] could not tell other tabs about a campaign change:', error);
  }
}
