import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { PARSER_VERSION, type CompendiumEntry, type LibrarySource, type StructuredRecord } from '@/types';
import {
  charactersUsingSource,
  deleteLibrarySource,
  deleteRecords,
  findSourcesByFingerprint,
  getAcceptedRecords,
  getJob,
  getRecords,
  getSourceEntries,
  listJobRecords,
  listJobs,
  listLibrarySources,
  listRecords,
  markSourceStructured,
  putJob,
  putRecords,
  saveLibrarySource,
  saveLibrarySourceWithRecords,
  setLibrarySourceEnabled,
  setRecordStatus,
  setSourceFingerprint,
  structuringSpendUsd,
  STRUCTURING_BUSY_ERROR,
  useJobs,
  useRecords,
} from '@/storage';
import {
  extractionJob,
  FIXTURE_TIME,
  gloamwoodEntries,
  gloamwoodRecords,
  gloamwoodSource,
  importedRef,
  structuredRecord,
  zeroUsage,
} from '@/test/structuredFixtures';
import { sampleCampaign, sampleCharacter } from '@/test/fixtures';
import { db } from './db';
import { compareRecordsByReading, entryOrdinal, throttler } from './structured';
import { resetDatabase } from './testData';

beforeEach(resetDatabase);

async function seedBook(source: LibrarySource = gloamwoodSource(), entries: CompendiumEntry[] = gloamwoodEntries(source.id)) {
  await saveLibrarySource(source, entries);
  return { source, entries };
}

const structureOf = async (id = 'gloam') => (await db.library.get(id))?.structure;

describe('getSourceEntries', () => {
  it('returns entries in reading order (numeric suffix), not IndexedDB string order', async () => {
    const entries = [3, 10, 1, 2, 11].map((n) => ({ id: `lib:s:${n}`, sourceId: 's', sourceName: 'S', kind: 'rule' as const, name: `E${n}`, text: `t${n}` }));
    await saveLibrarySource({ id: 's', title: 'S', kind: 'import', enabled: true, entryCount: 5, createdAt: 1, updatedAt: 1 }, entries);
    expect((await getSourceEntries('s')).map((e) => e.id)).toEqual(['lib:s:1', 'lib:s:2', 'lib:s:3', 'lib:s:10', 'lib:s:11']);
    expect(await getSourceEntries('missing')).toEqual([]);
  });

  it('reads ordinals only from three-segment chunk ids', () => {
    expect(entryOrdinal('lib:gloam:12')).toBe(12);
    expect(entryOrdinal('lib:gloam:class:12')).toBeNaN();
    expect(entryOrdinal('srd:spell:fireball')).toBeNaN();
  });
});

