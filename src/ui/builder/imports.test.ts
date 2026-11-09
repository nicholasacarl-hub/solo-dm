/**
 * The character builder with imported options (spec §5.3, SRD 5.2.1 "Creating a Character"): the
 * Gloamwood fixture's merged data (invented content only) on top of an SRD subset. SRD-only drafts
 * build exactly as before.
 */
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_MERGED,
  GLOAMWOOD_MARKERS,
  GLOAMWOOD_SRD_SUBSET,
  GLOAMWOOD_TITLE,
  gloamwoodEntryId,
  gloamwoodSource,
} from '@/test/structuredFixtures';
import type { BuilderData, ClassOption, CompendiumEntry, Feature } from '@/types';
import {
  backgroundBonuses,
  buildCharacter,
  classChoiceFeatures,
  draftAdaptationNotes,
  draftImports,
  emptyDraft,
  fightingStyleChoices,
  finalAbilityScores,
  originFeats,
  picks,
  selectClass,
  speciesChoices,
  spellInfo,
  spellsForClassOption,
  validateStep,
  type BuilderContext,
  type BuilderDraft,
} from './logic';

const data = EXPECTED_MERGED;
const byName = <T extends { name: string }>(list: readonly T[], name: string, imported = true) =>
  list.find((o) => o.name === name && Boolean((o as { source?: unknown }).source) === imported) as T;
const fighter = byName(data.classes, 'Fighter', false);
const wickwright = byName(data.classes, 'Wickwright');
const mothkin = byName(data.species, 'Mothkin');
const bramblefolk = byName(data.species, 'Bramblefolk');
const lamplighter = byName(data.backgrounds, 'Lamplighter');
const ferryHand = byName(data.backgrounds, 'Ferry Hand');

const spell = (id: string, name: string, level: number, classes: string[], sourceId = 'srd-5.2.1', extra: Partial<CompendiumEntry> = {}): CompendiumEntry => ({
  id,
  sourceId,
  sourceName: sourceId === 'srd-5.2.1' ? 'SRD 5.2.1' : GLOAMWOOD_TITLE,
  kind: 'spell',
  name,
  summary: `${level ? `Level ${level} Evocation` : 'Evocation Cantrip'} (${classes.join(', ')})`,
  text: 'A spell.',
  data: { level, classes },
  ...extra,
});
const SPELLS = [
  spell('srd:spell:burning-hands', 'Burning Hands', 1, ['Sorcerer', 'Wizard']),
  spell('srd:spell:light', 'Light', 0, ['Bard', 'Cleric', 'Sorcerer', 'Wizard']),
  spell('srd:spell:mending', 'Mending', 0, ['Bard', 'Cleric', 'Druid', 'Sorcerer', 'Wizard']),
  spell('srd:spell:fire-bolt', 'Fire Bolt', 0, ['Sorcerer', 'Wizard']),
  spell(gloamwoodEntryId('Cinder Mote'), 'Cinder Mote', 0, ['Wickwright'], 'gloam', {
    text: 'You flick a glowing cinder. Make a ranged spell attack against the target. On a hit, the target takes 1d10 Fire damage.',
    data: { level: 0, classes: ['Wickwright'], recordId: 'rec:gloam:spell:cinder-mote', attack: 'ranged', damage: '1d10', damageTypes: ['fire'], range: '60 feet' },
  }),
  spell('lib:gloam:900', 'Smoky Whisper', 1, ['Wickwright'], 'gloam'),
].map(spellInfo);
const ctx: BuilderContext = { data, spells: SPELLS };

/** A complete draft: Fighter (Archery), Lamplighter, Mothkin (Ashwing), standard array, package A. */
function fighterDraft(patch: Partial<BuilderDraft> = {}): BuilderDraft {
  return {
    ...emptyDraft(),
    classId: fighter.id,
    fightingStyle: 'Archery',
    backgroundId: lamplighter.id,
    bonusPlus2: 'dex',
    bonusPlus1: 'wis',
    speciesId: mothkin.id,
    lineage: 'Ashwing',
    lineageAbility: 'wis',
    size: 'Small',
    assignment: { str: 0, dex: 1, con: 2, wis: 3, int: 4, cha: 5 },
    classSkills: ['athletics', 'insight'],
    languages: ['Elvish', 'Halfling'],
    classEquipment: 0,
    backgroundEquipment: 0,
    weaponMasteries: ['Greatsword', 'Flail', 'Javelin'],
    name: 'Ember',
    ...patch,
  };
}

