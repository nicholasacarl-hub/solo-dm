import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { loadSrdBuilderData, loadSrdCompendium, loadSrdManifest, resetSrdCache, srdUrl } from './srd';

const BUILDER = { classes: [{ id: 'srd:class:wizard', name: 'Wizard' }], species: [], backgrounds: [], feats: [], equipment: [] };
const ENTRY = { id: 'srd:spell:light', sourceId: 'srd-5.2.1', sourceName: 'SRD 5.2.1', kind: 'spell', name: 'Light', text: 'Glow.' };

function respond(body: unknown, init: { status?: number; raw?: string } = {}) {
  return new Response(init.raw ?? JSON.stringify(body), { status: init.status ?? 200, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetSrdCache();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('SRD loaders', () => {
  it('fetches from the app base URL', () => {
    expect(srdUrl('builder.json')).toBe('/srd/builder.json');
    vi.stubEnv('BASE_URL', '/solo-dm/');
    expect(srdUrl('compendium.json')).toBe('/solo-dm/srd/compendium.json');
  });

  it('loads each file once and caches it', async () => {
    fetchMock.mockImplementation(async () => respond(BUILDER));
    const [a, b] = await Promise.all([loadSrdBuilderData(), loadSrdBuilderData()]);
    expect(a).toBe(b);
    expect(a.classes[0].name).toBe('Wizard');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/srd/builder.json');
  });

  it('explains HTTP failures and retries on the next call', async () => {
    fetchMock.mockResolvedValueOnce(respond(null, { status: 404 }));
    await expect(loadSrdBuilderData()).rejects.toThrow("Couldn't load the SRD rules (builder.json): the server answered 404.");
    fetchMock.mockResolvedValueOnce(respond(BUILDER));
    await expect(loadSrdBuilderData()).resolves.toMatchObject({ classes: [{ name: 'Wizard' }] });
  });

  it('explains network failures, damaged JSON and the wrong shape', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(loadSrdCompendium()).rejects.toThrow(/Failed to fetch\. Check your connection/);
    fetchMock.mockResolvedValueOnce(respond(null, { raw: '{"oops' }));
    await expect(loadSrdCompendium()).rejects.toThrow(/damaged \(it isn't valid JSON\)/);
    fetchMock.mockResolvedValueOnce(respond({ entries: [] }));
    await expect(loadSrdCompendium()).rejects.toThrow(/expected a list of entries/);
    fetchMock.mockResolvedValueOnce(respond({ classes: [] }));
    await expect(loadSrdBuilderData()).rejects.toThrow(/builder\.json is damaged/);
    fetchMock.mockResolvedValueOnce(respond({ counts: {} }));
    await expect(loadSrdManifest()).rejects.toThrow(/manifest\.json is damaged/);
  });

  it('skips malformed compendium entries with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(respond([ENTRY, { ...ENTRY, id: 'bad', kind: 'nonsense' }, { name: 'no id' }]));
    await expect(loadSrdCompendium()).resolves.toEqual([ENTRY]);
    expect(warn).toHaveBeenCalledWith('SRD compendium: skipped 2 malformed entries.');
  });
});

describe('useBuilderData', () => {
  it('reports loading, then the data; later mounts get it immediately', async () => {
    vi.resetModules();
    const { useBuilderData } = await import('./builderData');
    fetchMock.mockImplementation(async () => respond(BUILDER));
    const first = renderHook(() => useBuilderData());
    expect(first.result.current).toEqual({ data: null, error: null, loading: true });
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.data?.classes[0].name).toBe('Wizard');
    const second = renderHook(() => useBuilderData());
    expect(second.result.current.loading).toBe(false);
    expect(second.result.current.data).toBe(first.result.current.data);
  });

  it('reports errors', async () => {
    vi.resetModules();
    const { useBuilderData } = await import('./builderData');
    fetchMock.mockResolvedValue(respond(null, { status: 500 }));
    const { result } = renderHook(() => useBuilderData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toEqual({ data: null, error: "Couldn't load the SRD rules (builder.json): the server answered 500.", loading: false });
  });
});