describe('putRecords and the source counts', () => {
  it('creates the counts on the first write and adjusts them by each record’s delta', async () => {
    await seedBook();
    const records = gloamwoodRecords();
    await putRecords(records);
    const structure = await structureOf();
    // 23 records: the Gloamwood Arms table has its Hookstaff row, so the table itself counts nowhere.
    expect(structure?.counts).toEqual({
      class: { pending: 1, accepted: 0, rejected: 0 },
      subclass: { pending: 3, accepted: 0, rejected: 0 },
      species: { pending: 2, accepted: 0, rejected: 0 },
      background: { pending: 2, accepted: 0, rejected: 0 },
      feat: { pending: 4, accepted: 0, rejected: 0 },
      spell: { pending: 2, accepted: 0, rejected: 0 },
      'magic-item': { pending: 3, accepted: 0, rejected: 0 },
      item: { pending: 2, accepted: 0, rejected: 0 },
      monster: { pending: 3, accepted: 0, rejected: 0 },
    });
    // The Goblin Warrior has no data (its ability scores aren't printed).
    expect(structure?.needsClaude).toBe(1);
    expect(structure?.parserVersion).toBe(1);

    const drake = records.find((r) => r.name === 'Glimmerwing Drake') as StructuredRecord;
    await putRecords([{ ...drake, status: 'accepted' }]);
    expect((await structureOf())?.counts.monster).toEqual({ pending: 2, accepted: 1, rejected: 0 });

    const goblin = records.find((r) => r.name === 'Goblin Warrior') as StructuredRecord;
    await putRecords([{ ...goblin, status: 'rejected' }]);
    const after = await structureOf();
    expect(after?.counts.monster).toEqual({ pending: 1, accepted: 1, rejected: 1 });
    expect(after?.needsClaude).toBe(0); // kept as text: it no longer waits for Claude
  });

  it('counts an unread gear table until its rows exist, and again when they are gone', async () => {
    await seedBook();
    const all = gloamwoodRecords();
    const table = all.find((r) => r.span === 'table') as StructuredRecord;
    const row = all.find((r) => r.span === 'row') as StructuredRecord;
    await putRecords([table]);
    expect(await structureOf()).toMatchObject({ counts: { item: { pending: 1, accepted: 0, rejected: 0 } }, needsClaude: 1 });
    await putRecords([row]);
    expect(await structureOf()).toMatchObject({ counts: { item: { pending: 1, accepted: 0, rejected: 0 } }, needsClaude: 0 });
    await deleteRecords([row.id]);
    expect(await structureOf()).toMatchObject({ counts: { item: { pending: 1, accepted: 0, rejected: 0 } }, needsClaude: 1 });
    await deleteRecords([table.id]);
    expect(await structureOf()).toMatchObject({ counts: {}, needsClaude: 0 });
  });

  it('keeps the counts of several writes of one record in one batch (last wins) and of re-puts', async () => {
    await seedBook();
    const spell = gloamwoodRecords().find((r) => r.name === 'Ashen Choir') as StructuredRecord;
    await putRecords([spell, { ...spell, status: 'accepted' }]);
    expect((await structureOf())?.counts.spell).toEqual({ pending: 0, accepted: 1, rejected: 0 });
    await putRecords([{ ...spell, status: 'accepted' }]);
    expect((await structureOf())?.counts.spell).toEqual({ pending: 0, accepted: 1, rejected: 0 });
    expect((await getRecords([spell.id]))[0]?.status).toBe('accepted');
  });

  it('S3: a reading Claude returned without data no longer counts as "not read yet": it is one to review (it needs a fix)', async () => {
    await seedBook();
    const records = gloamwoodRecords();
    await putRecords(records);
    expect(await structureOf()).toMatchObject({ counts: { monster: { pending: 3, accepted: 0, rejected: 0 } }, needsClaude: 1 });
    const goblin = records.find((r) => r.name === 'Goblin Warrior') as StructuredRecord;
    expect(goblin).toMatchObject({ origin: 'parser', data: null });
    // Claude read it but couldn't complete it: still pending, no longer waiting for a (paid) read.
    const readByClaude = { ...goblin, origin: 'claude' as const, runState: 'done' as const };
    await putRecords([readByClaude]);
    expect(await structureOf()).toMatchObject({ counts: { monster: { pending: 3, accepted: 0, rejected: 0 } }, needsClaude: 0 });
    // Counted whole (a pack, or a source's first write), it agrees.
    const copy = gloamwoodRecords('copy').map((r) => (r.name === 'Goblin Warrior' ? { ...r, origin: 'claude' as const } : r));
    await saveLibrarySourceWithRecords(gloamwoodSource('copy'), gloamwoodEntries('copy'), copy);
    expect((await structureOf('copy'))?.needsClaude).toBe(0);
  });

  it('writes records of a source that is no longer in the library without counts', async () => {
    const orphan = structuredRecord('spell', 'Lost Spell', {}, 'gone');
    await putRecords([orphan]);
    expect((await getRecords([orphan.id]))[0]?.name).toBe('Lost Spell');
    expect(await db.library.get('gone')).toBeUndefined();
  });

  it('leaves the rest of the source row alone', async () => {
    await seedBook();
    await setLibrarySourceEnabled('gloam', false);
    const before = await db.library.get('gloam');
    await putRecords(gloamwoodRecords().slice(0, 3));
    const after = await db.library.get('gloam');
    expect({ ...after, structure: undefined }).toEqual({ ...before, structure: undefined });
  });
});

describe('listRecords', () => {
  it('returns reading order and filters by kind and status', async () => {
    await seedBook();
    const records = gloamwoodRecords();
    // Written shuffled: reading order comes from the entries, not the write order.
    await putRecords([...records].reverse());
    const all = await listRecords('gloam');
    expect(all.map((r) => r.name)).toEqual(records.map((r) => r.name));
    expect((await listRecords('gloam', { kind: 'feat' })).map((r) => r.name)).toEqual(["Moth's Grace", 'Lantern Bearer', 'Watchlight Vigil', 'Hooked Reach']);
    await setRecordStatus([records[0].id, records[2].id], 'accepted');
    expect((await listRecords('gloam', { status: 'accepted' })).map((r) => r.name)).toEqual(['Mothkin', 'Lamplighter']);
    expect((await listRecords('gloam', { kind: 'species', status: 'pending' })).map((r) => r.name)).toEqual(['Bramblefolk']);
  });

  it('orders a table before its rows', () => {
    const records = gloamwoodRecords();
    const table = records.find((r) => r.span === 'table') as StructuredRecord;
    const row = records.find((r) => r.span === 'row') as StructuredRecord;
    expect([row, table].sort(compareRecordsByReading)).toEqual([table, row]);
  });
});

