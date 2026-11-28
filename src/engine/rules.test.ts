import { describe, expect, it } from 'vitest';
import type { AcSpellName, Attack, Character, EquipmentOption, Feature, ImportedRef, InventoryItem, PlayerRollRequest, SkillBonus } from '@/types';
import { sampleCharacter } from '@/test/fixtures';
import * as engine from '@/engine';
import { applyAttackRollRules, manualD20Result } from './dice';
import {
  AC_SPELLS,
  abilityCheckModifier,
  abilityModifier,
  acSpellNamed,
  acSpells,
  attackAbilityModifier,
  attackBonus,
  attackCritRange,
  attackDamageExpression,
  attackScaling,
  characterLevel,
  computeArmorClass,
  countedAcSpells,
  handSetNames,
  isFightingStyle,
  deathSaveModifier,
  effectiveSpeed,
  eldritchBlastBeams,
  exhaustionPenalty,
  formatModifier,
  initiativeModifier,
  isMonkWeapon,
  passivePerception,
  proficiencyBonus,
  rollRequestExpression,
  unarmedDamageExpression,
  rollRequestModifier,
  saveBonusSources,
  savingThrowModifier,
  skillModifier,
  speedChangeText,
  speedDetails,
  spellAttackBonus,
  spellSaveDC,
  spellcastingAbility,
  syncArmorClass,
  weaponCritRange,
  workedOutWords,
} from './rules';

const mira = (overrides: Partial<Character> = {}) => sampleCharacter(overrides);
const dagger = (c: Character) => c.attacks.find((a) => a.name === 'Dagger') as Attack;
const fireBolt = (c: Character) => c.attacks.find((a) => a.name === 'Fire Bolt') as Attack;
const request = (patch: Partial<PlayerRollRequest>): PlayerRollRequest => ({
  rollType: 'skill',
  revealDc: false,
  advantage: 'normal',
  reason: 'test',
  ...patch,
});
const wearing = (c: Character, ...items: Array<Partial<InventoryItem> & { name: string }>): Character => ({
  ...c,
  inventory: items.map((i, n) => ({ id: `w${n}`, quantity: 1, equipped: true, ...i })),
});

describe('basic numbers', () => {
  it('ability modifiers follow floor((score - 10) / 2)', () => {
    expect([1, 3, 8, 9, 10, 11, 12, 15, 20, 30].map(abilityModifier)).toEqual([-5, -4, -1, -1, 0, 0, 1, 2, 5, 10]);
  });

  it('formats modifiers with a true minus sign', () => {
    expect(formatModifier(3)).toBe('+3');
    expect(formatModifier(0)).toBe('+0');
    expect(formatModifier(-1)).toBe('−1');
  });

  it('proficiency bonus by level (SRD 5.2.1 Level Advancement)', () => {
    const table = Array.from({ length: 20 }, (_, i) => proficiencyBonus(i + 1));
    expect(table).toEqual([2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6]);
    expect(proficiencyBonus(0)).toBe(2);
    expect(proficiencyBonus(25)).toBe(6);
  });

  it('character level sums class levels (minimum 1)', () => {
    expect(characterLevel(mira())).toBe(3);
    expect(characterLevel(mira({ classes: [] }))).toBe(1);
    const multi = mira({
      classes: [
        { classId: 'srd:class:wizard', name: 'Wizard', level: 3, hitDie: 6, casterType: 'full', spellcastingAbility: 'int' },
        { classId: 'srd:class:cleric', name: 'Cleric', level: 2, hitDie: 8, casterType: 'full', spellcastingAbility: 'wis' },
      ],
    });
    expect(characterLevel(multi)).toBe(5);
    expect(skillModifier(multi, 'arcana')).toBe(6); // PB +3 at level 5
  });
});

describe('checks, saves and passive scores', () => {
  it('skills add PB × proficiency level', () => {
    expect(skillModifier(mira(), 'arcana')).toBe(5);
    expect(skillModifier(mira(), 'stealth')).toBe(2);
    expect(skillModifier(mira(), 'perception')).toBe(3);
    expect(skillModifier(mira({ skills: { arcana: 2 } }), 'arcana')).toBe(7);
    expect(skillModifier(mira({ skills: { athletics: 0.5 } }), 'athletics')).toBe(0); // STR −1 + floor(2 / 2)
  });

  it('saving throws add PB when proficient', () => {
    expect(savingThrowModifier(mira(), 'int')).toBe(5);
    expect(savingThrowModifier(mira(), 'wis')).toBe(3);
    expect(savingThrowModifier(mira(), 'str')).toBe(-1);
  });

  it('includes an attuned Ring of Protection and a Paladin 6 Aura of Protection in saves', () => {
    const ring = mira({
      inventory: [{ id: 'r', name: 'Ring of Protection', quantity: 1, attuned: true, magic: true }],
    });
    expect(savingThrowModifier(ring, 'str')).toBe(0);
    const paladin = mira({
      abilityScores: { str: 16, dex: 10, con: 14, int: 8, wis: 10, cha: 16 },
      savingThrows: ['wis', 'cha'],
      classes: [{ classId: 'srd:class:paladin', name: 'Paladin', level: 6, hitDie: 10, casterType: 'half', spellcastingAbility: 'cha' }],
    });
    expect(savingThrowModifier(paladin, 'str')).toBe(3 + 3);
    expect(savingThrowModifier({ ...paladin, conditions: [{ id: 'stunned' }] }, 'str')).toBe(3);
  });

  it('raw checks, initiative and passive Perception', () => {
    expect(abilityCheckModifier(mira(), 'str')).toBe(-1);
    expect(initiativeModifier(mira())).toBe(2);
    expect(initiativeModifier(mira({ initiativeBonusExtra: 2 }))).toBe(4);
    expect(passivePerception(mira())).toBe(13);
    expect(passivePerception(mira({ passivePerceptionExtra: 5 }))).toBe(18);
  });

  it('exhaustion: −2 per level to D20 Tests (SRD 5.2.1)', () => {
    expect(exhaustionPenalty(mira())).toBe(0);
    expect(exhaustionPenalty(mira({ exhaustion: 2 }))).toBe(-4);
    expect(exhaustionPenalty(mira({ exhaustion: 9 }))).toBe(-12);
    expect(deathSaveModifier(mira({ exhaustion: 1 }))).toBe(-2);
  });
});

describe('spellcasting numbers', () => {
  it('spell save DC and attack bonus', () => {
    expect(spellcastingAbility(mira())).toBe('int');
    expect(spellSaveDC(mira())).toBe(13);
    expect(spellAttackBonus(mira())).toBe(5);
    expect(spellSaveDC(mira(), 'wis')).toBe(11);
    const fighter = mira({
      spellcasting: undefined,
      classes: [{ classId: 'srd:class:fighter', name: 'Fighter', level: 3, hitDie: 10, casterType: 'none' }],
    });
    expect(spellcastingAbility(fighter)).toBeNull();
    expect(spellSaveDC(fighter)).toBeNull();
    expect(spellAttackBonus(fighter)).toBeNull();
  });
});

describe('attacks', () => {
  it('attack ability, bonus and damage strings', () => {
    const c = mira();
    expect(attackAbilityModifier(c, dagger(c))).toBe(2);
    expect(attackAbilityModifier(c, fireBolt(c))).toBe(3);
    expect(attackBonus(c, dagger(c))).toBe(4);
    expect(attackBonus(c, fireBolt(c))).toBe(5);
    expect(attackBonus(c, { ...dagger(c), attackBonusExtra: 1 })).toBe(5);
    expect(attackBonus(c, { ...dagger(c), proficient: false })).toBe(2);
    expect(attackDamageExpression(c, dagger(c))).toBe('1d4+2');
    expect(attackDamageExpression(c, dagger(c), true)).toBe('2d4+2');
    expect(attackDamageExpression(c, fireBolt(c))).toBe('1d10');
    expect(attackDamageExpression(c, fireBolt(c), true)).toBe('2d10');
  });

  it('merges flat bonuses, handles penalties and reads sloppy damage text', () => {
    const c = mira();
    const club: Attack = { id: 'club', name: 'Club', ability: 'str', proficient: true, damage: '1d4', damageType: 'bludgeoning' };
    expect(attackDamageExpression(c, club)).toBe('1d4-1');
    expect(attackDamageExpression(c, { ...dagger(c), damage: '2d6+1' })).toBe('2d6+3');
    expect(attackDamageExpression(c, { ...dagger(c), damage: '1d8 piercing' })).toBe('1d8+2');
    expect(attackDamageExpression(c, { ...dagger(c), damage: '1d6+2 (versatile 1d8)', addAbilityToDamage: false })).toBe('1d6+2');
    expect(attackDamageExpression(c, { ...dagger(c), damage: '—' })).toBe('—');
  });
});

describe('speed', () => {
  it('applies exhaustion and speed-zeroing conditions (2024)', () => {
    expect(effectiveSpeed(mira())).toBe(30);
    expect(effectiveSpeed(mira({ exhaustion: 2 }))).toBe(20);
    expect(effectiveSpeed(mira({ conditions: [{ id: 'grappled' }] }))).toBe(0);
    expect(effectiveSpeed(mira({ conditions: [{ id: 'restrained' }] }))).toBe(0);
    // 2024 Stunned and Incapacitated no longer reduce Speed to 0.
    expect(effectiveSpeed(mira({ conditions: [{ id: 'stunned' }] }))).toBe(30);
    expect(effectiveSpeed(mira({ conditions: [{ id: 'prone' }] }))).toBe(30);
  });

  it('heavy armor below its Strength requirement costs 10 ft', () => {
    const c = wearing(mira(), { name: 'Chain Mail', category: 'armor' });
    expect(effectiveSpeed(c)).toBe(20);
    expect(speedDetails(c).notes[0]).toMatch(/Chain Mail needs Strength 13/);
    expect(effectiveSpeed({ ...c, abilityScores: { ...c.abilityScores, str: 13 } })).toBe(30);
  });

  it('a hero without a Speed feature reads as before: the stored speed and other speeds, nothing raised', () => {
    expect(speedDetails(mira())).toEqual({ speed: 30, base: 30, raised: 30, bonuses: [], off: [], classFeatures: [], other: {}, notes: [] });
    expect(speedDetails(mira({ exhaustion: 1 }))).toMatchObject({ speed: 25, raised: 30, notes: ['Exhaustion 1: −5 ft'] });
  });
});

/** Speed from class features: spec §1.1–1.2 (class extras). Heroes wear nothing unless a test says so. */
describe('Speed from class features (SRD 5.2.1 srd:rule:monk-unarmored-movement, srd:rule:barbarian-fast-movement, srd:rule:ranger-roving)', () => {
  type ClassEntry = Character['classes'][number];
  type Gear = Partial<InventoryItem> & { name: string };
  const cls = (name: string, level: number, extra: Partial<ClassEntry> = {}): ClassEntry => ({
    classId: `srd:class:${name.toLowerCase()}`,
    name,
    level,
    hitDie: 8,
    casterType: 'none',
    ...extra,
  });
  const hero = (classes: ClassEntry[], extra: Partial<Character> = {}) => mira({ classes, inventory: [], spellcasting: undefined, ...extra });
  const monk = (level: number, extra: Partial<Character> = {}) => hero([cls('Monk', level)], extra);
  const barbarian = (level: number, extra: Partial<Character> = {}) => hero([cls('Barbarian', level)], extra);
  const ranger = (level: number, extra: Partial<Character> = {}) => hero([cls('Ranger', level)], extra);
  /** STR 16: Plate Armor's Strength 15 costs no Speed. */
  const strong = { ...mira().abilityScores, str: 16 };
  const plate: Gear = { name: 'Plate Armor', category: 'armor' };
  const leather: Gear = { name: 'Leather Armor', category: 'armor' };
  /** Armor the app can't identify: category armor, no stats. */
  const coat: Gear = { name: 'Mithral Coat', category: 'armor' };
  /** A Shield as the builder copies it (srd:item:shield). */
  const shield: Gear = { name: 'Shield', category: 'shield', armor: { kind: 'shield', baseAc: 2, dexCap: 0 } };

  it('Unarmored Movement follows the Monk Features table: +10 ft at Monk 2, +15 at 6, +20 at 10, +25 at 14, +30 at 18 (srd:class:monk)', () => {
    // srd:rule:monk-unarmored-movement: "This bonus increases when you reach certain Monk levels, as shown in the Monk Features table."
    const levels = [1, 2, 5, 6, 9, 10, 13, 14, 17, 18, 20];
    expect(levels.map((l) => effectiveSpeed(monk(l)))).toEqual([30, 40, 40, 45, 45, 50, 50, 55, 55, 60, 60]);
    expect(speedDetails(monk(6))).toEqual({
      speed: 45,
      base: 30,
      raised: 45,
      bonuses: [{ name: 'Unarmored Movement', feet: 15 }],
      off: [],
      classFeatures: ['Unarmored Movement'],
      other: {},
      notes: ['Unarmored Movement: +15 ft'],
    });
    // Level 1's column reads "—": no feature yet, as any other hero.
    expect(speedDetails(monk(1))).toEqual({ speed: 30, base: 30, raised: 30, bonuses: [], off: [], classFeatures: [], other: {}, notes: [] });
  });

  it('Unarmored Movement stops in armor or with a Shield, armor the app can\'t identify included (srd:rule:monk-unarmored-movement: "while you aren\'t wearing armor or wielding a Shield")', () => {
    for (const gear of [leather, shield, coat]) {
      expect(speedDetails(wearing(monk(6), gear))).toEqual({
        speed: 30,
        base: 30,
        raised: 30,
        bonuses: [],
        off: ['Unarmored Movement: no +15 ft in armor or with a Shield'],
        classFeatures: ['Unarmored Movement'],
        other: {},
        notes: [],
      });
    }
    // A weapon is neither: the bonus stays.
    expect(effectiveSpeed(wearing(monk(6), { name: 'Quarterstaff', category: 'weapon' }))).toBe(45);
  });

  it('Fast Movement at Barbarian 5 and Roving at Ranger 6 add 10 ft, a Shield and lighter armor kept (srd:rule:barbarian-fast-movement: "Your speed increases by 10 feet while you aren\'t wearing Heavy armor.")', () => {
    expect([4, 5, 20].map((l) => effectiveSpeed(barbarian(l)))).toEqual([30, 40, 40]);
    expect([5, 6, 20].map((l) => effectiveSpeed(ranger(l)))).toEqual([30, 40, 40]);
    expect(speedDetails(barbarian(4)).classFeatures).toEqual([]);
    expect(speedDetails(ranger(5)).classFeatures).toEqual([]);
    expect(speedDetails(barbarian(5))).toMatchObject({ raised: 40, bonuses: [{ name: 'Fast Movement', feet: 10 }], classFeatures: ['Fast Movement'], notes: ['Fast Movement: +10 ft'] });
    expect(speedDetails(ranger(6))).toMatchObject({ raised: 40, bonuses: [{ name: 'Roving', feet: 10 }], classFeatures: ['Roving'], notes: ['Roving: +10 ft'] });
    // Neither feature mentions a Shield: a Barbarian's Hide Armor and Shield, a Ranger's Studded Leather and Shield.
    expect(speedDetails(wearing(barbarian(5), { name: 'Hide Armor', category: 'armor' }, shield))).toMatchObject({ speed: 40, off: [] });
    expect(speedDetails(wearing(ranger(6), { name: 'Studded Leather Armor', category: 'armor' }, shield))).toMatchObject({ speed: 40, off: [] });
    expect(effectiveSpeed(wearing(barbarian(5), { name: 'Spiked Shield', category: 'shield' }))).toBe(40);
  });

  it('Heavy armor withholds Fast Movement and Roving: a heavy type, stored stats with no type and DEX cap 0, or armor the app can\'t identify (srd:rule:armor: "Every type of armor falls into a category: Light, Medium, or Heavy.")', () => {
    expect(speedDetails(wearing(barbarian(5, { abilityScores: strong }), plate))).toMatchObject({
      speed: 30,
      raised: 30,
      bonuses: [],
      off: ['Fast Movement: no +10 ft in Heavy armor'],
      classFeatures: ['Fast Movement'],
      notes: [],
    });
    expect(speedDetails(wearing(ranger(6, { abilityScores: strong }), plate))).toMatchObject({ speed: 30, off: ['Roving: no +10 ft in Heavy armor'] });
    // Stored numbers without a type: a DEX cap of 0 reads as Heavy; a stored type wins.
    const mail = (armorType?: 'medium'): Gear => ({ name: 'Ironbark Mail', category: 'armor', armor: { kind: 'armor', baseAc: 16, dexCap: 0, ...(armorType ? { armorType } : {}) } });
    expect(speedDetails(wearing(barbarian(5), mail()))).toMatchObject({ speed: 30, off: ['Fast Movement: no +10 ft in Heavy armor'] });
    expect(effectiveSpeed(wearing(barbarian(5), mail('medium')))).toBe(40);
    // Armor the app can't identify may be Heavy: withheld, by the item's name.
    expect(speedDetails(wearing(barbarian(5), coat))).toMatchObject({ speed: 30, off: ['Fast Movement: no +10 ft (Mithral Coat: armor type unknown)'] });
    expect(speedDetails(wearing(ranger(6), coat)).off).toEqual(['Roving: no +10 ft (Mithral Coat: armor type unknown)']);
    // Below its Strength it also costs 10 ft ("that armor reduces the wearer's speed by 10 feet unless the wearer has a
    // Strength score equal to or higher than the listed score"), after the bonuses: 30 − 10.
    expect(speedDetails(wearing(barbarian(5), plate))).toMatchObject({
      speed: 20,
      raised: 30,
      off: ['Fast Movement: no +10 ft in Heavy armor'],
      notes: ['Plate Armor needs Strength 15: −10 ft'],
    });
  });

  it('multiclass bonuses add up, each by its own class level (srd:rule:multiclassing-class-features: "When you gain a new level in a class, you get its features for that level.")', () => {
    // Different features; the multiclass rules name special cases only for "Extra Attack, Spellcasting, and features (such
    // as Unarmored Defense) that give you alternative ways to calculate your Armor Class".
    const both = hero([cls('Monk', 2), cls('Barbarian', 5)]);
    expect(speedDetails(both)).toMatchObject({
      speed: 50,
      raised: 50,
      bonuses: [
        { name: 'Unarmored Movement', feet: 10 },
        { name: 'Fast Movement', feet: 10 },
      ],
      classFeatures: ['Unarmored Movement', 'Fast Movement'],
      notes: ['Unarmored Movement: +10 ft', 'Fast Movement: +10 ft'],
    });
    // Medium armor stops Unarmored Movement only; Heavy armor stops both.
    expect(speedDetails(wearing(both, { name: 'Hide Armor', category: 'armor' }))).toMatchObject({
      speed: 40,
      bonuses: [{ name: 'Fast Movement', feet: 10 }],
      off: ['Unarmored Movement: no +10 ft in armor or with a Shield'],
    });
    expect(speedDetails(wearing({ ...both, abilityScores: strong }, plate))).toMatchObject({
      speed: 30,
      off: ['Unarmored Movement: no +10 ft in armor or with a Shield', 'Fast Movement: no +10 ft in Heavy armor'],
    });
    // Unarmored Movement comes at Monk level 2, whatever the character level.
    expect(speedDetails(hero([cls('Fighter', 5), cls('Monk', 1)]))).toMatchObject({ speed: 30, classFeatures: [] });
    expect(speedDetails(hero([cls('Fighter', 5), cls('Monk', 2)]))).toMatchObject({ speed: 40, bonuses: [{ name: 'Unarmored Movement', feet: 10 }] });
    expect(effectiveSpeed(hero([cls('Barbarian', 5), cls('Ranger', 6)]))).toBe(50);
  });

  it('Speed 0 can\'t increase; a stored Speed of 0 gets no bonus; the penalties come after the bonuses (srd:condition:grappled: "Your Speed is 0 and can\'t increase."; srd:condition:exhaustion)', () => {
    expect(speedDetails(monk(6, { conditions: [{ id: 'grappled' }] }))).toEqual({
      speed: 0,
      base: 30,
      raised: 30,
      bonuses: [],
      off: [],
      classFeatures: ['Unarmored Movement'],
      other: {},
      notes: ['Grappled: Speed 0'],
    });
    expect(speedDetails(monk(6, { deathSaves: { successes: 0, failures: 3, stable: false, dead: true } }))).toMatchObject({ speed: 0, raised: 30, bonuses: [], notes: ['Dead'] });
    // Only a DM's ruling stores 0: no class feature raises it.
    expect(speedDetails(monk(6, { speed: 0 }))).toEqual({ speed: 0, base: 0, raised: 0, bonuses: [], off: [], classFeatures: ['Unarmored Movement'], other: {}, notes: [] });
    // "Your Speed is reduced by a number of feet equal to 5 times your Exhaustion level": off the raised Speed, 30 + 15 − 10.
    expect(speedDetails(monk(6, { exhaustion: 2 }))).toMatchObject({ speed: 35, base: 30, raised: 45, notes: ['Unarmored Movement: +15 ft', 'Exhaustion 2: −10 ft'] });
    expect(effectiveSpeed(monk(2, { speed: 5, exhaustion: 5 }))).toBe(0);
    // A Speed the DM raised by hand gets the bonus on top: the app can't tell why it was raised (spec §1.4).
    expect(speedDetails(monk(6, { speed: 45 }))).toMatchObject({ speed: 60, base: 45, raised: 60 });
  });

  it("a 2024 book's Monk and a DM's class named Monk get Unarmored Movement; an older book's Monk gets none (srd:class:monk; DESIGN: stand-in classes)", () => {
    const ref = (format: '2024' | '2014'): ImportedRef => ({ sourceId: 'lamp', sourceTitle: 'The Lamp Folio', entryId: 'lib:lamp:class:monk', kind: 'class', entryName: 'Monk', textHash: '', textCopied: false, format });
    const book = (format: '2024' | '2014') => hero([cls('Monk', 6, { classId: 'lib:lamp:class:monk', ref: ref(format) })]);
    expect(effectiveSpeed(book('2024'))).toBe(45);
    // An older edition's Monk table can differ: the sheet's number stands.
    expect(speedDetails(book('2014'))).toMatchObject({ speed: 30, raised: 30, classFeatures: [], notes: [] });
    expect(effectiveSpeed(hero([cls('Monk', 6, { classId: 'monk' })]))).toBe(45);
  });

  it('Roving gives a Climb Speed and a Swim Speed equal to Speed, raised in place in the stored order (srd:rule:ranger-roving: "You also have a Climb Speed and a Swim Speed equal to your Speed.")', () => {
    expect(Object.entries(speedDetails(ranger(6)).other)).toEqual([
      ['climb', 40],
      ['swim', 40],
    ]);
    // {swim, fly}: swim raised where it stands, climb appended.
    expect(Object.entries(speedDetails(ranger(6, { otherSpeeds: { swim: 30, fly: 60 } })).other)).toEqual([
      ['swim', 40],
      ['fly', 60],
      ['climb', 40],
    ]);
    // A faster one of its own stays.
    expect(speedDetails(ranger(6, { otherSpeeds: { climb: 60 } })).other).toEqual({ climb: 60, swim: 40 });
    // Equal to the Speed after penalties: Exhaustion 2 gives 30, Grappled 0.
    expect(speedDetails(ranger(6, { exhaustion: 2 }))).toMatchObject({ speed: 30, other: { climb: 30, swim: 30 } });
    expect(speedDetails(ranger(6, { conditions: [{ id: 'grappled' }] })).other).toEqual({ climb: 0, swim: 0 });
    // The sentence has no armor condition: in Heavy armor (no +10 ft) the speeds still equal the Speed.
    expect(speedDetails(wearing(ranger(6, { abilityScores: strong }), plate))).toMatchObject({ speed: 30, other: { climb: 30, swim: 30 } });
    // Anyone else's other speeds as stored, in the stored order.
    expect(speedDetails(ranger(5)).other).toEqual({});
    expect(Object.entries(speedDetails(mira({ otherSpeeds: { swim: 30, fly: 60 } })).other)).toEqual([
      ['swim', 30],
      ['fly', 60],
    ]);
    expect(Object.entries(speedDetails(monk(6, { otherSpeeds: { fly: 60, swim: 30 } })).other)).toEqual([
      ['fly', 60],
      ['swim', 30],
    ]);
  });

  describe('speedChangeText (spec §1.1: the level-up texts)', () => {
    it('names the class bonuses that changed the walking Speed (srd:class:monk; srd:rule:barbarian-fast-movement)', () => {
      expect(speedChangeText(monk(1), monk(2))).toBe('Speed 30 ft → 40 ft (Unarmored Movement)');
      expect(speedChangeText(monk(5), monk(6))).toBe('Speed 40 ft → 45 ft (Unarmored Movement)');
      expect(speedChangeText(monk(17), monk(18))).toBe('Speed 55 ft → 60 ft (Unarmored Movement)');
      expect(speedChangeText(barbarian(4), barbarian(5))).toBe('Speed 30 ft → 40 ft (Fast Movement)');
      expect(speedChangeText(hero([cls('Monk', 13), cls('Barbarian', 4)]), hero([cls('Monk', 14), cls('Barbarian', 5)]))).toBe(
        'Speed 50 ft → 65 ft (Unarmored Movement, Fast Movement)',
      );
      // A change no class bonus made is the number alone.
      expect(speedChangeText(mira(), mira({ exhaustion: 1 }))).toBe('Speed 30 ft → 25 ft');
    });

    it("adds Roving's Climb and Swim Speeds when they appear or change, alone when Heavy armor keeps the walking Speed (srd:rule:ranger-roving)", () => {
      expect(speedChangeText(ranger(5), ranger(6))).toBe('Speed 30 ft → 40 ft (Roving), with a Climb Speed and a Swim Speed of 40 ft');
      const armored = (level: number) => wearing(ranger(level, { abilityScores: strong }), plate);
      expect(speedChangeText(armored(5), armored(6))).toBe('A Climb Speed and a Swim Speed of 30 ft (Roving)');
      // A faster Swim Speed of its own stays: only the Climb Speed is new.
      const swimmer = (level: number) => ranger(level, { otherSpeeds: { swim: 60 } });
      expect(speedChangeText(swimmer(5), swimmer(6))).toBe('Speed 30 ft → 40 ft (Roving), with a Climb Speed of 40 ft');
      // Roving's speeds follow a Speed that grows.
      expect(speedChangeText(hero([cls('Ranger', 6), cls('Monk', 1)]), hero([cls('Ranger', 6), cls('Monk', 2)]))).toBe(
        'Speed 40 ft → 50 ft (Unarmored Movement), with a Climb Speed and a Swim Speed of 50 ft',
      );
    });

    it('is empty when neither the walking Speed nor the other speeds changed', () => {
      expect(speedChangeText(monk(2), monk(3))).toBe('');
      expect(speedChangeText(mira(), mira({ classes: [{ ...mira().classes[0], level: 4 }] }))).toBe('');
      expect(speedChangeText(wearing(monk(1), leather), wearing(monk(2), leather))).toBe('');
      const grappled = { conditions: [{ id: 'grappled' }] };
      expect(speedChangeText(monk(1, grappled), monk(2, grappled))).toBe('');
    });
  });
});

