import { describe, expect, it } from 'vitest';
import type { Character, ClassLevel, Feature, ImportedRef, InventoryItem, SourceFormat } from '@/types';
import { sampleCharacter } from '@/test/fixtures';
import { asiLevels, findSrdClass, SRD_CLASSES } from './classData';
import { addAcSpell, addFeature, adjustHpMax, setConcentration } from './character';
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

  it("words a new slot level for two Spellcasting classes as the combined table's (SRD 5.2.1 Multiclassing)", () => {
    // "This table might give you spell slots of a higher level than the spells you prepare. You can use those slots but
    // only to cast your lower-level spells." A Ranger 4 / Sorcerer 2 gaining Sorcerer 3 reaches level 3 slots.
    const hero = mira({ classes: [{ classId: 'srd:class:ranger', name: 'Ranger', level: 4, hitDie: 10, casterType: 'half' }, { classId: 'srd:class:sorcerer', name: 'Sorcerer', level: 2, hitDie: 6, casterType: 'full' }] });
    const r = levelUp(recomputeSlots(hero), { className: 'Sorcerer', hpMethod: 'average' });
    expect(r.reminders).toContain('New spell slot level: level 3 slots cast your lower-level spells too; each class prepares spells only up to its own level.');
    expect(r.reminders.some((m) => m.startsWith('New spell slot level: you can now cast'))).toBe(false);
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

describe('applyLongRest ends the AC spells (srd:spell:mage-armor; srd:spell:shield-of-faith; srd:rule:long-rest)', () => {
  const mail: InventoryItem = { id: 'cm', name: 'Chain Mail', quantity: 1, weight: 55, category: 'armor', equipped: true };
  const messages = (r: { events: { message: string }[] }) => r.events.map((e) => e.message);

  it("Mage Armor's 8 hours are over by the end of a Long Rest (srd:spell:mage-armor: \"Duration: 8 hours\"; srd:rule:long-rest: \"at least 8 hours\")", () => {
    const c = addAcSpell(mira(), 'Mage Armor').character;
    expect(c.armorClass).toBe(15);
    const r = applyLongRest(c);
    expect(r.character).toMatchObject({ armorClass: 12, acFormula: '10 + DEX 2' });
    expect(r.character).not.toHaveProperty('acSpells');
    expect(messages(r)[0]).toBe('Mage Armor ends: AC 15 → 12');
    expect(r.events[1].type).toBe('rest');
  });

  it('every AC spell ends, each with its own step, the bonus before the base, and the Concentration on Shield of Faith with them', () => {
    let c = setConcentration(mira(), 'Shield of Faith').character;
    c = addAcSpell(addAcSpell(c, 'Mage Armor').character, 'Shield of Faith').character;
    expect(c.armorClass).toBe(17);
    const r = applyLongRest(c);
    expect(r.character).toMatchObject({ armorClass: 12, spellcasting: { concentratingOn: null } });
    expect(r.character).not.toHaveProperty('acSpells');
    // Shield of Faith's +2 comes off first, then Mage Armor's base 13 + DEX goes.
    expect(messages(r).slice(0, 2)).toEqual(['Shield of Faith ends: AC 17 → 15', 'Mage Armor ends: AC 15 → 12']);
    expect(messages(r)[2]).toMatch(/^Long rest: .*Concentration on Shield of Faith ended/);
    expect(r.events).toHaveLength(3);
  });

  it("ends Shield of Faith before Mage Armor, so a hand-set AC's warning gives the numbers the rest leaves (srd:spell:shield-of-faith; srd:spell:mage-armor)", () => {
    // Mage Armor 15 + Shield of Faith 2, then the DM sets 19 for Haste (srd:spell:haste: "+2 bonus to Armor Class"):
    // the hand-set formula keeps both parts ("set by the DM: Haste + Mage Armor: 13 + Shield of Faith 2").
    let c = setConcentration(mira(), 'Haste').character;
    c = addAcSpell(addAcSpell(c, 'Mage Armor').character, 'Shield of Faith').character;
    c = { ...c, armorClass: 19, acFormula: 'set by the DM: Haste + Mage Armor: 13 + Shield of Faith 2' };
    const r = applyLongRest(c);
    // The +2 comes off the hand-set AC (19 → 17); Mage Armor's end can't move a hand-set AC (a base isn't a delta), so
    // it is kept at 17 with what gear gives once both have ended (12), and its part leaves the formula.
    expect(r.character).toMatchObject({ armorClass: 17, acFormula: 'set by the DM: Haste' });
    expect(messages(r)).toEqual([
      'Shield of Faith ends: AC 19 → 17',
      'Mage Armor ends: AC stays 17',
      expect.stringMatching(/^Long rest: .*Concentration on Haste ended/),
      "AC kept at 17: it differs from the 15 that gear and features gave, so it may include an effect the app doesn't count or a manual change. Gear and features now give AC 12 (10 + DEX 2); update the AC if that is right.",
      'AC 17 was set by hand for Haste: if it counted Haste, set the AC back to 12 (armor and abilities).',
    ]);
  });

  it("gives no reminder for a Shield of Faith whose record the rest ended, even under an old save's words naming it", () => {
    // An old save's "set by the DM: Shield of Faith and Haste" 20 on Chain Mail 16, then recorded: kept at 20 with the
    // part counted (srd:rule:casting-spells-effects-combining-spell-effects). The rest takes the 2 off once
    // (srd:spell:shield-of-faith: "+2 bonus to AC"), and no reminder asks for it again.
    const old = setConcentration(
      mira({ armorTraining: ['Heavy armor'], inventory: [mail], armorClass: 20, acFormula: 'set by the DM: Shield of Faith and Haste' }),
      'Shield of Faith',
    ).character;
    const recorded = addAcSpell(old, 'Shield of Faith').character;
    expect(recorded).toMatchObject({ armorClass: 20, acFormula: 'set by the DM: Shield of Faith and Haste + Shield of Faith 2' });
    const r = applyLongRest(recorded);
    // The DM's words stay, marked as no longer counting it (E1: "Shield of Faith ended").
    expect(r.character).toMatchObject({ armorClass: 18, acFormula: 'set by the DM: Shield of Faith and Haste + Shield of Faith ended' });
    expect(messages(r)).toEqual(['Shield of Faith ends: AC 20 → 18', expect.stringMatching(/^Long rest: .*Concentration on Shield of Faith ended/)]);
  });

  it('an AC set by hand for Mage Armor or Shield of Faith with no record behind it (an old save) gets a reminder after the rest', () => {
    const old = mira({ armorClass: 15, acFormula: 'set by the DM: Mage Armor' });
    const r = applyLongRest(old);
    expect(r.character.armorClass).toBe(15);
    expect(r.events.map((e) => e.type)).toEqual(['rest', 'warning']);
    expect(r.events[1].message).toBe('AC 15 was set by hand for Mage Armor: if it counted Mage Armor, set the AC back to 12 (armor and abilities).');
    // Shield of Faith set by hand while she concentrates on it: one reminder, not two.
    const faith = setConcentration(mira({ armorTraining: ['Heavy armor'], inventory: [mail], armorClass: 18, acFormula: 'set by the DM: Shield of Faith' }), 'Shield of Faith').character;
    expect(messages(applyLongRest(faith)).slice(1)).toEqual([
      'AC 18 was set by hand for Shield of Faith: if it counted Shield of Faith, set the AC back to 16 (armor and abilities).',
    ]);
    // Any other spell the Concentration ends with: the same reminder (srd:spell:haste: "+2 bonus to Armor Class").
    const hasted = setConcentration(mira({ armorTraining: ['Heavy armor'], inventory: [mail], armorClass: 18, acFormula: 'set by the DM: Haste' }), 'Haste').character;
    expect(messages(applyLongRest(hasted)).slice(1)).toEqual(['AC 18 was set by hand for Haste: if it counted Haste, set the AC back to 16 (armor and abilities).']);
    // A Short Rest ends nothing (srd:rule:short-rest).
    expect(applyShortRest(addAcSpell(mira(), 'Mage Armor').character).character).toMatchObject({ armorClass: 15, acSpells: ['Mage Armor'] });
  });

  it('an older save\'s Concentration on Mage Armor: its end reminds of nothing, so the rest that ends the spell still does, once (F1; srd:spell:mage-armor, Duration "8 hours"; srd:rule:long-rest: "at least 8 hours")', () => {
    const old = setConcentration(mira({ armorClass: 15, acFormula: 'set by the DM: Mage Armor' }), 'Mage Armor').character;
    const r = applyLongRest(old);
    expect(r.character).toMatchObject({ armorClass: 15, spellcasting: { concentratingOn: null } });
    expect(r.events.map((e) => e.type)).toEqual(['rest', 'warning']);
    expect(messages(r)[0]).toMatch(/^Long rest: .*Concentration on Mage Armor ended\.$/);
    expect(r.events[1].message).toBe('AC 15 was set by hand for Mage Armor: if it counted Mage Armor, set the AC back to 12 (armor and abilities).');
    // Recorded: the record ends with the rest, and nothing is left to remind.
    const recorded = setConcentration(addAcSpell(mira(), 'Mage Armor').character, 'Mage Armor').character;
    const rested = applyLongRest(recorded);
    expect(rested.character).toMatchObject({ armorClass: 12, acFormula: '10 + DEX 2' });
    expect(rested.character).not.toHaveProperty('acSpells');
    expect(messages(rested)).toEqual(['Mage Armor ends: AC 15 → 12', expect.stringMatching(/^Long rest: .*Concentration on Mage Armor ended\.$/)]);
  });

  it('a Concentration under a sheet copy\'s noted name is that AC spell\'s: the rest reminds once, never twice (H1; srd:spell:mage-armor, Duration "8 hours"; srd:spell:shield-of-faith: "Concentration, up to 10 minutes")', () => {
    // An older save "concentrating" on a noted Mage Armor, its AC set by hand: one reminder, the rest's (F1).
    for (const acFormula of ['set by the DM: Mage Armor', 'set by the DM: Mage Armor (scroll)']) {
      const old = setConcentration(mira({ armorClass: 15, acFormula }), 'Mage Armor (scroll)').character;
      const r = applyLongRest(old);
      expect(r.events.map((e) => e.type), acFormula).toEqual(['rest', 'warning']);
      expect(r.events[1].message, acFormula).toBe('AC 15 was set by hand for Mage Armor: if it counted Mage Armor, set the AC back to 12 (armor and abilities).');
    }
    // A noted Shield of Faith with no record behind an old save's words: its Concentration's end gives the one reminder.
    const faith = setConcentration(
      mira({ armorTraining: ['Heavy armor'], inventory: [mail], armorClass: 18, acFormula: 'set by the DM: Shield of Faith' }),
      'Shield of Faith (scroll)',
    ).character;
    expect(messages(applyLongRest(faith)).slice(1)).toEqual([
      'AC 18 was set by hand for Shield of Faith (scroll): if it counted Shield of Faith (scroll), set the AC back to 16 (armor and abilities).',
    ]);
    // Recorded, her own casting from the copy: the record ends with the rest, and nothing is left to remind.
    const recorded = addAcSpell(setConcentration(mira(), 'Shield of Faith (scroll)').character, 'Shield of Faith').character;
    const rested = applyLongRest(recorded);
    expect(rested.character).toMatchObject({ armorClass: 12, acFormula: '10 + DEX 2', spellcasting: { concentratingOn: null } });
    expect(messages(rested)).toEqual(['Shield of Faith ends: AC 14 → 12', expect.stringMatching(/^Long rest: .*Concentration on Shield of Faith \(scroll\) ended\.$/)]);
  });

  it("Mage Armor's end at the rest, on an AC set by hand that counted it and that gear now gives too, says the number may still hold it (H3/HA2; srd:spell:mage-armor: \"Until the spell ends, the target's base AC becomes 13 plus its Dexterity modifier\")", () => {
    const note = 'AC 12, set by hand, counted Mage Armor, which has ended: if 12 still includes it, set the AC again (armor and abilities give 12).';
    // F3's advice followed: 12 "set by the DM: cursed (-3) + Mage Armor: 13" (13 + DEX 2 − 3).
    const cursed = mira({ armorClass: 12, acFormula: 'set by the DM: cursed (-3) + Mage Armor: 13', acSpells: ['Mage Armor'] });
    const r = applyLongRest(cursed);
    expect(r.character).toMatchObject({ armorClass: 12, acFormula: 'set by the DM: cursed (-3)' });
    expect(r.character).not.toHaveProperty('acSpells');
    expect(messages(r)).toEqual(['Mage Armor ends: AC stays 12', expect.stringMatching(/^Long rest: /), note]);
    // With Shield of Faith on top (14), its +2 comes off first, then the same warning on the 12 left.
    const both = mira({ armorClass: 14, acFormula: 'set by the DM: cursed (-3) + Mage Armor: 13 + Shield of Faith 2', acSpells: ['Mage Armor', 'Shield of Faith'] });
    expect(messages(applyLongRest(both))).toEqual(['Shield of Faith ends: AC 14 → 12', 'Mage Armor ends: AC stays 12', expect.stringMatching(/^Long rest: /), note]);
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

  it("keeps an AC set by hand (an effect the app doesn't count) and reminds the player what gear and features give", () => {
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

describe('levelUp: one entry for each counted family, Action Surge and Indomitable (SRD 5.2.1 Fighter)', () => {
  // srd:class:fighter, Fighter Features table: "Action Surge (one use), Tactical Mind" at 2, "Indomitable (one use),
  // Tactical Master" at 9, "Indomitable (two uses), Studied Attacks" at 13, "Action Surge (two uses), Indomitable (three
  // uses)" at 17. The texts below are the SRD's own.
  const SURGE =
    "You can push yourself beyond your normal limits for a moment. On your turn, you can take one additional action, except the Magic action.\n\nOnce you use this feature, you can't do so again until you finish a Short or Long Rest. Starting at level 17, you can use it twice before a rest but only once on a turn.";
  const INDOMITABLE =
    "If you fail a saving throw, you can reroll it with a bonus equal to your Fighter level. You must use the new roll, and you can't use this feature again until you finish a Long Rest.\n\nYou can use this feature twice before a Long Rest starting at level 13 and three times before a Long Rest starting at level 17.";
  /** An entry on the sheet: the class's own ("Fighter 9"), as the level-up dialog adds the table's row. */
  const entry = (id: string, name: string, level: number, max: number, used = 0): Feature => ({
    id,
    name,
    source: 'class',
    sourceName: `Fighter ${level}`,
    description: name.startsWith('Action Surge') ? SURGE : INDOMITABLE,
    uses: { max, used, recharge: name.startsWith('Action Surge') ? 'short' : 'long' },
  });
  /** A new feature as the level-up dialog gives it from the data (gainedFeatures: the table's row, uses from its name). */
  const row = (name: string, level: number, max?: number): Omit<Feature, 'id'> => {
    const { id: _id, ...f } = entry('', name, level, max ?? 0);
    return max === undefined ? { ...f, description: '', uses: undefined } : f;
  };
  const fighterAt = (level: number, features: Feature[]) =>
    mira({ classes: [asClass('Fighter', level)], hitDice: [{ die: 10, total: level, spent: 0 }], spellcasting: undefined, features });
  const family = (c: Character, base: string) => c.features.filter((f) => f.name.startsWith(base));
  const messages = (r: { events: { message: string }[] }) => r.events.map((e) => e.message);
  const up = (c: Character, newFeatures?: Omit<Feature, 'id'>[]) => levelUp(c, { className: 'Fighter', hpMethod: 'average', ...(newFeatures ? { newFeatures } : {}) });

  it('Fighter 2 and 9 add their rows as they always have, through the level-up dialog and the DM\'s level_up', () => {
    const two = up(fighterAt(1, []), [row('Action Surge (one use)', 2, 1), row('Tactical Mind', 2)]);
    expect(two.character.features.map((f) => [f.name, f.uses?.max])).toEqual([['Action Surge (one use)', 1], ['Tactical Mind', undefined]]);
    expect(messages(two)).toContain('New features: Action Surge (one use), Tactical Mind.');
    expect(two.merges).toBeUndefined();
    expect(two.folded).toBeUndefined();
    // The DM's level_up names no SRD class features: the reminder is today's, byte for byte.
    expect(up(fighterAt(1, [])).reminders).toContain('New Fighter 2 features to add to the sheet: Action Surge (one use), Tactical Mind.');
    const eight = fighterAt(8, [entry('surge', 'Action Surge (one use)', 2, 1)]);
    expect(up(eight).reminders).toContain('New Fighter 9 features to add to the sheet: Indomitable (one use), Tactical Master.');
    expect(up(eight).character.features).toEqual(eight.features);
    const nine = up(eight, [row('Indomitable (one use)', 9, 1), row('Tactical Master', 9)]);
    expect(nine.character.features.map((f) => f.name)).toEqual(['Action Surge (one use)', 'Indomitable (one use)', 'Tactical Master']);
    expect(messages(nine)).toContain('New features: Indomitable (one use), Tactical Master.');
  });

  it('Fighter 13 grows the Indomitable the sheet holds in place, its spent use kept, through either path ("twice before a Long Rest starting at level 13")', () => {
    const twelve = fighterAt(12, [entry('surge', 'Action Surge (one use)', 2, 1), entry('ind', 'Indomitable (one use)', 9, 1, 1)]);
    const grown = { ...twelve.features[1], name: 'Indomitable (two uses)', uses: { max: 2, used: 1, recharge: 'long' } };
    const dialog = up(twelve, [row('Indomitable (two uses)', 13, 2), row('Studied Attacks', 13)]);
    const dm = up(twelve);
    for (const r of [dialog, dm]) {
      expect(family(r.character, 'Indomitable')).toEqual([grown]);
      expect(family(r.character, 'Action Surge')).toEqual([twelve.features[0]]);
      expect(messages(r)).toContain('Feature uses now: Indomitable (two uses) 1 → 2.');
      expect(r.merges).toBeUndefined();
    }
    // The dialog's row is folded in: no new feature, and the result says so for the notice's list.
    expect(messages(dialog)).toContain('New features: Studied Attacks.');
    expect(dialog.folded).toEqual(['Indomitable (two uses)']);
    // The DM's level_up: the row grew the entry, so the reminder lists only what the sheet lacks.
    expect(dm.reminders).toContain('New Fighter 13 features to add to the sheet: Studied Attacks.');
    expect(messages(dm).some((m) => m.startsWith('New features'))).toBe(false);
    expect(dm.folded).toBeUndefined();
  });

  it('Fighter 17 grows both, spent uses kept ("Starting at level 17, you can use it twice before a rest"; "three times before a Long Rest starting at level 17")', () => {
    const sixteen = fighterAt(16, [entry('surge', 'Action Surge (one use)', 2, 1, 1), entry('ind', 'Indomitable (two uses)', 9, 2, 2)]);
    const dialog = up(sixteen, [row('Action Surge (two uses)', 17, 2), row('Indomitable (three uses)', 17, 3)]);
    const dm = up(sixteen);
    for (const r of [dialog, dm]) {
      expect(r.character.features).toEqual([
        { ...sixteen.features[0], name: 'Action Surge (two uses)', uses: { max: 2, used: 1, recharge: 'short' } },
        { ...sixteen.features[1], name: 'Indomitable (three uses)', uses: { max: 3, used: 2, recharge: 'long' } },
      ]);
      expect(messages(r)).toContain('Feature uses now: Action Surge (two uses) 1 → 2 and Indomitable (three uses) 2 → 3.');
      expect(messages(r).some((m) => m.startsWith('New features'))).toBe(false);
      expect(r.reminders.some((m) => m.startsWith('New Fighter 17 features'))).toBe(false);
    }
    expect(dialog.folded).toEqual(['Action Surge (two uses)', 'Indomitable (three uses)']);
  });

  it("merges an older version's duplicates at the next level-up: spent uses at most the count the family had (S1)", () => {
    // Fighter 16 made by an older version: "(one use)" and "(two uses)" side by side, all three uses spent there (the
    // SRD's two at 16). At 17 it has three uses, two of them spent: one left.
    const old16 = fighterAt(16, [entry('surge', 'Action Surge (one use)', 2, 1), entry('ind1', 'Indomitable (one use)', 9, 1, 1), entry('ind2', 'Indomitable (two uses)', 13, 2, 2)]);
    const r = up(old16, [row('Action Surge (two uses)', 17, 2), row('Indomitable (three uses)', 17, 3)]);
    expect(family(r.character, 'Indomitable')).toEqual([{ ...old16.features[1], name: 'Indomitable (three uses)', uses: { max: 3, used: 2, recharge: 'long' } }]);
    expect(messages(r)).toContain('Indomitable (one use) and Indomitable (two uses) merged into Indomitable (three uses): 3 uses, 1 left.');
    // The merge isn't growth: only Action Surge grew.
    expect(messages(r)).toContain('Feature uses now: Action Surge (two uses) 1 → 2.');
    expect(r.merges).toEqual([
      { id: 'ind1', name: 'Indomitable (three uses)', merged: ['Indomitable (one use)', 'Indomitable (two uses)'], text: 'merged into Indomitable (three uses) (3 uses, 1 left): Indomitable (one use), Indomitable (two uses)' },
    ]);
    // A Fighter 17 with an older version's five entries: one of each at its next level-up, whatever it brings.
    const old17 = fighterAt(17, [
      entry('surge1', 'Action Surge (one use)', 2, 1, 1),
      entry('ind1', 'Indomitable (one use)', 9, 1, 1),
      entry('ind2', 'Indomitable (two uses)', 13, 2),
      entry('surge2', 'Action Surge (two uses)', 17, 2),
      entry('ind3', 'Indomitable (three uses)', 17, 3),
    ]);
    const next = up(old17);
    expect(next.character.features).toEqual([
      { ...old17.features[0], name: 'Action Surge (two uses)', uses: { max: 2, used: 1, recharge: 'short' } },
      { ...old17.features[1], name: 'Indomitable (three uses)', uses: { max: 3, used: 1, recharge: 'long' } },
    ]);
    expect(messages(next)).toEqual(
      expect.arrayContaining([
        'Action Surge (one use) and Action Surge (two uses) merged into Action Surge (two uses): 2 uses, 1 left.',
        'Indomitable (one use), Indomitable (two uses) and Indomitable (three uses) merged into Indomitable (three uses): 3 uses, 2 left.',
      ]),
    );
    expect(next.merges?.map((m) => m.id)).toEqual(['surge1', 'ind1']);
  });

  it("keeps the DM's ruling: the ruled entry stays as it is, the row and any duplicate fold into it, and no reminder asks to add the row (S2)", () => {
    const ruled: Feature = { ...entry('ind', 'Indomitable (one use)', 9, 2, 1), uses: { max: 2, used: 1, recharge: 'long', ruled: true } };
    const sixteen = fighterAt(16, [entry('surge', 'Action Surge (one use)', 2, 1), ruled]);
    const dialog = up(sixteen, [row('Action Surge (two uses)', 17, 2), row('Indomitable (three uses)', 17, 3)]);
    for (const r of [dialog, up(sixteen)]) {
      expect(family(r.character, 'Indomitable')).toEqual([ruled]);
      expect(family(r.character, 'Action Surge')).toEqual([{ ...sixteen.features[0], name: 'Action Surge (two uses)', uses: { max: 2, used: 0, recharge: 'short' } }]);
      // The row folded into the ruled entry, which the sheet holds: nothing to add (the kept ruling is the DM's line).
      expect(r.reminders.some((m) => m.startsWith('New Fighter 17 features'))).toBe(false);
      expect(r.merges).toBeUndefined();
    }
    expect(dialog.folded).toEqual(['Action Surge (two uses)', 'Indomitable (three uses)']);
    // srd:class:fighter table: "| 13 | +5 | Indomitable (two uses), Studied Attacks |": a ruling of 3 at Fighter 12 is
    // kept, and the reminder lists only what the sheet lacks.
    const ruled12 = fighterAt(12, [entry('surge', 'Action Surge (one use)', 2, 1), { ...ruled, uses: { max: 3, used: 1, recharge: 'long', ruled: true } }]);
    const dialog12 = up(ruled12, [row('Indomitable (two uses)', 13, 2), row('Studied Attacks', 13)]);
    const dm12 = up(ruled12);
    for (const r of [dialog12, dm12]) expect(family(r.character, 'Indomitable')).toEqual([ruled12.features[1]]);
    expect(dialog12.reminders.some((m) => m.startsWith('New Fighter 13 features'))).toBe(false);
    expect(dm12.reminders).toContain('New Fighter 13 features to add to the sheet: Studied Attacks.');
    // Beside an older version's duplicate: one entry, the ruling's, its spent uses at most its number.
    const both = fighterAt(16, [ruled, entry('ind2', 'Indomitable (two uses)', 13, 2, 2)]);
    const merged = up(both);
    expect(merged.character.features).toEqual([{ ...ruled, uses: { ...ruled.uses!, used: 2 } }]);
    expect(messages(merged)).toContain('Indomitable (one use) and Indomitable (two uses) merged into Indomitable (one use): 2 uses, 0 left.');
    // The ruling on the later entry (the DM rewrote the level-13 one with 3): that entry is the one kept, under its name.
    const later: Feature = { ...entry('ind2', 'Indomitable (two uses)', 13, 3), uses: { max: 3, used: 0, recharge: 'long', ruled: true } };
    const laterRuled = up(fighterAt(14, [entry('ind1', 'Indomitable (one use)', 9, 1, 1), later]));
    expect(laterRuled.character.features).toEqual([{ ...later, uses: { ...later.uses!, used: 1 } }]);
    expect(laterRuled.merges).toMatchObject([{ id: 'ind2', name: 'Indomitable (two uses)', merged: ['Indomitable (one use)', 'Indomitable (two uses)'] }]);
  });

  it("folds the DM's entry of the table's name into the class's (S3); a family of the DM's entries only grows in place by the table's row (R2)", () => {
    // An older sheet: the DM followed the Fighter 13 reminder with features_add beside the class's entry.
    const dm: Feature = { id: 'dm', name: 'Indomitable (two uses)', source: 'class', sourceName: 'Granted in play', description: 'DM words.', uses: { max: 2, used: 1, recharge: 'long' } };
    const houseRule: Feature = { ...dm, id: 'house', name: 'Indomitable (house rule)', uses: { max: 1, used: 0, recharge: 'long' } };
    const thirteen = fighterAt(13, [entry('surge', 'Action Surge (one use)', 2, 1), entry('ind', 'Indomitable (one use)', 9, 1), dm, houseRule]);
    const r = up(thirteen);
    expect(family(r.character, 'Indomitable')).toEqual([{ ...thirteen.features[1], name: 'Indomitable (two uses)', uses: { max: 2, used: 1, recharge: 'long' } }, houseRule]);
    expect(messages(r)).toContain('Indomitable (one use) and Indomitable (two uses) merged into Indomitable (two uses): 2 uses, 1 left.');
    // The DM's bare "Indomitable" with the same count beside it: the table's name stays.
    const bare: Feature = { ...dm, id: 'bare', name: 'Indomitable', uses: { max: 2, used: 0, recharge: 'long' } };
    const fourteen = fighterAt(14, [{ ...entry('ind', 'Indomitable (two uses)', 9, 2, 1) }, bare]);
    expect(up(fourteen).character.features).toEqual([fourteen.features[0]]);
    // A DM-only Fighter (every feature from features_add): the Fighter's table counts Indomitable by name, so its row at
    // 13 grows the DM's entry in place, and the reminder lists only what the sheet lacks.
    const granted = (name: string, max: number): Feature => ({ id: name, name, source: 'class', sourceName: 'Granted in play', description: 'DM words.', uses: { max, used: 0, recharge: 'long' } });
    const dmOnly = fighterAt(12, [granted('Action Surge (one use)', 1), granted('Indomitable (one use)', 1)]);
    const dmUp = up(dmOnly);
    expect(dmUp.character.features).toEqual([dmOnly.features[0], { ...dmOnly.features[1], name: 'Indomitable (two uses)', uses: { max: 2, used: 0, recharge: 'long' } }]);
    expect(dmUp.reminders).toContain('New Fighter 13 features to add to the sheet: Studied Attacks.');
  });

  it("an older Fighter the DM's level_up levelled (every row added with features_add) merges to one entry of each at its next level-up, on either path (R2)", () => {
    // srd:rule:fighter-action-surge: "Starting at level 17, you can use it twice before a rest"; srd:rule:fighter-indomitable:
    // "three times before a Long Rest starting at level 17". The DM's level_up added no SRD class features before, and the
    // DM followed each reminder with features_add ("Granted in play"): five entries for two features.
    const granted = (id: string, name: string, max: number, used = 0): Feature => ({ ...entry(id, name, 0, max, used), sourceName: 'Granted in play' });
    const old17 = fighterAt(17, [
      granted('surge1', 'Action Surge (one use)', 1, 1),
      granted('ind1', 'Indomitable (one use)', 1, 1),
      granted('ind2', 'Indomitable (two uses)', 2),
      granted('surge2', 'Action Surge (two uses)', 2),
      granted('ind3', 'Indomitable (three uses)', 3),
    ]);
    // Fighter 18 brings the Champion's Survivor (a subclass feature) through the dialog, nothing through the DM's level_up.
    const survivor: Omit<Feature, 'id'> = { name: 'Survivor', source: 'subclass', sourceName: 'Champion 18', description: '' };
    for (const r of [up(old17), up(old17, [survivor])]) {
      expect(r.character.features.slice(0, 2)).toEqual([
        { ...old17.features[0], name: 'Action Surge (two uses)', uses: { max: 2, used: 1, recharge: 'short' } },
        { ...old17.features[1], name: 'Indomitable (three uses)', uses: { max: 3, used: 1, recharge: 'long' } },
      ]);
      expect(family(r.character, 'Action Surge')).toHaveLength(1);
      expect(family(r.character, 'Indomitable')).toHaveLength(1);
      expect(messages(r)).toEqual(
        expect.arrayContaining([
          'Action Surge (one use) and Action Surge (two uses) merged into Action Surge (two uses): 2 uses, 1 left.',
          'Indomitable (one use), Indomitable (two uses) and Indomitable (three uses) merged into Indomitable (three uses): 3 uses, 2 left.',
        ]),
      );
      expect(r.merges?.map((m) => [m.id, m.text])).toEqual([
        ['surge1', 'merged into Action Surge (two uses) (2 uses, 1 left): Action Surge (one use), Action Surge (two uses)'],
        ['ind1', 'merged into Indomitable (three uses) (3 uses, 2 left): Indomitable (one use), Indomitable (two uses), Indomitable (three uses)'],
      ]);
    }
    // A Rogue level merges them too: the family is the Fighter's, whatever class the level is in.
    const multi = { ...old17, classes: [asClass('Fighter', 16), asClass('Rogue', 1)] };
    expect(levelUp(multi, { className: 'Rogue', hpMethod: 'average' }).merges?.map((m) => m.id)).toEqual(['surge1', 'ind1']);
  });

  it("a DM-only Fighter's rows grow its entries in place at 13 and 17, spent uses kept; at 2 and 9, with no entry of the family yet, the reminder is today's (R2; srd:class:fighter table)", () => {
    // srd:class:fighter, Fighter Features table: "| 13 | +5 | Indomitable (two uses), Studied Attacks |", "| 17 | +6 |
    // Action Surge (two uses), Indomitable (three uses) |".
    const granted = (id: string, name: string, max: number, used = 0): Feature => ({ ...entry(id, name, 0, max, used), sourceName: 'Granted in play' });
    const twelve = fighterAt(12, [granted('surge', 'Action Surge (one use)', 1), granted('ind', 'Indomitable (one use)', 1, 1)]);
    const thirteen = up(twelve);
    expect(thirteen.character.features).toEqual([twelve.features[0], { ...twelve.features[1], name: 'Indomitable (two uses)', uses: { max: 2, used: 1, recharge: 'long' } }]);
    expect(messages(thirteen)).toContain('Feature uses now: Indomitable (two uses) 1 → 2.');
    expect(thirteen.reminders).toContain('New Fighter 13 features to add to the sheet: Studied Attacks.');
    expect(thirteen.merges).toBeUndefined();
    const sixteen = fighterAt(16, [granted('surge', 'Action Surge (one use)', 1, 1), granted('ind', 'Indomitable (two uses)', 2, 2)]);
    const seventeen = up(sixteen);
    expect(seventeen.character.features).toEqual([
      { ...sixteen.features[0], name: 'Action Surge (two uses)', uses: { max: 2, used: 1, recharge: 'short' } },
      { ...sixteen.features[1], name: 'Indomitable (three uses)', uses: { max: 3, used: 2, recharge: 'long' } },
    ]);
    expect(messages(seventeen)).toContain('Feature uses now: Action Surge (two uses) 1 → 2 and Indomitable (three uses) 2 → 3.');
    expect(seventeen.reminders.some((m) => m.startsWith('New Fighter 17 features'))).toBe(false);
    // The DM's entry with the DM's ruling keeps it, and the row it folds isn't one to add.
    const ruled: Feature = { ...granted('ind', 'Indomitable (one use)', 3, 1), uses: { max: 3, used: 1, recharge: 'long', ruled: true } };
    const ruledUp = up(fighterAt(12, [twelve.features[0], ruled]));
    expect(ruledUp.character.features).toEqual([twelve.features[0], ruled]);
    expect(ruledUp.reminders).toContain('New Fighter 13 features to add to the sheet: Studied Attacks.');
    // No entry of the family yet: nothing to grow, and the row is to add, as always.
    expect(up(fighterAt(1, [])).reminders).toContain('New Fighter 2 features to add to the sheet: Action Surge (one use), Tactical Mind.');
    const eight = fighterAt(8, [granted('surge', 'Action Surge (one use)', 1)]);
    const nine = up(eight);
    expect(nine.character.features).toEqual(eight.features);
    expect(nine.reminders).toContain('New Fighter 9 features to add to the sheet: Indomitable (one use), Tactical Master.');
  });

  it("the DM's level_up new_features of another parenthetical are features of their own: added and listed, as before (F2; srd:rule:fighter-action-surge)", () => {
    // srd:rule:fighter-action-surge: "you can take one additional action, except the Magic action". A DM's homebrew "Action
    // Surge (Bonus)" is no row of the table: the class's Action Surge stays as it is beside it.
    const thirteen = fighterAt(13, [entry('surge', 'Action Surge (one use)', 2, 1), entry('ind', 'Indomitable (two uses)', 9, 2, 1)]);
    const bonus: Omit<Feature, 'id'> = { name: 'Action Surge (Bonus)', source: 'class', description: 'Homebrew: a Bonus Action surge.', uses: { max: 1, used: 0, recharge: 'short' } };
    const r = up(thirteen, [bonus]);
    expect(r.character.features).toEqual([...thirteen.features, { ...bonus, id: expect.any(String), sourceName: 'Fighter 14' }]);
    expect(messages(r)).toContain('New features: Action Surge (Bonus).');
    expect(r.folded).toBeUndefined();
    expect(r.merges).toBeUndefined();
    // At 13 the table's row still grows the class's Indomitable, and the DM's "Indomitable (Tactical)" joins beside it.
    const twelve = fighterAt(12, [entry('surge', 'Action Surge (one use)', 2, 1), entry('ind', 'Indomitable (one use)', 9, 1, 1)]);
    const tactical: Omit<Feature, 'id'> = { name: 'Indomitable (Tactical)', source: 'class', description: 'Homebrew: a tactical reroll.', uses: { max: 1, used: 0, recharge: 'long' } };
    const t = up(twelve, [tactical]);
    expect(family(t.character, 'Indomitable').map((f) => [f.name, f.uses?.max, f.uses?.used])).toEqual([
      ['Indomitable (two uses)', 2, 1],
      ['Indomitable (Tactical)', 1, 0],
    ]);
    expect(messages(t)).toContain('New features: Indomitable (Tactical).');
    expect(messages(t)).toContain('Feature uses now: Indomitable (two uses) 1 → 2.');
    expect(t.reminders).toContain('New Fighter 13 features to add to the sheet: Studied Attacks.');
  });

  it("a DM's higher count among the level's new features is the entry's count, the DM's ruling, and the table's row isn't told to be added (F4, D3; srd:class:fighter table, \"Indomitable (two uses)\" at 13)", () => {
    const twelve = fighterAt(12, [entry('surge', 'Action Surge (one use)', 2, 1), entry('ind', 'Indomitable (one use)', 9, 1, 1)]);
    const house = (name: string): Omit<Feature, 'id'> => ({ name, source: 'class', description: 'A house rule.', uses: { max: 3, used: 0, recharge: 'long' } });
    for (const name of ['Indomitable (three uses)', 'Indomitable']) {
      const r = up(twelve, [house(name)]);
      // Three at Fighter 13, where the table gives two: the DM's ruling, which the dialog's re-read and level_up both keep.
      expect(family(r.character, 'Indomitable')).toEqual([{ ...twelve.features[1], name, uses: { max: 3, used: 1, recharge: 'long', ruled: true } }]);
      expect(r.reminders).toContain('New Fighter 13 features to add to the sheet: Studied Attacks.');
      expect(r.reminders.join(' ')).not.toContain('Indomitable (two uses)');
    }
  });

  it("folds the DM's new_features entry of the family into the entry the sheet holds, by the table's name or the bare name", () => {
    const twelve = fighterAt(12, [entry('surge', 'Action Surge (one use)', 2, 1), entry('ind', 'Indomitable (one use)', 9, 1, 1)]);
    const grown = { ...twelve.features[1], name: 'Indomitable (two uses)', uses: { max: 2, used: 1, recharge: 'long' } };
    const dmEntry = (name: string): Omit<Feature, 'id'> => ({ name, source: 'class', description: 'DM words.', uses: { max: 2, used: 0, recharge: 'long' } });
    for (const name of ['Indomitable (two uses)', 'Indomitable']) {
      const r = up(twelve, [dmEntry(name)]);
      expect(family(r.character, 'Indomitable')).toEqual([grown]);
      expect(messages(r)).toContain('Feature uses now: Indomitable (two uses) 1 → 2.');
      expect(messages(r).some((m) => m.startsWith('New features'))).toBe(false);
      expect(r.folded).toEqual([name]);
      expect(r.reminders).toContain('New Fighter 13 features to add to the sheet: Studied Attacks.');
    }
  });

  it('counts by Fighter level in a multiclass: a Wizard or Rogue level grows nothing (srd:rule:multiclassing-class-features: "When you gain a new level in a class, you get its features for that level.")', () => {
    // Fighter 12 / Wizard 1 levelling Wizard (character level 14) keeps one Indomitable; a Fighter level gives two.
    const fw = mira({ classes: [asClass('Fighter', 12), asClass('Wizard', 1)], features: [entry('surge', 'Action Surge (one use)', 2, 1), entry('ind', 'Indomitable (one use)', 9, 1)] });
    const wizard = levelUp(fw, { className: 'Wizard', hpMethod: 'average' });
    expect(wizard.character.features).toEqual(fw.features);
    expect(messages(wizard).some((m) => m.startsWith('Feature uses now'))).toBe(false);
    expect(family(levelUp(fw, { className: 'Fighter', hpMethod: 'average' }).character, 'Indomitable')).toMatchObject([{ name: 'Indomitable (two uses)', uses: { max: 2 } }]);
    // Fighter 16 / Rogue 1 (character level 17) keeps one Action Surge, by either class's level.
    const fr = (fighter: number, rogue: number) =>
      mira({ classes: [asClass('Fighter', fighter), asClass('Rogue', rogue)], spellcasting: undefined, features: [entry('surge', 'Action Surge (one use)', 2, 1), entry('ind', 'Indomitable (two uses)', 9, 2)] });
    for (const r of [levelUp(fr(15, 1), { className: 'Fighter', hpMethod: 'average' }), levelUp(fr(16, 1), { className: 'Rogue', hpMethod: 'average' })]) {
      expect(r.character.features).toEqual(fr(16, 1).features);
    }
  });

  it('every other repeated row is added and kept as always: Ability Score Improvement (Fighter 6, 8), Improved Brutal Strike (Barbarian 13, 17), Mystic Arcanum (Warlock 13), Expertise (Rogue 6, Bard 9)', () => {
    const feature = (id: string, name: string, sourceName: string, description = ''): Feature => ({ id, name, source: 'class', sourceName, description });
    const add = ({ id: _id, ...f }: Feature) => f;
    // srd:class:fighter table: "| 6 | +3 | Ability Score Improvement | 3 | 4 |", "| 8 | +3 | Ability Score Improvement | 3 | 4 |".
    const asi = (level: number) => feature(`asi${level}`, 'Ability Score Improvement', `Fighter ${level}`);
    const six = up(fighterAt(5, [asi(4)]), [add(asi(6))]);
    expect(six.character.features.map((f) => f.name)).toEqual(['Ability Score Improvement', 'Ability Score Improvement']);
    expect(messages(six)).toContain('New features: Ability Score Improvement.');
    expect(six.reminders.some((m) => m.startsWith('Fighter 6: Ability Score Improvement'))).toBe(true);
    expect(six.folded).toBeUndefined();
    const eight = up(fighterAt(7, [asi(4), asi(6)]), [add(asi(8))]);
    expect(eight.character.features.map((f) => f.sourceName)).toEqual(['Fighter 4', 'Fighter 6', 'Fighter 8']);
    expect(eight.reminders.some((m) => m.startsWith('Fighter 8: Ability Score Improvement'))).toBe(true);
    // srd:class:barbarian: 13 "You have honed new ways to attack furiously. The following effects are now among your
    // Brutal Strike options."; 17 "The extra damage of your Brutal Strike increases to 2d10. …": two rules, two entries.
    const ibs13 = feature('ibs13', 'Improved Brutal Strike', 'Barbarian 13', 'You have honed new ways to attack furiously.');
    const ibs17 = feature('ibs17', 'Improved Brutal Strike', 'Barbarian 17', 'The extra damage of your Brutal Strike increases to 2d10.');
    const barbarian = mira({ classes: [asClass('Barbarian', 16)], spellcasting: undefined, features: [ibs13] });
    const b17 = levelUp(barbarian, { className: 'Barbarian', hpMethod: 'average', newFeatures: [add(ibs17)] });
    expect(b17.character.features.map((f) => [f.name, f.description])).toEqual([
      ['Improved Brutal Strike', ibs13.description],
      ['Improved Brutal Strike', ibs17.description],
    ]);
    // srd:class:warlock: "you gain another Warlock spell of your choice that can be cast in this way when you reach
    // Warlock levels 13 (level 7 spell), 15 (level 8 spell), and 17 (level 9 spell)."
    const warlock = mira({ classes: [asClass('Warlock', 12)], features: [feature('ma6', 'Mystic Arcanum (level 6 spell)', 'Warlock 11')] });
    const w13 = levelUp(warlock, { className: 'Warlock', hpMethod: 'average', newFeatures: [add(feature('ma7', 'Mystic Arcanum (level 7 spell)', 'Warlock 13'))] });
    expect(w13.character.features.map((f) => f.name)).toEqual(['Mystic Arcanum (level 6 spell)', 'Mystic Arcanum (level 7 spell)']);
    expect(w13.reminders).toContain('Warlock 13: choose a Warlock spell for your Mystic Arcanum.');
    // srd:class:rogue: "At Rogue level 6, you gain Expertise in two more of your skill proficiencies of your choice.";
    // srd:class:bard: "At Bard level 9, you gain Expertise in two more of your skill proficiencies of your choice."
    for (const [cls, from, to] of [['Rogue', 1, 6], ['Bard', 2, 9]] as const) {
      const hero = mira({ classes: [asClass(cls, to - 1)], features: [feature('e1', 'Expertise', `${cls} ${from}`)] });
      const r = levelUp(hero, { className: cls, hpMethod: 'average', newFeatures: [add(feature('e2', 'Expertise', `${cls} ${to}`))] });
      expect(r.character.features.map((f) => f.sourceName)).toEqual([`${cls} ${from}`, `${cls} ${to}`]);
      expect(r.reminders).toContain(`${cls} ${to}: choose two skill proficiencies to gain Expertise in.`);
    }
  });

  it("a DM's own counted label beside a class feature named without a count is no family: both stay as before (srd:class:druid Wild Shape, srd:class:barbarian Rage)", () => {
    // srd:class:druid, Wild Shape: "You can use Wild Shape twice. … You gain additional uses when you reach certain Druid
    // levels, as shown in the Wild Shape column of the Druid Features table" ("| 6 | +3 | Subclass feature | 3 |").
    const wildShape: Feature = { id: 'ws', name: 'Wild Shape', source: 'class', sourceName: 'Druid 2', description: '', uses: { max: 2, used: 1, recharge: 'long' } };
    const dmShape: Feature = { id: 'dm', name: 'Wild Shape (2 uses)', source: 'class', sourceName: 'Granted in play', description: 'DM words.', uses: { max: 2, used: 0, recharge: 'long' } };
    const druid = levelUp(mira({ classes: [asClass('Druid', 5)], features: [wildShape, dmShape] }), { className: 'Druid', hpMethod: 'average' });
    expect(druid.character.features).toEqual([{ ...wildShape, uses: { ...wildShape.uses!, max: 3 } }, dmShape]);
    expect(messages(druid)).toContain('Feature uses now: Wild Shape 2 → 3.');
    expect(druid.merges).toBeUndefined();
    // srd:class:barbarian, Rage: "the number of times shown for your Barbarian level in the Rages column of the
    // Barbarian Features table" ("| 4 | +2 | Ability Score Improvement | 3 |"); the DM's entry named with that count.
    const rage: Feature = { id: 'rage', name: 'Rage', source: 'class', sourceName: 'Barbarian 1', description: '', uses: { max: 3, used: 1, recharge: 'long' } };
    const dmRage: Feature = { id: 'dm-rage', name: 'Rage (3 uses)', source: 'class', sourceName: 'Granted in play', description: 'DM words.', uses: { max: 3, used: 0, recharge: 'long' } };
    const barbarian = levelUp(mira({ classes: [asClass('Barbarian', 3)], spellcasting: undefined, features: [rage, dmRage] }), { className: 'Barbarian', hpMethod: 'average' });
    expect(barbarian.character.features).toEqual([rage, dmRage]);
    expect(barbarian.merges).toBeUndefined();
    expect(barbarian.folded).toBeUndefined();
    // Nor does the DM's label hold the table's row of the bare name: Druid 2 ("| 2 | +2 | Wild Shape, Wild Companion |")
    // still names Wild Shape to add.
    const druid1 = levelUp(mira({ classes: [asClass('Druid', 1)], features: [dmShape] }), { className: 'Druid', hpMethod: 'average' });
    expect(druid1.reminders).toContain('New Druid 2 features to add to the sheet: Wild Shape, Wild Companion.');
  });

  it("a book Fighter's entry that follows its table's counts keeps its name and scale as the DM's entry of the table's name folds in; a higher count is the DM's ruling on it", () => {
    // A 2024 book's Fighter as the offline parser names it ("Indomitable"): its uses read from the table's "Indomitable
    // (two uses)" cell at 13 (srd:class:fighter's Fighter Features table, as the book prints it), a by-table scale.
    const scale = { by: 'table' as const, className: 'Fighter', values: [...Array<number>(8).fill(0), 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3] };
    const bookFighter = (level: number): ClassLevel => ({ classId: 'lib:lantern:class:fighter', name: 'Fighter', level, hitDie: 10, casterType: 'none' });
    const bare: Feature = { ...entry('ind', 'Indomitable', 9, 1, 1), uses: { max: 1, used: 1, recharge: 'long', scale } };
    const twelve = mira({ classes: [bookFighter(12)], hitDice: [{ die: 10, total: 12, spent: 0 }], spellcasting: undefined, features: [bare] });
    const dmEntry = (name: string, max: number): Omit<Feature, 'id'> => ({ name, source: 'class', description: 'DM words.', uses: { max, used: 0, recharge: 'long' } });
    const r = up(twelve, [dmEntry('Indomitable (two uses)', 2)]);
    expect(r.character.features).toEqual([{ ...bare, uses: { max: 2, used: 1, recharge: 'long', scale } }]);
    expect(r.folded).toEqual(['Indomitable (two uses)']);
    expect(messages(r)).toContain('Feature uses now: Indomitable 1 → 2.');
    // Three at Fighter 13, where the table gives two: the DM's ruling, on the same entry under its own name.
    const ruled = up(twelve, [dmEntry('Indomitable (three uses)', 3)]);
    expect(ruled.character.features).toEqual([{ ...bare, uses: { max: 3, used: 1, recharge: 'long', ruled: true } }]);
    // The next level leaves the ruling as it is.
    expect(up({ ...ruled.character, classes: [bookFighter(16)] }).character.features).toEqual(ruled.character.features);
  });

  it("a 2024 book Fighter's bare entry its table hasn't counted yet keeps its name as the DM's entry merges into it, so the next read of the table gives the count; a higher count of the DM's is the ruling, its own older count isn't (F2; srd:rule:fighter-indomitable)", () => {
    // An older save of a 2024 book's Fighter 12 / Wizard 1 as the offline parser names its features ("Indomitable" without
    // uses, "Action Surge" read as 2 from the level-17 sentence), the DM's "Indomitable (one use)" beside, levelling its
    // Wizard where nothing read the book's table first (its data isn't on this device). srd:rule:fighter-indomitable: "You
    // can use this feature twice before a Long Rest starting at level 13 and three times before a Long Rest starting at
    // level 17": the name keeps no count the table would have to read over.
    const ref: ImportedRef = { sourceId: 'lantern', sourceTitle: 'The Lanternfall Handbook', entryId: 'lib:lantern:class:fighter', kind: 'class', entryName: 'Fighter', format: '2024', textHash: '', textCopied: false };
    const book = (level: number): ClassLevel => ({ classId: 'lib:lantern:class:fighter', name: 'Fighter', level, hitDie: 10, casterType: 'none', ref });
    const bare: Feature = { ...entry('ind', 'Indomitable', 9, 0), uses: undefined };
    const surge = entry('surge', 'Action Surge', 2, 2);
    const granted = (id: string, name: string, max: number): Feature => ({ ...entry(id, name, 9, max), sourceName: 'Granted in play', description: 'DM words.' });
    const hero = (classes: ClassLevel[], features: Feature[]) => mira({ classes, hitDice: [{ die: 10, total: 12, spent: 0 }, { die: 6, total: 1, spent: 0 }], features });
    const wizard = (c: Character) => levelUp(c, { className: 'Wizard', hpMethod: 'average' });
    const r = wizard(hero([book(12), asClass('Wizard', 1)], [surge, bare, granted('dm', 'Indomitable (one use)', 1)]));
    expect(family(r.character, 'Indomitable')).toEqual([{ ...bare, uses: { max: 1, used: 0, recharge: 'long' } }]);
    expect(messages(r)).toContain('Indomitable and Indomitable (one use) merged into Indomitable: 1 use, 1 left.');
    expect(family(r.character, 'Action Surge')).toEqual([surge]);
    // The DM's higher count beside it ("Indomitable (two uses)" at Fighter 12, where the table gives one) is the DM's
    // ruling on it, under its own name.
    const higher = wizard(hero([book(12), asClass('Wizard', 1)], [surge, bare, granted('dm', 'Indomitable (two uses)', 2)]));
    expect(family(higher.character, 'Indomitable')).toEqual([{ ...bare, uses: { max: 2, used: 0, recharge: 'long', ruled: true } }]);
    // Its own older count isn't: "Action Surge" read as 2 beside the DM's "Action Surge (one use)" keeps its 2 unruled,
    // for the next read to give the table's 1 (srd:rule:fighter-action-surge: "Starting at level 17, you can use it twice").
    const surges = wizard(hero([book(12), asClass('Wizard', 1)], [surge, granted('dms', 'Action Surge (one use)', 1)]));
    expect(family(surges.character, 'Action Surge')).toEqual([surge]);
    expect(messages(surges)).toContain('Action Surge and Action Surge (one use) merged into Action Surge: 2 uses, 2 left.');
    // An SRD Fighter's own bare entry (a hand-made sheet) is no book's: it takes the newest name, as before.
    const srd = wizard(hero([asClass('Fighter', 12), asClass('Wizard', 1)], [surge, bare, granted('dm', 'Indomitable (one use)', 1)]));
    expect(family(srd.character, 'Indomitable')).toEqual([{ ...bare, name: 'Indomitable (one use)', uses: { max: 1, used: 0, recharge: 'long' } }]);
  });

  it("a count above the Fighter table's at the class level is the DM's ruling on the entry kept; at the table's count, none (D3; srd:class:fighter table)", () => {
    // srd:class:fighter, Fighter Features table: "Action Surge (one use)" at 2, "Indomitable (one use)" at 9, "(two uses)"
    // at 13, "Action Surge (two uses), Indomitable (three uses)" at 17: the latest count at or below the Fighter level.
    const granted = (id: string, name: string, max: number): Feature => ({ ...entry(id, name, 0, max), sourceName: 'Granted in play', description: 'DM words.' });
    const multi = (fighter: number, features: Feature[]) =>
      mira({ classes: [asClass('Fighter', fighter), asClass('Wizard', 1)], hitDice: [{ die: 10, total: fighter, spent: 0 }, { die: 6, total: 1, spent: 0 }], features });
    const wizard = (c: Character) => levelUp(c, { className: 'Wizard', hpMethod: 'average' });
    // Fighter 16, where the table gives two: the DM's three is its ruling.
    const sixteen = wizard(multi(16, [entry('ind', 'Indomitable (two uses)', 13, 2), granted('dm', 'Indomitable (three uses)', 3)]));
    expect(family(sixteen.character, 'Indomitable')).toEqual([{ ...entry('ind', 'Indomitable (three uses)', 13, 3), uses: { max: 3, used: 0, recharge: 'long', ruled: true } }]);
    // Fighter 17, where it gives three: the same three is no ruling.
    const seventeen = wizard(multi(17, [entry('ind', 'Indomitable (two uses)', 13, 2), granted('dm', 'Indomitable (three uses)', 3)]));
    expect(family(seventeen.character, 'Indomitable')).toEqual([entry('ind', 'Indomitable (three uses)', 13, 3)]);
    // The class's own entry counting more than the table (the DM's features_add of "Indomitable (two uses)" at 12, its
    // name's count) beside the DM's bare entry: the count kept is the ruling too.
    const own = wizard(multi(12, [entry('ind', 'Indomitable (two uses)', 9, 2), granted('dm', 'Indomitable', 1)]));
    expect(family(own.character, 'Indomitable')).toEqual([{ ...entry('ind', 'Indomitable (two uses)', 9, 2), uses: { max: 2, used: 0, recharge: 'long', ruled: true } }]);
    // A DM-only Fighter 1 whose boon "Action Surge (two uses)" meets the table's "(one use)" at Fighter 2: its ruling.
    const boon = granted('gs', 'Action Surge (two uses)', 2);
    const two = levelUp(fighterAt(1, [boon]), { className: 'Fighter', hpMethod: 'average' });
    expect(two.character.features).toEqual([{ ...boon, uses: { max: 2, used: 0, recharge: 'short', ruled: true } }]);
    expect(two.reminders).toContain('New Fighter 2 features to add to the sheet: Tactical Mind.');
  });

  it("a new feature kept under the name of the DM's entry that counts more is merged with it, named first as it came, and is no new feature; every other merge reads as before (F3; srd:class:fighter table: \"| 2 | +2 | Action Surge (one use), Tactical Mind |\")", () => {
    // A Wizard 5 / Fighter 1 holding the DM's boon "Action Surge (two uses)" (features_add, the class's source, before the
    // Fighter's own Action Surge) levels Fighter 2 with the table's row among the new features: the level-up dialog's, or
    // level_up's new_features. The class's entry is kept under the boon's name and count, the DM's ruling (D3).
    const boon: Feature = { ...entry('boon', 'Action Surge (two uses)', 0, 2), sourceName: 'Granted in play', description: 'A boon of the Lantern-Saint.' };
    const multi = mira({ classes: [asClass('Wizard', 5), asClass('Fighter', 1)], hitDice: [{ die: 6, total: 5, spent: 0 }, { die: 10, total: 1, spent: 0 }], features: [boon] });
    const two = up(multi, [row('Action Surge (one use)', 2, 1), row('Tactical Mind', 2)]);
    const kept = family(two.character, 'Action Surge');
    expect(kept).toEqual([{ ...entry(kept[0].id, 'Action Surge (two uses)', 2, 2), uses: { max: 2, used: 0, recharge: 'short', ruled: true } }]);
    expect(kept[0].id).not.toBe('boon');
    expect(messages(two).filter((m) => m.startsWith('New features'))).toEqual(['New features: Tactical Mind.']);
    expect(messages(two)).toContain('Action Surge (one use) and Action Surge (two uses) merged into Action Surge (two uses): 2 uses, 2 left.');
    expect(two.merges).toEqual([
      {
        id: kept[0].id,
        name: 'Action Surge (two uses)',
        merged: ['Action Surge (one use)', 'Action Surge (two uses)'],
        text: 'merged into Action Surge (two uses) (2 uses, 2 left): Action Surge (one use), Action Surge (two uses)',
        renamedNew: true,
      },
    ]);
    expect(two.folded).toEqual(['Action Surge (one use)']);
    expect(two.reminders.some((m) => m.startsWith('New Fighter 2 features'))).toBe(false);
    // The DM's level_up without new_features keeps the boon itself, its count the ruling, as before: no merge, nothing
    // folded, and the reminder names Tactical Mind.
    const dm = up(multi);
    expect(family(dm.character, 'Action Surge')).toEqual([{ ...boon, uses: { max: 2, used: 0, recharge: 'short', ruled: true } }]);
    expect(dm.merges).toBeUndefined();
    expect(dm.folded).toBeUndefined();
    expect(dm.reminders).toContain('New Fighter 2 features to add to the sheet: Tactical Mind.');
    // Indomitable alike: an SRD Fighter 8's boon "Indomitable (two uses)" at Fighter 9 (srd:class:fighter table: "| 9 | +4 |
    // Indomitable (one use), Tactical Master |").
    const eight = fighterAt(8, [entry('surge', 'Action Surge (one use)', 2, 1), { ...entry('dm', 'Indomitable (two uses)', 0, 2), sourceName: 'Granted in play', description: 'A boon.' }]);
    const nine = up(eight, [row('Indomitable (one use)', 9, 1), row('Tactical Master', 9)]);
    expect(messages(nine).filter((m) => m.startsWith('New features') || m.includes('merged'))).toEqual([
      'New features: Tactical Master.',
      'Indomitable (one use) and Indomitable (two uses) merged into Indomitable (two uses): 2 uses, 2 left.',
    ]);
    expect(nine.folded).toEqual(['Indomitable (one use)']);
    // A new feature kept under its own name is listed as new, and the DM's entry merged into it, as before: a 2024 book's
    // Fighter's bare "Indomitable" (readsItsTable) beside the DM's boon at 9.
    const ref: ImportedRef = { sourceId: 'lantern', sourceTitle: 'The Lanternfall Handbook', entryId: 'lib:lantern:class:fighter', kind: 'class', entryName: 'Fighter', format: '2024', textHash: '', textCopied: false };
    const book = { ...eight, classes: [{ classId: 'lib:lantern:class:fighter', name: 'Fighter', level: 8, hitDie: 10 as const, casterType: 'none' as const, ref }] };
    const bookNine = up(book, [row('Indomitable', 9), row('Tactical Master', 9)]);
    expect(family(bookNine.character, 'Indomitable').map((f) => [f.name, f.sourceName, f.uses?.max, f.uses?.ruled])).toEqual([['Indomitable', 'Fighter 9', 2, true]]);
    expect(messages(bookNine).filter((m) => m.startsWith('New features') || m.includes('merged'))).toEqual([
      'New features: Indomitable, Tactical Master.',
      'Indomitable (two uses) merged into Indomitable: 2 uses, 2 left.',
    ]);
    expect(bookNine.merges?.map((m) => [m.merged, 'renamedNew' in m])).toEqual([[['Indomitable (two uses)'], false]]);
    expect(bookNine.folded).toBeUndefined();
  });

  it("a hero with no counted family levels up exactly as before: no merges, nothing folded", () => {
    const r = levelUp(mira(), { className: 'Wizard', hpMethod: 'average' });
    expect(Object.keys(r).sort()).toEqual(['character', 'events', 'hpGained', 'newLevel', 'reminders']);
  });
});

describe('levelUp: the Speed a level changes (Unarmored Movement, Fast Movement, Roving)', () => {
  const unarmored = (cls: string, level: number) => mira({ classes: [asClass(cls, level)], hitDice: [{ die: findSrdClass(cls)!.hitDie, total: level, spent: 0 }], spellcasting: undefined, features: [], inventory: [] });
  const messages = (r: { events: { message: string }[] }) => r.events.map((e) => e.message);

  it('names the Speed a Monk level raises, as a field and an event (srd:class:monk table: "+10 ft." at 2–5, "| 6 | +3 | … | +15 ft. |")', () => {
    // srd:rule:monk-unarmored-movement: "Your speed increases by 10 feet while you aren't wearing armor or wielding a
    // Shield. This bonus increases when you reach certain Monk levels, as shown in the Monk Features table."
    const six = levelUp(unarmored('Monk', 5), { className: 'Monk', hpMethod: 'average' });
    expect(six.speedChange).toBe('Speed 40 ft → 45 ft (Unarmored Movement)');
    expect(messages(six)).toContain('Speed 40 ft → 45 ft (Unarmored Movement).');
    // Monk 7 changes nothing: no field, no event.
    const seven = levelUp(six.character, { className: 'Monk', hpMethod: 'average' });
    expect('speedChange' in seven).toBe(false);
    expect(messages(seven).some((m) => m.startsWith('Speed'))).toBe(false);
  });

  it("names Roving's Climb and Swim Speeds at Ranger 6 (srd:rule:ranger-roving), and Fast Movement at Barbarian 5 (srd:rule:barbarian-fast-movement)", () => {
    // "Your Speed increases by 10 feet while you aren't wearing Heavy armor. You also have a Climb Speed and a Swim Speed
    // equal to your Speed."
    const ranger = levelUp(unarmored('Ranger', 5), { className: 'Ranger', hpMethod: 'average' });
    expect(ranger.speedChange).toBe('Speed 30 ft → 40 ft (Roving), with a Climb Speed and a Swim Speed of 40 ft');
    expect(messages(ranger)).toContain('Speed 30 ft → 40 ft (Roving), with a Climb Speed and a Swim Speed of 40 ft.');
    // "Your speed increases by 10 feet while you aren't wearing Heavy armor."
    expect(levelUp(unarmored('Barbarian', 4), { className: 'Barbarian', hpMethod: 'average' }).speedChange).toBe('Speed 30 ft → 40 ft (Fast Movement)');
  });
});
