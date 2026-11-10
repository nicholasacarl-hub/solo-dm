import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ImageLogEntry, LogEntry, StoredImage } from '@/types';
import {
  IMAGE_CAMPAIGN_MISSING,
  deleteCampaign,
  deleteImage,
  duplicateCampaign,
  exportCampaignBundle,
  getCampaign,
  getImage,
  getImageStats,
  importCampaignBundle,
  listImages,
  markImageLogEntry,
  parseCampaignBundle,
  saveImage,
  useImageList,
  useImageUrl,
  useImageUrlState,
} from '@/storage';
import Dexie from 'dexie';
import { sampleCampaign } from '@/test/fixtures';
import { db } from './db';
import { serializeBundle } from './backup';
import { resetDatabase, seedCampaign } from './testData';

const PROMPT = 'Painterly fantasy. A lighthouse on a black cliff, its lantern burning green.';

function picture(bytes: number[], type = 'image/webp'): Blob {
  return new Blob([new Uint8Array(bytes)], { type });
}

function storedImage(overrides: Partial<StoredImage> = {}): StoredImage {
  return {
    id: 'img-1',
    campaignId: 'a-camp',
    sessionId: 'a-sess-2',
    title: 'The lighthouse',
    subject: 'scene',
    prompt: PROMPT,
    model: 'gpt-image-2.5-flare',
    mime: 'image/webp',
    blob: picture([1, 2, 3, 4]),
    createdAt: 1_700_000_100_000,
    ...overrides,
  };
}

function imageEntry(overrides: Partial<ImageLogEntry> = {}): ImageLogEntry {
  return {
    id: 'a-log-img',
    campaignId: 'a-camp',
    sessionId: 'a-sess-2',
    seq: 100,
    createdAt: 1_700_000_100_000,
    kind: 'image',
    imageId: 'img-1',
    title: 'The lighthouse',
    subject: 'scene',
    status: 'ready',
    ...overrides,
  };
}

async function bytesOf(blob: Blob): Promise<number[]> {
  return [...new Uint8Array(await blob.arrayBuffer())];
}

beforeEach(resetDatabase);

describe('image storage', () => {
  it('saves a picture and reads it back; lists metadata only, newest first', async () => {
    await seedCampaign('a');
    await saveImage(storedImage({ id: 'old', createdAt: 10 }));
    await saveImage(storedImage({ id: 'new', createdAt: 20, blob: picture([9, 8], 'image/jpeg'), mime: 'image/jpeg' }));

    const back = await getImage('new');
    expect(back).toMatchObject({ id: 'new', campaignId: 'a-camp', mime: 'image/jpeg', prompt: PROMPT, createdAt: 20 });
    expect(back?.blob.type).toBe('image/jpeg');
    expect(await bytesOf(back!.blob)).toEqual([9, 8]);

    const listed = await listImages('a-camp');
    expect(listed.map((i) => i.id)).toEqual(['new', 'old']);
    expect(listed[0]).not.toHaveProperty('blob');
    expect(listed[0]).not.toHaveProperty('size');
    expect(await listImages('other-camp')).toEqual([]);
    expect(await getImage('nope')).toBeUndefined();
  });

  it('refuses a picture for a campaign that no longer exists (no orphans)', async () => {
    await expect(saveImage(storedImage({ campaignId: 'gone' }))).rejects.toThrow(IMAGE_CAMPAIGN_MISSING);
    expect(await db.images.count()).toBe(0);
    expect(await db.imageData.count()).toBe(0);
  });

  it('deletes a picture with its bytes', async () => {
    await seedCampaign('a');
    await saveImage(storedImage());
    await deleteImage('img-1');
    expect(await getImage('img-1')).toBeUndefined();
    expect(await db.imageData.count()).toBe(0);
  });

  it('counts pictures and their size per campaign', async () => {
    await seedCampaign('a');
    await seedCampaign('b');
    await saveImage(storedImage({ id: 'a1', blob: picture([1, 2, 3]) }));
    await saveImage(storedImage({ id: 'a2', blob: picture([1]) }));
    await saveImage(storedImage({ id: 'b1', campaignId: 'b-camp', blob: picture([1, 2]) }));
    expect(await getImageStats()).toEqual({
      count: 3,
      bytes: 6,
      byCampaign: { 'a-camp': { count: 2, bytes: 4 }, 'b-camp': { count: 1, bytes: 2 } },
    });
  });
});

