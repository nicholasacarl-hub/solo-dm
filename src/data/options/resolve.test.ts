/**
 * Option lookups (spec §5.2): id first; an imported id never binds to an SRD option by name, nor the
 * reverse; same book → SRD → other books. Invented fixture content only.
 */
import { describe, expect, it } from 'vitest';
import { EXPECTED_MERGED, GLOAMWOOD_TITLE, gloamwoodEntryId, importedRef } from '@/test/structuredFixtures';
import type { Character, ClassOption, EquipmentOption, FeatOption, OptionSource } from '@/types';
import {
  backgroundOptionFor,
  classByName,
  classOptionFor,
  findCatalogOption,
  findEquipment,
  findFeat,
  inventoryFromOption,
  isImportedId,
  optionSourceLabel,
  primaryRuleOf,
  speciesOptionFor,
  subclassOptionFor,
  suggestParentClass,
} from './resolve';

const source = (sourceId: string, title: string): OptionSource => ({ sourceId, title, recordId: `rec:${sourceId}:class:x`, format: '2024', adaptations: [] });
const srdFighter = EXPECTED_MERGED.classes.find((c) => c.id === 'srd:class:fighter') as ClassOption;
const bookFighter: ClassOption = { ...srdFighter, id: 'lib:gloam:class:fighter', source: source('gloam', GLOAMWOOD_TITLE), subclasses: [] };
const otherFighter: ClassOption = { ...srdFighter, id: 'lib:other:class:fighter', source: source('other', 'Other Notes'), subclasses: [] };
const classes = [...EXPECTED_MERGED.classes, bookFighter, otherFighter];

describe('isImportedId and optionSourceLabel', () => {
  it('tells library ids apart and labels the source', () => {
    expect(isImportedId('lib:gloam:3')).toBe(true);
    expect(isImportedId('srd:class:fighter')).toBe(false);
    expect(isImportedId(undefined)).toBe(false);
    expect(optionSourceLabel(srdFighter)).toBe('SRD 5.2.1');
    expect(optionSourceLabel(bookFighter)).toBe(GLOAMWOOD_TITLE);
  });
});

describe('classOptionFor', () => {
  it('resolves by id first', () => {
    expect(classOptionFor({ classId: 'lib:gloam:class:fighter', name: 'Fighter' }, classes)).toBe(bookFighter);
    expect(classOptionFor({ classId: 'srd:class:fighter', name: 'Fighter' }, classes)).toBe(srdFighter);
  });

  it('never binds an imported id to the SRD Fighter by name (another device: by ref, else nothing)', () => {
    expect(classOptionFor({ classId: 'lib:elsewhere:class:fighter', name: 'Fighter' }, classes)).toBeUndefined();
    const ref = importedRef({ entryId: 'lib:elsewhere:class:fighter', kind: 'class', entryName: 'Fighter', part: undefined, sourceId: 'elsewhere' });
    expect(classOptionFor({ classId: 'lib:elsewhere:class:fighter', name: 'Fighter', ref }, classes)).toBe(bookFighter);
    const other = importedRef({ ...ref, sourceTitle: 'Other Notes', sourceId: 'gone' });
    expect(classOptionFor({ classId: 'lib:gone:class:fighter', name: 'Fighter', ref: other }, classes)).toBe(otherFighter);
  });

  it('falls back to the name among SRD options only (old sheets without SRD ids)', () => {
    expect(classOptionFor({ classId: 'class:fighter', name: 'Fighter' }, classes)).toBe(srdFighter);
    expect(classOptionFor({ classId: 'class:wickwright', name: 'Wickwright' }, classes)).toBeUndefined();
  });
});

describe('subclassOptionFor', () => {
  const ember = srdFighter.subclasses.find((s) => s.name === 'Ember Warden');
  const champion = srdFighter.subclasses.find((s) => s.name === 'Champion');

  it('resolves by subclassId, else by a unique name', () => {
    expect(subclassOptionFor({ subclass: 'Ember Warden', subclassId: 'lib:gloam:subclass:ember-warden' }, srdFighter)).toBe(ember);
    expect(subclassOptionFor({ subclass: 'Champion' }, srdFighter)).toBe(champion);
    expect(subclassOptionFor({ subclass: 'Ember Warden' }, srdFighter)).toBe(ember);
    expect(subclassOptionFor({ subclass: 'Nobody' }, srdFighter)).toBeUndefined();
  });

  it('keeps imported and SRD subclasses apart when they share a name', () => {
    const lookalike = { ...ember!, id: 'lib:gloam:subclass:champion', name: 'Champion' };
    const cls = { ...srdFighter, subclasses: [...srdFighter.subclasses, lookalike] };
    expect(subclassOptionFor({ subclass: 'Champion' }, cls)).toBe(champion);
    expect(subclassOptionFor({ subclass: 'Champion', subclassId: 'srd:subclass:champion' }, cls)).toBe(champion);
    expect(subclassOptionFor({ subclass: 'Champion', subclassId: 'lib:moved:subclass:champion' }, cls)).toBe(lookalike);
  });
});

