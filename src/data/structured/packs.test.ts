import { describe, expect, it } from 'vitest';
import packsDoc from '../../../docs/PACKS.md?raw';
import { parseJsonImport } from '@/data/jsonImport';
import {
  FIXTURE_TIME,
  GLOAMWOOD_TITLE,
  gloamwoodEntries,
  gloamwoodRecords,
  gloamwoodSource,
} from '@/test/structuredFixtures';
import type { FeatData, StructuredRecord, SubclassData } from '@/types';
import { exportPack, isPackFile, parsePack, type PackFileV1 } from './packs';

const OPTS = { sourceId: 'pack', sourceName: 'The Lantern Road (sample pack)', now: FIXTURE_TIME };

/** The JSON example in docs/PACKS.md. */
function docExample(): Record<string, unknown> {
  const block = /```json\n([\s\S]*?)\n```/.exec(packsDoc);
  if (!block) throw new Error('docs/PACKS.md has no JSON example');
  return JSON.parse(block[1]) as Record<string, unknown>;
}

describe('parsePack (spec §3.12)', () => {
  it('reads the documented example: entries re-homed, every record pending, nothing skipped', () => {
    const json = docExample();
    expect(isPackFile(json)).toBe(true);
    const pack = parsePack(json, OPTS);
    expect(pack.issues).toEqual([]);
    expect(pack.source).toMatchObject({ title: 'The Lantern Road (sample pack)', license: 'CC-BY-4.0', attribution: 'Written for the Solo DM documentation.' });
    expect(pack.source.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(pack.entries.slice(0, 4).map((e) => [e.id, e.name, e.kind])).toEqual([
      ['lib:pack:1', 'Spark Lash', 'spell'],
      ['lib:pack:2', 'Road Warden', 'feat'],
      ['lib:pack:3', 'Fighter Subclass: Lamp Keeper', expect.any(String)],
      ['lib:pack:4', 'Cinder Hound', 'monster'],
    ]);
    expect(pack.records.map((r) => [r.id, r.kind, r.status, r.origin, r.publicId])).toEqual([
      ['rec:pack:spell:spark-lash', 'spell', 'pending', 'pack', 'lib:pack:1'],
      ['rec:pack:feat:road-warden', 'feat', 'pending', 'pack', 'lib:pack:2'],
      ['rec:pack:subclass:lamp-keeper', 'subclass', 'pending', 'pack', 'lib:pack:subclass:lamp-keeper'],
      ['rec:pack:monster:cinder-hound', 'monster', 'pending', 'pack', 'lib:pack:4'],
    ]);
    expect((pack.records[1].data as FeatData).text).toEqual({ entryIds: ['lib:pack:2'], from: 2, to: 2 });
    expect(pack.reviewedElsewhere).toBe(0);
  });

  it('turns inline text into entries of their own, and attaches a subclass to an SRD class', () => {
    const pack = parsePack(docExample(), OPTS);
    const keeper = pack.records.find((r) => r.name === 'Lamp Keeper') as StructuredRecord<'subclass'>;
    expect(keeper.parentClassId).toBe('srd:class:fighter');
    const features = (keeper.data as SubclassData).features;
    expect(features.map((f) => f.text)).toEqual([
      { entryIds: ['lib:pack:5'], from: 1, to: 1 },
      { entryIds: ['lib:pack:6'], from: 1, to: 1 },
    ]);
    expect(pack.entries.slice(4)).toEqual([
      expect.objectContaining({ id: 'lib:pack:5', kind: 'rule', name: 'Steady Lamp', path: ['Lamp Keeper', 'Steady Lamp'] }),
      expect.objectContaining({ id: 'lib:pack:6', kind: 'rule', name: 'Long Watch', path: ['Lamp Keeper', 'Long Watch'] }),
    ]);
    expect(keeper.entryIds).toEqual(['lib:pack:3', 'lib:pack:5', 'lib:pack:6']);
    // A subclass whose class is nowhere blocks Accept until the player picks one.
    const json = docExample();
    const records = (json.records as Record<string, unknown>[]).map((r) => (r.name === 'Lamp Keeper' ? { ...r, parentClass: 'Lamplighter Knight', data: { ...(r.data as object), parentClass: 'Lamplighter Knight' } } : r));
    const orphan = parsePack({ ...json, records }, OPTS).records.find((r) => r.name === 'Lamp Keeper');
    expect(orphan?.parentClassId).toBeUndefined();
    expect(orphan?.warnings).toContainEqual(expect.objectContaining({ code: 'unresolved-ref', severity: 'block' }));
  });

  it('skips an invalid record with its path while the rest import, and notes it on the source', () => {
    const json = docExample();
    const records = json.records as Record<string, unknown>[];
    const broken = [
      { ...records[0], data: { ...(records[0].data as object), level: 12 } },
      records[1],
      { ...records[3], data: { ...(records[3].data as object), sneaky: true } },
      { ...records[1], name: 'Lost Feat', entries: ['nowhere'] },
      { ...records[1], name: 'Long Span', data: { ...(records[1].data as object), text: { entries: ['road-warden'], from: 2, to: 9 } } },
    ];
    const pack = parsePack({ ...json, records: broken }, OPTS);
    // A "__proto__" key in the file's data is an unknown key like any other (spec §2.8).
    const sneaky = JSON.parse(`{"__proto__": {"polluted": true}, ${JSON.stringify(records[1].data).slice(1)}`) as Record<string, unknown>;
    const proto = parsePack({ ...json, records: [{ ...records[1], data: sneaky }] }, OPTS);
    expect(proto.records).toEqual([]);
    expect(proto.issues[0].path).toBe('records[0].data');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(pack.records.map((r) => r.name)).toEqual(['Road Warden']);
    expect(pack.issues.map((i) => i.path)).toEqual(['records[0].data.level', 'records[2].data', 'records[3].entries[0]', 'records[4].data.text']);
    expect(pack.source.notes).toMatch(/^4 records in this pack couldn't be read and were skipped: Spark Lash \(records\[0\]\.data\.level: /);
  });

  it('fails the whole file for an entry it cannot read, or a file it cannot use', () => {
    const json = docExample();
    const entries = json.entries as Record<string, unknown>[];
    expect(() => parsePack({ ...json, entries: [...entries, { id: 'x', name: '', text: 'No name.' }] }, OPTS)).toThrow(/entries\[4\]\.name/);
    expect(() => parsePack({ ...json, entries: [...entries, entries[0]] }, OPTS)).toThrow(/the id "spark-lash" appears twice/);
    expect(() => parsePack({ ...json, entries: [] }, OPTS)).toThrow(/the pack has no entries/);
    expect(() => parsePack({ ...json, version: 2 }, OPTS)).toThrow(/newer version of Solo DM \(pack format 2\)/);
    expect(() => parsePack({ ...json, schemaVersion: 3 }, OPTS)).toThrow(/data version 3/);
    expect(() => parsePack({ ...json, format: 'other' }, OPTS)).toThrow(/format marker/);
    expect(() => parsePack({ ...json, title: '  ' }, OPTS)).toThrow(/title/);
  });

  it('leaves legacy JSON imports to the old reader, unchanged', () => {
    const legacy = [{ name: 'Lantern Oil', kind: 'item', text: 'Burns green for an hour.' }];
    expect(isPackFile(legacy)).toBe(false);
    expect(isPackFile({ entries: legacy })).toBe(false);
    const read = parseJsonImport(JSON.stringify(legacy), { sourceId: 'old', sourceName: 'Old Notes' });
    expect(read).toEqual([expect.objectContaining({ sourceId: 'old', sourceName: 'Old Notes', kind: 'item', name: 'Lantern Oil', text: 'Burns green for an hour.' })]);
  });
});

describe('exportPack → parsePack ("Download book data", spec §3.12)', () => {
  const source = gloamwoodSource();
  const entries = gloamwoodEntries();
  const all = gloamwoodRecords();
  // On the first device: most records accepted, one kept as text, the rest pending.
  const records = all.map((r): StructuredRecord => {
    if (r.name === 'Watchlight Vigil') return { ...r, status: 'rejected' };
    if (['Glimmerwing Drake', 'Ember Warden', 'Wickwright', 'Order of the Long Wick', 'Mothkin', 'Hookstaff'].includes(r.name)) return { ...r, status: 'accepted' };
    return r;
  });
  const file: PackFileV1 = JSON.parse(JSON.stringify(exportPack(source, [...entries].reverse(), records))) as PackFileV1;

  it('writes every entry in ordinal order and the non-rejected records that have data, with their status', () => {
    expect(file).toMatchObject({ format: 'solo-dm-pack', version: 1, schemaVersion: 1, title: GLOAMWOOD_TITLE, bookFingerprint: source.fingerprint });
    expect(file.entries.map((e) => e.id)).toEqual(entries.map((e) => e.id));
    const names = (file.records ?? []).map((r) => r.name);
    expect(names).not.toContain('Watchlight Vigil');
    expect(names).not.toContain('Goblin Warrior'); // no data
    expect(names).not.toContain('Gloamwood Arms'); // the table record; its row is there
    expect(names).toContain('Hookstaff');
    expect((file.records ?? []).find((r) => r.name === 'Order of the Long Wick')).toMatchObject({ parentClass: 'Wickwright', reviewedStatus: 'accepted' });
    expect((file.records ?? []).find((r) => r.name === 'Ember Warden')?.parentClass).toBe('Fighter');
    expect((file.records ?? []).find((r) => r.name === "Moth's Grace")).toMatchObject({ reviewedStatus: 'pending', data: { text: { entries: ['lib:gloam:35'], from: 2, to: 2 } } });
  });

  it('round-trips onto a new source: ordinals kept, references intact, accepted ones offered, never applied', () => {
    const pack = parsePack(file, { sourceId: 'copy', sourceName: GLOAMWOOD_TITLE, now: FIXTURE_TIME });
    expect(pack.issues).toEqual([]);
    expect(pack.source.fingerprint).toBe(source.fingerprint);
    expect(pack.entries.map((e) => e.id)).toEqual(entries.map((e) => e.id.replace('lib:gloam:', 'lib:copy:')));
    expect(pack.entries.map((e) => e.text)).toEqual(entries.map((e) => e.text));
    const byName = new Map(pack.records.map((r) => [r.name, r]));
    const original = new Map(records.map((r) => [r.name, r]));
    for (const [name, r] of byName) {
      const before = original.get(name) as StructuredRecord;
      expect(r.status).toBe('pending');
      expect(r.entryIds).toEqual(before.entryIds.map((id) => id.replace('lib:gloam:', 'lib:copy:')));
      expect(r.publicId).toBe(before.publicId.replace('lib:gloam:', 'lib:copy:'));
      expect(r.id).toBe(before.id.replace('rec:gloam:', 'rec:copy:'));
      expect(JSON.stringify(r.data)).toBe(JSON.stringify(before.data).replaceAll('lib:gloam:', 'lib:copy:'));
      expect(Boolean(r.reviewedElsewhere)).toBe(before.status === 'accepted');
    }
    expect(pack.reviewedElsewhere).toBe(6);
    expect(byName.get('Order of the Long Wick')?.parentClassId).toBe('lib:copy:class:wickwright');
    expect(byName.get('Ember Warden')?.parentClassId).toBe('srd:class:fighter');
    expect(byName.get('Hookstaff')).toMatchObject({ span: 'row', rowIndex: 0, publicId: 'lib:copy:item:hookstaff' });
  });
});
