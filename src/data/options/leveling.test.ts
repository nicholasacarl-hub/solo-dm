/**
 * Level-up from the merged builder data (spec §5.4), against the real engine and the invented Gloamwood
 * fixture: features gained per level and caught up when a subclass is chosen (SRD 5.2.1 "Level
 * Advancement"), a third-caster subclass's spellcasting ("Multiclassing: Spell Slots"), an imported
 * subclass's always-prepared spells, and the Feat choice panel ("Ability Score Improvement" feat; feat
 * prerequisites: only "Level N+" is checked).
 */
import { describe, expect, it } from 'vitest';
import { characterLevel, levelUp } from '@/engine';
import { nameKey } from '@/lib/id';
import { sampleCharacter } from '@/test/fixtures';
import { EXPECTED_MERGED, GLOAMWOOD_TITLE, SRD_BUILDER_DATA, TEXT } from '@/test/structuredFixtures';
import type { Character, ClassLevel, ClassOption, CompendiumEntry, SubclassOption } from '@/types';
import { gainedFeatures } from './leveling';
import {
  applyFeatChoice,
  caughtUpFeatures,
  dropChoiceReminder,
  featChoiceComplete,
  featChoiceNotice,
  featChoices,
  featChoiceTrigger,
  featIncrease,
  subclassCastingOf,
  subclassRefOf,
  subclassSpellsToAdd,
  type FeatChoice,
  type FeatChoiceTrigger,
} from './levelUpChoices';

const classOf = (id: string): ClassOption => {
  const found = EXPECTED_MERGED.classes.find((c) => c.id === id) ?? SRD_BUILDER_DATA.classes.find((c) => c.id === id);
  if (!found) throw new Error(`no class ${id}`);
  return found;
};
const subOf = (cls: ClassOption, name: string): SubclassOption => {
  const found = cls.subclasses.find((s) => s.name === name);
  if (!found) throw new Error(`no subclass ${name}`);
  return found;
};
const FIGHTER = classOf('srd:class:fighter');
const CLERIC = classOf('srd:class:cleric');
const WICKWRIGHT = classOf('lib:gloam:class:wickwright');
const EMBER = subOf(FIGHTER, 'Ember Warden');
const DUSK = subOf(CLERIC, 'Dusk Domain');

function hero(cl: Partial<ClassLevel> & Pick<ClassLevel, 'classId' | 'name' | 'level' | 'hitDie'>, extra: Partial<Character> = {}): Character {
  const base = sampleCharacter();
  return {
    ...base,
    classes: [{ casterType: 'none', ...cl }],
    hitDice: [{ die: cl.hitDie, total: cl.level, spent: 0 }],
    features: [],
    spellcasting: undefined,
    inventory: [],
    armorClass: 12,
    abilityScores: { str: 16, dex: 14, con: 13, int: 10, wis: 12, cha: 8 },
    ...extra,
  };
}
const ctxOf = (c: Character) => ({ scores: c.abilityScores, characterLevel: characterLevel(c) + 1 });