describe('species and background lookups', () => {
  const mothkin = EXPECTED_MERGED.species.find((s) => s.name === 'Mothkin');
  const lamplighter = EXPECTED_MERGED.backgrounds.find((b) => b.name === 'Lamplighter');
  const c = (patch: Partial<Character>) => ({ species: '', background: '', ...patch });

  it('resolves by id, else (imported ids) by ref', () => {
    expect(speciesOptionFor(c({ species: 'Mothkin (Ashwing lineage)', speciesId: 'lib:gloam:species:mothkin' }), EXPECTED_MERGED.species)).toBe(mothkin);
    expect(speciesOptionFor(c({ species: 'Mothkin', speciesId: 'lib:x:species:mothkin' }), EXPECTED_MERGED.species)).toBeUndefined();
    const speciesRef = importedRef({ entryId: 'lib:x:species:mothkin', kind: 'species', entryName: 'Mothkin', part: undefined, sourceId: 'x' });
    expect(speciesOptionFor(c({ species: 'Mothkin', speciesId: 'lib:x:species:mothkin', speciesRef }), EXPECTED_MERGED.species)).toBe(mothkin);
    expect(backgroundOptionFor(c({ background: 'Lamplighter', backgroundId: lamplighter?.id }), EXPECTED_MERGED.backgrounds)).toBe(lamplighter);
  });

  it('never matches an imported option by name for a sheet without ids', () => {
    expect(speciesOptionFor(c({ species: 'Mothkin (Ashwing lineage)' }), EXPECTED_MERGED.species)).toBeUndefined();
    expect(backgroundOptionFor(c({ background: 'Lamplighter' }), EXPECTED_MERGED.backgrounds)).toBeUndefined();
  });
});

describe('findFeat', () => {
  const feat = (id: string, name: string, src?: OptionSource): FeatOption => ({ id, name, category: 'origin', description: '', ...(src ? { source: src } : {}) });
  const srdAlert = feat('srd:feat:alert', 'Alert');
  const bookAlert = feat('lib:gloam:9', 'Alert', source('gloam', GLOAMWOOD_TITLE));
  const otherAlert = feat('lib:other:4', 'Alert', source('other', 'Other Notes'));
  const feats = [otherAlert, srdAlert, bookAlert, feat('srd:feat:magic-initiate', 'Magic Initiate')];

  it('prefers the same book, then the SRD, then other books', () => {
    expect(findFeat(feats, 'Alert', 'gloam')).toBe(bookAlert);
    expect(findFeat(feats, 'Alert')).toBe(srdAlert);
    expect(findFeat([otherAlert], 'Alert', 'gloam')).toBe(otherAlert);
  });

  it('matches the base name before "(…)" after exact names', () => {
    expect(findFeat(feats, 'Magic Initiate (Cleric)')?.id).toBe('srd:feat:magic-initiate');
    expect(findFeat(EXPECTED_MERGED.feats, "Moth's Grace", 'gloam')?.source?.title).toBe(GLOAMWOOD_TITLE);
  });
});

describe('findEquipment', () => {
  const catalog = EXPECTED_MERGED.equipment;

  it('matches package names like the builder always did', () => {
    expect(findEquipment('Daggers', catalog)?.option.name).toBe('Dagger');
    expect(findEquipment('Oil (2 flasks)', catalog)?.option.name).toBe('Oil');
    expect(findEquipment('Hookstaff', catalog, 'gloam')).toMatchObject({ via: 'name', option: { id: 'lib:gloam:item:hookstaff' } });
    expect(findEquipment('Lute', catalog)).toBeNull();
  });

  it('prefers the same book over the SRD and never matches a magic item', () => {
    const bookRope: EquipmentOption = { id: 'lib:gloam:item:rope', name: 'Rope', category: 'gear', source: source('gloam', GLOAMWOOD_TITLE) };
    const withRope = [...catalog, bookRope];
    expect(findEquipment('Rope', withRope, 'gloam')?.option).toBe(bookRope);
    expect(findEquipment('Rope', withRope)?.option.id).toBe('srd:item:rope');
    expect(findEquipment("Warden's Mail", catalog)).toBeNull();
    expect(findCatalogOption("warden's mail", catalog)?.magic?.rarity).toBe('rare');
  });
});

