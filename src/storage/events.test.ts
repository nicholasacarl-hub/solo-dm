import { describe, expect, it, vi } from 'vitest';
import type { CampaignChange } from './events';

/** A fresh copy of the module: its own listeners, like another tab of the app. */
async function openTab(): Promise<typeof import('./events')> {
  vi.resetModules();
  return import('./events');
}

describe('campaign change events', () => {
  it('reach listeners in this tab and in the other tabs (BroadcastChannel), once each', async () => {
    const here = await openTab();
    const there = await openTab();
    const seenHere: CampaignChange[] = [];
    const seenThere: CampaignChange[] = [];
    here.onCampaignChange((c) => seenHere.push(c));
    const unsubscribe = there.onCampaignChange((c) => seenThere.push(c));

    here.emitCampaignChange({ type: 'deleted', campaignId: 'camp-1' });

    expect(seenHere).toEqual([{ type: 'deleted', campaignId: 'camp-1' }]);
    await vi.waitFor(() => expect(seenThere).toEqual([{ type: 'deleted', campaignId: 'camp-1' }]));

    unsubscribe();
    there.emitCampaignChange({ type: 'replaced', campaignId: 'camp-2' });
    await vi.waitFor(() => expect(seenHere).toHaveLength(2));
    expect(seenHere[1]).toEqual({ type: 'replaced', campaignId: 'camp-2' });
    expect(seenThere).toHaveLength(1);
  });

  it('ignores malformed messages from other tabs', async () => {
    const here = await openTab();
    const seen: CampaignChange[] = [];
    here.onCampaignChange((c) => seen.push(c));
    const stranger = new BroadcastChannel('solo-dm:campaign-changes');
    stranger.postMessage({ type: 'exploded', campaignId: 'camp-1' });
    stranger.postMessage('not even an object');
    stranger.postMessage({ type: 'deleted', campaignId: 'camp-3' });
    await vi.waitFor(() => expect(seen).toEqual([{ type: 'deleted', campaignId: 'camp-3' }]));
    stranger.close();
  });
});