describe('computeArmorClass', () => {
  const fighter = mira({ armorTraining: ['Light armor', 'Medium armor', 'Heavy armor', 'Shields'] });

  it('unarmored: 10 + DEX', () => {
    expect(computeArmorClass(mira(), [])).toEqual({ ac: 12, formula: '10 + DEX 2' });
  });

  it('light, medium (DEX max 2) and heavy armor', () => {
    expect(computeArmorClass(wearing(fighter, { name: 'Leather Armor', category: 'armor' }), []).ac).toBe(13);
    const nimble = { ...fighter, abilityScores: { ...fighter.abilityScores, dex: 18 } };
    const halfPlate = computeArmorClass(wearing(nimble, { name: 'Half Plate Armor', category: 'armor' }), []);
    expect(halfPlate.ac).toBe(17);
    expect(halfPlate.formula).toBe('Half Plate Armor 15 + DEX 2 (max 2)');
    expect(computeArmorClass(wearing(nimble, { name: 'Plate', category: 'armor' }), []).ac).toBe(18);
  });

  it('adds a trained shield (+2) and magic bonuses', () => {
    const c = wearing(fighter, { name: 'Chain Mail', category: 'armor' }, { name: 'Shield', category: 'shield' });
    expect(computeArmorClass(c, [])).toEqual({ ac: 18, formula: 'Chain Mail 16 + Shield 2' });
    const magic = wearing(fighter, { name: '+1 Chain Mail', category: 'armor', magic: true }, { name: 'Shield +2', category: 'shield' });
    expect(computeArmorClass(magic, []).ac).toBe(16 + 1 + 4);
  });

  it('an untrained shield gives no AC; untrained armor is flagged', () => {
    const c = wearing(mira(), { name: 'Shield', category: 'shield' });
    const result = computeArmorClass(c, []);
    expect(result.ac).toBe(12);
    expect(result.formula).toMatch(/no Shield training/);
    expect(computeArmorClass(wearing(mira(), { name: 'Leather Armor', category: 'armor' }), []).formula).toMatch(/untrained in light armor/);
  });

  it('Barbarian and Monk Unarmored Defense', () => {
    const barbarian = mira({
      abilityScores: { str: 16, dex: 14, con: 16, int: 8, wis: 10, cha: 10 },
      armorTraining: ['Light armor', 'Medium armor', 'Shields'],
      classes: [{ classId: 'srd:class:barbarian', name: 'Barbarian', level: 1, hitDie: 12, casterType: 'none' }],
    });
    expect(computeArmorClass(barbarian, [])).toEqual({ ac: 15, formula: 'Unarmored Defense: 10 + DEX 2 + CON 3' });
    expect(computeArmorClass(wearing(barbarian, { name: 'Shield', category: 'shield' }), []).ac).toBe(17);
    const monk = mira({
      abilityScores: { str: 10, dex: 16, con: 12, int: 8, wis: 16, cha: 10 },
      classes: [{ classId: 'srd:class:monk', name: 'Monk', level: 2, hitDie: 8, casterType: 'none' }],
      armorTraining: ['Shields'],
    });
    expect(computeArmorClass(monk, []).ac).toBe(16);
    // A Monk wielding a Shield loses Unarmored Defense: 10 + DEX 3 + Shield 2.
    expect(computeArmorClass(wearing(monk, { name: 'Shield', category: 'shield' }), []).ac).toBe(15);
  });

  it('uses the catalog and keeps AC for unknown armor', () => {
    const catalog: EquipmentOption[] = [
      { id: 'hb:armor:mithral', name: 'Mithral Plate', category: 'armor', armorClass: 18, dexCap: 0, armorType: 'heavy' },
    ];
    const c = wearing(fighter, { name: 'Mithral Plate', category: 'armor', compendiumId: 'hb:armor:mithral' });
    expect(computeArmorClass(c, catalog).ac).toBe(18);
    const mystery = wearing({ ...fighter, armorClass: 15 }, { name: 'Elven Chain', category: 'armor' });
    expect(computeArmorClass(mystery, []).ac).toBe(15);
    expect(computeArmorClass(mystery, []).formula).toMatch(/stats unknown/);
  });

  it('Defense fighting style and protection items', () => {
    const c = {
      ...wearing(fighter, { name: 'Chain Mail', category: 'armor' }),
      features: [{ id: 'd', name: 'Defense', source: 'feat' as const, description: '+1 AC in armor' }],
    };
    expect(computeArmorClass(c, []).ac).toBe(17);
    // However the style is named, the Champion's second one included (SRD 5.2.1 Champion, Additional Fighting Style).
    const named = (name: string, source: Feature['source'] = 'feat') => computeArmorClass({ ...c, features: [{ ...c.features[0], name, source }] }, []).ac;
    const styleNames = ['Fighting Style (Defense)', 'Fighting Style: Defense', 'Defense Fighting Style', 'Additional Fighting Style (Defense)', 'Fighting Style Feat: Defense', 'Defense (Fighter 1)', 'Defense (Additional Fighting Style)'];
    for (const name of styleNames) expect(named(name)).toBe(17);
    expect(named('Additional Fighting Style (Defense)', 'subclass')).toBe(17);
    for (const name of ['Unarmored Defense', 'Superior Defense', 'Fighting Style', 'Additional Fighting Style']) expect(named(name)).toBe(16);
    // A species trait that shares the style's name isn't the style, nor is a boon's, an item's or a background's.
    expect(named('Defense', 'species')).toBe(16);
    for (const source of ['boon', 'item', 'background'] as const) expect(named('Defense', source), source).toBe(16);
    for (const source of ['homebrew', 'other'] as const) expect(named('Defense', source), source).toBe(17);
    // A style whose own name ends in "Fighting".
    expect(isFightingStyle({ name: 'Great Weapon Fighting Style', source: 'class' }, 'Great Weapon Fighting')).toBe(true);
    expect(isFightingStyle({ name: 'Fighting Style: Two-Weapon Fighting Style', source: 'feat' }, 'Two-Weapon Fighting')).toBe(true);
    expect(isFightingStyle({ name: 'Great Weapon Fighting Style', source: 'class' }, 'Defense')).toBe(false);
    // A style a book names so itself (invented), on the sheet under that name or another.
    for (const name of ['Fighting Style: Lantern Guard', 'Lantern Guard', 'Fighting Style (Lantern Guard)', 'Additional Fighting Style (Lantern Guard)']) {
      for (const style of ['Fighting Style: Lantern Guard', 'Additional Fighting Style: Lantern Guard', 'Fighting Style Feat: Lantern Guard', 'Lantern Guard']) {
        expect(isFightingStyle({ name, source: 'feat' }, style), `${name} / ${style}`).toBe(true);
      }
    }
    expect(isFightingStyle({ name: 'Fighting Style: Lantern Guard', source: 'feat' }, 'Fighting Style: Wick Lash')).toBe(false);
    // A sheet name that wraps the book's own name; a book's name with a style suffix, either way round.
    for (const name of ['Fighting Style (Fighting Style: Lantern Guard)', 'Additional Fighting Style (Fighting Style: Lantern Guard)', 'Fighting Style: Fighting Style: Lantern Guard']) {
      expect(isFightingStyle({ name, source: 'other' }, 'Fighting Style: Lantern Guard'), name).toBe(true);
    }
    expect(isFightingStyle({ name: 'Defense', source: 'feat' }, 'Defense Fighting Style')).toBe(true);
    expect(isFightingStyle({ name: 'Great Weapon Fighting', source: 'feat' }, 'Great Weapon Fighting Style')).toBe(true);
    for (const style of ['Defense Drill', 'Superior Defense', 'Fighting Style']) expect(isFightingStyle({ name: 'Defense', source: 'feat' }, style), style).toBe(false);
    expect(isFightingStyle({ name: 'Archery', source: 'feat' }, 'Archery Expert')).toBe(false);
    // Another feature that only begins with a style's name (invented).
    expect(named('Defense Drill')).toBe(16);
    expect(isFightingStyle({ name: 'Archery Expert', source: 'feat' }, 'Archery')).toBe(false);
    const ring = wearing(mira(), { name: 'Ring of Protection', category: 'magic-item', attuned: true });
    expect(computeArmorClass(ring, []).ac).toBe(13);
  });
});

describe('rollRequestModifier', () => {
  it('labels and modifiers for every d20 test', () => {
    const c = mira();
    expect(rollRequestModifier(c, request({ rollType: 'skill', skill: 'stealth' }))).toEqual({ modifier: 2, label: 'Stealth check (DEX)' });
    expect(rollRequestModifier(c, request({ rollType: 'skill', skill: 'athletics', ability: 'dex' }))).toEqual({ modifier: 2, label: 'Athletics check (DEX)' });
    expect(rollRequestModifier(c, request({ rollType: 'save', ability: 'wis' }))).toEqual({ modifier: 3, label: 'Wisdom saving throw' });
    expect(rollRequestModifier(c, request({ rollType: 'ability', ability: 'str' }))).toEqual({ modifier: -1, label: 'Strength check' });
    expect(rollRequestModifier(c, request({ rollType: 'attack', attackName: 'dagger' }))).toEqual({ modifier: 4, label: 'Dagger attack' });
    expect(rollRequestModifier(c, request({ rollType: 'attack', attackName: 'FIRE BOLT' }))).toEqual({ modifier: 5, label: 'Fire Bolt attack' });
    expect(rollRequestModifier(c, request({ rollType: 'initiative' }))).toEqual({ modifier: 2, label: 'Initiative' });
    expect(rollRequestModifier(c, request({ rollType: 'death-save' }))).toEqual({ modifier: 0, label: 'Death saving throw' });
  });

  it('includes the exhaustion penalty in d20 tests only', () => {
    const tired = mira({ exhaustion: 1 });
    expect(rollRequestModifier(tired, request({ rollType: 'skill', skill: 'arcana' })).modifier).toBe(3);
    expect(rollRequestModifier(tired, request({ rollType: 'attack', attackName: 'Dagger' })).modifier).toBe(2);
    expect(rollRequestModifier(tired, request({ rollType: 'initiative' })).modifier).toBe(0);
    expect(rollRequestModifier(mira({ exhaustion: 2 }), request({ rollType: 'death-save' })).modifier).toBe(-4);
    expect(rollRequestModifier(tired, request({ rollType: 'damage', attackName: 'Dagger' })).modifier).toBe(0);
  });

  it('labels damage, custom and hit-die rolls', () => {
    const c = mira();
    expect(rollRequestModifier(c, request({ rollType: 'damage', attackName: 'dagger' }))).toEqual({ modifier: 0, label: 'Dagger damage' });
    expect(rollRequestModifier(c, request({ rollType: 'damage', attackName: 'Dagger', critical: true })).label).toBe('Dagger damage (critical)');
    expect(rollRequestModifier(c, request({ rollType: 'custom', expression: '1d6 + 1' })).label).toBe('Roll 1d6+1');
    expect(rollRequestModifier(c, request({ rollType: 'hit-die' })).label).toBe('Hit Point Die');
  });

  it('falls back sensibly for attacks that are not on the sheet', () => {
    const c = mira();
    expect(rollRequestModifier(c, request({ rollType: 'attack', attackName: 'Unarmed Strike' }))).toEqual({ modifier: 1, label: 'Unarmed Strike attack' });
    expect(rollRequestModifier(c, request({ rollType: 'attack', attackName: 'Scorching Ray' }))).toEqual({ modifier: 5, label: 'Scorching Ray attack' });
  });
});

