/**
 * This tab's claim on a campaign while it is open at the table: only one tab may write a campaign
 * at a time (storage.acquireCampaignLock, Web Locks). Mounts of the table share one lock per
 * campaign, and letting go waits a moment, so a remount (React StrictMode, re-entering the route)
 * reuses the lock instead of racing its own release and finding the campaign "taken".
 */
import { acquireCampaignLock, type CampaignLock } from '@/storage';

export interface CampaignHold {
  /** The lock, or null when another tab has the campaign open. Rejects only if locking itself broke. */
  lock: Promise<CampaignLock | null>;
  /** Let go (once). The lock is released only when no mount of this tab still holds it. */
  release(): void;
}

interface Holder {
  lock: Promise<CampaignLock | null>;
  users: number;
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

const holders = new Map<string, Holder>();

/** How long an unused lock is kept before it is released (covers an immediate remount). */
export const RELEASE_DELAY_MS = 50;

function forget(campaignId: string, holder: Holder): void {
  if (holders.get(campaignId) === holder) holders.delete(campaignId);
}

/**
 * Hold the campaign for this tab. With `steal`, take it over from another tab (that tab's lock
 * reports `lost`). A null or lost lock is forgotten, so the next call asks again.
 */
export function holdCampaign(campaignId: string, opts: { steal?: boolean } = {}): CampaignHold {
  let holder = holders.get(campaignId);
  if (!holder) {
    const created: Holder = { lock: Promise.resolve(null), users: 0, releaseTimer: null };
    created.lock = Promise.resolve()
      .then(() => acquireCampaignLock(campaignId, opts.steal ? { steal: true } : undefined))
      .then(
        (lock) => {
          if (!lock) forget(campaignId, created);
          else void lock.lost.then(() => forget(campaignId, created));
          return lock;
        },
        (err: unknown) => {
          forget(campaignId, created);
          throw err;
        },
      );
    holders.set(campaignId, created);
    holder = created;
  }

  const held = holder;
  held.users += 1;
  if (held.releaseTimer !== null) {
    clearTimeout(held.releaseTimer);
    held.releaseTimer = null;
  }

  let released = false;
  return {
    lock: held.lock,
    release() {
      if (released) return;
      released = true;
      held.users -= 1;
      if (held.users > 0 || held.releaseTimer !== null) return;
      held.releaseTimer = setTimeout(() => {
        held.releaseTimer = null;
        if (held.users > 0) return;
        forget(campaignId, held);
        held.lock.then(
          (lock) => lock?.release(),
          () => {},
        );
      }, RELEASE_DELAY_MS);
    },
  };
}

/** Drop every hold without releasing it (tests start each case from a clean slate). */
export function forgetCampaignHolds(): void {
  for (const holder of holders.values()) {
    if (holder.releaseTimer !== null) clearTimeout(holder.releaseTimer);
  }
  holders.clear();
}
