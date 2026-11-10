/**
 * Detection (spec §3.2, §3.10, §3.14) over fake-indexeddb: the fixture book's records, the re-run
 * table, the fingerprint of an older import, the duplicate-book check, "Structure as…" and the free
 * re-read. The rules index is a small SRD stand-in (spells, classes and the SRD's Goblin Warrior).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bookFingerprint } from '@/lib/importedContent';
import { deleteRecords, getRecords, getSourceEntries, listLibrarySources, listRecords, putRecords, saveLibrarySource } from '@/storage';
import { resetDatabase } from '@/storage/testData';
import { EXPECTED_DATA, GLOAMWOOD_CANDIDATES, GLOAMWOOD_SOURCE_ID, gloamwoodEntries, gloamwoodEntryId, gloamwoodSource } from '@/test/structuredFixtures';
import { PARSER_VERSION, SRD_SOURCE_ID, type CompendiumEntry, type LibrarySource, type StructuredRecord } from '@/types';
import { createRulesIndex } from '../search';
import { applyReading, detectStructure, doubtMessage, mergeReadings, readOffline, rereadOffline, settleUnmatched, structureEntryAs, type Reading } from './detect';
import { noticeIndex } from './notices';
import { segment } from './segment';

const srd = (kind: CompendiumEntry['kind'], name: string): CompendiumEntry => ({
  id: `srd:${kind}:${name.toLowerCase().replace(/\W+/g, '-')}`, sourceId: SRD_SOURCE_ID, sourceName: 'SRD 5.2.1', kind, name, text: `${name}.`,
});
const SRD = [
  ...['Burning Hands', 'Continual Flame', 'Daylight', 'Detect Magic', 'Faerie Fire', 'Fireball', 'Light', 'Mending'].map((n) => srd('spell', n)),
  srd('class', 'Fighter'),
  srd('class', 'Cleric'),
  srd('monster', 'Goblin Warrior'),
];
vi.mock('../rulesIndexStore', () => ({ getRulesIndex: async () => createRulesIndex(SRD), invalidateRulesIndex: vi.fn() }));

const SOURCE = GLOAMWOOD_SOURCE_ID;
async function importBook(dialect: 'md' | 'mixed' = 'md', overrides: Parameters<typeof gloamwoodSource>[2] = {}) {
  await saveLibrarySource(gloamwoodSource(SOURCE, dialect, overrides), gloamwoodEntries(SOURCE, dialect));
}
const byName = (records: StructuredRecord[], name: string) => records.find((r) => r.name === name);

beforeEach(resetDatabase);

describe('detectStructure', () => {
  it('writes a record per candidate (plus the gear row), reading the Markdown book offline', async () => {
    await importBook();
    const summary = await detectStructure(SOURCE);
    const records = await listRecords(SOURCE);
    expect(records.map((r) => r.name).sort()).toEqual([...GLOAMWOOD_CANDIDATES.map((c) => c.name), 'Hookstaff'].sort());
    expect(summary).toMatchObject({ total: 22, leftOut: 0 });
    expect(summary.byKind).toMatchObject({ monster: { found: 3, readyOffline: 2, needClaude: 1 }, item: { found: 2, readyOffline: 2, needClaude: 0 } });
    for (const name of ['Ashen Choir', 'Cinder Mote', 'Lantern of Hollow Light', 'Mothsilk Cloak', "Warden's Mail", 'Hookstaff', 'Wick Lantern', 'Bramble Hound', 'Glimmerwing Drake'] as const) {
      expect(byName(records, name)?.data, name).toEqual(EXPECTED_DATA[name]);
    }
    expect(byName(records, 'Bramble Hound')?.adaptations.map((a) => a.code)).toEqual(['monster-2014-statblock']);
    const goblin = byName(records, 'Goblin Warrior')!;
    expect(goblin.data).toBeNull();
    expect(goblin.warnings.map((w) => [w.code, w.severity])).toEqual(expect.arrayContaining([['missing', 'block'], ['needs-claude', 'block'], ['name-collision', 'info']]));
  });

  it('gives records the §2.6 ids, the table and its row, the parser version and pending status', async () => {
    await importBook();
    await detectStructure(SOURCE);
    const records = await listRecords(SOURCE);
    const drake = byName(records, 'Glimmerwing Drake')!;
    expect(drake).toMatchObject({
      id: 'rec:gloam:monster:glimmerwing-drake', publicId: gloamwoodEntryId('Glimmerwing Drake'), span: 'entry', status: 'pending',
      origin: 'parser', confidence: 'high', edited: false, parserVersion: PARSER_VERSION, candidateKey: `monster:glimmerwing-drake:${gloamwoodEntryId('Glimmerwing Drake')}`,
    });
    const table = byName(records, 'Gloamwood Arms')!;
    expect(table).toMatchObject({ id: 'rec:gloam:item:gloamwood-arms', span: 'table', data: null, warnings: [] });
    expect(byName(records, 'Hookstaff')).toMatchObject({ span: 'row', rowIndex: 0, tableRecordId: table.id, publicId: 'lib:gloam:item:hookstaff', candidateKey: `item:hookstaff:${gloamwoodEntryId('Gloamwood Arms')}:r0` });
    expect(byName(records, 'Ember Warden')).toMatchObject({ id: 'rec:gloam:subclass:ember-warden', publicId: 'lib:gloam:subclass:ember-warden', span: 'section' });
  });

  it('leaves the flattened Wickwright, Glimmerwing Drake and Mothkin for Claude, and lore unstructured', async () => {
    await importBook('mixed');
    await detectStructure(SOURCE);
    const records = await listRecords(SOURCE);
    for (const name of ['Wickwright', 'Glimmerwing Drake', 'Mothkin']) {
      const r = byName(records, name)!;
      expect(r.data, name).toBeNull();
      expect(r.warnings, name).toContainEqual(expect.objectContaining({ code: 'needs-claude', severity: 'block' }));
    }
    expect(records.some((r) => r.entryIds.includes(gloamwoodEntryId('The Long Dusk')))).toBe(false);
  });

  it('U7: remembers a book it found nothing in (an empty structure on the source), and a re-run keeps it', async () => {
    const road = (n: number, name: string, text: string): CompendiumEntry => ({ id: `lib:road:${n}`, sourceId: 'road', sourceName: 'Road notes', kind: 'rule', name, text, path: ['Road notes', name] });
    await saveLibrarySource({ id: 'road', title: 'Road notes', kind: 'import', enabled: true, entryCount: 2, createdAt: 1, updatedAt: 1 }, [
      road(1, 'The Old Road', 'The road bends past the mill and the ford. Travellers rest at the inn.'),
      road(2, 'The Ford', 'In spring the water rises and the ferryman charges double.'),
    ]);
    expect(await detectStructure('road')).toMatchObject({ total: 0, readyOffline: 0, needClaude: 0, leftOut: 0 });
    expect(await listRecords('road')).toEqual([]);
    const structureOf = async () => (await listLibrarySources()).find((s) => s.id === 'road')?.structure;
    const remembered = await structureOf();
    expect(remembered).toEqual({ detectedAt: expect.any(Number), parserVersion: PARSER_VERSION, counts: {}, needsClaude: 0 });
    await detectStructure('road');
    expect(await structureOf()).toEqual(remembered);
  });

  it('stores the fingerprint of an older import, and names another copy of the same book', async () => {
    await importBook('md', { fingerprint: undefined });
    await saveLibrarySource({ ...gloamwoodSource('copy'), title: 'Gloamwood (old copy)' }, gloamwoodEntries('copy'));
    const summary = await detectStructure(SOURCE);
    const source = (await listLibrarySources()).find((s) => s.id === SOURCE)!;
    expect(source.fingerprint).toBe(bookFingerprint(gloamwoodEntries(SOURCE).map((e) => e.text)));
    expect(summary.duplicateOf).toEqual({ id: 'copy', title: 'Gloamwood (old copy)' });
  });

  it('re-runs without destroying work: same results are not rewritten, an edit gets a proposal when the reading changed, rejected and pack records stay', async () => {
    await importBook();
    await detectStructure(SOURCE);
    const before = await listRecords(SOURCE);
    const hound = byName(before, 'Bramble Hound')!;
    const choir = byName(before, 'Ashen Choir')!;
    const cloak = byName(before, 'Mothsilk Cloak')!;
    const drake = byName(before, 'Glimmerwing Drake')!;
    await putRecords([
      // Read by a reader that read it differently, then edited by the player.
      { ...hound, edited: true, data: { ...hound.data!, hp: 30 } as StructuredRecord['data'], readingHash: 'an-older-reading', updatedAt: 1 },
      { ...choir, status: 'rejected', data: { ...choir.data!, level: 5 } as StructuredRecord['data'], updatedAt: 1 },
      { ...cloak, origin: 'pack', data: { ...cloak.data!, charges: 9 } as StructuredRecord['data'], updatedAt: 1 },
      { ...drake, origin: 'claude', data: { ...drake.data!, hp: 53 } as StructuredRecord['data'], updatedAt: 1 },
    ]);
    await detectStructure(SOURCE);
    const after = await listRecords(SOURCE);
    expect(byName(after, 'Bramble Hound')).toMatchObject({ data: { hp: 30 }, proposal: { data: EXPECTED_DATA['Bramble Hound'], origin: 'parser' } });
    expect(byName(after, 'Ashen Choir')).toMatchObject({ status: 'rejected', data: { level: 5 }, updatedAt: 1 });
    expect(byName(after, 'Mothsilk Cloak')).toMatchObject({ origin: 'pack', data: { charges: 9 }, updatedAt: 1 });
    expect(byName(after, 'Glimmerwing Drake')).toMatchObject({ origin: 'claude', data: { hp: 53 }, updatedAt: 1 });
    expect(byName(after, 'Glimmerwing Drake')).not.toHaveProperty('proposal');
    const unchanged = byName(after, 'Cinder Mote')!;
    expect(unchanged.updatedAt).toBe(byName(before, 'Cinder Mote')!.updatedAt);
  });

  it('marks a record whose text changed as stale, and never deletes it', async () => {
    await importBook();
    await detectStructure(SOURCE);
    const accepted = byName(await listRecords(SOURCE), 'Ashen Choir')!;
    await putRecords([{ ...accepted, status: 'accepted' }]);
    const entries = gloamwoodEntries(SOURCE).map((e) => (e.name === 'Ashen Choir' ? { ...e, text: e.text.replace('3d8', '4d8') } : e));
    await saveLibrarySource(gloamwoodSource(SOURCE), entries);
    await detectStructure(SOURCE);
    const choir = byName(await listRecords(SOURCE), 'Ashen Choir')!;
    expect(choir.status).toBe('accepted');
    expect(choir.warnings).toContainEqual(expect.objectContaining({ code: 'stale-text' }));
    expect(choir.proposal?.data).toMatchObject({ damage: '4d8' });
  });
});

describe('structureEntryAs and rereadOffline', () => {
  it('marks an entry detection missed, read offline when it can be', async () => {
    await importBook();
    await detectStructure(SOURCE);
    const lore = await structureEntryAs(SOURCE, [gloamwoodEntryId('The Long Dusk')], 'feat');
    expect(lore).toMatchObject({ kind: 'feat', name: 'The Long Dusk', span: 'entry', publicId: gloamwoodEntryId('The Long Dusk'), status: 'pending' });
    const again = await structureEntryAs(SOURCE, [gloamwoodEntryId('Mothkin')], 'species');
    expect(again.id).toBe('rec:gloam:species:mothkin');
    await expect(structureEntryAs(SOURCE, ['lib:gloam:999'], 'spell')).rejects.toThrow();
  });

  it('re-reads chosen records for free: pending ones are replaced, accepted ones get a proposal', async () => {
    await importBook();
    await detectStructure(SOURCE);
    const records = await listRecords(SOURCE);
    const cloak = byName(records, 'Mothsilk Cloak')!;
    const lantern = byName(records, 'Lantern of Hollow Light')!;
    const hookstaff = byName(records, 'Hookstaff')!;
    await putRecords([
      { ...cloak, data: { ...cloak.data!, rarity: 'rare' } as StructuredRecord['data'] },
      { ...lantern, status: 'accepted', data: { ...lantern.data!, charges: 5 } as StructuredRecord['data'] },
      { ...hookstaff, data: { ...hookstaff.data!, costGp: 99 } as StructuredRecord['data'] },
    ]);
    await rereadOffline([cloak.id, lantern.id, hookstaff.id, 'rec:gloam:monster:nobody']);
    const [c, l, h] = await getRecords([cloak.id, lantern.id, hookstaff.id]);
    expect(c?.data).toEqual(EXPECTED_DATA['Mothsilk Cloak']);
    expect(l).toMatchObject({ status: 'accepted', data: { charges: 5 }, proposal: { data: EXPECTED_DATA['Lantern of Hollow Light'] } });
    expect(h?.data).toEqual(EXPECTED_DATA.Hookstaff);
  });
});

describe('mergeReadings and applyReading (pure)', () => {
  const entries = gloamwoodEntries(SOURCE);
  const ctx = { sourceId: SOURCE, entriesById: new Map(entries.map((e) => [e.id, e])), spellLists: [], notices: noticeIndex(SRD) };
  const { candidates } = segment(entries, { knownSpellNames: new Set(), knownClassNames: new Set() });
  const readings: Reading[] = candidates.filter((c) => c.kind === 'spell').flatMap((c) => readOffline(c, ctx));

  it('stops adding records at the source limit and reports what was left out', () => {
    const merged = mergeReadings(SOURCE, [], readings, { explicit: false, now: 1, limit: 1 });
    expect(merged.writes.map((r) => r.name)).toEqual(['Ashen Choir']);
    expect(merged.records).toEqual([merged.writes[0], undefined]);
  });

  it('matches a record by name when its key changed, and keeps its ids', () => {
    const [first] = mergeReadings(SOURCE, [], readings, { explicit: false, now: 1 }).writes;
    const moved = { ...first, candidateKey: 'spell:ashen-choir:lib:gloam:1' };
    const merged = mergeReadings(SOURCE, [moved], readings, { explicit: false, now: 2 });
    expect(merged.records[0]?.id).toBe(first.id);
    expect(merged.unmatched).toEqual([]);
  });

  it('suffixes a clashing slug', () => {
    const merged = mergeReadings(SOURCE, [], [readings[0], { ...readings[0], candidateKey: 'spell:ashen-choir:lib:gloam:2', entryIds: ['lib:gloam:2'] }], { explicit: false, now: 1 });
    expect(merged.writes.map((r) => r.id)).toEqual(['rec:gloam:spell:ashen-choir', 'rec:gloam:spell:ashen-choir-2']);
  });

  it('never overwrites a record a newer app version wrote', () => {
    const [first] = mergeReadings(SOURCE, [], readings, { explicit: false, now: 1 }).writes;
    expect(applyReading({ ...first, schemaVersion: 99, data: null }, first, { explicit: true, now: 2 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// After the offline reader improved (PARSER_VERSION 2): an invented book whose stronghold rooms and class
// option print Prerequisite lines, imported and read by version 1, which took all of them for feats.
// ---------------------------------------------------------------------------

describe('after the offline reader improved', () => {
  const HOLD = 'hold';
  const BOOK = 'Lamplight Holdings';
  const entry = (n: number, name: string, kind: CompendiumEntry['kind'], text: string, section: string, summary?: string): CompendiumEntry => ({
    id: `lib:${HOLD}:${n}`, sourceId: HOLD, sourceName: BOOK, kind, name, text, path: [BOOK, section, name], ...(summary ? { summary } : {}),
  });
  /** The entries as version 1 stored them (a room took its subsection along, as a feat would). */
  const OLD_ENTRIES = [
    entry(1, 'Glowworm Gallery', 'feat', '_Level 5 Holding Room_\n\n_Prerequisite: None_\n\n_Room: Snug_\n\nThe keeper raises glowworms in jars of moss.\n\n### Gallery Tasks\n\nBrew. The keeper fills a jar with light.', 'Holding Rooms', 'Prerequisite: None'),
    entry(2, 'Moth Archive', 'feat', "_Level 9 Holding Room_\n\n_Prerequisite: Proficiency with a lantern-maker's tools_\n\nMoths copy every map left on the tables.", 'Holding Rooms', "Prerequisite: Proficiency with a lantern-maker's tools"),
    entry(3, 'Bright Ember', 'feat', "_Prerequisite: Level 5+ Wickwright_\n\nYour wick's flame sheds bright light 10 feet farther.", 'Wick Charm Options', 'Prerequisite: Level 5+ Wickwright'),
    // A real older-style feat, under a heading that doesn't name feats (as a flattened PDF leaves it).
    entry(4, 'Night Walker', 'feat', '_Prerequisite: Wisdom 13 or higher_\n\nYou can walk the lamp roads at night without a light.', 'Heroic Talents', 'Prerequisite: Wisdom 13 or higher'),
    entry(5, 'Lamp Oil', 'rule', 'Lamp oil burns for six hours in a hooded lantern.', 'Supplies'),
  ];
  const source = (format: LibrarySource['format']): LibrarySource => ({ id: HOLD, title: BOOK, kind: 'import', format, enabled: true, entryCount: OLD_ENTRIES.length, createdAt: 1, updatedAt: 1 });
  const ctx = { sourceId: HOLD, entriesById: new Map(OLD_ENTRIES.map((e) => [e.id, e])), spellLists: [], notices: null };

  /** What version 1 wrote: a feat record per Prerequisite entry (read offline, version 1). */
  async function importedByVersion1(format: LibrarySource['format'] = 'pdf'): Promise<StructuredRecord[]> {
    await saveLibrarySource(source(format), OLD_ENTRIES);
    const { candidates } = segment(OLD_ENTRIES, { knownSpellNames: new Set(), knownClassNames: new Set() });
    const readings = candidates.flatMap((c) => readOffline(c, ctx));
    const records = mergeReadings(HOLD, [], readings, { explicit: false, now: 1 }).writes.map((r) => ({ ...r, parserVersion: 1 }));
    expect(records.map((r) => [r.name, r.kind])).toEqual([['Glowworm Gallery', 'feat'], ['Moth Archive', 'feat'], ['Bright Ember', 'feat'], ['Night Walker', 'feat']]);
    await putRecords(records);
    return records;
  }
  const named = (records: StructuredRecord[], name: string) => records.find((r) => r.name === name);
  const recheckCount = (records: StructuredRecord[]) =>
    records.filter((r) => r.origin === 'parser' && (r.parserVersion ?? 0) < PARSER_VERSION && r.status !== 'rejected' && !r.runState).length;

  it('corrects the stored kinds, drops the misreadings nobody worked on, and keeps the ones the player did with a note', async () => {
    const v1 = await importedByVersion1();
    await putRecords([
      { ...named(v1, 'Moth Archive')!, status: 'rejected' },
      { ...named(v1, 'Bright Ember')!, status: 'accepted' },
    ]);
    const summary = await detectStructure(HOLD);

    const kinds = Object.fromEntries((await getSourceEntries(HOLD)).map((e) => [e.name, [e.kind, e.summary]]));
    expect(kinds).toEqual({
      'Glowworm Gallery': ['rule', `${BOOK} › Holding Rooms`],
      'Moth Archive': ['rule', `${BOOK} › Holding Rooms`],
      'Bright Ember': ['rule', `${BOOK} › Wick Charm Options`],
      'Night Walker': ['feat', 'Prerequisite: Wisdom 13 or higher'],
      'Lamp Oil': ['rule', undefined],
    });
    const after = await listRecords(HOLD);
    expect(named(after, 'Glowworm Gallery')).toBeUndefined();
    // The player's decisions stand: rejected stays untouched, accepted stays accepted with a note.
    expect(named(after, 'Moth Archive')).toMatchObject({ status: 'rejected', parserVersion: 1, updatedAt: 1 });
    const ember = named(after, 'Bright Ember')!;
    expect(ember).toMatchObject({ status: 'accepted', parserVersion: PARSER_VERSION, confidence: 'medium' });
    expect(ember.warnings).toContainEqual({ code: 'not-this-kind', severity: 'warn', field: 'kind', message: doubtMessage('feat') });
    // The real feat is still a feat (no Feats heading needed), read by today's reader.
    expect(named(after, 'Night Walker')).toMatchObject({ kind: 'feat', status: 'pending', parserVersion: PARSER_VERSION, data: { category: 'general', prerequisite: 'Wisdom 13 or higher' } });

    expect(summary).toMatchObject({
      total: 1,
      removed: { feat: 1 },
      removedNames: ['Glowworm Gallery'],
      removedRecords: [expect.objectContaining({ id: named(v1, 'Glowworm Gallery')!.id, parserVersion: 1 })],
      doubted: [{ id: ember.id, kind: 'feat', status: 'accepted' }],
    });
    const counts = (await listLibrarySources()).find((s) => s.id === HOLD)?.structure?.counts;
    expect(counts?.feat).toEqual({ pending: 1, accepted: 1, rejected: 1 });
    expect(recheckCount(after)).toBe(0);
  });

  it('never removes what the player marked or changed the kind of: it reads them again', async () => {
    const v1 = await importedByVersion1();
    /** A marking as version 1 stored it (before records remembered markings). */
    const markedByVersion1 = async (entryId: string, kind: StructuredRecord['kind']) => {
      const { marked: _marked, ...record } = await structureEntryAs(HOLD, [entryId], kind);
      await putRecords([{ ...record, parserVersion: 1 }]);
    };
    // "What it is" turned the room's feat record into a background; "Structure as… feat" marked Lamp Oil;
    // and a newer marking says the archive is a feat after all.
    await markedByVersion1('lib:hold:1', 'background');
    await deleteRecords([named(v1, 'Glowworm Gallery')!.id]);
    await markedByVersion1('lib:hold:5', 'feat');
    await putRecords([{ ...named(v1, 'Moth Archive')!, marked: true }]);

    const summary = await detectStructure(HOLD);
    const after = await listRecords(HOLD);
    expect(after.map((r) => [r.name, r.kind, r.parserVersion]).sort()).toEqual([
      ['Glowworm Gallery', 'background', PARSER_VERSION],
      ['Lamp Oil', 'feat', PARSER_VERSION],
      ['Moth Archive', 'feat', PARSER_VERSION],
      ['Night Walker', 'feat', PARSER_VERSION],
    ]);
    expect(named(after, 'Moth Archive')).toMatchObject({ marked: true });
    expect(summary).toMatchObject({ removed: { feat: 1 }, removedNames: ['Bright Ember'] });
    expect(recheckCount(after)).toBe(0);
  });

  it('leaves alone a record that changed while it looked through the book, and one Claude is reading', async () => {
    const v1 = await importedByVersion1();
    const walker = named(v1, 'Night Walker')!;
    const gallery = named(v1, 'Glowworm Gallery')!;
    const ember = named(v1, 'Bright Ember')!;
    await putRecords([{ ...ember, runState: 'queued', jobId: 'job:1' }]);
    let wrote: Promise<void> | null = null;
    await detectStructure(HOLD, {
      onProgress: (done, total) => {
        if (done !== total || wrote) return;
        // Meanwhile: the player accepts Night Walker and Glowworm Gallery; Claude's reading of Bright Ember lands.
        wrote = putRecords([
          { ...walker, status: 'accepted', updatedAt: 999_999 },
          { ...gallery, status: 'accepted', updatedAt: 999_999 },
          { ...ember, origin: 'claude', runState: 'done', jobId: 'job:1', updatedAt: 999_999 },
        ]);
      },
    });
    await wrote;
    const after = await listRecords(HOLD);
    expect(named(after, 'Night Walker')).toMatchObject({ status: 'accepted', updatedAt: 999_999 });
    expect(named(after, 'Glowworm Gallery')).toMatchObject({ status: 'accepted', updatedAt: 999_999 });
    expect(named(after, 'Bright Ember')).toMatchObject({ origin: 'claude', runState: 'done', updatedAt: 999_999 });
  });

  it("doesn't offer an offline reading over the player's edit or over Claude's waiting reading, and judges stale text by the record's own entries", async () => {
    const v1 = await importedByVersion1();
    const walker = named(v1, 'Night Walker')!;
    const edited = { ...walker, status: 'accepted' as const, edited: true, data: { ...(walker.data as object), prerequisite: 'Wisdom 14 or higher' } as StructuredRecord['data'] };
    await putRecords([edited]);
    await detectStructure(HOLD);
    const once = named(await listRecords(HOLD), 'Night Walker')!;
    expect(once).toMatchObject({ edited: true, parserVersion: PARSER_VERSION, data: { prerequisite: 'Wisdom 14 or higher' } });
    expect(once).not.toHaveProperty('proposal');
    expect(once.warnings.some((w) => w.code === 'stale-text')).toBe(false);

    const claudeProposal = { data: walker.data!, warnings: [], adaptations: [], excerpts: [], origin: 'claude' as const, createdAt: 5 };
    const accepted = { ...walker, status: 'accepted' as const, data: { ...(walker.data as object), repeatable: true } as StructuredRecord['data'], proposal: claudeProposal, parserVersion: 1 };
    await putRecords([accepted]);
    await detectStructure(HOLD);
    expect(named(await listRecords(HOLD), 'Night Walker')?.proposal).toEqual(claudeProposal);
  });

  it('changes nothing the second time', async () => {
    await importedByVersion1();
    await detectStructure(HOLD);
    const before = await listRecords(HOLD);
    const again = await detectStructure(HOLD);
    expect(again).toMatchObject({ removed: {}, removedNames: [], removedRecords: [], doubted: [] });
    expect(await listRecords(HOLD)).toEqual(before);
  });

  it("keeps a JSON file's kinds (they are the file's, not a guess), and re-checks its records", async () => {
    await importedByVersion1('json');
    const summary = await detectStructure(HOLD);
    expect(summary).toMatchObject({ removed: {}, doubted: [] });
    expect((await getSourceEntries(HOLD)).filter((e) => e.kind === 'feat')).toHaveLength(4);
    expect(recheckCount(await listRecords(HOLD))).toBe(0);
  });

  it('stamps a reviewed record today’s reader still finds, so the re-check is done for it', () => {
    const entries = gloamwoodEntries(SOURCE);
    const gctx = { sourceId: SOURCE, entriesById: new Map(entries.map((e) => [e.id, e])), spellLists: [], notices: null };
    const { candidates } = segment(entries, { knownSpellNames: new Set(), knownClassNames: new Set() });
    const reading = candidates.filter((c) => c.kind === 'spell').flatMap((c) => readOffline(c, gctx));
    const [fresh] = mergeReadings(SOURCE, [], reading, { explicit: false, now: 1 }).writes;
    const accepted: StructuredRecord = { ...fresh, status: 'accepted', parserVersion: 1 };
    expect(applyReading(accepted, fresh, { explicit: false, now: 2 })).toEqual({ ...accepted, parserVersion: PARSER_VERSION, updatedAt: 2 });
    expect(applyReading({ ...accepted, origin: 'claude' }, fresh, { explicit: false, now: 2 })).toBeNull();
    // Stale text follows the predicate when given (detection passes the record's own entries).
    const moved = { ...fresh, textHash: 'other' };
    expect(applyReading({ ...accepted, parserVersion: PARSER_VERSION }, moved, { explicit: false, now: 3, textChanged: () => false })).toBeNull();
    expect(applyReading({ ...accepted, parserVersion: PARSER_VERSION }, fresh, { explicit: false, now: 3, textChanged: () => true })?.warnings).toContainEqual(expect.objectContaining({ code: 'stale-text' }));
    // A record Claude is reading is left to that reading.
    expect(applyReading({ ...fresh, runState: 'running', parserVersion: 1 }, fresh, { explicit: false, now: 3 })).toBeNull();
  });
});

