/**
 * The builder against the real SRD 5.2.1 data in public/srd/ (CC-BY-4.0): level 1 class choices,
 * feature uses and how they scale with the class tables (SRD "Barbarian Class Features" etc.),
 * species uses and Resistances ("Character Origins"), the Thaumaturge / Magician skill bonus,
 * cantrip attacks ("Cantrip Upgrade"), and the refresh after a level-up. The engine is the test
 * fake, so these exercise only the builder's reading of the data.
 */
import { describe, expect, it, vi } from 'vitest';
import builderRaw from '../../../public/srd/builder.json?raw';
import compendiumRaw from '../../../public/srd/compendium.json?raw';
import type { Rng } from '@/engine';
import type { BuilderData, Character, CompendiumEntry, Feature } from '@/types';
import { letDmBuildAll } from './autofill';
import { featureUseChanges, refreshFeatureUses } from './leveling';
import { buildCharacter, classChoiceFeatures, emptyDraft, inferFeatureUses, spellAttack, spellInfo, validateStep, type BuilderContext, type BuilderDraft } from './logic';

vi.mock('@/engine', async () => (await import('./testing/fakeEngine')).fakeEngine);

const data = JSON.parse(builderRaw) as BuilderData;
const spells = (JSON.parse(compendiumRaw) as CompendiumEntry[]).filter((e) => e.kind === 'spell').map(spellInfo);
const ctx: BuilderContext = { data, spells };
const rng: Rng = { next: () => 0 };

const cls = (name: string) => data.classes.find((c) => c.name === name)!;
const speciesId = (name: string) => data.species.find((s) => s.name === name)!.id;
const spell = (name: string) => spells.find((s) => s.name === name)!;
const scores = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
const pb = (level: number) => 2 + Math.floor((level - 1) / 4);

/** A complete level 1 character ("Let the DM decide" fills what the draft leaves open). */
function build(className: string, species: string, extra: Partial<BuilderDraft> = {}): Character {
  const draft = letDmBuildAll({ ...emptyDraft(), classId: cls(className).id, speciesId: speciesId(species), name: 'Test', ...extra }, ctx, rng);
  return buildCharacter(draft, ctx, { campaignId: 'camp-1' });
}

/** The character after reaching `level` in its only class (what levelUp changes, minus HP and features). */
function atLevel(c: Character, level: number): Character {
  return { ...c, classes: c.classes.map((cl) => ({ ...cl, level })) };
}

const named = (c: Character, name: string): Feature | undefined => c.features.find((f) => f.name === name);

describe('level 1 class choices', () => {
  it('does not treat Barbarian Rage as a choice', () => {
    expect(classChoiceFeatures(cls('Barbarian'))).toEqual([]);
    expect(validateStep('class', { ...emptyDraft(), classId: cls('Barbarian').id }, ctx)).toEqual([]);
    const c = build('Barbarian', 'Dwarf');
    // SRD Barbarian table, Rages column.
    expect(named(c, 'Rage')?.uses).toEqual({
      max: 2,
      used: 0,
      recharge: 'long',
      scale: { by: 'table', className: 'Barbarian', values: [2, 2, 3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 6, 6, 6, 6] },
    });
    // A draft saved by the older builder still holds a "choice" for Rage; it no longer decorates the name.
    expect(named(build('Barbarian', 'Dwarf', { classOptions: { Rage: 'Duration' } }), 'Rage')).toBeDefined();
  });

  it('keeps Divine Order and Primal Order as choices', () => {
    expect(classChoiceFeatures(cls('Cleric')).map(({ feature, options }) => [feature.name, options.map((o) => o.name)])).toEqual([
      ['Divine Order', ['Protector', 'Thaumaturge']],
    ]);
    expect(classChoiceFeatures(cls('Druid')).map(({ feature, options }) => [feature.name, options.map((o) => o.name)])).toEqual([
      ['Primal Order', ['Magician', 'Warden']],
    ]);
  });
});

