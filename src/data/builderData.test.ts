/**
 * Merged builder data (spec §5.1, D28): cached per rules-index version, the SRD object itself without
 * imports, SRD-only when the library can't be read, and the pending option counts for the builder hint.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPECTED_MERGED, GLOAMWOOD_SRD_SUBSET, gloamwoodRecords, gloamwoodSnapshot, gloamwoodSource } from '@/test/structuredFixtures';
import type { LibrarySnapshot } from './rulesIndexStore';

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn<() => Promise<LibrarySnapshot>>(),
  indexState: { index: null as object | null, loading: false, error: null as string | null },
  listLibrarySources: vi.fn(),
  listRecords: vi.fn(),
}));
vi.mock('./srd', () => ({ loadSrdBuilderData: async () => GLOAMWOOD_SRD_SUBSET }));
vi.mock('./rulesIndexStore', () => ({ getLibrarySnapshot: mocks.snapshot, useRulesIndexState: () => mocks.indexState }));
vi.mock('@/storage', () => ({ listLibrarySources: mocks.listLibrarySources, listRecords: mocks.listRecords }));

const { countUnreviewedOptions, getBuilderProblems, loadBuilderData, resetBuilderData, useBuilderData } = await import('./builderData');

const empty = (version: number): LibrarySnapshot => ({ version, sources: [], entriesById: new Map(), accepted: [] });

beforeEach(() => {
  resetBuilderData();
  mocks.snapshot.mockReset();
  mocks.indexState = { index: null, loading: false, error: null };
});

describe('loadBuilderData', () => {
  it('is the SRD object itself without imports', async () => {
    mocks.snapshot.mockResolvedValue(empty(1));
    expect(await loadBuilderData()).toBe(GLOAMWOOD_SRD_SUBSET);
  });

  it('merges the accepted options once per version', async () => {
    mocks.snapshot.mockResolvedValue(gloamwoodSnapshot('gloam', 4));
    const first = await loadBuilderData();
    expect(first).toEqual(EXPECTED_MERGED);
    expect(await loadBuilderData()).toBe(first);
    expect(getBuilderProblems()).toEqual([]);
    mocks.snapshot.mockResolvedValue(gloamwoodSnapshot('gloam', 5));
    const next = await loadBuilderData();
    expect(next).not.toBe(first);
    expect(next).toEqual(first);
  });

  it('records merge problems for the book page', async () => {
    const snap = gloamwoodSnapshot('gloam', 7);
    mocks.snapshot.mockResolvedValue({ ...snap, accepted: snap.accepted.filter((r) => r.name !== 'Wickwright') });
    await loadBuilderData();
    expect(getBuilderProblems().map((p) => p.name)).toEqual(['Order of the Long Wick']);
  });

  it('falls back to the SRD when the library cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.snapshot.mockRejectedValue(new Error('IndexedDB is unavailable'));
    expect(await loadBuilderData()).toBe(GLOAMWOOD_SRD_SUBSET);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('IndexedDB is unavailable'));
    warn.mockRestore();
  });
});

describe('useBuilderData', () => {
  it('loads, then follows the rules-index version while keeping the previous data', async () => {
    mocks.snapshot.mockResolvedValue(empty(1));
    const { result, rerender } = renderHook(() => useBuilderData());
    expect(result.current).toEqual({ data: null, error: null, loading: true });
    await waitFor(() => expect(result.current.data).toBe(GLOAMWOOD_SRD_SUBSET));
    expect(result.current.loading).toBe(false);
    // The player accepts the book: the index is invalidated and rebuilt.
    mocks.snapshot.mockResolvedValue(gloamwoodSnapshot('gloam', 2));
    mocks.indexState = { index: null, loading: true, error: null };
    rerender();
    expect(result.current.data).toBe(GLOAMWOOD_SRD_SUBSET);
    await waitFor(() => expect(result.current.data).toEqual(EXPECTED_MERGED));
    const merged = result.current.data;
    await act(async () => {
      mocks.indexState = { index: {}, loading: false, error: null };
      rerender();
    });
    expect(result.current.data).toBe(merged);
  });
});

describe('countUnreviewedOptions', () => {
  it('counts pending option records with data, per book and kind', async () => {
    mocks.listLibrarySources.mockResolvedValue([gloamwoodSource(), gloamwoodSource('off', 'md', { enabled: false })]);
    mocks.listRecords.mockImplementation(async (sourceId: string) => (sourceId === 'gloam' ? gloamwoodRecords() : []));
    const counts = await countUnreviewedOptions();
    expect(counts).toEqual([
      { sourceId: 'gloam', title: 'The Gloamwood Almanac', kind: 'class', count: 1 },
      { sourceId: 'gloam', title: 'The Gloamwood Almanac', kind: 'subclass', count: 3 },
      { sourceId: 'gloam', title: 'The Gloamwood Almanac', kind: 'species', count: 2 },
      { sourceId: 'gloam', title: 'The Gloamwood Almanac', kind: 'background', count: 2 },
      { sourceId: 'gloam', title: 'The Gloamwood Almanac', kind: 'feat', count: 4 },
    ]);
    expect(mocks.listRecords).toHaveBeenCalledWith('gloam', { status: 'pending' });
  });
});