describe('classByName', () => {
  it("prefers the hero's own class, then the SRD, and reports ties", () => {
    const tie = classByName(classes, 'fighter');
    expect(tie.option).toBe(srdFighter);
    expect(tie.others).toEqual([bookFighter, otherFighter]);
    const hero = { classes: [{ classId: 'lib:gloam:class:fighter', name: 'Fighter', level: 3, hitDie: 10, casterType: 'none' }] } as unknown as Character;
    expect(classByName(classes, 'Fighter', hero).option).toBe(bookFighter);
    expect(classByName(classes, 'Wickwright')).toEqual({ option: EXPECTED_MERGED.classes[2], others: [] });
    expect(classByName(classes, 'Nobody')).toEqual({ others: [] });
  });
});

describe('primaryRuleOf', () => {
  it('reads the explicit rule, else the SRD Fighter is "any" and everyone else "all"', () => {
    expect(primaryRuleOf(srdFighter)).toBe('any');
    expect(primaryRuleOf({ id: 'lib:gloam:class:fighter' })).toBe('all');
    expect(primaryRuleOf({ id: 'lib:gloam:class:fighter', primaryAbilityRule: 'any' })).toBe('any');
    expect(primaryRuleOf({ id: 'srd:class:fighter', primaryAbilityRule: 'all' })).toBe('all');
  });
});

describe('suggestParentClass', () => {
  const list = [
    { id: 'srd:class:fighter', name: 'Fighter' },
    { id: 'srd:class:cleric', name: 'Cleric' },
    { id: 'lib:gloam:class:wickwright', name: 'Wickwright', sourceId: 'gloam' },
    { id: 'lib:a:class:lamplord', name: 'Lamplord', sourceId: 'a' },
    { id: 'lib:b:class:lamplord', name: 'Lamplord', sourceId: 'b' },
    { id: 'lib:c:class:tidecaller', name: 'Tidecaller', sourceId: 'c' },
  ];

  it('gives each reason', () => {
    expect(suggestParentClass('Wickwright', 'gloam', list)).toMatchObject({ id: 'lib:gloam:class:wickwright', reason: 'same-book' });
    expect(suggestParentClass('fighter', 'gloam', list)).toMatchObject({ id: 'srd:class:fighter', reason: 'srd' });
    expect(suggestParentClass('Tidecaller', 'gloam', list)).toMatchObject({ id: 'lib:c:class:tidecaller', reason: 'other-book' });
    const ambiguous = suggestParentClass('Lamplord', 'gloam', list);
    expect(ambiguous).toEqual({ reason: 'ambiguous', candidates: [{ id: 'lib:a:class:lamplord', name: 'Lamplord' }, { id: 'lib:b:class:lamplord', name: 'Lamplord' }] });
    expect(suggestParentClass('Nobody', 'gloam', list)).toEqual({ reason: 'missing', candidates: [] });
    expect(suggestParentClass('', 'gloam', list)).toEqual({ reason: 'missing', candidates: [] });
  });
});

describe('inventoryFromOption', () => {
  const byName = (name: string) => EXPECTED_MERGED.equipment.find((e) => e.name === name) as EquipmentOption;

  it("copies Warden's Mail's numbers and a ref, with an app-written description (no book text)", () => {
    const item = inventoryFromOption(byName("Warden's Mail"), 1, EXPECTED_MERGED.equipment);
    expect(item).toEqual({
      name: "Warden's Mail",
      quantity: 1,
      category: 'armor',
      compendiumId: gloamwoodEntryId("Warden's Mail"),
      weight: 55,
      description: 'Rare armor (Chain Mail) · +1 AC',
      armor: { kind: 'armor', armorType: 'heavy', baseAc: 16, dexCap: 0, strength: 13, stealthDisadvantage: true },
      magic: true,
      bonuses: { ac: 1 },
      requiresAttunement: false,
      ref: expect.objectContaining({ kind: 'magic-item', entryName: "Warden's Mail", textCopied: false, textHash: '' }),
    });
  });

  it('marks attunement for the Mothsilk Cloak and copies its bonuses', () => {
    const item = inventoryFromOption(byName('Mothsilk Cloak'), 1);
    expect(item).toMatchObject({ category: 'gear', magic: true, requiresAttunement: true, bonuses: { ac: 1, savingThrows: 1 } });
    expect(item.description).toBe('Uncommon magic item, requires attunement · +1 AC and saving throws');
    expect(item.armor).toBeUndefined();
  });

  it('gives an imported weapon a numbers-only description and an SRD item its own', () => {
    expect(inventoryFromOption(byName('Hookstaff'), 1).description).toBe('Martial melee weapon · 1d8 bludgeoning · Reach, Two-Handed · mastery Topple');
    expect(inventoryFromOption(byName('Hookstaff'), 1).ref).toMatchObject({ kind: 'item', textCopied: false });
    const rope = inventoryFromOption(byName('Rope'), 1);
    expect(rope.ref).toBeUndefined();
    expect(rope.description).toBe(byName('Rope').description);
  });
});