describe('feature uses that grow with the class', () => {
  const uses = (className: string, feature: string, level: number) => {
    const def = cls(className).features.find((f) => f.name === feature)!;
    return inferFeatureUses(def.name, def.description, { level, proficiencyBonus: pb(level), scores: { ...scores, cha: 16 }, cls: cls(className) });
  };

  it('reads the column a feature names (Focus Points, Sorcery Points)', () => {
    expect(uses('Monk', "Monk's Focus", 2)).toMatchObject({ max: 2, recharge: 'short', scale: { by: 'table', className: 'Monk' } });
    expect(uses('Monk', "Monk's Focus", 5)?.max).toBe(5);
    expect(uses('Sorcerer', 'Font of Magic', 2)).toMatchObject({ max: 2, recharge: 'long', scale: { by: 'table', className: 'Sorcerer' } });
  });

  it('scales Channel Divinity, Wild Shape, Second Wind and Favored Enemy by their tables', () => {
    expect([2, 6, 18].map((l) => uses('Cleric', 'Channel Divinity', l)?.max)).toEqual([2, 3, 4]);
    expect([3, 11].map((l) => uses('Paladin', 'Channel Divinity', l)?.max)).toEqual([2, 3]);
    expect([2, 6, 17].map((l) => uses('Druid', 'Wild Shape', l)?.max)).toEqual([2, 3, 4]);
    expect([1, 4, 10].map((l) => uses('Fighter', 'Second Wind', l)?.max)).toEqual([2, 3, 4]);
    expect([1, 5, 17].map((l) => uses('Ranger', 'Favored Enemy', l)?.max)).toEqual([2, 3, 6]);
  });

  it('scales Lay On Hands with Paladin level and keeps fixed and ability-based uses unscaled', () => {
    expect(uses('Paladin', 'Lay On Hands', 2)).toMatchObject({ max: 10, scale: { by: 'class-level', className: 'Paladin', multiplier: 5 } });
    expect(uses('Bard', 'Bardic Inspiration', 1)).toEqual({ max: 3, used: 0, recharge: 'long' });
    expect(uses('Fighter', 'Action Surge (one use)', 2)).toEqual({ max: 1, used: 0, recharge: 'short' });
    expect(uses('Fighter', 'Indomitable (three uses)', 17)?.max).toBe(3);
  });
});

describe('species traits', () => {
  it('gives Giant Ancestry Proficiency Bonus uses per Long Rest (Goliath)', () => {
    const c = build('Fighter', 'Goliath', { lineage: 'Stone Giant' });
    const ancestry = named(c, 'Giant Ancestry (Stone Giant)');
    expect(ancestry?.uses).toEqual({ max: 2, used: 0, recharge: 'long', scale: { by: 'proficiency-bonus' } });
    expect(ancestry?.description).toContain("**Stone Giant.** Stone's Endurance.");
    expect(ancestry?.description).not.toContain("Storm's Thunder");
  });

  it('gives only the Forest Gnome its Speak with Animals uses', () => {
    const forest = build('Wizard', 'Gnome', { lineage: 'Forest Gnome', lineageAbility: 'int' });
    expect(named(forest, 'Gnomish Lineage (Forest Gnome)')?.uses).toMatchObject({ max: 2, scale: { by: 'proficiency-bonus' } });
    const rock = build('Wizard', 'Gnome', { lineage: 'Rock Gnome', lineageAbility: 'int' });
    expect(named(rock, 'Gnomish Lineage (Rock Gnome)')).toBeDefined();
    expect(named(rock, 'Gnomish Lineage (Rock Gnome)')?.uses).toBeUndefined();
  });

  it('records species Resistances (Dwarf, Dragonborn ancestry, Tiefling legacy)', () => {
    expect(build('Fighter', 'Dwarf').damageResistances).toEqual(['poison']);
    expect(build('Fighter', 'Dragonborn', { lineage: 'Red' }).damageResistances).toEqual(['fire']);
    expect(build('Fighter', 'Dragonborn', { lineage: 'Silver' }).damageResistances).toEqual(['cold']);
    expect(build('Wizard', 'Tiefling', { lineage: 'Abyssal', lineageAbility: 'int' }).damageResistances).toEqual(['poison']);
    expect(build('Wizard', 'Tiefling', { lineage: 'Chthonic', lineageAbility: 'int' }).damageResistances).toEqual(['necrotic']);
    expect(build('Wizard', 'Elf', { lineage: 'High Elf', lineageAbility: 'int' }).damageResistances).toBeUndefined();
    // Rage's Resistance only applies while raging, so it isn't recorded.
    expect(build('Barbarian', 'Human').damageResistances).toBeUndefined();
  });
});