describe('gainedFeatures (SRD 5.2.1 Level Advancement)', () => {
  it("adds an imported class's features at exactly the new level, with their book text and refs", () => {
    const c = hero({ classId: WICKWRIGHT.id, name: 'Wickwright', level: 3, hitDie: 8, casterType: 'half' });
    const gained = gainedFeatures(WICKWRIGHT, 4, undefined, ctxOf(c), { have: c.features });
    expect(gained.map((f) => f.name)).toEqual(['Ability Score Improvement']);
    expect(gained[0]).toMatchObject({ source: 'class', sourceName: 'Wickwright 4', description: TEXT.abilityScoreImprovement.join('\n\n') });
    expect(gained[0].ref).toMatchObject({ entryId: WICKWRIGHT.id, part: 'Ability Score Improvement', level: 4, textCopied: true });
  });

  it('adds the subclass chosen now with its uses and refs, and only its features up to the level', () => {
    const c = hero({ classId: FIGHTER.id, name: 'Fighter', level: 2, hitDie: 10 });
    const gained = gainedFeatures(FIGHTER, 3, EMBER, ctxOf(c), { have: c.features, subclassChosenNow: true });
    expect(gained.map((f) => [f.source, f.name])).toEqual([
      ['class', 'Fighter Subclass'],
      ['subclass', 'Ember Ward'],
      ['subclass', 'Kindled Strikes'],
    ]);
    const ward = gained[1];
    // "a number of times equal to your Proficiency Bonus … when you finish a Long Rest"
    expect(ward.uses).toMatchObject({ max: 2, used: 0, recharge: 'long', scale: { by: 'proficiency-bonus' } });
    expect(ward).toMatchObject({ sourceName: 'Ember Warden 3', ref: { entryId: EMBER.id, part: 'Ember Ward', level: 3, textCopied: true } });
    // A "Subclass feature" row of a class table names no feature of its own and is skipped.
    expect(gainedFeatures(WICKWRIGHT, 7, undefined, ctxOf(c)).map((f) => f.name)).toEqual([]);
  });

  it('catches up the subclass features of earlier levels when the subclass is chosen late', () => {
    const c = hero({ classId: FIGHTER.id, name: 'Fighter', level: 3, hitDie: 10 });
    const gained = gainedFeatures(FIGHTER, 4, EMBER, ctxOf(c), { have: c.features, subclassChosenNow: true });
    expect(gained.map((f) => f.name)).toEqual(['Ability Score Improvement', 'Ember Ward', 'Kindled Strikes']);
    expect(caughtUpFeatures(EMBER, 4, c.features).map((d) => d.name)).toEqual(['Ember Ward', 'Kindled Strikes']);
    // Features already on the sheet aren't added twice.
    const withWard = { ...c, features: [{ id: 'f1', name: 'Ember Ward', source: 'subclass' as const, description: '' }] };
    expect(gainedFeatures(FIGHTER, 4, EMBER, ctxOf(withWard), { have: withWard.features, subclassChosenNow: true }).map((f) => f.name)).toEqual([
      'Ability Score Improvement',
      'Kindled Strikes',
    ]);
  });

  it('gives Dusk Domain, chosen at Cleric 3, the features its older book prints at levels 1 and 2', () => {
    const c = hero({ classId: CLERIC.id, name: 'Cleric', level: 2, hitDie: 8, casterType: 'full', spellcastingAbility: 'wis' });
    const gained = gainedFeatures(CLERIC, 3, DUSK, ctxOf(c), { have: c.features, subclassChosenNow: true });
    expect(gained.filter((f) => f.source === 'subclass').map((f) => f.name)).toEqual(['Hearthlight Blessing', 'Channel Divinity: Settling Gloom']);
    expect(DUSK.firstLevel).toBe(1);
    expect(DUSK.source?.adaptations.map((a) => a.code)).toContain('subclass-early-features');
    // Later, only the features of exactly that level arrive.
    expect(gainedFeatures(CLERIC, 6, DUSK, ctxOf(c), { have: c.features }).filter((f) => f.source === 'subclass').map((f) => f.name)).toEqual(['Evening Bell']);
  });
});

describe('subclass spellcasting and refs (SRD 5.2.1 Multiclassing: Spell Slots)', () => {
  const lampKnight: SubclassOption = { ...EMBER, id: 'lib:gloam:subclass:lamp-knight', name: 'Lamp Knight', casterType: 'third', spellcastingAbility: 'int' };

  it('makes a third-caster subclass set its class to a third caster with slots', () => {
    expect(subclassCastingOf(lampKnight)).toEqual({ casterType: 'third', spellcastingAbility: 'int' });
    expect(subclassCastingOf(EMBER)).toBeUndefined();
    const c = hero({ classId: FIGHTER.id, name: 'Fighter', level: 2, hitDie: 10 });
    const r = levelUp(c, {
      className: 'Fighter',
      classId: FIGHTER.id,
      subclass: lampKnight.name,
      subclassId: lampKnight.id,
      subclassRef: subclassRefOf(lampKnight),
      subclassCasting: subclassCastingOf(lampKnight),
      hpMethod: 'average',
    });
    expect(r.character.classes[0]).toMatchObject({ casterType: 'third', spellcastingAbility: 'int', subclassId: lampKnight.id });
    expect(r.character.classes[0].subclassRef).toMatchObject({ entryId: lampKnight.id, kind: 'subclass', textCopied: false, sourceTitle: GLOAMWOOD_TITLE });
    expect(r.character.spellcasting?.slots[1]).toEqual({ max: 2, used: 0 });
  });

  it('gives SRD subclasses no ref', () => {
    expect(subclassRefOf(subOf(FIGHTER, 'Champion'))).toBeUndefined();
  });
});