describe('rollRequestExpression', () => {
  it('builds the dice to roll for a request', () => {
    const c = mira();
    expect(rollRequestExpression(c, request({ rollType: 'skill', skill: 'stealth', advantage: 'advantage' }))).toBe('2d20kh1+2');
    expect(rollRequestExpression(c, request({ rollType: 'damage', attackName: 'Dagger', critical: true }))).toBe('2d4+2');
    expect(rollRequestExpression(c, request({ rollType: 'damage', expression: '2d6+1', critical: true }))).toBe('4d6+1');
    expect(rollRequestExpression(c, request({ rollType: 'hit-die' }))).toBe('1d6+1');
    expect(rollRequestExpression(c, request({ rollType: 'custom', expression: 'd%' }))).toBe('1d100');
    expect(() => rollRequestExpression(c, request({ rollType: 'damage' }))).toThrow(/needs an attack/);
  });
});

describe('skill bonuses (SRD 5.2.1 Cleric: Divine Order — Thaumaturge; Druid: Primal Order — Magician)', () => {
  const cleric = (overrides: Partial<Character> = {}) =>
    mira({
      abilityScores: { str: 10, dex: 12, con: 14, int: 10, wis: 17, cha: 8 },
      classes: [{ classId: 'srd:class:cleric', name: 'Cleric', level: 1, hitDie: 8, casterType: 'full', spellcastingAbility: 'wis' }],
      skills: { religion: 1 },
      features: [],
      ...overrides,
    });
  const thaumaturge: SkillBonus = { skills: ['arcana', 'religion'], ability: 'wis', minimum: 1, source: 'Thaumaturge (Divine Order)' };
  const order = (name: string): Feature => ({ id: name, name, source: 'class', sourceName: 'Cleric 1', description: '' });

  it('adds the WIS modifier (minimum +1) to Arcana and Religion checks', () => {
    const c = cleric({ skillBonuses: [thaumaturge] });
    expect(skillModifier(c, 'religion')).toBe(5); // INT +0, PB +2, WIS +3 (the review's WIS 17 / INT 10 Cleric)
    expect(skillModifier(c, 'arcana')).toBe(3);
    expect(skillModifier(c, 'history')).toBe(0);
    const unwise = cleric({ abilityScores: { ...c.abilityScores, wis: 8 }, skillBonuses: [thaumaturge] });
    expect(skillModifier(unwise, 'arcana')).toBe(1); // minimum of +1
  });

  it('derives Thaumaturge and Magician from the feature on older sheets, without counting them twice', () => {
    const legacy = cleric({ features: [order('Divine Order (Thaumaturge)')] });
    expect(skillModifier(legacy, 'religion')).toBe(5);
    expect(skillModifier({ ...legacy, skillBonuses: [thaumaturge] }, 'religion')).toBe(5);
    expect(skillModifier({ ...legacy, skillBonuses: [thaumaturge, { ...thaumaturge }] }, 'religion')).toBe(5);
    const druid = cleric({ features: [order('Primal Order (Magician)')] });
    expect(skillModifier(druid, 'nature')).toBe(3);
    expect(skillModifier(druid, 'religion')).toBe(2);
    expect(skillModifier(cleric({ features: [order('Divine Order (Protector)')] }), 'religion')).toBe(2);
  });

  it("applies to Intelligence checks only, so not when the DM calls for another ability", () => {
    const c = cleric({ abilityScores: { str: 10, dex: 12, con: 14, int: 12, wis: 17, cha: 8 }, skillBonuses: [thaumaturge] });
    expect(rollRequestModifier(c, request({ skill: 'religion' }))).toEqual({ modifier: 6, label: 'Religion check (INT)' });
    expect(rollRequestModifier(c, request({ skill: 'religion', ability: 'int' })).modifier).toBe(6);
    expect(rollRequestModifier(c, request({ skill: 'religion', ability: 'wis' })).modifier).toBe(5); // WIS 3 + PB 2, no bonus
    expect(rollRequestModifier({ ...c, exhaustion: 1 }, request({ skill: 'arcana' })).modifier).toBe(2); // 1 + 3 − 2
  });

  it('flat bonuses count in passive scores too', () => {
    const hawk = mira({ skillBonuses: [{ skills: ['perception'], flat: 2, source: 'Hawk-eyed (homebrew)' }] });
    expect(skillModifier(hawk, 'perception')).toBe(5);
    expect(passivePerception(hawk)).toBe(15);
  });
});