describe('class option skill bonuses', () => {
  it('adds WIS (min +1) to Arcana and Religion for a Thaumaturge, Arcana and Nature for a Magician', () => {
    expect(build('Cleric', 'Human', { classOptions: { 'Divine Order': 'Thaumaturge' } }).skillBonuses).toEqual([
      { skills: ['arcana', 'religion'], ability: 'wis', minimum: 1, source: 'Thaumaturge (Divine Order)' },
    ]);
    expect(build('Druid', 'Human', { classOptions: { 'Primal Order': 'Magician' } }).skillBonuses).toEqual([
      { skills: ['arcana', 'nature'], ability: 'wis', minimum: 1, source: 'Magician (Primal Order)' },
    ]);
    expect(build('Cleric', 'Human', { classOptions: { 'Divine Order': 'Protector' } }).skillBonuses).toBeUndefined();
  });
});

describe('cantrip attacks', () => {
  it('scales the dice of cantrips whose Cantrip Upgrade adds dice', () => {
    for (const name of ['Fire Bolt', 'Ray of Frost', 'Chill Touch', 'Shocking Grasp', 'Produce Flame', 'Poison Spray', 'Starry Wisp']) {
      expect(spellAttack(spell(name)), name).toMatchObject({ scaling: 'cantrip', notes: 'Cantrip' });
    }
    expect(spellAttack(spell('Fire Bolt'))).toMatchObject({ damage: '1d10', damageType: 'fire' });
  });

  it('adds beams to Eldritch Blast instead of dice', () => {
    const blast = spellAttack(spell('Eldritch Blast'));
    expect(blast).toMatchObject({ damage: '1d10', damageType: 'force', notes: 'Cantrip: 2 beams at level 5, 3 at 11, 4 at 17 (one attack roll per beam)' });
    expect(blast?.scaling).toBeUndefined();
  });

  it('marks the Monk’s Unarmed Strike for Martial Arts', () => {
    expect(build('Monk', 'Human').attacks.find((a) => a.name === 'Unarmed Strike')).toMatchObject({ damage: '1d6', ability: 'finesse', scaling: 'martial-arts' });
    expect(build('Fighter', 'Human').attacks.find((a) => a.name === 'Unarmed Strike')?.scaling).toBeUndefined();
  });
});

