import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { CompendiumEntry, HomebrewEntry } from '@/types';

vi.mock('@/storage', () => ({
  getLibraryEntries: vi.fn(),
  listHomebrew: vi.fn(),
}));

import { getLibraryEntries, listHomebrew } from '@/storage';
import { getRulesIndex, invalidateRulesIndex, resetRulesIndex, useRulesIndex, useRulesIndexState } from './rulesIndexStore';
import { resetSrdCache } from './srd';

const SRD: CompendiumEntry[] = [
  { id: 'srd:spell:light', sourceId: 'srd-5.2.1', sourceName: 'SRD 5.2.1', kind: 'spell', name: 'Light', text: 'An object sheds bright light.' },
  { id: 'srd:condition:prone', sourceId: 'srd-5.2.1', sourceName: 'SRD 5.2.1', kind: 'condition', name: 'Prone', text: 'You crawl.' },
];
const IMPORTED: CompendiumEntry = {
  id: 'lib:import-1:1',
  sourceId: 'import-1',
  sourceName: 'My Book',
  kind: 'spell',
  name: 'Moonbeam Lance',
  text: 'A lance of moonlight.',
};
const brew = (name: string): HomebrewEntry => ({
  id: `hb:${name}`,
  sourceId: 'homebrew',
  sourceName: 'Homebrew',
  kind: 'boon',
  name,
  text: `${name}, a gift of the gods.`,
  campaignId: null,
  origin: 'dm',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
});

const getLibrary = vi.mocked(getLibraryEntries);
const getHomebrew = vi.mocked(listHomebrew);
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetSrdCache();
  resetRulesIndex();
  fetchMock = vi.fn(async () => new Response(JSON.stringify(SRD), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  getLibrary.mockResolvedValue([IMPORTED]);
  getHomebrew.mockResolvedValue([brew('Blessing of Dawn')]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getRulesIndex', () => {
  it('indexes the SRD, enabled imports and homebrew', async () => {
    const index = await getRulesIndex();
    expect(fetchMock).toHaveBeenCalledWith('/srd/compendium.json');
    expect(index.findByName('light')?.id).toBe('srd:spell:light');
    expect(index.findByName('Moonbeam Lance')?.sourceId).toBe('import-1');
    expect(index.findByName('Blessing of Dawn')?.kind).toBe('boon');
    expect(getLibrary).toHaveBeenCalledWith();
    expect(getHomebrew).toHaveBeenCalledWith();
  });

  it('builds once and returns the cached index', async () => {
    const [a, b] = await Promise.all([getRulesIndex(), getRulesIndex()]);
    expect(a).toBe(b);
    expect(await getRulesIndex()).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getLibrary).toHaveBeenCalledTimes(1);
  });

  it('indexes the SRD alone when storage is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getLibrary.mockImplementation(() => {
      throw new Error('storage: not implemented');
    });
    getHomebrew.mockRejectedValue(new Error('IndexedDB blocked'));
    const index = await getRulesIndex();
    expect(index.list().map((e) => e.id)).toEqual(['srd:spell:light', 'srd:condition:prone']);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toMatch(/imported library entries \(storage: not implemented\)/);
  });

  it('rebuilds after invalidation without re-fetching the SRD', async () => {
    const before = await getRulesIndex();
    getHomebrew.mockResolvedValue([brew('Blessing of Dawn'), brew('Curse of Rust')]);
    invalidateRulesIndex();
    const after = await getRulesIndex();
    expect(after).not.toBe(before);
    expect(after.findByName('Curse of Rust')).toBeDefined();
    expect(before.findByName('Curse of Rust')).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects with a clear error when the SRD cannot load, then retries', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(getRulesIndex()).rejects.toThrow("Couldn't load the SRD rules (compendium.json): the server answered 503.");
    await expect(getRulesIndex()).resolves.toBeDefined();
  });
});

describe('useRulesIndex', () => {
  it('is null while building, then the index; after invalidation it keeps the old index until the new one is ready', async () => {
    const { result } = renderHook(() => useRulesIndex());
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).not.toBeNull());
    const first = result.current;
    expect(first?.findByName('Curse of Rust')).toBeUndefined();

    getHomebrew.mockResolvedValue([brew('Curse of Rust')]);
    act(() => invalidateRulesIndex());
    expect(result.current).toBe(first);
    await waitFor(() => expect(result.current).not.toBe(first));
    expect(result.current?.findByName('Curse of Rust')).toBeDefined();
  });

  it('exposes loading and error state', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    const { result } = renderHook(() => useRulesIndexState());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.error).toMatch(/answered 404/));
    expect(result.current).toMatchObject({ index: null, loading: false });
  });
});