describe('damage dice that grow with level', () => {
  const wizard = (level: number, extra: Partial<Character> = {}) => mira({ classes: [{ ...mira().classes[0], level }], ...extra });
  const blast: Attack = {
    id: 'eb',
    name: 'Eldritch Blast',
    ability: 'spell',
    proficient: true,
    damage: '1d10',
    damageType: 'force',
    addAbilityToDamage: false,
    notes: 'Cantrip',
    scaling: 'cantrip',
  };

  it('cantrip dice ×2 at character level 5, ×3 at 11, ×4 at 17 (SRD 5.2.1 Fire Bolt, "Cantrip Upgrade")', () => {
    const levels = [1, 4, 5, 10, 11, 16, 17, 20];
    expect(levels.map((l) => attackDamageExpression(wizard(l), fireBolt(wizard(l))))).toEqual([
      '1d10', '1d10', '2d10', '2d10', '3d10', '3d10', '4d10', '4d10',
    ]);
    const rayOfFrost: Attack = { ...blast, id: 'rof', name: 'Ray of Frost', damage: '1d8', damageType: 'cold' };
    expect(attackDamageExpression(wizard(5), rayOfFrost)).toBe('2d8');
    expect(attackDamageExpression(wizard(5), rayOfFrost, true)).toBe('4d8');
    expect(rollRequestExpression(wizard(11), request({ rollType: 'damage', attackName: 'Fire Bolt' }))).toBe('3d10');
    expect(attackDamageExpression(wizard(5), dagger(wizard(5)))).toBe('1d4+2'); // weapons don't scale
  });

  it('uses the character level across classes; older sheets are recognised but never scaled twice', () => {
    const multi = mira({ classes: [...mira().classes, { classId: 'srd:class:fighter', name: 'Fighter', level: 2, hitDie: 10, casterType: 'none' }] });
    expect(attackScaling(multi, fireBolt(multi))).toBe('cantrip'); // a known cantrip of the same name
    expect(attackDamageExpression(multi, fireBolt(multi))).toBe('2d10');
    const noted: Attack = { ...fireBolt(multi), name: 'Chill Touch', notes: 'Cantrip' };
    expect(attackDamageExpression(multi, noted)).toBe('2d10');
    expect(attackDamageExpression(multi, { ...fireBolt(multi), damage: '2d10' })).toBe('2d10'); // already scaled by hand
    expect(attackScaling(multi, { ...fireBolt(multi), name: 'Scorching Ray' })).toBeUndefined(); // a level 2 spell
    // Newer sheets mark every scaling attack, so a cantrip left unmarked doesn't gain dice.
    const newer = { ...multi, attacks: [{ ...fireBolt(multi), scaling: 'cantrip' as const }, { ...noted, name: 'Magic Stone', damage: '1d6' }] };
    expect(attackDamageExpression(newer, newer.attacks[0])).toBe('2d10');
    expect(attackDamageExpression(newer, newer.attacks[1])).toBe('1d6');
  });

  it('Eldritch Blast gains beams, not dice (SRD 5.2.1 Eldritch Blast, "Cantrip Upgrade")', () => {
    expect(attackDamageExpression(wizard(11), blast)).toBe('1d10');
    expect([1, 5, 11, 17].map((l) => eldritchBlastBeams(wizard(l), blast))).toEqual([1, 2, 3, 4]);
    expect(eldritchBlastBeams(wizard(5), fireBolt(wizard(5)))).toBeNull();
  });

  it("a Monk's Unarmed Strike rolls the Martial Arts die for the Monk level (SRD 5.2.1 Monk Features table)", () => {
    const strike: Attack = { id: 'us', name: 'Unarmed Strike', ability: 'finesse', proficient: true, damage: '1d6', damageType: 'bludgeoning', scaling: 'martial-arts' };
    const monk = (level: number, extra: Partial<Character> = {}) =>
      mira({
        abilityScores: { str: 10, dex: 16, con: 12, int: 8, wis: 16, cha: 10 },
        classes: [{ classId: 'srd:class:monk', name: 'Monk', level, hitDie: 8, casterType: 'none' }],
        spellcasting: undefined,
        attacks: [strike],
        ...extra,
      });
    const levels = [1, 4, 5, 10, 11, 16, 17, 20];
    expect(levels.map((l) => attackDamageExpression(monk(l), strike))).toEqual([
      '1d6+3', '1d6+3', '1d8+3', '1d8+3', '1d10+3', '1d10+3', '1d12+3', '1d12+3',
    ]);
    expect(attackDamageExpression(monk(5), strike, true)).toBe('2d8+3');
    expect(rollRequestExpression(monk(11), request({ rollType: 'damage', attackName: 'Unarmed Strike' }))).toBe('1d10+3');
    // Martial Arts works only without armor or a Shield: the builder's strike rolls its normal 1 + STR (STR 10).
    const armored = monk(5, { inventory: [{ id: 'la', name: 'Leather Armor', quantity: 1, equipped: true, category: 'armor' }] });
    expect(attackDamageExpression(armored, strike)).toBe('1');
    // Older sheets: the Unarmed Strike of a Monk is recognised by name.
    expect(attackDamageExpression(monk(5), { ...strike, scaling: undefined })).toBe('1d8+3');
    // A bigger weapon die is kept ("in place of the normal damage" only when that's better).
    expect(attackDamageExpression(monk(5), { ...strike, damage: '1d10' })).toBe('1d10+3');
  });

  it("a 2024 book's Monk rolls the same Martial Arts die and makes Dexterous Attacks; an older book's keeps its own die (SRD 5.2.1 Monk: Martial Arts)", () => {
    const strike: Attack = { id: 'us', name: 'Unarmed Strike', ability: 'finesse', proficient: true, damage: '1d6', damageType: 'bludgeoning', scaling: 'martial-arts' };
    const ref = (format: '2024' | '2014'): ImportedRef => ({ sourceId: 'lamp', sourceTitle: 'The Lamp Folio', entryId: 'lib:lamp:class:monk', kind: 'class', entryName: 'Monk', textHash: '', textCopied: false, format });
    const bookMonk = (level: number, format: '2024' | '2014', attacks: Attack[] = [strike]) =>
      mira({
        abilityScores: { str: 10, dex: 16, con: 12, int: 8, wis: 16, cha: 10 },
        classes: [{ classId: 'lib:lamp:class:monk', name: 'Monk', level, hitDie: 8, casterType: 'none', ref: ref(format) }],
        spellcasting: undefined,
        attacks,
        inventory: [],
        features: [],
      });
    expect([1, 5, 11, 17].map((l) => attackDamageExpression(bookMonk(l, '2024'), strike))).toEqual(['1d6+3', '1d8+3', '1d10+3', '1d12+3']);
    // An older book's Monk: its own Martial Arts die (a 2014 Monk's grows differently), as on the sheet.
    expect(attackDamageExpression(bookMonk(11, '2014'), strike)).toBe('1d6+3');
    // Dexterous Attacks: an Unarmed Strike off the sheet uses DEX 3 (not STR 0), plus the Proficiency Bonus 3.
    expect(rollRequestModifier(bookMonk(5, '2024', []), request({ rollType: 'attack', attackName: 'Unarmed Strike' }))).toEqual({ modifier: 6, label: 'Unarmed Strike attack' });
    // Unarmored Defense (SRD 5.2.1 Monk): 10 + DEX 3 + WIS 3, from the class itself.
    expect(computeArmorClass(bookMonk(1, '2024')).ac).toBe(16);
  });

  it("Dexterous Attacks: a Monk's Unarmed Strike made before the Monk levels uses DEX, never in armor or with a Shield (SRD 5.2.1 Monk, Martial Arts)", () => {
    // A Fighter's Unarmed Strike (STR), the hero now a Monk too.
    const strike: Attack = { id: 'us', name: 'Unarmed Strike', ability: 'str', proficient: true, damage: '1', damageType: 'bludgeoning' };
    // A Greataxe isn't a Monk weapon (Heavy, Two-Handed): it keeps Strength.
    const greataxe: Attack = { id: 'ga', name: 'Greataxe', ability: 'str', proficient: true, damage: '1d12', damageType: 'slashing' };
    const ref: ImportedRef = { sourceId: 'lamp', sourceTitle: 'The Lamp Folio', entryId: 'lib:lamp:class:monk', kind: 'class', entryName: 'Monk', textHash: '', textCopied: false, format: '2024' };
    const hero = (monk: Character['classes'][number], inventory: InventoryItem[] = []) =>
      mira({
        abilityScores: { str: 10, dex: 16, con: 12, int: 8, wis: 14, cha: 10 },
        classes: [{ classId: 'srd:class:fighter', name: 'Fighter', level: 1, hitDie: 10, casterType: 'none' }, monk],
        spellcasting: undefined,
        attacks: [strike, greataxe],
        inventory,
        features: [],
      });
    for (const monk of [
      { classId: 'srd:class:monk', name: 'Monk', level: 4, hitDie: 8 as const, casterType: 'none' as const },
      { classId: 'lib:lamp:class:monk', name: 'Monk', level: 4, hitDie: 8 as const, casterType: 'none' as const, ref },
    ]) {
      // DEX 3 + Proficiency Bonus 3 to hit; the Martial Arts die with DEX for damage.
      expect(attackBonus(hero(monk), strike)).toBe(6);
      expect(attackDamageExpression(hero(monk), strike)).toBe('1d6+3');
      expect(attackBonus(hero(monk), greataxe)).toBe(3);
      const shield: InventoryItem = { id: 'sh', name: 'Shield', quantity: 1, equipped: true, category: 'armor' };
      expect(attackBonus(hero(monk, [shield]), strike)).toBe(3);
      expect(rollRequestModifier({ ...hero(monk, [shield]), attacks: [] }, request({ rollType: 'attack', attackName: 'Unarmed Strike' })).modifier).toBe(3);
    }
  });

  it("prices an unarmed strike the sheet doesn't list by that name: 1 + STR, or a Monk's Martial Arts die and DEX (SRD 5.2.1 Unarmed Strike; Monk, Martial Arts)", () => {
    const ref: ImportedRef = { sourceId: 'lamp', sourceTitle: 'The Lamp Folio', entryId: 'lib:lamp:class:monk', kind: 'class', entryName: 'Monk', textHash: '', textCopied: false, format: '2024' };
    const shield: InventoryItem = { id: 'sh', name: 'Shield', quantity: 1, equipped: true, category: 'armor' };
    const monk = (classLevel: Character['classes'][number], inventory: InventoryItem[] = []) =>
      mira({ abilityScores: { str: 10, dex: 16, con: 12, int: 8, wis: 16, cha: 10 }, classes: [classLevel], spellcasting: undefined, attacks: [], inventory, features: [] });
    for (const cl of [
      { classId: 'srd:class:monk', name: 'Monk', level: 5, hitDie: 8 as const, casterType: 'none' as const },
      { classId: 'lib:lamp:class:monk', name: 'Monk', level: 5, hitDie: 8 as const, casterType: 'none' as const, ref },
    ]) {
      expect(unarmedDamageExpression(monk(cl))).toBe('1d8+3');
      expect(unarmedDamageExpression(monk(cl), true)).toBe('2d8+3');
      expect(rollRequestExpression(monk(cl), request({ rollType: 'damage', attackName: 'Kick' }))).toBe('1d8+3');
      // With a Shield, no Martial Arts: 1 + STR 0.
      expect(unarmedDamageExpression(monk(cl, [shield]))).toBe('1');
    }
    // Anyone else: 1 + STR, never below 0; the sheet's Unarmed Strike when it has one.
    const fighter = (str: number, attacks: Attack[] = []) =>
      mira({ abilityScores: { ...mira().abilityScores, str }, classes: [{ classId: 'srd:class:fighter', name: 'Fighter', level: 1, hitDie: 10, casterType: 'none' }], spellcasting: undefined, attacks });
    expect(unarmedDamageExpression(fighter(16))).toBe('4');
    expect(unarmedDamageExpression(fighter(6))).toBe('0');
    const brawler: Attack = { id: 'us', name: 'Unarmed Strike', ability: 'str', proficient: true, damage: '1d4', damageType: 'bludgeoning' };
    expect(unarmedDamageExpression(fighter(16, [brawler]))).toBe('1d4+3');
    // A blank damage on the sheet's falls back to everyone's.
    expect(unarmedDamageExpression(fighter(16, [{ ...brawler, damage: '' }]))).toBe('4');
    // "Clenched Fist" (SRD 5.2.1 Arcane Hand) isn't an unarmed strike; "Fist (Bonus Action)" is.
    expect(() => rollRequestExpression(fighter(16), request({ rollType: 'damage', attackName: 'Clenched Fist' }))).toThrow(/needs an attack/);
    expect(rollRequestExpression(fighter(16), request({ rollType: 'damage', attackName: 'Fist (Bonus Action)' }))).toBe('4');
    expect(rollRequestExpression(fighter(16), request({ rollType: 'damage', attackName: 'Bare Fists' }))).toBe('4');
    expect(() => rollRequestExpression(fighter(16), request({ rollType: 'damage', attackName: 'Arcane Hand (Clenched Fist)' }))).toThrow(/needs an attack/);
    expect(() => rollRequestExpression(fighter(16), request({ rollType: 'damage', attackName: 'Fist (Arcane Hand)' }))).toThrow(/needs an attack/);
    for (const name of ['Clenched-Fist', 'Spectral Fist', 'Fist of Force', 'Fist (Arcane-Hand)']) {
      expect(() => rollRequestExpression(fighter(16), request({ rollType: 'damage', attackName: name }))).toThrow(/needs an attack/);
    }
    expect(rollRequestExpression(fighter(16), request({ rollType: 'damage', attackName: 'Fist Strike' }))).toBe('4');
    // A weapon that names a fist keeps the DM's `ability`.
    expect(rollRequestModifier(fighter(16), request({ rollType: 'attack', attackName: 'Fist-sized Rock', ability: 'dex' })).label).toMatch(/^Fist-sized Rock attack \(DEX/);
    expect(rollRequestModifier(fighter(16), request({ rollType: 'attack', attackName: 'Clenched Fist' })).label).not.toMatch(/Unarmed Strike/);
    expect(rollRequestModifier(fighter(16), request({ rollType: 'attack', attackName: 'Spinning Kick' })).label).toBe('Unarmed Strike attack');
  });

  it('Martial Arts follows the Monk level, not the character level, and replaces the flat 1', () => {
    const fighterMonk = mira({
      abilityScores: { ...mira().abilityScores, str: 16 },
      classes: [
        { classId: 'srd:class:fighter', name: 'Fighter', level: 5, hitDie: 10, casterType: 'none' },
        { classId: 'srd:class:monk', name: 'Monk', level: 1, hitDie: 8, casterType: 'none' },
      ],
      spellcasting: undefined,
      inventory: [],
      attacks: [{ id: 'us', name: 'Unarmed Strike', ability: 'str', proficient: true, damage: '1', damageType: 'bludgeoning' }],
    });
    expect(attackDamageExpression(fighterMonk, fighterMonk.attacks[0])).toBe('1d6+3');
    const notAMonk = { ...fighterMonk, classes: [fighterMonk.classes[0]] };
    expect(attackDamageExpression(notAMonk, notAMonk.attacks[0])).toBe('4'); // 1 + STR 3
  });
});

describe('critical range (SRD 5.2.1 Fighter Subclass: Champion — Improved Critical, Superior Critical)', () => {
  const longsword: Attack = { id: 'ls', name: 'Longsword', ability: 'str', proficient: true, damage: '1d8', damageType: 'slashing' };
  const champion = (level: number, extra: Partial<Character> = {}) =>
    mira({
      classes: [{ classId: 'srd:class:fighter', name: 'Fighter', level, hitDie: 10, casterType: 'none', subclass: 'Champion' }],
      attacks: [longsword, ...mira().attacks],
      ...extra,
    });

  it('19–20 from Champion 3, 18–20 from Champion 15', () => {
    expect(weaponCritRange(mira())).toBe(20);
    expect(weaponCritRange(champion(2))).toBe(20);
    expect(weaponCritRange(champion(3))).toBe(19);
    expect(weaponCritRange(champion(14))).toBe(19);
    expect(weaponCritRange(champion(15))).toBe(18);
    const feature = (name: string): Feature => ({ id: name, name, source: 'subclass', sourceName: 'Champion 3', description: '' });
    expect(weaponCritRange(mira({ features: [feature('Improved Critical')] }))).toBe(19);
    expect(weaponCritRange(mira({ features: [feature('Improved Critical'), feature('Superior Critical')] }))).toBe(18);
  });

  it('covers weapon and Unarmed Strike attack rolls only', () => {
    const c = champion(3);
    expect(attackCritRange(c, { rollType: 'attack', attackName: 'Longsword' })).toBe(19);
    expect(attackCritRange(c, { rollType: 'attack', attackName: 'Unarmed Strike' })).toBe(19);
    expect(attackCritRange(c, { rollType: 'attack', attackName: 'Longbow' })).toBe(19); // a weapon not on the sheet
    expect(attackCritRange(c, { rollType: 'attack', attackName: 'Fire Bolt' })).toBe(20); // spell attack on the sheet
    expect(attackCritRange(c, { rollType: 'attack', attackName: 'Scorching Ray' })).toBe(20); // a known spell
    expect(attackCritRange(c, { rollType: 'skill' })).toBe(20);
    expect(attackCritRange(mira(), { rollType: 'attack', attackName: 'Dagger' })).toBe(20);
  });

  it("makes a Champion's natural 19 a Critical Hit, which hits", () => {
    const critRange = attackCritRange(champion(3), { rollType: 'attack', attackName: 'Longsword' });
    expect(applyAttackRollRules(manualD20Result(19, 5, { dc: 30 }), { critRange })).toMatchObject({ isCritical: true, success: true });
    expect(applyAttackRollRules(manualD20Result(18, 5, { dc: 15 }), { critRange })).toMatchObject({ isCritical: false, success: true });
  });
});

describe('syncArmorClass (SRD 5.2.1 Armor table, Armor Class; Ring of Protection)', () => {
  const fighter = mira({ armorTraining: ['Light armor', 'Medium armor', 'Heavy armor', 'Shields'] });

  it('replaces an AC that was worked out from gear and features', () => {
    const r = syncArmorClass(fighter, wearing(fighter, { name: 'Chain Mail', category: 'armor' }));
    expect(r.character).toMatchObject({ armorClass: 16, acFormula: 'Chain Mail 16' });
    expect(r.events).toEqual([{ type: 'combat', message: 'AC 12 → 16 (Chain Mail 16)' }]);
  });

  it("keeps an AC set by hand (an effect the app doesn't count, such as Haste) and reports the computed value", () => {
    const hasted = { ...fighter, armorClass: 15 };
    const r = syncArmorClass(hasted, wearing(hasted, { name: 'Ring of Protection', category: 'magic-item', attuned: true }));
    expect(r.character.armorClass).toBe(15);
    expect(r.events).toEqual([
      {
        type: 'warning',
        message:
          "AC kept at 15: it differs from the 12 that gear and features gave, so it may include an effect the app doesn't count or a manual change. Gear and features now give AC 13 (10 + DEX 2 + Ring of Protection 1); update the AC if that is right.",
      },
    ]);
  });

  it("is silent when the computed AC doesn't change, and flags armor it can't identify", () => {
    expect(syncArmorClass(fighter, { ...fighter, notes: 'new notes' })).toEqual({ character: { ...fighter, notes: 'new notes' }, events: [] });
    const mystery = syncArmorClass(fighter, wearing(fighter, { name: 'Dragonhide Coat', category: 'armor' }));
    expect(mystery.character.armorClass).toBe(12);
    expect(mystery.events[0].message).toBe("AC kept at 12: Dragonhide Coat's armor stats are unknown, so set the AC by hand.");
  });

  it('uses the catalog when one is given', () => {
    const catalog: EquipmentOption[] = [{ id: 'hb:armor:mithral', name: 'Mithral Plate', category: 'armor', armorClass: 18, dexCap: 0, armorType: 'heavy' }];
    const worn = wearing(fighter, { name: 'Mithral Plate', category: 'armor', compendiumId: 'hb:armor:mithral' });
    expect(syncArmorClass(fighter, worn, catalog).character.armorClass).toBe(18);
    expect(syncArmorClass(fighter, worn).character.armorClass).toBe(12); // unknown without the catalog: kept
  });
});

describe('AC from spells: Mage Armor and Shield of Faith (srd:spell:mage-armor; srd:spell:shield-of-faith; srd:rule:armor-class)', () => {
  const fighter = mira({ armorTraining: ['Light armor', 'Medium armor', 'Heavy armor', 'Shields'] });
  /** In Chain Mail, AC 16 worked out from it. */
  const mailed = (patch: Partial<Character> = {}) => wearing({ ...fighter, armorClass: 16, acFormula: 'Chain Mail 16', ...patch }, { name: 'Chain Mail', category: 'armor' });
  const withSpells = (c: Character, ...names: AcSpellName[]): Character => ({ ...c, acSpells: names });

  it('counts each spell as its text says, by its exact name, or that name with a trailing note (H1/HN1/HX1)', () => {
    // srd:spell:mage-armor: "Until the spell ends, the target's base AC becomes 13 plus its Dexterity modifier."
    // srd:spell:shield-of-faith: "granting it a +2 bonus to AC for the duration".
    expect(AC_SPELLS).toEqual({ 'Mage Armor': { base: 13 }, 'Shield of Faith': { bonus: 2 } });
    expect(['mage armor', 'MAGE-ARMOR', ' Shield of Faith '].map(acSpellNamed)).toEqual(['Mage Armor', 'Mage Armor', 'Shield of Faith']);
    // A sheet copy's note, or a casting's, is left off (withoutNote): a Spell Scroll's copy, a multiclass sheet's copy.
    expect(['Shield of Faith (scroll)', 'Shield of Faith (Paladin)', 'shield of faith (2nd level)', 'Mage Armor (scroll)'].map(acSpellNamed)).toEqual([
      'Shield of Faith',
      'Shield of Faith',
      'Shield of Faith',
      'Mage Armor',
    ]);
    // Never a looser match: "Shield" (the spell) isn't Shield of Faith, a note alone is no spell, and one note only is
    // left off.
    for (const name of ['Shield', 'Shield (scroll)', '(scroll)', 'Faith (scroll)', 'Shield of Faith (scroll) (2nd level)', 'Haste', 'Barkskin', '']) {
      expect(acSpellNamed(name), name).toBeUndefined();
    }
    expect(acSpellNamed(3 as unknown as string)).toBeUndefined();
  });

  it('reads the records leniently: known names once each, in a fixed order', () => {
    const stored = ['Shield of Faith', 'mage armor', 'Mage Armor', 'Haste', 3, null] as unknown as AcSpellName[];
    expect(acSpells({ acSpells: stored })).toEqual(['Mage Armor', 'Shield of Faith']);
    expect(acSpells({ acSpells: 'Mage Armor' as unknown as AcSpellName[] })).toEqual([]);
    expect(acSpells({})).toEqual([]);
  });

  it('Mage Armor is one more base AC, used without armor (srd:spell:mage-armor: "who isn\'t wearing armor")', () => {
    expect(computeArmorClass(withSpells(mira(), 'Mage Armor'))).toEqual({ ac: 15, formula: 'Mage Armor: 13 + DEX 2' });
    // Armor worn: not counted (and not ended: the record stays, and counts again once the armor is off).
    expect(computeArmorClass(withSpells(mailed(), 'Mage Armor'))).toEqual({ ac: 16, formula: 'Chain Mail 16' });
    expect(countedAcSpells({ acSpells: ['Mage Armor'], acFormula: 'Chain Mail 16' })).toEqual([]);
  });

  it('Mage Armor competes with Unarmored Defense and Draconic Resilience: one base AC only, the best (srd:rule:armor-class: "you choose which calculation to use; you can\'t use more than one")', () => {
    // srd:rule:barbarian-unarmored-defense: 10 + DEX + CON, "You can use a Shield and still gain this benefit."
    const barbarian = (con: number, ...items: Array<Partial<InventoryItem> & { name: string }>) =>
      wearing(
        withSpells(
          mira({
            abilityScores: { str: 16, dex: 14, con, int: 8, wis: 10, cha: 10 },
            armorTraining: ['Light armor', 'Medium armor', 'Shields'],
            classes: [{ classId: 'srd:class:barbarian', name: 'Barbarian', level: 1, hitDie: 12, casterType: 'none' }],
          }),
          'Mage Armor',
        ),
        ...items,
      );
    // CON 16: Unarmored Defense 15 ties with Mage Armor 15, and the feature keeps the AC (the spell adds nothing).
    expect(computeArmorClass(barbarian(16))).toEqual({ ac: 15, formula: 'Unarmored Defense: 10 + DEX 2 + CON 3' });
    expect(computeArmorClass(barbarian(18)).formula).toBe('Unarmored Defense: 10 + DEX 2 + CON 4');
    expect(computeArmorClass(barbarian(12))).toEqual({ ac: 15, formula: 'Mage Armor: 13 + DEX 2' });
    expect(computeArmorClass(barbarian(12, { name: 'Shield', category: 'shield' }))).toEqual({ ac: 17, formula: 'Mage Armor: 13 + DEX 2 + Shield 2' });
    // srd:rule:monk-unarmored-defense: 10 + DEX + WIS "While you aren't wearing armor or wielding a Shield".
    const monk = (wis: number, ...items: Array<Partial<InventoryItem> & { name: string }>) =>
      wearing(
        mira({
          abilityScores: { str: 10, dex: 16, con: 12, int: 8, wis, cha: 10 },
          classes: [{ classId: 'srd:class:monk', name: 'Monk', level: 2, hitDie: 8, casterType: 'none' }],
          armorTraining: ['Shields'],
        }),
        ...items,
      );
    expect(computeArmorClass(withSpells(monk(16), 'Mage Armor'))).toEqual({ ac: 16, formula: 'Unarmored Defense: 10 + DEX 3 + WIS 3' });
    expect(computeArmorClass(withSpells(monk(12), 'Mage Armor'))).toEqual({ ac: 16, formula: 'Mage Armor: 13 + DEX 3' });
    // With a Shield the Monk's Unarmored Defense goes, and Mage Armor (which allows one) is the best base left.
    const shield = { name: 'Shield', category: 'shield' as const };
    expect(computeArmorClass(monk(16, shield)).ac).toBe(15);
    expect(computeArmorClass(withSpells(monk(16, shield), 'Mage Armor'))).toEqual({ ac: 18, formula: 'Mage Armor: 13 + DEX 3 + Shield 2' });
    // srd:rule:sorcerer-draconic-sorcery-draconic-resilience: 10 + DEX + CHA "While you aren't wearing armor".
    const sorcerer = (cha: number) =>
      withSpells(
        mira({
          classes: [{ classId: 'srd:class:sorcerer', name: 'Sorcerer', level: 3, hitDie: 6, casterType: 'full', spellcastingAbility: 'cha', subclass: 'Draconic Sorcery', subclassId: 'srd:subclass:draconic-sorcery' }],
          features: [],
          inventory: [],
          abilityScores: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha },
        }),
        'Mage Armor',
      );
    expect(computeArmorClass(sorcerer(18))).toEqual({ ac: 16, formula: 'Draconic Resilience: 10 + DEX 2 + CHA 4' });
    expect(computeArmorClass(sorcerer(16)).formula).toBe('Draconic Resilience: 10 + DEX 2 + CHA 3');
    expect(computeArmorClass(sorcerer(10))).toEqual({ ac: 15, formula: 'Mage Armor: 13 + DEX 2' });
  });

  it('items still add to Mage Armor: Bracers of Defense without a Shield, a Ring of Protection (srd:magic-item:bracers-of-defense; srd:magic-item:ring-of-protection)', () => {
    const bracers = { name: 'Bracers of Defense', category: 'magic-item' as const, attuned: true };
    const ring = { name: 'Ring of Protection', category: 'magic-item' as const, attuned: true };
    const trained = withSpells(mira({ armorTraining: ['Shields'] }), 'Mage Armor');
    expect(computeArmorClass(wearing(trained, bracers))).toEqual({ ac: 17, formula: 'Mage Armor: 13 + DEX 2 + Bracers of Defense 2' });
    expect(computeArmorClass(wearing(trained, bracers, { name: 'Shield', category: 'shield' })).formula).toBe('Mage Armor: 13 + DEX 2 + Shield 2');
    expect(computeArmorClass(wearing(trained, ring))).toEqual({ ac: 16, formula: 'Mage Armor: 13 + DEX 2 + Ring of Protection 1' });
  });

  it('Shield of Faith adds 2 to whatever the AC is worked out from, after the items', () => {
    expect(computeArmorClass(withSpells(mailed(), 'Shield of Faith'))).toEqual({ ac: 18, formula: 'Chain Mail 16 + Shield of Faith 2' });
    const shielded = wearing(withSpells(fighter, 'Shield of Faith'), { name: 'Chain Mail', category: 'armor' }, { name: 'Shield', category: 'shield' });
    expect(computeArmorClass(shielded)).toEqual({ ac: 20, formula: 'Chain Mail 16 + Shield 2 + Shield of Faith 2' });
    const ring: InventoryItem = { id: 'r', name: 'Ring of Protection', quantity: 1, magic: true, attuned: true, bonuses: { ac: 1 } };
    const both = withSpells(mira({ inventory: [ring], features: [] }), 'Mage Armor', 'Shield of Faith');
    expect(computeArmorClass(both)).toEqual({ ac: 18, formula: 'Mage Armor: 13 + DEX 2 + Ring of Protection 1 + Shield of Faith 2' });
    expect(countedAcSpells({ ...both, acFormula: computeArmorClass(both).formula })).toEqual(['Mage Armor', 'Shield of Faith']);
    // Armor the app can't identify: the stored AC stands, records or not (syncArmorClass moves it by the bonus).
    const elven = wearing({ ...withSpells(fighter, 'Shield of Faith'), armorClass: 17 }, { name: 'Elven Chain', category: 'armor' });
    expect(computeArmorClass(elven).ac).toBe(17);
  });

  it('counts a spell as in the AC only when its part is in the formula', () => {
    expect(countedAcSpells({ acSpells: ['Mage Armor', 'Shield of Faith'], acFormula: 'set by the DM: Haste + Shield of Faith 2' })).toEqual(['Shield of Faith']);
    // An old save's hand-set formula names a spell without its part; a part without a record isn't one.
    expect(countedAcSpells({ acSpells: ['Mage Armor'], acFormula: 'set by the DM: Mage Armor' })).toEqual([]);
    expect(countedAcSpells({ acFormula: 'Mage Armor: 13 + DEX 2' })).toEqual([]);
    expect(countedAcSpells({ acSpells: ['Shield of Faith'] })).toEqual([]);
  });

  it('reads whole ` + ` parts only, never a piece of one: the DM\'s words are no marker (engine-lens note)', () => {
    const both: AcSpellName[] = ['Mage Armor', 'Shield of Faith'];
    for (const acFormula of [
      'set by the DM: Shield of Faith 2nd casting',
      'set by the DM: Haste + Shield of Faith 2 from a ring',
      'set by the DM: Mage Armor: 13 from the scroll',
      'set by the DM: Shield of Faith 2',
      'Mage Armor:13 + DEX 2',
    ]) {
      expect(countedAcSpells({ acSpells: both, acFormula }), acFormula).toEqual([]);
    }
    // A worked-out formula's notes follow its last part, and that part still counts.
    expect(countedAcSpells({ acSpells: both, acFormula: 'Chain Mail 16 + Shield of Faith 2 (untrained in heavy armor: Disadvantage on STR/DEX D20 Tests and no spellcasting)' })).toEqual(['Shield of Faith']);
    expect(countedAcSpells({ acSpells: both, acFormula: 'Mage Armor: 13 + DEX 2 (no Shield training: the Shield gives no AC)' })).toEqual(['Mage Armor']);
    expect(countedAcSpells({ acSpells: both, acFormula: 'Elven Chain (stats unknown — AC kept at 17) + Shield of Faith 2' })).toEqual(['Shield of Faith']);
  });

  it("handSetNames: an AC set by hand names a spell in the DM's words, never in the app's own parts (E2)", () => {
    // srd:spell:slow: "it takes a -2 penalty to AC"; srd:spell:shield-of-faith: "a +2 bonus to AC for the duration".
    const slowed = 'set by the DM: Slow from the Stone Golem + Shield of Faith 2';
    expect(handSetNames(slowed, 'Slow')).toBe(true);
    expect(handSetNames(slowed, 'Shield of Faith')).toBe(false);
    expect(handSetNames('set by the DM: Haste + Mage Armor: 13 + Shield of Faith 2', 'Mage Armor')).toBe(false);
    // An old save's words do name it, the app's part beside them or not.
    expect(handSetNames('set by the DM: Shield of Faith', 'Shield of Faith')).toBe(true);
    expect(handSetNames('set by the DM: Shield of Faith and Haste + Shield of Faith 2', 'Shield of Faith')).toBe(true);
    expect(handSetNames('set by the DM: Shield of Faith from Brother Aldo', 'Shield of Faith')).toBe(true);
    // Whole words only, and only an AC set by hand with the DM's reason.
    expect(handSetNames('set by the DM: Hasted', 'Haste')).toBe(false);
    expect(handSetNames('Chain Mail 16 + Shield of Faith 2', 'Shield of Faith')).toBe(false);
    expect(handSetNames('set by the DM', 'Haste')).toBe(false);
    expect(handSetNames(undefined, 'Haste')).toBe(false);
    expect(handSetNames(18 as unknown as string, 'Haste')).toBe(false);
    // The DM tools and the sheet read it from the engine barrel.
    expect(engine.handSetNames).toBe(handSetNames);
  });

  it('handSetNames reads a noted name as its spell: the DM\'s "Haste" names a sheet copy\'s "Haste (scroll)" (H1/HX2; srd:spell:haste: "it gains a +2 bonus to Armor Class")', () => {
    expect(handSetNames('set by the DM: Haste', 'Haste (scroll)')).toBe(true);
    expect(handSetNames('set by the DM: Haste (scroll)', 'Haste (scroll)')).toBe(true);
    expect(handSetNames('set by the DM: Haste', 'Haste')).toBe(true);
    // An AC spell's copy: an old save's words name it, until the app has taken the spell off them.
    expect(handSetNames('set by the DM: Shield of Faith', 'Shield of Faith (scroll)')).toBe(true);
    expect(handSetNames('set by the DM: Shield of Faith + Shield of Faith ended', 'Shield of Faith (scroll)')).toBe(false);
    // Still whole words only, and the app's own parts are never the DM's words.
    expect(handSetNames('set by the DM: Hasted', 'Haste (scroll)')).toBe(false);
    expect(handSetNames('set by the DM: Slow from the Stone Golem + Shield of Faith 2', 'Shield of Faith (scroll)')).toBe(false);
  });

  describe("syncArmorClass's one AC rule for a spell recorded or ended", () => {
    it('a derived AC becomes the AC worked out: Shield of Faith adds 2, and ending it takes them off', () => {
      const up = syncArmorClass(mailed(), withSpells(mailed(), 'Shield of Faith'));
      expect(up.character).toMatchObject({ armorClass: 18, acFormula: 'Chain Mail 16 + Shield of Faith 2' });
      expect(up.events).toEqual([{ type: 'combat', message: 'AC 16 → 18 (Chain Mail 16 + Shield of Faith 2)' }]);
      const down = syncArmorClass(up.character, withSpells(up.character));
      expect(down.character).toMatchObject({ armorClass: 16, acFormula: 'Chain Mail 16' });
    });

    it('an AC set by hand moves by +2 and −2, its formula keeping the part ("set by the DM: Haste + Shield of Faith 2")', () => {
      // A hand-set Haste 18 on gear that gives 16 (srd:spell:haste: "+2 bonus to Armor Class"), then Shield of Faith: 20.
      const hasted = mailed({ armorClass: 18, acFormula: 'set by the DM: Haste' });
      const up = syncArmorClass(hasted, withSpells(hasted, 'Shield of Faith'));
      expect(up.character).toMatchObject({ armorClass: 20, acFormula: 'set by the DM: Haste + Shield of Faith 2' });
      expect(up.events).toEqual([{ type: 'combat', message: 'AC 18 → 20 (Shield of Faith +2)' }]);
      expect(countedAcSpells(up.character)).toEqual(['Shield of Faith']);
      const down = syncArmorClass(up.character, withSpells(up.character));
      expect(down.character).toMatchObject({ armorClass: 18, acFormula: 'set by the DM: Haste' });
      expect(down.events).toEqual([{ type: 'combat', message: 'AC 20 → 18 (Shield of Faith −2)' }]);
    });

    it('armor the app can\'t identify moves by +2 and −2 too, though computeArmorClass keeps the stored AC', () => {
      const elven = wearing({ ...fighter, armorClass: 17, acFormula: 'Elven Chain (stats unknown — AC kept at 17)' }, { name: 'Elven Chain', category: 'armor' });
      const up = syncArmorClass(elven, withSpells(elven, 'Shield of Faith'));
      expect(up.character).toMatchObject({ armorClass: 19, acFormula: 'Elven Chain (stats unknown — AC kept at 17) + Shield of Faith 2' });
      expect(up.events).toEqual([{ type: 'combat', message: 'AC 17 → 19 (Shield of Faith +2)' }]);
      const down = syncArmorClass(up.character, withSpells(up.character));
      expect(down.character).toMatchObject({ armorClass: 17, acFormula: 'Elven Chain (stats unknown — AC kept at 17)' });
      expect(down.events).toEqual([{ type: 'combat', message: 'AC 19 → 17 (Shield of Faith −2)' }]);
      // Mage Armor adds no bonus, and doesn't count in armor: nothing moves.
      expect(syncArmorClass(elven, withSpells(elven, 'Mage Armor'))).toEqual({ character: withSpells(elven, 'Mage Armor'), events: [] });
    });

    it("an old save's hand-set AC that already counted the spell is kept, once (srd:rule:casting-spells-effects-combining-spell-effects: the same spell's effects \"don't combine\")", () => {
      // AC 18 "set by the DM: Shield of Faith" on gear that gives 16: recording the spell keeps 18 and makes it derived.
      const old = mailed({ armorClass: 18, acFormula: 'set by the DM: Shield of Faith' });
      const r = syncArmorClass(old, withSpells(old, 'Shield of Faith'));
      expect(r).toEqual({ character: { ...withSpells(old, 'Shield of Faith'), acFormula: 'Chain Mail 16 + Shield of Faith 2' }, events: [] });
      expect(countedAcSpells(r.character)).toEqual(['Shield of Faith']);
      // From then on ending it takes the 2 off once.
      expect(syncArmorClass(r.character, withSpells(r.character)).character).toMatchObject({ armorClass: 16, acFormula: 'Chain Mail 16' });
      // An old save's Mage Armor 15 (base 13 + DEX 2) is kept the same way.
      const robe = mira({ armorClass: 15, acFormula: 'set by the DM: Mage Armor' });
      expect(syncArmorClass(robe, withSpells(robe, 'Mage Armor'))).toEqual({ character: { ...withSpells(robe, 'Mage Armor'), acFormula: 'Mage Armor: 13 + DEX 2' }, events: [] });
    });

    it('Mage Armor over an AC set by hand for something else: kept, with what gear, features and spells now give', () => {
      const hasted = mira({ armorClass: 14, acFormula: 'set by the DM: Haste' });
      const r = syncArmorClass(hasted, withSpells(hasted, 'Mage Armor'));
      expect(r.character.armorClass).toBe(14);
      expect(r.events).toEqual([
        {
          type: 'warning',
          message:
            "AC kept at 14: it differs from the 12 that gear and features gave, so it may include an effect the app doesn't count or a manual change. Gear and features now give AC 15 (Mage Armor: 13 + DEX 2); update the AC if that is right.",
        },
      ]);
    });

    it('equipping armor over Mage Armor leaves the record: it stops counting, and counts again when the armor comes off', () => {
      const robe = withSpells(mira({ armorTraining: ['Heavy armor'], armorClass: 15, acFormula: 'Mage Armor: 13 + DEX 2' }), 'Mage Armor');
      const armored = syncArmorClass(robe, wearing(robe, { name: 'Chain Mail', category: 'armor' }));
      expect(armored.character).toMatchObject({ armorClass: 16, acFormula: 'Chain Mail 16', acSpells: ['Mage Armor'] });
      expect(countedAcSpells(armored.character)).toEqual([]);
      const off = syncArmorClass(armored.character, { ...armored.character, inventory: [] });
      expect(off.character).toMatchObject({ armorClass: 15, acFormula: 'Mage Armor: 13 + DEX 2' });
    });

    it('a Shield of Faith a hand-set AC counted ends by its 2, whatever the rest adds up to (E1; srd:spell:slow: "it takes a -2 penalty to AC")', () => {
      // Slowed in Chain Mail (16): the DM sets 14, then Shield of Faith (srd:spell:shield-of-faith: "+2 bonus to AC").
      const slowed = mailed({ armorClass: 14, acFormula: 'set by the DM: Slow from the Stone Golem' });
      const up = syncArmorClass(slowed, withSpells(slowed, 'Shield of Faith'));
      expect(up.character).toMatchObject({ armorClass: 16, acFormula: 'set by the DM: Slow from the Stone Golem + Shield of Faith 2' });
      expect(up.events).toEqual([{ type: 'combat', message: 'AC 14 → 16 (Shield of Faith +2)' }]);
      // 16 is what Chain Mail alone gives, but the AC isn't Chain Mail's: ending the spell takes its 2 off, Slow stays.
      const down = syncArmorClass(up.character, withSpells(up.character));
      expect(down.character).toMatchObject({ armorClass: 14, acFormula: 'set by the DM: Slow from the Stone Golem' });
      expect(down.events).toEqual([{ type: 'combat', message: 'AC 16 → 14 (Shield of Faith −2)' }]);
    });

    it("an old save's hand-set AC naming the spell keeps its number when gear doesn't add up to it: never counted twice (E3/H2; srd:rule:casting-spells-effects-combining-spell-effects: the same spell's effects \"don't combine\")", () => {
      // 20 "set by the DM: Shield of Faith and Haste" on Chain Mail 16: recording Shield of Faith keeps 20, now counted.
      const two = mailed({ armorClass: 20, acFormula: 'set by the DM: Shield of Faith and Haste' });
      const r = syncArmorClass(two, withSpells(two, 'Shield of Faith'));
      expect(r.character).toMatchObject({ armorClass: 20, acFormula: 'set by the DM: Shield of Faith and Haste + Shield of Faith 2' });
      expect(countedAcSpells(r.character)).toEqual(['Shield of Faith']);
      expect(r.events).toEqual([
        {
          type: 'warning',
          message:
            'AC 20 was set by hand naming Shield of Faith: kept, and Shield of Faith is now counted in it (ending Shield of Faith takes 2 off). Gear, features and spells give 18 (Chain Mail 16 + Shield of Faith 2); update the AC if that is right.',
        },
      ]);
      // Ending it later takes the 2 off once (Haste's +2 stays: srd:spell:haste, "+2 bonus to Armor Class"), and the
      // DM's words stop counting it (E1: "Shield of Faith ended").
      expect(syncArmorClass(r.character, withSpells(r.character)).character).toMatchObject({
        armorClass: 18,
        acFormula: 'set by the DM: Shield of Faith and Haste + Shield of Faith ended',
      });

      // 18 "set by the DM: Shield of Faith" on Chain Mail 16, with a Ring of Protection attuned since (the AC was kept at
      // 18 then): kept at 18, counted, and the warning gives 19 (srd:magic-item:ring-of-protection: "+1 bonus to Armor Class").
      const ringed = wearing(
        { ...fighter, armorClass: 18, acFormula: 'set by the DM: Shield of Faith' },
        { name: 'Chain Mail', category: 'armor' },
        { name: 'Ring of Protection', category: 'magic-item', attuned: true },
      );
      const kept = syncArmorClass(ringed, withSpells(ringed, 'Shield of Faith'));
      expect(kept.character).toMatchObject({ armorClass: 18, acFormula: 'set by the DM: Shield of Faith + Shield of Faith 2' });
      expect(countedAcSpells(kept.character)).toEqual(['Shield of Faith']);
      expect(kept.events.map((e) => e.message)).toEqual([
        'AC 18 was set by hand naming Shield of Faith: kept, and Shield of Faith is now counted in it (ending Shield of Faith takes 2 off). Gear, features and spells give 19 (Chain Mail 16 + Ring of Protection 1 + Shield of Faith 2); update the AC if that is right.',
      ]);

      // A wizard (gear 12) with an old 17 "set by the DM: Shield of Faith from Brother Aldo" (Mage Armor and an ally's
      // Shield of Faith, both by hand): either order of recording the two never gives 19.
      const wizard = mira({ armorClass: 17, acFormula: 'set by the DM: Shield of Faith from Brother Aldo' });
      const faithFirst = syncArmorClass(wizard, withSpells(wizard, 'Shield of Faith')).character;
      expect(faithFirst).toMatchObject({ armorClass: 17, acFormula: 'set by the DM: Shield of Faith from Brother Aldo + Shield of Faith 2' });
      const thenArmor = syncArmorClass(faithFirst, withSpells(faithFirst, 'Mage Armor', 'Shield of Faith'));
      expect(thenArmor).toEqual({ character: withSpells(faithFirst, 'Mage Armor', 'Shield of Faith'), events: [] }); // 13 + 2 + 2: 17 already
      const armorFirst = syncArmorClass(wizard, withSpells(wizard, 'Mage Armor')).character;
      expect(armorFirst.armorClass).toBe(17);
      const thenFaith = syncArmorClass(armorFirst, withSpells(armorFirst, 'Mage Armor', 'Shield of Faith'));
      expect(thenFaith).toEqual({ character: { ...withSpells(armorFirst, 'Mage Armor', 'Shield of Faith'), acFormula: 'Mage Armor: 13 + DEX 2 + Shield of Faith 2' }, events: [] });

      // Under armor the app can't identify, the second sentence is left out (it can't work the AC out).
      const elven = wearing({ ...fighter, armorClass: 19, acFormula: 'set by the DM: Elven Chain and Shield of Faith' }, { name: 'Elven Chain', category: 'armor' });
      const unknown = syncArmorClass(elven, withSpells(elven, 'Shield of Faith'));
      expect(unknown.character).toMatchObject({ armorClass: 19, acFormula: 'set by the DM: Elven Chain and Shield of Faith + Shield of Faith 2' });
      expect(unknown.events.map((e) => e.message)).toEqual([
        'AC 19 was set by hand naming Shield of Faith: kept, and Shield of Faith is now counted in it (ending Shield of Faith takes 2 off).',
      ]);
    });

    it('armor the app can\'t identify, newly worn, keeps the parts of the bonus spells the AC counted (E4/S1; srd:spell:shield-of-faith)', () => {
      const faithful = withSpells(mailed({ armorClass: 18, acFormula: 'Chain Mail 16 + Shield of Faith 2' }), 'Shield of Faith');
      // Chain Mail off, Elven Chain on (srd:magic-item:elven-chain, whose entry gives the engine no armor stats). The
      // armor's part keeps the AC less the +2 its parts add (E3), so it reads as 18.
      const swapped = syncArmorClass(faithful, wearing(faithful, { name: 'Elven Chain', category: 'armor' }));
      expect(swapped.character).toMatchObject({ armorClass: 18, acFormula: 'Elven Chain (stats unknown — AC kept at 16) + Shield of Faith 2' });
      expect(countedAcSpells(swapped.character)).toEqual(['Shield of Faith']);
      expect(swapped.events).toEqual([{ type: 'warning', message: "AC kept at 18: Elven Chain's armor stats are unknown, so set the AC by hand." }]);
      // So ending it takes its 2 off, and the number and the words agree (16).
      const ended = syncArmorClass(swapped.character, withSpells(swapped.character));
      expect(ended.character).toMatchObject({ armorClass: 16, acFormula: 'Elven Chain (stats unknown — AC kept at 16)' });
      expect(ended.events).toEqual([{ type: 'combat', message: 'AC 18 → 16 (Shield of Faith −2)' }]);
      // The same armor, not newly worn (renamed): the same text from the AC less the +2, and no warning (E3).
      const renamed = syncArmorClass(swapped.character, {
        ...swapped.character,
        inventory: swapped.character.inventory.map((i) => (i.name === 'Elven Chain' ? { ...i, name: 'Dragonhide Coat' } : i)),
      });
      expect(renamed.character).toMatchObject({ armorClass: 18, acFormula: 'Dragonhide Coat (stats unknown — AC kept at 16) + Shield of Faith 2' });
      expect(renamed.events).toEqual([]);
      // A recorded Shield of Faith whose part isn't in the formula isn't in the stored AC: ending it moves nothing.
      const bare = { ...swapped.character, acFormula: 'Elven Chain (stats unknown — AC kept at 18)' };
      expect(syncArmorClass(bare, withSpells(bare))).toEqual({ character: withSpells(bare), events: [] });
      const handSet = { ...swapped.character, armorClass: 20, acFormula: 'set by the DM: Elven Chain 18 + 2' };
      expect(syncArmorClass(handSet, withSpells(handSet))).toEqual({ character: withSpells(handSet), events: [] });
      // Under armor it knows, the AC set by hand stays too; the warning gives what gear and features give.
      const hasted = withSpells(mailed({ armorClass: 20, acFormula: 'set by the DM: Haste and the shrine' }), 'Shield of Faith');
      const kept = syncArmorClass(hasted, withSpells(hasted));
      expect(kept.character).toEqual(withSpells(hasted));
      expect(kept.events.map((e) => e.message)).toEqual([
        "AC kept at 20: it differs from the 18 that gear and features gave, so it may include an effect the app doesn't count or a manual change. Gear and features now give AC 16 (Chain Mail 16); update the AC if that is right.",
      ]);
    });

    it('a hand-set formula drops Mage Armor\'s part once armor goes on or the record ends: never counted then (E5/H7/S7; srd:spell:mage-armor: "a willing creature who isn\'t wearing armor"; srd:rule:armor-class)', () => {
      const robe = (patch: Partial<Character> = {}) =>
        withSpells(mira({ armorTraining: ['Light armor'], armorClass: 17, acFormula: 'set by the DM: Haste + Mage Armor: 13', ...patch }), 'Mage Armor');
      expect(countedAcSpells(robe())).toEqual(['Mage Armor']);
      // Leather Armor on: the stored AC stays (a base isn't a delta) and the warning says what gear gives.
      const leather = syncArmorClass(robe(), wearing(robe(), { name: 'Leather Armor', category: 'armor' }));
      expect(leather.character).toMatchObject({ armorClass: 17, acFormula: 'set by the DM: Haste', acSpells: ['Mage Armor'] });
      expect(countedAcSpells(leather.character)).toEqual([]);
      expect(leather.events.map((e) => e.message)).toEqual([
        "AC kept at 17: it differs from the 15 that gear and features gave, so it may include an effect the app doesn't count or a manual change. Gear and features now give AC 13 (Leather Armor 11 + DEX 2); update the AC if that is right.",
      ]);
      // Armor it can't identify, too.
      const elven = syncArmorClass(robe(), wearing(robe(), { name: 'Elven Chain', category: 'armor' }));
      expect(elven.character.acFormula).toBe('set by the DM: Haste');
      // The record ends: the part goes with it, even when nothing else changed (armor already on).
      const worn = wearing(robe(), { name: 'Leather Armor', category: 'armor' });
      expect(syncArmorClass(worn, withSpells(worn)).character.acFormula).toBe('set by the DM: Haste');
      const ended = syncArmorClass(robe(), withSpells(robe()));
      expect(ended.character).toMatchObject({ armorClass: 17, acFormula: 'set by the DM: Haste' });
      expect(ended.events.map((e) => e.message)).toEqual([
        "AC kept at 17: it differs from the 15 that gear and features gave, so it may include an effect the app doesn't count or a manual change. Gear and features now give AC 12 (10 + DEX 2); update the AC if that is right.",
      ]);
      // While it applies, the part stays; Shield of Faith's part stays under armor.
      const shield = { name: 'Shield', category: 'shield' as const };
      expect(syncArmorClass(robe({ armorTraining: ['Shields'] }), wearing(robe({ armorTraining: ['Shields'] }), shield)).character.acFormula).toBe(
        'set by the DM: Haste + Mage Armor: 13',
      );
      const faith = { ...withSpells(robe(), 'Mage Armor', 'Shield of Faith'), armorClass: 19, acFormula: 'set by the DM: Haste + Mage Armor: 13 + Shield of Faith 2' };
      expect(syncArmorClass(faith, wearing(faith, { name: 'Leather Armor', category: 'armor' })).character.acFormula).toBe('set by the DM: Haste + Shield of Faith 2');
      // A hero without the records keeps a formula as it was (the DM's own words).
      const plain = mira({ armorTraining: ['Light armor'], armorClass: 17, acFormula: 'set by the DM: Haste + Mage Armor: 13' });
      expect(syncArmorClass(plain, wearing(plain, { name: 'Leather Armor', category: 'armor' })).character.acFormula).toBe('set by the DM: Haste + Mage Armor: 13');
    });

    it('the app\'s "ended" part: once the app has taken a spell off an AC set by hand, the DM\'s words naming it no longer count it (E1; srd:spell:shield-of-faith: "a +2 bonus to AC for the duration")', () => {
      const ended = 'set by the DM: Shield of Faith and Haste + Shield of Faith ended';
      expect(handSetNames(ended, 'Shield of Faith')).toBe(false);
      expect(handSetNames(ended, 'shield of faith')).toBe(false);
      // The rest of the DM's words still count (srd:spell:haste: "a +2 bonus to Armor Class").
      expect(handSetNames(ended, 'Haste')).toBe(true);
      // An "ended" part is the app's own, never the DM's words, for either AC spell.
      expect(handSetNames('set by the DM: Haste + Shield of Faith ended', 'Faith')).toBe(false);
      expect(handSetNames('set by the DM: Haste + Mage Armor ended', 'Mage Armor')).toBe(false);
      // Only a whole part is the app's: the DM's own "(Shield of Faith ended)" inside a reason stays the DM's words.
      expect(handSetNames('set by the DM: Haste (Shield of Faith ended)', 'Shield of Faith')).toBe(true);
      // Never a counted part, and a formula the app worked out has none.
      expect(countedAcSpells({ acSpells: ['Shield of Faith'], acFormula: ended })).toEqual([]);
      expect(handSetNames('Chain Mail 16 + Shield of Faith ended', 'Haste')).toBe(false);
    });

    it("each casting adds Shield of Faith's 2 and each end takes it off, under the DM's words naming it: never counted in twice, never taken off twice (E1; srd:spell:shield-of-faith: \"a +2 bonus to AC for the duration\"; srd:rule:casting-spells-effects-combining-spell-effects: \"the effects of the same spell cast multiple times don't combine\" only \"while their durations overlap\")", () => {
      type Sync = ReturnType<typeof syncArmorClass>;
      const others = (c: Character) => acSpells(c).filter((n) => n !== 'Shield of Faith');
      /** Shield of Faith recorded (a casting) or ended, the other records kept: what addAcSpell and endAcSpell sync. */
      const cast = (c: Character): Sync => syncArmorClass(c, withSpells(c, ...others(c), 'Shield of Faith'));
      const end = (c: Character): Sync => syncArmorClass(c, withSpells(c, ...others(c)));
      /** The steps in turn (a casting, an end…), each from where the one before left the hero. */
      const run = (start: Character, ...steps: Array<(c: Character) => Sync>) => {
        let c = start;
        return steps.map((step) => {
          const r = step(c);
          c = r.character;
          return r;
        });
      };
      const cycle = (start: Character) => run(start, cast, end, cast, end);
      const acs = (runs: Sync[]) => runs.map((r) => [r.character.armorClass, r.character.acFormula]);

      // FIXES' kept examples: an old save's 20 "set by the DM: Shield of Faith and Haste" on Chain Mail 16 (Haste from
      // an ally, srd:spell:haste) goes 20/18/20/18, never turning derived; the marker is exactly "Shield of Faith ended".
      const haste = cycle(mailed({ armorClass: 20, acFormula: 'set by the DM: Shield of Faith and Haste' }));
      expect(acs(haste)).toEqual([
        [20, 'set by the DM: Shield of Faith and Haste + Shield of Faith 2'],
        [18, 'set by the DM: Shield of Faith and Haste + Shield of Faith ended'],
        [20, 'set by the DM: Shield of Faith and Haste + Shield of Faith 2'],
        [18, 'set by the DM: Shield of Faith and Haste + Shield of Faith ended'],
      ]);
      // The second casting is a plain +2 (nothing "already counted"), and each end a plain −2.
      expect(haste.slice(1).map((r) => r.events)).toEqual([
        [{ type: 'combat', message: 'AC 20 → 18 (Shield of Faith −2)' }],
        [{ type: 'combat', message: 'AC 18 → 20 (Shield of Faith +2)' }],
        [{ type: 'combat', message: 'AC 20 → 18 (Shield of Faith −2)' }],
      ]);

      // 18 "set by the DM: Shield of Faith" on Chain Mail 16 with a Ring of Protection attuned since
      // (srd:magic-item:ring-of-protection: "a +1 bonus to Armor Class"): 18/16/18/16.
      const ringed = wearing(
        { ...fighter, armorClass: 18, acFormula: 'set by the DM: Shield of Faith' },
        { name: 'Chain Mail', category: 'armor' },
        { name: 'Ring of Protection', category: 'magic-item', attuned: true },
      );
      expect(acs(cycle(ringed))).toEqual([
        [18, 'set by the DM: Shield of Faith + Shield of Faith 2'],
        [16, 'set by the DM: Shield of Faith + Shield of Faith ended'],
        [18, 'set by the DM: Shield of Faith + Shield of Faith 2'],
        [16, 'set by the DM: Shield of Faith + Shield of Faith ended'],
      ]);

      // The wizard (gear 12) with an old 17 "set by the DM: Shield of Faith from Brother Aldo": never 19, and 17 again
      // after an end and a recast, alone or beside Mage Armor recorded first or last.
      const wizard = mira({ armorClass: 17, acFormula: 'set by the DM: Shield of Faith from Brother Aldo' });
      expect(acs(cycle(wizard))).toEqual([
        [17, 'set by the DM: Shield of Faith from Brother Aldo + Shield of Faith 2'],
        [15, 'set by the DM: Shield of Faith from Brother Aldo + Shield of Faith ended'],
        [17, 'set by the DM: Shield of Faith from Brother Aldo + Shield of Faith 2'],
        [15, 'set by the DM: Shield of Faith from Brother Aldo + Shield of Faith ended'],
      ]);
      const armorLast = syncArmorClass(cast(wizard).character, withSpells(cast(wizard).character, 'Mage Armor', 'Shield of Faith')).character;
      const armorFirst = cast(syncArmorClass(wizard, withSpells(wizard, 'Mage Armor')).character).character;
      for (const both of [armorLast, armorFirst]) {
        expect(both.armorClass).toBe(17);
        const off = end(both).character;
        expect(off.armorClass).toBe(15);
        expect(cast(off).character.armorClass).toBe(17);
      }

      // A new save: the DM's reason names the spell while it is recorded and counted (statSteps keeps the part).
      // srd:spell:slow: "it takes a -2 penalty to AC": 16, then 14/16/14.
      const slowed = withSpells(mailed({ armorClass: 16, acFormula: 'set by the DM: Slow from the Stone Golem (-2); Shield of Faith still up + Shield of Faith 2' }), 'Shield of Faith');
      expect(acs(run(slowed, end, cast, end))).toEqual([
        [14, 'set by the DM: Slow from the Stone Golem (-2); Shield of Faith still up + Shield of Faith ended'],
        [16, 'set by the DM: Slow from the Stone Golem (-2); Shield of Faith still up + Shield of Faith 2'],
        [14, 'set by the DM: Slow from the Stone Golem (-2); Shield of Faith still up + Shield of Faith ended'],
      ]);
      // And Haste: 20, then 18/20/18.
      const hasted = withSpells(mailed({ armorClass: 20, acFormula: 'set by the DM: Haste from Lyra, on top of Shield of Faith + Shield of Faith 2' }), 'Shield of Faith');
      expect(acs(run(hasted, end, cast, end))).toEqual([
        [18, 'set by the DM: Haste from Lyra, on top of Shield of Faith + Shield of Faith ended'],
        [20, 'set by the DM: Haste from Lyra, on top of Shield of Faith + Shield of Faith 2'],
        [18, 'set by the DM: Haste from Lyra, on top of Shield of Faith + Shield of Faith ended'],
      ]);
      // Under armor the app can't identify, the same: 19, then 17/19.
      const elven = wearing({ ...fighter, armorClass: 19, acFormula: 'set by the DM: Elven Chain and Shield of Faith' }, { name: 'Elven Chain', category: 'armor' });
      expect(acs(cycle(elven)).map(([ac]) => ac)).toEqual([19, 17, 19, 17]);
      expect(end(cast(elven).character).character.acFormula).toBe('set by the DM: Elven Chain and Shield of Faith + Shield of Faith ended');
    });

    it("a hand-set AC no higher than what gear and features give is taken not to hold a spell its words name: the spell is added, with F3's warning (E2/F3; srd:spell:shield-of-faith: \"a +2 bonus to AC\"; srd:rule:armor-class)", () => {
      // The D1 state: an old save's 18 "set by the DM: Shield of Faith" in Chain Mail, and a Shield donned since, so the
      // gear gives 18 too. Recording the spell adds its 2 through the derived branch: 20, and its end 18. The words name
      // the spell, so the DM is told how to put 18 back if it counted it beside a penalty (F3).
      const shielded = wearing(
        { ...fighter, armorClass: 18, acFormula: 'set by the DM: Shield of Faith' },
        { name: 'Chain Mail', category: 'armor' },
        { name: 'Shield', category: 'shield' },
      );
      const up = syncArmorClass(shielded, withSpells(shielded, 'Shield of Faith'));
      expect(up.character).toMatchObject({ armorClass: 20, acFormula: 'Chain Mail 16 + Shield 2 + Shield of Faith 2' });
      expect(up.events).toEqual([
        { type: 'combat', message: 'AC 18 → 20 (Chain Mail 16 + Shield 2 + Shield of Faith 2)' },
        {
          type: 'warning',
          message:
            "AC 18, set by hand, names Shield of Faith, but gear and features alone give 18, so the app now counts Shield of Faith as well (AC 20): if 18 already counted it beside a penalty the app doesn't count (such as Slow), set the AC to 18.",
        },
      ]);
      const down = syncArmorClass(up.character, withSpells(up.character));
      expect(down.character).toMatchObject({ armorClass: 18, acFormula: 'Chain Mail 16 + Shield 2' });
      // Below the gear: "set by the DM: Slow, without Shield of Faith" 14 on Chain Mail 16 (srd:spell:slow: "a -2 penalty
      // to AC") gives 16, never "AC stays 14"; its words name the spell, so the warning too (F3).
      const slowed = mailed({ armorClass: 14, acFormula: 'set by the DM: Slow, without Shield of Faith' });
      const r = syncArmorClass(slowed, withSpells(slowed, 'Shield of Faith'));
      expect(r.character).toMatchObject({ armorClass: 16, acFormula: 'set by the DM: Slow, without Shield of Faith + Shield of Faith 2' });
      expect(r.events).toEqual([
        { type: 'combat', message: 'AC 14 → 16 (Shield of Faith +2)' },
        {
          type: 'warning',
          message:
            "AC 14, set by hand, names Shield of Faith, but gear and features alone give 16, so the app now counts Shield of Faith as well (AC 16): if 14 already counted it beside a penalty the app doesn't count (such as Slow), set the AC to 14.",
        },
      ]);
      // Mage Armor's base too (srd:spell:mage-armor: "base AC becomes 13 plus its Dexterity modifier"): a hand-set 12 that
      // gear gives (10 + DEX 2) is taken to hold no Mage Armor, so recording it gives 15, and the words name it (F3).
      const robe = mira({ armorClass: 12, acFormula: 'set by the DM: Mage Armor dispelled' });
      const armored = syncArmorClass(robe, withSpells(robe, 'Mage Armor'));
      expect(armored.character).toMatchObject({ armorClass: 15, acFormula: 'Mage Armor: 13 + DEX 2' });
      expect(armored.events).toEqual([
        { type: 'combat', message: 'AC 12 → 15 (Mage Armor: 13 + DEX 2)' },
        {
          type: 'warning',
          message:
            "AC 12, set by hand, names Mage Armor, but gear and features alone give 12, so the app now counts Mage Armor as well (AC 15): if 12 already counted it beside a penalty the app doesn't count (such as Slow), set the AC to 12.",
        },
      ]);
    });

    it('the gear guard\'s baseline counts only the AC spells the formula counts: a recorded Mage Armor the DM\'s words never claimed isn\'t in it (F2/TX2; srd:spell:mage-armor: "base AC becomes 13 plus its Dexterity modifier"; srd:spell:shield-of-faith: "a +2 bonus to AC for the duration"; srd:rule:casting-spells-effects-combining-spell-effects: "the effects of the same spell cast multiple times don\'t combine")', () => {
      // A wizard (DEX 14, no armor: gear 12) with an old 14 "set by the DM: Shield of Faith from Brother Aldo" (10 + DEX 2
      // + an ally's Shield of Faith 2, by hand).
      const wizard = mira({ armorClass: 14, acFormula: 'set by the DM: Shield of Faith from Brother Aldo' });
      expect(computeArmorClass(wizard)).toEqual({ ac: 12, formula: '10 + DEX 2' });
      // Mage Armor recorded first: kept at 14 (above the gear's 12), its record beside the DM's words, not counted in them.
      const armor = syncArmorClass(wizard, withSpells(wizard, 'Mage Armor'));
      expect(armor.character).toMatchObject({ armorClass: 14, acFormula: 'set by the DM: Shield of Faith from Brother Aldo', acSpells: ['Mage Armor'] });
      expect(countedAcSpells(armor.character)).toEqual([]);
      // Then Shield of Faith: 14 is still above what gear, features and the counted spells (none) give, so the words hold
      // it: kept at 14, now counted, and the warning names the 17 gear and spells give. Never 16 (the +2 twice).
      const faith = syncArmorClass(armor.character, withSpells(armor.character, 'Mage Armor', 'Shield of Faith'));
      expect(faith.character).toMatchObject({ armorClass: 14, acFormula: 'set by the DM: Shield of Faith from Brother Aldo + Shield of Faith 2' });
      expect(countedAcSpells(faith.character)).toEqual(['Shield of Faith']);
      expect(faith.events).toEqual([
        {
          type: 'warning',
          message:
            'AC 14 was set by hand naming Shield of Faith: kept, and Shield of Faith is now counted in it (ending Shield of Faith takes 2 off). Gear, features and spells give 17 (Mage Armor: 13 + DEX 2 + Shield of Faith 2); update the AC if that is right.',
        },
      ]);
      // Ending it then takes its 2 off once.
      expect(syncArmorClass(faith.character, withSpells(faith.character, 'Mage Armor')).character.armorClass).toBe(12);
      // The other order: Shield of Faith first makes the AC derived (10 + DEX 2 + Shield of Faith 2), and Mage Armor
      // then gives 17, as before.
      const faithFirst = syncArmorClass(wizard, withSpells(wizard, 'Shield of Faith'));
      expect(faithFirst).toEqual({ character: { ...withSpells(wizard, 'Shield of Faith'), acFormula: '10 + DEX 2 + Shield of Faith 2' }, events: [] });
      const thenArmor = syncArmorClass(faithFirst.character, withSpells(faithFirst.character, 'Mage Armor', 'Shield of Faith'));
      expect(thenArmor.character).toMatchObject({ armorClass: 17, acFormula: 'Mage Armor: 13 + DEX 2 + Shield of Faith 2' });
      expect(thenArmor.events).toEqual([{ type: 'combat', message: 'AC 14 → 17 (Mage Armor: 13 + DEX 2 + Shield of Faith 2)' }]);
      // A formula that does carry Mage Armor's part counts it in the baseline. The DM set 15 "Shield of Faith dispelled"
      // while Mage Armor was counted (the part kept): 15 is what Mage Armor gives, so it holds no Shield of Faith, and the
      // spell cast again is added (17), with the warning (F3), never "kept at 15". The warning says what its 15 counts:
      // Mage Armor, not gear and features alone (H2/HA1).
      const dispelled = withSpells(mira({ armorClass: 15, acFormula: 'set by the DM: Shield of Faith dispelled + Mage Armor: 13' }), 'Mage Armor');
      expect(countedAcSpells(dispelled)).toEqual(['Mage Armor']);
      const recast = syncArmorClass(dispelled, withSpells(dispelled, 'Mage Armor', 'Shield of Faith'));
      expect(recast.character).toMatchObject({ armorClass: 17, acFormula: 'Mage Armor: 13 + DEX 2 + Shield of Faith 2' });
      expect(recast.events.map((e) => e.message)).toEqual([
        'AC 15 → 17 (Mage Armor: 13 + DEX 2 + Shield of Faith 2)',
        "AC 15, set by hand, names Shield of Faith, but gear, features and Mage Armor give 15, so the app now counts Shield of Faith as well (AC 17): if 15 already counted it beside a penalty the app doesn't count (such as Slow), set the AC to 15.",
      ]);
    });

    it('a spell the DM\'s words name, counted on a hand-set AC no higher than the baseline: one warning with how to put the AC back, only when the AC moved (F3/TE1/TX1; srd:spell:slow: "it takes a -2 penalty to AC"; srd:spell:shield-of-faith: "a +2 bonus to AC for the duration")', () => {
      // An older save: Chain Mail 16 with 16 "set by the DM: Slow (-2) and Shield of Faith" (16 − 2 + 2). The guard takes
      // 16 not to hold the spell (it is no higher than Chain Mail's 16): the AC becomes derived at 18, and the warning
      // says how to put 16 back.
      const slowed = mailed({ armorClass: 16, acFormula: 'set by the DM: Slow (-2) and Shield of Faith' });
      const r = syncArmorClass(slowed, withSpells(slowed, 'Shield of Faith'));
      expect(r.character).toMatchObject({ armorClass: 18, acFormula: 'Chain Mail 16 + Shield of Faith 2', acSpells: ['Shield of Faith'] });
      expect(r.events).toEqual([
        { type: 'combat', message: 'AC 16 → 18 (Chain Mail 16 + Shield of Faith 2)' },
        {
          type: 'warning',
          message:
            "AC 16, set by hand, names Shield of Faith, but gear and features alone give 16, so the app now counts Shield of Faith as well (AC 18): if 16 already counted it beside a penalty the app doesn't count (such as Slow), set the AC to 16.",
        },
      ]);
      // Two spells at once, both named: "them", the names joined as elsewhere.
      const both = mira({ armorClass: 12, acFormula: 'set by the DM: Mage Armor and Shield of Faith' });
      const two = syncArmorClass(both, withSpells(both, 'Mage Armor', 'Shield of Faith'));
      expect(two.character).toMatchObject({ armorClass: 17, acFormula: 'Mage Armor: 13 + DEX 2 + Shield of Faith 2' });
      expect(two.events.map((e) => e.message)).toEqual([
        'AC 12 → 17 (Mage Armor: 13 + DEX 2 + Shield of Faith 2)',
        "AC 12, set by hand, names Mage Armor and Shield of Faith, but gear and features alone give 12, so the app now counts Mage Armor and Shield of Faith as well (AC 17): if 12 already counted them beside a penalty the app doesn't count (such as Slow), set the AC to 12.",
      ]);
      // None above the baseline: the kept warning as before (20 "Shield of Faith and Haste" on Chain Mail 16).
      const hasted = mailed({ armorClass: 20, acFormula: 'set by the DM: Shield of Faith and Haste' });
      expect(syncArmorClass(hasted, withSpells(hasted, 'Shield of Faith')).events.map((e) => e.message)).toEqual([
        'AC 20 was set by hand naming Shield of Faith: kept, and Shield of Faith is now counted in it (ending Shield of Faith takes 2 off). Gear, features and spells give 18 (Chain Mail 16 + Shield of Faith 2); update the AC if that is right.',
      ]);
      // None when the words don't name the spell (srd:spell:slow alone): +2, as before.
      const slow = mailed({ armorClass: 14, acFormula: 'set by the DM: Slow from the Stone Golem' });
      expect(syncArmorClass(slow, withSpells(slow, 'Shield of Faith')).events).toEqual([{ type: 'combat', message: 'AC 14 → 16 (Shield of Faith +2)' }]);
      // None when the AC didn't move. A Barbarian's Unarmored Defense (10 + DEX 2 + CON 3) ties Mage Armor's 15 and keeps
      // the AC (srd:rule:armor-class: "you can't use more than one"): nothing changes.
      const barbarian = mira({
        abilityScores: { str: 16, dex: 14, con: 16, int: 8, wis: 10, cha: 10 },
        classes: [{ classId: 'srd:class:barbarian', name: 'Barbarian', level: 1, hitDie: 12, casterType: 'none' }],
        armorClass: 15,
        acFormula: 'set by the DM: Mage Armor',
      });
      expect(syncArmorClass(barbarian, withSpells(barbarian, 'Mage Armor'))).toEqual({ character: withSpells(barbarian, 'Mage Armor'), events: [] });
      // A hand-set 10 below the gear naming Mage Armor: Mage Armor (a base, no delta) leaves the stored AC, with the
      // kept-AC warning only.
      const dispelled = mira({ armorClass: 10, acFormula: 'set by the DM: Mage Armor dispelled; Slow (-2)' });
      const kept = syncArmorClass(dispelled, withSpells(dispelled, 'Mage Armor'));
      expect(kept.character.armorClass).toBe(10);
      expect(kept.events.map((e) => e.message)).toEqual([
        "AC kept at 10: it differs from the 12 that gear and features gave, so it may include an effect the app doesn't count or a manual change. Gear and features now give AC 15 (Mage Armor: 13 + DEX 2); update the AC if that is right.",
      ]);
    });

    it('F3\'s warning names what its baseline counts: "gear, features and Mage Armor give 15", never "alone" (H2/HA1; srd:spell:mage-armor: "base AC becomes 13 plus its Dexterity modifier"; srd:spell:shield-of-faith: "a +2 bonus to AC for the duration")', () => {
      // An older save: the wizard (DEX 14, no armor: gear 12) at 14 "set by the DM: Mage Armor and Shield of Faith; cursed
      // (-3)" (13 + 2 + 2 − 3). Both recorded in one call, in its order (update_character's ac_spells_add records one at
      // a time): Mage Armor first, kept at 14 and now counted, then Shield of Faith on a baseline of 15 that counts it.
      const cursed = mira({ armorClass: 14, acFormula: 'set by the DM: Mage Armor and Shield of Faith; cursed (-3)' });
      expect(computeArmorClass(cursed)).toEqual({ ac: 12, formula: '10 + DEX 2' });
      const armor = syncArmorClass(cursed, withSpells(cursed, 'Mage Armor'));
      expect(armor.character).toMatchObject({ armorClass: 14, acFormula: 'set by the DM: Mage Armor and Shield of Faith; cursed (-3) + Mage Armor: 13' });
      expect(armor.events.map((e) => e.message)).toEqual([
        'AC 14 was set by hand naming Mage Armor: kept, and Mage Armor is now counted in it. Gear, features and spells give 15 (Mage Armor: 13 + DEX 2); update the AC if that is right.',
      ]);
      const faith = syncArmorClass(armor.character, withSpells(armor.character, 'Mage Armor', 'Shield of Faith'));
      expect(faith.character).toMatchObject({
        armorClass: 16,
        acFormula: 'set by the DM: Mage Armor and Shield of Faith; cursed (-3) + Mage Armor: 13 + Shield of Faith 2',
      });
      expect(faith.events.map((e) => e.message)).toEqual([
        'AC 14 → 16 (Shield of Faith +2)',
        "AC 14, set by hand, names Shield of Faith, but gear, features and Mage Armor give 15, so the app now counts Shield of Faith as well (AC 16): if 14 already counted it beside a penalty the app doesn't count (such as Slow), set the AC to 14.",
      ]);
      // A counted Shield of Faith in the baseline: 14 "Mage Armor + Shield of Faith 2" (10 + DEX 2 + its 2), then Mage Armor.
      const faithful = withSpells(mira({ armorClass: 14, acFormula: 'set by the DM: Mage Armor + Shield of Faith 2' }), 'Shield of Faith');
      expect(syncArmorClass(faithful, withSpells(faithful, 'Mage Armor', 'Shield of Faith')).events.map((e) => e.message)).toEqual([
        'AC 14 → 17 (Mage Armor: 13 + DEX 2 + Shield of Faith 2)',
        "AC 14, set by hand, names Mage Armor, but gear, features and Shield of Faith give 14, so the app now counts Mage Armor as well (AC 17): if 14 already counted it beside a penalty the app doesn't count (such as Slow), set the AC to 14.",
      ]);
      // A Mage Armor recorded beside the DM's words, which the formula doesn't count, isn't in the baseline (F2), nor in
      // its words: 12 "set by the DM: Shield of Faith", then Shield of Faith.
      const beside = withSpells(mira({ armorClass: 12, acFormula: 'set by the DM: Shield of Faith' }), 'Mage Armor');
      expect(countedAcSpells(beside)).toEqual([]);
      expect(syncArmorClass(beside, withSpells(beside, 'Mage Armor', 'Shield of Faith')).events.map((e) => e.message)).toEqual([
        'AC 12 → 14 (Shield of Faith +2)',
        "AC 12, set by hand, names Shield of Faith, but gear and features alone give 12, so the app now counts Shield of Faith as well (AC 14): if 12 already counted it beside a penalty the app doesn't count (such as Slow), set the AC to 12.",
      ]);
      // Nothing counted: the words as before (srd:spell:slow: "it takes a -2 penalty to AC"; Chain Mail 16).
      const slowed = mailed({ armorClass: 16, acFormula: 'set by the DM: Slow (-2) and Shield of Faith' });
      expect(syncArmorClass(slowed, withSpells(slowed, 'Shield of Faith')).events.map((e) => e.message)).toEqual([
        'AC 16 → 18 (Chain Mail 16 + Shield of Faith 2)',
        "AC 16, set by hand, names Shield of Faith, but gear and features alone give 16, so the app now counts Shield of Faith as well (AC 18): if 16 already counted it beside a penalty the app doesn't count (such as Slow), set the AC to 16.",
      ]);
    });

    it("an AC set by hand that counted Mage Armor is flagged when Mage Armor ends and the number stays (H3/HA2; srd:spell:mage-armor: \"Until the spell ends, the target's base AC becomes 13 plus its Dexterity modifier\")", () => {
      // F3's advice followed: the wizard (gear 12) at 12 "set by the DM: cursed (-3) + Mage Armor: 13" (13 + 2 − 3), Mage
      // Armor recorded. Its end leaves 12, what gear gives too, though the curse goes on: the DM is told.
      const note = 'AC 12, set by hand, counted Mage Armor, which has ended: if 12 still includes it, set the AC again (armor and abilities give 12).';
      const cursed = withSpells(mira({ armorClass: 12, acFormula: 'set by the DM: cursed (-3) + Mage Armor: 13' }), 'Mage Armor');
      expect(countedAcSpells(cursed)).toEqual(['Mage Armor']);
      const ended = syncArmorClass(cursed, withSpells(cursed));
      expect(ended.character).toMatchObject({ armorClass: 12, acFormula: 'set by the DM: cursed (-3)' });
      expect(ended.events).toEqual([{ type: 'warning', message: note }]);
      // Set by hand without a reason ("set by the DM"): the same.
      const bare = withSpells(mira({ armorClass: 12, acFormula: 'set by the DM + Mage Armor: 13' }), 'Mage Armor');
      expect(syncArmorClass(bare, withSpells(bare))).toEqual({ character: { ...withSpells(bare), acFormula: 'set by the DM' }, events: [{ type: 'warning', message: note }] });
      // Another warning already says the AC stays (13 "cursed (-2)"): that one only.
      const kept = withSpells(mira({ armorClass: 13, acFormula: 'set by the DM: cursed (-2) + Mage Armor: 13' }), 'Mage Armor');
      expect(syncArmorClass(kept, withSpells(kept)).events.map((e) => e.message)).toEqual([
        "AC kept at 13: it differs from the 15 that gear and features gave, so it may include an effect the app doesn't count or a manual change. Gear and features now give AC 12 (10 + DEX 2); update the AC if that is right.",
      ]);
      // A derived AC goes back to what gear gives, with no warning.
      const derived = withSpells(mira({ armorClass: 15, acFormula: 'Mage Armor: 13 + DEX 2' }), 'Mage Armor');
      expect(syncArmorClass(derived, withSpells(derived)).events).toEqual([{ type: 'combat', message: 'AC 15 → 12 (10 + DEX 2)' }]);
      // Nothing for a formula not set by hand, nor for a Mage Armor the hand-set AC never counted (its part isn't in it).
      const stale = withSpells(mira({ armorClass: 12, acFormula: 'Mage Armor: 13 + DEX 2' }), 'Mage Armor');
      expect(syncArmorClass(stale, withSpells(stale)).events).toEqual([]);
      const beside = withSpells(mira({ armorClass: 12, acFormula: 'set by the DM: cursed (-3)' }), 'Mage Armor');
      expect(syncArmorClass(beside, withSpells(beside)).events).toEqual([]);
      // Nor while Mage Armor is still recorded: a Dexterity raise (14 → 16) makes the AC worked out the DM's 16.
      const blessed = withSpells(mira({ armorClass: 16, acFormula: 'set by the DM: blessed (+1) + Mage Armor: 13' }), 'Mage Armor');
      const raised = { ...blessed, abilityScores: { ...blessed.abilityScores, dex: 16 } };
      expect(computeArmorClass(raised).ac).toBe(16);
      expect(syncArmorClass(blessed, raised)).toEqual({ character: raised, events: [] });
      // Shield of Faith's +2 comes off (F3's follow-through under Slow, 16 then 14): no new warning.
      const slowed = withSpells(mailed({ armorClass: 16, acFormula: 'set by the DM: Slow from the Stone Golem (-2) + Shield of Faith 2' }), 'Shield of Faith');
      const off = syncArmorClass(slowed, withSpells(slowed));
      expect(off.character).toMatchObject({ armorClass: 14, acFormula: 'set by the DM: Slow from the Stone Golem (-2)' });
      expect(off.events.filter((e) => e.type === 'warning')).toEqual([]);
    });

    it('names a Shield of Faith still counted in the AC the warning gives when Mage Armor ends first (E5-1; srd:spell:mage-armor: "Until the spell ends, the target\'s base AC becomes 13 plus its Dexterity modifier"; srd:spell:shield-of-faith: "a +2 bonus to AC for the duration")', () => {
      // 14 "cursed (-3)" with both spells counted (13 + 2 + 2 − 3). Mage Armor ends while Shield of Faith lasts: the 14
      // the DM is told to work from holds the +2, so the words say so (armor and abilities alone give 12).
      const faithful = withSpells(mira({ armorClass: 14, acFormula: 'set by the DM: cursed (-3) + Mage Armor: 13 + Shield of Faith 2' }), 'Mage Armor', 'Shield of Faith');
      expect(countedAcSpells(faithful)).toEqual(['Mage Armor', 'Shield of Faith']);
      const first = syncArmorClass(faithful, withSpells(faithful, 'Shield of Faith'));
      expect(first.character).toMatchObject({ armorClass: 14, acFormula: 'set by the DM: cursed (-3) + Shield of Faith 2', acSpells: ['Shield of Faith'] });
      expect(first.events).toEqual([
        {
          type: 'warning',
          message: 'AC 14, set by hand, counted Mage Armor, which has ended: if 14 still includes it, set the AC again (armor, abilities and Shield of Faith give 14).',
        },
      ]);
      expect(computeArmorClass(withSpells(faithful)).ac).toBe(12);
      // The words describe the number given, the AC worked out: a Shield of Faith recorded whose part the hand-set formula
      // lacks (an older save's) is in that 14 all the same.
      const older = withSpells(mira({ armorClass: 14, acFormula: 'set by the DM: cursed (-3) + Mage Armor: 13' }), 'Mage Armor', 'Shield of Faith');
      expect(countedAcSpells(older)).toEqual(['Mage Armor']);
      expect(syncArmorClass(older, withSpells(older, 'Shield of Faith')).events).toEqual([
        {
          type: 'warning',
          message: 'AC 14, set by hand, counted Mage Armor, which has ended: if 14 still includes it, set the AC again (armor, abilities and Shield of Faith give 14).',
        },
      ]);
    });

    it('workedOutWords: what an AC worked out holds, in words, with the recorded AC spells its formula counts (E5-1; srd:spell:mage-armor: "13 plus its Dexterity modifier"; srd:spell:shield-of-faith: "a +2 bonus to AC")', () => {
      const robed = withSpells(mira(), 'Mage Armor', 'Shield of Faith');
      expect(workedOutWords(mira(), computeArmorClass(mira()).formula)).toBe('armor and abilities');
      expect(computeArmorClass(robed).formula).toBe('Mage Armor: 13 + DEX 2 + Shield of Faith 2');
      expect(workedOutWords(robed, computeArmorClass(robed).formula)).toBe('armor, abilities, Mage Armor and Shield of Faith');
      // Only what the formula counts: Mage Armor under Chain Mail isn't (srd:spell:mage-armor: "who isn't wearing armor").
      const armored = withSpells(mailed(), 'Mage Armor', 'Shield of Faith');
      expect(workedOutWords(armored, computeArmorClass(armored).formula)).toBe('armor, abilities and Shield of Faith');
      // A record whose part isn't in the formula given isn't named.
      expect(workedOutWords(robed, '10 + DEX 2')).toBe('armor and abilities');
      // Only AC spells are named: an item's part is in the number unnamed (X6-2; srd:magic-item:ring-of-protection: "You
      // gain a +1 bonus to Armor Class and saving throws while wearing this ring").
      const ringed = withSpells(wearing(mira(), { name: 'Ring of Protection', category: 'magic-item', attuned: true }), 'Shield of Faith');
      expect(computeArmorClass(ringed)).toEqual({ ac: 15, formula: '10 + DEX 2 + Ring of Protection 1 + Shield of Faith 2' });
      expect(workedOutWords(ringed, computeArmorClass(ringed).formula)).toBe('armor, abilities and Shield of Faith');
    });
  });
});