describe('deleting a campaign', () => {
  it('deletes its pictures and leaves other campaigns’ pictures alone', async () => {
    await seedCampaign('a');
    await seedCampaign('b');
    await saveImage(storedImage({ id: 'a1' }));
    await saveImage(storedImage({ id: 'b1', campaignId: 'b-camp' }));

    await deleteCampaign('a-camp');

    expect(await getImage('a1')).toBeUndefined();
    expect(await db.imageData.get('a1')).toBeUndefined();
    expect(await getImage('b1')).toBeDefined();
  });
});

describe('save files and pictures', () => {
  it('exports the story’s image entries but never the pictures or their prompts', async () => {
    await seedCampaign('a');
    await db.log.put(imageEntry());
    await saveImage(storedImage({ blob: picture([0xde, 0xad, 0xbe, 0xef]) }));

    const bundle = await exportCampaignBundle('a-camp');
    const text = serializeBundle(bundle);

    expect(Object.keys(bundle)).not.toContain('images');
    expect(text).not.toContain(PROMPT);
    expect(text).not.toContain('gpt-image-2.5-flare');
    expect(text).not.toContain(btoa(String.fromCharCode(0xde, 0xad, 0xbe, 0xef)));
    expect(bundle.log.find((e) => e.kind === 'image')).toMatchObject({ imageId: 'img-1', title: 'The lighthouse' });
  });

  it('imports image entries; a picture that was still being painted can never finish, so it reads as failed', () => {
    const bundle = parseCampaignBundle({
      format: 'solo-dm-campaign',
      version: 1,
      campaign: { id: 'c', name: 'C', settings: {}, createdAt: 1, updatedAt: 1 },
      log: [
        imageEntry({ id: 'ready', imageId: 'i1', seq: 1 }),
        imageEntry({ id: 'pending', imageId: 'i2', seq: 2, status: 'pending' }),
        { ...imageEntry({ id: 'odd', imageId: 'i3', seq: 3 }), subject: 'map', status: 'weird' },
        { id: 'no-picture', seq: 4, kind: 'image', createdAt: 1, title: 'Lost' },
        { id: 'future', seq: 5, kind: 'hologram', createdAt: 1, text: 'from a newer app' },
      ],
    });
    expect(bundle.log.map((e) => e.id)).toEqual(['ready', 'pending', 'odd']);
    expect(bundle.log[0]).toMatchObject({ status: 'ready' });
    expect(bundle.log[1]).toMatchObject({ status: 'failed', error: expect.stringMatching(/wasn’t finished/) });
    expect(bundle.log[2]).toMatchObject({ subject: 'scene', status: 'failed' });
  });

  it('a campaign replaced by an import keeps its pictures', async () => {
    await seedCampaign('a');
    await db.log.put(imageEntry());
    await saveImage(storedImage());
    const bundle = await exportCampaignBundle('a-camp');

    await importCampaignBundle(bundle, 'replace');

    expect(await getImage('img-1')).toBeDefined();
    expect((await db.log.get('a-log-img')) as LogEntry).toMatchObject({ kind: 'image', imageId: 'img-1' });
  });

  it('an import as a copy brings along the pictures its story shows, under its own ids', async () => {
    await seedCampaign('a');
    await db.log.put(imageEntry());
    await saveImage(storedImage());
    await saveImage(storedImage({ id: 'gallery-only', createdAt: 5 }));
    const bundle = await exportCampaignBundle('a-camp');

    const copy = await importCampaignBundle(bundle, 'copy');

    const entry = (await db.log.where('campaignId').equals(copy.id).toArray()).find((e) => e.kind === 'image');
    expect(entry?.kind).toBe('image');
    const copiedId = (entry as ImageLogEntry).imageId;
    expect(copiedId).not.toBe('img-1');
    expect(await getImage(copiedId)).toMatchObject({ campaignId: copy.id, title: 'The lighthouse' });
    expect((await listImages(copy.id)).map((i) => i.id)).toEqual([copiedId]);
  });
});

