/**
 * The IndexedDB database ("solo-dm") behind every save slot.
 *
 * Migrations: never edit a shipped version. To change the schema, append a new version that lists
 * only the tables whose indexes change (set a table to null to drop it), and transform existing
 * rows in an upgrade callback, e.g.
 *
 *   db.version(2)
 *     .stores({ quests: 'id, campaignId, status' })
 *     .upgrade((tx) => tx.table('quests').toCollection().modify((q) => { q.status ??= 'active'; }));
 *
 * Dexie runs every pending upgrade in order the next time the database opens. Bump
 * CampaignBundle.version too if exported files change shape.
 */
import Dexie, { type EntityTable, type IndexableType, type Table } from 'dexie';
import type {
  Campaign,
  Character,
  Clock,
  CombatState,
  CompendiumEntry,
  HomebrewEntry,
  JournalEntry,
  LibrarySource,
  LogEntry,
  Quest,
  Session,
  TranscriptMessage,
} from '@/types';

/** The combat tracker of one campaign (one row per campaign; no row = no combat). */
export interface CombatRecord {
  campaignId: string;
  state: CombatState;
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

/** Every table that holds data owned by a campaign (all of them except the library). */
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
