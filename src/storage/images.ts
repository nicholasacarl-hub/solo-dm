/**
 * Illustrations: pictures the image model painted for a campaign. They live only on this device
 * (tables "images" and "imageData"), never in save files or GitHub saves: they are far too large.
 * Deleting a campaign deletes its pictures; a duplicate gets copies of them.
 */
import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { ImageLogEntry, LogEntry, StoredImage } from '@/types';
import { db, imageTables, ownerRange, type ImageRecord } from './db';

export type StoredImageMeta = Omit<StoredImage, 'blob'>;

/** A stored picture as an object URL, or why there is none yet. */
export type ImageUrlState = { status: 'loading' } | { status: 'missing' } | { status: 'ready'; url: string };

export interface ImageStats {
  count: number;
  /** Total size of the pictures in bytes. */
  bytes: number;
  byCampaign: Record<string, { count: number; bytes: number }>;
}

export const IMAGE_CAMPAIGN_MISSING = 'That campaign no longer exists, so the picture was not saved.';

/** The fields of an image log entry the painter updates when a picture is ready or has failed. */
export type ImageLogPatch = Partial<Pick<ImageLogEntry, 'status' | 'error'>>;

function metaOf(record: ImageRecord): StoredImageMeta {
  const { size: _size, ...meta } = record;
  return meta;
}

/** A Blob's bytes (FileReader where Blob.arrayBuffer is missing, as in older Safari). */
function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the picture.'));
    reader.readAsArrayBuffer(blob);
  });
}

/** Save a picture for a campaign that exists (an orphan could never be deleted with its campaign). */
export async function saveImage(image: StoredImage): Promise<void> {
  const { blob, ...meta } = image;
  const bytes = await blobBytes(blob);
  await db.transaction('rw', [db.campaigns, ...imageTables()], async () => {
    if (!(await db.campaigns.get(image.campaignId))) throw new Error(IMAGE_CAMPAIGN_MISSING);
    await db.images.put({ ...meta, size: bytes.byteLength });
    await db.imageData.put({ id: image.id, campaignId: image.campaignId, bytes });
  });
}

export function getImage(id: string): Promise<StoredImage | undefined> {
  return db.transaction('r', imageTables(), async () => {
    const [record, data] = await Promise.all([db.images.get(id), db.imageData.get(id)]);
    if (!record || !data) return undefined;
    return { ...metaOf(record), blob: new Blob([data.bytes], { type: record.mime }) };
  });
}

/** A campaign's pictures (metadata only), newest first. */
export async function listImages(campaignId: string): Promise<StoredImageMeta[]> {
  const records = await db.images.where('[campaignId+createdAt]').between(...ownerRange(campaignId)).reverse().toArray();
  return records.map(metaOf);
}

export function deleteImage(id: string): Promise<void> {
  return db.transaction('rw', imageTables(), async () => {
    await Promise.all([db.images.delete(id), db.imageData.delete(id)]);
  });
}

/** Delete every picture of a campaign (joins the caller's transaction when there is one). */
export function deleteCampaignImages(campaignId: string): Promise<void> {
  return db.transaction('rw', imageTables(), async () => {
    await Promise.all([
      db.images.where('campaignId').equals(campaignId).delete(),
      db.imageData.where('campaignId').equals(campaignId).delete(),
    ]);
  });
}

/** How many pictures this device holds and how much space they take, in total and per campaign. */
export async function getImageStats(): Promise<ImageStats> {
  const stats: ImageStats = { count: 0, bytes: 0, byCampaign: {} };
  await db.images.each((record) => {
    const own = (stats.byCampaign[record.campaignId] ??= { count: 0, bytes: 0 });
    own.count += 1;
    own.bytes += record.size;
    stats.count += 1;
    stats.bytes += record.size;
  });
  return stats;
}

// ---------------------------------------------------------------------------
// Copies (duplicated campaigns, imports as a copy)
// ---------------------------------------------------------------------------

function isImageEntry(entry: LogEntry): entry is ImageLogEntry {
  return entry.kind === 'image';
}

/** Ids of the pictures an image log entry refers to, in log order (no repeats). */
export function referencedImageIds(log: readonly LogEntry[]): string[] {
  return [...new Set(log.filter(isImageEntry).map((e) => e.imageId))];
}

/**
 * Copy pictures to another campaign under new ids (`ids` maps old id → new id). Pictures that
 * aren't on this device are skipped. Joins the caller's transaction when there is one.
 */
