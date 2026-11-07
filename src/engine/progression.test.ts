import { describe, expect, it } from 'vitest';
import type { Character, ClassLevel, Feature } from '@/types';
import { sampleCharacter } from '@/test/fixtures';
import { asiLevels, findSrdClass, SRD_CLASSES } from './classData';
import type { Rng } from './dice';
import {
  XP_THRESHOLDS,
  applyLongRest,
  applyShortRest,
  levelForXp,
  levelUp,
  spendHitDie,
  xpSummary,
  xpToNextLevel,
} from './progression';
import { recomputeSlots } from './spellcasting';

const mira = (overrides: Partial<Character> = {}) => sampleCharacter(overrides);
const faces = (...rolls: Array<[number, number]>): Rng => {
  let i = 0;
  return { next: () => (rolls[i] ? (rolls[i][0] - 0.5) / rolls[i++][1] : 0.5) };
};
const asClass = (name: string, level: number, extra: Partial<ClassLevel> = {}): ClassLevel => {
  const info = findSrdClass(name)!;
  return {
    classId: info.id,
    name: info.name,
    level,
    hitDie: info.hitDie,
    casterType: info.casterType,
    ...(info.spellcastingAbility ? { spellcastingAbility: info.spellcastingAbility } : {}),
    ...extra,
  };
};
const feature = (name: string, uses?: Feature['uses']): Feature => ({ id: name, name, source: 'class', description: '', ...(uses ? { uses } : {}) });

describe('XP and levels (SRD 5.2.1 Character Advancement)', () => {
  it('has the 2024 XP table', () => {
    expect(XP_THRESHOLDS).toHaveLength(20);
    expect(XP_THRESHOLDS.slice(0, 5)).toEqual([0, 300, 900, 2700, 6500]);
    expect(XP_THRESHOLDS[19]).toBe(355_000);
  });

  it('levelForXp', () => {
    expect([0, 299, 300, 899, 900, 6499, 6500, 354_999, 355_000, 10_000_000].map(levelForXp)).toEqual([1, 1, 2, 2, 3, 4, 5, 19, 20, 20]);
  });

  it('xpToNextLevel and xpSummary', () => {
    expect(xpToNextLevel(mira())).toBe(1800);
    expect(xpToNextLevel(mira({ xp: 5000 }))).toBe(0);
    expect(xpToNextLevel(mira({ classes: [asClass('Wizard', 20)] }))).toBeNull();
    expect(xpSummary(mira())).toBe('900 XP (1,800 to level 4)');
  });
});

describe('class reference data', () => {
  it('covers the twelve SRD classes with 20 levels each', () => {
    expect(SRD_CLASSES).toHaveLength(12);
    for (const c of SRD_CLASSES) {
      expect(c.featuresByLevel).toHaveLength(20);
      expect(c.featuresByLevel[2].some((f) => f.endsWith(' Subclass'))).toBe(true); // every 2024 class picks a subclass at 3
      expect(c.featuresByLevel[18]).toContain('Epic Boon');
    }
  });

  it('knows each class’s Ability Score Improvement levels', () => {
    expect(asiLevels(findSrdClass('Wizard')!)).toEqual([4, 8, 12, 16]);
    expect(asiLevels(findSrdClass('fighter')!)).toEqual([4, 6, 8, 12, 14, 16]);
    expect(asiLevels(findSrdClass('srd:class:rogue')!)).toEqual([4, 8, 10, 12, 16]);
  });
});

