import { describe, expect, it } from 'vitest';
import type { CompendiumEntry, MonsterData, StructuredRecord } from '@/types';
import {
  gloamwoodEntries,
  gloamwoodEntryId,
  gloamwoodRecords,
  gloamwoodSource,
  GLOAMWOOD_TITLE,
  structuredRecord,
} from '@/test/structuredFixtures';
import { costText, isReviewedImport, itemText, materializeEntries, sectionText, signed, summaryFor } from './materialize';

const entries = gloamwoodEntries();
const sources = [gloamwoodSource()];
const accepted = gloamwoodRecords('gloam', { status: 'accepted' }).filter((r) => r.data !== null);
const byName = (list: readonly CompendiumEntry[], name: string) => list.find((e) => e.name === name);
const record = (name: string) => accepted.find((r) => r.name === name) as StructuredRecord;
const id = (name: string) => gloamwoodEntryId(name);

describe('materializeEntries', () => {
  const out = materializeEntries(entries, accepted, sources);
  const ids = out.map((e) => e.id);

  it('returns its input when nothing is accepted (the no-imports identity)', () => {
    expect(materializeEntries(entries, [], sources)).toBe(entries);
    const pending = gloamwoodRecords().filter((r) => r.data !== null);
    expect(materializeEntries(entries, pending, sources)).toBe(entries);
  });

  it('keeps a one-entry record on its chunk id, re-kinded, with SRD-shaped data and the record id', () => {
    const drake = out.find((e) => e.id === id('Glimmerwing Drake')) as CompendiumEntry;
    expect(drake).toMatchObject({
      kind: 'monster',
      name: 'Glimmerwing Drake',
      sourceId: 'gloam',
      sourceName: GLOAMWOOD_TITLE,
      summary: 'CR 3 (700 XP) · Large Dragon',
      path: ['Bestiary', 'Glimmerwing Drake'],
    });
    expect(drake.text).toBe(byName(entries, 'Glimmerwing Drake')?.text);
    expect(drake.data).toMatchObject({
      cr: '3', crValue: 3, xp: 700, pb: 2, size: 'Large', type: 'Dragon', ac: 17, acNote: 'natural armor', hp: 52, hitDice: '8d10 + 8',
      speeds: { walk: 30, fly: 60, hover: true }, initiative: 2, reachFt: 10, recordId: 'rec:gloam:monster:glimmerwing-drake', adaptations: [],
    });
    expect(drake.data).not.toHaveProperty('format');
    expect(drake.data).not.toHaveProperty('aliasIds');
    expect(isReviewedImport(drake)).toBe(true);
  });

  it('rejoins a part chain on the primary chunk and keeps the other parts as aliases', () => {
    const parts: CompendiumEntry[] = [
      { id: 'lib:p:1', sourceId: 'p', sourceName: 'P', kind: 'rule', name: 'Old Bear', text: 'Part one.', path: ['Beasts', 'Old Bear'] },
      { id: 'lib:p:2', sourceId: 'p', sourceName: 'P', kind: 'rule', name: 'Old Bear (part 2)', text: 'Part two.', path: ['Beasts', 'Old Bear (part 2)'] },
      { id: 'lib:p:3', sourceId: 'p', sourceName: 'P', kind: 'rule', name: 'Next', text: 'Next.' },
    ];
    const bear = structuredRecord('monster', 'Old Bear', { status: 'accepted', entryIds: ['lib:p:1', 'lib:p:2'], data: record('Bramble Hound').data as MonsterData }, 'p');
    const result = materializeEntries(parts, [bear], [gloamwoodSource('p')]);
    expect(result.map((e) => e.id)).toEqual(['lib:p:1', 'lib:p:3']);
    expect(result[0]).toMatchObject({ kind: 'monster', text: 'Part one.\n\nPart two.', data: { aliasIds: ['lib:p:2'] } });
  });

  it('merges a species section into one four-segment entry; its chunks become aliases', () => {
    const mothkin = out.find((e) => e.id === 'lib:gloam:species:mothkin') as CompendiumEntry;
    expect(mothkin).toMatchObject({ kind: 'species', name: 'Mothkin', summary: 'Small or Medium Humanoid · Speed 30 ft. · Darkvision 60 ft.' });
    expect(mothkin.data).toMatchObject({ creatureType: 'Humanoid', sizes: ['Small', 'Medium'], speed: 30, darkvision: 60, lineages: ['Ashwing', 'Silverwing'] });
    expect(mothkin.data?.aliasIds).toEqual([id('Mothkin'), id('Mothkin Lineages')]);
    expect(mothkin.text.startsWith(byName(entries, 'Mothkin')?.text as string)).toBe(true);
    expect(mothkin.text).toContain('\n\n### Mothkin Lineages\n\n| Lineage |');
    expect(ids).not.toContain(id('Mothkin'));
    expect(ids).not.toContain(id('Mothkin Lineages'));
  });

  it('turns a class into an overview entry and keeps its feature blocks as enriched rules', () => {
    const wick = out.find((e) => e.id === 'lib:gloam:class:wickwright') as CompendiumEntry;
    expect(wick).toMatchObject({ kind: 'class', name: 'Wickwright', summary: 'Intelligence · d8 Hit Die · Half spellcaster' });
    expect(wick.data).toMatchObject({
      hitDie: 8, primaryAbilities: ['int'], savingThrows: ['int', 'wis'], casterType: 'half', spellcastingAbility: 'int',
      subclasses: ['Order of the Long Wick'], subclassLevel: 3,
    });
    expect(wick.data?.aliasIds).toEqual([id('Wickwright'), id('Core Wickwright Traits'), id('Wickwright Class Features'), id('Wickwright Spell List')]);
    expect(wick.text).toContain('### Core Wickwright Traits');
    expect(wick.text).toContain('### Wickwright Spell List');
    expect(wick.text).not.toContain('Level 1: Wick Sense');

    const sense = out.find((e) => e.id === id('Level 1: Wick Sense')) as CompendiumEntry;
    expect(sense).toMatchObject({
      kind: 'rule',
      name: 'Wick Sense',
      summary: 'Wickwright feature (level 1)',
      path: ['Wickwright', 'Wickwright Class Features', 'Wick Sense'],
      data: { class: 'Wickwright', classId: 'lib:gloam:class:wickwright', level: 1 },
    });
    expect(sense.text).toBe(byName(entries, 'Level 1: Wick Sense')?.text);
    // Feature blocks aren't reviewed entries of their own (no stats line).
    expect(isReviewedImport(sense)).toBe(false);
  });

  it('gives subclass features the SRD subclass-feature shape, attached to the parent from review', () => {
    const ember = out.find((e) => e.id === 'lib:gloam:subclass:ember-warden') as CompendiumEntry;
    expect(ember).toMatchObject({ kind: 'subclass', summary: 'Fighter subclass · Guard the Flame Within', data: { class: 'Fighter', classId: 'srd:class:fighter', featureLevels: [3, 7] } });
    expect(out.find((e) => e.id === id('Level 3: Ember Ward'))).toMatchObject({
      kind: 'rule',
      name: 'Ember Ward',
      summary: 'Ember Warden feature (Fighter level 3)',
      data: { class: 'Fighter', classId: 'srd:class:fighter', subclass: 'Ember Warden', subclassId: 'lib:gloam:subclass:ember-warden', level: 3 },
    });
    const order = out.find((e) => e.id === 'lib:gloam:subclass:order-of-the-long-wick');
    expect(order?.data).toMatchObject({ class: 'Wickwright', classId: 'lib:gloam:class:wickwright' });
  });

  it('adds a gear row as an app-written item entry after its table, which stays a rule', () => {
    const table = ids.indexOf(id('Gloamwood Arms'));
    expect(table).toBeGreaterThan(-1);
    expect(out[table].kind).toBe('rule');
    const hookstaff = out[table + 1];
    expect(hookstaff).toMatchObject({
      id: 'lib:gloam:item:hookstaff',
      kind: 'item',
      name: 'Hookstaff',
      summary: 'Martial Melee Weapon · 1d8 Bludgeoning · Reach, Two-Handed',
      text: 'Hookstaff — Martial Melee Weapon. Damage 1d8 bludgeoning. Properties: Reach, Two-Handed. Mastery: Topple. 12 GP, 6 lb.',
      path: ['Gloamwood Gear', 'Gloamwood Arms', 'Hookstaff'],
      data: { category: 'weapon', weaponCategory: 'martial', weaponType: 'melee', damage: '1d8', damageType: 'bludgeoning', costGp: 12, weight: 6 },
    });
  });

  it('keeps reading order and leaves lore and unreviewed entries alone', () => {
    expect(byName(out, 'The Long Dusk')).toBe(byName(entries, 'The Long Dusk'));
    expect(out.find((e) => e.id === id('Goblin Warrior'))).toBe(entries.find((e) => e.id === id('Goblin Warrior')));
    const positions = ['The Long Dusk', 'Mothkin', 'Lamplighter', 'Ember Warden', 'Wickwright', 'Ashen Choir', 'Hookstaff', 'Glimmerwing Drake'].map((n) =>
      out.findIndex((e) => e.name === n),
    );
    expect(positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1]))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries adaptation notes for the stats line', () => {
    const hound = out.find((e) => e.id === id('Bramble Hound'));
    expect(hound?.data?.adaptations).toEqual([
      "Older stat block: its initiative is its Dexterity modifier and its proficiency bonus comes from its CR.",
    ]);
  });

  it('ignores pending, rejected, invalid and switched-off records', () => {
    const drake = record('Glimmerwing Drake');
    const invalid = { ...drake, data: { ...(drake.data as object), ac: 99 } } as StructuredRecord;
    for (const r of [{ ...drake, status: 'pending' as const }, { ...drake, status: 'rejected' as const }, invalid]) {
      expect(materializeEntries(entries, [r], sources)).toBe(entries);
    }
    expect(materializeEntries(entries, [drake], [])).toBe(entries);
    expect(materializeEntries(entries, [{ ...drake, schemaVersion: 99 }], sources)).toBe(entries);
    // A subclass without the parent chosen in review is never materialized.
    const { parentClassId: _parent, ...orphan } = record('Ember Warden');
    expect(materializeEntries(entries, [orphan as StructuredRecord], sources)).toBe(entries);
  });

  it('lets the first record claim a chunk when two records name it', () => {
    const drake = record('Glimmerwing Drake');
    const twin = { ...drake, id: 'rec:gloam:monster:twin', name: 'Twin Drake' };
    const result = materializeEntries(entries, [drake, twin], sources);
    expect(result.filter((e) => e.id === id('Glimmerwing Drake')).map((e) => e.name)).toEqual(['Glimmerwing Drake']);
  });
});