export function copyImages(ids: ReadonlyMap<string, string>, campaignId: string): Promise<void> {
  return db.transaction('rw', imageTables(), async () => {
    const oldIds = [...ids.keys()];
    const [records, data] = await Promise.all([db.images.bulkGet(oldIds), db.imageData.bulkGet(oldIds)]);
    const copies = oldIds.flatMap((oldId, i) => {
      const record = records[i];
      const bytes = data[i]?.bytes;
      const id = ids.get(oldId);
      return record && bytes && id ? [{ record: { ...record, id, campaignId }, data: { id, campaignId, bytes } }] : [];
    });
    await db.images.bulkPut(copies.map((c) => c.record));
    await db.imageData.bulkPut(copies.map((c) => c.data));
  });
}

/**
 * The pictures a copy needs, each under the id `newId` gives it (the ids the copy's log entries use):
 * whatever the source log refers to, plus the whole gallery of `galleryOf` when given (a duplicated
 * campaign keeps its portraits and every other picture; an imported copy only what its story shows).
 */
export async function imagesToCopy(
  log: readonly LogEntry[],
  newId: (oldId: string) => string,
  galleryOf?: string,
): Promise<Map<string, string>> {
  const gallery = galleryOf ? await db.images.where('campaignId').equals(galleryOf).primaryKeys() : [];
  const ids = new Map<string, string>();
  for (const oldId of [...referencedImageIds(log), ...gallery]) ids.set(oldId, newId(oldId));
  return ids;
}

// ---------------------------------------------------------------------------
// The story log, for pictures finished after the player left the table
// ---------------------------------------------------------------------------

/**
 * Update an image entry of the story log in storage (status / error only) and bump its campaign's
 * updatedAt so cloud sync notices. For pictures that finish while their campaign isn't loaded at the
 * table. Resolves false when the entry or its campaign is gone.
 */
export function markImageLogEntry(entryId: string, patch: ImageLogPatch): Promise<boolean> {
  return db.transaction('rw', [db.log, db.campaigns], async () => {
    const entry = await db.log.get(entryId);
    if (!entry || entry.kind !== 'image') return false;
    const campaign = await db.campaigns.get(entry.campaignId);
    if (!campaign) return false;
    const next: ImageLogEntry = { ...entry, ...patch };
    if (next.status !== 'failed') delete next.error;
    await db.log.put(next);
    await db.campaigns.update(campaign.id, { updatedAt: Math.max(Date.now(), campaign.updatedAt + 1) });
    return true;
  });
}

// ---------------------------------------------------------------------------
// React hooks
// ---------------------------------------------------------------------------

/** Live list of a campaign's pictures (metadata only), newest first; undefined while loading. */
export function useImageList(campaignId: string | null): StoredImageMeta[] | undefined {
  return useLiveQuery(() => (campaignId ? listImages(campaignId) : []), [campaignId]);
}

/** Live picture count and size on this device; undefined while loading. */
export function useImageStats(): ImageStats | undefined {
  return useLiveQuery(getImageStats, []);
}

interface PictureBytes {
  mime: string;
  bytes: ArrayBuffer;
}

/** The picture's bytes: undefined while loading, null when this device doesn't have it. */
function usePictureBytes(imageId: string | null): PictureBytes | null | undefined {
  return useLiveQuery(async () => {
    if (!imageId) return null;
    const [record, data] = await Promise.all([db.images.get(imageId), db.imageData.get(imageId)]);
    return record && data ? { mime: record.mime, bytes: data.bytes } : null;
  }, [imageId]);
}

/**
 * A stored picture as an object URL (revoked when it changes or on unmount). Live: a picture that is
 * saved after mounting (one still being painted) shows up as soon as it lands. 'missing' means this
 * device doesn't have it (deleted, or the story came from a save file made elsewhere).
 */
export function useImageUrlState(imageId: string | null): ImageUrlState {
  const picture = usePictureBytes(imageId);
  const [made, setMade] = useState<{ source: PictureBytes; url: string } | null>(null);
  useEffect(() => {
    if (!picture) return undefined;
    const url = URL.createObjectURL(new Blob([picture.bytes], { type: picture.mime }));
    setMade({ source: picture, url });
    return () => URL.revokeObjectURL(url);
  }, [picture]);
  if (picture === undefined) return { status: 'loading' };
  if (picture === null) return { status: 'missing' };
  return made?.source === picture ? { status: 'ready', url: made.url } : { status: 'loading' };
}

/** An object URL for a stored picture, or null while loading or when this device doesn't have it. */
export function useImageUrl(imageId: string | null): string | null {
  const state = useImageUrlState(imageId);
  return state.status === 'ready' ? state.url : null;
}
