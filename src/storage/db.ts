/**
 * The IndexedDB database ("solo-dm") behind every save slot.
 *
 * Migrations: never edit a shipped version. To change the schema, append a new version that lists
 * only the tables whose indexes change (set a table to null to drop it), and transform existing
 * rows in an upgrade callback, e.g.
 *
 *   db.version(4)
 *     .stores({ quests: 'id, campaignId, status' })
 *     .upgrade((tx) => tx.table('quests').toCollection().modify((q) => { q.status ??= 'active'; }));
 *
 * Dexie runs every pending upgrade in order the next time the database opens. Bump
 * CampaignBundle.version too if exported files change shape.
 *
 * History: 1 = the original schema; 2 = illustrations (the "images" and "imageData" tables);
 * 3 = structured imports (the "libraryRecords" and "libraryJobs" tables); 4 = no schema change: entry
 * kinds an older import guessed wrongly are corrected once.
 */
import Dexie, { type EntityTable, type IndexableType, type Table } from 'dexie';
import { staleFeatKinds } from '@/data/chunk';
import type {
  Campaign,
  Character,
  Clock,
  CombatState,
  CompendiumEntry,
  ExtractionJob,
  HomebrewEntry,
  JournalEntry,
  LibrarySource,
  LogEntry,
  Quest,
  Session,
  StoredImage,
  StructuredRecord,
  TranscriptMessage,
} from '@/types';

/** The combat tracker of one campaign (one row per campaign; no row = no combat). */
export interface CombatRecord {
  campaignId: string;
  state: CombatState;
}

/**
 * An illustration's metadata (table "images"): StoredImage without the picture, plus its size in
 * bytes. Listing a gallery reads only these rows, never the pictures.
 */
export interface ImageRecord extends Omit<StoredImage, 'blob'> {
  size: number;
}

/**
 * An illustration's picture (table "imageData"), stored as bytes rather than a Blob: Blobs in
 * IndexedDB have been unreliable in some Safari versions, and bytes behave the same everywhere.
 */
export interface ImageDataRecord {
  id: string;
  campaignId: string;
  bytes: ArrayBuffer;
}

export type SoloDmDatabase = Dexie & {
  campaigns: EntityTable<Campaign, 'id'>;
  characters: EntityTable<Character, 'id'>;
  sessions: EntityTable<Session, 'id'>;
  transcript: EntityTable<TranscriptMessage, 'id'>;
  log: Table<LogEntry, string>;
  combat: EntityTable<CombatRecord, 'campaignId'>;
  journal: EntityTable<JournalEntry, 'id'>;
  quests: EntityTable<Quest, 'id'>;
  clocks: EntityTable<Clock, 'id'>;
  homebrew: EntityTable<HomebrewEntry, 'id'>;
  library: EntityTable<LibrarySource, 'id'>;
  libraryEntries: EntityTable<CompendiumEntry, 'id'>;
  images: EntityTable<ImageRecord, 'id'>;
  imageData: EntityTable<ImageDataRecord, 'id'>;
  libraryRecords: EntityTable<StructuredRecord, 'id'>;
  libraryJobs: EntityTable<ExtractionJob, 'id'>;
};

export const db = new Dexie('solo-dm') as SoloDmDatabase;

db.version(1).stores({
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
});

// Version 2: illustrations. Two new tables, so existing rows need no upgrade callback. Pictures live
// apart from their metadata ("imageData") so a gallery can be listed without reading every picture.
// Neither table is part of campaignTables(): images never go into save files or GitHub saves, and a
// campaign replaced by an import or a pull keeps its pictures. deleteCampaign removes them.
db.version(2).stores({
  images: 'id, campaignId, createdAt, [campaignId+createdAt]',
  imageData: 'id, campaignId',
});

// Version 3: structured imports. Two new tables; no existing row changes, so no upgrade callback.
// Neither table is part of campaignTables(): like the library, they never leave this device.
db.version(3).stores({
  libraryRecords: 'id, sourceId, [sourceId+kind], [sourceId+status], [jobId+runState]',
  libraryJobs: 'id, sourceId, status, createdAt',
});

// Version 4: no schema change. Imports made before the offline reader's version 2 stored some entries
// as feats only because of a bare "Prerequisite:" line (stronghold rooms, class options, item
// infusions); their kinds and summaries are corrected once, here, with today's rules (staleFeatKinds, a
// pure function of the stored entries). Imported text only: a JSON file's kinds are the file's own.
// Their structured records are settled by the book page's "Re-check" (detect.ts settleUnmatched).
db.version(4)
  .stores({})
  .upgrade(async (tx) => {
    const sources = (await tx.table('library').toArray()) as LibrarySource[];
    const guessed = new Set(sources.filter((s) => s.kind === 'import' && s.format !== 'json').map((s) => s.id));
    if (guessed.size === 0) return;
    const feats = ((await tx.table('libraryEntries').where('kind').equals('feat').toArray()) as CompendiumEntry[]).filter((e) => guessed.has(e.sourceId));
    const bySource = new Map<string, CompendiumEntry[]>();
    for (const e of feats) {
      const list = bySource.get(e.sourceId) ?? [];
      list.push(e);
      bySource.set(e.sourceId, list);
    }
    const byId = new Map(feats.map((e) => [e.id, e]));
    const corrected: CompendiumEntry[] = [];
    for (const [sourceId, list] of bySource) {
      // An upgrade that throws leaves the whole database unopenable: a book whose old entries can't be
      // read this way just keeps its kinds (Re-check and "Structure as…" still work on it).
      try {
        for (const fix of staleFeatKinds(list)) {
          const entry = byId.get(fix.id);
          if (!entry) continue;
          const { summary: _old, ...rest } = entry;
          corrected.push({ ...rest, kind: fix.kind, ...(fix.summary ? { summary: fix.summary } : {}) });
        }
      } catch (error) {
        console.warn(`[storage] Kept the stored kinds of book ${sourceId}: they couldn't be checked.`, error);
      }
    }
    if (corrected.length) await tx.table('libraryEntries').bulkPut(corrected);
  });

/**
 * Every table that holds a campaign's saved game (all of them except the library, its structured
 * records and jobs, and the illustrations, which stay on this device: see imageTables()).
 */
export function campaignTables(): Table[] {
  return [
    db.campaigns,
    db.characters,
    db.sessions,
    db.transcript,
    db.log,
    db.combat,
    db.journal,
    db.quests,
    db.clocks,
    db.homebrew,
  ];
}

/** The tables of a campaign's illustrations (metadata and pictures). */
export function imageTables(): Table[] {
  return [db.images, db.imageData];
}

/** Everything a campaign owns on this device: its saved game and its illustrations. */
export function campaignAndImageTables(): Table[] {
  return [...campaignTables(), ...imageTables()];
}

/**
 * Ask the browser to keep this site's data under storage pressure (best-effort storage can be
 * evicted). Chrome decides silently; Firefox may ask the player. Resolves false when unsupported.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const manager = globalThis.navigator?.storage;
    if (typeof manager?.persist !== 'function') return false;
    if (await manager.persisted()) return true;
    return await manager.persist();
  } catch {
    return false;
  }
}

/** Range bounds for "every row of this owner" on a compound [ownerId+n] index. */
export function ownerRange(ownerId: string): [IndexableType, IndexableType] {
  return [
    [ownerId, Dexie.minKey],
    [ownerId, Dexie.maxKey],
  ];
}