describe('levelUp', () => {
  it('average HP, hit dice, slots (keeping used counts) and the level-4 ASI reminder', () => {
    const r = levelUp(mira(), { className: 'Wizard', hpMethod: 'average' });
    expect(r.newLevel).toBe(4);
    expect(r.hpGained).toBe(5); // fixed 4 + CON 1
    expect(r.character.hp).toEqual({ max: 22, current: 17, temp: 0 });
    expect(r.character.classes[0].level).toBe(4);
    expect(r.character.hitDice).toEqual([{ die: 6, total: 4, spent: 1 }]);
    expect(r.character.spellcasting?.slots).toEqual({ 1: { max: 4, used: 1 }, 2: { max: 3, used: 0 } });
    expect(r.events[0].type).toBe('level-up');
    expect(r.reminders.some((m) => m.startsWith('Wizard 4: Ability Score Improvement'))).toBe(true);
  });

  it('rolled HP has a minimum of 1', () => {
    const frail = mira({ abilityScores: { ...mira().abilityScores, con: 8 } });
    const r = levelUp(frail, { className: 'Wizard', hpMethod: 'roll', rng: faces([1, 6]) });
    expect(r.hpRoll?.total).toBe(0);
    expect(r.hpGained).toBe(1);
    const good = levelUp(mira(), { className: 'Wizard', hpMethod: 'roll', rng: faces([6, 6]) });
    expect(good.hpGained).toBe(7);
    expect(good.hpRoll?.expression).toBe('1d6+1');
  });

  it('a fixed hit-die result adds the CON modifier; a bad method falls back to the average', () => {
    expect(levelUp(mira(), { className: 'Wizard', hpMethod: { fixed: 6 } }).hpGained).toBe(7);
    expect(levelUp(mira(), { className: 'Wizard', hpMethod: undefined as never }).hpGained).toBe(5);
  });

  it('reminds about new spell slot levels and Proficiency Bonus', () => {
    const four = levelUp(mira(), { className: 'Wizard', hpMethod: 'average' }).character;
    const five = levelUp(four, { className: 'Wizard', hpMethod: 'average' });
    expect(five.character.spellcasting?.slots[3]).toEqual({ max: 2, used: 0 });
    expect(five.reminders).toContain('New spell slot level: you can now cast level 3 spells.');
    expect(five.reminders).toContain('Proficiency Bonus is now +3.');
    expect(five.reminders.some((m) => m.includes('Memorize Spell'))).toBe(true);
  });

  it('subclass at 3 for every class; class-specific ASIs; Epic Boon at 19', () => {
    const fighter = (level: number, extra: Partial<ClassLevel> = {}) =>
      mira({ spellcasting: undefined, classes: [asClass('Fighter', level, extra)], hitDice: [{ die: 10, total: level, spent: 0 }] });
    expect(levelUp(fighter(2), { className: 'Fighter', hpMethod: 'average' }).reminders).toContain('Fighter 3: choose a Fighter subclass.');
    expect(levelUp(fighter(2), { className: 'Fighter', hpMethod: 'average', subclass: 'Champion' }).reminders).not.toContain(
      'Fighter 3: choose a Fighter subclass.',
    );
    expect(levelUp(fighter(5, { subclass: 'Champion' }), { className: 'Fighter', hpMethod: 'average' }).reminders.some((m) => m.startsWith('Fighter 6: Ability Score Improvement'))).toBe(true);
    expect(levelUp(fighter(13, { subclass: 'Champion' }), { className: 'Fighter', hpMethod: 'average' }).reminders.some((m) => m.startsWith('Fighter 14: Ability Score Improvement'))).toBe(true);
    const rogue = mira({ spellcasting: undefined, classes: [asClass('Rogue', 9, { subclass: 'Thief' })] });
    expect(levelUp(rogue, { className: 'Rogue', hpMethod: 'average' }).reminders.some((m) => m.startsWith('Rogue 10: Ability Score Improvement'))).toBe(true);
    const sage = mira({ classes: [asClass('Wizard', 18, { subclass: 'Evoker' })], xp: 305_000 });
    expect(levelUp(sage, { className: 'Wizard', hpMethod: 'average' }).reminders).toContain(
      'Wizard 19: choose an Epic Boon feat (or another feat you qualify for).',
    );
  });

  it('multiclassing adds a class, a new hit die type and checks prerequisites', () => {
    const r = levelUp(mira(), { className: 'Cleric', hpMethod: 'average' });
    expect(r.newLevel).toBe(4);
    expect(r.hpGained).toBe(6); // d8 fixed 5 + CON 1
    expect(r.character.classes.map((c) => `${c.name} ${c.level}`)).toEqual(['Wizard 3', 'Cleric 1']);
    expect(r.character.classes[1]).toMatchObject({ classId: 'srd:class:cleric', hitDie: 8, casterType: 'full', spellcastingAbility: 'wis' });
    expect(r.character.hitDice).toEqual([{ die: 6, total: 3, spent: 1 }, { die: 8, total: 1, spent: 0 }]);
    expect(r.character.spellcasting?.slots).toEqual({ 1: { max: 4, used: 1 }, 2: { max: 3, used: 0 } }); // caster level 4
    expect(r.reminders[0]).toMatch(/prerequisite not met: Cleric needs 13\+ \(Wisdom 12\)/);
  });

  it('adds features and per-level HP bonuses (Dwarven Toughness)', () => {
    const dwarf = mira({ features: [...mira().features, { id: 'dt', name: 'Dwarven Toughness', source: 'species', description: '' }] });
    const r = levelUp(dwarf, {
      className: 'Wizard',
      hpMethod: 'average',
      newFeatures: [{ name: 'Tough', source: 'feat', description: '+2 HP per level' }],
    });
    expect(r.hpGained).toBe(5 + 1 + 8); // average + Dwarven Toughness + Tough (2 × level 4)
    expect(r.character.features.at(-1)).toMatchObject({ name: 'Tough', sourceName: 'Wizard 4' });
  });

  it('keeps Alert’s initiative bonus in step with the Proficiency Bonus', () => {
    const alert = mira({
      classes: [asClass('Wizard', 4)],
      initiativeBonusExtra: 2,
      features: [...mira().features, { id: 'al', name: 'Alert', source: 'feat', description: '' }],
    });
    expect(levelUp(alert, { className: 'Wizard', hpMethod: 'average' }).character.initiativeBonusExtra).toBe(3);
  });

  it('refuses at level 20 and for unknown classes without a hit die', () => {
    const max = mira({ classes: [asClass('Wizard', 20)] });
    expect(levelUp(max, { className: 'Wizard', hpMethod: 'average' }).events[0].type).toBe('warning');
    expect(levelUp(mira(), { className: 'Artificer', hpMethod: 'average' }).events[0].type).toBe('warning');
    const homebrew = levelUp(mira(), { className: 'Artificer', hitDie: 8, casterType: 'half', spellcastingAbility: 'int', hpMethod: 'average' });
    expect(homebrew.character.classes[1]).toMatchObject({ name: 'Artificer', classId: 'class:artificer' });
    expect(homebrew.reminders.some((m) => m.includes('Artificer class table'))).toBe(true);
  });

  it('the first level gets the full hit die', () => {
    const blank = mira({ classes: [], hitDice: [], hp: { max: 0, current: 0, temp: 0 }, spellcasting: undefined });
    const r = levelUp(blank, { className: 'Fighter', hpMethod: 'average' });
    expect(r.hpGained).toBe(11); // d10 max + CON 1
    expect(r.character.hp).toEqual({ max: 11, current: 11, temp: 0 });
    expect(r.newLevel).toBe(1);
  });
});

