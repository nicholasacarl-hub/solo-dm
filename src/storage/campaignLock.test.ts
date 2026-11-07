import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type LockModule = typeof import('./campaignLock');

interface FakeHolder {
  steal(): void;
}

/**
 * Just enough of the Web Locks API (exclusive locks with ifAvailable / steal) to stand in for the
 * browser's lock manager, which is shared by every tab of the origin. Waiting requests aren't modelled.
 */
class FakeLockManager {
  readonly holders = new Map<string, FakeHolder>();

  request(name: string, options: LockOptions, callback: (lock: Lock | null) => unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      queueMicrotask(() => {
        const holder = this.holders.get(name);
        if (holder && options.ifAvailable) {
          Promise.resolve()
            .then(() => callback(null))
            .then(resolve, reject);
          return;
        }
        if (holder && !options.steal) throw new Error('FakeLockManager: waiting requests are not modelled');
        if (holder) {
          this.holders.delete(name);
          holder.steal();
        }
        let stolen = false;
        const me: FakeHolder = {
          steal() {
            stolen = true;
            reject(new DOMException('Lock broken by another request with the "steal" option.', 'AbortError'));
          },
        };
        this.holders.set(name, me);
        const settle = () => {
          if (this.holders.get(name) === me) this.holders.delete(name);
        };
        Promise.resolve()
          .then(() => callback({ name, mode: options.mode ?? 'exclusive' } as Lock))
          .then(
            (value) => {
              settle();
              if (!stolen) resolve(value);
            },
            (error: unknown) => {
              settle();
              if (!stolen) reject(error);
            },
          );
      });
    });
  }

  async query(): Promise<LockManagerSnapshot> {
    return { held: [...this.holders.keys()].map((name) => ({ name, mode: 'exclusive' as const, clientId: 'tab' })), pending: [] };
  }
}

/** A fresh copy of the module: its own in-memory state, like a separate browser tab. */
async function openTab(): Promise<LockModule> {
  vi.resetModules();
  return import('./campaignLock');
}

let locks: FakeLockManager;

function installLocks(manager: unknown): void {
  Object.defineProperty(window.navigator, 'locks', { value: manager, configurable: true });
}

afterEach(() => {
  Reflect.deleteProperty(window.navigator, 'locks');
});

describe('acquireCampaignLock without Web Locks', () => {
  it('resolves a lock that never conflicts, and nothing is open elsewhere', async () => {
    const [a, b] = [await openTab(), await openTab()];
    const first = await a.acquireCampaignLock('camp-1');
    const second = await b.acquireCampaignLock('camp-1');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(await b.isCampaignOpenElsewhere('camp-1')).toBe(false);
    first?.release();
    second?.release();
  });

  it('falls back to such a lock when the browser refuses the request (e.g. an opaque origin)', async () => {
    installLocks({
      request: () => Promise.reject(new DOMException('Access denied', 'SecurityError')),
      query: () => Promise.reject(new DOMException('Access denied', 'SecurityError')),
    });
    const tab = await openTab();
    expect(await tab.acquireCampaignLock('camp-1')).not.toBeNull();
    expect(await tab.isCampaignOpenElsewhere('camp-1')).toBe(false);
  });
});

describe('acquireCampaignLock with Web Locks', () => {
  beforeEach(() => {
    locks = new FakeLockManager();
    installLocks(locks);
  });

  it('gives a second tab null while the first holds the campaign, and lets it in after release', async () => {
    const [a, b] = [await openTab(), await openTab()];
    const held = await a.acquireCampaignLock('camp-1');
    expect(held).not.toBeNull();
    expect([...locks.holders.keys()]).toEqual(['solo-dm:campaign:camp-1']);

    expect(await b.acquireCampaignLock('camp-1')).toBeNull();
    expect(await b.isCampaignOpenElsewhere('camp-1')).toBe(true);
    await expect(b.assertCampaignNotOpenElsewhere('camp-1')).rejects.toThrow(b.OPEN_ELSEWHERE_ERROR);
    expect(await a.isCampaignOpenElsewhere('camp-1')).toBe(false);
    // Other campaigns are independent.
    expect(await b.acquireCampaignLock('camp-2')).not.toBeNull();

    held?.release();
    held?.release(); // twice is harmless
    await vi.waitFor(() => expect(locks.holders.has('solo-dm:campaign:camp-1')).toBe(false));
    expect(await b.isCampaignOpenElsewhere('camp-1')).toBe(false);
    expect(await b.acquireCampaignLock('camp-1')).not.toBeNull();
  });

  it('steal takes the campaign over; the first tab learns it lost it and is then refused', async () => {
    const [a, b] = [await openTab(), await openTab()];
    const first = await a.acquireCampaignLock('camp-1');
    let lost = false;
    void first?.lost.then(() => {
      lost = true;
    });

    const taken = await b.acquireCampaignLock('camp-1', { steal: true });

    expect(taken).not.toBeNull();
    await vi.waitFor(() => expect(lost).toBe(true));
    expect(await a.isCampaignOpenElsewhere('camp-1')).toBe(true);
    expect(await b.isCampaignOpenElsewhere('camp-1')).toBe(false);
    expect(await a.acquireCampaignLock('camp-1')).toBeNull();
    first?.release(); // releasing a lost lock is harmless
    expect(await a.isCampaignOpenElsewhere('camp-1')).toBe(true);
    // Taking it back works the same way.
    const back = await a.acquireCampaignLock('camp-1', { steal: true });
    expect(back).not.toBeNull();
    expect(await a.isCampaignOpenElsewhere('camp-1')).toBe(false);
  });

  it('shares one lock between holders in the same tab until the last one releases', async () => {
    const [a, b] = [await openTab(), await openTab()];
    const [first, second] = await Promise.all([a.acquireCampaignLock('camp-1'), a.acquireCampaignLock('camp-1')]);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // Stealing from itself just shares it too.
    const third = await a.acquireCampaignLock('camp-1', { steal: true });
    expect(third?.lost).toBe(first?.lost);

    first?.release();
    third?.release();
    expect(await b.acquireCampaignLock('camp-1')).toBeNull();
    second?.release();
    await vi.waitFor(async () => expect(await b.acquireCampaignLock('camp-1')).not.toBeNull());
  });

  it('a remount right after a release gets the lock again instead of finding the campaign taken', async () => {
    const tab = await openTab();
    const mount = tab.acquireCampaignLock('camp-1');
    // StrictMode: the first mount's cleanup releases as soon as its lock arrives; the second mount
    // has already asked again.
    void mount.then((lock) => lock?.release());
    const remount = await tab.acquireCampaignLock('camp-1');
    expect(remount).not.toBeNull();
    expect(locks.holders.has('solo-dm:campaign:camp-1')).toBe(true);

    const other = await openTab();
    expect(await other.acquireCampaignLock('camp-1')).toBeNull();
  });
});