const importedFeature = (f: Feature) => f.ref !== undefined;

describe('imported options in the builder', () => {
  it("offers Mothkin's lineages from its named lineage trait (Lamp-Drawn), not the name rule", () => {
    const choices = speciesChoices(mothkin);
    expect(choices.lineageTrait?.name).toBe('Lamp-Drawn');
    expect(choices.lineages.map((l) => l.name)).toEqual(['Ashwing', 'Silverwing']);
    expect(choices.lineageNeedsAbility).toBe(true);
  });

  it('builds a Mothkin Lamplighter with the book’s words, a ref on every copied text, and gear by numbers', () => {
    const c = buildCharacter(fighterDraft(), ctx, { campaignId: 'camp-1' });
    expect(c.speciesId).toBe(mothkin.id);
    expect(c.species).toBe('Mothkin (Ashwing lineage)');
    expect(c.speciesRef).toMatchObject({ entryId: mothkin.id, kind: 'species', textCopied: false, bookFingerprint: gloamwoodSource().fingerprint });
    expect(c.backgroundRef).toMatchObject({ entryId: lamplighter.id, kind: 'background', textCopied: false });
    const named = (name: string) => c.features.find((f) => f.name === name);
    expect(named('Dusk Sight')?.description).toContain(GLOAMWOOD_MARKERS[2]);
    expect(named('Dusk Sight')?.ref).toMatchObject({ part: 'Dusk Sight', textCopied: true });
    expect(named('Ashwing')?.description).toContain(GLOAMWOOD_MARKERS[3]);
    expect(named('Ashwing')?.ref).toMatchObject({ part: 'Ashwing', textCopied: true, at: { from: 1, to: 1 } });
    expect(named('Lamp-Drawn (Ashwing)')?.ref?.part).toBe('Lamp-Drawn');
    // Moth's Grace from the same book as the background.
    expect(named("Moth's Grace")).toMatchObject({ source: 'feat', sourceName: 'Lamplighter (Origin feat)' });
    expect(named("Moth's Grace")?.description).toContain(GLOAMWOOD_MARKERS[4]);
    // Every feature from an imported option carries a ref; SRD ones don't.
    expect(c.features.filter(importedFeature).map((f) => f.name).sort()).toEqual(['Ashwing', 'Dusk Sight', 'Lamp-Drawn (Ashwing)', "Moth's Grace", 'Powdered Wings']);
    for (const f of c.features.filter(importedFeature)) expect(f.ref?.textHash, f.name).toMatch(/^[0-9a-f]{16}$/);
    // The Hookstaff: numbers and a ref, an app-written description, and an attack.
    const hookstaff = c.inventory.find((i) => i.name === 'Hookstaff');
    expect(hookstaff).toMatchObject({ category: 'weapon', compendiumId: 'lib:gloam:item:hookstaff', ref: { textCopied: false, kind: 'item' } });
    expect(hookstaff?.description).toBe('Martial melee weapon · 1d8 bludgeoning · Reach, Two-Handed · mastery Topple');
    expect(c.attacks.find((a) => a.name === 'Hookstaff')).toMatchObject({ damage: '1d8', damageType: 'bludgeoning', range: '10 ft.', proficient: true });
    expect(c.adaptationNotes).toBeUndefined();
    expect(draftImports(fighterDraft(), data)).toEqual([
      { name: 'Mothkin', kind: 'species', book: GLOAMWOOD_TITLE },
      { name: 'Lamplighter', kind: 'background', book: GLOAMWOOD_TITLE },
      { name: "Moth's Grace", kind: 'feat', book: GLOAMWOOD_TITLE },
    ]);
  });

  it('keeps Bramblefolk’s printed increases for reference only, and reads its darkvision and poison resistance', () => {
    const draft = fighterDraft({ speciesId: bramblefolk.id, lineage: 'Thornback', lineageAbility: null, size: null });
    expect(validateStep('species', draft, ctx)).toEqual([]);
    const c = buildCharacter(draft, ctx, { campaignId: 'camp-1' });
    // Standard array 15/14/13/12/10/8 + Lamplighter +2 DEX, +1 WIS; the printed +2 CON / +1 WIS are not applied.
    expect(c.abilityScores).toEqual({ str: 15, dex: 16, con: 13, int: 10, wis: 13, cha: 8 });
    expect(c.darkvision).toBe(60);
    expect(c.speed).toBe(25);
    expect(c.size).toBe('Small');
    expect(c.damageResistances).toEqual(['poison']);
    expect(c.adaptationNotes).toEqual(bramblefolk.source?.adaptations.map((a) => a.note));
    expect(c.features.find((f) => f.name === 'Subrace (Thornback)')).toBeDefined();
    expect(c.features.find((f) => f.name === 'Thornback')?.ref?.part).toBe('Thornback');
  });

  it('lets Ferry Hand raise any three abilities and choose its Origin feat; keeps its feature with a ref', () => {
    const draft = fighterDraft({ backgroundId: ferryHand.id, bonusMode: 'one-one-one', bonusPlus2: null, bonusPlus1: null, backgroundEquipment: 0 });
    expect(validateStep('abilities', draft, ctx)).toEqual(['Choose three different abilities for +1 each (0 chosen).']);
    expect(validateStep('background', draft, ctx)).toEqual(['Choose an Origin feat: Ferry Hand lets you pick one.']);
    const grace = byName(data.feats, "Moth's Grace");
    const done = { ...draft, backgroundAbilities: ['str', 'con', 'cha'] as BuilderDraft['backgroundAbilities'], backgroundFeat: grace.id };
    expect(validateStep('abilities', done, ctx)).toEqual([]);
    expect(validateStep('background', done, ctx)).toEqual([]);
    expect(backgroundBonuses(done, ferryHand)).toEqual({ str: 1, con: 1, cha: 1 });
    expect(finalAbilityScores({ ...done, bonusMode: 'two-one', bonusPlus2: 'int', bonusPlus1: 'cha' }, ferryHand)).toMatchObject({ int: 12, cha: 9 });
    expect(originFeats(done, data).map((f) => f.name)).toEqual(["Moth's Grace"]);
    const c = buildCharacter(done, ctx, { campaignId: 'camp-1' });
    const feature = c.features.find((f) => f.name === "Ferryman's Right");
    expect(feature).toMatchObject({ source: 'background', sourceName: 'Ferry Hand (background)' });
    expect(feature?.description).toContain(GLOAMWOOD_MARKERS[5]);
    expect(feature?.ref).toMatchObject({ kind: 'background', part: "Ferryman's Right", textCopied: true });
    expect(c.adaptationNotes).toEqual(ferryHand.source?.adaptations.map((a) => a.note));
    expect(draftAdaptationNotes(done, data)).toEqual(c.adaptationNotes);
  });

  it('lists Hooked Reach once with the inline styles a class prints, and no second picker', () => {
    const def = fighter.features.find((f) => f.name === 'Fighting Style');
    const printed = `${def?.description}\n\n_**Hooked Reach.**_ Pull them close.\n\n_**Lamp Guard.**_ Shield the light.`;
    const cls: ClassOption = { ...fighter, id: 'lib:gloam:class:lamp-knight', name: 'Lamp Knight', features: fighter.features.map((f) => (f === def ? { ...f, description: printed } : f)) };
    const choices = fightingStyleChoices(cls, data);
    expect(choices.filter((c) => c.name === 'Hooked Reach')).toHaveLength(1);
    expect(choices.find((c) => c.name === 'Hooked Reach')?.feat?.source?.title).toBe(GLOAMWOOD_TITLE);
    expect(choices.find((c) => c.name === 'Lamp Guard')).toMatchObject({ feat: null, description: 'Shield the light.' });
    expect(classChoiceFeatures(cls).map((c) => c.feature.name)).not.toContain('Fighting Style');
    const withCls = { ...data, classes: [...data.classes, cls] };
    const c = buildCharacter(fighterDraft({ classId: cls.id, fightingStyle: 'Lamp Guard' }), { ...ctx, data: withCls }, { campaignId: 'camp-1' });
    expect(c.features.find((f) => f.name === 'Lamp Guard')).toMatchObject({ source: 'class', description: 'Shield the light.' });
  });

  it("lists the Wickwright's spells: its own and the SRD spells its list prints", () => {
    const cantrips = spellsForClassOption(SPELLS, wickwright, 0).map((s) => s.name);
    expect(cantrips).toEqual(['Cinder Mote', 'Light', 'Mending']);
    expect(spellsForClassOption(SPELLS, wickwright, 1).map((s) => s.name)).toEqual(['Burning Hands', 'Smoky Whisper']);
    const c = buildCharacter(fighterDraft({ classId: wickwright.id, fightingStyle: null, classSkills: ['arcana', 'history'], cantrips: [], prepared: [SPELLS[5].id, SPELLS[0].id] }), ctx, { campaignId: 'camp-1' });
    expect(c.classes[0]).toMatchObject({ classId: wickwright.id, casterType: 'half', ref: { kind: 'class', entryId: wickwright.id, textCopied: false } });
    expect(c.spellcasting?.spells.find((s) => s.name === 'Smoky Whisper')?.ref).toMatchObject({ kind: 'spell', textCopied: false });
    expect(c.spellcasting?.spells.find((s) => s.name === 'Burning Hands')?.ref).toBeUndefined();
    expect(c.features.find((f) => f.name === 'Wick Sense')?.description).toContain(GLOAMWOOD_MARKERS[6]);
  });

  it('requires and builds the subclass of a class that chooses it at level 1', () => {
    const order = wickwright.subclasses[0];
    const early: ClassOption = { ...wickwright, subclassLevel: 1, subclasses: [{ ...order, features: order.features.map((f, i) => (i ? f : { ...f, level: 1 })) }] };
    const withEarly: BuilderData = { ...data, classes: data.classes.map((c) => (c.id === wickwright.id ? early : c)) };
    const draft = fighterDraft({ classId: wickwright.id, fightingStyle: null, classSkills: ['arcana', 'history'] });
    expect(validateStep('class', draft, { ...ctx, data: withEarly })).toEqual(['Choose your Wickwright subclass: Wickwright chooses it at level 1.']);
    const chosen = { ...draft, subclassId: order.id };
    expect(validateStep('class', chosen, { ...ctx, data: withEarly })).toEqual([]);
    expect(picks(selectClass(chosen, fighter.id), withEarly).subclass).toBeUndefined();
    const c = buildCharacter(chosen, { ...ctx, data: withEarly }, { campaignId: 'camp-1' });
    expect(c.classes[0]).toMatchObject({ subclass: order.name, subclassId: order.id, subclassRef: { kind: 'subclass', entryId: order.id } });
    expect(c.features.find((f) => f.name === 'Steady Flame')).toMatchObject({ source: 'subclass', sourceName: 'Order of the Long Wick 1', ref: { part: 'Steady Flame' } });
  });

  it('says when a picked option came from a book that is switched off', () => {
    const draft = fighterDraft({ classId: 'lib:gone:class:x', backgroundId: 'lib:gone:background:y', speciesId: 'lib:gone:species:z' });
    const switchedOff = "came from a book that's switched off or removed. Switch it on in the Library, or pick another.";
    expect(validateStep('class', draft, ctx)).toEqual([`The class you picked ${switchedOff}`]);
    expect(validateStep('background', draft, ctx)).toEqual([`The background you picked ${switchedOff}`]);
    expect(validateStep('species', draft, ctx)).toEqual([`The species you picked ${switchedOff}`]);
  });
});

describe('SRD-only drafts', () => {
  it('build the same character with or without imported options in the data', () => {
    const srdDraft = { ...fighterDraft(), speciesId: null, backgroundId: null, lineage: null, size: null };
    const strip = (c: ReturnType<typeof buildCharacter>) =>
      JSON.parse(JSON.stringify(c, (key, value) => (key === 'id' || key === 'createdAt' || key === 'updatedAt' ? undefined : value))) as unknown;
    const srdOnly = buildCharacter(srdDraft, { data: GLOAMWOOD_SRD_SUBSET, spells: SPELLS }, { campaignId: 'camp-1' });
    const merged = buildCharacter(srdDraft, ctx, { campaignId: 'camp-1' });
    expect(strip(merged)).toEqual(strip(srdOnly));
    expect(merged.features.some(importedFeature)).toBe(false);
    expect(merged.adaptationNotes).toBeUndefined();
  });
});