describe('spendHitDie (SRD 5.2.1 Short Rest)', () => {
  it('rolls the die + CON and heals', () => {
    const r = spendHitDie(mira(), 6, { rng: faces([3, 6]) });
    expect(r.roll?.total).toBe(4);
    expect(r.healed).toBe(4);
    expect(r.character.hp.current).toBe(16);
    expect(r.character.hitDice[0].spent).toBe(2);
    expect(r.events[0].type).toBe('hp-changed');
  });

  it('heals at least 1 HP', () => {
    const frail = mira({ abilityScores: { ...mira().abilityScores, con: 6 } });
    const r = spendHitDie(frail, 6, { rng: faces([1, 6]) });
    expect(r.roll?.total).toBe(-1);
    expect(r.healed).toBe(1);
  });

  it('accepts a roll from the dialog (bare die rolls get the CON modifier)', () => {
    const bare = spendHitDie(mira(), 6, { roll: { expression: '1d6', total: 2, dice: [{ sides: 6, value: 2 }], modifier: 0, breakdown: 'd6 (2) = 2' } });
    expect(bare.healed).toBe(3);
    const withCon = spendHitDie(mira(), 6, { roll: { expression: '1d6+1', total: 3, dice: [{ sides: 6, value: 2 }], modifier: 1, breakdown: 'd6 (2) + 1 = 3' } });
    expect(withCon.healed).toBe(3);
  });

  it('warns when no die of that size remains or the character is at 0 HP', () => {
    const spent = mira({ hitDice: [{ die: 6, total: 3, spent: 3 }] });
    expect(spendHitDie(spent, 6).events[0].type).toBe('warning');
    expect(spendHitDie(mira(), 10).events[0].message).toBe('No d10 Hit Point Dice.');
    expect(spendHitDie(mira({ hp: { max: 17, current: 0, temp: 0 } }), 6).roll).toBeNull();
  });
});