describe('imported classes and subclasses keep to their own rules (SRD 5.2.1 Classes; Champion: Improved Critical; Draconic Sorcery: Draconic Resilience)', () => {
  const asFighter = (patch: Partial<Character['classes'][number]>) =>
    mira({ classes: [{ classId: 'srd:class:fighter', name: 'Fighter', level: 3, hitDie: 10, casterType: 'none', ...patch }], features: [] });

  it('scores Improved Critical only for the SRD Champion when the entry has a subclass id', () => {
    expect(weaponCritRange(asFighter({ subclass: 'Champion', subclassId: 'srd:subclass:champion' }))).toBe(19);
    expect(weaponCritRange(asFighter({ subclass: 'Champion' }))).toBe(19);
    expect(weaponCritRange(asFighter({ subclass: 'Champion', subclassId: 'lib:gloam:subclass:champion' }))).toBe(20);
    expect(weaponCritRange(asFighter({ classId: 'lib:gloam:class:fighter', subclass: 'Champion' }))).toBe(20);
  });

  it("a 2024 book's Fighter and Paladin play by the SRD's: Improved Critical with the SRD Champion, Aura of Protection at 6; a 2014 book's don't (SRD 5.2.1 Champion; Paladin)", () => {
    const ref = (entryName: string, format: '2024' | '2014'): ImportedRef => ({
      sourceId: 'lamp', sourceTitle: 'The Lamp Folio', entryId: `lib:lamp:class:${entryName.toLowerCase()}`, kind: 'class', entryName, textHash: '', textCopied: false, format,
    });
    const bookFighter = (format: '2024' | '2014') =>
      asFighter({ classId: 'lib:lamp:class:fighter', ref: ref('Fighter', format), subclass: 'Champion', subclassId: 'srd:subclass:champion' });
    expect(weaponCritRange(bookFighter('2024'))).toBe(19);
    expect(weaponCritRange(bookFighter('2014'))).toBe(20);
    const bookPaladin = (format: '2024' | '2014') =>
      mira({
        abilityScores: { str: 16, dex: 10, con: 14, int: 8, wis: 10, cha: 16 },
        savingThrows: ['wis', 'cha'],
        classes: [{ classId: 'lib:lamp:class:paladin', name: 'Paladin', level: 6, hitDie: 10, casterType: 'half', spellcastingAbility: 'cha', ref: ref('Paladin', format) }],
        features: [],
      });
    // A Strength save: STR 3, plus CHA 3 from the aura.
    expect(savingThrowModifier(bookPaladin('2024'), 'str')).toBe(6);
    expect(savingThrowModifier(bookPaladin('2014'), 'str')).toBe(3);
  });

  it('gives Draconic Resilience only to the SRD Draconic Sorcery by id', () => {
    const sorcerer = (patch: Partial<Character['classes'][number]>) =>
      mira({
        classes: [{ classId: 'srd:class:sorcerer', name: 'Sorcerer', level: 3, hitDie: 6, casterType: 'full', spellcastingAbility: 'cha', ...patch }],
        features: [],
        inventory: [],
        abilityScores: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 16 },
      });
    expect(computeArmorClass(sorcerer({ subclass: 'Draconic Sorcery', subclassId: 'srd:subclass:draconic-sorcery' })).ac).toBe(15);
    expect(computeArmorClass(sorcerer({ subclass: 'Draconic Bloodline', subclassId: 'lib:gloam:subclass:draconic-bloodline' })).ac).toBe(12);
  });

  it('gives an imported "Barbarian" no Unarmored Defense', () => {
    const c = mira({ classes: [{ classId: 'lib:gloam:class:barbarian', name: 'Barbarian', level: 1, hitDie: 12, casterType: 'none' }], features: [], inventory: [] });
    expect(computeArmorClass(c).formula).not.toMatch(/Unarmored Defense/);
  });
});