describe('setRecordStatus', () => {
  it('returns the previous statuses (for Undo), sets reviewedAt and keeps the counts', async () => {
    await seedBook();
    const records = gloamwoodRecords();
    await putRecords(records);
    const feats = records.filter((r) => r.kind === 'feat');
    await setRecordStatus([feats[0].id], 'rejected');
    const previous = await setRecordStatus([...feats.map((f) => f.id), 'rec:gloam:feat:missing'], 'accepted');
    expect(previous).toEqual([
      { id: feats[0].id, status: 'rejected' },
      ...feats.slice(1).map((f) => ({ id: f.id, status: 'pending' })),
    ]);
    const stored = await getRecords(feats.map((f) => f.id));
    expect(stored.every((r) => r?.status === 'accepted' && typeof r.reviewedAt === 'number')).toBe(true);
    expect((await structureOf())?.counts.feat).toEqual({ pending: 0, accepted: 4, rejected: 0 });

    // Undo: back to what each one was.
    for (const status of ['pending', 'rejected'] as const) {
      await setRecordStatus(previous.filter((p) => p.status === status).map((p) => p.id), status);
    }
    expect((await structureOf())?.counts.feat).toEqual({ pending: 3, accepted: 0, rejected: 1 });
    const back = await getRecords([feats[1].id]);
    expect(back[0]?.reviewedAt).toBeUndefined();
  });
});

describe('getAcceptedRecords', () => {
  it('reads accepted records of enabled imports, or of the given sources', async () => {
    await seedBook();
    await seedBook(gloamwoodSource('other', 'md', { title: 'Another copy' }));
    await putRecords([...gloamwoodRecords('gloam', { status: 'accepted' }).slice(0, 2), ...gloamwoodRecords('other', { status: 'accepted' }).slice(0, 1)]);
    expect((await getAcceptedRecords()).map((r) => r.id)).toEqual(['rec:gloam:species:mothkin', 'rec:gloam:species:bramblefolk', 'rec:other:species:mothkin']);
    await setLibrarySourceEnabled('other', false);
    expect((await getAcceptedRecords()).map((r) => r.sourceId)).toEqual(['gloam', 'gloam']);
    expect((await getAcceptedRecords(['other'])).map((r) => r.id)).toEqual(['rec:other:species:mothkin']);
    expect(await getAcceptedRecords([])).toEqual([]);
  });
});

describe('jobs', () => {
  it('stores jobs, lists them oldest first by source and status, and lists a job’s records in queue order', async () => {
    await seedBook();
    const a = extractionJob({ id: 'job:a', createdAt: 2, status: 'paused' });
    const b = extractionJob({ id: 'job:b', createdAt: 1, status: 'queued', sourceId: 'other' });
    await putJob(a);
    await putJob(b);
    expect(await getJob('job:a')).toEqual(a);
    expect((await listJobs()).map((j) => j.id)).toEqual(['job:b', 'job:a']);
    expect((await listJobs({ sourceId: 'gloam' })).map((j) => j.id)).toEqual(['job:a']);
    expect((await listJobs({ status: ['queued', 'running'] })).map((j) => j.id)).toEqual(['job:b']);

    const records = gloamwoodRecords().map((r) => ({ ...r, jobId: 'job:a', runState: 'queued' as const }));
    // Reading order puts the monsters last; queue order is STRUCTURED_KINDS first (class, subclass, …).
    await putRecords(records);
    await putRecords([{ ...records[0], runState: 'done' }]);
    const queued = await listJobRecords('job:a', 'queued');
    expect(queued[0].kind).toBe('class');
    expect(queued.map((r) => r.kind).slice(0, 4)).toEqual(['class', 'subclass', 'subclass', 'subclass']);
    expect(queued.some((r) => r.id === records[0].id)).toBe(false);
    expect((await listJobRecords('job:a', 'done')).map((r) => r.name)).toEqual(['Mothkin']);
  });

  it('adds up the lifetime spend of books still in the library', async () => {
    await seedBook();
    await putJob(extractionJob({ id: 'job:1', usage: { ...zeroUsage(), estimatedCostUsd: 1.25 } }));
    await putJob(extractionJob({ id: 'job:2', usage: { ...zeroUsage(), estimatedCostUsd: 0.5 } }));
    await putJob(extractionJob({ id: 'job:3', sourceId: 'deleted-book', usage: { ...zeroUsage(), estimatedCostUsd: 9 } }));
    expect(await structuringSpendUsd()).toBeCloseTo(1.75);
  });
});