describe('applyShortRest', () => {
  it('recharges short-rest features and Pact Magic, not long-rest ones', () => {
    const base = recomputeSlots(mira({ classes: [asClass('Wizard', 3), asClass('Warlock', 2)] }));
    const c: Character = {
      ...base,
      spellcasting: { ...base.spellcasting!, pact: { slotLevel: 1, slots: { max: 2, used: 2 } } },
      features: [feature('Action Surge', { max: 1, used: 1, recharge: 'short' }), feature('Arcane Recovery', { max: 1, used: 1, recharge: 'long' })],
    };
    const r = applyShortRest(c);
    expect(r.character.features.map((f) => f.uses?.used)).toEqual([0, 1]);
    expect(r.character.spellcasting?.pact?.slots.used).toBe(0);
    expect(r.character.spellcasting?.slots[1]?.used).toBe(1);
    expect(r.character.hp.current).toBe(12);
    expect(r.events[0].type).toBe('rest');
  });

  it('2024: Rage, Second Wind, Channel Divinity and Wild Shape regain one use', () => {
    const c = mira({
      features: [
        feature('Second Wind', { max: 2, used: 2, recharge: 'long' }),
        feature('Channel Divinity', { max: 3, used: 3, recharge: 'short' }),
        feature('Rage', { max: 3, used: 1, recharge: 'long' }),
      ],
    });
    expect(applyShortRest(c).character.features.map((f) => f.uses?.used)).toEqual([1, 2, 0]);
  });

  it('Bardic Inspiration recharges from Bard 5; Tireless lowers Exhaustion', () => {
    const bard = mira({ classes: [asClass('Bard', 5)], features: [feature('Bardic Inspiration', { max: 3, used: 3, recharge: 'long' })] });
    expect(applyShortRest(bard).character.features[0].uses?.used).toBe(0);
    const lowBard = { ...bard, classes: [asClass('Bard', 4)] };
    expect(applyShortRest(lowBard).character.features[0].uses?.used).toBe(3);
    const ranger = mira({ classes: [asClass('Ranger', 10)], exhaustion: 2 });
    expect(applyShortRest(ranger).character.exhaustion).toBe(1);
    expect(applyShortRest(mira({ exhaustion: 2 })).character.exhaustion).toBe(2);
  });

  it('needs at least 1 HP', () => {
    const r = applyShortRest(mira({ hp: { max: 17, current: 0, temp: 0 } }));
    expect(r.events[0].type).toBe('warning');
  });
});

describe('applyLongRest (SRD 5.2.1)', () => {
  const tired = () =>
    mira({
      hp: { max: 17, current: 5, temp: 4 },
      hitDice: [{ die: 6, total: 3, spent: 3 }],
      exhaustion: 2,
      heroicInspiration: false,
      deathSaves: { successes: 1, failures: 1, stable: false, dead: false },
      features: [
        feature('Arcane Recovery', { max: 1, used: 1, recharge: 'long' }),
        feature('Lucky Charm', { max: 1, used: 1, recharge: 'none' }),
        feature('Dawn Blessing', { max: 1, used: 1, recharge: 'dawn' }),
        feature('Resourceful'),
      ],
      spellcasting: { ...mira().spellcasting!, concentratingOn: 'Detect Magic', slots: { 1: { max: 4, used: 4 }, 2: { max: 2, used: 1 } } },
    });

  it('restores HP, ALL spent Hit Point Dice, slots and features', () => {
    const { character, events } = applyLongRest(tired());
    expect(character.hp).toEqual({ max: 17, current: 17, temp: 0 });
    expect(character.hitDice).toEqual([{ die: 6, total: 3, spent: 0 }]);
    expect(character.spellcasting?.slots).toEqual({ 1: { max: 4, used: 0 }, 2: { max: 2, used: 0 } });
    expect(character.features.map((f) => f.uses?.used)).toEqual([0, 1, 0, undefined]);
    expect(events[0].type).toBe('rest');
  });

  it('reduces Exhaustion by 1, resets death saves, ends Concentration, grants Resourceful inspiration', () => {
    const { character, events } = applyLongRest(tired());
    expect(character.exhaustion).toBe(1);
    expect(character.deathSaves).toEqual({ successes: 0, failures: 0, stable: false, dead: false });
    expect(character.spellcasting?.concentratingOn).toBeNull();
    expect(character.heroicInspiration).toBe(true);
    expect(events[0].message).toMatch(/Exhaustion 2 → 1/);
  });

  it('needs at least 1 HP', () => {
    const r = applyLongRest(mira({ hp: { max: 17, current: 0, temp: 0 } }));
    expect(r.events[0].type).toBe('warning');
    expect(r.character.hp.current).toBe(0);
  });
});