describe('settleUnmatched (pure)', () => {
  const room = { id: 'lib:hold:1', sourceId: 'hold', sourceName: 'Holdings', kind: 'rule', name: 'Glowworm Gallery', text: '_Level 5 Holding Room_\n\n_Prerequisite: None_\n\nGlowworms.', path: ['Holdings', 'Glowworm Gallery'] } as CompendiumEntry;
  const feat = { id: 'lib:hold:2', sourceId: 'hold', sourceName: 'Holdings', kind: 'feat', name: 'Night Walker', text: 'Prerequisite: Wisdom 13 or higher\n\nYou walk at night.', path: ['Holdings', 'Night Walker'] } as CompendiumEntry;
  const entriesById = new Map([room, feat].map((e) => [e.id, e]));
  const base = (id: string, patch: Partial<StructuredRecord> = {}): StructuredRecord => ({
    id, publicId: room.id, sourceId: 'hold', kind: 'feat', name: id, schemaVersion: 1, entryIds: [room.id], span: 'entry', candidateKey: id,
    status: 'pending', confidence: 'high', origin: 'parser', data: null, warnings: [], adaptations: [], excerpts: [], edited: false,
    textHash: 'h', parserVersion: 1, createdAt: 1, updatedAt: 1, ...patch,
  });

  it('removes only the misreadings the version change explains that nobody worked on', () => {
    const records = [
      base('unreviewed'),
      base('accepted', { status: 'accepted' }),
      base('edited', { edited: true }),
      base('proposal', { proposal: { data: { format: '2014', category: 'general', repeatable: false, text: { entryIds: [room.id], from: 2, to: 2 } }, warnings: [], adaptations: [], excerpts: [], origin: 'claude', createdAt: 1 } }),
      base('read-by-claude', { runState: 'done', jobId: 'job:1' }),
      base('marked', { marked: true }),
      base('a-background', { kind: 'background' }),
      base('a-real-feat', { entryIds: [feat.id] }),
      base('rejected', { status: 'rejected' }),
      base('by-claude', { origin: 'claude', parserVersion: undefined }),
      base('being-read', { runState: 'queued' }),
      base('newer-app', { schemaVersion: 99 }),
      base('current', { parserVersion: PARSER_VERSION }),
    ];
    const settled = settleUnmatched(records, entriesById, 5);
    expect([...settled.remove]).toEqual(['unreviewed']);
    expect(settled.doubted.map((r) => r.id)).toEqual(['accepted', 'edited', 'proposal', 'read-by-claude']);
    expect(settled.doubted[0]).toMatchObject({ status: 'accepted', confidence: 'medium', parserVersion: PARSER_VERSION, updatedAt: 5 });
    expect(settled.reread.map((r) => r.id)).toEqual(['marked', 'a-background', 'a-real-feat']);
  });
});
