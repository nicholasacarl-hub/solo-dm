/**
 * The character builder with imported options (spec §5.3, SRD 5.2.1 "Creating a Character"): the
 * Gloamwood fixture's merged data (invented content only) on top of an SRD subset. SRD-only drafts
 * build exactly as before.
 */
import { describe, expect, it } from 'vitest';
import { characterSheetText } from '@/engine';
import { importedPlaceholder, redactImported, textFingerprint } from '@/lib/importedContent';
import { featChoices } from '@/data/options/levelUpChoices';
import { importedOptions, mergeBuilderData } from '@/data/structured/merge';
import { restoreImportedText, type LibraryLookup } from '@/data/structured/restore';
import { redactCopiedImports } from '@/storage/redact';
import { sampleCampaign } from '@/test/fixtures';
import {
  EXPECTED_MERGED,
  GLOAMWOOD_MARKERS,
  GLOAMWOOD_SOURCE_ID,
  GLOAMWOOD_SRD_SUBSET,
  GLOAMWOOD_TITLE,
  gloamwoodEntryId,
  gloamwoodSnapshot,
  gloamwoodSource,
  importedRef,
} from '@/test/structuredFixtures';
import { SRD_SOURCE_ID, type BackgroundOption, type BuilderData, type Character, type ClassData, type ClassOption, type CompendiumEntry, type EquipmentOption, type FeatOption, type Feature, type OptionSource, type SourceFormat, type SpeciesOption, type StructuredRecord } from '@/types';
import { fillStep, letDmDecide } from './autofill';
import {
  backgroundBonuses,
  buildCharacter,
  chosenFightingStyle,
  classChoiceFeatures,
  draftAdaptationNotes,
  draftImports,
  emptyDraft,
  fightingStyleChoices,
  filtered,
  finalAbilityScores,
  masteryPlan,
  offeredFightingStyles,
  originFeats,
  picks,
  selectClass,
  speciesChoices,
  spellInfo,
  spellsForClassOption,
  validateStep,
  visibleSpells,
  type BuilderContext,
  type BuilderDraft,
  type SpellInfo,
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

/** The character as a download or GitHub save carries it (spec §7.3). */
function exportedCopy(c: Character): Character {
  const { data: copy } = redactCopiedImports({ campaign: sampleCampaign(), character: c, sessions: [], transcript: [], log: [], combat: null, journal: [], quests: [], clocks: [], homebrew: [] });
  return copy.character as Character;
}

/** A book's own "Great Weapon Fighting" (invented rules), sharing the SRD feat's name. */
const BOOK_GWF: FeatOption = {
  id: 'lib:gloam:feat:great-weapon-fighting',
  name: 'Great Weapon Fighting',
  category: 'fighting-style',
  description: 'Invented: once per turn, when you miss with a Heavy weapon, you can reroll the attack roll.',
  source: { sourceId: GLOAMWOOD_SOURCE_ID, title: GLOAMWOOD_TITLE, recordId: 'rec:gloam:feat:great-weapon-fighting', format: '2014', adaptations: [] },
  ref: importedRef({ entryId: 'lib:gloam:feat:great-weapon-fighting', kind: 'feat', entryName: 'Great Weapon Fighting', textCopied: true }),
};

/** An invented Fighting Style feature that prints two styles of its own, in an entry of its own (ordinal 900). */
const STYLE_ENTRY: CompendiumEntry = {
  id: 'lib:gloam:900',
  sourceId: GLOAMWOOD_SOURCE_ID,
  sourceName: GLOAMWOOD_TITLE,
  kind: 'rule',
  name: 'Wickwright Fighting Styles',
  text: [
    '### Wickwright Fighting Styles',
    'Wickwrights drill with whatever the lamplit roads hand them. Choose one of the following options.',
    '_**Lantern Guard.**_ While you hold a lit lantern, you gain a +1 bonus to AC.',
    '_**Wick Lash.**_ You can add your Intelligence modifier to the damage of a whip.',
  ].join('\n\n'),
};

/** The merged data with the Wickwright's record given that Fighting Style feature at level 1 (paragraphs 2–4 of the entry). */
function withInlineStyles() {
  const snap = gloamwoodSnapshot();
  const entriesById = new Map([...snap.entriesById, [STYLE_ENTRY.id, STYLE_ENTRY]]);
  const style = { level: 1, name: 'Fighting Style', text: { entryIds: [STYLE_ENTRY.id], from: 2, to: 4 } };
  const accepted = snap.accepted.map((r) =>
    r.kind === 'class' && r.name === 'Wickwright' ? ({ ...r, data: { ...(r.data as ClassData), features: [...(r.data as ClassData).features, style] } } as StructuredRecord) : r,
  );
  const { data: merged } = mergeBuilderData(GLOAMWOOD_SRD_SUBSET, importedOptions({ ...snap, entriesById, accepted }));
  return { merged, entriesById, source: snap.sources[0] };
}

/** An invented sentence of the invented "Cinderkin" species, which must never leave the device. */
const CINDER_SECRET = 'The ember answers only to a patient hand of ash.';

/**
 * An invented book species whose record lists no lineages, with a trait offering a choice made in play
 * ("each time you finish a Long Rest"), as an accepted record merges it: every trait with its ref.
 */
function cinderkin(patch: Partial<SpeciesOption> = {}): SpeciesOption {
  const sight = 'You have Darkvision with a range of 60 feet.';
  const gift = `Choose one of the following gifts each time you finish a Long Rest.\n\n**Ember.** ${CINDER_SECRET}\n\n**Ash.** Smoke clings to you, and you have Advantage on Dexterity (Stealth) checks in smoke.`;
  const id = 'lib:gloam:species:cinderkin';
  const ref = (part: string, text: string) => importedRef({ entryId: id, kind: 'species', entryName: 'Cinderkin', part, textHash: textFingerprint(text), textCopied: true });
  return {
    ...mothkin,
    id,
    name: 'Cinderkin',
    traits: [
      { name: 'Dusk Sight', description: sight, ref: ref('Dusk Sight', sight) },
      { name: 'Kindled Gift', description: gift, ref: ref('Kindled Gift', gift) },
    ],
    lineages: undefined,
    lineageTrait: undefined,
    ...patch,
  };
}

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

  it("B1: a book species' choice trait without lineages in its record stays one trait with its ref, and leaves exports", () => {
    for (const species of [cinderkin(), cinderkin({ lineageTrait: 'Kindled Gift' })]) {
      const withSpecies: BuilderData = { ...data, species: [...data.species, species] };
      const bctx: BuilderContext = { ...ctx, data: withSpecies };
      // No lineage is read out of the trait's text, so none is required…
      expect(speciesChoices(species)).toMatchObject({ lineages: [], lineageTrait: null });
      const draft = fighterDraft({ speciesId: species.id, lineage: 'Ember', lineageAbility: null });
      expect(validateStep('species', draft, bctx)).toEqual([]);
      // …and the trait arrives as printed, with the trait's own ref.
      const c = buildCharacter(draft, bctx, { campaignId: 'camp-1' });
      const speciesFeatures = c.features.filter((f) => f.source === 'species');
      expect(speciesFeatures.map((f) => f.name)).toEqual(['Dusk Sight', 'Kindled Gift']);
      const gift = speciesFeatures[1];
      expect(gift.description).toBe(species.traits[1].description);
      expect(gift.ref).toEqual(species.traits[1].ref);
      expect(c.species).toBe('Cinderkin');
      // The DM's sheet text wraps it (so saved system prompts drop it), and the exported copy leaves it out.
      expect(characterSheetText(c)).toContain(CINDER_SECRET);
      expect(redactImported(characterSheetText(c))).not.toContain(CINDER_SECRET);
      const out = exportedCopy(c);
      expect(JSON.stringify(out)).not.toContain(CINDER_SECRET);
      expect(out.features.find((f) => f.name === 'Kindled Gift')?.description).toBe(importedPlaceholder(GLOAMWOOD_TITLE));
    }
  });

  it('B1: a book lineage is copied part by part, each with its ref, never as preamble plus option text', () => {
    const c = buildCharacter(fighterDraft(), ctx, { campaignId: 'camp-1' });
    for (const f of c.features.filter((x) => x.source === 'species')) {
      expect(f.ref, f.name).toMatchObject({ textCopied: true });
      expect(f.ref?.textHash, f.name).toBe(textFingerprint(f.description));
    }
    expect(c.features.filter((x) => x.source === 'species').map((f) => f.name)).toEqual(['Dusk Sight', 'Powdered Wings', 'Lamp-Drawn (Ashwing)', 'Ashwing']);
    expect(JSON.stringify(exportedCopy(c).features)).not.toContain(GLOAMWOOD_MARKERS[3]);
  });

  it("B4: a book's Fighting Style feat that shares an SRD feat's name is its own choice, chosen and built by id", () => {
    const withBook: BuilderData = { ...data, feats: [...data.feats, BOOK_GWF] };
    const bctx: BuilderContext = { ...ctx, data: withBook };
    const srdGwf = withBook.feats.find((f) => f.id === 'srd:feat:great-weapon-fighting') as FeatOption;
    const named = fightingStyleChoices(fighter, withBook).filter((c) => c.name === 'Great Weapon Fighting');
    expect(named.map((c) => c.id)).toEqual([srdGwf.id, BOOK_GWF.id]);
    // The book filter shows the chosen book style alone: its SRD namesake isn't kept along with it.
    const bookOnly = fightingStyleChoices(fighter, withBook, GLOAMWOOD_SOURCE_ID, BOOK_GWF.id).map((c) => c.id);
    expect(bookOnly).toContain(BOOK_GWF.id);
    expect(bookOnly).not.toContain(srdGwf.id);
    const draft = fighterDraft({ fightingStyle: BOOK_GWF.id, sourceFilter: GLOAMWOOD_SOURCE_ID });
    expect(chosenFightingStyle(named, draft.fightingStyle)?.feat).toBe(BOOK_GWF);
    expect(validateStep('class', draft, bctx)).toEqual([]);
    const style = buildCharacter(draft, bctx, { campaignId: 'camp-1' }).features.find((f) => f.sourceName === 'Fighting Style (Fighter 1)');
    expect(style).toMatchObject({ name: 'Great Weapon Fighting', source: 'feat', description: BOOK_GWF.description, ref: BOOK_GWF.ref });
    expect(draftImports(draft, withBook)).toContainEqual({ name: 'Great Weapon Fighting', kind: 'feat', book: GLOAMWOOD_TITLE });
    // The SRD card builds the SRD feat; a draft saved before ids (the name) still builds the first of that name.
    for (const value of [srdGwf.id, 'Great Weapon Fighting']) {
      const built = buildCharacter(fighterDraft({ fightingStyle: value }), bctx, { campaignId: 'camp-1' }).features.find((f) => f.sourceName === 'Fighting Style (Fighter 1)');
      expect(built, value).toMatchObject({ name: 'Great Weapon Fighting', description: srdGwf.description });
      expect(built?.ref, value).toBeUndefined();
    }
    // The book switched off: the step says so, and nothing is built from a stale id.
    expect(validateStep('class', draft, ctx)).toEqual(["The Fighting Style you picked came from a book that's switched off or removed. Switch it on in the Library, or pick another."]);
    expect(buildCharacter(draft, ctx, { campaignId: 'camp-1' }).features.some((f) => f.sourceName === 'Fighting Style (Fighter 1)')).toBe(false);
  });

  it('B5: an inline fighting style keeps a ref to its own option, so an export and restore bring back only its words', () => {
    const { merged, entriesById, source } = withInlineStyles();
    const wick = merged.classes.find((c) => c.id === wickwright.id) as ClassOption;
    const def = wick.features.find((f) => f.name === 'Fighting Style');
    expect(def?.ref?.at).toEqual({ ordinals: [900], from: 2, to: 4 });
    expect(fightingStyleChoices(wick, merged).filter((c) => !c.feat).map((c) => c.id)).toEqual(['inline:lantern-guard', 'inline:wick-lash']);
    const draft = fighterDraft({ classId: wick.id, fightingStyle: 'inline:lantern-guard', classSkills: ['arcana', 'history'] });
    const c = buildCharacter(draft, { ...ctx, data: merged }, { campaignId: 'camp-1' });
    const style = c.features.find((f) => f.name === 'Lantern Guard') as Feature;
    const words = 'While you hold a lit lantern, you gain a +1 bonus to AC.';
    expect(style).toMatchObject({ source: 'class', description: words });
    expect(style.ref).toMatchObject({ entryId: wick.id, kind: 'class', part: 'Lantern Guard', level: 1, at: { ordinals: [900], from: 3, to: 3 }, textHash: textFingerprint(words), textCopied: true });
    // The level-up panel offers the same style with the same ref.
    expect(featChoices('fighting-style', merged.feats, { cls: wick, characterLevel: 2, have: [] }).find((p) => p.id === 'inline:lantern-guard')?.ref).toEqual(style.ref);

    const out = exportedCopy(c);
    expect(out.features.find((f) => f.name === 'Lantern Guard')?.description).toBe(importedPlaceholder(GLOAMWOOD_TITLE));
    // A device with the same book (by fingerprint and place, the book structured or not)…
    const book: LibraryLookup = { entriesById, sourcesByFingerprint: new Map([[source.fingerprint as string, source]]), sourcesByTitle: new Map(), builder: GLOAMWOOD_SRD_SUBSET };
    // …or with the class structured: each brings back the style's own words, never the whole feature.
    const structured: LibraryLookup = { entriesById: new Map(), sourcesByFingerprint: new Map(), sourcesByTitle: new Map(), builder: merged };
    for (const lookup of [book, structured]) {
      const { character, report } = restoreImportedText(out, lookup);
      expect(character.features.find((f) => f.name === 'Lantern Guard')?.description).toBe(words);
      expect(report.differs).toBe(0);
    }
  });
});

