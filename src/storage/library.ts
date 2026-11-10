/**
 * Homebrew and the player's imported library. Imported sourcebook text stays in this browser:
 * nothing here is ever exported in a campaign bundle or synced. Characters keep provenance for book
 * text they copy; exports replace that text (redact.ts).
 */
import { useLiveQuery } from 'dexie-react-hooks';
import type { CompendiumEntry, HomebrewEntry, LibrarySource } from '@/types';
import { db } from './db';

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/** Bump the owning campaign's updatedAt so cloud sync notices homebrew edits made outside play. */
async function touchCampaign(campaignId: string | null): Promise<void> {
  if (!campaignId) return;
  await db.campaigns
    .where('id')
    .equals(campaignId)
    .modify((c) => {
      c.updatedAt = Math.max(Date.now(), c.updatedAt + 1);
    });
}

export async function putHomebrew(h: HomebrewEntry): Promise<void> {
  await db.transaction('rw', db.homebrew, db.campaigns, async () => {
    await db.homebrew.put(h);
    await touchCampaign(h.campaignId);
  });
}

export async function deleteHomebrewRecord(id: string): Promise<void> {
  await db.transaction('rw', db.homebrew, db.campaigns, async () => {
    const existing = await db.homebrew.get(id);
    if (!existing) return;
    await db.homebrew.delete(id);
    await touchCampaign(existing.campaignId);
  });
}

/** campaignId undefined = all homebrew; null = shared only; string = that campaign + shared. */
export async function listHomebrew(campaignId?: string | null): Promise<HomebrewEntry[]> {
  // Shared entries have campaignId null, which IndexedDB cannot index, so they are filtered.
  const rows =
    campaignId === undefined
      ? await db.homebrew.toArray()
      : await db.homebrew.filter((h) => h.campaignId === null || h.campaignId === campaignId).toArray();
  return rows.sort(byName);
}

export function useHomebrewList(campaignId?: string | null): HomebrewEntry[] | undefined {
  return useLiveQuery(() => listHomebrew(campaignId), [campaignId]);
}

/** Built-in sources first, then by title. */
export async function listLibrarySources(): Promise<LibrarySource[]> {
  const sources = await db.library.toArray();
  return sources.sort(
    (a, b) =>
      Number(b.kind === 'builtin') - Number(a.kind === 'builtin') ||
      a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
  );
}

export function useLibrarySources(): LibrarySource[] | undefined {
  return useLiveQuery(listLibrarySources, []);
}

/** Save a source and replace all of its entries (entry count kept in step). */
export async function saveLibrarySource(source: LibrarySource, entries: CompendiumEntry[]): Promise<void> {
  await db.transaction('rw', db.library, db.libraryEntries, async () => {
    await db.libraryEntries.where('sourceId').equals(source.id).delete();
    await db.libraryEntries.bulkPut(entries.map((e) => (e.sourceId === source.id ? e : { ...e, sourceId: source.id })));
    await db.library.put({ ...source, entryCount: entries.length });
  });
}

/** The error deleteLibrarySource gives while Claude is reading the book (a job is running or pausing). */
export const STRUCTURING_BUSY_ERROR = 'Pause or cancel structuring first.';

/** Delete a source with its entries, structured records and extraction jobs (refused while a job runs). */
export async function deleteLibrarySource(id: string): Promise<void> {
  await db.transaction('rw', [db.library, db.libraryEntries, db.libraryRecords, db.libraryJobs], async () => {
    const busy = await db.libraryJobs
      .where('sourceId')
      .equals(id)
      .filter((j) => j.status === 'running' || j.status === 'pausing')
      .count();
    if (busy > 0) throw new Error(STRUCTURING_BUSY_ERROR);
    await db.libraryEntries.where('sourceId').equals(id).delete();
    await db.libraryRecords.where('sourceId').equals(id).delete();
    await db.libraryJobs.where('sourceId').equals(id).delete();
    await db.library.delete(id);
  });
}

export async function setLibrarySourceEnabled(id: string, enabled: boolean): Promise<void> {
  const updated = await db.library.update(id, { enabled, updatedAt: Date.now() });
  if (updated === 0) throw new Error('That library source no longer exists.');
}

/** Entries for the given sources (all enabled imported sources when omitted). */
export async function getLibraryEntries(sourceIds?: string[]): Promise<CompendiumEntry[]> {
  const ids =
    sourceIds ??
    (await db.library.toArray()).filter((s) => s.enabled && s.kind === 'import').map((s) => s.id);
  if (ids.length === 0) return [];
  return db.libraryEntries.where('sourceId').anyOf(ids).toArray();
}