describe('refreshing uses after a level-up', () => {
  it('grows Rage from the Barbarian table', () => {
    const c = atLevel(build('Barbarian', 'Human'), 3);
    const refreshed = refreshFeatureUses(c, data);
    expect(named(refreshed, 'Rage')?.uses).toMatchObject({ max: 3, used: 0 });
    expect(featureUseChanges(c, refreshed)).toEqual(['Rage 2 → 3']);
  });

  it('renames an older builder’s "Rage (Duration)" and gives it its table', () => {
    const built = build('Barbarian', 'Human');
    const legacy = {
      ...atLevel(built, 3),
      features: built.features.map((f) => (f.name === 'Rage' ? { ...f, name: 'Rage (Duration)', uses: { max: 2, used: 1, recharge: 'long' as const } } : f)),
    };
    const rage = refreshFeatureUses(legacy, data).features.find((f) => f.source === 'class' && f.name.startsWith('Rage'));
    expect(rage?.name).toBe('Rage');
    expect(rage?.uses).toMatchObject({ max: 3, used: 1, scale: { by: 'table', className: 'Barbarian' } });
  });

  it('doubles Lay On Hands at Paladin 2 and gives a Monk’s Focus its points', () => {
    expect(named(refreshFeatureUses(atLevel(build('Paladin', 'Human'), 2), data), 'Lay On Hands')?.uses?.max).toBe(10);
    const monk = build('Monk', 'Human');
    const focus: Feature = { id: 'focus', name: "Monk's Focus", source: 'class', sourceName: 'Monk 2', description: cls('Monk').features.find((f) => f.name === "Monk's Focus")!.description };
    const refreshed = refreshFeatureUses({ ...atLevel(monk, 5), features: [...monk.features, focus] }, data);
    expect(named(refreshed, "Monk's Focus")?.uses).toMatchObject({ max: 5, used: 0, recharge: 'short' });
  });

  it('grows species uses with the Proficiency Bonus and opens level 5 traits (Dragonborn)', () => {
    const c = atLevel(build('Fighter', 'Dragonborn', { lineage: 'Red' }), 5);
    const refreshed = refreshFeatureUses(c, data);
    expect(named(refreshed, 'Breath Weapon')?.uses).toMatchObject({ max: 3, scale: { by: 'proficiency-bonus' } });
    expect(named(refreshed, 'Draconic Flight')?.uses).toEqual({ max: 1, used: 0, recharge: 'long' });
    expect(featureUseChanges(c, refreshed)).toEqual(expect.arrayContaining(['Breath Weapon 2 → 3', 'Draconic Flight 1']));
  });

  it('reads the chosen lineage, not the stored text, for lineage uses (Rock Gnome)', () => {
    const rock = build('Wizard', 'Gnome', { lineage: 'Rock Gnome', lineageAbility: 'int' });
    const trait = data.species.find((s) => s.name === 'Gnome')!.traits.find((t) => t.name === 'Gnomish Lineage')!;
    // An older builder stored the whole trait, Forest Gnome's Proficiency Bonus uses included.
    const legacy = {
      ...atLevel(rock, 5),
      features: rock.features.map((f) => (f.name === 'Gnomish Lineage (Rock Gnome)' ? { ...f, description: trait.description } : f)),
    };
    const refreshed = named(refreshFeatureUses(legacy, data), 'Gnomish Lineage (Rock Gnome)');
    expect(refreshed).toBeDefined();
    expect(refreshed?.uses).toBeUndefined();
  });

  it('leaves class features alone when the builder data is unavailable', () => {
    // The engine's level-up already set three Second Winds; "You can use this feature twice" must not undo it.
    const fighter = atLevel(build('Fighter', 'Human'), 4);
    const scaled = { ...fighter, features: fighter.features.map((f) => (f.name === 'Second Wind' ? { ...f, uses: { ...f.uses!, max: 3 } } : f)) };
    expect(refreshFeatureUses(scaled, null)).toBe(scaled);
  });

  it('adds what an older builder never recorded: skill bonuses and Resistances', () => {
    const cleric = build('Cleric', 'Dwarf', { classOptions: { 'Divine Order': 'Thaumaturge' } });
    const legacy = { ...cleric, skillBonuses: undefined, damageResistances: undefined };
    const refreshed = refreshFeatureUses(legacy, data);
    expect(refreshed.skillBonuses).toEqual(cleric.skillBonuses);
    expect(refreshed.damageResistances).toEqual(['poison']);
    // Nothing left to repair or grow: the same object comes back.
    expect(refreshFeatureUses(cleric, data)).toBe(cleric);
  });
});