describe('deleteLibrarySource', () => {
  it('removes the source with its entries, records and jobs', async () => {
    await seedBook();
    await seedBook(gloamwoodSource('other'));
    await putRecords([...gloamwoodRecords(), ...gloamwoodRecords('other')]);
    await putJob(extractionJob({ id: 'job:done', status: 'done' }));
    await deleteLibrarySource('gloam');
    expect(await listLibrarySources()).toHaveLength(1);
    expect(await getSourceEntries('gloam')).toEqual([]);
    expect(await listRecords('gloam')).toEqual([]);
    expect(await listJobs({ sourceId: 'gloam' })).toEqual([]);
    expect((await listRecords('other')).length).toBe(23);
  });

  it('refuses while one of its jobs is running or pausing', async () => {
    await seedBook();
    await putRecords(gloamwoodRecords());
    for (const status of ['running', 'pausing'] as const) {
      await putJob(extractionJob({ id: 'job:busy', status }));
      await expect(deleteLibrarySource('gloam')).rejects.toThrow(STRUCTURING_BUSY_ERROR);
      expect(await listRecords('gloam')).toHaveLength(23);
      expect(await getSourceEntries('gloam')).not.toHaveLength(0);
    }
    await putJob(extractionJob({ id: 'job:busy', status: 'paused' }));
    await deleteLibrarySource('gloam');
    expect(await listJobs()).toEqual([]);
  });
});

describe('saveLibrarySourceWithRecords', () => {
  it('writes the source, its entries and records with counts in one transaction', async () => {
    const source = gloamwoodSource('pack', 'md', { structure: undefined });
    const entries = gloamwoodEntries('pack');
    const records = gloamwoodRecords('pack');
    await saveLibrarySourceWithRecords(source, entries, records);
    expect(await db.library.get('pack')).toMatchObject({ id: 'pack', entryCount: entries.length, structure: { needsClaude: 1 } });
    expect((await structureOf('pack'))?.counts.item).toEqual({ pending: 2, accepted: 0, rejected: 0 });
    expect(await getSourceEntries('pack')).toHaveLength(entries.length);
    expect(await listRecords('pack')).toHaveLength(records.length);
  });

  it('is atomic: a failed write leaves nothing behind', async () => {
    const source = gloamwoodSource('pack');
    const records = gloamwoodRecords('pack');
    // Two entries with the same id are fine for IndexedDB; a record that can't be stored is not.
    const broken = [...records, { ...records[0], id: undefined } as unknown as StructuredRecord];
    await expect(saveLibrarySourceWithRecords(source, gloamwoodEntries('pack'), broken)).rejects.toThrow();
    expect(await db.library.get('pack')).toBeUndefined();
    expect(await getSourceEntries('pack')).toEqual([]);
    expect(await listRecords('pack')).toEqual([]);
  });

  it('refuses records of another source', async () => {
    await expect(saveLibrarySourceWithRecords(gloamwoodSource('pack'), [], gloamwoodRecords('gloam'))).rejects.toThrow(/another source/);
  });
});

describe('fingerprints', () => {
  it('sets a fingerprint once and finds sources by it', async () => {
    await seedBook(gloamwoodSource('gloam', 'md', { fingerprint: undefined }));
    await setSourceFingerprint('gloam', 'aaaa');
    await setSourceFingerprint('gloam', 'bbbb'); // never recomputed
    expect((await db.library.get('gloam'))?.fingerprint).toBe('aaaa');
    await seedBook(gloamwoodSource('copy', 'md', { fingerprint: 'aaaa', createdAt: FIXTURE_TIME + 5 }));
    expect((await findSourcesByFingerprint('aaaa')).map((s) => s.id)).toEqual(['gloam', 'copy']);
    expect(await findSourcesByFingerprint('')).toEqual([]);
    await expect(setSourceFingerprint('missing', 'x')).rejects.toThrow(/no longer exists/);
  });
});