describe('levelUp: feature uses that grow with level', () => {
  const paladin = (level: number, features: Feature[]) =>
    mira({
      abilityScores: { str: 16, dex: 10, con: 14, int: 8, wis: 10, cha: 14 },
      classes: [asClass('Paladin', level)],
      hitDice: [{ die: 10, total: level, spent: 0 }],
      spellcasting: undefined,
      features,
    });
  const legacy = (name: string, sourceName: string, max: number, used = 0): Feature => ({
    id: name,
    name,
    source: 'class',
    sourceName,
    description: '',
    uses: { max, used, recharge: 'long' },
  });
  const usesOf = (c: Character, name: string) => c.features.find((f) => f.name === name)?.uses;

  it('recomputes FeatureUses.scale: Lay On Hands 5 → 10 at Paladin 2 (SRD 5.2.1 Paladin: five times your Paladin level)', () => {
    const layOnHands: Feature = {
      ...legacy('Lay On Hands', 'Paladin 1', 5, 3),
      uses: { max: 5, used: 3, recharge: 'long', scale: { by: 'class-level', className: 'Paladin', multiplier: 5 } },
    };
    const r = levelUp(paladin(1, [layOnHands]), { className: 'Paladin', hpMethod: 'average' });
    expect(usesOf(r.character, 'Lay On Hands')).toEqual({ ...layOnHands.uses, max: 10, used: 3 });
    expect(r.events.map((e) => e.message)).toContain('Feature uses now: Lay On Hands 5 → 10.');
  });

  it('table scales, and older sheets via the SRD 5.2.1 Barbarian, Fighter, Cleric and Paladin Features tables (Rages, Second Wind, Channel Divinity)', () => {
    const barbarian = mira({ classes: [asClass('Barbarian', 2)], spellcasting: undefined, features: [legacy('Rage', 'Barbarian 1', 2, 1)] });
    expect(usesOf(levelUp(barbarian, { className: 'Barbarian', hpMethod: 'average' }).character, 'Rage')).toMatchObject({ max: 3, used: 1 });
    const fighter = mira({ classes: [asClass('Fighter', 3)], spellcasting: undefined, features: [legacy('Second Wind', 'Fighter 1', 2)] });
    expect(usesOf(levelUp(fighter, { className: 'Fighter', hpMethod: 'average' }).character, 'Second Wind')?.max).toBe(3);
    const cleric = mira({ classes: [asClass('Cleric', 5)], features: [legacy('Channel Divinity', 'Cleric 2', 2)] });
    expect(usesOf(levelUp(cleric, { className: 'Cleric', hpMethod: 'average' }).character, 'Channel Divinity')?.max).toBe(3);
    const oath = paladin(10, [legacy('Channel Divinity', 'Paladin 3', 2)]);
    expect(usesOf(levelUp(oath, { className: 'Paladin', hpMethod: 'average' }).character, 'Channel Divinity')?.max).toBe(3);
    const rage: Feature = { ...legacy('Rage', 'Barbarian 1', 2), uses: { max: 2, used: 0, recharge: 'long', scale: { by: 'table', className: 'Barbarian', values: [2, 2, 3, 3, 3, 4] } } };
    const tableBarbarian = { ...barbarian, features: [rage] };
    expect(usesOf(levelUp(tableBarbarian, { className: 'Barbarian', hpMethod: 'average' }).character, 'Rage')?.max).toBe(3);
  });

  it("only the leveled class's level counts, and homebrew features are left alone", () => {
    const multi = mira({
      classes: [asClass('Barbarian', 2), asClass('Fighter', 3)],
      spellcasting: undefined,
      features: [legacy('Rage', 'Barbarian 1', 2), legacy('Second Wind', 'Fighter 1', 2), legacy('Rage', 'Homebrew', 1)],
    });
    const r = levelUp(multi, { className: 'Fighter', hpMethod: 'average' }).character;
    expect(r.features.map((f) => f.uses?.max)).toEqual([2, 3, 1]);
  });

  it('Proficiency Bonus uses grow at level 5 (SRD 5.2.1 Goliath: Giant Ancestry); spent uses stay spent, capped at the new maximum', () => {
    const giant: Feature = {
      id: 'ga',
      name: 'Giant Ancestry (Stone Giant)',
      source: 'species',
      sourceName: 'Goliath',
      description: '',
      uses: { max: 2, used: 2, recharge: 'long', scale: { by: 'proficiency-bonus' } },
    };
    const shrinking: Feature = { ...giant, id: 'x', name: 'Odd', uses: { max: 3, used: 3, recharge: 'long', scale: { by: 'table', className: 'Wizard', values: [3, 3, 3, 3, 2] } } };
    const four = mira({ classes: [asClass('Wizard', 4)], features: [giant, shrinking] });
    const five = levelUp(four, { className: 'Wizard', hpMethod: 'average' }).character;
    expect(five.features[0].uses).toMatchObject({ max: 3, used: 2 });
    expect(five.features[1].uses).toMatchObject({ max: 2, used: 2 });
  });

  it('ignores scales it cannot read', () => {
    const odd: Feature = { ...legacy('Odd', 'Wizard 1', 2), uses: { max: 2, used: 0, recharge: 'long', scale: { by: 'table', className: 'Cleric', values: [4] } } };
    const zero: Feature = { ...odd, id: 'z', uses: { max: 1, used: 0, recharge: 'long', scale: { by: 'table', className: 'Wizard', values: [] } } };
    const r = levelUp(mira({ features: [odd, zero] }), { className: 'Wizard', hpMethod: 'average' });
    expect(r.character.features.map((f) => f.uses?.max)).toEqual([2, 1]);
    expect(r.events.some((e) => e.message.startsWith('Feature uses now'))).toBe(false);
  });
});

