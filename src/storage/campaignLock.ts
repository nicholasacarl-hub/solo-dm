/**
 * One tab at a time per campaign. While a campaign is open at the table, its tab holds an exclusive
 * Web Lock named "solo-dm:campaign:<id>". Another tab asking for it gets null, or with `steal` takes
 * it over (the first tab's `lost` then resolves). Within one tab, holders share a single lock
 * (StrictMode remounts, two screens), released when the last holder lets go.
 *
 * Writes respect the lock: the game store, save-file imports and deletes refuse to change a
 * campaign that another tab holds (see isCampaignOpenElsewhere).
 *
 * Where Web Locks are unavailable (old browsers, some embedded views), every request succeeds
 * with a lock that never conflicts, and nothing is ever "open elsewhere".
 */

export interface CampaignLock {
  release(): void;
  /** Resolves if another tab takes the campaign over (steal). */
  lost: Promise<void>;
}

const LOCK_PREFIX = 'solo-dm:campaign:';

export const OPEN_ELSEWHERE_ERROR =
  'This campaign is open at the table in another tab or window, so it can’t be changed here. Continue there, or close that tab and try again.';

interface HeldLock {
  /** Handles in this tab still holding it. */
  refs: number;
  state: 'held' | 'releasing' | 'lost';
  lost: Promise<void>;
  /** Ends the lock callback, which lets the browser release the Web Lock. */
  unlock: () => void;
  /** Settles once the Web Lock is gone (released or stolen). */
  gone: Promise<void>;
}

/** This tab's lock per campaign while held or being released. */
const current = new Map<string, HeldLock>();
/** Acquisitions run one at a time per campaign, so concurrent requests in one tab share the lock. */
const queues = new Map<string, Promise<unknown>>();

const noop = () => {};
const never = new Promise<void>(noop);

function lockManager(): LockManager | null {
  try {
    const locks = globalThis.navigator?.locks;
    return locks && typeof locks.request === 'function' ? locks : null;
  } catch {
    return null;
  }
}

/** A lock that never conflicts (Web Locks unavailable). */
function unmanagedLock(): CampaignLock {
  return { release: noop, lost: never };
}

function handle(entry: HeldLock): CampaignLock {
  entry.refs += 1;
  let released = false;
  return {
    lost: entry.lost,
    release() {
      if (released) return;
      released = true;
      entry.refs -= 1;
      if (entry.refs > 0 || entry.state !== 'held') return;
      entry.state = 'releasing';
      entry.unlock();
    },
  };
}

type Requested = HeldLock | 'unavailable' | 'unsupported';

/** Ask the browser for the lock: granted, unavailable (held by another tab), or unsupported. */
function request(locks: LockManager, campaignId: string, steal: boolean): Promise<Requested> {
  return new Promise<Requested>((resolve) => {
    let unlock = noop;
    const until = new Promise<void>((r) => {
      unlock = r;
    });
    let markLost = noop;
    const lost = new Promise<void>((r) => {
      markLost = r;
    });
    let markGone = noop;
    const gone = new Promise<void>((r) => {
      markGone = r;
    });
    let entry: HeldLock | null = null;

    const finish = (rejected: boolean) => {
      markGone();
      // Rejected before it was granted: Web Locks don't work here (e.g. an opaque origin).
      if (!entry) {
        if (rejected) resolve('unsupported');
        return;
      }
      if (current.get(campaignId) === entry) current.delete(campaignId);
      if (rejected && entry.state === 'held') {
        // Another tab stole the lock (its request was granted with steal: true).
        entry.state = 'lost';
        markLost();
      }
    };

    let pending: Promise<unknown>;
    try {
      const options: LockOptions = steal ? { mode: 'exclusive', steal: true } : { mode: 'exclusive', ifAvailable: true };
      pending = locks.request(`${LOCK_PREFIX}${campaignId}`, options, (lock) => {
        if (!lock) {
          resolve('unavailable');
          return undefined;
        }
        entry = { refs: 0, state: 'held', lost, unlock, gone };
        current.set(campaignId, entry);
        resolve(entry);
        return until;
      });
    } catch {
      resolve('unsupported');
      return;
    }
    pending.then(
      () => finish(false),
      () => finish(true),
    );
  });
}

async function acquire(campaignId: string, steal: boolean): Promise<CampaignLock | null> {
  let entry = current.get(campaignId);
  if (entry?.state === 'releasing') {
    // Released a moment ago (a remount): wait until the browser has really let go, then ask again.
    await entry.gone;
    entry = current.get(campaignId);
  }
  if (entry?.state === 'held') return handle(entry);
  const locks = lockManager();
  if (!locks) return unmanagedLock();
  const result = await request(locks, campaignId, steal);
  if (result === 'unsupported') return unmanagedLock();
  if (result === 'unavailable') return null;
  return handle(result);
}

/**
 * Hold an exclusive per-campaign lock (Web Locks API) while the campaign is open at the table.
 * Resolves null when another tab already holds it (unless steal: true, which takes it over).
 * Where Web Locks are unavailable, resolves a lock that never conflicts.
 */
export function acquireCampaignLock(campaignId: string, opts: { steal?: boolean } = {}): Promise<CampaignLock | null> {
  const run = (queues.get(campaignId) ?? Promise.resolve()).then(() => acquire(campaignId, opts.steal === true));
  queues.set(campaignId, run.then(noop, noop));
  return run;
}

/** True when another tab or window holds the campaign's lock (it is open at the table there). */
export async function isCampaignOpenElsewhere(campaignId: string): Promise<boolean> {
  const entry = current.get(campaignId);
  if (entry && entry.state !== 'lost') return false;
  const locks = lockManager();
  if (!locks || typeof locks.query !== 'function') return false;
  try {
    const snapshot = await locks.query();
    return (snapshot.held ?? []).some((info) => info.name === `${LOCK_PREFIX}${campaignId}`);
  } catch {
    return false;
  }
}

/** Throw OPEN_ELSEWHERE_ERROR when another tab holds the campaign's lock. */
export async function assertCampaignNotOpenElsewhere(campaignId: string): Promise<void> {
  if (await isCampaignOpenElsewhere(campaignId)) throw new Error(OPEN_ELSEWHERE_ERROR);
}
