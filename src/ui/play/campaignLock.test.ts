import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { acquireCampaignLock, type CampaignLock } from '@/storage';
import { forgetCampaignHolds, holdCampaign, RELEASE_DELAY_MS } from './campaignLock';

vi.mock('@/storage', () => ({ acquireCampaignLock: vi.fn() }));

function fakeLock(): { lock: CampaignLock & { release: Mock<() => void> }; lose: () => void } {
  let lose!: () => void;
  const lost = new Promise<void>((resolve) => (lose = resolve));
  return { lock: { release: vi.fn<() => void>(), lost }, lose };
}

const acquire = vi.mocked(acquireCampaignLock);

beforeEach(() => {
  vi.useFakeTimers();
  acquire.mockReset();
});

afterEach(() => {
  forgetCampaignHolds();
  vi.useRealTimers();
});

describe('holdCampaign', () => {
  it('asks storage for the lock and hands it out', async () => {
    const { lock } = fakeLock();
    acquire.mockResolvedValue(lock);
    const hold = holdCampaign('camp-1');
    await expect(hold.lock).resolves.toBe(lock);
    expect(acquire).toHaveBeenCalledWith('camp-1', undefined);
  });

  it('shares one lock between a mount and an immediate remount (StrictMode), releasing it only at the end', async () => {
    const { lock } = fakeLock();
    acquire.mockResolvedValue(lock);
    const first = holdCampaign('camp-1');
    first.release();
    const second = holdCampaign('camp-1');
    await vi.advanceTimersByTimeAsync(RELEASE_DELAY_MS * 2);

    expect(acquire).toHaveBeenCalledTimes(1);
    await expect(second.lock).resolves.toBe(lock);
    expect(lock.release).not.toHaveBeenCalled();

    second.release();
    second.release(); // releasing twice is harmless
    await vi.advanceTimersByTimeAsync(RELEASE_DELAY_MS);
    expect(lock.release).toHaveBeenCalledTimes(1);

    // Released for good: the next hold asks storage again.
    holdCampaign('camp-1');
    expect(acquire).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('asks again after another tab held the campaign, and steals when told to', async () => {
    acquire.mockResolvedValueOnce(null);
    await expect(holdCampaign('camp-1').lock).resolves.toBeNull();

    const { lock } = fakeLock();
    acquire.mockResolvedValueOnce(lock);
    await expect(holdCampaign('camp-1', { steal: true }).lock).resolves.toBe(lock);
    expect(acquire).toHaveBeenLastCalledWith('camp-1', { steal: true });
  });

  it('forgets a lock that another tab took over', async () => {
    const taken = fakeLock();
    acquire.mockResolvedValueOnce(taken.lock);
    await holdCampaign('camp-1').lock;
    taken.lose();
    await vi.advanceTimersByTimeAsync(0);

    const again = fakeLock();
    acquire.mockResolvedValueOnce(again.lock);
    await expect(holdCampaign('camp-1').lock).resolves.toBe(again.lock);
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('passes a locking failure on (and tries afresh next time)', async () => {
    acquire.mockRejectedValueOnce(new Error('locks broke'));
    await expect(holdCampaign('camp-1').lock).rejects.toThrow('locks broke');
    acquire.mockResolvedValueOnce(null);
    await expect(holdCampaign('camp-1').lock).resolves.toBeNull();
  });
});