describe('levelUp: Armor Class', () => {
  it('Draconic Sorcery at Sorcerer 3 gives Draconic Resilience: 10 + DEX + CHA (SRD 5.2.1 Sorcerer)', () => {
    const sorcerer = mira({
      abilityScores: { str: 8, dex: 14, con: 14, int: 10, wis: 12, cha: 15 },
      classes: [asClass('Sorcerer', 2)],
      features: [],
    });
    const r = levelUp(sorcerer, {
      className: 'Sorcerer',
      subclass: 'Draconic Sorcery',
      hpMethod: 'average',
      newFeatures: [{ name: 'Draconic Resilience', source: 'subclass', description: 'Your AC equals 10 + DEX + CHA while unarmored.' }],
    });
    expect(r.character).toMatchObject({ armorClass: 14, acFormula: 'Draconic Resilience: 10 + DEX 2 + CHA 2' });
    expect(r.events.map((e) => e.message)).toContain('AC 12 → 14 (Draconic Resilience: 10 + DEX 2 + CHA 2)');
  });

  it('multiclassing into Barbarian adds Unarmored Defense (SRD 5.2.1 Barbarian; Multiclassing)', () => {
    const r = levelUp(mira(), { className: 'Barbarian', hpMethod: 'average' });
    expect(r.character).toMatchObject({ armorClass: 13, acFormula: 'Unarmored Defense: 10 + DEX 2 + CON 1' });
  });

  it('keeps an AC set by hand (Mage Armor) and reminds the player what gear and features give', () => {
    const r = levelUp(mira({ armorClass: 15 }), { className: 'Barbarian', hpMethod: 'average' });
    expect(r.character.armorClass).toBe(15);
    expect(r.reminders.some((m) => /^AC kept at 15: .*now give AC 13/.test(m))).toBe(true);
  });

  it("leaves the AC alone when the level doesn't change it, and reads the equipment catalog", () => {
    expect(levelUp(mira(), { className: 'Wizard', hpMethod: 'average' }).character).toMatchObject({ armorClass: 12, acFormula: '10 + DEX' });
    const catalog = [{ id: 'hb:armor:mithral', name: 'Mithral Plate', category: 'armor' as const, armorClass: 18, dexCap: 0, armorType: 'heavy' as const }];
    const knight = mira({
      classes: [asClass('Paladin', 1)],
      spellcasting: undefined,
      armorClass: 18,
      armorTraining: ['Heavy armor'],
      inventory: [{ id: 'mp', name: 'Mithral Plate', quantity: 1, equipped: true, category: 'armor', compendiumId: 'hb:armor:mithral' }],
    });
    const defense = { newFeatures: [{ name: 'Defense', source: 'feat' as const, description: '+1 AC while wearing armor' }] };
    expect(levelUp(knight, { className: 'Paladin', hpMethod: 'average', equipment: catalog, ...defense }).character.armorClass).toBe(19);
    expect(levelUp(knight, { className: 'Paladin', hpMethod: 'average', ...defense }).character.armorClass).toBe(18); // unknown armor: kept
  });
});
