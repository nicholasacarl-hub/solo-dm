import { describe, expect, it } from 'vitest';
import type { CompendiumEntry, StructuredRecord } from '@/types';
import { gloamwoodEntries, gloamwoodEntryId, gloamwoodRecords, gloamwoodSource } from '@/test/structuredFixtures';
import { materializeEntries } from './materialize';
import { statsLine } from './statsLine';

const accepted = gloamwoodRecords('gloam', { status: 'accepted' }).filter((r) => r.data !== null);
const index = materializeEntries(gloamwoodEntries(), accepted, [gloamwoodSource()]);
const entry = (id: string) => index.find((e) => e.id === id) as CompendiumEntry;
const chunk = (name: string) => entry(gloamwoodEntryId(name));

describe('statsLine (spec §6.7)', () => {
  it('writes one line per kind from the reviewed fields', () => {
    expect(statsLine(chunk('Glimmerwing Drake'))).toBe(
      'Reviewed stats: Large Dragon · AC 17 (natural armor) · HP 52 (8d10 + 8) · Speed 30 ft., fly 60 ft. (hover) · Initiative +2 · CR 3 (700 XP; PB +2) · Reach 10 ft.',
    );
    expect(statsLine(chunk('Ashen Choir'))).toBe(
      'Reviewed stats: Level 2 Evocation · Action · Self (15-foot cone) · 15-ft cone · DEX save · 3d8 fire · Sorcerer, Wizard, Wickwright',
    );
    expect(statsLine(chunk('Cinder Mote'))).toBe('Reviewed stats: Evocation cantrip · Action · 60 feet · ranged spell attack · 1d10 fire · Wickwright');
    expect(statsLine(chunk('Mothsilk Cloak'))).toBe('Reviewed stats: Wondrous item, uncommon, requires attunement · +1 AC and saving throws while worn');
    expect(statsLine(chunk("Warden's Mail"))).toBe('Reviewed stats: Armor (Chain Mail), rare · +1 AC while worn');
    expect(statsLine(chunk('Lantern of Hollow Light'))).toBe('Reviewed stats: Wondrous item, uncommon, requires attunement · 3 charges');
    expect(statsLine(entry('lib:gloam:item:hookstaff'))).toBe(
      'Reviewed stats: Martial melee weapon · 1d8 bludgeoning · Reach, Two-Handed · mastery Topple · 12 GP, 6 lb.',
    );
    expect(statsLine(chunk('Wick Lantern'))).toBe('Reviewed stats: Adventuring gear · 2 GP, 1 lb.');
    expect(statsLine(chunk('Lantern Bearer'))).toBe('Reviewed stats: General feat · Prerequisite: Level 4+ · +1 Wisdom or Charisma');
    expect(statsLine(entry('lib:gloam:background:lamplighter'))).toBe(
      "Reviewed stats: Dex, Wis, Cha · Origin feat Moth's Grace · Perception, Stealth · Tinker's Tools",
    );
    expect(statsLine(entry('lib:gloam:species:mothkin'))).toBe(
      'Reviewed stats: Small or Medium Humanoid · Speed 30 ft. · Darkvision 60 ft. · lineages Ashwing, Silverwing',
    );
    expect(statsLine(entry('lib:gloam:class:wickwright'))).toBe(
      'Reviewed stats: d8 Hit Die · saves INT, WIS · half caster (Intelligence) · subclass at level 3',
    );
    expect(statsLine(entry('lib:gloam:subclass:ember-warden'))).toBe('Reviewed stats: Fighter subclass · features at levels 3, 7');
  });

  it('appends "Adapted for 2024" with the app-written notes of older-format content', () => {
    expect(statsLine(chunk('Bramble Hound'))).toBe(
      'Reviewed stats: Medium Monstrosity · AC 13 (natural armor) · HP 22 (4d8 + 4) · Speed 40 ft. · Initiative +1 · CR 1 (200 XP; PB +2) · Reach 5 ft.\n' +
        "Adapted for 2024: Older stat block: its initiative is its Dexterity modifier and its proficiency bonus comes from its CR.",
    );
    const ferry = statsLine(entry('lib:gloam:background:ferry-hand'));
    expect(ferry.split('\n')[0]).toBe('Reviewed stats: Any three abilities · Origin feat of your choice · Athletics, Survival · Vehicles (Water)');
    expect(ferry.split('\n')[1]).toMatch(/^Adapted for 2024: Older edition: Ferry Hand doesn't list ability scores/);
  });

  it("is empty for SRD entries, raw chunks and a book's feature blocks", () => {
    expect(statsLine({ id: 'srd:monster:goblin-warrior', sourceId: 'srd-5.2.1', sourceName: 'SRD 5.2.1', kind: 'monster', name: 'Goblin Warrior', text: '', data: { ac: 15 } })).toBe('');
    expect(statsLine(chunk('Goblin Warrior'))).toBe('');
    expect(statsLine(chunk('Level 3: Ember Ward'))).toBe('');
  });

  it('describes armor, shields and ritual or concentration spells', () => {
    const reviewed = (kind: CompendiumEntry['kind'], data: Record<string, unknown>): CompendiumEntry => ({
      id: 'lib:x:1', sourceId: 'x', sourceName: 'X', kind, name: 'X', text: '', data: { recordId: 'rec:x', adaptations: [], ...data },
    });
    expect(statsLine(reviewed('item', { category: 'armor', armorType: 'medium', armorClass: 14, dexCap: 2, stealthDisadvantage: true, costGp: 400, weight: 20 }))).toBe(
      'Reviewed stats: Medium armor · AC 14 + Dex (max 2) · Stealth disadvantage · 400 GP, 20 lb.',
    );
    expect(statsLine(reviewed('item', { category: 'armor', armorType: 'heavy', armorClass: 18, dexCap: 0, strengthRequirement: 15 }))).toBe('Reviewed stats: Heavy armor · AC 18 · Str 15');
    expect(statsLine(reviewed('item', { category: 'shield', armorClass: 2, costGp: 10, weight: 6 }))).toBe('Reviewed stats: Shield · +2 AC · 10 GP, 6 lb.');
    expect(statsLine(reviewed('spell', { level: 1, school: 'Divination', ritual: true, concentration: true, castingTime: '1 minute', range: 'Self', duration: 'Concentration, up to 1 hour', classes: ['Wickwright'] }))).toBe(
      'Reviewed stats: Level 1 Divination (ritual) · 1 minute · Self · Concentration · Wickwright',
    );
    expect(statsLine(reviewed('magic-item', { category: 'ring', rarity: 'varies', rarityText: 'Rare (+1), Very Rare (+2)', attunement: 'by a Wizard', bonuses: { ac: 1, acOnlyWhen: 'no-armor' } }))).toBe(
      'Reviewed stats: Ring, rare (+1), very rare (+2), requires attunement by a Wizard · +1 AC while worn (AC without armor)',
    );
  });

  it('leaves out what a reviewed entry does not have, and never throws on odd data', () => {
    const odd: CompendiumEntry = { id: 'lib:x:1', sourceId: 'x', sourceName: 'X', kind: 'monster', name: 'Odd', text: '', data: { recordId: 'rec:x', ac: 'high', speed: 7 } };
    expect(statsLine(odd)).toBe('');
    const negative = { ...chunk('Glimmerwing Drake'), data: { ...chunk('Glimmerwing Drake').data, initiative: -1, xp: 1800 } };
    expect(statsLine(negative)).toContain('Initiative −1 · CR 3 (1,800 XP; PB +2)');
  });

  it('describes the 2014 subclass at its printed levels', () => {
    const dusk = accepted.find((r) => r.name === 'Dusk Domain') as StructuredRecord;
    const out = materializeEntries(gloamwoodEntries(), [dusk], [gloamwoodSource()]);
    expect(statsLine(out.find((e) => e.id === 'lib:gloam:subclass:dusk-domain') as CompendiumEntry)).toBe('Reviewed stats: Cleric subclass · features at levels 1, 2, 6');
  });
});
