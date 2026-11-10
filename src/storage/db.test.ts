/**
 * The database upgrade to version 4 (src/storage/db.ts): entry kinds an older import guessed wrongly
 * (a feat that was only a bare "Prerequisite:" line outside a Feats heading) are corrected once, for
 * imported text only. Invented content only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import type { CompendiumEntry, LibrarySource } from '@/types';
import { db } from './db';
import { resetDatabase } from './testData';

/** The schema up to version 3, as the app declared it. */
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
const V2_STORES = { images: 'id, campaignId, createdAt, [campaignId+createdAt]', imageData: 'id, campaignId' };
const V3_STORES = {
  libraryRecords: 'id, sourceId, [sourceId+kind], [sourceId+status], [jobId+runState]',
  libraryJobs: 'id, sourceId, status, createdAt',
};

const source = (id: string, format: LibrarySource['format'], kind: LibrarySource['kind'] = 'import'): LibrarySource => ({
  id, title: 'Lamplight Holdings', kind, format, enabled: true, entryCount: 0, createdAt: 1, updatedAt: 1,
});
const entry = (sourceId: string, n: number, name: string, kind: CompendiumEntry['kind'], text: string, path: string[], summary?: string): CompendiumEntry => ({
  id: `lib:${sourceId}:${n}`, sourceId, sourceName: 'Lamplight Holdings', kind, name, text, path, ...(summary ? { summary } : {}),
});
const ROOM = '_Level 5 Holding Room_\n\n_Prerequisite: None_\n\nThe keeper raises glowworms.';
const FEAT = '_Prerequisite: Wisdom 13 or higher_\n\nYou walk the lamp roads at night.';

/** Book entries as version 1's chunker stored them (rooms as feats, a long room in two parts). */
const stored = (sourceId: string) => [
  entry(sourceId, 1, 'Glowworm Gallery', 'feat', ROOM, ['Lamplight Holdings', 'Holding Rooms', 'Glowworm Gallery'], 'Prerequisite: None'),
  entry(sourceId, 2, 'Moth Archive', 'feat', `_Level 9 Holding Room_\n\n_Prerequisite: None_\n\n${'Moths copy maps. '.repeat(10)}`, ['Lamplight Holdings', 'Holding Rooms', 'Moth Archive'], 'Prerequisite: None'),
  entry(sourceId, 3, 'Moth Archive (part 2)', 'feat', 'The keeper sells the copies.', ['Lamplight Holdings', 'Holding Rooms', 'Moth Archive (part 2)'], 'Prerequisite: None'),
  entry(sourceId, 4, 'Night Walker', 'feat', FEAT, ['Lamplight Holdings', 'Feats', 'Night Walker'], 'Prerequisite: Wisdom 13 or higher'),
  entry(sourceId, 5, 'Lantern Bearer', 'feat', '_General Feat (Prerequisite: Level 4+)_\n\nYou carry the light.', ['Lantern Bearer'], 'General Feat (Prerequisite: Level 4+)'),
  entry(sourceId, 6, 'Lamp Oil', 'rule', 'Lamp oil burns for six hours.', ['Lamplight Holdings', 'Supplies', 'Lamp Oil']),
];

afterEach(async () => {
  db.close();
  await Dexie.delete('solo-dm');
  await db.open();
  await resetDatabase();
});

describe('upgrading to version 4', () => {
  it("corrects the kinds an older import guessed from a bare Prerequisite line, and nothing else", async () => {
    db.close();
    await Dexie.delete('solo-dm');
    const v3 = new Dexie('solo-dm');
    v3.version(1).stores(V1_STORES);
    v3.version(2).stores(V2_STORES);
    v3.version(3).stores(V3_STORES);
    await v3.table('library').bulkPut([source('pdf', 'pdf'), source('notes', undefined), source('file', 'json'), source('srd-like', 'markdown', 'builtin')]);
    await v3.table('libraryEntries').bulkPut([...stored('pdf'), ...stored('notes'), ...stored('file'), ...stored('srd-like')]);
    const record = { id: 'rec:pdf:feat:glowworm-gallery', sourceId: 'pdf', kind: 'feat', status: 'pending', entryIds: ['lib:pdf:1'] };
    await v3.table('libraryRecords').put(record);
    v3.close();

    await db.open();

    expect(db.verno).toBe(4);
    const kinds = async (sourceId: string) =>
      Object.fromEntries((await db.libraryEntries.where('sourceId').equals(sourceId).toArray()).map((e) => [e.name, [e.kind, e.summary]]));
    const fixed = {
      'Glowworm Gallery': ['rule', 'Lamplight Holdings › Holding Rooms'],
      'Moth Archive': ['rule', 'Lamplight Holdings › Holding Rooms'],
      'Moth Archive (part 2)': ['rule', 'Lamplight Holdings › Holding Rooms'],
      'Night Walker': ['feat', 'Prerequisite: Wisdom 13 or higher'],
      'Lantern Bearer': ['feat', 'General Feat (Prerequisite: Level 4+)'],
      'Lamp Oil': ['rule', undefined],
    };
    expect(await kinds('pdf')).toEqual(fixed);
    expect(await kinds('notes')).toEqual(fixed); // an import from before formats were recorded
    // A JSON file's kinds are its own, and a built-in source is never touched.
    const untouched = Object.fromEntries(stored('file').map((e) => [e.name, [e.kind, e.summary]]));
    expect(await kinds('file')).toEqual(untouched);
    expect(await kinds('srd-like')).toEqual(untouched);
    // Records are left for the book page's Re-check, which settles them.
    expect(await db.libraryRecords.get(record.id)).toEqual(record);
    // Night Walker and Lantern Bearer in each imported-text book, all five stored feats in the other two.
    expect(await db.libraryEntries.where('kind').equals('feat').count()).toBe(2 + 2 + 5 + 5);
  });

  it('still opens when an old entry is malformed (that book keeps its kinds)', async () => {
    db.close();
    await Dexie.delete('solo-dm');
    const v3 = new Dexie('solo-dm');
    v3.version(1).stores(V1_STORES);
    v3.version(2).stores(V2_STORES);
    v3.version(3).stores(V3_STORES);
    await v3.table('library').bulkPut([source('pdf', 'pdf'), source('odd', 'pdf')]);
    const broken = { id: 'lib:odd:1', sourceId: 'odd', sourceName: 'Odd', kind: 'feat', name: 'Broken', text: null, path: 'not a list' };
    await v3.table('libraryEntries').bulkPut([...stored('pdf'), broken]);
    v3.close();

    await db.open();

    expect(db.verno).toBe(4);
    expect(await db.libraryEntries.get('lib:odd:1')).toEqual(broken);
    expect((await db.libraryEntries.get('lib:pdf:1'))?.kind).toBe('rule');
  });

  it('opens an empty library at version 4', async () => {
    db.close();
    await Dexie.delete('solo-dm');
    await db.open();
    expect(db.verno).toBe(4);
    expect(await db.libraryEntries.count()).toBe(0);
  });
});