describe("a 2024 book's option in place of the SRD's: one per name under All", () => {
  // Invented: the Gloamwood Almanac (a 2024 book) reprinting SRD names, and an older book doing the same.
  const GLOAM = wickwright.source as OptionSource;
  const as = <T extends { source?: OptionSource }>(o: T, format: SourceFormat): T => ({ ...o, source: { ...(o.source as OptionSource), format } });
  const ids = (list: readonly { id: string }[]) => list.map((o) => o.id);
  const cleric = byName(data.classes, 'Cleric', false);
  const bookFighter: ClassOption = { ...fighter, id: 'lib:gloam:class:fighter', subclasses: [], source: { ...GLOAM, recordId: 'rec:gloam:class:fighter' } };

  it('lists the book’s class alone; the chosen SRD class, the SRD filter and lookups by id still have the SRD’s', () => {
    const classes = [...data.classes, bookFighter];
    expect(ids(filtered(classes, null))).toEqual([cleric.id, wickwright.id, bookFighter.id]);
    expect(ids(filtered(classes, null, fighter.id))).toEqual([cleric.id, fighter.id, wickwright.id, bookFighter.id]);
    expect(ids(filtered(classes, SRD_SOURCE_ID))).toEqual([cleric.id, fighter.id]);
    expect(ids(filtered(classes, GLOAMWOOD_SOURCE_ID))).toEqual([wickwright.id, bookFighter.id]);
    expect(picks(fighterDraft(), { ...data, classes }).cls).toBe(fighter);
    // An older book's Fighter is another design: it sits beside the SRD's.
    const older = as(bookFighter, '2014');
    expect(ids(filtered([...data.classes, older], null))).toEqual([cleric.id, fighter.id, wickwright.id, older.id]);
  });

  it('"Let the DM decide" picks among the same cards; filling in keeps a chosen SRD class', () => {
    const bctx: BuilderContext = { ...ctx, data: { ...data, classes: [...data.classes, bookFighter] } };
    for (const next of [0, 0.34, 0.67, 0.99]) {
      expect(letDmDecide('class', emptyDraft(), bctx, { next: () => next }).classId).not.toBe(fighter.id);
    }
    expect(fillStep('class', { ...emptyDraft(), classId: fighter.id }, bctx, { next: () => 0.99 }).classId).toBe(fighter.id);
  });

  it('the Fighting Style picker offers the book’s style in place of the SRD’s; lookups and an older book’s keep both', () => {
    const bookGwf = as(BOOK_GWF, '2024');
    const withBook: BuilderData = { ...data, feats: [...data.feats, bookGwf] };
    const srdGwf = 'srd:feat:great-weapon-fighting';
    const gwf = (choices: readonly { id: string; name: string }[]) => ids(choices.filter((c) => c.name === 'Great Weapon Fighting'));
    expect(gwf(offeredFightingStyles(fighter, withBook, null))).toEqual([bookGwf.id]);
    expect(gwf(offeredFightingStyles(fighter, withBook, null, srdGwf))).toEqual([srdGwf, bookGwf.id]);
    // A draft saved before ids names the style: the first of that name (the SRD's) stays chosen and shown.
    expect(gwf(offeredFightingStyles(fighter, withBook, null, 'Great Weapon Fighting'))).toEqual([srdGwf, bookGwf.id]);
    expect(gwf(offeredFightingStyles(fighter, withBook, SRD_SOURCE_ID))).toEqual([srdGwf]);
    expect(gwf(fightingStyleChoices(fighter, withBook))).toEqual([srdGwf, bookGwf.id]);
    expect(validateStep('class', fighterDraft({ fightingStyle: srdGwf }), { ...ctx, data: withBook })).toEqual([]);
    expect(gwf(offeredFightingStyles(fighter, { ...data, feats: [...data.feats, BOOK_GWF] }, null))).toEqual([srdGwf, BOOK_GWF.id]);
    // The DM picks from the same cards: the Fighter's recommended Defense is the book's when it stands in.
    const bookDefense: FeatOption = { ...bookGwf, id: 'lib:gloam:feat:defense', name: 'Defense', description: 'Invented: a lantern-lit guard.' };
    const pick = (feats: FeatOption[]) => fillStep('class', { ...emptyDraft(), classId: fighter.id }, { ...ctx, data: { ...data, feats } }, { next: () => 0 }).fightingStyle;
    expect(pick([...data.feats, bookDefense])).toBe(bookDefense.id);
    expect(pick([...data.feats, as(bookDefense, '2014')])).toBe('srd:feat:defense');
  });

  it('an Origin feat is never taken twice: the background’s feat of any book counts (SRD 5.2.1 Feats: each feat once unless Repeatable)', () => {
    const bookAlert: FeatOption = { id: 'lib:gloam:feat:alert', name: 'Alert', category: 'origin', description: 'Invented: you wake at the first creak of a floorboard.', source: { ...GLOAM, recordId: 'rec:gloam:feat:alert' } };
    const watch: BackgroundOption = { ...lamplighter, id: 'lib:gloam:background:night-watch', name: 'Night Watch', feat: 'Alert' };
    const wayfolk: SpeciesOption = {
      ...cinderkin(),
      id: 'lib:gloam:species:wayfolk',
      name: 'Wayfolk',
      traits: [{ name: 'Wayfarer', description: 'You gain an Origin feat of your choice.' }],
    };
    const withBook: BuilderData = { ...data, feats: [...data.feats, bookAlert], backgrounds: [...data.backgrounds, watch], species: [...data.species, wayfolk] };
    const bctx: BuilderContext = { ...ctx, data: withBook };
    const draft = (speciesFeat: string) => fighterDraft({ backgroundId: watch.id, speciesId: wayfolk.id, lineage: null, size: null, speciesFeat });
    expect(originFeats(draft('srd:feat:alert'), withBook).map((f) => f.feat?.id)).toEqual([bookAlert.id, 'srd:feat:alert']);
    expect(validateStep('species', draft('srd:feat:alert'), bctx)).toContain('You already have Alert from your background; choose a different feat.');
    expect(validateStep('species', draft('srd:feat:savage-attacker'), bctx).filter((e) => e.includes('Alert'))).toEqual([]);
    // A background that lets the player choose keeps a chosen SRD feat the book's now stands in for.
    const ferry = fighterDraft({ backgroundId: ferryHand.id, backgroundFeat: 'srd:feat:alert' });
    expect(fillStep('background', ferry, bctx, { next: () => 0.99 }).backgroundFeat).toBe('srd:feat:alert');
    expect(letDmDecide('background', { ...ferry, backgroundId: null }, bctx, { next: () => 0 }).backgroundFeat).not.toBe('srd:feat:alert');
    // A filter never makes the DM replace a valid choice its step still shows (filtered keeps it).
    const kept = fillStep('species', { ...draft('srd:feat:savage-attacker'), sourceFilter: GLOAMWOOD_SOURCE_ID }, bctx, { next: () => 0.99 });
    expect(kept.speciesFeat).toBe('srd:feat:savage-attacker');
    expect(fillStep('background', { ...ferry, sourceFilter: GLOAMWOOD_SOURCE_ID }, bctx, { next: () => 0.99 }).backgroundFeat).toBe('srd:feat:alert');
    // Filling in replaces it, under "All" and under the SRD filter (which lists the SRD's Alert).
    for (const sourceFilter of [null, SRD_SOURCE_ID]) {
      for (const next of [0, 0.5, 0.99]) {
        const feat = fillStep('species', { ...draft('srd:feat:alert'), sourceFilter }, bctx, { next: () => next }).speciesFeat;
        expect(withBook.feats.find((f) => f.id === feat)?.name, `${sourceFilter} ${next}`).not.toBe('Alert');
      }
    }
  });

  it("a class that chooses its subclass at level 1 lists one subclass per name, and the DM picks among those", () => {
    const sub = wickwright.subclasses[0];
    const srdLike = { ...sub, id: 'srd:subclass:lamp-oath', name: 'Lamp Oath', source: undefined };
    const bookOath = { ...sub, id: 'lib:gloam:subclass:lamp-oath', name: 'Lamp Oath' };
    const early: ClassOption = { ...wickwright, subclassLevel: 1, subclasses: [srdLike, bookOath] };
    const bctx: BuilderContext = { ...ctx, data: { ...data, classes: [...data.classes.filter((c) => c.id !== wickwright.id), early] } };
    for (const next of [0, 0.99]) {
      expect(fillStep('class', { ...emptyDraft(), classId: early.id }, bctx, { next: () => next }).subclassId).toBe(bookOath.id);
    }
    expect(fillStep('class', { ...emptyDraft(), classId: early.id, subclassId: srdLike.id }, bctx, { next: () => 0 }).subclassId).toBe(srdLike.id);
  });

  it('Weapon Mastery offers one chip per weapon name (the choice is stored by name)', () => {
    const srdDagger = data.equipment.find((e) => e.id === 'srd:item:dagger') as EquipmentOption;
    const bookDagger: EquipmentOption = { ...srdDagger, id: 'lib:gloam:item:dagger', source: { ...GLOAM, recordId: 'rec:gloam:item:dagger' } };
    const withBook: BuilderData = { ...data, equipment: [...data.equipment, bookDagger] };
    const before = masteryPlan(fighterDraft(), data);
    const after = masteryPlan(fighterDraft(), withBook);
    expect(after.candidates.map((c) => c.name)).toEqual(before.candidates.map((c) => c.name));
    expect(after.candidates.filter((c) => c.name === 'Dagger').map((c) => c.id)).toEqual([srdDagger.id]);
    expect(after.count).toBe(before.count);
  });

  describe('spell lists', () => {
    const light = SPELLS.find((s) => s.name === 'Light') as SpellInfo;
    const bookLight = (format: SourceFormat | null, id = 'lib:gloam:910', reviewed = format !== null) =>
      spellInfo({
        ...light.entry,
        id,
        sourceId: 'gloam',
        sourceName: GLOAMWOOD_TITLE,
        text: 'Invented: a lamp-wick glow.',
        data: { ...light.entry.data, ...(format ? { format } : {}), ...(reviewed ? { recordId: `rec:${id}` } : {}) },
      });
    const lights = (list: readonly SpellInfo[]) => ids(list.filter((s) => s.name === 'Light'));

    it("show a book's accepted 2024 spell in place of the SRD's, the SRD's beside an older book's, and the SRD's over one not yet reviewed", () => {
      const reviewed = bookLight('2024');
      expect(lights(visibleSpells([...SPELLS, reviewed], null))).toEqual([reviewed.id]);
      expect(lights(visibleSpells([...SPELLS, bookLight('2014')], null))).toEqual([light.id, 'lib:gloam:910']);
      expect(lights(visibleSpells([...SPELLS, bookLight(null)], null))).toEqual([light.id]);
      // Only an accepted record stands in: an entry that merely says 2024 (a pack's text, say) doesn't.
      expect(lights(visibleSpells([...SPELLS, bookLight('2024', 'lib:gloam:912', false)], null))).toEqual([light.id]);
      // A book's spell the SRD doesn't have is listed, reviewed or not (Smoky Whisper isn't reviewed).
      expect(visibleSpells(SPELLS, null).map((s) => s.name)).toEqual(SPELLS.map((s) => s.name));
      // The accepted one also wins over a third book's unreviewed copy.
      expect(lights(visibleSpells([...SPELLS, reviewed, bookLight(null, 'lib:reed:4')], null))).toEqual([reviewed.id]);
    });

    it('keep a chosen spell, and let each filter show its own source in full', () => {
      const reviewed = bookLight('2024');
      const unreviewed = bookLight(null, 'lib:gloam:911');
      const all = [...SPELLS, reviewed, unreviewed];
      expect(lights(visibleSpells(all, null, new Set([light.id])))).toEqual([light.id, reviewed.id]);
      expect(lights(visibleSpells(all, SRD_SOURCE_ID))).toEqual([light.id]);
      expect(lights(visibleSpells(all, GLOAMWOOD_SOURCE_ID))).toEqual([reviewed.id, unreviewed.id]);
      expect(lights(visibleSpells(all, GLOAMWOOD_SOURCE_ID, new Set([light.id])))).toEqual([light.id, reviewed.id, unreviewed.id]);
    });
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
