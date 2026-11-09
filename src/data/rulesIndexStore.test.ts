import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { CompendiumEntry, HomebrewEntry, LibrarySource, StructuredRecord } from '@/types';

vi.mock('@/storage', () => ({
  getAcceptedRecords: vi.fn(),
  getLibraryEntries: vi.fn(),
  listHomebrew: vi.fn(),
  listLibrarySources: vi.fn(),
}));

import { getAcceptedRecords, getLibraryEntries, listHomebrew, listLibrarySources } from '@/storage';
import { gloamwoodEntries, gloamwoodEntryId, gloamwoodRecords, gloamwoodSource } from '@/test/structuredFixtures';
import { getLibrarySnapshot, getRulesIndex, invalidateRulesIndex, resetRulesIndex, useRulesIndex, useRulesIndexState } from './rulesIndexStore';
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

const SOURCE: LibrarySource = { id: 'import-1', title: 'My Book', kind: 'import', enabled: true, entryCount: 1, createdAt: 1, updatedAt: 1 };

const getLibrary = vi.mocked(getLibraryEntries);
const getHomebrew = vi.mocked(listHomebrew);
const getSources = vi.mocked(listLibrarySources);
const getAccepted = vi.mocked(getAcceptedRecords);
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetSrdCache();
  resetRulesIndex();
  fetchMock = vi.fn(async () => new Response(JSON.stringify(SRD), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  getLibrary.mockResolvedValue([IMPORTED]);
  getHomebrew.mockResolvedValue([brew('Blessing of Dawn')]);
  getSources.mockResolvedValue([SOURCE, { ...SOURCE, id: 'off', enabled: false }, { ...SOURCE, id: 'srd-5.2.1', kind: 'builtin' }]);
  getAccepted.mockResolvedValue([]);
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
    // Only switched-on imports are read.
    expect(getLibrary).toHaveBeenCalledWith(['import-1']);
    expect(getAccepted).toHaveBeenCalledWith(['import-1']);
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
    getSources.mockImplementation(() => {
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

describe('getLibrarySnapshot (spec §5.1)', () => {
  const book = gloamwoodSource();
  const entries = gloamwoodEntries();
  // IndexedDB returns "lib:gloam:10" before "lib:gloam:2": the snapshot puts them back in reading order.
  const stringOrder = [...entries].sort((a, b) => (a.id < b.id ? -1 : 1));
  const accepted = gloamwoodRecords('gloam', { status: 'accepted' }).filter((r) => r.data !== null);

  beforeEach(() => {
    getSources.mockResolvedValue([book, { ...book, id: 'off', enabled: false }]);
    getLibrary.mockResolvedValue(stringOrder);
    getAccepted.mockResolvedValue(accepted);
  });

  it('holds the switched-on imports, their entries in reading order and their valid accepted records', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const drake = accepted.find((r) => r.name === 'Glimmerwing Drake') as StructuredRecord;
    const broken = { ...drake, id: 'rec:gloam:monster:broken', data: { ...(drake.data as object), hp: -3 } } as StructuredRecord;
    getAccepted.mockResolvedValue([...accepted, broken, { ...drake, id: 'rec:gloam:monster:future', schemaVersion: 2 }]);
    const snap = await getLibrarySnapshot();
    expect(snap.sources.map((s) => s.id)).toEqual(['gloam']);
    expect([...snap.entriesById.keys()]).toEqual(entries.map((e) => e.id));
    expect(snap.accepted.map((r) => r.id)).toEqual(accepted.map((r) => r.id));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/2 accepted structured record\(s\) failed validation/));
  });

  it('is read once per index version and again after invalidation', async () => {
    const a = await getLibrarySnapshot();
    expect(await getLibrarySnapshot()).toBe(a);
    await getRulesIndex();
    expect(getAccepted).toHaveBeenCalledTimes(1);
    invalidateRulesIndex();
    const b = await getLibrarySnapshot();
    expect(b).not.toBe(a);
    expect(b.version).toBeGreaterThan(a.version);
    expect(getAccepted).toHaveBeenCalledTimes(2);
  });

  it('is empty when no import is switched on (the index is then exactly the SRD and homebrew)', async () => {
    getSources.mockResolvedValue([{ ...book, enabled: false }]);
    const snap = await getLibrarySnapshot();
    expect(snap).toMatchObject({ sources: [], accepted: [] });
    expect(snap.entriesById.size).toBe(0);
    expect(getLibrary).not.toHaveBeenCalled();
    expect((await getRulesIndex()).list().map((e) => e.id)).toEqual(['srd:spell:light', 'srd:condition:prone', 'hb:Blessing of Dawn']);
  });

  it('builds the index from the materialized entries', async () => {
    const index = await getRulesIndex();
    const drake = index.findByName('Glimmerwing Drake', { kind: 'monster' });
    expect(drake).toMatchObject({ id: gloamwoodEntryId('Glimmerwing Drake'), data: { size: 'Large', reachFt: 10 } });
    expect(index.get('lib:gloam:species:mothkin')?.name).toBe('Mothkin');
    // The chunk the species replaced still resolves, to the materialized entry.
    expect(index.get(gloamwoodEntryId('Mothkin Lineages'))?.id).toBe('lib:gloam:species:mothkin');
    // The unreviewed Goblin Warrior stays a thin raw chunk.
    expect(index.findByName('Goblin Warrior', { kind: 'monster' })?.data).toEqual({ cr: '1/4' });
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