describe('duplicating a campaign', () => {
  it('copies every picture under new ids and points the copy’s story at them', async () => {
    await seedCampaign('a');
    await db.log.put(imageEntry());
    await saveImage(storedImage({ blob: picture([7, 7, 7]) }));
    await saveImage(storedImage({ id: 'portrait', subject: 'character', title: 'Mira', createdAt: 5 }));

    const copy = await duplicateCampaign('a-camp');
    const copies = await listImages(copy.id);

    expect(copies).toHaveLength(2);
    expect(copies.map((i) => i.id)).not.toContain('img-1');
    const entry = (await db.log.where('campaignId').equals(copy.id).toArray()).find((e) => e.kind === 'image') as ImageLogEntry;
    const copied = await getImage(entry.imageId);
    expect(copied).toMatchObject({ campaignId: copy.id, title: 'The lighthouse' });
    expect(await bytesOf(copied!.blob)).toEqual([7, 7, 7]);

    // Deleting the original leaves the copy whole.
    await deleteCampaign('a-camp');
    expect(await listImages(copy.id)).toHaveLength(2);
    expect(await getImage(entry.imageId)).toBeDefined();
  });
});

describe('markImageLogEntry', () => {
  it('marks a stored entry ready or failed and bumps the campaign so cloud sync notices', async () => {
    await seedCampaign('a');
    await db.log.put(imageEntry({ status: 'pending' }));
    const before = (await getCampaign('a-camp'))!.updatedAt;

    expect(await markImageLogEntry('a-log-img', { status: 'failed', error: 'The image service declined this picture.' })).toBe(true);
    expect(await db.log.get('a-log-img')).toMatchObject({ status: 'failed', error: 'The image service declined this picture.' });
    expect((await getCampaign('a-camp'))!.updatedAt).toBeGreaterThan(before);

    expect(await markImageLogEntry('a-log-img', { status: 'ready' })).toBe(true);
    const ready = await db.log.get('a-log-img');
    expect(ready).toMatchObject({ status: 'ready' });
    expect(ready).not.toHaveProperty('error');
  });

  it('does nothing for entries that are gone or are not pictures', async () => {
    await seedCampaign('a');
    expect(await markImageLogEntry('missing', { status: 'ready' })).toBe(false);
    const [first] = await db.log.toArray();
    expect(await markImageLogEntry(first.id, { status: 'ready' })).toBe(false);
    expect(await db.log.get(first.id)).toEqual(first);
  });
});

describe('image hooks', () => {
  beforeEach(() => {
    let n = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test-${++n}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('useImageList follows saves and deletes, newest first', async () => {
    await seedCampaign('a');
    const { result } = renderHook(() => useImageList('a-camp'));
    await waitFor(() => expect(result.current).toEqual([]));
    await saveImage(storedImage({ id: 'one', createdAt: 1 }));
    await saveImage(storedImage({ id: 'two', createdAt: 2 }));
    await waitFor(() => expect(result.current?.map((i) => i.id)).toEqual(['two', 'one']));
    await deleteImage('two');
    await waitFor(() => expect(result.current?.map((i) => i.id)).toEqual(['one']));
  });

  it('useImageList is empty without a campaign', async () => {
    const { result } = renderHook(() => useImageList(null));
    await waitFor(() => expect(result.current).toEqual([]));
  });

  it('useImageUrlState tells a missing picture from one still loading, and shows it as soon as it lands', async () => {
    await seedCampaign('a');
    const { result, unmount } = renderHook(() => useImageUrlState('img-1'));
    expect(result.current).toEqual({ status: 'loading' });
    await waitFor(() => expect(result.current).toEqual({ status: 'missing' }));

    await act(() => saveImage(storedImage()));
    await waitFor(() => expect(result.current).toEqual({ status: 'ready', url: 'blob:test-1' }));
    const made = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(made.type).toBe('image/webp');

    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-1');
  });

  it('useImageUrl gives the object URL or null, and revokes the old one when the image changes', async () => {
    await seedCampaign('a');
    await saveImage(storedImage({ id: 'x' }));
    await saveImage(storedImage({ id: 'y' }));
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useImageUrl(id), { initialProps: { id: 'x' as string | null } });
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe('blob:test-1'));

    rerender({ id: 'y' });
    await waitFor(() => expect(result.current).toBe('blob:test-2'));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-1');

    rerender({ id: null });
    await waitFor(() => expect(result.current).toBeNull());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-2');
  });
});