describe('always-prepared spells of an imported subclass', () => {
  const spell = (id: string, name: string, level: number, extra: Partial<CompendiumEntry> = {}): CompendiumEntry => ({
    id,
    sourceId: id.startsWith('lib:') ? 'gloam' : 'srd-5.2.1',
    sourceName: id.startsWith('lib:') ? GLOAMWOOD_TITLE : 'SRD 5.2.1',
    kind: 'spell',
    name,
    text: '',
    data: { level },
    ...extra,
  });
  const index = [
    spell('srd:spell:faerie-fire', 'Faerie Fire', 1, { data: { level: 1, concentration: true } }),
    spell('srd:spell:sleep', 'Sleep', 1),
    spell('lib:gloam:40', 'Ashen Choir', 2),
    spell('srd:spell:daylight', 'Daylight', 3),
  ];
  const find = (name: string) => index.find((e) => nameKey(e.name) === nameKey(name));

  it('adds the spells of the rows up to the class level, with index ids and refs for imported ones', () => {
    const plan = subclassSpellsToAdd(DUSK, 3, [], find);
    expect(plan.spells.map((s) => [s.id, s.name, s.level, s.alwaysPrepared, s.source])).toEqual([
      ['srd:spell:faerie-fire', 'Faerie Fire', 1, true, 'Dusk Domain'],
      ['srd:spell:sleep', 'Sleep', 1, true, 'Dusk Domain'],
      ['lib:gloam:40', 'Ashen Choir', 2, true, 'Dusk Domain'],
    ]);
    expect(plan.spells[0]).toMatchObject({ concentration: true, prepared: true });
    expect(plan.spells[0].ref).toBeUndefined();
    expect(plan.spells[2].ref).toEqual({ sourceId: 'gloam', sourceTitle: GLOAMWOOD_TITLE, entryId: 'lib:gloam:40', kind: 'spell', entryName: 'Ashen Choir', textHash: '', textCopied: false });
    // Darkness isn't in this index: the DM adds it.
    expect(plan.missing).toEqual(['Darkness']);
  });

  it('skips spells already on the sheet and rows above the class level; SRD subclasses list none', () => {
    expect(subclassSpellsToAdd(DUSK, 1, [{ name: 'Sleep' }], find).spells.map((s) => s.name)).toEqual(['Faerie Fire']);
    expect(subclassSpellsToAdd(subOf(CLERIC, 'Life Domain'), 5, [], find)).toEqual({ spells: [], missing: [] });
  });
});

