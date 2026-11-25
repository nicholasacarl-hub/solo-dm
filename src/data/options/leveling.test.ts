/**
 * Level-up from the merged builder data (spec §5.4), against the real engine and the invented Gloamwood
 * fixture: features gained per level and caught up when a subclass is chosen (SRD 5.2.1 "Level
 * Advancement"), a third-caster subclass's spellcasting ("Multiclassing: Spell Slots"), an imported
 * subclass's always-prepared spells, and the Feat choice panel ("Ability Score Improvement" feat; feat
 * prerequisites: only "Level N+" is checked).
 */
import { describe, expect, it } from 'vitest';
import { characterLevel, characterSheetText, computeArmorClass, levelUp } from '@/engine';
import { nameKey } from '@/lib/id';
import { sampleCharacter } from '@/test/fixtures';
import { EXPECTED_MERGED, GLOAMWOOD_TITLE, SRD_BUILDER_DATA, TEXT } from '@/test/structuredFixtures';
import { HOMEBREW_SOURCE_ID, type Character, type ClassFeatureDef, type ClassLevel, type ClassOption, type CompendiumEntry, type FeatOption, type Feature, type OptionSource, type SubclassOption } from '@/types';
import { featureUseChanges, gainedFeatures, keptRulings } from './leveling';
import {
  applyFeatChoice,
  caughtUpFeatures,
  dropChoiceReminder,
  featChoiceComplete,
  featChoiceNotice,
  featChoices,
  featChoiceTrigger,
  featIncrease,
  hasFightingStyleFeature,
  subclassCastingOf,
  subclassFightingStyle,
  subclassRefOf,
  type FeatChoice,
  type FeatChoiceContext,
  type FeatChoiceTrigger,
  type FeatPick,
} from './levelUpChoices';
import { alwaysPreparedGained, applyAlwaysPrepared } from './spellPicks';

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

  const cleric = (level: number, extra: Partial<Character> = {}) => hero({ classId: CLERIC.id, name: 'Cleric', level, hitDie: 8, casterType: 'full', spellcastingAbility: 'wis' }, extra);

  it('adds the spells of the rows up to the class level, with index ids and refs for imported ones', () => {
    const plan = alwaysPreparedGained(cleric(3), CLERIC, DUSK, 3, find);
    expect(plan.add.map((s) => [s.id, s.name, s.level, s.alwaysPrepared, s.source])).toEqual([
      ['srd:spell:faerie-fire', 'Faerie Fire', 1, true, 'Dusk Domain'],
      ['srd:spell:sleep', 'Sleep', 1, true, 'Dusk Domain'],
      ['lib:gloam:40', 'Ashen Choir', 2, true, 'Dusk Domain'],
    ]);
    expect(plan.add[0]).toMatchObject({ concentration: true, prepared: true });
    expect(plan.add[0].ref).toBeUndefined();
    expect(plan.add[2].ref).toEqual({ sourceId: 'gloam', sourceTitle: GLOAMWOOD_TITLE, entryId: 'lib:gloam:40', kind: 'spell', entryName: 'Ashen Choir', textHash: '', textCopied: false });
    // Darkness isn't in this index: the DM adds it.
    expect(plan.missing).toEqual([{ name: 'Darkness', source: 'Dusk Domain' }]);
  });

  it('leaves rows above the class level, and turns a row spell the hero picked always prepared', () => {
    // SRD 5.2.1 srd:rule:gaining-spells: "a spell that you always have prepared doesn't count against the number of
    // spells on that list" — the picked Sleep becomes the subclass's, by its own id.
    const picked = cleric(1, { spellcasting: { ability: 'wis', slots: {}, spells: [{ id: 'my-sleep', name: 'Sleep', level: 1, prepared: true, source: 'Cleric' }], concentratingOn: null } });
    const plan = alwaysPreparedGained(picked, CLERIC, DUSK, 1, find);
    expect(plan.add.map((s) => s.name)).toEqual(['Faerie Fire']);
    // It leaves the Cleric's list (the class its source names), which owes that place again.
    expect(plan.flip).toEqual([{ id: 'my-sleep', name: 'Sleep', source: 'Dusk Domain', owner: 'Cleric', counted: true }]);
  });

  it("gives a spell the lookup finds in homebrew its entry's id as homebrewId, which the sheet tags", () => {
    // The level-up lookups rank the campaign's homebrew first, so a name the subclass lists can be a homebrew spell.
    const veil: CompendiumEntry = { ...spell('hb:gloaming-veil', 'Gloaming Veil', 1), sourceId: HOMEBREW_SOURCE_ID, sourceName: 'Homebrew' };
    const withVeil: SubclassOption = { ...DUSK, alwaysPreparedSpells: [{ level: 1, spells: ['Faerie Fire', 'Gloaming Veil'] }] };
    const plan = alwaysPreparedGained(cleric(1), CLERIC, withVeil, 1, (name) => (nameKey(name) === nameKey(veil.name) ? veil : find(name)));
    expect(plan.add.map((s) => [s.id, s.homebrewId])).toEqual([
      ['srd:spell:faerie-fire', undefined],
      ['hb:gloaming-veil', 'hb:gloaming-veil'],
    ]);
    expect(plan.add[0]).not.toHaveProperty('homebrewId');
    const sheet = applyAlwaysPrepared(cleric(1), plan);
    expect(characterSheetText(sheet).split('\n')).toContain('- Level 1: Faerie Fire (C, always prepared, Dusk Domain), Gloaming Veil (always prepared, Dusk Domain, homebrew)');
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
    const picks = featChoices('asi', EXPECTED_MERGED.feats, { cls: FIGHTER, characterLevel: 4, have: [] }).filter((p) => p.category === 'general');
    expect(picks.map((p) => p.name)).toEqual(['Grappler', 'Lantern Bearer', 'Watchlight Vigil']);
    const [grappler, lantern, vigil] = picks;
    expect(grappler).toMatchObject({ sourceLabel: 'SRD 5.2.1', prerequisite: 'Level 4+, Strength or Dexterity 13+', minLevel: 4, meetsLevel: true });
    expect(grappler.increase).toEqual({ abilities: ['str', 'dex'], amount: 1, max: 20 });
    expect(lantern).toMatchObject({ sourceLabel: GLOAMWOOD_TITLE, minLevel: 4, meetsLevel: true, increase: { abilities: ['wis', 'cha'], amount: 1, max: 20 } });
    // Level 8+ at level 4: flagged, still offered (the player can say their DM allows it).
    expect(vigil).toMatchObject({ minLevel: 8, meetsLevel: false, taken: false });
  });

  describe('every feat the hero qualifies for at Ability Score Improvement and Epic Boon (SRD 5.2.1 Fighter 4, 19: "or another feat of your choice for which you qualify")', () => {
    const names = (picks: readonly FeatPick[]) => picks.map((p) => p.name);
    const GENERAL = ['Grappler', 'Lantern Bearer', 'Watchlight Vigil'];
    // SRD 5.2.1 Feats: Origin feats have no prerequisite.
    const ORIGIN = ['Alert', 'Magic Initiate', 'Savage Attacker', 'Skilled', "Moth's Grace"];
    const STYLES = ['Archery', 'Defense', 'Great Weapon Fighting', 'Two-Weapon Fighting', 'Hooked Reach'];
    const BOONS = [
      'Boon of Combat Prowess',
      'Boon of Dimensional Travel',
      'Boon of Fate',
      'Boon of Irresistible Offense',
      'Boon of Spell Recall',
      'Boon of the Night Spirit',
      'Boon of Truesight',
    ];
    const STYLE_FEATURE = { name: 'Fighting Style', source: 'class' as const };
    const panel = (kind: 'asi' | 'epic-boon', characterLevel: number, have: FeatChoiceContext['have'] = []) =>
      featChoices(kind, EXPECTED_MERGED.feats, { cls: FIGHTER, characterLevel, have });

    it('offers Origin feats beside the General feats, each with its category', () => {
      const picks = panel('asi', 4);
      expect(names(picks)).toEqual([...GENERAL, ...ORIGIN]);
      expect(picks.map((p) => p.category)).toEqual([...GENERAL.map(() => 'general'), ...ORIGIN.map(() => 'origin')]);
      expect(picks.find((p) => p.name === 'Alert')).toMatchObject({ sourceLabel: 'SRD 5.2.1', meetsLevel: true, taken: false });
      expect(picks.find((p) => p.name === 'Alert')).not.toHaveProperty('minLevel');
    });

    it('offers Fighting Style feats only with a Fighting Style feature (Prerequisite: Fighting Style Feature)', () => {
      expect(names(panel('asi', 6, [STYLE_FEATURE]))).toEqual([...GENERAL, ...ORIGIN, ...STYLES]);
      expect(names(panel('epic-boon', 19, [STYLE_FEATURE]))).toEqual([...BOONS, ...GENERAL, ...ORIGIN, ...STYLES]);
      // A Wizard's Ability Score Improvement: none.
      expect(names(panel('asi', 4, [{ name: 'Arcane Recovery', source: 'class' }]))).toEqual([...GENERAL, ...ORIGIN]);
      // A style the class prints isn't a feat: never at an Ability Score Improvement.
      const paladin = featChoices('asi', EXPECTED_MERGED.feats, { cls: classOf('srd:class:paladin'), characterLevel: 4, have: [STYLE_FEATURE] });
      expect(paladin.every((p) => p.feat)).toBe(true);
      expect(names(paladin)).not.toContain('Blessed Warrior');
    });

    it('offers Epic Boons at an Ability Score Improvement from level 19 (Prerequisite: Level 19+), and every category at Epic Boon', () => {
      expect(names(panel('asi', 18))).toEqual([...GENERAL, ...ORIGIN]);
      // A Rogue 4 with 15 Fighter levels: character level 19.
      const at19 = panel('asi', 19);
      expect(names(at19)).toEqual([...GENERAL, ...ORIGIN, ...BOONS]);
      expect(at19.find((p) => p.name === 'Boon of Fate')).toMatchObject({ category: 'epic-boon', minLevel: 19, meetsLevel: true });
      expect(names(panel('epic-boon', 19))).toEqual([...BOONS, ...GENERAL, ...ORIGIN]);
    });

    it("marks an Origin feat the sheet holds taken, unless Repeatable (Magic Initiate, Skilled); a style as the engine reads it", () => {
      // The background's Alert and Magic Initiate, the species' Skilled (the builder adds them as feats).
      const have: FeatChoiceContext['have'] = [
        { name: 'Alert', source: 'feat' },
        { name: 'Magic Initiate', source: 'feat' },
        { name: 'Skilled', source: 'feat' },
        STYLE_FEATURE,
        // An older sheet's style under the feature's name: the Defense feat is that style; a boon's "Archery" isn't.
        { name: 'Fighting Style (Defense)', source: 'class' },
        { name: 'Archery', source: 'boon' },
      ];
      for (const kind of ['asi', 'epic-boon'] as const) {
        expect(
          panel(kind, 19, have)
            .filter((p) => p.taken)
            .map((p) => p.name),
          kind,
        ).toEqual(['Alert', 'Defense']);
      }
    });
  });

  it("reads a Fighting Style feature however the sheet names it, from a class, subclass or the DM's own entry (SRD 5.2.1 Feats: Fighting Style Feature)", () => {
    const has = (name: string, source: Feature['source']) => hasFightingStyleFeature([{ name, source }]);
    for (const name of ['Fighting Style', 'Fighting Style (Defense)', 'Fighting Style: Defense', 'Additional Fighting Style', 'Fighting Styles']) {
      expect(has(name, 'class'), name).toBe(true);
    }
    for (const source of ['subclass', 'homebrew', 'other'] as const) expect(has('Fighting Style', source), source).toBe(true);
    // A feat, species trait, transformation's power or a boon's, item's or background's feature of the name isn't one…
    for (const source of ['feat', 'species', 'transformation', 'boon', 'item', 'background'] as const) expect(has('Fighting Style', source), source).toBe(false);
    // …nor a style, or another feature with the words.
    for (const name of ['Defense', 'Fighting Spirit', 'Martial Fighting Style']) expect(has(name, 'class'), name).toBe(false);
    expect(hasFightingStyleFeature([])).toBe(false);
  });

  it("marks a feat taken that the sheet holds as a feat or as the DM's entry of its name, not a trait's or a transformation's (SRD 5.2.1 Feats: once, unless Repeatable)", () => {
    const taken = (source: Feature['source'], feats: readonly FeatOption[] = EXPECTED_MERGED.feats) =>
      featChoices('asi', feats, { cls: FIGHTER, characterLevel: 4, have: [{ name: 'Grappler', source }] }).find((p) => p.name === 'Grappler')?.taken;
    // A feat, or the one feature addFeature keeps of it and the DM's boon's, background's, item's, homebrew or other entry.
    for (const source of ['feat', 'boon', 'background', 'item', 'homebrew', 'other'] as const) expect(taken(source), source).toBe(true);
    // A species trait or class feature of its name stays beside the feat; a transformation's power goes when it ends.
    for (const source of ['species', 'class', 'subclass', 'transformation'] as const) expect(taken(source), source).toBe(false);
    const repeatable = EXPECTED_MERGED.feats.map((f) => (f.name === 'Grappler' ? { ...f, repeatable: true } : f));
    expect(taken('boon', repeatable)).toBe(false);
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
    expect(picks.at(-1)).toMatchObject({ id: 'inline:blessed-warrior', sourceLabel: 'SRD 5.2.1', category: 'fighting-style' });
    expect(picks.at(-1)?.description).toMatch(/^You learn two Cleric cantrips/);
  });

  it("is offered at the Champion's Additional Fighting Style and adds the style beside it (SRD 5.2.1 Champion, level 7)", () => {
    const champion = subOf(FIGHTER, 'Champion');
    const defense = { id: 'f-defense', name: 'Defense', source: 'feat' as const, sourceName: 'Fighting Style (Fighter 1)', description: '' };
    const c = hero({ classId: FIGHTER.id, name: 'Fighter', level: 6, hitDie: 10, subclass: 'Champion', subclassId: champion.id }, { features: [defense] });
    const gained = gainedFeatures(FIGHTER, 7, champion, ctxOf(c), { have: c.features });
    const trigger = featChoiceTrigger(gained) as FeatChoiceTrigger;
    expect(trigger).toEqual({ kind: 'fighting-style', featureName: 'Additional Fighting Style', source: 'subclass' });
    const picks = featChoices(trigger.kind, EXPECTED_MERGED.feats, { cls: FIGHTER, characterLevel: 7, have: c.features });
    expect(picks.find((p) => p.name === 'Defense')?.taken).toBe(true);
    const archery = picks.find((p) => p.name === 'Archery')!;
    const leveled = levelUp(c, { className: 'Fighter', classId: FIGHTER.id, hpMethod: 'average', newFeatures: gained });
    const before = new Set(c.features.map((f) => f.id));
    const addedIds = new Set(leveled.character.features.filter((f) => !before.has(f.id)).map((f) => f.id));
    const choice: FeatChoice = { kind: 'feat', pick: archery };
    const { character } = applyFeatChoice(leveled.character, trigger, choice, { className: 'Fighter', classLevel: 7, addedIds });
    expect(character.features.map((f) => [f.name, f.source, f.sourceName])).toEqual([
      ['Defense', 'feat', 'Fighting Style (Fighter 1)'],
      ['Additional Fighting Style', 'subclass', 'Champion 7'],
      ['Archery', 'feat', 'Additional Fighting Style (Fighter 7)'],
    ]);
    // The engine's reminder of the choice goes once it's made.
    const reminder = 'Fighter 7: Additional Fighting Style — choose another Fighting Style.';
    expect(leveled.reminders).toContain(reminder);
    expect(dropChoiceReminder(leveled.reminders, trigger.kind, choice)).not.toContain(reminder);
  });

  it('never merges a feat into another feature of its name: completes the one the level-up added, else adds one', () => {
    const lantern = featChoices('asi', EXPECTED_MERGED.feats, { cls: FIGHTER, characterLevel: 4, have: [] }).find((p) => p.name === 'Lantern Bearer')!;
    const trait = { id: 't-lantern', name: 'Lantern Bearer', source: 'species' as const, description: 'Invented: a moth-folk trait of the same name.' };
    const c = { ...fighter4(), features: [trait] };
    const choice: FeatChoice = { kind: 'feat', pick: lantern, ability: 'wis' };
    const named = (x: Character) => x.features.filter((f) => f.name === 'Lantern Bearer');
    // Not given to levelUp: a new feature beside the trait, or beside an earlier taking of the feat (a Repeatable one).
    const plain = levelWith(c, FIGHTER, choice).character;
    expect(named(plain)).toEqual([trait, expect.objectContaining({ source: 'feat', ref: expect.objectContaining({ entryName: 'Lantern Bearer' }) })]);
    const earlier = { id: 'f-earlier', name: 'Lantern Bearer', source: 'feat' as const, sourceName: 'Ability Score Improvement (Fighter 4)', description: lantern.description, uses: { max: 2, used: 1, recharge: 'long' as const } };
    const again = levelWith({ ...fighter4(), features: [earlier] }, FIGHTER, choice).character;
    expect(named(again)).toEqual([earlier, expect.objectContaining({ source: 'feat', sourceName: 'Ability Score Improvement (Fighter 4)' })]);
    expect(named(again)[1].id).not.toBe(earlier.id);
    // Given to levelUp (the dialog): that feature is the one completed, its id kept.
    const gained = gainedFeatures(FIGHTER, 4, undefined, ctxOf(c), { have: c.features });
    const leveled = levelUp(c, { className: 'Fighter', classId: FIGHTER.id, hpMethod: 'average', newFeatures: [...gained, { name: lantern.name, source: 'feat', description: lantern.description }] }).character;
    const addedIds = new Set(leveled.features.filter((f) => f.id !== trait.id).map((f) => f.id));
    const bare = leveled.features.find((f) => f.source === 'feat' && f.name === 'Lantern Bearer')!;
    const done = applyFeatChoice(leveled, featChoiceTrigger(gained) as FeatChoiceTrigger, choice, { className: 'Fighter', classLevel: 4, addedIds }).character;
    expect(named(done)).toEqual([trait, expect.objectContaining({ id: bare.id, sourceName: 'Ability Score Improvement (Fighter 4)', ref: expect.objectContaining({ entryName: 'Lantern Bearer' }) })]);
  });

  it("marks a style already on the sheet taken, a feat or a style the class prints (SRD 5.1 Fighting Style: an option can't be taken twice)", () => {
    const paladin = classOf('srd:class:paladin');
    const taken = (have: { name: string; source: Feature['source'] }[], feats: readonly FeatOption[] = EXPECTED_MERGED.feats) =>
      featChoices('fighting-style', feats, { cls: paladin, characterLevel: 7, have })
        .filter((p) => p.taken)
        .map((p) => p.name);
    // The builder's or an earlier level's: a feat, or a style the class prints (a class feature of its name).
    expect(taken([{ name: 'Archery', source: 'feat' }, { name: 'Blessed Warrior', source: 'class' }])).toEqual(['Archery', 'Blessed Warrior']);
    // An older book's printed Defense on the sheet: the Defense feat is that style.
    expect(taken([{ name: 'Defense', source: 'class' }])).toEqual(['Defense']);
    // However the DM named it and whichever feature it went under, as the engine's Defense AC reads it.
    for (const name of ['Fighting Style (Defense)', 'Fighting Style: Defense', 'Defense Fighting Style', 'Additional Fighting Style (Defense)', 'Defense (Fighter 1)']) {
      expect(taken([{ name, source: 'class' }])).toEqual(['Defense']);
    }
    expect(taken([{ name: 'Additional Fighting Style (Defense)', source: 'subclass' }])).toEqual(['Defense']);
    expect(taken([{ name: 'Great Weapon Fighting Style', source: 'other' }])).toEqual(['Great Weapon Fighting']);
    // A species trait of a style's name isn't the style; a Repeatable style can be taken again.
    expect(taken([{ name: 'Defense', source: 'species' }])).toEqual([]);
    const repeatable = EXPECTED_MERGED.feats.map((f) => (f.name === 'Defense' ? { ...f, repeatable: true } : f));
    expect(taken([{ name: 'Defense', source: 'feat' }], repeatable)).toEqual([]);
    // One rule with the Defense AC (SRD 5.2.1 Defense: +1 AC in armor): whatever the entry's source, the style is taken
    // exactly when the AC counts it, so a boon's, item's or background's "Defense" leaves the feat that raises it open.
    const mail = sampleCharacter({ inventory: [{ id: 'mail', name: 'Chain Mail', quantity: 1, category: 'armor', equipped: true }] });
    const sources: Feature['source'][] = ['class', 'subclass', 'species', 'background', 'feat', 'boon', 'transformation', 'item', 'homebrew', 'other'];
    const ac = (features: Feature[]) => computeArmorClass({ ...mail, features }).ac;
    const counted = sources.filter((source) => ac([{ id: 'd', name: 'Defense', source, description: '' }]) > ac([]));
    expect(counted).toEqual(['class', 'subclass', 'feat', 'homebrew', 'other']);
    for (const source of sources) expect(taken([{ name: 'Defense', source }]), source).toEqual(counted.includes(source) ? ['Defense'] : []);
    // A style feat a book names "Fighting Style: …" itself is taken under that name too (invented).
    const hooked = EXPECTED_MERGED.feats.find((f) => f.name === 'Hooked Reach')!;
    for (const name of ['Fighting Style: Lantern Guard', 'Additional Fighting Style: Lantern Guard', 'Fighting Style Feat: Lantern Guard']) {
      const feat: FeatOption = { ...hooked, id: `lib:gloam:feat:${nameKey(name)}`, name };
      expect(taken([{ name, source: 'feat' }], [...EXPECTED_MERGED.feats, feat]), name).toEqual([name]);
      expect(taken([{ name: `Fighting Style (${name})`, source: 'other' }], [...EXPECTED_MERGED.feats, feat]), name).toEqual([name]);
    }
    // A book's style with a style suffix is the style the sheet has (as the Defense AC reads it), either way round.
    const suffixed: FeatOption = { ...hooked, id: 'lib:gloam:feat:defense-fighting-style', name: 'Defense Fighting Style' };
    expect(taken([{ name: 'Defense', source: 'feat' }], [...EXPECTED_MERGED.feats, suffixed])).toEqual(['Defense', 'Defense Fighting Style']);
    expect(taken([{ name: 'Defense Fighting Style', source: 'feat' }], [...EXPECTED_MERGED.feats, suffixed])).toEqual(['Defense', 'Defense Fighting Style']);
  });

  describe("a subclass's own Fighting Style that prints its styles (an older book's subclass)", () => {
    // An invented book subclass of the SRD Fighter whose level-3 Fighting Style lists two styles of its own.
    const guard = 'While you hold your lantern aloft, the first attack against you each round has Disadvantage.';
    const lash = 'Your wick cracks like a whip, and a creature it hits drops one object it holds.';
    const style: ClassFeatureDef = {
      level: 3,
      name: 'Fighting Style',
      description: ['Choose one of the options below.', `***Lantern Guard.*** ${guard}`, `***Wick Lash.*** ${lash}`].join('\n\n'),
      ref: { ...EMBER.features[0].ref!, entryId: 'lib:gloam:subclass:lamp-sentinel', entryName: 'Lamp Sentinel', part: 'Fighting Style' },
    };
    const sentinel: SubclassOption = { ...EMBER, id: 'lib:gloam:subclass:lamp-sentinel', name: 'Lamp Sentinel', features: [style] };
    const fighter3 = hero({ classId: FIGHTER.id, name: 'Fighter', level: 2, hitDie: 10 });
    const gained = gainedFeatures(FIGHTER, 3, sentinel, ctxOf(fighter3), { have: [], subclassChosenNow: true });

    it('offers its styles, each with the subclass feature narrowed to it, beside the Fighting Style feats and in place of the class’s', () => {
      const trigger = featChoiceTrigger(gained);
      expect(trigger).toEqual({ kind: 'fighting-style', featureName: 'Fighting Style', source: 'subclass' });
      const subclassStyle = subclassFightingStyle(trigger, sentinel);
      expect(subclassStyle).toEqual({ sub: sentinel, def: style });
      // A Paladin's class prints Blessed Warrior: the subclass's own list stands in for it.
      const picks = featChoices('fighting-style', EXPECTED_MERGED.feats, { cls: classOf('srd:class:paladin'), characterLevel: 3, have: [], subclassStyle });
      expect(picks.filter((p) => !p.feat).map((p) => [p.name, p.printedBy, p.sourceLabel])).toEqual([
        ['Lantern Guard', 'subclass', GLOAMWOOD_TITLE],
        ['Wick Lash', 'subclass', GLOAMWOOD_TITLE],
      ]);
      expect(picks.find((p) => p.name === 'Lantern Guard')).toMatchObject({ description: guard, ref: { kind: 'subclass', entryId: sentinel.id, part: 'Lantern Guard', textCopied: true } });
      expect(picks.filter((p) => p.feat).map((p) => p.name)).toContain('Defense');
      // Without it, the class's (as before).
      expect(featChoices('fighting-style', EXPECTED_MERGED.feats, { cls: classOf('srd:class:paladin'), characterLevel: 3, have: [] }).filter((p) => !p.feat).map((p) => [p.name, p.printedBy])).toEqual([['Blessed Warrior', 'class']]);
    });

    it("arrives though a multiclass hero's other subclass has a feature of its name; this subclass's own, or the DM's, is skipped (SRD 5.2.1 Level Advancement)", () => {
      // The hero's Paladin took the invented Oath of the Wick, whose own feature is named Fighting Style too.
      const other = { name: 'Fighting Style', source: 'subclass' as const, sourceName: 'Oath of the Wick 3' };
      const otherSubclasses = ['Oath of the Wick'];
      const names = (have: { name: string; source: 'subclass'; sourceName: string }[]) =>
        gainedFeatures(FIGHTER, 3, sentinel, ctxOf(fighter3), { have, subclassChosenNow: true, otherSubclasses }).filter((f) => f.source === 'subclass').map((f) => f.name);
      expect(names([other])).toEqual(['Fighting Style']);
      expect(featChoiceTrigger(gainedFeatures(FIGHTER, 3, sentinel, ctxOf(fighter3), { have: [other], subclassChosenNow: true, otherSubclasses }))?.source).toBe('subclass');
      // This subclass's own, under its name or an earlier one (renamed in review since), and the DM's: already there.
      for (const sourceName of ['Lamp Sentinel 3', 'Lamp Warden 3', 'Granted in play']) expect(names([{ ...other, sourceName }]), sourceName).toEqual([]);
      // The "caught up" note reads it alike (a subclass chosen late, at Fighter 4).
      expect(caughtUpFeatures(sentinel, 4, [other], otherSubclasses).map((d) => d.name)).toEqual(['Fighting Style']);
      expect(caughtUpFeatures(sentinel, 4, [{ ...other, sourceName: 'Lamp Warden 3' }], otherSubclasses)).toEqual([]);
    });

    it("is none for the class's Fighting Style, a subclass's that prints none, or another kind of choice", () => {
      const champion = subOf(FIGHTER, 'Champion');
      expect(subclassFightingStyle({ kind: 'fighting-style', featureName: 'Additional Fighting Style', source: 'subclass' }, champion)).toBeUndefined();
      expect(subclassFightingStyle({ kind: 'fighting-style', featureName: 'Fighting Style', source: 'class' }, sentinel)).toBeUndefined();
      expect(subclassFightingStyle({ kind: 'asi', featureName: 'Fighting Style', source: 'subclass' }, sentinel)).toBeUndefined();
      expect(subclassFightingStyle({ kind: 'fighting-style', featureName: 'Fighting Style', source: 'subclass' }, undefined)).toBeUndefined();
    });

    it('adds the chosen style beside the Fighting Style as the subclass’s feature, named for it, and marks it taken later', () => {
      const leveled = levelUp(fighter3, { className: 'Fighter', classId: FIGHTER.id, hpMethod: 'average', subclass: sentinel.name, subclassId: sentinel.id, newFeatures: gained }).character;
      const addedIds = new Set(leveled.features.map((f) => f.id));
      const trigger = featChoiceTrigger(gained) as FeatChoiceTrigger;
      const subclassStyle = subclassFightingStyle(trigger, sentinel);
      const pick = featChoices('fighting-style', EXPECTED_MERGED.feats, { cls: FIGHTER, characterLevel: 3, have: [], subclassStyle }).find((p) => p.name === 'Wick Lash')!;
      const done = applyFeatChoice(leveled, trigger, { kind: 'feat', pick }, { className: 'Fighter', classLevel: 3, addedIds, subclassName: sentinel.name }).character;
      const own = done.features.filter((f) => f.source === 'subclass');
      expect(own.map((f) => [f.name, f.sourceName])).toEqual([
        ['Fighting Style', 'Lamp Sentinel 3'],
        ['Wick Lash', 'Fighting Style (Lamp Sentinel 3)'],
      ]);
      expect(own[1]).toMatchObject({ description: lash, ref: { kind: 'subclass', part: 'Wick Lash', textCopied: true } });
      // As a class's printed style would be: on the sheet, it can't be taken again.
      expect(featChoices('fighting-style', EXPECTED_MERGED.feats, { cls: FIGHTER, characterLevel: 7, have: done.features, subclassStyle }).find((p) => p.name === 'Wick Lash')?.taken).toBe(true);
    });
  });

  it("offers a 2024 book's feat in place of the SRD feat of its name (the picked one stays); an older book's sits beside it", () => {
    const grappler = EXPECTED_MERGED.feats.find((f) => f.id === 'srd:feat:grappler') as FeatOption;
    const lantern = EXPECTED_MERGED.feats.find((f) => f.name === 'Lantern Bearer') as FeatOption;
    const book = (format: '2024' | '2014'): FeatOption => ({ ...lantern, id: 'lib:gloam:feat:grappler', name: 'Grappler', source: { ...(lantern.source as OptionSource), format } });
    const asi = (feats: FeatOption[], keepId?: string) => featChoices('asi', feats, { cls: FIGHTER, characterLevel: 4, have: [], ...(keepId ? { keepId } : {}) });
    const grapplers = (picks: { id: string; name: string }[]) => picks.filter((p) => p.name === 'Grappler').map((p) => p.id);
    expect(grapplers(asi([...EXPECTED_MERGED.feats, book('2024')]))).toEqual(['lib:gloam:feat:grappler']);
    expect(grapplers(asi([...EXPECTED_MERGED.feats, book('2024')], grappler.id))).toEqual([grappler.id, 'lib:gloam:feat:grappler']);
    expect(grapplers(asi([...EXPECTED_MERGED.feats, book('2014')]))).toEqual([grappler.id, 'lib:gloam:feat:grappler']);
    // A Fighting Style: the book's Archery stands in for the SRD's.
    const archery: FeatOption = { ...book('2024'), id: 'lib:gloam:feat:archery', name: 'Archery', category: 'fighting-style' };
    const styles = featChoices('fighting-style', [...EXPECTED_MERGED.feats, archery], { cls: FIGHTER, characterLevel: 2, have: [] });
    expect(styles.filter((p) => p.name === 'Archery').map((p) => p.id)).toEqual([archery.id]);
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

describe('featureUseChanges: the uses a level-up changed', () => {
  it('tells apart two of one name that both grew, as features_use names them (SRD 5.2.1 Feats: Repeatable)', () => {
    const taking = (id: string, level: number, max: number): Feature => ({
      id,
      name: 'Wick Tender',
      source: 'feat',
      sourceName: `Ability Score Improvement (Fighter ${level})`,
      description: 'Invented feat.',
      uses: { max, used: 0, recharge: 'long' },
    });
    const rage: Feature = { id: 'rage', name: 'Rage', source: 'class', description: '', uses: { max: 2, used: 0, recharge: 'long' } };
    const before = sampleCharacter({ features: [taking('a', 4, 3), taking('b', 8, 3), rage] });
    const after = { ...before, features: [taking('a', 4, 4), taking('b', 8, 4), { ...rage, uses: { ...rage.uses!, max: 3 } }] };
    expect(featureUseChanges(before, after)).toEqual(['Wick Tender (Ability Score Improvement (Fighter 4)) 3 → 4', 'Wick Tender (Ability Score Improvement (Fighter 8)) 3 → 4', 'Rage 2 → 3']);
    // Only one of them grew: its name alone.
    const one = { ...before, features: [taking('a', 4, 4), taking('b', 8, 3), rage] };
    expect(featureUseChanges(before, one)).toEqual(['Wick Tender 3 → 4']);
  });
});

describe('keptRulings: the numbers of uses the DM ruled, which level-ups keep', () => {
  it('names each ruled feature with its number, namesakes told apart as features_use takes them, and none when it ruled none', () => {
    const luck = (id: string, source: Feature['source'], max: number, ruled?: boolean): Feature => ({
      id,
      name: 'Lantern Luck',
      source,
      sourceName: 'Granted in play',
      description: 'Invented.',
      uses: { max, used: 0, recharge: 'long', ...(ruled ? { ruled } : {}) },
    });
    const wind: Feature = { id: 'wind', name: 'Second Wind', source: 'class', sourceName: 'Fighter 1', description: '', uses: { max: 4, used: 1, recharge: 'short', ruled: true } };
    expect(keptRulings(sampleCharacter({ features: [luck('a', 'species', 2), luck('b', 'feat', 1)] }))).toBeNull();
    expect(keptRulings(sampleCharacter({ features: [wind, luck('a', 'species', 2)] }))).toBe('kept your ruling: Second Wind 4 uses (a new uses_max in features_add changes it)');
    expect(keptRulings(sampleCharacter({ features: [luck('a', 'species', 2, true), luck('b', 'feat', 1, true)] }))).toBe(
      'kept your rulings: Lantern Luck (species) 2 uses and Lantern Luck (feat) 1 use (a new uses_max in features_add changes one)',
    );
  });
});
