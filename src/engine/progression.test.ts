import { describe, expect, it } from 'vitest';
import type { Character, ClassLevel, Feature, ImportedRef, SourceFormat } from '@/types';
import { sampleCharacter } from '@/test/fixtures';
import { asiLevels, findSrdClass, SRD_CLASSES } from './classData';
import { addFeature, adjustHpMax } from './character';
import type { Rng } from './dice';
import {
  applyLongRest,
  applyShortRest,
  draconicResilienceHitPoints,
  levelForXp,
  levelUp,
  spendHitDie,
  startingFeatureHitPoints,
  XP_THRESHOLDS,
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

  it("names the Champion's Additional Fighting Style choice, and the subclass feature only while it's missing (SRD 5.2.1 Champion, level 7)", () => {
    const champion = mira({ spellcasting: undefined, classes: [asClass('Fighter', 6, { subclass: 'Champion' })], hitDice: [{ die: 10, total: 6, spent: 0 }] });
    const style = (source: Feature['source']) => ({ name: 'Additional Fighting Style', source, description: 'You gain another Fighting Style feat of your choice.' });
    const choose = 'Fighter 7: Additional Fighting Style — choose another Fighting Style.';
    const subclassFeature = 'Fighter 7: gain a feature from your subclass (Champion).';
    // The level-up dialog adds the subclass's features from the data: the choice is named, nothing is missing.
    const fromData = levelUp(champion, { className: 'Fighter', hpMethod: 'average', newFeatures: [style('subclass')] }).reminders;
    expect(fromData).toContain(choose);
    expect(fromData).not.toContain(subclassFeature);
    // Nothing added: the subclass feature is still to come.
    const bare = levelUp(champion, { className: 'Fighter', hpMethod: 'average' }).reminders;
    expect(bare).toContain(subclassFeature);
    expect(bare).not.toContain(choose);
    // The DM's level_up lists an SRD subclass's features itself (as class features): the choice is named too.
    expect(levelUp(champion, { className: 'Fighter', hpMethod: 'average', newFeatures: [style('class')] }).reminders).toEqual(expect.arrayContaining([choose, subclassFeature]));
  });

  it("still names the subclass feature when a book's subclass chosen late brings only earlier levels' features", () => {
    const fighter9 = mira({ spellcasting: undefined, classes: [asClass('Fighter', 9)], hitDice: [{ die: 10, total: 9, spent: 0 }] });
    const part = (name: string, level: number) => ({
      name,
      source: 'subclass' as const,
      description: 'Invented.',
      ref: { sourceId: 'gloam', sourceTitle: 'Gloam', entryId: 'lib:gloam:subclass:lamp', kind: 'subclass' as const, entryName: 'Lamplighter', part: name, level, textHash: '', textCopied: true },
    });
    const up = (...features: ReturnType<typeof part>[]) =>
      levelUp(fighter9, { className: 'Fighter', hpMethod: 'average', subclass: 'Lamplighter', newFeatures: features }).reminders;
    const owed = 'Fighter 10: gain a feature from your subclass (Lamplighter).';
    // Caught up from levels 3 and 7, nothing at 10 in the book's data: the level's feature is still to add.
    expect(up(part('Wick Ward', 3), part('Ember Step', 7))).toContain(owed);
    // With the book's level 10 feature among them: nothing owed.
    expect(up(part('Wick Ward', 3), part('Ember Step', 7), part('Lamp Oath', 10))).not.toContain(owed);
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

  it("checks a book's class's multiclass prerequisites from the ones its caller gives (SRD 5.2.1 Multiclassing)", () => {
    const primaries = [{ name: 'Cleric', primaryAbilities: ['wis' as const], primaryRule: 'all' as const }];
    const r = levelUp(mira(), { className: 'Cleric', classId: 'lib:gloam:class:cleric', hitDie: 8, casterType: 'full', hpMethod: 'average', multiclassPrimaries: primaries });
    expect(r.reminders[0]).toMatch(/prerequisite not met: Cleric needs 13\+ \(Wisdom 12\)/);
    const none = levelUp(mira(), { className: 'Cleric', classId: 'lib:gloam:class:cleric', hitDie: 8, casterType: 'full', hpMethod: 'average' });
    expect(none.reminders.some((m) => m.includes('prerequisite'))).toBe(false);
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
    // Given again as a feat: still only the step (SRD 5.2.1 "The Bonus Doesn't Stack").
    const again = levelUp(alert, { className: 'Wizard', hpMethod: 'average', newFeatures: [{ name: 'Alert', source: 'feat', description: '' }] });
    expect(again.character.initiativeBonusExtra).toBe(3);
  });

  it('keeps an Alert or Tough the DM recorded growing at level-ups (SRD 5.2.1 Alert; the engine\'s Tough rule)', () => {
    const fourth = mira({ classes: [asClass('Wizard', 4)], features: [] });
    const recorded = addFeature(addFeature(fourth, { name: 'Alert', source: 'feat', description: '' }).character, { name: 'Tough', source: 'feat', description: '' }).character;
    // Wizard 4: Initiative +2 and Hit Points +8 when recorded.
    expect(recorded.initiativeBonusExtra).toBe(2);
    expect(recorded.hp.max).toBe(fourth.hp.max + 8);
    // Wizard 5: the bonus rises to +3, and Tough adds 2 (d6 average 4 + CON 1, + 2): twice the level in all.
    const r = levelUp(recorded, { className: 'Wizard', hpMethod: 'average' });
    expect(r.character.initiativeBonusExtra).toBe(3);
    expect(r.hpGained).toBe(5 + 2);
    expect(r.character.hp.max - fourth.hp.max - 5).toBe(2 * 5);
  });

  it('keeps a recorded Alert or Tough growing after the DM records a trait of its name beside it (SRD 5.2.1 Alert)', () => {
    const fourth = mira({ classes: [asClass('Wizard', 4)], features: [] });
    let c = fourth;
    for (const name of ['Alert', 'Tough']) c = addFeature(c, { name, source: 'background', description: '' }).character;
    for (const name of ['Alert', 'Tough']) c = addFeature(c, { name, source: 'species', description: 'Invented: a trait of the name.' }).character;
    // Still the feats: Wizard 5 raises the bonus to +3 and adds Tough's 2.
    const r = levelUp(c, { className: 'Wizard', hpMethod: 'average' });
    expect(r.character.initiativeBonusExtra).toBe(3);
    expect(r.hpGained).toBe(5 + 2);
  });

  it("counts the Tough feat only: a species trait, class feature or transformation power of its name neither brings Hit Points nor stops the feat's", () => {
    const namesake = (source: Feature['source'], classes = [asClass('Wizard', 3)]) =>
      mira({ classes, features: [...mira().features, { id: 'ns', name: 'Tough', source, description: 'Invented: not the feat.' }] });
    const taking = [{ name: 'Tough', source: 'feat' as const, description: '' }];
    for (const source of ['species', 'class', 'subclass', 'transformation'] as const) {
      // Wizard 3 → 4 taking the feat beside it: twice the new level (d6 average 4 + CON 1, + 8).
      expect(levelUp(namesake(source), { className: 'Wizard', hpMethod: 'average', newFeatures: taking }).hpGained, source).toBe(5 + 8);
      // Alone, at a level-up: nothing.
      expect(levelUp(namesake(source, [asClass('Wizard', 4)]), { className: 'Wizard', hpMethod: 'average' }).hpGained, source).toBe(5);
      // Gained as one (a level_up extra is a class feature): nothing.
      expect(levelUp(mira(), { className: 'Wizard', hpMethod: 'average', newFeatures: [{ name: 'Tough', source, description: '' }] }).hpGained, source).toBe(5);
    }
    // On neither side of the feat line (the DM's boon, background, item, homebrew or other entry): the feat.
    for (const source of ['boon', 'background', 'item', 'homebrew', 'other'] as const) {
      const held = mira({ classes: [asClass('Wizard', 4)], features: [{ id: 't', name: 'Tough', source, description: '' }] });
      expect(levelUp(held, { className: 'Wizard', hpMethod: 'average' }).hpGained, source).toBe(5 + 2);
    }
  });

  it("counts the Alert feat only: a species trait, class feature or transformation power of its name neither brings the bonus nor stops the feat's", () => {
    const namesake = (source: Feature['source'], classes = [asClass('Wizard', 3)]) =>
      mira({ classes, features: [...mira().features, { id: 'ns', name: 'Alert', source, description: 'Invented: not the feat.' }] });
    const taking = [{ name: 'Alert', source: 'feat' as const, description: '' }];
    for (const source of ['species', 'class', 'subclass', 'transformation'] as const) {
      // Wizard 3 → 4 taking the feat beside it: the whole +2, and its reminder.
      const r = levelUp(namesake(source), { className: 'Wizard', hpMethod: 'average', newFeatures: taking });
      expect(r.character.initiativeBonusExtra, source).toBe(2);
      expect(r.reminders, source).toContain('Alert: initiative bonus from your Proficiency Bonus is now +2.');
      // Alone, across the bonus's rise at Wizard 5: nothing (it never brought the bonus).
      const alone = levelUp(namesake(source, [asClass('Wizard', 4)]), { className: 'Wizard', hpMethod: 'average' });
      expect(alone.character.initiativeBonusExtra ?? 0, source).toBe(0);
      expect(alone.reminders.some((m) => m.startsWith('Alert:')), source).toBe(false);
      // Gained as one (a level_up extra is a class feature): nothing.
      expect(levelUp(mira(), { className: 'Wizard', hpMethod: 'average', newFeatures: [{ name: 'Alert', source, description: '' }] }).character.initiativeBonusExtra ?? 0, source).toBe(0);
    }
    // On neither side of the feat line (the DM's boon, background, item, homebrew or other entry): the feat, as the
    // level-up panel counts it taken.
    for (const source of ['boon', 'background', 'item', 'homebrew', 'other'] as const) {
      const held = mira({ classes: [asClass('Wizard', 4)], initiativeBonusExtra: 2, features: [{ id: 'a', name: 'Alert', source, description: '' }] });
      expect(levelUp(held, { className: 'Wizard', hpMethod: 'average' }).character.initiativeBonusExtra, source).toBe(3);
    }
  });

  it('adds the whole Proficiency Bonus to Initiative for Alert taken at this level (SRD 5.2.1 Alert: Initiative Proficiency)', () => {
    const taking = [{ name: 'Alert', source: 'feat' as const, description: '' }];
    // Wizard 3 → 4: +2, beside a bonus the sheet already has from elsewhere.
    const r = levelUp(mira({ initiativeBonusExtra: 1 }), { className: 'Wizard', hpMethod: 'average', newFeatures: taking });
    expect(r.character.initiativeBonusExtra).toBe(1 + 2);
    expect(r.reminders).toContain('Alert: initiative bonus from your Proficiency Bonus is now +2.');
    // Wizard 4 → 5, where the bonus becomes +3: all of it, not the step.
    expect(levelUp(mira({ classes: [asClass('Wizard', 4)] }), { className: 'Wizard', hpMethod: 'average', newFeatures: taking }).character.initiativeBonusExtra).toBe(3);
    // A new hero's first level.
    const blank = mira({ classes: [], hitDice: [], hp: { max: 0, current: 0, temp: 0 }, spellcasting: undefined });
    expect(levelUp(blank, { className: 'Fighter', hpMethod: 'average', newFeatures: taking }).character.initiativeBonusExtra).toBe(2);
    // Another feature gained, no Alert: nothing.
    const none = levelUp(mira(), { className: 'Wizard', hpMethod: 'average', newFeatures: [{ name: 'Alertness', source: 'feat', description: '' }] });
    expect(none.character.initiativeBonusExtra ?? 0).toBe(0);
    expect(none.reminders.some((m) => m.startsWith('Alert:'))).toBe(false);
  });

  it("reminds of the choices of Magic Initiate and Skilled taken at this level, which the sheet doesn't make (SRD 5.2.1 Feats)", () => {
    const feat = (name: string) => ({ name, source: 'feat' as const, description: '' });
    const r = levelUp(mira(), { className: 'Wizard', hpMethod: 'average', newFeatures: [feat('Magic Initiate'), feat('Skilled')] });
    expect(r.reminders).toEqual(
      expect.arrayContaining([
        'Magic Initiate: choose its spell list, two cantrips and a level 1 spell from it, and its spellcasting ability.',
        'Skilled: choose three skills or tools to gain proficiency in.',
      ]),
    );
    // One the sheet already has, and a level that adds neither, ask for nothing.
    const had = mira({ features: [...mira().features, { id: 'mi', ...feat('Magic Initiate') }, { id: 'sk', ...feat('Skilled') }] });
    expect(levelUp(had, { className: 'Wizard', hpMethod: 'average' }).reminders.filter((m) => /^(Magic Initiate|Skilled):/.test(m))).toEqual([]);
    // A Repeatable feat taken again asks again.
    expect(levelUp(had, { className: 'Wizard', hpMethod: 'average', newFeatures: [feat('Skilled')] }).reminders).toContain('Skilled: choose three skills or tools to gain proficiency in.');
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

  it("a 2024 book's Bard and Ranger rest by the SRD's class levels too (SRD 5.2.1 Bard: Font of Inspiration; Ranger: Tireless)", () => {
    const ref = (name: string, format: SourceFormat): ImportedRef => ({ sourceId: 'lamp', sourceTitle: 'The Lamp Folio', entryId: `lib:lamp:class:${name.toLowerCase()}`, kind: 'class', entryName: name, textHash: '', textCopied: false, format });
    const book = (name: string, level: number, format: SourceFormat): ClassLevel => ({ ...asClass(name, level), classId: `lib:lamp:class:${name.toLowerCase()}`, ref: ref(name, format) });
    const inspired = feature('Bardic Inspiration', { max: 3, used: 3, recharge: 'long' });
    expect(applyShortRest(mira({ classes: [book('Bard', 5, '2024')], features: [inspired] })).character.features[0].uses?.used).toBe(0);
    expect(applyShortRest(mira({ classes: [book('Bard', 5, '2014')], features: [inspired] })).character.features[0].uses?.used).toBe(3);
    expect(applyShortRest(mira({ classes: [book('Ranger', 10, '2024')], exhaustion: 2 })).character.exhaustion).toBe(1);
    expect(applyShortRest(mira({ classes: [book('Ranger', 10, '2014')], exhaustion: 2 })).character.exhaustion).toBe(2);
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

  it('a reduced Hit Point maximum returns to normal, and Aid ends; HP refill to it (srd:rule:long-rest)', () => {
    // "If your Hit Point maximum was reduced, it returns to normal." Aid's 8 hours are over by the end of the rest.
    const drained = adjustHpMax(mira({ hp: { max: 17, current: 6, temp: 0 } }), { name: 'Life Drain', change: -7, ends: 'long-rest' }).character; // 6/10
    const r = applyLongRest(drained);
    expect(r.character.hp).toEqual({ max: 17, current: 17, temp: 0 });
    expect(r.character).not.toHaveProperty('hpMaxAdjustments');
    expect(r.events[0].message).toBe('Life Drain −7 ends: HP maximum 10 → 17');
    expect(r.events[1].message).toMatch(/^Long rest: HP 6 → 17;/);
    const aided = adjustHpMax(mira(), { name: 'Aid', change: 5, ends: 'long-rest' }).character;
    expect(applyLongRest(aided).character.hp).toEqual({ max: 17, current: 17, temp: 0 });
  });

  it("keeps what a rest doesn't end: Heroes' Feast, a Death Dog's reduction, a lasting change (srd:spell:heroes-feast, srd:monster:death-dog)", () => {
    // Heroes' Feast: "which last for 24 hours"; Death Dog: "the target's Hit Point maximum doesn't return to normal when
    // finishing a Long Rest".
    let c = mira();
    c = adjustHpMax(c, { name: "Heroes' Feast", change: 11, ends: 'when-ended' }).character;
    c = adjustHpMax(c, { name: 'Death Dog poison', change: -5, ends: 'when-ended' }).character;
    c = adjustHpMax(c, { name: 'Blessing of the Grove', change: 2, ends: 'never' }).character;
    const r = applyLongRest(c);
    expect(r.character.hpMaxAdjustments).toEqual(c.hpMaxAdjustments);
    expect(r.character.hp).toEqual({ max: 25, current: 25, temp: 0 });
    expect(r.events).toHaveLength(1);
  });

  it("ends Aid before the drains: its 8 hours are over before the rest finishes, so a drained hero it kept alive dies (srd:rule:long-rest, srd:spell:aid)", () => {
    // Aid: "Duration: 8 hours"; Long Rest: "at least 8 hours", stopped by "Casting a spell other than a cantrip", and only
    // "When you finish the rest … If your Hit Point maximum was reduced, it returns to normal."
    let c = adjustHpMax(mira(), { name: 'Aid', change: 5, ends: 'long-rest' }).character; // 17/22
    c = adjustHpMax(c, { name: 'Life Drain', change: -20, ends: 'long-rest' }).character; // 2/2
    const r = applyLongRest(c);
    expect(r.character.deathSaves.dead).toBe(true);
    expect(r.events).toEqual([{ type: 'died', message: 'Aid +5 ends: HP maximum 2 → 0 — a creature dies if its Hit Point maximum reaches 0.' }]);
    // The hero never finished the rest: the drain stays, its records adding up to the maximum of 0.
    expect(r.character.hp).toEqual({ max: 0, current: 0, temp: 0 });
    expect(r.character.hpMaxAdjustments).toEqual([{ name: 'Life Drain', amount: -17, ends: 'long-rest' }]);
    // With room to spare, Aid ends first and the drain then returns to normal: the same full rest as ever.
    let spare = adjustHpMax(mira(), { name: 'Aid', change: 5, ends: 'long-rest' }).character; // 17/22
    spare = adjustHpMax(spare, { name: 'Life Drain', change: -10, ends: 'long-rest' }).character; // 12/12
    const rested = applyLongRest(spare);
    expect(rested.character.hp).toEqual({ max: 17, current: 17, temp: 0 });
    expect(rested.events.slice(0, 2).map((e) => e.message)).toEqual(['Aid +5 ends: HP maximum 12 → 7, HP 12 → 7', 'Life Drain −10 ends: HP maximum 7 → 17']);
    expect(rested.events[2].message).toMatch(/^Long rest: HP 7 → 17[;.]/);
  });

  it("Aid ending under a curse the rest doesn't lift can kill (srd:rule:...-instant-death: \"A creature dies if its Hit Point maximum reaches 0.\")", () => {
    let c = adjustHpMax(mira(), { name: 'Aid', change: 5, ends: 'long-rest' }).character; // 17/22
    c = adjustHpMax(c, { name: 'Mummy Rot', change: -21, ends: 'when-ended' }).character; // 1/1
    const r = applyLongRest(c);
    expect(r.character.deathSaves.dead).toBe(true);
    expect(r.character.hp).toEqual({ max: 0, current: 0, temp: 0 });
    expect(r.events.map((e) => e.type)).toEqual(['died']);
  });

  it('a Short Rest changes no maximum (srd:rule:short-rest)', () => {
    const c = adjustHpMax(mira(), { name: 'Life Drain', change: -3, ends: 'long-rest' }).character;
    expect(applyShortRest(c).character.hp.max).toBe(14);
    expect(applyShortRest(c).character.hpMaxAdjustments).toEqual(c.hpMaxAdjustments);
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

  it("B8: a book's class named like an SRD class keeps its own uses, never the SRD Fighter Features table (SRD 5.2.1 Fighter: Second Wind)", () => {
    // The book's Second Wind: once per rest by its text, with no table column (inferFeatureUses gave max 1, no scale).
    const bookWind: Feature = { ...legacy('Second Wind', 'Fighter 1', 1), uses: { max: 1, used: 0, recharge: 'short' } };
    const bookFighter = mira({ classes: [asClass('Fighter', 1, { classId: 'lib:gloam:class:fighter' })], spellcasting: undefined, features: [bookWind] });
    const r = levelUp(bookFighter, { className: 'Fighter', classId: 'lib:gloam:class:fighter', hpMethod: 'average' });
    expect(usesOf(r.character, 'Second Wind')?.max).toBe(1);
    expect(r.events.map((e) => e.message).join(' ')).not.toContain('Second Wind 1');
    // A book feature (it carries a ref) on an SRD-named class entry without an id is left alone too.
    const ref = { sourceId: 'gloam', sourceTitle: 'The Gloamwood Almanac', entryId: 'lib:gloam:class:fighter', kind: 'class' as const, entryName: 'Fighter', part: 'Second Wind', level: 1, textHash: 'h', textCopied: true };
    const legacyEntry = mira({ classes: [asClass('Fighter', 1, { classId: '' })], spellcasting: undefined, features: [{ ...bookWind, ref }] });
    expect(usesOf(levelUp(legacyEntry, { className: 'Fighter', hpMethod: 'average' }).character, 'Second Wind')?.max).toBe(1);
    // The SRD Fighter's older sheets still grow by its table (Second Wind 3 at Fighter 4).
    const srd = mira({ classes: [asClass('Fighter', 3)], spellcasting: undefined, features: [legacy('Second Wind', 'Fighter 1', 2)] });
    expect(usesOf(levelUp(srd, { className: 'Fighter', hpMethod: 'average' }).character, 'Second Wind')?.max).toBe(3);
  });

  it("a number of uses the DM's rewrite changes stays at level-ups (FeatureUses.ruled); the same number keeps growing (SRD 5.2.1 Fighter and Barbarian Features tables: Second Wind, Rages)", () => {
    // The DM's features_add rewriting the SRD Fighter's Second Wind, an older sheet's (no scale: the table by its source name).
    const fighter = (level: number) => mira({ classes: [asClass('Fighter', level)], spellcasting: undefined, features: [legacy('Second Wind', 'Fighter 1', 2, 1)] });
    const rewrite = (c: Character, extra: Partial<Feature> = {}) =>
      addFeature(c, { name: 'Second Wind', source: 'class', sourceName: 'Granted in play', description: 'DM ruling: four uses.', ...extra }).character;
    const ruled = rewrite(fighter(2), { uses: { max: 4, used: 0, recharge: 'short' } });
    expect(ruled.features[0]).toMatchObject({ sourceName: 'Fighter 1', uses: { max: 4, used: 1, recharge: 'short', ruled: true } });
    const r = levelUp(ruled, { className: 'Fighter', hpMethod: 'average' });
    expect(usesOf(r.character, 'Second Wind')).toEqual({ max: 4, used: 1, recharge: 'short', ruled: true });
    expect(r.events.map((e) => e.message).join(' ')).not.toContain('Second Wind 4');
    // A later rewrite without uses, or with the ruled number again, keeps the ruling.
    expect(rewrite(ruled).features[0].uses).toEqual(ruled.features[0].uses);
    expect(rewrite(ruled, { uses: { max: 4, used: 0, recharge: 'short' } }).features[0].uses).toEqual(ruled.features[0].uses);
    // The number it had: the table still applies (Second Wind 3 at Fighter 4).
    const restated = rewrite(fighter(3), { uses: { max: 2, used: 0, recharge: 'short' } });
    expect(restated.features[0].uses).toEqual({ max: 2, used: 1, recharge: 'short' });
    expect(usesOf(levelUp(restated, { className: 'Fighter', hpMethod: 'average' }).character, 'Second Wind')?.max).toBe(3);
    // A scaled feature keeps its scale: Rage 3 at Barbarian 3.
    const scale = { by: 'table' as const, className: 'Barbarian', values: [2, 2, 3, 3, 3, 4] };
    const barbarian = mira({ classes: [asClass('Barbarian', 2)], spellcasting: undefined, features: [{ ...legacy('Rage', 'Barbarian 1', 2, 1), uses: { max: 2, used: 1, recharge: 'long', scale } }] });
    const rage = addFeature(barbarian, { name: 'Rage', source: 'class', description: 'Rewritten.', uses: { max: 2, used: 0, recharge: 'long' } }).character;
    expect(rage.features[0].uses).toEqual({ max: 2, used: 1, recharge: 'long', scale });
    expect(usesOf(levelUp(rage, { className: 'Barbarian', hpMethod: 'average' }).character, 'Rage')).toEqual({ max: 3, used: 1, recharge: 'long', scale });
    // Uses given where it had none are the DM's too.
    const flame: Feature = { id: 'flame', name: 'Watchful Flame', source: 'class', sourceName: 'Fighter 2', description: '' };
    const given = addFeature(mira({ classes: [asClass('Fighter', 2)], spellcasting: undefined, features: [flame] }), { ...flame, uses: { max: 2, used: 0, recharge: 'long' } });
    expect(given.character.features[0].uses).toEqual({ max: 2, used: 0, recharge: 'long', ruled: true });
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

  it("a book's Sorcerer gains Draconic Resilience's Hit Points as the SRD's does, in either edition (SRD 5.2.1 Draconic Sorcery; SRD 5.1 Draconic Bloodline)", () => {
    const ref = (format: SourceFormat): ImportedRef => ({ sourceId: 'lamp', sourceTitle: 'The Lamp Folio', entryId: 'lib:lamp:class:sorcerer', kind: 'class', entryName: 'Sorcerer', textHash: '', textCopied: false, format });
    const sorcerer = (format: SourceFormat, level: number, features: Feature[] = []) =>
      mira({
        abilityScores: { str: 8, dex: 14, con: 14, int: 10, wis: 12, cha: 15 },
        classes: [{ classId: 'lib:lamp:class:sorcerer', name: 'Sorcerer', level, hitDie: 6, casterType: 'full', spellcastingAbility: 'cha', ref: ref(format) }],
        features,
      });
    const gain = {
      className: 'Sorcerer',
      classId: 'lib:lamp:class:sorcerer',
      subclass: 'Draconic Sorcery',
      hpMethod: 'average' as const,
      newFeatures: [{ name: 'Draconic Resilience', source: 'subclass' as const, description: 'Invented: scales.' }],
    };
    // "Your Hit Point maximum increases by 3" at Sorcerer 3: the d6 average 4 + CON 2, then 3.
    expect(levelUp(sorcerer('2024', 2), gain).hpGained).toBe(4 + 2 + 3);
    // "...and it increases by 1 whenever you gain another Sorcerer level."
    const resilient: Feature[] = [{ id: 'dr', name: 'Draconic Resilience', source: 'subclass', description: '' }];
    expect(levelUp(sorcerer('2024', 3, resilient), { className: 'Sorcerer', hpMethod: 'average' }).hpGained).toBe(4 + 2 + 1);
    // An older book's Sorcerer: the same one per Sorcerer level (its Draconic Bloodline's from 1st level).
    expect(levelUp(sorcerer('2014', 2), gain).hpGained).toBe(4 + 2 + 3);
    expect(levelUp(sorcerer('2014', 1, resilient), { className: 'Sorcerer', hpMethod: 'average' }).hpGained).toBe(4 + 2 + 1);
    // Not a Sorcerer level: a Fighter level of the same hero adds nothing for it.
    const multi = { ...sorcerer('2014', 3, resilient), classes: [...sorcerer('2014', 3).classes, asClass('Fighter', 1)] };
    expect(levelUp(multi, { className: 'Fighter', hpMethod: 'average' }).hpGained).toBe(6 + 2);
  });

  it('startingFeatureHitPoints: what Tough and a 1st-level Draconic Resilience add to a new hero (levelUp adds them after)', () => {
    const named = (...names: string[]) => names.map((name) => ({ name, source: name === 'Draconic Resilience' ? ('subclass' as const) : ('feat' as const) }));
    const book2014: ClassLevel = { ...asClass('Sorcerer', 1), classId: 'lib:lamp:class:sorcerer' };
    expect(startingFeatureHitPoints(named('Tough'), asClass('Fighter', 1))).toBe(2);
    expect(startingFeatureHitPoints(named('Draconic Resilience'), book2014)).toBe(1);
    expect(startingFeatureHitPoints(named('Tough', 'Draconic Resilience'), book2014)).toBe(3);
    // A 2014 book's Sorcerer as the builder makes it, its ref recording the edition.
    const ref: ImportedRef = { sourceId: 'lamp', sourceTitle: 'The Lamp Folio', entryId: 'lib:lamp:class:sorcerer', kind: 'class', entryName: 'Sorcerer', textHash: '', textCopied: false, format: '2014' };
    expect(startingFeatureHitPoints(named('Draconic Resilience'), { ...book2014, ref })).toBe(1);
    // Not counted here: a Draconic Resilience on another class, and a species' per-level bonus (the builder's own).
    expect(startingFeatureHitPoints(named('Draconic Resilience'), asClass('Fighter', 1))).toBe(0);
    expect(startingFeatureHitPoints(named('Dwarven Toughness', 'Alert'), asClass('Fighter', 1))).toBe(0);
    // A book species' trait named Tough isn't the Tough feat: nothing, and the feat beside it brings its own.
    const trait = { name: 'Tough', source: 'species' as const };
    expect(startingFeatureHitPoints([trait], asClass('Fighter', 1))).toBe(0);
    expect(startingFeatureHitPoints([trait, ...named('Tough')], asClass('Fighter', 1))).toBe(2);
  });

  it("draconicResilienceHitPoints: one per Sorcerer level with the feature, a 2024 book's Sorcerer included (SRD 5.2.1 Draconic Sorcery)", () => {
    const resilient: Feature[] = [{ id: 'dr', name: 'Draconic Resilience', source: 'subclass', description: '' }];
    const ref = (format: SourceFormat): ImportedRef => ({ sourceId: 'lamp', sourceTitle: 'The Lamp Folio', entryId: 'lib:lamp:class:sorcerer', kind: 'class', entryName: 'Sorcerer', textHash: '', textCopied: false, format });
    const book = (level: number, format: SourceFormat): ClassLevel => ({ ...asClass('Sorcerer', level), classId: 'lib:lamp:class:sorcerer', ref: ref(format) });
    expect(draconicResilienceHitPoints({ classes: [asClass('Sorcerer', 6), asClass('Fighter', 2)], features: resilient })).toBe(6);
    expect(draconicResilienceHitPoints({ classes: [book(4, '2024')], features: resilient })).toBe(4);
    expect(draconicResilienceHitPoints({ classes: [book(4, '2014')], features: resilient })).toBe(0);
    expect(draconicResilienceHitPoints({ classes: [asClass('Sorcerer', 6)], features: [] })).toBe(0);
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

describe('levelUp: imported classes and subclasses (SRD 5.2.1 Multiclassing; Multiclassing: Spell Slots)', () => {
  const fighter = (level: number, extra: Partial<ClassLevel> = {}) => asClass('Fighter', level, extra);

  it('never merges an imported "Fighter" into the SRD Fighter when the call names its id', () => {
    const c = mira({ classes: [fighter(3)], abilityScores: { str: 15, dex: 13, con: 14, int: 10, wis: 10, cha: 8 } });
    const r = levelUp(c, { className: 'Fighter', classId: 'lib:gloam:class:fighter', hitDie: 10, casterType: 'none', hpMethod: 'average' });
    expect(r.character.classes.map((cl) => [cl.classId, cl.level])).toEqual([
      ['srd:class:fighter', 3],
      ['lib:gloam:class:fighter', 1],
    ]);
    // It is a new class without SRD reference data: no SRD reminders for it.
    expect(r.reminders.some((x) => x.startsWith('Fighter 1:'))).toBe(false);
  });

  it('still levels a class by name when the call gives no id (the DM)', () => {
    const c = mira({ classes: [fighter(3)] });
    expect(levelUp(c, { className: 'Fighter', hpMethod: 'average' }).character.classes).toEqual([{ ...fighter(4) }]);
  });

  it('stores the subclass id and ref, and copies the class ref onto a new entry', () => {
    const subclassRef = { sourceId: 'gloam', sourceTitle: 'The Gloamwood Almanac', entryId: 'lib:gloam:subclass:ember-warden', kind: 'subclass' as const, entryName: 'Ember Warden', textHash: '', textCopied: false };
    const c = mira({ classes: [fighter(2)] });
    const r = levelUp(c, { className: 'Fighter', classId: 'srd:class:fighter', subclass: 'Ember Warden', subclassId: subclassRef.entryId, subclassRef, hpMethod: 'average' });
    expect(r.character.classes[0]).toMatchObject({ level: 3, subclass: 'Ember Warden', subclassId: subclassRef.entryId, subclassRef });
    const classRef = { ...subclassRef, entryId: 'lib:gloam:class:wickwright', kind: 'class' as const, entryName: 'Wickwright' };
    const multi = levelUp(mira({ classes: [fighter(3)], abilityScores: { str: 13, dex: 10, con: 10, int: 13, wis: 10, cha: 10 } }), {
      className: 'Wickwright',
      classId: classRef.entryId,
      classRef,
      hitDie: 8,
      casterType: 'half',
      spellcastingAbility: 'int',
      hpMethod: 'average',
    });
    expect(multi.character.classes[1]).toMatchObject({ classId: classRef.entryId, name: 'Wickwright', ref: classRef, casterType: 'half' });
  });

  it("B2: naming the entry's own subclass again keeps its id and ref; another subclass replaces or drops them (SRD 5.2.1 Fighter: Champion, Improved Critical)", () => {
    const subclassRef = { sourceId: 'gloam', sourceTitle: 'The Gloamwood Almanac', entryId: 'lib:gloam:subclass:champion', kind: 'subclass' as const, entryName: 'Champion', textHash: '', textCopied: false };
    const bookChampion = fighter(6, { subclass: 'Champion', subclassId: subclassRef.entryId, subclassRef });
    const c = mira({ classes: [bookChampion], spellcasting: undefined });
    const again = levelUp(c, { className: 'Fighter', subclass: 'Champion', hpMethod: 'average' }).character.classes[0];
    expect(again).toMatchObject({ level: 7, subclass: 'Champion', subclassId: subclassRef.entryId, subclassRef });
    // The SRD Champion by id: the book's ref goes with the book's id.
    const srd = levelUp(c, { className: 'Fighter', subclass: 'Champion', subclassId: 'srd:subclass:champion', hpMethod: 'average' }).character.classes[0];
    expect(srd).toMatchObject({ subclass: 'Champion', subclassId: 'srd:subclass:champion' });
    expect(srd.subclassRef).toBeUndefined();
    // A plain new name (unknown to the data): neither the old id nor the old ref describes it.
    const plain = levelUp(c, { className: 'Fighter', subclass: 'Battle Master', hpMethod: 'average' }).character.classes[0];
    expect(plain.subclass).toBe('Battle Master');
    expect(plain.subclassId).toBeUndefined();
    expect(plain.subclassRef).toBeUndefined();
  });

  it("makes a third-caster subclass's class count as a third caster for spell slots", () => {
    const c = mira({ classes: [fighter(2)], spellcasting: undefined });
    const r = levelUp(c, {
      className: 'Fighter',
      classId: 'srd:class:fighter',
      subclass: 'Lamp Knight',
      subclassId: 'lib:gloam:subclass:lamp-knight',
      subclassCasting: { casterType: 'third', spellcastingAbility: 'int' },
      hpMethod: 'average',
    });
    expect(r.character.classes[0]).toMatchObject({ casterType: 'third', spellcastingAbility: 'int' });
    // A third caster has two 1st-level slots at class level 3.
    expect(r.character.spellcasting?.slots[1]).toEqual({ max: 2, used: 0 });
  });
});