describe('structured magic item bonuses (SRD 5.2.1 Attunement; Ring of Protection)', () => {
  const ring = (patch: Partial<InventoryItem> = {}): InventoryItem => ({
    id: 'ring',
    name: 'Ring of Protection',
    quantity: 1,
    category: 'magic-item',
    magic: true,
    requiresAttunement: true,
    bonuses: { ac: 1, savingThrows: 1 },
    ...patch,
  });
  const bare = (inventory: InventoryItem[]) => mira({ inventory, features: [], armorClass: 12 });

  it('applies AC and save bonuses only while worn and, when required, attuned', () => {
    expect(computeArmorClass(bare([ring()])).ac).toBe(12);
    expect(computeArmorClass(bare([ring({ equipped: true })])).ac).toBe(12);
    expect(computeArmorClass(bare([ring({ attuned: true })])).ac).toBe(13);
    expect(computeArmorClass(bare([ring({ attuned: true, equipped: false })])).ac).toBe(12);
    expect(savingThrowModifier(bare([ring({ attuned: true })]), 'dex')).toBe(savingThrowModifier(bare([]), 'dex') + 1);
    expect(deathSaveModifier(bare([ring({ attuned: true })]))).toBe(deathSaveModifier(bare([])) + 1);
    // No attunement needed: worn is enough.
    expect(computeArmorClass(bare([ring({ requiresAttunement: false, equipped: true })])).ac).toBe(13);
  });

  it('counts a Ring of Protection with structured bonuses once, not again by its name', () => {
    const c = bare([ring({ attuned: true })]);
    expect(computeArmorClass(c).ac).toBe(13);
    expect(savingThrowModifier(c, 'wis')).toBe(savingThrowModifier(bare([]), 'wis') + 1);
    // Two of the same item don't stack.
    expect(computeArmorClass(bare([ring({ attuned: true }), ring({ id: 'ring-2', attuned: true })])).ac).toBe(13);
  });

  it('names every save bonus it counts (saveBonusSources), and the save modifiers add exactly those', () => {
    // SRD 5.2.1 Magic Items, Cloak of Protection: "+1 bonus to Armor Class and saving throws while you wear this cloak"
    // (counted by name); an imported item's structured bonus (counted once, while it works); Aura of Protection
    // (Paladin level 6: +CHA, minimum +1, while not Incapacitated).
    const cloak: InventoryItem = { id: 'c', name: 'Cloak of Protection', quantity: 1, magic: true, attuned: true };
    const fen = ring({ id: 'fen', name: 'Cloak of the Fen', attuned: true, bonuses: { savingThrows: 2 } });
    const paladin = (inventory: InventoryItem[], patch: Partial<Character> = {}) =>
      mira({
        inventory,
        features: [],
        abilityScores: { str: 16, dex: 10, con: 14, int: 8, wis: 10, cha: 16 },
        savingThrows: ['wis', 'cha'],
        classes: [{ classId: 'srd:class:paladin', name: 'Paladin', level: 6, hitDie: 10, casterType: 'half', spellcastingAbility: 'cha' }],
        ...patch,
      });
    // Two of each: a magic item's bonus doesn't stack with another copy of itself.
    const c = paladin([cloak, { ...cloak, id: 'c-2' }, fen, { ...fen, id: 'fen-2' }]);
    expect(saveBonusSources(c)).toEqual([
      { name: 'Cloak of Protection', bonus: 1 },
      { name: 'Cloak of the Fen', bonus: 2 },
      { name: 'Aura of Protection', bonus: 3 },
    ]);
    expect(savingThrowModifier(c, 'str')).toBe(3 + 1 + 2 + 3);
    expect(deathSaveModifier(c)).toBe(1 + 2 + 3);
    expect(rollRequestModifier(c, { rollType: 'save', revealDc: false, advantage: 'normal', reason: 'any save' }).modifier).toBe(1 + 2 + 3);
    // Not attuned, taken off, Incapacitated: none of them count, and none is named.
    const off = paladin([{ ...cloak, attuned: false }, { ...fen, equipped: false }], { conditions: [{ id: 'stunned' }] });
    expect(saveBonusSources(off)).toEqual([]);
    expect(savingThrowModifier(off, 'str')).toBe(3);
    expect(saveBonusSources(bare([]))).toEqual([]);
  });

  it('respects "only without armor (and shield)"', () => {
    const bracers = (when: 'no-armor' | 'no-armor-no-shield'): InventoryItem => ({ id: 'b', name: 'Mothsilk Bracers', quantity: 1, magic: true, equipped: true, bonuses: { ac: 2, acOnlyWhen: when } });
    const armor: InventoryItem = { id: 'a', name: 'Leather Armor', quantity: 1, category: 'armor', equipped: true };
    const shield: InventoryItem = { id: 's', name: 'Shield', quantity: 1, category: 'shield', equipped: true };
    const trained = (inventory: InventoryItem[]) => mira({ inventory, features: [], armorTraining: ['Light armor', 'Shields'] });
    expect(computeArmorClass(trained([bracers('no-armor')])).ac).toBe(14);
    expect(computeArmorClass(trained([bracers('no-armor'), armor])).ac).toBe(13);
    expect(computeArmorClass(trained([bracers('no-armor'), shield])).ac).toBe(16);
    expect(computeArmorClass(trained([bracers('no-armor-no-shield'), shield])).ac).toBe(14);
  });

  it("adds a magic armor's bonus once, on top of its stored base", () => {
    const mail: InventoryItem = {
      id: 'm',
      name: "Warden's Mail",
      quantity: 1,
      category: 'armor',
      magic: true,
      equipped: true,
      requiresAttunement: false,
      armor: { kind: 'armor', armorType: 'heavy', baseAc: 16, dexCap: 0, strength: 13, stealthDisadvantage: true },
      bonuses: { ac: 1 },
    };
    const c = mira({ inventory: [mail], features: [], armorTraining: ['Heavy armor'] });
    expect(computeArmorClass(c)).toEqual({ ac: 17, formula: "Warden's Mail 16 + 1 (magic)" });
  });
});

