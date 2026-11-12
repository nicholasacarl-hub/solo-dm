import { describe, expect, it } from 'vitest';
import type { Attack, Character, EquipmentOption, Feature, InventoryItem, PlayerRollRequest, SkillBonus } from '@/types';
import { sampleCharacter } from '@/test/fixtures';
import { applyAttackRollRules, manualD20Result } from './dice';
import {
  abilityCheckModifier,
  abilityModifier,
  attackAbilityModifier,
  attackBonus,
  attackCritRange,
  attackDamageExpression,
  attackScaling,
  characterLevel,
  computeArmorClass,
  deathSaveModifier,
  effectiveSpeed,
  eldritchBlastBeams,
  exhaustionPenalty,
  formatModifier,
  initiativeModifier,
  passivePerception,
  proficiencyBonus,
  rollRequestExpression,
  rollRequestModifier,
  saveBonusSources,
  savingThrowModifier,
  skillModifier,
  speedDetails,
  spellAttackBonus,
  spellSaveDC,
  spellcastingAbility,
  syncArmorClass,
  weaponCritRange,
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
    // Martial Arts works only without armor or a Shield.
    const armored = monk(5, { inventory: [{ id: 'la', name: 'Leather Armor', quantity: 1, equipped: true, category: 'armor' }] });
    expect(attackDamageExpression(armored, strike)).toBe('1d6+3');
    // Older sheets: the Unarmed Strike of a Monk is recognised by name.
    expect(attackDamageExpression(monk(5), { ...strike, scaling: undefined })).toBe('1d8+3');
    // A bigger weapon die is kept ("in place of the normal damage" only when that's better).
    expect(attackDamageExpression(monk(5), { ...strike, damage: '1d10' })).toBe('1d10+3');
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

  it('keeps an AC set by hand (e.g. Mage Armor) and reports the computed value', () => {
    const mageArmor = { ...fighter, armorClass: 15 };
    const r = syncArmorClass(mageArmor, wearing(mageArmor, { name: 'Ring of Protection', category: 'magic-item', attuned: true }));
    expect(r.character.armorClass).toBe(15);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].type).toBe('warning');
    expect(r.events[0].message).toMatch(/^AC kept at 15: .*Gear and features now give AC 13 \(10 \+ DEX 2 \+ Ring of Protection 1\)/);
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

describe('imported classes and subclasses keep to their own rules (SRD 5.2.1 Classes; Champion: Improved Critical; Draconic Sorcery: Draconic Resilience)', () => {
  const asFighter = (patch: Partial<Character['classes'][number]>) =>
    mira({ classes: [{ classId: 'srd:class:fighter', name: 'Fighter', level: 3, hitDie: 10, casterType: 'none', ...patch }], features: [] });

  it('scores Improved Critical only for the SRD Champion when the entry has a subclass id', () => {
    expect(weaponCritRange(asFighter({ subclass: 'Champion', subclassId: 'srd:subclass:champion' }))).toBe(19);
    expect(weaponCritRange(asFighter({ subclass: 'Champion' }))).toBe(19);
    expect(weaponCritRange(asFighter({ subclass: 'Champion', subclassId: 'lib:gloam:subclass:champion' }))).toBe(20);
    expect(weaponCritRange(asFighter({ classId: 'lib:gloam:class:fighter', subclass: 'Champion' }))).toBe(20);
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
