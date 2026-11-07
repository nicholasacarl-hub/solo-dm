import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleCampaign } from '@/test/fixtures';
import type { HomebrewEntry } from '@/types';
import type { CampaignSummary } from '@/storage';

vi.mock('@/data', () => ({ invalidateRulesIndex: vi.fn() }));
vi.mock('@/storage', () => ({
  listCampaigns: vi.fn(),
  putHomebrew: vi.fn(),
  deleteHomebrewRecord: vi.fn(),
}));
const game = {
  campaignId: null as string | null,
  saveHomebrew: vi.fn(),
  deleteHomebrew: vi.fn(),
};
vi.mock('@/state/gameStore', () => ({
  useGame: { getState: () => game },
  queueCampaignNotice: vi.fn(),
}));

const storage = await import('@/storage');
const { queueCampaignNotice } = await import('@/state/gameStore');
const { deleteHomebrewEntry, homebrewNotice, saveHomebrewEntry } = await import('./homebrewActions');

function slot(id: string, activeSessionId: string | null): CampaignSummary {
  return { campaign: sampleCampaign({ id, name: id, activeSessionId }), character: null, level: 0 };
}

function boon(overrides: Partial<HomebrewEntry> = {}): HomebrewEntry {
  return {
    id: 'hb:tidecaller',
    sourceId: 'homebrew',
    sourceName: 'Homebrew',
    kind: 'boon',
    name: 'Tidecaller’s Boon',
    text: 'Once per day, command the tide.',
    origin: 'dm',
    status: 'active',
    campaignId: 'camp-sea',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const noticedCampaigns = () => vi.mocked(queueCampaignNotice).mock.calls.map(([id]) => id).sort();

describe('Library homebrew changes reach the DM', () => {
  beforeEach(() => {
    game.campaignId = null;
    game.saveHomebrew.mockReset().mockResolvedValue(undefined);
    game.deleteHomebrew.mockReset().mockResolvedValue(undefined);
    vi.mocked(storage.putHomebrew).mockReset().mockResolvedValue();
    vi.mocked(storage.deleteHomebrewRecord).mockReset().mockResolvedValue();
    vi.mocked(queueCampaignNotice).mockReset().mockResolvedValue();
    vi.mocked(storage.listCampaigns)
      .mockReset()
      .mockResolvedValue([slot('camp-sea', 'sess-1'), slot('camp-moor', 'sess-7'), slot('camp-new', null)]);
  });

  it('queues a notice on the owning campaign even though no campaign is loaded', async () => {
    const edited = boon({ text: 'Once per long rest, command the tide.' });
    await saveHomebrewEntry(edited, 'edited', boon());

    expect(storage.putHomebrew).toHaveBeenCalledWith(edited);
    expect(game.saveHomebrew).not.toHaveBeenCalled();
    expect(queueCampaignNotice).toHaveBeenCalledTimes(1);
    expect(queueCampaignNotice).toHaveBeenCalledWith('camp-sea', homebrewNotice(edited, 'edited'));
  });

  it('tells every campaign with a session in progress about shared homebrew', async () => {
    const shared = boon({ campaignId: null, status: 'retired' });
    await saveHomebrewEntry(shared, 'retired', boon({ campaignId: null }));
    expect(noticedCampaigns()).toEqual(['camp-moor', 'camp-sea']);
  });

  it('skips campaigns between sessions (their next prompt has the current homebrew)', async () => {
    await saveHomebrewEntry(boon({ campaignId: 'camp-new' }), 'created');
    expect(queueCampaignNotice).not.toHaveBeenCalled();
  });

  it('tells both campaigns when an entry moves from one to another', async () => {
    await saveHomebrewEntry(boon({ campaignId: 'camp-moor' }), 'edited', boon({ campaignId: 'camp-sea' }));
    expect(noticedCampaigns()).toEqual(['camp-moor', 'camp-sea']);
  });

  it('goes through the game store when the change touches the loaded campaign', async () => {
    game.campaignId = 'camp-sea';
    const entry = boon();
    await deleteHomebrewEntry(entry);

    expect(game.deleteHomebrew).toHaveBeenCalledWith(entry.id);
    expect(storage.deleteHomebrewRecord).not.toHaveBeenCalled();
    expect(queueCampaignNotice).toHaveBeenCalledWith('camp-sea', homebrewNotice(entry, 'deleted'));
  });

  it('keeps the saved change when the notice cannot be queued', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(queueCampaignNotice).mockRejectedValue(new Error('quota exceeded'));
    await expect(saveHomebrewEntry(boon(), 'edited', boon())).resolves.toBeUndefined();

    vi.mocked(storage.listCampaigns).mockRejectedValue(new Error('database closed'));
    await expect(deleteHomebrewEntry(boon())).resolves.toBeUndefined();

    expect(storage.putHomebrew).toHaveBeenCalledTimes(1);
    expect(storage.deleteHomebrewRecord).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
