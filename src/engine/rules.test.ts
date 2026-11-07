import { describe, expect, it } from 'vitest';
import type { Attack, Character, EquipmentOption, InventoryItem, PlayerRollRequest } from '@/types';
import { sampleCharacter } from '@/test/fixtures';
import {
  abilityCheckModifier,
  abilityModifier,
  attackAbilityModifier,
  attackBonus,
  attackDamageExpression,
  characterLevel,
  computeArmorClass,
  deathSaveModifier,
  effectiveSpeed,
  exhaustionPenalty,
  formatModifier,
  initiativeModifier,
  passivePerception,
  proficiencyBonus,
  rollRequestExpression,
  rollRequestModifier,
  savingThrowModifier,
  skillModifier,
  speedDetails,
  spellAttackBonus,
  spellSaveDC,
  spellcastingAbility,
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