describe('the Feat choice panel', () => {
  const fighter4 = () => hero({ classId: FIGHTER.id, name: 'Fighter', level: 3, hitDie: 10, subclass: 'Ember Warden', subclassId: EMBER.id });

  /** Level the hero up with the gained features, as the dialog does, and apply a choice. */
  function levelWith(c: Character, cls: ClassOption, choice: FeatChoice) {
    const gained = gainedFeatures(cls, c.classes[0].level + 1, undefined, ctxOf(c), { have: c.features });
    const trigger = featChoiceTrigger(gained) as FeatChoiceTrigger;
    const r = levelUp(c, { className: cls.name, classId: c.classes[0].classId, hpMethod: 'average', newFeatures: gained });
    const before = new Set(c.features.map((f) => f.id));
    const addedIds = new Set(r.character.features.filter((f) => !before.has(f.id)).map((f) => f.id));
    const applied = applyFeatChoice(r.character, trigger, choice, { className: cls.name, classLevel: c.classes[0].level + 1, addedIds });
    return { trigger, leveled: r, ...applied };
  }

  it('is offered at Ability Score Improvement, Epic Boon and Fighting Style levels', () => {
    expect(featChoiceTrigger([{ name: 'Second Wind' }])).toBeNull();
    expect(featChoiceTrigger([{ name: 'Ability Score Improvement' }])).toEqual({ kind: 'asi', featureName: 'Ability Score Improvement' });
    expect(featChoiceTrigger([{ name: 'Epic Boon' }])?.kind).toBe('epic-boon');
    expect(featChoiceTrigger([{ name: "Paladin's Smite" }, { name: 'Fighting Style' }])?.kind).toBe('fighting-style');
  });

  it('offers General feats from every source at Ability Score Improvement, checking only "Level N+"', () => {
    const picks = featChoices('asi', EXPECTED_MERGED.feats, { cls: FIGHTER, characterLevel: 4, have: [] });
    expect(picks.map((p) => p.name)).toEqual(['Grappler', 'Lantern Bearer', 'Watchlight Vigil']);
    const [grappler, lantern, vigil] = picks;
    expect(grappler).toMatchObject({ sourceLabel: 'SRD 5.2.1', prerequisite: 'Level 4+, Strength or Dexterity 13+', minLevel: 4, meetsLevel: true });
    expect(grappler.increase).toEqual({ abilities: ['str', 'dex'], amount: 1, max: 20 });
    expect(lantern).toMatchObject({ sourceLabel: GLOAMWOOD_TITLE, minLevel: 4, meetsLevel: true, increase: { abilities: ['wis', 'cha'], amount: 1, max: 20 } });
    // Level 8+ at level 4: flagged, still offered (the player can say their DM allows it).
    expect(vigil).toMatchObject({ minLevel: 8, meetsLevel: false, taken: false });
  });

  it('offers Epic Boons and General feats at Epic Boon, with the boons’ maximum of 30', () => {
    const picks = featChoices('epic-boon', EXPECTED_MERGED.feats, { cls: FIGHTER, characterLevel: 19, have: [] });
    expect(picks[0]).toMatchObject({ name: 'Boon of Combat Prowess', meetsLevel: true });
    expect(picks[0].increase).toMatchObject({ amount: 1, max: 30 });
    expect(picks[0].increase?.abilities).toHaveLength(6);
    expect(picks.map((p) => p.name)).toContain('Lantern Bearer');
    expect(picks.map((p) => p.name)).not.toContain('Ability Score Improvement');
  });

  it("offers Fighting Style feats plus the class feature's printed option, and marks a taken feat", () => {
    const paladin = classOf('srd:class:paladin');
    const have = [{ name: 'Defense', source: 'feat' as const }];
    const picks = featChoices('fighting-style', EXPECTED_MERGED.feats, { cls: paladin, characterLevel: 2, have });
    expect(picks.map((p) => p.name)).toEqual(['Archery', 'Defense', 'Great Weapon Fighting', 'Two-Weapon Fighting', 'Hooked Reach', 'Blessed Warrior']);
    expect(picks.find((p) => p.name === 'Defense')?.taken).toBe(true);
    expect(picks.at(-1)).toMatchObject({ id: 'inline:blessed-warrior', sourceLabel: 'SRD 5.2.1' });
    expect(picks.at(-1)?.description).toMatch(/^You learn two Cleric cantrips/);
  });

  it('applies +2 to one ability, capped at 20, and names the choice on the sheet (Ability Score Improvement feat)', () => {
    const c = fighter4(); // STR 16
    const { character, warnings, leveled, increases } = levelWith(c, FIGHTER, { kind: 'plus-two', ability: 'str' });
    expect(character.abilityScores.str).toBe(18);
    expect(warnings).toEqual([]);
    expect(increases).toEqual([{ ability: 'str', amount: 2 }]);
    const asi = character.features.filter((f) => nameKey(f.name).startsWith('ability-score-improvement'));
    expect(asi).toHaveLength(1);
    expect(asi[0]).toMatchObject({ name: 'Ability Score Improvement (+2 Strength)', source: 'feat', sourceName: 'Fighter 4' });
    expect(character.hp.max).toBe(leveled.character.hp.max);
  });

  it('B3: names an Ability Score Improvement for what took effect under the cap of 20 (SRD 5.2.1 Ability Score Improvement)', () => {
    const scores = (str: number, dex: number) => ({ str, dex, con: 13, int: 10, wis: 12, cha: 8 });
    // +2 on a 19: only +1 fits, and the sheet, the notice and the summary say +1.
    const nineteen = levelWith({ ...fighter4(), abilityScores: scores(19, 14) }, FIGHTER, { kind: 'plus-two', ability: 'str' });
    expect(nineteen.character.abilityScores.str).toBe(20);
    expect(nineteen.warnings).toEqual(['Strength is capped at 20.']);
    expect(nineteen.increases).toEqual([{ ability: 'str', amount: 1 }]);
    expect(nineteen.character.features.find((f) => f.source === 'feat')?.name).toBe('Ability Score Improvement (+1 Strength)');
    expect(featChoiceNotice({ kind: 'plus-two', ability: 'str' }, nineteen.increases)).toBe('chose: +1 Strength');

    const reminder = 'Fighter 4: Ability Score Improvement — raise one score by 2 or two scores by 1 (max 20), or take another feat you qualify for.';
    // A score already at 20 can't be chosen: nothing is applied, the gained feature and the reminder stay.
    for (const choice of [{ kind: 'plus-two', ability: 'str' }, { kind: 'plus-one-one', abilities: ['str', 'dex'] }] as FeatChoice[]) {
      const at20 = { ...fighter4(), abilityScores: scores(20, 19) };
      expect(featChoiceComplete(choice, at20.abilityScores), choice.kind).toBe(false);
      const out = levelWith(at20, FIGHTER, choice);
      expect(out.character, choice.kind).toBe(out.leveled.character);
      expect(out.increases).toEqual([]);
      expect(out.character.features.map((f) => [f.name, f.source])).toEqual([['Ability Score Improvement', 'class']]);
      expect(out.leveled.reminders).toContain(reminder);
      expect(dropChoiceReminder(out.leveled.reminders, 'asi', choice, out.increases)).toContain(reminder);
      expect(featChoiceNotice(choice, out.increases)).toBeNull();
    }
    // Two abilities with room still work, and a different pair below 20 is complete.
    expect(featChoiceComplete({ kind: 'plus-one-one', abilities: ['dex', 'con'] }, scores(20, 19))).toBe(true);
  });

  it('applies +1 to two abilities; a Constitution increase raises HP for every level', () => {
    const c = fighter4(); // CON 13 → 14: +1 modifier at character level 4
    const { character, leveled } = levelWith(c, FIGHTER, { kind: 'plus-one-one', abilities: ['str', 'con'] });
    expect(character.abilityScores).toMatchObject({ str: 17, con: 14 });
    expect(character.hp.max).toBe(leveled.character.hp.max + 4);
    expect(character.features.find((f) => f.source === 'feat')?.name).toBe('Ability Score Improvement (+1 Strength, +1 Constitution)');
  });

  it("takes a feat in the gained feature's place, with the book's text, its ref and its increase", () => {
    const lantern = featChoices('asi', EXPECTED_MERGED.feats, { cls: FIGHTER, characterLevel: 4, have: [] }).find((p) => p.name === 'Lantern Bearer')!;
    const { character } = levelWith(fighter4(), FIGHTER, { kind: 'feat', pick: lantern, ability: 'wis' });
    expect(character.abilityScores.wis).toBe(13);
    expect(character.features.some((f) => f.name === 'Ability Score Improvement')).toBe(false);
    const feat = character.features.find((f) => f.name === 'Lantern Bearer');
    expect(feat).toMatchObject({ source: 'feat', sourceName: 'Ability Score Improvement (Fighter 4)', description: TEXT.lanternBearer.join('\n\n') });
    expect(feat?.ref).toMatchObject({ kind: 'feat', entryName: 'Lantern Bearer', textCopied: true });
  });

  it('lets an unmet "Level 8+" feat be taken at level 4 (the DM allows it)', () => {
    const vigil = featChoices('asi', EXPECTED_MERGED.feats, { cls: FIGHTER, characterLevel: 4, have: [] }).find((p) => p.name === 'Watchlight Vigil')!;
    expect(vigil.meetsLevel).toBe(false);
    const { character } = levelWith(fighter4(), FIGHTER, { kind: 'feat', pick: vigil });
    expect(character.features.map((f) => f.name)).toContain('Watchlight Vigil');
  });

  it('changes nothing with "Decide with my DM", and keeps the matching reminder', () => {
    const { character, leveled } = levelWith(fighter4(), FIGHTER, { kind: 'dm' });
    expect(character).toBe(leveled.character);
    const reminders = ['Fighter 4: Ability Score Improvement — raise one score by 2 or two scores by 1 (max 20), or take another feat you qualify for.', 'Proficiency Bonus is now +2.'];
    expect(dropChoiceReminder(reminders, 'asi', { kind: 'dm' })).toEqual(reminders);
    expect(dropChoiceReminder(reminders, 'asi', { kind: 'plus-two', ability: 'str' })).toEqual(['Proficiency Bonus is now +2.']);
    expect(featChoiceNotice({ kind: 'dm' })).toBeNull();
  });

  it('names the choice for the DM notice (names only)', () => {
    const picks = featChoices('asi', EXPECTED_MERGED.feats, { cls: FIGHTER, characterLevel: 4, have: [] });
    expect(featChoiceNotice({ kind: 'plus-two', ability: 'str' })).toBe('chose: +2 Strength');
    expect(featChoiceNotice({ kind: 'plus-one-one', abilities: ['wis', 'cha'] })).toBe('chose: +1 Wisdom, +1 Charisma');
    expect(featChoiceNotice({ kind: 'feat', pick: picks[1], ability: 'wis' })).toBe('feat: Lantern Bearer (The Gloamwood Almanac)');
    expect(featChoiceNotice({ kind: 'feat', pick: picks[0], ability: 'str' })).toBe('feat: Grappler');
  });

  it('reads an SRD feat’s increase from its text when it has no structured field', () => {
    expect(featIncrease({ description: 'You gain the following benefits.\n\n_**Ability Score Increase.**_ Increase your Strength or Dexterity score by 1, to a maximum of 20.' })).toEqual({
      abilities: ['str', 'dex'],
      amount: 1,
      max: 20,
    });
    expect(featIncrease({ description: 'You can stay awake through the night.' })).toBeUndefined();
  });
});