describe('markSourceStructured', () => {
  it('U7: stores an empty structure on a source detection found nothing in, and leaves a structure it has alone', async () => {
    await seedBook();
    const before = await db.library.get('gloam');
    await markSourceStructured('gloam');
    const marked = await db.library.get('gloam');
    expect(marked?.structure).toEqual({ detectedAt: expect.any(Number), parserVersion: PARSER_VERSION, counts: {}, needsClaude: 0 });
    expect({ ...marked, structure: undefined }).toEqual({ ...before, structure: undefined });

    // Records written later count from the empty structure; marking again changes nothing.
    await putRecords(gloamwoodRecords());
    const counted = await structureOf();
    expect(counted).toMatchObject({ counts: { monster: { pending: 3, accepted: 0, rejected: 0 } }, needsClaude: 1 });
    await markSourceStructured('gloam');
    expect(await structureOf()).toEqual(counted);

    // A source no longer in the library stays gone.
    await expect(markSourceStructured('missing')).resolves.toBeUndefined();
    expect(await db.library.get('missing')).toBeUndefined();
  });
});

describe('charactersUsingSource', () => {
  it('finds heroes with a ref into the book, by id or (from another device) by fingerprint', async () => {
    const source = gloamwoodSource();
    await seedBook(source);
    const put = async (tag: string, refs: Parameters<typeof sampleCharacter>[0]) => {
      const campaign = sampleCampaign({ id: `${tag}-camp`, name: `Campaign ${tag}`, characterId: `${tag}-char` });
      await db.campaigns.put(campaign);
      await db.characters.put(sampleCharacter({ id: `${tag}-char`, campaignId: campaign.id, name: `Hero ${tag}`, ...refs }));
    };
    const base = sampleCharacter();
    await put('b', { features: [...base.features, { id: 'f1', name: 'Ember Ward', source: 'subclass', description: 'x', ref: importedRef() }] });
    await put('a', { speciesRef: importedRef({ sourceId: 'elsewhere', kind: 'species', entryName: 'Mothkin' }) });
    await put('c', { speciesRef: importedRef({ sourceId: 'elsewhere', bookFingerprint: 'another-book' }) });
    await put('d', {});
    expect(await charactersUsingSource('gloam')).toEqual([
      { campaignId: 'a-camp', campaignName: 'Campaign a', characterName: 'Hero a' },
      { campaignId: 'b-camp', campaignName: 'Campaign b', characterName: 'Hero b' },
    ]);
  });
});

describe('live hooks', () => {
  it('useRecords follows writes, filtered by status', async () => {
    await seedBook();
    const records = gloamwoodRecords();
    const { result } = renderHook(() => useRecords('gloam', { status: 'accepted' }));
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toEqual([]));
    await putRecords(records);
    await setRecordStatus([records[1].id], 'accepted');
    await waitFor(() => expect(result.current?.map((r) => r.name)).toEqual(['Bramblefolk']), { timeout: 2000 });
  });

  it('useRecords is undefined without a source id', () => {
    const { result } = renderHook(() => useRecords(undefined));
    expect(result.current).toBeUndefined();
  });

  it('useJobs follows a source’s jobs', async () => {
    const { result } = renderHook(() => useJobs('gloam'));
    await waitFor(() => expect(result.current).toEqual([]));
    await putJob(extractionJob({ id: 'job:x' }));
    await waitFor(() => expect(result.current?.map((j) => j.id)).toEqual(['job:x']), { timeout: 2000 });
  });
});

describe('throttler', () => {
  afterEach(() => vi.useRealTimers());

  it('emits the first value at once, then at most one per interval, always the latest', () => {
    vi.useFakeTimers();
    let clock = 0;
    const out: number[] = [];
    const t = throttler<number>((v) => out.push(v), 500, () => clock);
    t.push(1);
    expect(out).toEqual([1]);
    clock = 100;
    t.push(2);
    t.push(3);
    expect(out).toEqual([1]);
    clock = 500;
    vi.advanceTimersByTime(400);
    expect(out).toEqual([1, 3]);
    clock = 1200;
    t.push(4);
    expect(out).toEqual([1, 3, 4]);
    clock = 1300;
    t.push(5);
    t.cancel();
    vi.advanceTimersByTime(1000);
    expect(out).toEqual([1, 3, 4]);
  });
});