/** The schema as version 1 shipped it. */
const V1_STORES = {
  campaigns: 'id, updatedAt, lastPlayedAt',
  characters: 'id, campaignId',
  sessions: 'id, campaignId, [campaignId+number]',
  transcript: 'id, sessionId, [sessionId+seq]',
  log: 'id, campaignId, [campaignId+seq]',
  combat: 'campaignId',
  journal: 'id, campaignId, [campaignId+kind]',
  quests: 'id, campaignId',
  clocks: 'id, campaignId',
  homebrew: 'id, campaignId, kind',
  library: 'id',
  libraryEntries: 'id, sourceId, kind',
};
/** The tables version 2 added (illustrations). */
const V2_STORES = {
  images: 'id, campaignId, createdAt, [campaignId+createdAt]',
  imageData: 'id, campaignId',
};

describe('upgrading a database from before illustrations', () => {
  it('keeps every save and adds the picture tables', async () => {
    db.close();
    await Dexie.delete('solo-dm');
    const v1 = new Dexie('solo-dm');
    v1.version(1).stores(V1_STORES);
    await v1.table('campaigns').put(sampleCampaign({ id: 'old-camp' }));
    v1.close();

    await db.open();

    expect(db.verno).toBe(4);
    expect(await getCampaign('old-camp')).toMatchObject({ id: 'old-camp' });
    await saveImage(storedImage({ campaignId: 'old-camp' }));
    expect((await listImages('old-camp')).map((i) => i.id)).toEqual(['img-1']);
  });
});

describe('upgrading a database from before structured imports (version 2 → 3)', () => {
  it('keeps saves, pictures and the library intact and adds the record and job tables', async () => {
    db.close();
    await Dexie.delete('solo-dm');
    const v2 = new Dexie('solo-dm');
    v2.version(1).stores(V1_STORES);
    v2.version(2).stores(V2_STORES);
    const library = { id: 'gloam', title: 'The Gloamwood Almanac', kind: 'import', enabled: true, entryCount: 1, createdAt: 1, updatedAt: 1 };
    const entry = { id: 'lib:gloam:1', sourceId: 'gloam', sourceName: 'The Gloamwood Almanac', kind: 'rule', name: 'The Long Dusk', text: 'Lanterns on every branch.' };
    await v2.table('campaigns').put(sampleCampaign({ id: 'old-camp' }));
    await v2.table('library').put(library);
    await v2.table('libraryEntries').put(entry);
    await v2.table('images').put({ ...storedImage({ campaignId: 'old-camp' }), blob: undefined, size: 3 });
    v2.close();

    await db.open();

    expect(db.verno).toBe(4);
    expect(await getCampaign('old-camp')).toMatchObject({ id: 'old-camp' });
    expect(await db.library.get('gloam')).toEqual(library);
    expect(await db.libraryEntries.get('lib:gloam:1')).toEqual(entry);
    expect(await db.images.count()).toBe(1);
    expect(await db.libraryRecords.count()).toBe(0);
    expect(await db.libraryJobs.count()).toBe(0);
    // The new indexes work.
    await db.libraryRecords.put({ id: 'rec:gloam:spell:x', sourceId: 'gloam', kind: 'spell', status: 'pending', jobId: 'job:1', runState: 'queued' } as never);
    expect(await db.libraryRecords.where('[sourceId+status]').equals(['gloam', 'pending']).count()).toBe(1);
    expect(await db.libraryRecords.where('[jobId+runState]').equals(['job:1', 'queued']).count()).toBe(1);
  });
});