describe('summaries and app-written text', () => {
  it('writes summaries in the SRD style', () => {
    expect(summaryFor(record('Ashen Choir'))).toBe('Level 2 Evocation · Sorcerer, Wizard, Wickwright');
    expect(summaryFor(record('Cinder Mote'))).toBe('Evocation cantrip · Wickwright');
    expect(summaryFor(record('Mothsilk Cloak'))).toBe('Wondrous Item, uncommon (requires attunement)');
    expect(summaryFor(record("Warden's Mail"))).toBe('Armor (Chain Mail), rare');
    expect(summaryFor(record('Lantern Bearer'))).toBe('General Feat (Prerequisite: Level 4+)');
    expect(summaryFor(record("Moth's Grace"))).toBe('Origin Feat');
    expect(summaryFor(record('Lamplighter'))).toBe("Dex, Wis, Cha · Moth's Grace · Perception, Stealth");
    expect(summaryFor(record('Ferry Hand'))).toBe('Any three abilities · Origin feat: your choice · Athletics, Survival');
    expect(summaryFor(record('Wick Lantern'))).toBe('Adventuring Gear · 2 GP · 1 lb.');
  });

  it('formats prices, signs and items', () => {
    expect([costText(12), costText(0.5), costText(0.02)]).toEqual(['12 GP', '5 SP', '2 CP']);
    expect([signed(2), signed(0), signed(-1)]).toEqual(['+2', '+0', '−1']);
    expect(itemText('Iron Pot', { format: '2024', category: 'gear', costGp: 0.2, weight: 10 })).toBe('Iron Pot — Adventuring Gear. 2 SP, 10 lb.');
    expect(itemText('Bark Vest', { format: '2024', category: 'armor', armorType: 'light', armorClass: 11, dexCap: null, costGp: 5, weight: 8 })).toBe(
      'Bark Vest — Light Armor. AC 11 + Dex modifier. 5 GP, 8 lb.',
    );
  });

  it('joins a part chain inside a section without a heading', () => {
    const chunk = (id: string, name: string, text: string, path: string[]): CompendiumEntry => ({ id, sourceId: 'p', sourceName: 'P', kind: 'rule', name, text, path });
    const text = sectionText([
      chunk('lib:p:1', 'Fernfolk', 'Intro.', ['Peoples', 'Fernfolk']),
      chunk('lib:p:2', 'Fernfolk Traits', 'Traits one.', ['Peoples', 'Fernfolk', 'Fernfolk Traits']),
      chunk('lib:p:3', 'Fernfolk Traits (part 2)', 'Traits two.', ['Peoples', 'Fernfolk', 'Fernfolk Traits (part 2)']),
      chunk('lib:p:4', 'Old Roots', 'Deep.', ['Peoples', 'Fernfolk', 'Fernfolk Traits', 'Old Roots']),
    ]);
    expect(text).toBe('Intro.\n\n### Fernfolk Traits\n\nTraits one.\n\nTraits two.\n\n#### Old Roots\n\nDeep.');
  });

  it('re-levels a section’s headings like the importer', () => {
    const chunks = ['Bramblefolk', 'Thornback', 'Mossback'].map((n) => byName(entries, n) as CompendiumEntry);
    const text = sectionText(chunks);
    expect(text).toContain('\n\n### Thornback\n\nThornbacks grow sharp spines');
    expect(text).toContain('\n\n### Mossback\n\n');
  });
});
