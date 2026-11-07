import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { sampleSettings } from '@/test/fixtures';
import {
  createCampaign,
  deleteCampaign,
  putHomebrew,
  requestPersistentStorage,
  saveLibrarySource,
  setLibrarySourceEnabled,
  useCampaignList,
  useHomebrewList,
  useLibrarySources,
} from '@/storage';
import { resetDatabase, seedCampaign, sharedHomebrew } from './testData';

beforeEach(resetDatabase);

describe('live hooks', () => {
  it('useCampaignList is undefined while loading, then follows changes', async () => {
    const { result } = renderHook(() => useCampaignList());
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toEqual([]));

    const c = await createCampaign({ name: 'Fresh', premise: '', settings: sampleSettings() });
    await waitFor(() => expect(result.current?.map((s) => s.campaign.name)).toEqual(['Fresh']));

    await deleteCampaign(c.id);
    await waitFor(() => expect(result.current).toEqual([]));
  });

  it('useHomebrewList follows the campaign scope', async () => {
    await seedCampaign('a');
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useHomebrewList(id), {
      initialProps: { id: 'a-camp' as string | null },
    });
    await waitFor(() => expect(result.current?.map((h) => h.name)).toEqual(['Fireblade']));

    await putHomebrew(sharedHomebrew());
    await waitFor(() => expect(result.current?.map((h) => h.name)).toEqual(['Fireblade', 'Lantern Oil']));

    rerender({ id: null });
    await waitFor(() => expect(result.current?.map((h) => h.name)).toEqual(['Lantern Oil']));
  });

  it('useLibrarySources follows saves and toggles', async () => {
    const { result } = renderHook(() => useLibrarySources());
    await waitFor(() => expect(result.current).toEqual([]));
    await saveLibrarySource(
      { id: 'notes', title: 'Notes', kind: 'import', enabled: true, entryCount: 0, createdAt: 1, updatedAt: 1 },
      [],
    );
    await waitFor(() => expect(result.current?.[0]).toMatchObject({ id: 'notes', enabled: true }));
    await setLibrarySourceEnabled('notes', false);
    await waitFor(() => expect(result.current?.[0].enabled).toBe(false));
  });
});

describe('requestPersistentStorage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks the browser to persist, and copes without the API', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('navigator', { storage: { persisted: vi.fn().mockResolvedValue(false), persist } });
    expect(await requestPersistentStorage()).toBe(true);
    expect(persist).toHaveBeenCalledOnce();

    vi.stubGlobal('navigator', { storage: { persisted: vi.fn().mockResolvedValue(true), persist } });
    expect(await requestPersistentStorage()).toBe(true);
    expect(persist).toHaveBeenCalledOnce();

    vi.stubGlobal('navigator', {});
    expect(await requestPersistentStorage()).toBe(false);
  });
});