describe('Monk weapons (SRD 5.2.1 Monk, Martial Arts: Simple Melee weapons and Martial Melee weapons that have the Light property)', () => {
  const weapon = (name: string, damage: string, kind: Pick<Attack, 'weaponCategory' | 'weaponType'> | null, properties: string[] = [], ability: Attack['ability'] = 'str'): Attack => ({
    id: name, name, ability, proficient: true, damage, damageType: 'piercing', properties, ...(kind ?? {}),
  });
  const simpleMelee = { weaponCategory: 'simple', weaponType: 'melee' } as const;
  const martialMelee = { weaponCategory: 'martial', weaponType: 'melee' } as const;
  const simpleRanged = { weaponCategory: 'simple', weaponType: 'ranged' } as const;
  const spear = weapon('Spear', '1d6', simpleMelee, ['Thrown (Range 20/60)', 'Versatile (1d8)']);
  const knife = weapon('Dagger', '1d4', simpleMelee, ['Finesse', 'Light', 'Thrown (Range 20/60)'], 'finesse');
  const greatclub = weapon('Greatclub', '1d8', simpleMelee, ['Two-Handed']);
  const shortsword = weapon('Shortsword', '1d6', martialMelee, ['Finesse', 'Light'], 'finesse');
  const longsword = weapon('Longsword', '1d8', martialMelee, ['Versatile (1d10)']);
  const dart = weapon('Dart', '1d4', simpleRanged, ['Finesse', 'Thrown (Range 20/60)'], 'finesse');
  const shield: InventoryItem = { id: 'sh', name: 'Shield', quantity: 1, equipped: true, category: 'armor' };
  const monkClass = (level: number): Character['classes'][number] => ({ classId: 'srd:class:monk', name: 'Monk', level, hitDie: 8, casterType: 'none' });
  const hero = (classes: Character['classes'], inventory: InventoryItem[] = []) =>
    mira({ abilityScores: { str: 10, dex: 16, con: 12, int: 8, wis: 16, cha: 10 }, classes, spellcasting: undefined, inventory, features: [] });
  const monk = (level: number, inventory: InventoryItem[] = []) => hero([monkClass(level)], inventory);

  it('counts Simple Melee weapons and Light Martial Melee weapons, never a ranged weapon; older attacks go by their SRD name', () => {
    expect([spear, knife, greatclub, shortsword].map(isMonkWeapon)).toEqual([true, true, true, true]);
    expect([longsword, dart].map(isMonkWeapon)).toEqual([false, false]);
    // A martial melee weapon only with Light ("Lightning" isn't Light); a spell attack never.
    expect(isMonkWeapon(weapon('Storm Blade', '1d6', martialMelee, ['Lightning']))).toBe(false);
    expect(isMonkWeapon({ ...spear, ability: 'spell' })).toBe(false);
    // By the recorded category and type, whatever the name (a book's own weapons); the record beats the name.
    expect([weapon('Lampwick Knife', '1d4', martialMelee, ['Light']), weapon('Tidewort Cudgel', '1d6', simpleMelee)].map(isMonkWeapon)).toEqual([true, true]);
    expect(isMonkWeapon(weapon('Spear', '1d6', { weaponCategory: 'martial', weaponType: 'ranged' }))).toBe(false);
    // Attacks made before the category and type were recorded.
    expect(['Spear', 'Light Hammer', 'Scimitar', 'Greatclub'].map((n) => isMonkWeapon(weapon(n, '1d6', null)))).toEqual([true, true, true, true]);
    expect(['Longsword', 'Dart', 'Shortbow', 'Whip'].map((n) => isMonkWeapon(weapon(n, '1d6', null)))).toEqual([false, false, false, false]);
  });

  it('rolls the Martial Arts die in place of a smaller weapon die by Monk level, never in armor or with a Shield', () => {
    // DEX 3 for damage (Dexterous Attacks on the Spear; the Dagger and Shortsword are Finesse).
    expect([1, 5, 11, 17].map((l) => attackDamageExpression(monk(l), spear))).toEqual(['1d6+3', '1d8+3', '1d10+3', '1d12+3']);
    expect(attackScaling(monk(5), spear)).toBe('martial-arts');
    expect(attackDamageExpression(monk(1), knife)).toBe('1d6+3');
    expect(attackDamageExpression(monk(5), shortsword)).toBe('1d8+3');
    // "You can roll": a bigger weapon die stays (the Greatclub's d8, until the d10 at Monk 11).
    expect([1, 5, 11].map((l) => attackDamageExpression(monk(l), greatclub))).toEqual(['1d8+3', '1d8+3', '1d10+3']);
    // Not Monk weapons: a Longsword (STR 0) and a Dart.
    expect(attackDamageExpression(monk(11), longsword)).toBe('1d8');
    expect(attackScaling(monk(11), longsword)).toBeUndefined();
    expect(attackDamageExpression(monk(11), dart)).toBe('1d4+3');
    // A Critical Hit doubles the Martial Arts die.
    expect(attackDamageExpression(monk(5), spear, true)).toBe('2d8+3');
    // With a Shield or in armor: the weapon's own die, and Strength for the Spear.
    expect(attackDamageExpression(monk(5, [shield]), spear)).toBe('1d6');
    expect(attackDamageExpression(monk(5, [{ id: 'la', name: 'Leather Armor', quantity: 1, equipped: true, category: 'armor' }]), spear)).toBe('1d6');
    expect(attackDamageExpression(monk(5, [shield]), knife)).toBe('1d4+3');
  });

  it('gives a Monk weapon from before the Monk levels (STR) Dexterity; anyone else keeps the weapon as it is', () => {
    const fighterClass: Character['classes'][number] = { classId: 'srd:class:fighter', name: 'Fighter', level: 1, hitDie: 10, casterType: 'none' };
    // Fighter 1 / Monk 5: Proficiency Bonus 3, DEX 3.
    expect(attackBonus(hero([fighterClass, monkClass(5)]), spear)).toBe(6);
    expect(attackDamageExpression(hero([fighterClass, monkClass(5)]), spear)).toBe('1d8+3');
    expect(attackBonus(hero([fighterClass, monkClass(5)]), longsword)).toBe(3);
    expect(attackBonus(hero([fighterClass, monkClass(5)], [shield]), spear)).toBe(3);
    const fighter = hero([{ ...fighterClass, level: 5 }]);
    expect(attackScaling(fighter, spear)).toBeUndefined();
    expect(attackBonus(fighter, spear)).toBe(3);
    expect(attackDamageExpression(fighter, spear)).toBe('1d6');
  });

  it("does the same for a 2024 book's Monk; a 2014 book's Monk keeps the weapon's own die", () => {
    const ref = (format: '2024' | '2014'): ImportedRef => ({ sourceId: 'lamp', sourceTitle: 'The Lamp Folio', entryId: 'lib:lamp:class:monk', kind: 'class', entryName: 'Monk', textHash: '', textCopied: false, format });
    const book = (format: '2024' | '2014') => hero([{ ...monkClass(5), classId: 'lib:lamp:class:monk', ref: ref(format) }]);
    expect(attackDamageExpression(book('2024'), spear)).toBe('1d8+3');
    expect(attackDamageExpression(book('2014'), spear)).toBe('1d6');
  });
});

