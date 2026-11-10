/**
 * Detection (spec §3.2, §3.10, §3.14) over fake-indexeddb: the fixture book's records, the re-run
 * table, the fingerprint of an older import, the duplicate-book check, "Structure as…" and the free
 * re-read. The rules index is a small SRD stand-in (spells, classes and the SRD's Goblin Warrior).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bookFingerprint } from '@/lib/importedContent';
import { getRecords, listLibrarySources, listRecords, putRecords, saveLibrarySource } from '@/storage';
import { resetDatabase } from '@/storage/testData';
import { EXPECTED_DATA, GLOAMWOOD_CANDIDATES, GLOAMWOOD_SOURCE_ID, gloamwoodEntries, gloamwoodEntryId, gloamwoodSource } from '@/test/structuredFixtures';
import { PARSER_VERSION, SRD_SOURCE_ID, type CompendiumEntry, type StructuredRecord } from '@/types';
import { createRulesIndex } from '../search';
import { applyReading, detectStructure, mergeReadings, readOffline, rereadOffline, structureEntryAs, type Reading } from './detect';
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
vi.mock('../rulesIndexStore', () => ({ getRulesIndex: async () => createRulesIndex(SRD) }));

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
      origin: 'parser', confidence: 'high', edited: false, parserVersion: 1, candidateKey: `monster:glimmerwing-drake:${gloamwoodEntryId('Glimmerwing Drake')}`,
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

  it('re-runs without destroying work: same results are not rewritten, edits get a proposal, rejected and pack records stay', async () => {
    await importBook();
    await detectStructure(SOURCE);
    const before = await listRecords(SOURCE);
    const hound = byName(before, 'Bramble Hound')!;
    const choir = byName(before, 'Ashen Choir')!;
    const cloak = byName(before, 'Mothsilk Cloak')!;
    const drake = byName(before, 'Glimmerwing Drake')!;
    await putRecords([
      { ...hound, edited: true, data: { ...hound.data!, hp: 30 } as StructuredRecord['data'], updatedAt: 1 },
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