describe("Martial Arts stops in armor or with a Shield, the builder's attacks too (SRD 5.2.1 Monk, Martial Arts)", () => {
  // As the builder makes them for a class with Martial Arts: Dexterity for the Unarmed Strike and Monk weapons, the
  // Unarmed Strike's die stored.
  const strike: Attack = { id: 'us', name: 'Unarmed Strike', ability: 'finesse', proficient: true, damage: '1d6', damageType: 'bludgeoning', range: '5 ft.', scaling: 'martial-arts' };
  const spear: Attack = { id: 'sp', name: 'Spear', ability: 'finesse', proficient: true, damage: '1d6', damageType: 'piercing', properties: ['Thrown (Range 20/60)', 'Versatile (1d8)'], weaponCategory: 'simple', weaponType: 'melee' };
  const knife: Attack = { id: 'dg', name: 'Dagger', ability: 'finesse', proficient: true, damage: '1d4', damageType: 'piercing', properties: ['Finesse', 'Light', 'Thrown (Range 20/60)'], weaponCategory: 'simple', weaponType: 'melee' };
  const shield: InventoryItem = { id: 'sh', name: 'Shield', quantity: 1, equipped: true, category: 'armor' };
  const leather: InventoryItem = { id: 'la', name: 'Leather Armor', quantity: 1, equipped: true, category: 'armor' };
  const monk5: Character['classes'][number] = { classId: 'srd:class:monk', name: 'Monk', level: 5, hitDie: 8, casterType: 'none' };
  // STR 12 (+1), DEX 16 (+3); Proficiency Bonus 3 at level 5.
  const hero = (classes: Character['classes'], inventory: InventoryItem[] = []) =>
    mira({ abilityScores: { str: 12, dex: 16, con: 12, int: 8, wis: 16, cha: 10 }, classes, spellcasting: undefined, inventory, features: [], attacks: [strike, spear, knife] });
  const numbers = (c: Character, a: Attack) => [attackBonus(c, a), attackDamageExpression(c, a)];

  it('without armor or a Shield: the Martial Arts die for the Monk level, and Dexterity', () => {
    const c = hero([monk5]);
    expect([strike, spear, knife].map((a) => numbers(c, a))).toEqual([[6, '1d8+3'], [6, '1d8+3'], [6, '1d8+3']]);
  });

  it("in armor or with a Shield: the Unarmed Strike's normal 1 and a Monk weapon's own die, with Strength; a Finesse weapon keeps Dexterity", () => {
    for (const worn of [shield, leather]) {
      const c = hero([monk5], [worn]);
      expect(numbers(c, strike)).toEqual([4, '2']);
      expect(numbers(c, spear)).toEqual([4, '1d6+1']);
      expect(numbers(c, knife)).toEqual([6, '1d4+3']);
      // The strike off the sheet ("Kick") and an older sheet's strike (no `scaling`) follow the same rule.
      expect(unarmedDamageExpression(c)).toBe('2');
      expect(attackDamageExpression(c, { ...strike, scaling: undefined })).toBe('2');
      // A die that isn't Martial Arts' (a feat's, on a Strength strike) stays.
      expect(attackDamageExpression(c, { ...strike, ability: 'str', scaling: undefined, damage: '1d4' })).toBe('1d4+1');
    }
  });

  it("prices the app's own Shield, a strike off a sheet without one, low Strength and a Dagger whose properties weren't read", () => {
    const realShield: InventoryItem = { id: 'sh2', name: 'Shield', quantity: 1, equipped: true, category: 'shield', armor: { kind: 'shield', baseAc: 2, dexCap: 0 } };
    expect(numbers(hero([monk5], [realShield]), strike)).toEqual([4, '2']);
    // No Unarmed Strike on the sheet: everyone's, 1 + STR, and the attack with STR.
    const bare = { ...hero([monk5], [realShield]), attacks: [] };
    expect(rollRequestModifier(bare, request({ rollType: 'attack', attackName: 'Kick' })).modifier).toBe(4);
    expect(unarmedDamageExpression(bare)).toBe('2');
    // STR 6: 1 - 2, but damage never goes below 0.
    const weak = { ...hero([monk5], [leather]), abilityScores: { ...hero([monk5]).abilityScores, str: 6 } };
    expect(attackDamageExpression(weak, strike)).toBe('0');
    // A book's Dagger read without its properties is still Finesse (by its SRD name): Dexterity in armor.
    expect(numbers(hero([monk5], [leather]), { ...knife, properties: [] })).toEqual([6, '1d4+3']);
    // ...where a Mace (no properties of its own) gave its Dexterity for Martial Arts.
    expect(numbers(hero([monk5], [leather]), { ...spear, name: 'Mace', properties: [] })).toEqual([4, '1d6+1']);
  });

  it("a 2014 book's Monk too, which the engine doesn't count as a Monk: the stored die and Dexterity, gone in armor", () => {
    const ref: ImportedRef = { sourceId: 'lamp', sourceTitle: 'The Lamp Folio', entryId: 'lib:lamp:class:monk', kind: 'class', entryName: 'Monk', textHash: '', textCopied: false, format: '2014' };
    const older = { ...monk5, classId: 'lib:lamp:class:monk', ref };
    // The die its book's table gave the builder (d4 at Monk 1) stays as stored.
    const bookStrike: Attack = { ...strike, damage: '1d4' };
    expect(numbers(hero([older]), bookStrike)).toEqual([6, '1d4+3']);
    expect(numbers(hero([older]), spear)).toEqual([6, '1d6+3']);
    expect(numbers(hero([older], [leather]), bookStrike)).toEqual([4, '2']);
    expect(numbers(hero([older], [leather]), spear)).toEqual([4, '1d6+1']);
    // An off-sheet "Kick" rolls as the sheet's Unarmed Strike does, with or without armor.
    const kick = (c: Character) => rollRequestModifier({ ...c, attacks: [bookStrike] }, request({ rollType: 'attack', attackName: 'Kick' })).modifier;
    expect([kick(hero([older])), kick(hero([older], [leather]))]).toEqual([6, 4]);
  });
});
