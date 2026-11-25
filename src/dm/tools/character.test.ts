/**
 * The DM's character tools with content from the player's books (spec §5.5, §6.4, §6.6), on the real
 * engine with the merged builder data of the invented Gloamwood fixture: level_up adds an imported
 * class's or subclass's features with their text and refs (SRD 5.2.1 "Level Advancement"), keeps the
 * DM's extra features and SRD behavior; inventory_add, spells_add and features_add link exact names.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/engine')>();
  return { ...real, levelUp: vi.fn(real.levelUp) };
});
vi.mock('@/data', () => import('../testing/fakeData'));
vi.mock('@/state/gameStore', () => import('../testing/fakeGameStoreModule'));

import compendiumRaw from '../../../public/srd/compendium.json?raw';
import { knownSpellFromEntry } from '@/data/options/levelUpChoices';
import { owedSpells } from '@/data/options/spellPicks';
import { characterSheetText, levelUp, recomputeSlots, weaponCritRange } from '@/engine';
import { sampleCharacter, sampleCombat, sampleMappedCombat } from '@/test/fixtures';
import { EXPECTED_MERGED, GLOAMWOOD_MARKERS, GLOAMWOOD_TITLE, gloamwoodEntryId, importedRef, SRD_BUILDER_DATA, TEXT } from '@/test/structuredFixtures';
import {
  HOMEBREW_SOURCE_ID,
  type BuilderData,
  type Character,
  type ClassFeatureDef,
  type ClassLevel,
  type ClassOption,
  type CombatState,
  type CompendiumEntry,
  type FeatOption,
  type HomebrewEntry,
  type KnownSpell,
  type MapEffect,
  type OptionSource,
  type SubclassOption,
  type TranscriptMessage,
} from '@/types';
import { redactImportedDeep } from '@/storage/backup';
import { redactCopiedImports } from '@/storage/redact';
import { campaignGraph } from '@/storage/testData';
import type { CampaignData } from '@/storage/types';
import { deps, resetDmDeps, setDmDeps } from '../deps';
import { SAMPLE_RULES } from '../testing/fakeData';
import { setupHarness, type HarnessOptions } from '../testing/harness';
import { acSpellLines } from './character';
import type { ToolContext } from './context';
import { runTool } from './handlers';

afterEach(() => {
  resetDmDeps();
  vi.mocked(levelUp).mockClear();
});

const entry = (id: string, name: string, kind: CompendiumEntry['kind'], data: Record<string, unknown> = {}): CompendiumEntry => {
  const book = id.startsWith('lib:');
  return { id, sourceId: book ? 'gloam' : 'srd-5.2.1', sourceName: book ? GLOAMWOOD_TITLE : 'SRD 5.2.1', kind, name, text: `${name}.`, data };
};
const RULES: CompendiumEntry[] = [
  ...SAMPLE_RULES,
  entry('srd:spell:faerie-fire', 'Faerie Fire', 'spell', { level: 1, concentration: true }),
  entry('srd:spell:sleep', 'Sleep', 'spell', { level: 1, concentration: true }),
  entry(gloamwoodEntryId('Ashen Choir'), 'Ashen Choir', 'spell', { recordId: 'rec:gloam:spell:ashen-choir', level: 2, ritual: false, concentration: false }),
  entry(gloamwoodEntryId("Warden's Mail"), "Warden's Mail", 'magic-item', { recordId: 'rec:gloam:magic-item:wardens-mail', rarity: 'rare', attunement: false, bonuses: { ac: 1 } }),
  entry(gloamwoodEntryId('Lantern of Hollow Light'), 'Lantern of Hollow Light', 'magic-item', { recordId: 'rec:gloam:magic-item:lantern', rarity: 'uncommon', attunement: true }),
  entry('srd:item:rope', 'Rope', 'item', { category: 'gear' }),
];

const classOf = (id: string) => EXPECTED_MERGED.classes.find((c) => c.id === id) as ClassOption;
const FIGHTER = classOf('srd:class:fighter');
const EMBER = FIGHTER.subclasses.find((s) => s.name === 'Ember Warden')!;
const CLERIC_OPTION = classOf('srd:class:cleric');
const DUSK = classOf('srd:class:cleric').subclasses.find((s) => s.name === 'Dusk Domain')!;

function hero(cl: Partial<ClassLevel> & Pick<ClassLevel, 'classId' | 'name' | 'level' | 'hitDie'>, extra: Partial<Character> = {}): Character {
  return {
    ...sampleCharacter(),
    classes: [{ casterType: 'none', ...cl }],
    hitDice: [{ die: cl.hitDie, total: cl.level, spent: 0 }],
    hp: { max: 30, current: 30, temp: 0 },
    features: [],
    spellcasting: undefined,
    inventory: [],
    armorClass: 12,
    acFormula: '10 + DEX',
    abilityScores: { str: 16, dex: 14, con: 13, int: 14, wis: 12, cha: 8 },
    armorTraining: ['Light armor', 'Medium armor', 'Heavy armor', 'Shields'],
    ...extra,
  };
}

function setup(opts: HarnessOptions = {}) {
  const h = setupHarness({ withSession: true, rules: RULES, campaignSettings: { enabledSources: ['srd-5.2.1', 'gloam'], ...opts.campaignSettings }, ...opts });
  const ctx: ToolContext = { deps: deps(), signal: new AbortController().signal, status: vi.fn() };
  return { ...h, run: (name: string, input: unknown) => runTool(name, input, ctx), sheet: () => h.s().character as Character };
}

describe('level_up from the merged builder data', () => {
  it("adds an imported subclass's features with the book's text and refs, and keeps the DM's extras", async () => {
    const h = setup({ character: hero({ classId: FIGHTER.id, name: 'Fighter', level: 2, hitDie: 10 }) });
    const out = await h.run('level_up', {
      class_name: 'Fighter',
      subclass: 'Ember Warden',
      new_features: [
        { name: 'Ember Ward', description: 'My own summary of the ward.' },
        { name: 'Lantern Oath', description: 'A homebrew boon from the story.' },
      ],
    });
    expect(out.isError).toBeUndefined();
    const c = h.sheet();
    expect(c.classes[0]).toMatchObject({ level: 3, subclass: 'Ember Warden', subclassId: EMBER.id, subclassRef: { entryId: EMBER.id, kind: 'subclass', textCopied: false } });
    const ward = c.features.filter((f) => f.name === 'Ember Ward');
    expect(ward).toHaveLength(1);
    expect(ward[0]).toMatchObject({ source: 'subclass', description: TEXT.emberWard.join('\n\n'), uses: { max: 2, recharge: 'long' }, ref: { part: 'Ember Ward', level: 3, textCopied: true } });
    expect(c.features.find((f) => f.name === 'Kindled Strikes')?.ref?.textCopied).toBe(true);
    expect(c.features.find((f) => f.name === 'Lantern Oath')).toMatchObject({ source: 'class', sourceName: 'Fighter 3', description: 'A homebrew boon from the story.' });
    // The SRD Fighter's own level-3 feature stays the DM's to add, as today.
    expect(c.features.some((f) => f.name === 'Fighter Subclass')).toBe(false);
    // The result names the features and their book, never their text.
    expect(out.content).toContain('- Ember Ward (The Gloamwood Almanac) — get_character_sheet has its text');
    expect(out.content).toContain("Used the book's text instead of your description for: Ember Ward.");
    for (const marker of GLOAMWOOD_MARKERS) expect(out.content).not.toContain(marker);
    // The catalog reaches the engine (AC after the level).
    expect(vi.mocked(levelUp).mock.calls[0][1]).toMatchObject({ classId: FIGHTER.id, subclassId: EMBER.id, equipment: EXPECTED_MERGED.equipment });
  });

  it("adds an imported class's features at the new level, and multiclasses into it by name", async () => {
    const wick = classOf('lib:gloam:class:wickwright');
    const h = setup({ character: hero({ classId: wick.id, name: 'Wickwright', level: 3, hitDie: 8, casterType: 'half', spellcastingAbility: 'int' }) });
    await h.run('level_up', { class_name: 'Wickwright' });
    expect(h.sheet().features.find((f) => f.name === 'Ability Score Improvement')?.ref).toMatchObject({ entryId: wick.id, level: 4, textCopied: true });

    const m = setup({ character: hero({ classId: FIGHTER.id, name: 'Fighter', level: 3, hitDie: 10, subclass: 'Champion' }) });
    const out = await m.run('level_up', { class_name: 'wickwright' });
    expect(out.isError).toBeUndefined();
    expect(m.sheet().classes[1]).toMatchObject({ classId: wick.id, name: 'Wickwright', level: 1, hitDie: 8, casterType: 'half', spellcastingAbility: 'int', ref: { entryId: wick.id, kind: 'class' } });
    expect(m.sheet().features.map((f) => f.name)).toEqual(['Spellcasting', 'Wick Sense']);
  });

  it("chooses an older subclass with its early features and always-prepared spells (the ones the DM may consult)", async () => {
    const h = setup({ character: hero({ classId: 'srd:class:cleric', name: 'Cleric', level: 2, hitDie: 8, casterType: 'full', spellcastingAbility: 'wis' }) });
    const out = await h.run('level_up', { class_name: 'Cleric', subclass: 'Dusk Domain' });
    const c = h.sheet();
    expect(c.classes[0]).toMatchObject({ subclass: 'Dusk Domain', subclassId: DUSK.id });
    expect(c.features.filter((f) => f.source === 'subclass').map((f) => f.name)).toEqual(['Hearthlight Blessing', 'Channel Divinity: Settling Gloom']);
    expect(c.spellcasting?.spells.map((s) => [s.id, s.name, s.alwaysPrepared])).toEqual([
      ['srd:spell:faerie-fire', 'Faerie Fire', true],
      ['srd:spell:sleep', 'Sleep', true],
      [gloamwoodEntryId('Ashen Choir'), 'Ashen Choir', true],
    ]);
    expect(out.content).toContain('Always prepared now: Faerie Fire, Sleep, Ashen Choir (Dusk Domain).');
    // Darkness isn't in the rules here: added under the subclass's name, as the line says, no class counts it (SRD 5.2.1
    // srd:rule:gaining-spells: "a spell that you always have prepared doesn't count against the number of spells on that
    // list"), so the Cleric's choices stay open. The player's log names it only.
    expect(out.content).toContain(
      'Not in the rules you can consult: Darkness (Dusk Domain). If it applies, add it with update_character spells_add, source "Dusk Domain" (not a class\'s name: an always-prepared spell isn\'t one of its choices).',
    );
    const detail = toolLog(h, 'level_up')?.detail ?? '';
    expect(detail).toContain('Not in the rules here: Darkness (Dusk Domain).');
    expect(detail).not.toContain('update_character');
    const marks = h.sheet().spellcasting?.spellPicks;
    const added = await h.run('update_character', { spells_add: [{ name: 'Darkness', level: 2, source: 'Dusk Domain' }] });
    expect(added.content).not.toContain('Spell choices');
    expect(h.sheet().spellcasting?.spellPicks).toEqual(marks);
  });

  it('keeps a number of uses the DM ruled through a level-up, and lists no growth (FeatureUses.ruled; SRD 5.2.1 Fighter: Second Wind)', async () => {
    const wind = { id: 'f-wind', name: 'Second Wind', source: 'class' as const, sourceName: 'Fighter 1', description: 'Second Wind text.', uses: { max: 2, used: 1, recharge: 'short' as const } };
    const h = setup({ character: hero({ classId: FIGHTER.id, name: 'Fighter', level: 2, hitDie: 10 }, { features: [wind] }) });
    const ruling = { name: 'Second Wind', source: 'class', description: 'DM ruling: the blessing of the lantern gives you four uses.', uses_max: 4, recharge: 'short' };
    expect((await h.run('update_character', { features_add: [ruling] })).content).toContain('Updated feature: Second Wind');
    const out = await h.run('level_up', { class_name: 'Fighter' });
    expect(out.isError).toBeUndefined();
    expect(out.content).not.toContain('Second Wind 4 →');
    expect(out.content).not.toContain('grew with the level');
    // The result reminds the DM the number is its own.
    expect(out.content).toContain('Kept your ruling: Second Wind 4 uses (a new uses_max in features_add changes it).');
    expect(h.sheet().features).toEqual([{ ...wind, description: ruling.description, uses: { max: 4, used: 1, recharge: 'short', ruled: true } }]);
  });

  it("reminds the DM of every number of uses it ruled at a level-up, namesakes told apart, and of none when it ruled none", async () => {
    const h = setup({ character: hero({ classId: FIGHTER.id, name: 'Fighter', level: 2, hitDie: 10 }) });
    // Two of one name the DM added, then ruled on (another number each), and one the DM gave uses where it had none.
    await h.run('update_character', { features_add: [{ name: 'Lantern Luck', description: 'Invented trait.', source: 'species', uses_max: 1, recharge: 'short' }] });
    await h.run('update_character', { features_add: [{ name: 'Lantern Luck', description: 'Invented feat.', source: 'feat', uses_max: 3 }] });
    const quiet = await h.run('level_up', { class_name: 'Fighter' });
    expect(quiet.content).not.toContain('Kept your ruling');
    await h.run('update_character', { features_add: [{ name: 'Lantern Luck', description: 'DM ruling: twice.', source: 'species', uses_max: 2, recharge: 'short' }] });
    await h.run('update_character', { features_add: [{ name: 'Lantern Luck', description: 'DM ruling: once.', source: 'feat', uses_max: 1 }] });
    const out = await h.run('level_up', { class_name: 'Fighter' });
    expect(out.content).toContain('Kept your rulings: Lantern Luck (species) 2 uses and Lantern Luck (feat) 1 use (a new uses_max in features_add changes one).');
  });

  it('naming the hero’s own book subclass by the name it was given in review since adds none of its features again', async () => {
    const h = setup({ character: hero({ classId: FIGHTER.id, name: 'Fighter', level: 2, hitDie: 10 }) });
    expect((await h.run('level_up', { class_name: 'Fighter', subclass: 'Ember Warden' })).isError).toBeUndefined();
    const before = h.sheet().features.map((f) => [f.name, f.sourceName]);
    expect(before).toEqual(expect.arrayContaining([['Ember Ward', 'Ember Warden 3'], ['Kindled Strikes', 'Ember Warden 3']]));
    // The player renamed it in review: the same option id, a new name.
    const renamed = { ...EMBER, name: 'Ember Keeper' };
    const data: BuilderData = { ...EXPECTED_MERGED, classes: EXPECTED_MERGED.classes.map((c) => (c.id === FIGHTER.id ? { ...c, subclasses: c.subclasses.map((s) => (s.id === EMBER.id ? renamed : s)) } : c)) };
    const again = setup({ builderData: data, character: h.sheet() });
    expect((await again.run('level_up', { class_name: 'Fighter', subclass: 'Ember Keeper' })).isError).toBeUndefined();
    expect(again.sheet().features.filter((f) => f.name === 'Ember Ward' || f.name === 'Kindled Strikes')).toHaveLength(2);
    // Its id and ref stay, under the name it has now.
    expect(again.sheet().classes[0]).toMatchObject({ level: 4, subclass: 'Ember Keeper', subclassId: EMBER.id, subclassRef: { entryId: EMBER.id } });
  });

  it("a multiclass hero's other subclass's feature of the same name doesn't keep the new subclass's own off the sheet", async () => {
    // An invented book subclass of the SRD Fighter whose level-3 feature is named Fighting Style, and a Paladin's
    // invented oath with a feature of that name already on the sheet.
    const style = { level: 3, name: 'Fighting Style', description: 'Invented: the sentinel’s own style.', ref: { ...EMBER.features[0].ref!, entryId: 'lib:gloam:subclass:lamp-sentinel', entryName: 'Lamp Sentinel', part: 'Fighting Style' } };
    const sentinel: SubclassOption = { ...EMBER, id: 'lib:gloam:subclass:lamp-sentinel', name: 'Lamp Sentinel', features: [style] };
    const data: BuilderData = { ...EXPECTED_MERGED, classes: EXPECTED_MERGED.classes.map((c) => (c.id === FIGHTER.id ? { ...c, subclasses: [...c.subclasses, sentinel] } : c)) };
    const fighter2 = hero({ classId: FIGHTER.id, name: 'Fighter', level: 2, hitDie: 10 });
    const paladin: ClassLevel = { classId: 'srd:class:paladin', name: 'Paladin', level: 5, hitDie: 10, casterType: 'half', subclass: 'Oath of the Wick' };
    const oath = { id: 'f-oath', name: 'Fighting Style', source: 'subclass' as const, sourceName: 'Oath of the Wick 3', description: 'Invented: the oath’s own style.' };
    const h = setup({ builderData: data, character: { ...fighter2, classes: [...fighter2.classes, paladin], features: [oath] } });
    expect((await h.run('level_up', { class_name: 'Fighter', subclass: 'Lamp Sentinel' })).isError).toBeUndefined();
    expect(h.sheet().features.filter((f) => f.name === 'Fighting Style').map((f) => f.sourceName)).toEqual(['Oath of the Wick 3', 'Lamp Sentinel 3']);
  });

  it('names a tie between classes of the same name and uses the hero’s own', async () => {
    const importedFighter: ClassOption = { ...FIGHTER, id: 'lib:gloam:class:fighter', subclasses: [], source: { sourceId: 'gloam', title: GLOAMWOOD_TITLE, recordId: 'rec:gloam:class:fighter', format: '2024', adaptations: [] } };
    const data: BuilderData = { ...EXPECTED_MERGED, classes: [...EXPECTED_MERGED.classes, importedFighter] };
    const h = setup({ builderData: data, character: hero({ classId: FIGHTER.id, name: 'Fighter', level: 3, hitDie: 10, subclass: 'Champion' }) });
    const out = await h.run('level_up', { class_name: 'Fighter' });
    expect(out.content).toContain("Two classes are named Fighter (SRD 5.2.1, The Gloamwood Almanac); used the hero's own.");
    expect(h.sheet().classes).toHaveLength(1);
    expect(h.sheet().classes[0]).toMatchObject({ classId: FIGHTER.id, level: 4 });
  });

  describe("two books' Ember Wardens: the Gloamwood's attached to the SRD Fighter, another 2024 book's Fighter's own (shared)", () => {
    const ashen: OptionSource = { sourceId: 'ashen', title: 'The Ashen Folio', recordId: 'rec:ashen:class:fighter', format: '2024', adaptations: [] };
    const ashenEmber: SubclassOption = {
      ...EMBER,
      id: 'lib:ashen:subclass:ember-warden',
      source: { ...ashen, recordId: 'rec:ashen:subclass:ember-warden' },
      features: EMBER.features.map((f) => ({ ...f, ...(f.ref ? { ref: { ...f.ref, sourceId: 'ashen', sourceTitle: 'The Ashen Folio', bookFingerprint: 'fp-ashen', entryId: 'lib:ashen:subclass:ember-warden' } } : {}) })),
    };
    const ashenFighter: ClassOption = { ...FIGHTER, id: 'lib:ashen:class:fighter', source: ashen, subclasses: [ashenEmber], sharedSubclasses: [...FIGHTER.subclasses] };
    const withAshen = (srd: ClassOption): BuilderData => ({
      ...EXPECTED_MERGED,
      classes: [...EXPECTED_MERGED.classes.map((c) => (c.id === FIGHTER.id ? { ...srd, sharedSubclasses: [ashenEmber] } : c)), ashenFighter],
    });

    it('a hero on the SRD Fighter who names it takes the one attached to the SRD Fighter, by id, and says so', async () => {
      const h = setup({ builderData: withAshen(FIGHTER), character: hero({ classId: FIGHTER.id, name: 'Fighter', level: 2, hitDie: 10 }) });
      const out = await h.run('level_up', { class_name: 'Fighter', subclass: 'Ember Warden' });
      expect(h.sheet().classes[0]).toMatchObject({ level: 3, subclass: 'Ember Warden', subclassId: EMBER.id });
      expect(h.sheet().features.map((f) => f.name)).toEqual(expect.arrayContaining(['Ember Ward', 'Kindled Strikes']));
      expect(out.content).toContain(`Two subclasses of Fighter are named Ember Warden (${GLOAMWOOD_TITLE}, The Ashen Folio); used the one from ${GLOAMWOOD_TITLE}.`);
    });

    it("a hero on the SRD Fighter with the other book's (by id) gets its later features", async () => {
      const subclassRef = importedRef({ entryId: ashenEmber.id, kind: 'subclass', entryName: 'Ember Warden', sourceId: 'ashen', sourceTitle: 'The Ashen Folio', bookFingerprint: 'fp-ashen' });
      const h = setup({ builderData: withAshen(FIGHTER), character: hero({ classId: FIGHTER.id, name: 'Fighter', level: 6, hitDie: 10, subclass: 'Ember Warden', subclassId: ashenEmber.id, subclassRef }) });
      const out = await h.run('level_up', { class_name: 'Fighter' });
      expect(h.sheet().features.map((f) => f.name)).toContain('Smoke Step');
      expect(out.content).toContain('- Smoke Step (The Ashen Folio)');
    });

    it("keeps the other book's (by id) once its class is renamed in review and the classes no longer share", async () => {
      const renamed: BuilderData = { ...EXPECTED_MERGED, classes: [...EXPECTED_MERGED.classes, { ...ashenFighter, name: 'Fighter (Ashen)', sharedSubclasses: undefined }] };
      const subclassRef = importedRef({ entryId: ashenEmber.id, kind: 'subclass', entryName: 'Ember Warden', sourceId: 'ashen', sourceTitle: 'The Ashen Folio', bookFingerprint: 'fp-ashen' });
      const h = setup({ builderData: renamed, character: hero({ classId: FIGHTER.id, name: 'Fighter', level: 6, hitDie: 10, subclass: 'Ember Warden', subclassId: ashenEmber.id, subclassRef }) });
      const out = await h.run('level_up', { class_name: 'Fighter' });
      expect(out.content).toContain('- Smoke Step (The Ashen Folio)');
    });

    it("with the hero's book switched off, the hero's subclass never turns into the other book's", async () => {
      const switchedOff: ClassOption = { ...FIGHTER, subclasses: FIGHTER.subclasses.filter((s) => !s.source) };
      const subclassRef = importedRef({ entryId: EMBER.id, kind: 'subclass', entryName: 'Ember Warden' });
      const h = setup({ builderData: withAshen(switchedOff), character: hero({ classId: FIGHTER.id, name: 'Fighter', level: 6, hitDie: 10, subclass: 'Ember Warden', subclassId: EMBER.id, subclassRef }) });
      const out = await h.run('level_up', { class_name: 'Fighter' });
      expect(out.isError).toBeUndefined();
      expect(h.sheet().features.map((f) => f.name)).not.toContain('Smoke Step');
      expect(out.content).not.toContain("Features from the player's books");
      expect(h.sheet().classes[0]).toMatchObject({ level: 7, subclassId: EMBER.id, subclassRef });
    });
  });

  describe('B2: a subclass the hero already has, named again', () => {
    // A book reprinting an SRD subclass's name (invented features): it sits beside the SRD Champion.
    const bookChampion: SubclassOption = {
      ...EMBER,
      id: 'lib:gloam:subclass:champion',
      name: 'Champion',
      features: [
        ...EMBER.features.filter((f) => f.level === 3),
        { level: 7, name: 'Lantern Stride', description: 'Invented: you stride through dim light.', ref: importedRef({ entryId: 'lib:gloam:subclass:champion', kind: 'subclass', entryName: 'Champion', part: 'Lantern Stride', level: 7, textHash: 'h', textCopied: true }) },
      ],
    };
    const data: BuilderData = { ...EXPECTED_MERGED, classes: EXPECTED_MERGED.classes.map((c) => (c.id === FIGHTER.id ? { ...c, subclasses: [...c.subclasses, bookChampion] } : c)) };
    const subclassRef = importedRef({ entryId: bookChampion.id, kind: 'subclass', entryName: 'Champion' });

    it("keeps the hero's book subclass, its later features and its rules (no SRD Improved Critical)", async () => {
      const h = setup({ builderData: data, character: hero({ classId: FIGHTER.id, name: 'Fighter', level: 6, hitDie: 10, subclass: 'Champion', subclassId: bookChampion.id, subclassRef }) });
      expect(weaponCritRange(h.sheet())).toBe(20);
      const out = await h.run('level_up', { class_name: 'Fighter', subclass: 'Champion' });
      expect(out.isError).toBeUndefined();
      const c = h.sheet();
      expect(c.classes[0]).toMatchObject({ level: 7, subclass: 'Champion', subclassId: bookChampion.id, subclassRef });
      expect(c.features.map((f) => f.name)).toEqual(['Lantern Stride']);
      expect(weaponCritRange(c)).toBe(20);
      expect(out.content).toContain('- Lantern Stride (The Gloamwood Almanac) — get_character_sheet has its text');
    });

    it("a new name a 2024 book's subclass shares with the SRD's takes the book's (the one the player's list offers), and says so", async () => {
      expect(bookChampion.source?.format).toBe('2024');
      const h = setup({ builderData: data, character: hero({ classId: FIGHTER.id, name: 'Fighter', level: 2, hitDie: 10 }) });
      const out = await h.run('level_up', { class_name: 'Fighter', subclass: 'Champion' });
      expect(h.sheet().classes[0]).toMatchObject({ level: 3, subclass: 'Champion', subclassId: bookChampion.id });
      expect(h.sheet().classes[0].subclassRef?.entryId).toBe(bookChampion.id);
      expect(out.content).toContain('Two subclasses of Fighter are named Champion (SRD 5.2.1, The Gloamwood Almanac); used the one from The Gloamwood Almanac.');
    });

    it("a new name an older book's subclass shares takes the SRD's, says so, and keeps no book ref on it", async () => {
      const older: SubclassOption = { ...bookChampion, source: { ...(bookChampion.source as OptionSource), format: '2014' } };
      const olderData: BuilderData = { ...EXPECTED_MERGED, classes: EXPECTED_MERGED.classes.map((c) => (c.id === FIGHTER.id ? { ...c, subclasses: [...c.subclasses, older] } : c)) };
      const h = setup({ builderData: olderData, character: hero({ classId: FIGHTER.id, name: 'Fighter', level: 2, hitDie: 10 }) });
      const out = await h.run('level_up', { class_name: 'Fighter', subclass: 'Champion' });
      expect(h.sheet().classes[0]).toMatchObject({ level: 3, subclass: 'Champion', subclassId: 'srd:subclass:champion' });
      expect(h.sheet().classes[0].subclassRef).toBeUndefined();
      expect(out.content).toContain('Two subclasses of Fighter are named Champion (SRD 5.2.1, The Gloamwood Almanac); used the one from SRD 5.2.1.');
    });
  });

  it("a hero on a 2024 book's Fighter who takes the SRD Champion it shares gets the Champion's features (as the dialog adds them)", async () => {
    const srdFighter = EXPECTED_MERGED.classes.find((c) => c.id === FIGHTER.id)!;
    const bookFighter: ClassOption = { ...srdFighter, id: 'lib:gloam:class:fighter', subclasses: [], sharedSubclasses: [...srdFighter.subclasses], source: { sourceId: 'gloam', title: GLOAMWOOD_TITLE, recordId: 'rec:gloam:class:fighter', format: '2024', adaptations: [] } };
    const champion = srdFighter.subclasses.find((s) => s.name === 'Champion')!;
    const data: BuilderData = { ...EXPECTED_MERGED, classes: [...EXPECTED_MERGED.classes, bookFighter] };
    const h = setup({ builderData: data, character: hero({ classId: bookFighter.id, name: 'Fighter', level: 2, hitDie: 10 }) });
    const out = await h.run('level_up', { class_name: 'Fighter', subclass: 'Champion' });
    expect(out.isError).toBeUndefined();
    expect(h.sheet().classes[0]).toMatchObject({ level: 3, subclassId: champion.id });
    const level3 = champion.features.filter((f) => f.level === 3).map((f) => f.name);
    expect(level3.length).toBeGreaterThan(0);
    for (const name of level3) expect(h.sheet().features.map((f) => f.name)).toContain(name);
  });

  it("tells the DM the player still chooses the Champion's Additional Fighting Style (SRD 5.2.1 Champion, level 7)", async () => {
    const h = setup({ character: hero({ classId: FIGHTER.id, name: 'Fighter', level: 6, hitDie: 10, subclass: 'Champion', subclassId: 'srd:subclass:champion' }) });
    const out = await h.run('level_up', { class_name: 'Fighter', new_features: [{ name: 'Additional Fighting Style', description: 'You gain another Fighting Style feat of your choice.' }] });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('Choices the player still needs to make:');
    expect(out.content).toContain('- Fighter 7: Additional Fighting Style — choose another Fighting Style.');
  });

  it("checks the hero's own book class's prerequisites even when the new class isn't in the data", async () => {
    const bookCleric: ClassOption = { ...CLERIC_OPTION, id: 'lib:gloam:class:cleric', subclasses: [], source: { sourceId: 'gloam', title: GLOAMWOOD_TITLE, recordId: 'rec:gloam:class:cleric', format: '2024', adaptations: [] } };
    const data: BuilderData = { ...EXPECTED_MERGED, classes: [...EXPECTED_MERGED.classes, bookCleric] };
    const base = hero({ classId: bookCleric.id, name: 'Cleric', level: 3, hitDie: 8, casterType: 'full', spellcastingAbility: 'wis' });
    const h = setup({ builderData: data, character: { ...base, abilityScores: { ...base.abilityScores, wis: 8 } } });
    const out = await h.run('level_up', { class_name: 'Lamp Seeker', hit_die: 10 });
    expect(out.content).toMatch(/Multiclass prerequisite not met: Cleric needs 13\+ \(Wisdom 8\)/);
  });

  it("says the SRD's text, not the book's, replaced the DM's words for an SRD subclass under a book's class", async () => {
    const srdFighter = EXPECTED_MERGED.classes.find((c) => c.id === FIGHTER.id)!;
    const bookFighter: ClassOption = { ...srdFighter, id: 'lib:gloam:class:fighter', subclasses: [], sharedSubclasses: [...srdFighter.subclasses], source: { sourceId: 'gloam', title: GLOAMWOOD_TITLE, recordId: 'rec:gloam:class:fighter', format: '2024', adaptations: [] } };
    const feature = srdFighter.subclasses.find((s) => s.name === 'Champion')!.features.find((f) => f.level === 3)!;
    const data: BuilderData = { ...EXPECTED_MERGED, classes: [...EXPECTED_MERGED.classes, bookFighter] };
    const h = setup({ builderData: data, character: hero({ classId: bookFighter.id, name: 'Fighter', level: 2, hitDie: 10 }) });
    const out = await h.run('level_up', { class_name: 'Fighter', subclass: 'Champion', new_features: [{ name: feature.name, description: 'A ruling of the DM.' }] });
    expect(out.content).toContain(`Used the SRD's text instead of your description for: ${feature.name}.`);
    expect(out.content).not.toContain("Used the book's text");
  });

  it("warns when the hero doesn't meet a book class's multiclass prerequisites, as for the SRD's", async () => {
    const bookCleric: ClassOption = { ...CLERIC_OPTION, id: 'lib:gloam:class:cleric', subclasses: [], source: { sourceId: 'gloam', title: GLOAMWOOD_TITLE, recordId: 'rec:gloam:class:cleric', format: '2024', adaptations: [] } };
    const data: BuilderData = { ...EXPECTED_MERGED, classes: [...EXPECTED_MERGED.classes, bookCleric] };
    const base = hero({ classId: FIGHTER.id, name: 'Fighter', level: 3, hitDie: 10, subclass: 'Champion' });
    const h = setup({ builderData: data, character: { ...base, abilityScores: { ...base.abilityScores, wis: 8 } } });
    const out = await h.run('level_up', { class_name: 'Cleric' });
    expect(h.sheet().classes.map((cl) => cl.classId)).toEqual([FIGHTER.id, bookCleric.id]);
    expect(out.content).toMatch(/Multiclass prerequisite not met: Cleric needs 13\+ \(Wisdom 8\)/);
  });

  it("multiclasses into a 2024 book's class in place of the SRD class of its name (the player's lists offer the book's)", async () => {
    const bookCleric: ClassOption = { ...CLERIC_OPTION, id: 'lib:gloam:class:cleric', subclasses: [], source: { sourceId: 'gloam', title: GLOAMWOOD_TITLE, recordId: 'rec:gloam:class:cleric', format: '2024', adaptations: [] } };
    const data: BuilderData = { ...EXPECTED_MERGED, classes: [...EXPECTED_MERGED.classes, bookCleric] };
    const h = setup({ builderData: data, character: hero({ classId: FIGHTER.id, name: 'Fighter', level: 3, hitDie: 10, subclass: 'Champion' }) });
    const out = await h.run('level_up', { class_name: 'Cleric' });
    expect(h.sheet().classes.map((cl) => cl.classId)).toEqual([FIGHTER.id, bookCleric.id]);
    expect(out.content).toContain('Two classes are named Cleric (SRD 5.2.1, The Gloamwood Almanac); used the one from The Gloamwood Almanac.');
  });

  it('B6: a 2014 subclass chosen at level 3 brings its older-edition notes to the sheet text and the result, once', async () => {
    const h = setup({ character: hero({ classId: 'srd:class:cleric', name: 'Cleric', level: 2, hitDie: 8, casterType: 'full', spellcastingAbility: 'wis' }) });
    const out = await h.run('level_up', { class_name: 'Cleric', subclass: 'Dusk Domain' });
    const notes = (DUSK.source?.adaptations ?? []).map((a) => a.note);
    expect(notes.map((n) => n.slice(0, 26))).toEqual(['Older edition: you choose ', 'Written for the older rule']);
    expect(h.sheet().adaptationNotes).toEqual(notes);
    expect(characterSheetText(h.sheet())).toContain(['### Older-edition options (app notes)', ...notes.map((n) => `- ${n}`)].join('\n'));
    expect(out.content).toContain(['Older-edition notes now on the sheet (app notes):', ...notes.map((n) => `- ${n}`)].join('\n'));
    const next = await h.run('level_up', { class_name: 'Cleric' });
    expect(h.sheet().adaptationNotes).toEqual(notes);
    expect(next.content).not.toContain('Older-edition notes');
  });

  it("B8: a book's class named like an SRD class keeps its feature's own uses (no SRD Second Wind table)", async () => {
    const SECOND_WIND = 'You have a limited well of stamina. As a Bonus Action, you can regain Hit Points equal to 1d10 plus your Fighter level. Once you use this feature, you must finish a Short or Long Rest before you can use it again.';
    const ref = importedRef({ entryId: 'lib:gloam:class:fighter', kind: 'class', entryName: 'Fighter', part: 'Second Wind', level: 1, textCopied: true });
    const bookFighter: ClassOption = {
      ...FIGHTER,
      id: 'lib:gloam:class:fighter',
      source: { sourceId: 'gloam', title: GLOAMWOOD_TITLE, recordId: 'rec:gloam:class:fighter', format: '2014', adaptations: [] },
      features: [{ level: 1, name: 'Second Wind', description: SECOND_WIND, ref }],
      levelTable: FIGHTER.levelTable.map(({ level, proficiencyBonus, features }) => ({ level, proficiencyBonus, features })),
      subclasses: [],
    };
    const data: BuilderData = { ...EXPECTED_MERGED, classes: [...EXPECTED_MERGED.classes, bookFighter] };
    const wind = { id: 'wind', name: 'Second Wind', source: 'class' as const, sourceName: 'Fighter 1', description: SECOND_WIND, uses: { max: 1, used: 0, recharge: 'short' as const }, ref };
    const h = setup({ builderData: data, character: hero({ classId: bookFighter.id, name: 'Fighter', level: 1, hitDie: 10 }, { features: [wind] }) });
    const out = await h.run('level_up', { class_name: 'Fighter' });
    expect(h.sheet().classes[0]).toMatchObject({ classId: bookFighter.id, level: 2 });
    expect(h.sheet().features.find((f) => f.name === 'Second Wind')?.uses?.max).toBe(1);
    expect(out.content).not.toContain('Second Wind: 1 → 2');
  });

  it('levels an SRD class exactly as without builder data (the DM supplies its features)', async () => {
    const start = hero({ classId: FIGHTER.id, name: 'Fighter', level: 3, hitDie: 10, subclass: 'Champion', subclassId: 'srd:subclass:champion' });
    const input = { class_name: 'Fighter', new_features: [{ name: 'Ability Score Improvement', description: 'Raise scores or take a feat.' }] };
    const withData = setup({ character: start });
    const withoutData = setup({ character: start, builderData: null });
    const a = await withData.run('level_up', input);
    const b = await withoutData.run('level_up', input);
    const strip = (c: Character) => ({ ...c, features: c.features.map(({ id: _id, ...f }) => f), updatedAt: 0 });
    expect(strip(withData.sheet())).toEqual(strip(withoutData.sheet()));
    expect(a.content).toBe(b.content);
    expect(withData.sheet().features).toEqual([expect.objectContaining({ name: 'Ability Score Improvement', source: 'class', sourceName: 'Fighter 4', description: 'Raise scores or take a feat.' })]);
    expect(withData.sheet().features[0].ref).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Spell picks (src/data/options/spellPicks.ts) on the SRD's own class tables
// ---------------------------------------------------------------------------

const SRD_SPELLS = (JSON.parse(compendiumRaw) as CompendiumEntry[]).filter((e) => e.kind === 'spell');
const srdSpell = (name: string): CompendiumEntry => {
  const found = SRD_SPELLS.find((e) => e.name === name);
  if (!found) throw new Error(`no SRD spell ${name}`);
  return found;
};
/** The test's rules index with these SRD 5.2.1 spells added (the always-prepared ones a level-up looks up). */
const rulesWith = (...names: string[]): CompendiumEntry[] => [...RULES, ...names.map(srdSpell)];
/** An SRD spell on the sheet as the builder records it: the entry's id and flags, with this source. */
const held = (name: string, source: string, extra: Partial<KnownSpell> = {}): KnownSpell => knownSpellFromEntry(srdSpell(name), { source, ...extra })!;
/** `n` placeholder spells of a class: exactly what counts, nothing the rules index knows. */
const fill = (className: string, n: number, level: number, prepared = true): KnownSpell[] =>
  Array.from({ length: n }, (_, i) => ({ id: `fill-${className}-${level}-${i}`, name: `${className} spell ${level}-${i}`, level, prepared, source: className }));
const srdOption = (name: string): ClassOption => {
  const found = SRD_BUILDER_DATA.classes.find((c) => c.name === name);
  if (!found) throw new Error(`no SRD class ${name}`);
  return found;
};
const srdEntry = (name: string, level: number, extra: Partial<ClassLevel> = {}): ClassLevel => {
  const o = srdOption(name);
  return { classId: o.id, name: o.name, level, hitDie: o.hitDie, casterType: o.casterType, ...(o.spellcastingAbility ? { spellcastingAbility: o.spellcastingAbility } : {}), ...extra };
};
/** A hero of one SRD class holding these spells, with the slots its level gives. */
function caster(name: string, level: number, spells: KnownSpell[], extra: Partial<ClassLevel> = {}): Character {
  const cl = srdEntry(name, level, extra);
  const base = hero(cl);
  return recomputeSlots({ ...base, spellcasting: { ability: cl.spellcastingAbility ?? 'int', slots: {}, spells, concentratingOn: null } });
}
const toolLog = (h: ReturnType<typeof setup>, tool: string) =>
  (h.s().log as { kind: string; tool?: string; summary?: string; detail?: string }[]).filter((e) => e.kind === 'tool' && e.tool === tool).at(-1);
const RECORD_WIZARD =
  'The player chooses these on their sheet\'s Spells tab, and you\'ll get a note. If they tell you their choices instead, record each with update_character spells_add, source "Wizard" (prepared: false for a spell only added to the spellbook; a spell copied into it, or one a feature adds to it free: source "Wizard (copied)", prepared false unless the player prepares it; to prepare a spell already in it: re-add it by name with prepared true and no source).';

describe('level_up: always-prepared spells and the spell choices still open (SRD 5.2.1, each class\'s Spellcasting)', () => {
  it("Wizard 3 → 4: one line with the sheet's numbers in place of the engine's generic one, and the choices marked open (srd:rule:wizard-spellcasting)", async () => {
    // "Whenever you gain a Wizard level after 1, add two Wizard spells of your choice to your spellbook"; the table's
    // Cantrips 3 → 4 and Prepared Spells 6 → 7. The sample Wizard holds 3 Wizard cantrips (its High Elf cantrip isn't
    // the Wizard's) and a 6-spell book, 5 of them prepared, where a Wizard 4's book holds at least 6 + 2 × 3 = 12.
    const h = setup({ builderData: SRD_BUILDER_DATA });
    const out = await h.run('level_up', { class_name: 'Wizard' });
    expect(out.isError).toBeUndefined();
    // The book catches up from six: each level's two of a level its slots reached then (Wizard 2's: level 1), the book's
    // two level 2 spells holding two of the level 2 places.
    const line = 'Spell choices: Wizard 4 (spells of level 1–2): up to 1 cantrip (the sheet has 3 of 4), 6 spellbook spells (6 of at least 12: 2 up to level 2 and 4 of level 1) and 2 prepared spells (5 of 7).';
    expect(out.content).toContain(`${line} ${RECORD_WIZARD}`);
    expect(out.content).not.toContain('Review your Wizard cantrips');
    expect(out.content).toContain(['Choices the player still needs to make:', '- Wizard 4: Ability Score Improvement — raise one score by 2 or two scores by 1 (max 20), or take another feat you qualify for.', line].join('\n'));
    expect(h.sheet().spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:wizard' }]);
    // The player's log has the choices too, without the DM's note on recording them.
    const detail = toolLog(h, 'level_up')?.detail ?? '';
    expect(detail.split('\n').at(-1)).toBe(line);
    expect(detail).not.toContain('update_character');
    expect(detail).not.toContain('Review your Wizard cantrips');
  });

  it("Paladin 1 → 2: Divine Smite always prepared from Paladin's Smite, outside the count (srd:rule:paladin-s-smite)", async () => {
    // "You always have the Divine Smite spell prepared"; "If another Paladin feature gives you spells that you always have
    // prepared, those spells don't count against the number of spells you can prepare" (Prepared Spells 2 → 3).
    const start = caster('Paladin', 1, [held('Bless', 'Paladin'), held('Command', 'Paladin')]);
    const h = setup({ builderData: SRD_BUILDER_DATA, rules: rulesWith('Divine Smite'), character: start });
    const out = await h.run('level_up', { class_name: 'Paladin' });
    expect(h.sheet().spellcasting?.spells.find((s) => s.name === 'Divine Smite')).toEqual({
      id: 'srd:spell:divine-smite',
      name: 'Divine Smite',
      level: 1,
      prepared: true,
      alwaysPrepared: true,
      source: "Paladin's Smite",
    });
    expect(out.content).toContain("Always prepared now: Divine Smite (Paladin's Smite).");
    expect(out.content).toContain('Spell choices: Paladin 2 (level 1 spells): up to 1 prepared spell (2 of 3). The player chooses these on their sheet');
    // A Paladin keeps no spellbook and has no cantrips to review.
    expect(out.content).not.toContain('prepared: false for a spell only added to the spellbook');
    expect(out.content).not.toContain('Review your Paladin cantrips');
    expect(h.sheet().spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:paladin' }]);
    expect(toolLog(h, 'level_up')?.detail).toContain("Always prepared now: Divine Smite (Paladin's Smite).");
    // A name the rules the DM may consult don't have is the DM's to add, as before.
    const unknown = setup({ builderData: SRD_BUILDER_DATA, character: start });
    const told = await unknown.run('level_up', { class_name: 'Paladin' });
    expect(told.content).toContain(
      'Not in the rules you can consult: Divine Smite (Paladin\'s Smite). If it applies, add it with update_character spells_add, source "Paladin\'s Smite" (not a class\'s name: an always-prepared spell isn\'t one of its choices).',
    );
    expect(unknown.sheet().spellcasting?.spells.map((s) => s.name)).toEqual(['Bless', 'Command']);
  });

  it('Paladin 5 → 6 at its table: nothing to choose, so no choices line, no generic line, and the older mark is gone (srd:rule:paladin-spellcasting)', async () => {
    // The Paladin table's Prepared Spells stay 6 at levels 5 and 6; it has no Cantrips column and no swap on gaining a level.
    const always = { alwaysPrepared: true };
    const spells = [
      held('Divine Smite', "Paladin's Smite", always),
      held('Find Steed', 'Faithful Steed', always),
      ...['Bless', 'Command', 'Cure Wounds', 'Heroism', 'Shield of Faith', 'Protection from Evil and Good'].map((n) => held(n, 'Paladin')),
    ];
    const start = caster('Paladin', 5, spells);
    // Paladin 5's choices, left open on the sheet: the newer level replaces them.
    const marked: Character = { ...start, spellcasting: { ...start.spellcasting!, spellPicks: [{ classId: 'srd:class:paladin' }] } };
    const h = setup({ builderData: SRD_BUILDER_DATA, character: marked });
    const out = await h.run('level_up', { class_name: 'Paladin' });
    expect(out.isError).toBeUndefined();
    expect(out.content).not.toContain('Spell choices');
    expect(out.content).not.toContain('Review your Paladin');
    expect(out.content).not.toContain('Always prepared now');
    expect(out.content).toContain('- New Paladin 6 features to add to the sheet: Aura of Protection.');
    expect(h.sheet().spellcasting).not.toHaveProperty('spellPicks');
    expect(h.sheet().spellcasting?.spells).toEqual(spells);
  });

  it("Life Cleric 2 → 3: the domain's Bless and Cure Wounds, picked before, turn always prepared and free their places (srd:rule:cleric-life-domain-spells)", async () => {
    // "you thereafter always have the listed spells prepared" (Cleric 3: Aid, Bless, Cure Wounds, Lesser Restoration);
    // "If another Cleric feature gives you spells that you always have prepared, those spells don't count against the
    // number of spells you can prepare with this feature" (srd:rule:cleric-spellcasting; Prepared Spells 5 → 6).
    const cantrips = ['Guidance', 'Sacred Flame', 'Thaumaturgy'].map((n) => held(n, 'Cleric'));
    const picks = ['Bless', 'Cure Wounds', 'Guiding Bolt', 'Shield of Faith', 'Sanctuary'].map((n) => held(n, 'Cleric'));
    const h = setup({ builderData: SRD_BUILDER_DATA, rules: rulesWith('Aid', 'Lesser Restoration'), character: caster('Cleric', 2, [...cantrips, ...picks]) });
    const out = await h.run('level_up', { class_name: 'Cleric', subclass: 'Life Domain' });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('Always prepared now: Aid, Lesser Restoration (Life Domain).');
    expect(out.content).toContain("Now always prepared, no longer counted among the Cleric's spells: Bless, Cure Wounds.");
    const spells = h.sheet().spellcasting?.spells ?? [];
    expect(spells.filter((s) => s.alwaysPrepared).map((s) => [s.id, s.source])).toEqual([
      ['srd:spell:bless', 'Life Domain'],
      ['srd:spell:cure-wounds', 'Life Domain'],
      ['srd:spell:aid', 'Life Domain'],
      ['srd:spell:lesser-restoration', 'Life Domain'],
    ]);
    // Three of the table's six are left the Cleric's own: three to choose where keeping them counted would leave one.
    // A Cleric may also replace a cantrip on gaining a level ("Whenever you gain a Cleric level, you can replace one of
    // your cantrips").
    expect(out.content).toContain('Spell choices: Cleric 3 (spells of level 1–2): up to 3 prepared spells (3 of 6); may also replace one cantrip.');
    expect(h.sheet().spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:cleric', replaceCantrip: true }]);
    expect(toolLog(h, 'level_up')?.detail).toContain("Now always prepared, no longer counted among the Cleric's spells: Bless, Cure Wounds.");
  });

  it('a spell the DM granted turns always prepared too, but leaves no class\'s count, so it is named with the new spells', async () => {
    const granted = held('Bless', 'Granted in play');
    const h = setup({ builderData: SRD_BUILDER_DATA, rules: rulesWith('Aid', 'Cure Wounds', 'Lesser Restoration'), character: caster('Cleric', 2, [granted]) });
    const out = await h.run('level_up', { class_name: 'Cleric', subclass: 'Life Domain' });
    expect(out.content).toContain('Always prepared now: Aid, Cure Wounds, Lesser Restoration, Bless (Life Domain).');
    expect(out.content).not.toContain('no longer counted');
    expect(h.sheet().spellcasting?.spells[0]).toMatchObject({ id: 'srd:spell:bless', alwaysPrepared: true, source: 'Life Domain' });
  });

  it('Sorcerer 5 → 6: one new prepared spell, and the swaps the level allows, in the line (srd:rule:sorcerer-spellcasting)', async () => {
    // "Whenever you gain a Sorcerer level, you can replace one spell on your list with another Sorcerer spell for which
    // you have spell slots" and "one of your cantrips"; the table: Cantrips 5 at both levels, Prepared Spells 9 → 10.
    const h = setup({ builderData: SRD_BUILDER_DATA, character: caster('Sorcerer', 5, [...fill('Sorcerer', 5, 0), ...fill('Sorcerer', 9, 1)]) });
    const out = await h.run('level_up', { class_name: 'Sorcerer' });
    expect(out.content).toContain(
      'Spell choices: Sorcerer 6 (spells of level 1–3): up to 1 prepared spell (9 of 10); may also replace one spell and one cantrip. The player chooses these on their sheet\'s Spells tab, and you\'ll get a note. If they tell you their choices instead, record each with update_character spells_add, source "Sorcerer", and spells_remove for one they give up.',
    );
    expect(out.content).not.toContain('Review your Sorcerer');
    expect(h.sheet().spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:sorcerer', replaceSpell: true, replaceCantrip: true }]);
  });

  it("Wizard 3 multiclassing into Cleric 1: the Cleric's level-1 choices at its own cap, no swaps (srd:rule:multiclassing-class-features-spellcasting)", async () => {
    // "You determine what spells you can prepare for each class individually, as if you were a single-classed member of
    // that class": a Cleric 1's three cantrips and four level 1 spells, though the combined slots reach level 2.
    const h = setup({ builderData: SRD_BUILDER_DATA });
    const out = await h.run('level_up', { class_name: 'Cleric' });
    expect(h.sheet().classes.map((cl) => `${cl.name} ${cl.level}`)).toEqual(['Wizard 3', 'Cleric 1']);
    expect(h.sheet().spellcasting?.slots[2]?.max).toBeGreaterThan(0);
    expect(out.content).toContain('Spell choices: Cleric 1 (level 1 spells): up to 3 cantrips (the sheet has 0 of 3) and 4 prepared spells (0 of 4). The player chooses');
    expect(out.content).toContain('source "Cleric".');
    // Nothing to replace at a class's level 1; and the Wizard's spells are the Wizard's, not the Cleric's.
    expect(out.content).not.toContain('may also replace');
    expect(out.content).not.toContain('Review your Cleric');
    expect(out.content).toContain('- Cleric 1: choose your Divine Order.');
    expect(h.sheet().spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:cleric' }]);
  });

  it("keeps today's text exactly without the builder data, or for a class whose table can't be counted", async () => {
    // Captured before spell picks: the engine's generic line, and no mark on the sheet.
    const TODAY = [
      'Level up! Level 4 (Wizard) · HP +5 (max 22)',
      'Reached level 4 (Wizard 4): +5 HP (fixed 4 +1 CON) → HP max 22.',
      'Choices the player still needs to make:',
      '- Wizard 4: Ability Score Improvement — raise one score by 2 or two scores by 1 (max 20), or take another feat you qualify for.',
      '- Review your Wizard cantrips and prepared spells for level 4 (see the class table).',
      'Status: Mira Voss (Wizard 4) · HP 17/22 · AC 12 · Slots 1st 3/4, 2nd 3/3 · Hit Dice 3/4 d6 · Heroic Inspiration',
    ].join('\n');
    const none = setup({ builderData: null });
    expect((await none.run('level_up', { class_name: 'Wizard' })).content).toBe(TODAY);
    expect(none.sheet().spellcasting).not.toHaveProperty('spellPicks');
    expect(toolLog(none, 'level_up')?.detail?.split('\n').at(-1)).toBe('Review your Wizard cantrips and prepared spells for level 4 (see the class table).');
    // A Wizard whose table has neither a Cantrips nor a Prepared Spells column (as a book's class without them) can't be
    // counted: the same text, and nothing marked.
    const columnless: BuilderData = {
      ...SRD_BUILDER_DATA,
      classes: SRD_BUILDER_DATA.classes.map((c) => (c.name === 'Wizard' ? { ...c, levelTable: c.levelTable.map(({ level, proficiencyBonus, features }) => ({ level, proficiencyBonus, features })) } : c)),
    };
    const uncounted = setup({ builderData: columnless });
    expect((await uncounted.run('level_up', { class_name: 'Wizard' })).content).toBe(TODAY);
    expect(uncounted.sheet().spellcasting).not.toHaveProperty('spellPicks');
  });

  it('two levels before choosing: one open mark, counted live from the table, once (srd:rule:wizard-spellcasting)', async () => {
    // "choose additional Wizard spells until the number of spells on your list matches the number in the table": a Wizard
    // 5 has 4 cantrips, 9 prepared and a book of at least 6 + 2 × 4 = 14 (spells of level 1–3), however many levels passed.
    const h = setup({ builderData: SRD_BUILDER_DATA });
    await h.run('level_up', { class_name: 'Wizard' });
    const out = await h.run('level_up', { class_name: 'Wizard' });
    expect(h.sheet().spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:wizard' }]);
    expect(out.content).toContain('Spell choices: Wizard 5 (spells of level 1–3): up to 1 cantrip (the sheet has 3 of 4), 8 spellbook spells (6 of at least 14: 2 up to level 3, 2 up to level 2 and 4 of level 1) and 4 prepared spells (5 of 9).');
    // A cantrip the DM recorded between the levels, as the result says to, counts at once.
    const recorded = setup({ builderData: SRD_BUILDER_DATA });
    await recorded.run('level_up', { class_name: 'Wizard' });
    expect((await recorded.run('update_character', { spells_add: [{ name: 'Ray of Frost', level: 0, source: 'Wizard' }] })).isError).toBeUndefined();
    const live = await recorded.run('level_up', { class_name: 'Wizard' });
    expect(live.content).toContain('Spell choices: Wizard 5 (spells of level 1–3): up to 8 spellbook spells (6 of at least 14: 2 up to level 3, 2 up to level 2 and 4 of level 1) and 4 prepared spells (5 of 9).');
    expect(recorded.sheet().spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:wizard' }]);
  });
});

/** A hero of these SRD class entries (first class's spellcasting ability) holding these spells, with their slots. */
function multiCaster(entries: ClassLevel[], spells: KnownSpell[]): Character {
  const base = caster(entries[0].name, entries[0].level, spells);
  return recomputeSlots({ ...base, classes: entries, hitDice: entries.map((cl) => ({ die: cl.hitDie, total: cl.level, spent: 0 })) });
}
const recordHint = (className: string, extra = '') =>
  `The player chooses these on their sheet's Spells tab, and you'll get a note. If they tell you their choices instead, record each with update_character spells_add, source "${className}"${extra}.`;

describe('level_up and update_character: other classes, spellbooks and choices the DM records (SRD 5.2.1, each class\'s Spellcasting)', () => {
  it("Cleric 5 / Paladin 2 → Paladin 3, Oath of Devotion: the Cleric's Shield of Faith turns always prepared, and the Cleric may choose another (srd:rule:gaining-spells)", async () => {
    // "a spell that you always have prepared doesn't count against the number of spells on that list": the Cleric's list
    // has room for one more ("choose additional Cleric spells until the number of spells on your list matches the number
    // in the Cleric Features table"). The Cleric gained no level: no swaps.
    const spells = [...fill('Cleric', 4, 0), held('Shield of Faith', 'Cleric'), ...fill('Cleric', 8, 1), held('Divine Smite', "Paladin's Smite", { alwaysPrepared: true }), ...fill('Paladin', 3, 1)];
    const h = setup({ builderData: SRD_BUILDER_DATA, rules: rulesWith('Protection from Evil and Good'), character: multiCaster([srdEntry('Cleric', 5), srdEntry('Paladin', 2)], spells) });
    const out = await h.run('level_up', { class_name: 'Paladin', subclass: 'Oath of Devotion' });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('Always prepared now: Protection from Evil and Good (Oath of Devotion).');
    expect(out.content).toContain("Now always prepared, no longer counted among the Cleric's spells: Shield of Faith.");
    expect(out.content).toContain(`Spell choices: Paladin 3 (level 1 spells): up to 1 prepared spell (3 of 4). ${recordHint('Paladin')}`);
    expect(out.content).toContain(`Spell choices: Cleric 5 (spells of level 1–3): up to 1 prepared spell (8 of 9). ${recordHint('Cleric')}`);
    expect(h.sheet().spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:paladin' }, { classId: 'srd:class:cleric' }]);
    expect(toolLog(h, 'level_up')?.detail).toContain('Spell choices: Cleric 5 (spells of level 1–3): up to 1 prepared spell (8 of 9).');
  });

  it("Wizard 3 / Sorcerer 2 → Sorcerer 3, Draconic Sorcery: Chromatic Orb stays in the Wizard's spellbook (srd:rule:wizard-spellcasting)", async () => {
    // "The book contains the level 1+ spells you know": always prepared now, it leaves the Wizard's prepared spells but not
    // its book, whose two per level aren't owed again.
    const wizard = [...fill('Wizard', 3, 0), held('Chromatic Orb', 'Wizard'), ...fill('Wizard', 5, 1), ...fill('Wizard', 4, 1, false)].map((sp, i) => (i >= 9 ? { ...sp, id: `${sp.id}-book`, name: `${sp.name} book` } : sp));
    const spells = [...wizard, ...fill('Sorcerer', 4, 0), ...fill('Sorcerer', 4, 1)];
    const h = setup({ builderData: SRD_BUILDER_DATA, rules: rulesWith('Alter Self', 'Command', "Dragon's Breath"), character: multiCaster([srdEntry('Wizard', 3), srdEntry('Sorcerer', 2)], spells) });
    const out = await h.run('level_up', { class_name: 'Sorcerer', subclass: 'Draconic Sorcery' });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("Now always prepared, no longer counted among the Wizard's prepared spells (still in the spellbook): Chromatic Orb.");
    expect(out.content).not.toContain("no longer counted among the Wizard's spells");
    expect(h.sheet().spellcasting?.spells.find((sp) => sp.name === 'Chromatic Orb')).toMatchObject({ source: 'Wizard', alwaysPrepared: true });
    expect(out.content).toContain('Spell choices: Wizard 3 (spells of level 1–2): up to 1 prepared spell (5 of 6).');
    expect(out.content).not.toContain('spellbook spell (');
  });

  it("a spell copied into the Wizard's book doesn't use up the next level's two (srd:rule:wizard-spellcasting)", async () => {
    // "Whenever you gain a Wizard level after 1, add two Wizard spells of your choice to your spellbook"; "Copying a Spell
    // into the Book" is apart from those. A Wizard 3 at its table (3 cantrips, a 10-spell book, 6 prepared) copies one.
    const book = [...fill('Wizard', 6, 1), ...fill('Wizard', 4, 1, false).map((sp) => ({ ...sp, id: `${sp.id}-book`, name: `${sp.name} book` }))];
    const h = setup({ builderData: SRD_BUILDER_DATA, character: caster('Wizard', 3, [...fill('Wizard', 3, 0), ...book]) });
    expect((await h.run('update_character', { spells_add: [{ name: 'Invisibility', level: 2, source: 'Wizard (copied)', prepared: false }] })).isError).toBeUndefined();
    const out = await h.run('level_up', { class_name: 'Wizard' });
    expect(out.content).toContain('Spell choices: Wizard 4 (spells of level 1–2): up to 1 cantrip (the sheet has 3 of 4), 2 spellbook spells (10 of at least 12) and 1 prepared spell (6 of 7).');
  });

  it("a copied spell the DM prepares under the class's name stays a copy, outside each level's two (srd:rule:wizard-spellcasting)", async () => {
    // "Copying a Spell into the Book … Afterward you can prepare the spell like the other spells in your spellbook": a
    // Wizard 5 at its table (4 cantrips, a 14-spell book, 9 prepared) prepares its copied Fly after a Long Rest, and the DM
    // gives the class's name as the source. Wizard 6 still adds two ("Whenever you gain a Wizard level after 1, add two
    // Wizard spells of your choice to your spellbook").
    const book = [...fill('Wizard', 9, 1), ...fill('Wizard', 5, 1, false).map((sp) => ({ ...sp, id: `${sp.id}-book`, name: `${sp.name} book` }))];
    const h = setup({ builderData: SRD_BUILDER_DATA, character: caster('Wizard', 5, [...fill('Wizard', 4, 0), ...book, held('Fly', 'Wizard (copied)', { prepared: false })]) });
    const rest = await h.run('take_rest', { kind: 'long' });
    // Copying prepares nothing ("Afterward you can prepare the spell like the other spells in your spellbook").
    expect(rest.content).toContain('re-add one by name with prepared true or false and no source, so it keeps its own; a spell newly copied into the book takes source "Wizard (copied)", prepared false unless the player prepares it)');
    const prepare = await h.run('update_character', {
      spells_add: [
        { name: 'Fly', level: 3, source: 'Wizard', prepared: true },
        { name: 'Wizard spell 1-0', level: 1, source: 'Wizard', prepared: false },
      ],
    });
    expect(prepare.isError).toBeUndefined();
    expect(h.sheet().spellcasting?.spells.find((sp) => sp.name === 'Fly')).toMatchObject({ source: 'Wizard (copied)', prepared: true });
    // The DM hears that the source it gave wasn't taken, and how to make the copy one of a level's two (not the player's log).
    const KEPT_FLY =
      'Fly keeps its source "Wizard (copied)": a spell copied into the spellbook, or added to it free, stays outside the two spells each Wizard level adds to it. If it is one of those two, spells_remove it and spells_add it again with source "Wizard" and prepared true.';
    expect(prepare.content).toContain(`\n${KEPT_FLY}\n`);
    expect(prepare.content).not.toContain('Wizard spell 1-0 keeps');
    expect(toolLog(h, 'update_character')?.detail ?? '').not.toContain('keeps its source');
    expect((await h.run('level_up', { class_name: 'Wizard' })).content).toContain('Spell choices: Wizard 6 (spells of level 1–3): up to 2 spellbook spells (14 of at least 16) and 1 prepared spell (9 of 10).');
    // Taken out and added again, it becomes one of a level's two: the DM's way to make it one.
    const moved = await h.run('update_character', { spells_remove: ['Fly'], spells_add: [{ name: 'Fly', level: 3, source: 'Wizard' }] });
    expect(h.sheet().spellcasting?.spells.find((sp) => sp.name === 'Fly')?.source).toBe('Wizard');
    expect(moved.content).not.toContain('keeps its source');
    // Prepared as one of a level's picks the same way: the level's book spells stay owed.
    const four = [...fill('Wizard', 7, 1), ...fill('Wizard', 5, 1, false).map((sp) => ({ ...sp, id: `${sp.id}-book`, name: `${sp.name} book` }))];
    const w = setup({ builderData: SRD_BUILDER_DATA, character: caster('Wizard', 4, [...fill('Wizard', 4, 0), ...four, held('Invisibility', 'Wizard (copied)', { prepared: false })]) });
    await w.run('level_up', { class_name: 'Wizard' });
    const picked = await w.run('update_character', { spells_add: [{ name: 'Invisibility', level: 2, source: 'Wizard', prepared: true }] });
    expect(picked.content).toContain('Spell choices still open: Wizard 5 (spells of level 1–3): up to 2 spellbook spells (12 of at least 14) and 1 prepared spell (8 of 9).');
    expect(picked.content).toContain('Invisibility keeps its source "Wizard (copied)"');
    // Several at once, one line for their source and prepared state (the re-add keeps it: spells_add prepares a new spell
    // unless told); a free spell (Evocation Savant) is apart from the copies.
    const both = setup({
      builderData: SRD_BUILDER_DATA,
      character: caster('Wizard', 5, [
        held('Fly', 'Wizard (copied)', { prepared: false }),
        held('Haste', 'wizard (copied)', { prepared: false }),
        held('Web', 'Wizard (Evocation Savant)', { prepared: false }),
        held('Slow', 'Wizard (copied)', { prepared: true }),
      ]),
    });
    const kept4 = await both.run('update_character', {
      spells_add: [
        { name: 'Fly', level: 3, source: 'Wizard' },
        { name: 'Web', level: 2, source: 'wizard' },
        { name: 'Haste', level: 3, source: 'Wizard' },
        { name: 'Slow', level: 3, source: 'Wizard' },
      ],
    });
    expect(kept4.content).toContain(
      '\nFly and Haste keep their source "Wizard (copied)": a spell copied into the spellbook, or added to it free, stays outside the two spells each Wizard level adds to it. If one of them is one of those two, spells_remove it and spells_add it again with source "Wizard" and prepared false.\n',
    );
    expect(kept4.content).toContain('\nSlow keeps its source "Wizard (copied)": a spell copied into the spellbook, or added to it free, stays outside the two spells each Wizard level adds to it. If it is one of those two, spells_remove it and spells_add it again with source "Wizard" and prepared true.\n');
    expect(kept4.content).toContain('\nWeb keeps its source "Wizard (Evocation Savant)": a spell copied into the spellbook, or added to it free, stays outside the two spells each Wizard level adds to it. If it is one of those two, spells_remove it and spells_add it again with source "Wizard" and prepared false.\n');
    // Followed as written, the copy becomes the class's own and stays as the player had it.
    await both.run('update_character', { spells_remove: ['Fly'], spells_add: [{ name: 'Fly', level: 3, source: 'Wizard', prepared: false }] });
    expect(both.sheet().spellcasting?.spells.find((sp) => sp.name === 'Fly')).toMatchObject({ source: 'Wizard', prepared: false });
    // Its own copied source restated, or another class's name, says nothing.
    const same = await both.run('update_character', { spells_add: [{ name: 'Haste', level: 3, source: 'Wizard (copied)' }, { name: 'Web', level: 2, source: 'Granted in play' }] });
    expect(same.content).not.toContain('keeps its source');
    // A spell named twice in one call: its last entry with a source is the one its final source answers, so nothing kept
    // is reported for a source the call itself gave (a Cleric keeps no spellbook at all).
    const twice = setup({ builderData: SRD_BUILDER_DATA, character: caster('Wizard', 5, [held('Slow', 'Wizard (copied)', { prepared: false })]) });
    const made = await twice.run('update_character', {
      spells_add: [
        { name: 'Fly', level: 3, source: 'Wizard', prepared: true },
        { name: 'Fly', level: 3, source: 'Wizard (copied)', prepared: false },
        { name: 'Slow', level: 3, source: 'Wizard' },
        { name: 'Slow', level: 3, prepared: true },
      ],
    });
    expect(twice.sheet().spellcasting?.spells.find((sp) => sp.name === 'Fly')?.source).toBe('Wizard (copied)');
    expect(made.content).not.toContain('Fly keeps');
    expect(made.content).toContain('\nSlow keeps its source "Wizard (copied)"');
    const cleric = setup({ builderData: SRD_BUILDER_DATA, character: caster('Cleric', 5, []) });
    const bless = await cleric.run('update_character', { spells_add: [{ name: 'Bless', level: 1, source: 'Cleric' }, { name: 'Bless', level: 1, source: 'Cleric (Life Domain)' }] });
    expect(bless.content).not.toContain('keeps its source');
    // Concentrating on it: removing it ends that, so the DM is told to set it again. Always prepared: no re-add, which
    // would lose that (spells_add can't restore it).
    const copies = caster('Wizard', 5, [held('Fly', 'Wizard (copied)', { prepared: true }), held('Chromatic Orb', 'Wizard (copied)', { prepared: true, alwaysPrepared: true })]);
    const busy = setup({ builderData: SRD_BUILDER_DATA, character: { ...copies, spellcasting: { ...copies.spellcasting!, concentratingOn: 'Fly' } } });
    const kept = await busy.run('update_character', { spells_add: [{ name: 'Fly', level: 3, source: 'Wizard' }, { name: 'Chromatic Orb', level: 1, source: 'Wizard' }] });
    expect(kept.content).toContain('spells_add it again with source "Wizard" and prepared true. Removing Fly ends Concentration on it: set concentration again in a later call.\n');
    expect(kept.content).toContain(
      '\nChromatic Orb keeps its source "Wizard (copied)": a spell copied into the spellbook, or added to it free, stays outside the two spells each Wizard level adds to it. Leave it so: removed and added again, a spell would lose its always-prepared mark.\n',
    );
    // Without the class data, whether "Wizard" keeps a spellbook isn't known: the source given stands.
    const blind = setup({ builderData: null, character: caster('Wizard', 5, [held('Fly', 'Wizard (copied)', { prepared: false })]) });
    const taken = await blind.run('update_character', { spells_add: [{ name: 'Fly', level: 3, source: 'Wizard', prepared: true }] });
    expect(blind.sheet().spellcasting?.spells.find((sp) => sp.name === 'Fly')?.source).toBe('Wizard');
    expect(taken.content).not.toContain('keeps its source');
  });

  it("names a spellbook place's limit when the places left share one below the class's spell level (srd:rule:wizard-spellcasting)", async () => {
    // "Each of these spells must be of a level for which you have spell slots": a Wizard 4 one spell short (a book of
    // eight level 1 and three level 2 spells) owes Wizard 4's place, of level 1–2, besides Wizard 5's two of level 1–3.
    const book = [...fill('Wizard', 7, 1), ...fill('Wizard', 1, 1, false).map((sp) => ({ ...sp, id: `${sp.id}-book`, name: `${sp.name} book` })), ...fill('Wizard', 3, 2, false)];
    const h = setup({ builderData: SRD_BUILDER_DATA, character: caster('Wizard', 4, [...fill('Wizard', 4, 0), ...book]) });
    expect((await h.run('level_up', { class_name: 'Wizard' })).content).toContain('3 spellbook spells (11 of at least 14: 2 up to level 3 and 1 up to level 2)');
    // The player names Fireball and Fly: the place left is Wizard 4's, and the line still says so.
    const out = await h.run('update_character', {
      spells_add: [
        { name: 'Fireball', level: 3, source: 'Wizard', prepared: false },
        { name: 'Fly', level: 3, source: 'Wizard', prepared: false },
      ],
    });
    expect(out.content).toContain('Spell choices still open: Wizard 5 (spells of level 1–3): up to 1 spellbook spell (13 of at least 14: 1 up to level 2) and 2 prepared spells (7 of 9).');
  });

  it('frees no place for a spell turned always prepared that was not prepared, and says so (srd:rule:gaining-spells)', async () => {
    // "A spell that you always have prepared doesn't count against the number of spells on that list": an unprepared spell
    // wasn't on it. Wizard 3 / Sorcerer 2 → Sorcerer 3, Draconic Sorcery, with Chromatic Orb unprepared in the Wizard's book.
    const wizard = [...fill('Wizard', 3, 0), held('Chromatic Orb', 'Wizard', { prepared: false }), ...fill('Wizard', 6, 1), ...fill('Wizard', 3, 1, false)].map((sp, i) =>
      i >= 10 ? { ...sp, id: `${sp.id}-book`, name: `${sp.name} book` } : sp,
    );
    const spells = [...wizard, ...fill('Sorcerer', 4, 0), ...fill('Sorcerer', 4, 1)];
    const h = setup({ builderData: SRD_BUILDER_DATA, rules: rulesWith('Alter Self', 'Command', "Dragon's Breath"), character: multiCaster([srdEntry('Wizard', 3), srdEntry('Sorcerer', 2)], spells) });
    const out = await h.run('level_up', { class_name: 'Sorcerer', subclass: 'Draconic Sorcery' });
    expect(out.content).toContain("Now always prepared (still in the Wizard's spellbook): Chromatic Orb.");
    expect(out.content).not.toContain('no longer counted');
    expect(out.content).not.toContain('Spell choices: Wizard');
    // A Cleric's unticked Shield of Faith, turned by Oath of Devotion, is named with the spells new to the sheet.
    const cleric = [...fill('Cleric', 4, 0), held('Shield of Faith', 'Cleric', { prepared: false }), ...fill('Cleric', 9, 1), held('Divine Smite', "Paladin's Smite", { alwaysPrepared: true }), ...fill('Paladin', 3, 1)];
    const p = setup({ builderData: SRD_BUILDER_DATA, rules: rulesWith('Protection from Evil and Good'), character: multiCaster([srdEntry('Cleric', 5), srdEntry('Paladin', 2)], cleric) });
    const turned = await p.run('level_up', { class_name: 'Paladin', subclass: 'Oath of Devotion' });
    expect(turned.content).toContain('Always prepared now: Protection from Evil and Good, Shield of Faith (Oath of Devotion).');
    expect(turned.content).not.toContain('no longer counted');
    expect(turned.content).not.toContain('Spell choices: Cleric');
  });

  it("a swap and a new spell the DM records settle the Sorcerer's level; part of the choices leaves the rest open (srd:rule:sorcerer-spellcasting)", async () => {
    // "Whenever you gain a Sorcerer level, you can replace one spell on your list": the level_up result tells the DM to
    // record a replacement with spells_remove and spells_add; once nothing is owed, the sheet's reminder clears.
    const spells = [...fill('Sorcerer', 5, 0), held('Burning Hands', 'Sorcerer'), ...fill('Sorcerer', 8, 1)];
    const h = setup({ builderData: SRD_BUILDER_DATA, character: caster('Sorcerer', 5, spells) });
    await h.run('level_up', { class_name: 'Sorcerer' });
    expect(h.sheet().spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:sorcerer', replaceSpell: true, replaceCantrip: true }]);
    const out = await h.run('update_character', {
      spells_remove: ['Burning Hands'],
      spells_add: [
        { name: 'Haste', level: 3, source: 'Sorcerer' },
        { name: 'Lightning Bolt', level: 3, source: 'Sorcerer' },
      ],
    });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('Spell choices for Sorcerer 6 recorded: nothing left to choose.');
    expect(h.sheet().spellcasting).not.toHaveProperty('spellPicks');
    // A Wizard's book recorded in part: still open, with what is left.
    const w = setup({ builderData: SRD_BUILDER_DATA });
    await w.run('level_up', { class_name: 'Wizard' });
    const part = await w.run('update_character', { spells_add: [{ name: 'Ray of Frost', level: 0, source: 'Wizard' }] });
    expect(part.content).toContain('Spell choices still open: Wizard 4 (spells of level 1–2): up to 6 spellbook spells (6 of at least 12: 2 up to level 2 and 4 of level 1) and 2 prepared spells (5 of 7).');
    expect(w.sheet().spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:wizard' }]);
    // A spell of no class's leaves the choices as they are, and says nothing of them.
    const other = await w.run('update_character', { spells_add: [{ name: 'Fly', level: 3 }] });
    expect(other.content).not.toContain('Spell choices');
    expect(w.sheet().spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:wizard' }]);
  });
});

describe('take_rest long: the prepared spells a class may change now (srd:rule:gaining-spells, "Preparing Spells")', () => {
  const LINE =
    'The player may now change prepared spells on their sheet: Cleric (any), Paladin (one), Wizard (any from the spellbook; one cantrip). Record any they tell you with update_character spells_remove and spells_add, source the class\'s name (the Wizard\'s spellbook spells stay in the book: re-add one by name with prepared true or false and no source, so it keeps its own; a spell newly copied into the book takes source "Wizard (copied)", prepared false unless the player prepares it).';

  it("names each class whose own text allows a change after a Long Rest, and how to record what the player names", async () => {
    // "Preparing Spells": Cleric, Druid and Wizard change their list "Finish a Long Rest: Any", Paladin and Ranger "One";
    // the Wizard's come from its spellbook, and it may replace one cantrip (srd:rule:wizard-spellcasting).
    const start = caster('Cleric', 3, []);
    const classes = [srdEntry('Cleric', 3), srdEntry('Paladin', 2), srdEntry('Sorcerer', 1), srdEntry('Wizard', 1)];
    const h = setup({ builderData: SRD_BUILDER_DATA, character: { ...start, classes } });
    const out = await h.run('take_rest', { kind: 'long' });
    expect(out.isError).toBeUndefined();
    // A Sorcerer changes its spells on gaining a level, never after a rest: it isn't named.
    expect(out.content).toContain(`\n${LINE}\nStatus:`);
    // For the DM: the player's log keeps the rest itself.
    expect(toolLog(h, 'take_rest')?.detail).not.toContain('may now change');
  });

  it('says nothing for classes without such a change, without the builder data, or when the hero died in the rest', async () => {
    const sorcerer = setup({ builderData: SRD_BUILDER_DATA, character: caster('Sorcerer', 3, fill('Sorcerer', 6, 1)) });
    expect((await sorcerer.run('take_rest', { kind: 'long' })).content).not.toContain('may now change');
    const fighter = setup({ builderData: SRD_BUILDER_DATA, character: hero({ classId: FIGHTER.id, name: 'Fighter', level: 4, hitDie: 10 }) });
    expect((await fighter.run('take_rest', { kind: 'long' })).content).not.toContain('may now change');
    const noData = setup({ builderData: null, character: caster('Cleric', 3, []) });
    expect((await noData.run('take_rest', { kind: 'long' })).content).not.toContain('may now change');
    // Aid's 8 hours end before the rest finishes: a drained Cleric it kept alive dies (srd:spell:aid, srd:rule:long-rest).
    const dying = setup({ builderData: SRD_BUILDER_DATA, character: caster('Cleric', 4, []) });
    await dying.run('update_character', { hp_max: { name: 'Aid', change: 5, ends: 'long-rest' } });
    await dying.run('update_character', { hp: { amount: 33, kind: 'damage', damage_type: 'necrotic', drain: 'Life Drain' } });
    const rest = await dying.run('take_rest', { kind: 'long' });
    expect(rest.content).toContain('Long rest: the hero died');
    expect(rest.content).not.toContain('may now change');
  });
});

describe('update_character spells_add: a spell the sheet already holds', () => {
  const WIZARD = SRD_BUILDER_DATA.classes.find((c) => c.id === 'srd:class:wizard')!;

  it("keeps its source and prepared flag when the call leaves them out, so its class still counts it; a new spell keeps today's defaults", async () => {
    // The sample Wizard's Sleep is in its spellbook, unprepared (srd:rule:wizard-spellcasting: a spellbook spell is
    // prepared only when chosen). Re-added with notes it stays the Wizard's: "Granted in play" and prepared would take it
    // out of the Wizard's book and put it among its prepared spells (spellPicks.ts counts a class's spells by source).
    const h = setup({ builderData: SRD_BUILDER_DATA });
    const by = (name: string) => h.sheet().spellcasting?.spells.find((s) => s.name === name);
    const count = () => owedSpells(h.sheet(), h.sheet().classes[0], WIZARD);
    const before = count();
    const notes = 'Copied from the lighthouse keeper’s logbook.';
    expect((await h.run('update_character', { spells_add: [{ name: 'Sleep', level: 1, notes }, { name: 'Fireball', level: 3 }] })).isError).toBeUndefined();
    expect(by('Sleep')).toMatchObject({ id: 'srd:spell:sleep', source: 'Wizard', prepared: false, notes });
    expect(count()).toEqual(before);
    expect(by('Fireball')).toMatchObject({ id: 'srd:spell:fireball', source: 'Granted in play', prepared: true });
    // What the call gives, it changes: Sleep prepared (still the Wizard's), Shield moved to another source.
    await h.run('update_character', { spells_add: [{ name: 'Sleep', level: 1, prepared: true }, { name: 'Shield', level: 1, source: 'Ring of Spell Storing' }] });
    expect(by('Sleep')).toMatchObject({ source: 'Wizard', prepared: true, notes });
    expect(by('Shield')).toMatchObject({ source: 'Ring of Spell Storing', prepared: true });
    expect(count()?.prepared.held).toBe(before!.prepared.held);
    expect(count()?.spellbook?.held).toBe(before!.spellbook!.held - 1);
    // A spell the sheet holds with no source at all (an older save) stays without one.
    const older = sampleCharacter();
    const sourceless: Character = { ...older, spellcasting: { ...older.spellcasting!, spells: [{ id: 'old-light', name: 'Light', level: 0, prepared: true }] } };
    const old = setup({ character: sourceless });
    await old.run('update_character', { spells_add: [{ name: 'Light', level: 0, notes: 'The lantern trick.' }] });
    expect(old.sheet().spellcasting?.spells).toEqual([{ id: 'old-light', name: 'Light', level: 0, prepared: true, notes: 'The lantern trick.' }]);
  });
});

describe('update_character links names to the rules index and builder data', () => {
  it("features_add puts a feat beside a species trait of its name, and features_use spends the feat's uses", async () => {
    const trait = { id: 't-luck', name: 'Lantern Luck', source: 'species' as const, sourceName: 'Mothkin', description: 'Invented trait: reroll a 1.' };
    const h = setup({ character: hero({ classId: FIGHTER.id, name: 'Fighter', level: 4, hitDie: 10 }, { features: [trait] }) });
    const added = await h.run('update_character', { features_add: [{ name: 'Lantern Luck', description: 'Invented feat: 3 luck points.', source: 'feat', uses_max: 3, recharge: 'long' }] });
    expect(added.isError).toBeUndefined();
    expect(h.sheet().features.map((f) => [f.name, f.source, f.description])).toEqual([
      ['Lantern Luck', 'species', 'Invented trait: reroll a 1.'],
      ['Lantern Luck', 'feat', 'Invented feat: 3 luck points.'],
    ]);
    await h.run('update_character', { features_use: [{ name: 'Lantern Luck' }] });
    expect(h.sheet().features.map((f) => f.uses?.used)).toEqual([undefined, 1]);
  });

  it('features_use and features_restore reach either of two same-named features with uses: by the amount, or by the name the result gives', async () => {
    const trait = { id: 't-luck', name: 'Lantern Luck', source: 'species' as const, sourceName: 'Mothkin', description: 'Invented trait.', uses: { max: 1, used: 0, recharge: 'short' as const } };
    const h = setup({ character: hero({ classId: FIGHTER.id, name: 'Fighter', level: 4, hitDie: 10 }, { features: [trait] }) });
    const added = await h.run('update_character', { features_add: [{ name: 'Lantern Luck', description: 'Invented feat: 3 luck points.', source: 'feat', uses_max: 3, recharge: 'long' }] });
    expect(added.content).toContain('Gained feature: Lantern Luck (3 uses, recharges on a Long Rest), beside Lantern Luck (Mothkin)');
    const used = (await h.run('update_character', { features_use: [{ name: 'Lantern Luck' }] })).content;
    expect(used).toContain('Used Lantern Luck (Mothkin) (0/1 left; recharges on a Short or Long Rest). Another Lantern Luck is on the sheet: to use it, name it "Lantern Luck (Granted in play)".');
    await h.run('update_character', { features_use: [{ name: 'Lantern Luck', amount: 2 }, { name: 'Lantern Luck (Granted in play)' }] });
    expect(h.sheet().features.map((f) => f.uses?.used)).toEqual([1, 3]);
    await h.run('update_character', { features_restore: [{ name: 'Lantern Luck (feat)', amount: 2 }] });
    expect(h.sheet().features.map((f) => f.uses?.used)).toEqual([1, 1]);
    // The DM's ruling on the trait keeps where it came from: the names the results gave still find each one.
    expect((await h.run('update_character', { features_add: [{ name: 'Lantern Luck', description: 'DM ruling: the luck also works at dusk.', source: 'species' }] })).content).toContain('Updated feature: Lantern Luck (Mothkin)');
    expect(h.sheet().features.map((f) => f.sourceName)).toEqual(['Mothkin', 'Granted in play']);
    await h.run('update_character', { features_restore: [{ name: 'Lantern Luck (Mothkin)' }] });
    expect(h.sheet().features.map((f) => f.uses?.used)).toEqual([0, 1]);
    await h.run('update_character', { features_use: [{ name: 'Lantern Luck (Granted in play)' }] });
    expect(h.sheet().features.map((f) => f.uses?.used)).toEqual([0, 2]);
  });

  it('a rewrite that changes the source names the feature as the next use or restore takes it', async () => {
    // Two the DM added (both "Granted in play"), told apart by source; a homebrew ruling then rewrites the trait.
    const h = setup({ character: hero({ classId: FIGHTER.id, name: 'Fighter', level: 4, hitDie: 10 }) });
    await h.run('update_character', { features_add: [{ name: 'Lantern Luck', description: 'Invented trait.', source: 'species', uses_max: 1, recharge: 'short' }] });
    await h.run('update_character', { features_add: [{ name: 'Lantern Luck', description: 'Invented feat.', source: 'feat', uses_max: 3 }] });
    await h.run('update_character', { features_use: [{ name: 'Lantern Luck (species)' }] });
    const ruled = await h.run('update_character', { features_add: [{ name: 'Lantern Luck', description: 'DM ruling: the trait works at dusk too.', source: 'homebrew' }] });
    expect(ruled.content).toContain('Updated feature: Lantern Luck (homebrew)');
    await h.run('update_character', { features_restore: [{ name: 'Lantern Luck (homebrew)' }] });
    expect(h.sheet().features.map((f) => [f.source, f.uses?.used])).toEqual([['homebrew', 0], ['feat', 0]]);
    // Alone on the sheet, the bare name.
    const lone = setup({ character: hero({ classId: FIGHTER.id, name: 'Fighter', level: 4, hitDie: 10 }) });
    await lone.run('update_character', { features_add: [{ name: 'Lantern Luck', description: 'Invented trait.', source: 'species' }] });
    expect((await lone.run('update_character', { features_add: [{ name: 'Lantern Luck', description: 'Ruling.', source: 'homebrew' }] })).content).toContain('Updated feature: Lantern Luck\n');
  });

  it('links inventory_add items: a book’s magic armor by its numbers, an SRD item, and leaves others as given', async () => {
    const h = setup({ character: hero({ classId: FIGHTER.id, name: 'Fighter', level: 3, hitDie: 10 }) });
    await h.run('update_character', {
      inventory_add: [
        { name: "warden's mail", quantity: 1 },
        { name: 'Lantern of Hollow Light', quantity: 1, description: 'The DM describes how the lantern looks.' },
        { name: 'Rope', quantity: 1 },
        { name: 'Odd Rock', quantity: 1, category: 'treasure' },
      ],
    });
    const [mail, lantern, rope, rock] = h.sheet().inventory;
    expect(mail).toMatchObject({
      name: "Warden's Mail",
      category: 'armor',
      magic: true,
      requiresAttunement: false,
      bonuses: { ac: 1 },
      armor: { kind: 'armor', armorType: 'heavy', baseAc: 16, dexCap: 0 },
      compendiumId: gloamwoodEntryId("Warden's Mail"),
      ref: { kind: 'magic-item', textCopied: false },
    });
    expect(mail.description).not.toMatch(/old smoke/);
    // The DM's words about a book's item: kept on this device, marked copied for exports.
    expect(lantern).toMatchObject({ magic: true, requiresAttunement: true, description: 'The DM describes how the lantern looks.', ref: { textCopied: true } });
    expect(rope).toMatchObject({ name: 'Rope', compendiumId: 'srd:item:rope', category: 'gear' });
    expect(rope.ref).toBeUndefined();
    expect(rock).toMatchObject({ name: 'Odd Rock', category: 'treasure' });
    expect(rock.compendiumId).toBeUndefined();

    // Its stored numbers give the AC without any catalog lookup by name.
    const out = await h.run('update_character', { inventory_update: [{ name: "Warden's Mail", equipped: true }] });
    expect(h.sheet().armorClass).toBe(17);
    expect(out.content).toContain('AC 12 → 17');
  });

  it('links spells_add spells to their entries, with a ref for a book’s spell', async () => {
    const h = setup();
    await h.run('update_character', {
      spells_add: [
        { name: 'Ashen Choir', level: 2, source: 'Granted in play' },
        { name: 'Fireball', level: 3 },
        { name: 'Glimmer Song', level: 1, ritual: false },
      ],
    });
    const spells = h.sheet().spellcasting?.spells ?? [];
    const by = (name: string) => spells.find((s) => s.name === name);
    expect(by('Ashen Choir')).toMatchObject({ id: gloamwoodEntryId('Ashen Choir'), level: 2, ref: { kind: 'spell', textCopied: false } });
    expect(by('Fireball')).toMatchObject({ id: 'srd:spell:fireball' });
    expect(by('Fireball')?.ref).toBeUndefined();
    expect(by('Glimmer Song')).toMatchObject({ level: 1, ritual: false });
    expect(by('Glimmer Song')?.id).not.toMatch(/^(srd|lib):/);
  });

  /** A homebrew spell saved for a campaign (null: shared), as create_homebrew or the Library saves one. */
  const homebrewSpell = (id: string, name: string, campaignId: string | null): HomebrewEntry => ({
    ...entry(id, name, 'spell', { level: 1 }),
    sourceId: HOMEBREW_SOURCE_ID,
    sourceName: 'Homebrew',
    campaignId,
    origin: 'dm',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  });

  it("tags a spells_add spell homebrew when its name is this campaign's or shared homebrew, and links no other campaign's", async () => {
    const h = setup({
      rules: [...RULES, homebrewSpell('hb:cinder-veil', 'Cinder Veil', 'camp-1'), homebrewSpell('hb:lantern-ward', 'Lantern Ward', null), homebrewSpell('hb:ember-lance', 'Ember Lance', 'camp-2')],
    });
    await h.run('update_character', {
      spells_add: [
        { name: 'Cinder Veil', level: 1 },
        { name: 'Lantern Ward', level: 1 },
        { name: 'Ember Lance', level: 1 },
        { name: 'Ashen Choir', level: 2 },
        { name: 'Fireball', level: 3 },
      ],
    });
    const by = (name: string) => h.sheet().spellcasting?.spells.find((s) => s.name === name);
    expect(by('Cinder Veil')).toMatchObject({ id: 'hb:cinder-veil', homebrewId: 'hb:cinder-veil' });
    expect(by('Lantern Ward')).toMatchObject({ id: 'hb:lantern-ward', homebrewId: 'hb:lantern-ward' });
    // Another campaign's homebrew is no spell this DM may consult (its rules search hides it): added as given, as before.
    expect(by('Ember Lance')?.id).not.toMatch(/^hb:/);
    // Neither it, the book's spell nor the SRD's takes a homebrewId.
    for (const name of ['Ember Lance', 'Ashen Choir', 'Fireball']) expect(by(name)).not.toHaveProperty('homebrewId');

    const sheet = (await h.run('get_character_sheet', {})).content;
    expect(sheet).toContain('Cinder Veil (Granted in play, homebrew)');
    expect(sheet).toContain('Lantern Ward (Granted in play, homebrew)');
    expect(sheet).toMatch(/Ember Lance \(Granted in play\)[,\n]/);
    expect(sheet).toMatch(/Ashen Choir \(Granted in play\)[,\n]/);
    expect(sheet).toMatch(/Fireball \(Granted in play\)[,\n]/);
  });

  it('keeps a re-added spell the entry its id names: it takes the homebrewId of that homebrew only', async () => {
    const choirId = gloamwoodEntryId('Ashen Choir');
    const choirRef = { sourceId: 'gloam', sourceTitle: GLOAMWOOD_TITLE, entryId: choirId, kind: 'spell' as const, entryName: 'Ashen Choir', textHash: '', textCopied: false };
    const mira = sampleCharacter();
    const spells = [
      ...mira.spellcasting!.spells,
      // The book's spell, linked before the campaign had homebrew of its name.
      { id: choirId, name: 'Ashen Choir', level: 2, prepared: true, source: 'Granted in play', ref: choirRef },
      // A homebrew spell linked by an earlier version, which didn't record its homebrewId.
      { id: 'hb:cinder-veil', name: 'Cinder Veil', level: 1, prepared: true, source: 'Granted in play' },
    ];
    const h = setup({
      character: { ...mira, spellcasting: { ...mira.spellcasting!, spells } },
      rules: [...RULES, homebrewSpell('hb:ashen-choir', 'Ashen Choir', 'camp-1'), homebrewSpell('hb:cinder-veil', 'Cinder Veil', 'camp-1')],
    });
    // Both names now resolve to this campaign's homebrew, which outranks a book's spell of its name.
    await h.run('update_character', { spells_add: [{ name: 'Ashen Choir', level: 2, prepared: false }, { name: 'Cinder Veil', level: 1, prepared: false }] });
    const by = (name: string) => h.sheet().spellcasting?.spells.find((s) => s.name === name);
    // Still the book's spell (addSpell keeps its id and ref), so not homebrew.
    expect(by('Ashen Choir')).toMatchObject({ id: choirId, prepared: false, ref: choirRef });
    expect(by('Ashen Choir')).not.toHaveProperty('homebrewId');
    // Its id is that homebrew's: it takes the homebrewId it lacked.
    expect(by('Cinder Veil')).toMatchObject({ id: 'hb:cinder-veil', homebrewId: 'hb:cinder-veil', prepared: false });
  });

  it('gives features_add a ref when the name is one imported feat', async () => {
    const h = setup();
    await h.run('update_character', {
      features_add: [
        { name: 'Lantern Bearer', description: 'The DM sums up the feat.', source: 'feat' },
        { name: 'Alert', description: 'Initiative proficiency.', source: 'feat' },
      ],
    });
    const lantern = h.sheet().features.find((f) => f.name === 'Lantern Bearer');
    expect(lantern).toMatchObject({ description: 'The DM sums up the feat.', ref: { kind: 'feat', entryName: 'Lantern Bearer', textCopied: true } });
    expect(h.sheet().features.find((f) => f.name === 'Alert')?.ref).toBeUndefined();
  });
});

describe("a feat's numbers when the DM records it (features_add)", () => {
  const fighter4 = (extra: Partial<Character> = {}) => hero({ classId: FIGHTER.id, name: 'Fighter', level: 4, hitDie: 10 }, extra);

  it("gives Alert its Initiative bonus and Tough its Hit Points, and says so (SRD 5.2.1 Alert; the engine's Tough rule)", async () => {
    const h = setup({ character: fighter4() });
    const out = await h.run('update_character', {
      features_add: [
        { name: 'Alert', description: 'Initiative proficiency.', source: 'feat' },
        { name: 'Tough', description: 'Hardier than most.', source: 'feat' },
      ],
    });
    // Fighter 4, DEX 14, HP 30 of 30.
    expect(h.sheet()).toMatchObject({ initiativeBonusExtra: 2, hp: { max: 38, current: 38 } });
    expect(out.content).toContain('Initiative +2 → +4 (Alert: Proficiency Bonus +2)');
    expect(out.content).toContain('HP maximum 30 → 38 (Tough: twice your level, 4)');
    expect(out.content).not.toContain('joined the sheet beside');
    // Beside a class feature of its name (not a transformation's power): no hint.
    const beside = setup({ character: fighter4({ features: [{ id: 'c', name: 'Tough', source: 'class', sourceName: 'Fighter 1', description: 'Invented.' }] }) });
    expect((await beside.run('update_character', { features_add: [{ name: 'Tough', description: 'The feat.', source: 'feat' }] })).content).not.toContain('joined the sheet beside');
    // The DM's words again: the same features, nothing more.
    await h.run('update_character', { features_add: [{ name: 'Tough', description: 'Hardier still.', source: 'feat' }, { name: 'Alert', description: 'Quick.', source: 'feat' }] });
    expect(h.sheet()).toMatchObject({ initiativeBonusExtra: 2, hp: { max: 38 } });
  });

  it("keeps a Tough the DM recorded as a background's feat when it records a species trait of the name, then the feat again: paid once", async () => {
    const h = setup({ character: fighter4() });
    const tough = (source: string, description: string) => ({ features_add: [{ name: 'Tough', description, source }] });
    await h.run('update_character', tough('background', 'The Soldier origin feat.'));
    expect(h.sheet().hp.max).toBe(38);
    const beside = await h.run('update_character', tough('species', 'Invented: a trait of the name.'));
    expect(beside.content).toContain('Gained feature: Tough, beside Tough');
    expect(beside.content).not.toContain('HP maximum');
    // The DM learns which entry stays the feat, and how to change it.
    expect(beside.content).toContain(
      'Tough joined the sheet beside Tough (background), which stays the Tough feat with its Hit Points: a species trait or class feature doesn\'t replace it. To change that entry, record it with source "feat".',
    );
    await h.run('update_character', tough('feat', 'The feat, recorded again.'));
    expect(h.sheet().hp.max).toBe(38);
    expect(h.sheet().features.filter((f) => f.name === 'Tough').map((f) => f.source)).toEqual(['feat', 'species']);
    // Recorded as a feat from the start, a trait of the name never replaced it: no line.
    const asFeat = setup({ character: fighter4() });
    await asFeat.run('update_character', { features_add: [{ name: 'Alert', description: 'The feat.', source: 'feat' }] });
    expect((await asFeat.run('update_character', { features_add: [{ name: 'Alert', description: 'Invented: a trait.', source: 'class' }] })).content).not.toContain('stays the Alert feat');
  });

  it("records the Alert feat beside a transformation's power of its name, so the feat outlives the transformation", async () => {
    const h = setup({ character: fighter4(), campaignSettings: { transformations: 'offered' } });
    const begin = {
      action: 'begin',
      name: 'Wolf Blood',
      reason: 'Invented: a bite under the full moon.',
      summary: 'Invented: the moon sharpens the senses and the temper.',
      origin: 'accepted',
      player_chose_it: true,
      stage: 'Cub',
      how_it_ends: 'Invented: a silver-bell cure.',
      features_add: [{ name: 'Alert', description: 'Invented: keen senses at night.' }],
    };
    expect((await h.run('transform_character', begin)).isError).toBeUndefined();
    const out = await h.run('update_character', { features_add: [{ name: 'Alert', description: 'Initiative proficiency.', source: 'feat' }] });
    expect(h.sheet().features.filter((f) => f.name.startsWith('Alert')).map((f) => f.source)).toEqual(['transformation', 'feat']);
    // The DM learns the power is unchanged and the new one outlasts the transformation; resent, it joins nothing.
    expect(out.content).toContain("Alert joined the sheet beside Wolf Blood's own Alert, and stays when Wolf Blood ends; to change Wolf Blood's, use transform_character advance.");
    const resent = await h.run('update_character', { features_add: [{ name: 'Alert', description: 'Initiative proficiency, amended.', source: 'feat' }] });
    expect(resent.content).not.toContain('joined the sheet beside');
    expect(h.sheet().features.filter((f) => f.name === 'Alert')).toHaveLength(2);
    expect(h.sheet().initiativeBonusExtra).toBe(2);
    expect((await h.run('transform_character', { action: 'end', name: 'Wolf Blood', reason: 'Cured' })).isError).toBeUndefined();
    expect(h.sheet().features.filter((f) => f.name === 'Alert').map((f) => f.source)).toEqual(['feat']);
    expect(h.sheet().initiativeBonusExtra).toBe(2);
  });

  it('keeps the AC in step with a Defense the DM records (SRD 5.2.1 Defense: +1 to Armor Class while wearing armor)', async () => {
    const mail = { id: 'cm', name: 'Chain Mail', quantity: 1, equipped: true, category: 'armor' as const, armor: { kind: 'armor' as const, armorType: 'heavy' as const, baseAc: 16, dexCap: 0 } };
    const h = setup({ character: fighter4({ inventory: [mail], armorClass: 16, acFormula: 'Chain Mail 16' }) });
    const out = await h.run('update_character', { features_add: [{ name: 'Defense', description: 'A Fighting Style feat.', source: 'feat' }] });
    expect(h.sheet().armorClass).toBe(17);
    expect(out.content).toContain('AC 16 → 17');
    // Set by hand to what Defense gives before the DM recorded it: the AC stays, and the DM is asked whether it counted more.
    const handSet = setup({ character: fighter4({ inventory: [mail], armorClass: 17, acFormula: 'set by the DM: Defense' }) });
    const matched = await handSet.run('update_character', { features_add: [{ name: 'Defense', description: 'A Fighting Style feat.', source: 'feat' }] });
    expect(handSet.sheet().armorClass).toBe(17);
    // H1/P1: the example of what a hand-set AC may still have counted is an effect the app doesn't count (Haste).
    expect(matched.content).toContain(
      'AC 17 stays as set by hand; armor and features now give 17 too (Chain Mail 16 + Defense 1). If the hand-set AC counted an effect that still applies (such as Haste), set armor_class to include it.',
    );
    expect(matched.content).not.toContain('a spell such as Shield of Faith');
  });

  it("tells the DM when new gear only matches a hand-set AC that counted a spell (SRD 5.2.1 Shield of Faith: +2 AC)", async () => {
    const mail = { id: 'cm', name: 'Chain Mail', quantity: 1, equipped: true, category: 'armor' as const, armor: { kind: 'armor' as const, armorType: 'heavy' as const, baseAc: 16, dexCap: 0 } };
    const shield = { id: 'sh', name: 'Shield', quantity: 1, equipped: false, category: 'shield' as const, armor: { kind: 'shield' as const, baseAc: 2, dexCap: 0 } };
    const h = setup({ character: fighter4({ inventory: [mail, shield], armorClass: 18, acFormula: 'set by the DM: Shield of Faith' }) });
    const out = await h.run('update_character', { inventory_update: [{ name: 'Shield', equipped: true }] });
    expect(h.sheet().armorClass).toBe(18);
    // H1/P1: an older save's hand-set Shield of Faith with no record is recorded with ac_spells_add, never folded into
    // armor_class (the app then takes its +2 off when the spell ends).
    expect(out.content).toContain(
      'AC 18 stays as set by hand; armor and features now give 18 too (Chain Mail 16 + Shield 2). If it counted Shield of Faith, record it with ac_spells_add ["Shield of Faith"] (the app adds and ends it).',
    );
    expect(out.content).not.toContain('set armor_class to include it');
    // The DM's own armor_class in the same call is final, the same value restated too: nothing to ask.
    const restated = setup({ character: fighter4({ inventory: [mail, shield], armorClass: 18, acFormula: 'set by the DM: Shield of Faith' }) });
    const final = await restated.run('update_character', { inventory_update: [{ name: 'Shield', equipped: true }], armor_class: 18, reason: 'Shield of Faith ends' });
    expect(final.content).not.toContain('stays as set by hand');
  });

  it("says when armor whose stats aren't known is donned over a hand-set AC, rather than that it gives the AC", async () => {
    // Mage Armor set by hand, then homebrew armor the app has no stats for.
    const h = setup({ character: fighter4({ armorClass: 15, acFormula: 'set by the DM: Mage Armor' }) });
    const out = await h.run('update_character', { inventory_add: [{ name: 'Dragonhide Coat', quantity: 1, category: 'armor' }] });
    expect(out.isError).toBeUndefined();
    const donned = await h.run('update_character', { inventory_update: [{ name: 'Dragonhide Coat', equipped: true }] });
    expect(h.sheet().armorClass).toBe(15);
    expect(donned.content).toContain("AC stays 15 (set by hand): Dragonhide Coat's armor stats are unknown, so set armor_class by hand.");
    expect(donned.content).not.toContain('now give 15 too');
  });
});

describe('a hand-set AC the new gear only matches: what it may have counted (H1/P1)', () => {
  const mail = { id: 'cm', name: 'Chain Mail', quantity: 1, equipped: true, category: 'armor' as const, armor: { kind: 'armor' as const, armorType: 'heavy' as const, baseAc: 16, dexCap: 0 } };
  const shield = { id: 'sh', name: 'Shield', quantity: 1, equipped: false, category: 'shield' as const, armor: { kind: 'shield' as const, baseAc: 2, dexCap: 0 } };
  const fighter4 = (extra: Partial<Character> = {}) => hero({ classId: FIGHTER.id, name: 'Fighter', level: 4, hitDie: 10 }, extra);
  const concentratingOn = (spell: string) => ({ spellcasting: { ...sampleCharacter().spellcasting!, concentratingOn: spell } });
  const dragonBlooded = { name: 'Draconic Resilience', description: 'Invented: scales on the skin.', source: 'class' };

  it('an older save\'s Shield of Faith is recorded with ac_spells_add, and its +2 then ends with the Concentration (SRD 5.2.1 Shield of Faith: "+2 bonus to AC")', async () => {
    const h = setup({ character: fighter4({ inventory: [mail, shield], armorClass: 18, acFormula: 'set by the DM: Shield of Faith', ...concentratingOn('Shield of Faith') }) });
    const donned = await h.run('update_character', { inventory_update: [{ name: 'Shield', equipped: true }] });
    expect(donned.content).toContain('If it counted Shield of Faith, record it with ac_spells_add ["Shield of Faith"] (the app adds and ends it).');
    // Following it: the hand-set 18 already holds the +2, so it is kept and now counted, with what the gear gives.
    const recorded = await h.run('update_character', { ac_spells_add: ['Shield of Faith'] });
    expect(recorded.content).toContain(
      'Warning: AC 18 was set by hand naming Shield of Faith: kept, and Shield of Faith is now counted in it (ending Shield of Faith takes 2 off). Gear, features and spells give 20 (Chain Mail 16 + Shield 2 + Shield of Faith 2); update the AC if that is right.',
    );
    expect(h.sheet()).toMatchObject({ armorClass: 18, acSpells: ['Shield of Faith'] });
    await h.run('update_character', { armor_class: 20 });
    expect(h.sheet()).toMatchObject({ armorClass: 20, acFormula: 'Chain Mail 16 + Shield 2 + Shield of Faith 2' });
    const ended = await h.run('update_character', { concentration: null });
    expect(ended.content).toContain('No longer concentrating on Shield of Faith.\nShield of Faith ends: AC 20 → 18');
    expect(h.sheet()).toMatchObject({ armorClass: 18, acFormula: 'Chain Mail 16 + Shield 2' });
  });

  it('never takes the app\'s own "Shield of Faith 2" part for the DM naming it: a recorded spell gets the Haste example', async () => {
    // srd:spell:haste: "a +2 bonus to Armor Class", set by hand while Shield of Faith was recorded and counted.
    const h = setup({ character: fighter4({ inventory: [mail, shield], armorClass: 20, acFormula: 'set by the DM: Haste + Shield of Faith 2', acSpells: ['Shield of Faith'] }) });
    const out = await h.run('update_character', { inventory_update: [{ name: 'Shield', equipped: true }] });
    expect(out.content).toContain(
      'AC 20 stays as set by hand; armor and features now give 20 too (Chain Mail 16 + Shield 2 + Shield of Faith 2). If the hand-set AC counted an effect that still applies (such as Haste), set armor_class to include it.',
    );
    expect(out.content).not.toContain('ac_spells_add ["Shield of Faith"]');
    // An older save's words naming Shield of Faith, once the spell is recorded (its part kept beside them): nothing to record.
    const kept = setup({
      character: fighter4({ inventory: [mail, shield], armorClass: 20, acFormula: 'set by the DM: Shield of Faith + Shield of Faith 2', acSpells: ['Shield of Faith'] }),
    });
    const donned = await kept.run('update_character', { inventory_update: [{ name: 'Shield', equipped: true }] });
    expect(donned.content).toContain('If the hand-set AC counted an effect that still applies (such as Haste), set armor_class to include it.');
    expect(donned.content).not.toContain('ac_spells_add');
  });

  it('names Mage Armor only while no armor is worn (srd:spell:mage-armor: "The spell ends early if the target dons armor")', async () => {
    // An older save's Mage Armor set by hand (13 + DEX 2), then Draconic Resilience recorded: 10 + DEX 2 + CHA 3 is 15 too.
    const scaled = setup({ character: sampleCharacter({ abilityScores: { ...sampleCharacter().abilityScores, cha: 16 }, armorClass: 15, acFormula: 'set by the DM: Mage Armor' }) });
    const out = await scaled.run('update_character', { features_add: [dragonBlooded] });
    expect(out.content).toContain(
      'AC 15 stays as set by hand; armor and features now give 15 too (Draconic Resilience: 10 + DEX 2 + CHA 3). If it counted Mage Armor, record it with ac_spells_add ["Mage Armor"] (the app adds and ends it).',
    );
    // Armor donned instead (a Chain Shirt: 13 + DEX 2): Mage Armor is over, so nothing to record.
    const shirt = { id: 'cs', name: 'Chain Shirt', quantity: 1, equipped: false, category: 'armor' as const, armor: { kind: 'armor' as const, armorType: 'medium' as const, baseAc: 13, dexCap: 2 } };
    const armored = setup({ character: sampleCharacter({ inventory: [shirt], armorClass: 15, acFormula: 'set by the DM: Mage Armor' }) });
    const donned = await armored.run('update_character', { inventory_update: [{ name: 'Chain Shirt', equipped: true }] });
    expect(donned.content).toContain('If the hand-set AC counted an effect that still applies (such as Haste), set armor_class to include it.');
    expect(donned.content).not.toContain('ac_spells_add');
  });

  it('names both spells when the hand-set AC names both, in one call', async () => {
    // 13 + DEX 2 + Shield of Faith 2 set by hand; Draconic Resilience with CHA 20 gives 10 + DEX 2 + CHA 5, the same 17.
    const h = setup({ character: sampleCharacter({ abilityScores: { ...sampleCharacter().abilityScores, cha: 20 }, armorClass: 17, acFormula: 'set by the DM: Mage Armor and Shield of Faith' }) });
    const out = await h.run('update_character', { features_add: [dragonBlooded] });
    expect(out.content).toContain('If it counted Mage Armor and Shield of Faith, record them with ac_spells_add ["Mage Armor", "Shield of Faith"] (the app adds and ends them).');
  });
});

describe("a spell that needs no Concentration never becomes the hero's (D5)", () => {
  it('refuses Shield and Mage Armor before anything is written, saying where their AC goes (srd:spell:shield, srd:spell:mage-armor)', async () => {
    const h = setup();
    const start = h.sheet();
    // srd:spell:shield: "Duration: 1 round", "Until the start of your next turn, you have a +5 bonus to AC".
    expect(await h.run('update_character', { concentration: 'Shield' })).toEqual({
      isError: true,
      content: "Shield doesn't require Concentration (Duration: 1 round). Fold its +5 into the dc of attacks on Mira Voss until the start of Mira Voss's next turn.",
    });
    // srd:spell:mage-armor: "Duration: 8 hours". The slot this call spends isn't spent either.
    expect(await h.run('update_character', { spell_slots_spend: [{ level: 1 }], concentration: 'mage armor' })).toEqual({
      isError: true,
      content: 'Mage Armor doesn\'t require Concentration (Duration: 8 hours). Record its AC with update_character ac_spells_add ["Mage Armor"].',
    });
    expect(h.sheet()).toBe(start);
    expect(h.s().log).toHaveLength(0);
  });

  it("never refuses a spell the rules data doesn't know, or doesn't flag", async () => {
    const unknown = setup();
    expect((await unknown.run('update_character', { concentration: 'Shadow Lash' })).content).toContain('Concentrating on Shadow Lash.');
    // Fireball's entry here gives no Concentration flag: only the data's own "no" refuses.
    const unflagged = setup();
    expect((await unflagged.run('update_character', { concentration: 'Fireball' })).content).toContain('Concentrating on Fireball.');
    const faith = setup();
    expect((await faith.run('update_character', { concentration: 'Shield of Faith' })).content).toContain('Concentrating on Shield of Faith.');
  });
});

describe('what the DM reads back about AC and saves after its own changes', () => {
  it("armor_class: an AC the gear doesn't give says the DM set it; one the gear gives gets the gear's formula back", async () => {
    const h = setup();
    expect((await h.run('update_character', { armor_class: 15, reason: 'Mage Armor' })).isError).toBeUndefined();
    expect(h.sheet()).toMatchObject({ armorClass: 15, acFormula: 'set by the DM: Mage Armor' });
    expect(characterSheetText(h.sheet())).toContain('**AC** 15 (set by the DM: Mage Armor)');
    // Mage Armor ends: back to what the gear gives (unarmored, 10 + DEX), with its formula.
    expect((await h.run('update_character', { armor_class: 12 })).isError).toBeUndefined();
    expect(h.sheet()).toMatchObject({ armorClass: 12, acFormula: '10 + DEX 2' });
    expect((await h.run('update_character', { armor_class: 14 })).isError).toBeUndefined();
    expect(h.sheet().acFormula).toBe('set by the DM');
  });

  it('says when what every save includes changes (SRD 5.2.1 Cloak of Protection: +1 to saving throws while attuned)', async () => {
    const h = setup();
    await h.run('update_character', { inventory_add: [{ name: 'Cloak of Protection', quantity: 1, magic: true }] });
    const on = await h.run('update_character', { inventory_update: [{ name: 'Cloak of Protection', attuned: true }] });
    expect(on.content).toContain('Saving throws now include Cloak of Protection +1.');
    const off = await h.run('update_character', { inventory_update: [{ name: 'Cloak of Protection', attuned: false }] });
    expect(off.content).toContain('Saving throws no longer include Cloak of Protection +1.');
    // Nothing about saves when they don't change.
    expect((await h.run('update_character', { hp: { change: -1 } })).content).not.toContain('Saving throws');
  });
});

describe("conditions by the DM's own name (SRD 5.2.1 Rules Glossary conditions)", () => {
  const KEPT = 'Kept "Protection from Poison" as a homebrew condition: no Poisoned rules apply. To apply Poisoned, add "Poisoned".';

  it('keeps a name with a condition word inside it as a homebrew condition, and tells the DM (not the player) no rules of it apply', async () => {
    const h = setup();
    const out = await h.run('update_character', { conditions_add: [{ condition: 'Protection from Poison', source: 'spell', duration: '1 hour' }] });
    expect(h.sheet().conditions).toEqual([{ id: 'Protection from Poison', source: 'spell', duration: '1 hour' }]);
    expect(out.content).toContain(`Now Protection from Poison (1 hour, spell)\n${KEPT}\nStatus:`);
    expect(JSON.stringify(h.s().log)).not.toContain('Kept');
  });

  it('leaves a real Charmed alone: a boon named for a charm goes beside it, past an immunity to Charmed, and is removed by its name', async () => {
    const h = setup({ character: sampleCharacter({ conditions: [{ id: 'charmed', source: 'Vampire' }] }) });
    await h.run('update_character', { conditions_add: [{ condition: 'Charm of Warding', source: 'Fey blessing' }] });
    expect(h.sheet().conditions).toEqual([{ id: 'charmed', source: 'Vampire' }, { id: 'Charm of Warding', source: 'Fey blessing' }]);
    await h.run('update_character', { conditions_remove: ['Charm of Warding'] });
    expect(h.sheet().conditions).toEqual([{ id: 'charmed', source: 'Vampire' }]);

    const immune = setup({ character: sampleCharacter({ conditionImmunities: ['charmed'] }) });
    await immune.run('update_character', { conditions_add: [{ condition: 'Charm of Warding' }] });
    expect(immune.sheet().conditions).toEqual([{ id: 'Charm of Warding' }]);
  });

  it('never reads a boon that mentions Exhaustion as levels of it (SRD 5.2.1 Exhaustion: six levels kill)', async () => {
    const h = setup();
    const out = await h.run('update_character', { conditions_add: [{ condition: 'Ward against Exhaustion', source: 'Fey boon' }] });
    expect(h.sheet().exhaustion).toBe(0);
    expect(h.sheet().conditions).toEqual([{ id: 'Ward against Exhaustion', source: 'Fey boon' }]);
    expect(out.content).toContain('Kept "Ward against Exhaustion" as a homebrew condition: no Exhaustion rules apply.');
    await h.run('update_character', { conditions_remove: ['Ward against Exhaustion'] });
    expect(h.sheet().conditions).toEqual([]);
    expect(h.sheet().exhaustion).toBe(0);
  });

  it('keeps what worked: standard names in any case, their noun forms, a detail as the source, Exhaustion, removal by name', async () => {
    const h = setup();
    const out = await h.run('update_character', {
      conditions_add: [
        { condition: 'Poisoned' },
        { condition: 'blindness' },
        { condition: 'Frightened of the dragon' },
        { condition: 'Exhausted (forced march)' },
        { condition: 'Exhaustion 2' },
      ],
    });
    expect(h.sheet().conditions).toEqual([{ id: 'poisoned' }, { id: 'blinded' }, { id: 'frightened', source: 'of the dragon' }]);
    expect(h.sheet().exhaustion).toBe(2);
    expect(out.content).not.toContain('Kept');
    await h.run('update_character', { conditions_remove: ['poisoned', 'Blindness', 'Frightened', 'Exhaustion'] });
    expect(h.sheet().conditions).toEqual([]);
    expect(h.sheet().exhaustion).toBe(1);
  });

  it('says nothing of a homebrew name when the engine refused the condition', async () => {
    const h = setup({ character: sampleCharacter({ hp: { max: 17, current: 0, temp: 0 }, deathSaves: { successes: 0, failures: 3, stable: false, dead: true } }) });
    const out = await h.run('update_character', { conditions_add: [{ condition: 'Protection from Poison' }] });
    expect(out.content).toContain("Warning: The dead don't gain conditions.");
    expect(out.content).not.toContain('Kept');
  });
});

describe('get_character_sheet', () => {
  // Invented: three paragraphs of backstory and long ideals, past the old 500- and 200-character cuts.
  const BACKSTORY = [
    'Kestrel Vane grew up on the salt flats east of Harrowmere, where the caravans stop only to water their oxen. His mother traded rope and lamp oil; his father was a story she told on cold nights.',
    "At twelve he found a dragon's shed scale half buried in the flats, warm as a hearthstone in his hand. He swore an oath over it: one day he will become a dragon himself, scales and wings and all.",
    'He fights with twin hooked blades joined by a length of black chain, a gift from the smith who taught him to throw them.',
  ];
  const IDEALS =
    'Transformation. Anything worth having is worth changing yourself to reach, and a person who stays the same out of fear has already lost. Freedom. No chain holds me that I did not forge myself. Loyalty to the few who stayed.';
  const SPELLCASTING = [
    'You can cast sorcerer spells using Charisma. You know four cantrips and two level 1 spells of your choice from the Sorcerer spell list, and you regain all expended spell slots when you finish a Long Rest.',
    'You can use an Arcane Focus as a Spellcasting Focus for your sorcerer spells. Whenever you gain a Sorcerer level, you can replace one spell you know with another of a level for which you have spell slots.',
  ];

  it("returns the player's long text and each feature's text whole, as the frozen prompt renders it", async () => {
    const base = sampleCharacter();
    const character: Character = {
      ...base,
      personality: { ...base.personality, backstory: BACKSTORY.join('\n\n'), ideals: IDEALS },
      features: [{ id: 'f-sc', name: 'Spellcasting', source: 'class', sourceName: 'Sorcerer 1', description: SPELLCASTING.join('\n\n') }],
    };
    const h = setup({ character });
    const out = await h.run('get_character_sheet', {});
    expect(out.isError).toBeUndefined();
    expect(out.content).toBe(characterSheetText(h.sheet()));
    expect(out.content).toContain(`- Backstory: ${BACKSTORY.join('\n\n  ')}`);
    expect(out.content).toContain(`- Ideals: ${IDEALS}`);
    expect(out.content).toContain(`- **Spellcasting** (Sorcerer 1): ${SPELLCASTING.join('\n\n  ')}`);
    expect(out.content).not.toContain('…');
  });
});

describe("book text the DM names on the sheet keeps its book's ref (exports replace it)", () => {
  // The export pipeline (backup.ts) over a campaign holding this character.
  const exported = (character: Character) => {
    const g = campaignGraph('p');
    const data: CampaignData = { ...g, character: { ...character, id: g.character!.id, campaignId: g.campaign.id } };
    return JSON.stringify(redactImportedDeep(redactCopiedImports(data).data));
  };
  const mothkin = EXPECTED_MERGED.species.find((s) => s.name === 'Mothkin')!;
  const duskSight = mothkin.traits.find((t) => t.name === 'Dusk Sight')!;
  const fighter = () => hero({ classId: FIGHTER.id, name: 'Fighter', level: 2, hitDie: 10 });

  it('level_up: naming a copied feature already on the sheet adds no second, ref-less copy', async () => {
    const dusk = { id: 'f-dusk', name: 'Dusk Sight', source: 'species' as const, sourceName: 'Mothkin', description: duskSight.description, ref: duskSight.ref };
    const h = setup({ character: { ...fighter(), features: [dusk] } });
    const out = await h.run('level_up', { class_name: 'Fighter', new_features: [{ name: 'Dusk Sight', description: duskSight.description }] });
    expect(out.isError).toBeUndefined();
    expect(h.sheet().features.filter((f) => f.name === 'Dusk Sight')).toEqual([expect.objectContaining({ ref: duskSight.ref })]);
    expect(out.content).toContain("Already on the sheet with the book's text, kept as they are (uses included): Dusk Sight.");
    expect(exported(h.sheet())).not.toContain(GLOAMWOOD_MARKERS[2]);
  });

  it("level_up still adds an extra under a name the SRD prints too, or when the book data didn't load", async () => {
    const wick = EXPECTED_MERGED.classes.find((c) => c.name === 'Wickwright')!;
    const asi = wick.features.find((f) => f.name === 'Ability Score Improvement')!;
    const copied = { id: 'f-asi', name: asi.name, source: 'class' as const, sourceName: 'Wickwright 4', description: asi.description, ref: asi.ref };
    const extra = { name: 'Ability Score Improvement', description: 'Fighter 4: +2 Strength.' };
    const withData = setup({ character: { ...fighter(), features: [copied] } });
    expect((await withData.run('level_up', { class_name: 'Fighter', new_features: [extra] })).isError).toBeUndefined();
    expect(withData.sheet().features.filter((f) => f.name === 'Ability Score Improvement')).toHaveLength(2);
    const dusk = { id: 'f-dusk', name: 'Dusk Sight', source: 'species' as const, sourceName: 'Mothkin', description: duskSight.description, ref: duskSight.ref };
    const noData = setup({ character: { ...fighter(), features: [dusk] }, builderData: null });
    expect((await noData.run('level_up', { class_name: 'Fighter', new_features: [{ name: 'Dusk Sight', description: 'I see in the dark now.' }] })).isError).toBeUndefined();
    expect(noData.sheet().features.filter((f) => f.name === 'Dusk Sight')).toHaveLength(2);
  });

  it("leaves the DM's own words under a book part's name as the DM's: no ref, so exports keep them and restore never overwrites them", async () => {
    const own = 'You see through magical darkness within 10 feet of you.';
    const h = setup({ character: fighter() });
    expect((await h.run('update_character', { features_add: [{ name: 'Dusk Sight', description: own, source: 'species' }] })).isError).toBeUndefined();
    expect((await h.run('level_up', { class_name: 'Fighter', new_features: [{ name: 'Smoke Step', description: 'Once per turn you step through smoke.' }] })).isError).toBeUndefined();
    const c = h.sheet();
    expect(c.features.find((f) => f.name === 'Dusk Sight')?.ref).toBeUndefined();
    expect(c.features.find((f) => f.name === 'Smoke Step')?.ref).toBeUndefined();
    expect(exported(c)).toContain(own);
  });

  it("a species trait or class feature the DM adds under a book feat's name and in its own words never takes that feat's ref", async () => {
    // An invented Mothkin trait named like the book's feat Lantern Bearer, with its own ref.
    const trait = {
      id: 't-lantern',
      name: 'Lantern Bearer',
      source: 'species' as const,
      sourceName: 'Mothkin',
      description: 'Invented: a moth-folk trait of the same name.',
      ref: importedRef({ entryId: 'lib:gloam:species:mothkin', kind: 'species', entryName: 'Mothkin', part: 'Lantern Bearer', textHash: 'h', textCopied: true }),
    };
    const ruling = 'DM ruling: the glow also sheds dim light for 10 feet.';
    const h = setup({ character: { ...fighter(), features: [trait] } });
    expect((await h.run('update_character', { features_add: [{ name: 'Lantern Bearer', description: ruling, source: 'species' }] })).isError).toBeUndefined();
    // The trait is rewritten and keeps its own ref (restore refills the trait's text, never the feat's) and source name.
    expect(h.sheet().features).toEqual([{ ...trait, description: ruling }]);
    // A class feature of the name with no ref of its own: the DM's words stay the DM's, in exports too.
    const own = setup({ character: fighter() });
    expect((await own.run('update_character', { features_add: [{ name: 'Lantern Bearer', description: ruling, source: 'class' }] })).isError).toBeUndefined();
    expect(own.sheet().features.find((f) => f.name === 'Lantern Bearer')?.ref).toBeUndefined();
    expect(exported(own.sheet())).toContain(ruling);
    // An entry on neither side (a background's) named like the feat is the feat: it links it.
    const background = setup({ character: fighter() });
    expect((await background.run('update_character', { features_add: [{ name: 'Lantern Bearer', description: ruling, source: 'background' }] })).isError).toBeUndefined();
    expect(background.sheet().features.find((f) => f.name === 'Lantern Bearer')?.ref).toMatchObject({ kind: 'feat', entryName: 'Lantern Bearer' });
  });

  it("a species trait or class feature in a book feat's own words takes its ref, the SRD's name or not; words the SRD prints stay the DM's", async () => {
    // An invented book feat under an SRD 5.2.1 feat's name (an older book's Grappler), beside the SRD's in the builder.
    const shared = 'Invented shared wording: while you hold a creature fast, the lantern light never dims around it.';
    const bookOnly = 'Invented book wording: you learn the gloamwood hold, pinning a foe beneath a net of moth silk and lamplight.';
    const words = `${bookOnly} ${shared}`;
    const lantern = EXPECTED_MERGED.feats.find((f) => f.name === 'Lantern Bearer')!;
    const book: FeatOption = { ...lantern, id: 'lib:gloam:feat:grappler', name: 'Grappler', description: words, ref: { ...lantern.ref!, entryId: 'lib:gloam:feat:grappler', entryName: 'Grappler' } };
    const builderData: BuilderData = { ...EXPECTED_MERGED, feats: [...EXPECTED_MERGED.feats, book] };
    expect(builderData.feats.filter((f) => f.name === 'Grappler').map((f) => Boolean(f.source))).toEqual([false, true]);
    // The SRD's entry (in the rules index) prints the shared sentence.
    const rules = [...RULES, { ...entry('srd:feat:grappler', 'Grappler', 'feat'), text: `Grappler. ${shared}` }];
    const withCall = (character: Character, input: unknown, tool = 'update_character') => {
      const g = campaignGraph('p');
      const call: TranscriptMessage = { id: 'uc', sessionId: g.transcript[0].sessionId, seq: 99, param: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-uc', name: tool, input }] }, createdAt: 1 };
      const data: CampaignData = { ...g, character: { ...character, id: g.character!.id, campaignId: g.campaign.id }, transcript: [...g.transcript, call] };
      return JSON.stringify(redactImportedDeep(redactCopiedImports(data).data));
    };
    for (const source of ['species', 'class', 'subclass'] as const) {
      const input = { features_add: [{ name: 'Grappler', description: words, source }] };
      const h = setup({ builderData, rules, character: fighter() });
      expect((await h.run('update_character', input)).isError).toBeUndefined();
      expect(h.sheet().features.find((f) => f.name === 'Grappler')?.ref, source).toMatchObject({ kind: 'feat', entryName: 'Grappler', textCopied: true });
      // Out of the sheet and the DM's call alike.
      expect(withCall(h.sheet(), input), source).not.toContain('gloamwood hold');
    }
    // A level_up extra is a class feature: the same check (a class granting the book's feat).
    const level = { class_name: 'Fighter', new_features: [{ name: 'Grappler', description: words }] };
    const leveled = setup({ builderData, rules, character: fighter() });
    expect((await leveled.run('level_up', level)).isError).toBeUndefined();
    expect(leveled.sheet().features.find((f) => f.name === 'Grappler')).toMatchObject({ source: 'class', ref: { kind: 'feat', entryName: 'Grappler', textCopied: true } });
    expect(withCall(leveled.sheet(), level, 'level_up')).not.toContain('gloamwood hold');
    // Words the SRD prints too, or the DM's own: no ref, so exports keep them and restore never writes the feat over them.
    for (const description of [shared, 'DM ruling: the hold also works on a creature one size larger.']) {
      const h = setup({ builderData, rules, character: fighter() });
      expect((await h.run('update_character', { features_add: [{ name: 'Grappler', description, source: 'species' }] })).isError).toBeUndefined();
      expect((await h.run('level_up', { class_name: 'Fighter', new_features: [{ name: 'Grappler', description }] })).isError).toBeUndefined();
      expect(h.sheet().features.filter((f) => f.name === 'Grappler').map((f) => [f.source, f.ref]), description).toEqual([['species', undefined], ['class', undefined]]);
      expect(exported(h.sheet())).toContain(description);
    }
    // Without the rules index the SRD's words can't be told apart: any shared run counts, so the book's never leave.
    const h = setup({ builderData, rules, character: fighter() });
    setDmDeps({ rulesIndex: async () => Promise.reject(new Error('rules index unavailable (test)')) });
    const ctx: ToolContext = { deps: deps(), signal: new AbortController().signal, status: vi.fn() };
    expect((await runTool('update_character', { features_add: [{ name: 'Grappler', description: shared, source: 'species' }] }, ctx)).isError).toBeUndefined();
    expect(h.sheet().features.find((f) => f.name === 'Grappler')?.ref).toMatchObject({ kind: 'feat', entryName: 'Grappler', textCopied: true });
  });

  it("a trait the DM resends in its book's words keeps its own ref, though they share a sentence with a book feat of its name", async () => {
    // An invented Mothkin trait named like the book's feat Lantern Bearer, reprinting the feat's Lantern Ward sentence.
    const ward = 'While you hold a lit lantern, you and allies within 10 feet of you have Advantage on saving throws to avoid or end the Frightened condition.';
    const text = `Invented trait wording: moth-folk who carry a lantern from birth are never truly lost in the dark. ${ward}`;
    const ref = importedRef({ entryId: mothkin.id, kind: 'species', entryName: 'Mothkin', part: 'Lantern Bearer', textHash: 'h', textCopied: true });
    const builderData: BuilderData = { ...EXPECTED_MERGED, species: EXPECTED_MERGED.species.map((s) => (s.id === mothkin.id ? { ...s, traits: [...s.traits, { name: 'Lantern Bearer', description: text, ref }] } : s)) };
    const trait = { id: 't-lantern', name: 'Lantern Bearer', source: 'species' as const, sourceName: 'Mothkin', description: text, ref };
    // The whole text, or the sentence both print: the trait's words first (restore refills the trait's text, not the feat's).
    for (const description of [text, ward]) {
      const h = setup({ builderData, character: { ...fighter(), features: [trait] } });
      expect((await h.run('update_character', { features_add: [{ name: 'Lantern Bearer', description, source: 'species', uses_max: 2, recharge: 'long' }] })).isError).toBeUndefined();
      expect(h.sheet().features, description).toEqual([{ ...trait, description, uses: { max: 2, used: 0, recharge: 'long', ruled: true } }]);
    }
    // Two books' species print the trait: the sheet's trait, resent in its words, keeps its ref, never the feat's.
    const twice: BuilderData = { ...builderData, species: [...builderData.species, { ...mothkin, id: 'lib:ashen:species:mothkin', traits: [{ name: 'Lantern Bearer', description: text, ref: { ...ref, entryId: 'lib:ashen:species:mothkin' } }] }] };
    const h = setup({ builderData: twice, character: { ...fighter(), features: [trait] } });
    expect((await h.run('update_character', { features_add: [{ name: 'Lantern Bearer', description: text, source: 'species' }] })).isError).toBeUndefined();
    expect(h.sheet().features).toEqual([trait]);
    // A new entry in the feat's own words, both books' parts sharing one sentence of it: the feat's, so its words leave exports.
    const feat = EXPECTED_MERGED.feats.find((f) => f.name === 'Lantern Bearer')!;
    for (const source of ['species', 'class', 'subclass'] as const) {
      const fresh = setup({ builderData: twice, character: fighter() });
      expect((await fresh.run('update_character', { features_add: [{ name: 'Lantern Bearer', description: feat.description, source }] })).isError).toBeUndefined();
      expect(fresh.sheet().features.find((f) => f.name === 'Lantern Bearer')?.ref, source).toMatchObject({ kind: 'feat', entryName: 'Lantern Bearer', textCopied: true });
      expect(exported(fresh.sheet()), source).not.toContain('hold a lit lantern');
    }
    const leveled = setup({ builderData: twice, character: fighter() });
    expect((await leveled.run('level_up', { class_name: 'Fighter', new_features: [{ name: 'Lantern Bearer', description: feat.description }] })).isError).toBeUndefined();
    expect(leveled.sheet().features.find((f) => f.name === 'Lantern Bearer')?.ref).toMatchObject({ kind: 'feat', entryName: 'Lantern Bearer', textCopied: true });
  });

  it("two books printing a part in the same words: a new entry in them takes the first book's ref, so they leave exports", async () => {
    // One book's Mothkin twice (a reprint or a second import), no feat of the name.
    const twice: BuilderData = { ...EXPECTED_MERGED, species: [...EXPECTED_MERGED.species, { ...mothkin, id: 'lib:ashen:species:mothkin', traits: mothkin.traits.map((t) => ({ ...t, ...(t.ref ? { ref: { ...t.ref, entryId: 'lib:ashen:species:mothkin' } } : {}) })) }] };
    const marker = GLOAMWOOD_MARKERS[2];
    expect(duskSight.description).toContain(marker);
    for (const source of ['species', 'class', 'background', 'homebrew'] as const) {
      const h = setup({ builderData: twice, character: fighter() });
      expect((await h.run('update_character', { features_add: [{ name: 'Dusk Sight', description: duskSight.description, source }] })).isError).toBeUndefined();
      expect(h.sheet().features.find((f) => f.name === 'Dusk Sight')?.ref, source).toMatchObject({ kind: 'species', entryId: mothkin.id, textCopied: true });
      expect(exported(h.sheet()), source).not.toContain(marker);
    }
    const leveled = setup({ builderData: twice, character: fighter() });
    expect((await leveled.run('level_up', { class_name: 'Fighter', new_features: [{ name: 'Dusk Sight', description: duskSight.description }] })).isError).toBeUndefined();
    expect(leveled.sheet().features.find((f) => f.name === 'Dusk Sight')?.ref).toMatchObject({ kind: 'species', entryId: mothkin.id });
  });

  it("a new entry in a style a book's class prints takes that style's ref, though a feat of its name shares a sentence", async () => {
    // An invented Fighting Style feature of the Wickwright's printing two styles, and a 2024 book's style feat named like one.
    const guard = 'While you hold your lantern aloft, the first attack against you each round has Disadvantage.';
    const styleText = `Invented style wording: a wickwright's lantern wards the hand that holds it. ${guard}`;
    const lashText = 'Invented style wording: your wick cracks like a whip, and a creature it hits drops one held object.';
    const blessedText = 'Invented style wording: a candle blessed at the shrine burns in your off hand all day long.';
    const wickwright = EXPECTED_MERGED.classes.find((c) => c.name === 'Wickwright')!;
    const sense = wickwright.features.find((f) => f.name === 'Wick Sense')!;
    const fightingStyle: ClassFeatureDef = {
      level: 1,
      name: 'Fighting Style',
      description: ['Choose one of the options below.', `***Lantern Guard.*** ${styleText}`, `***Wick Lash.*** ${lashText}`, `***Blessed Warrior.*** ${blessedText}`].join('\n\n'),
      ref: { ...sense.ref!, part: 'Fighting Style' },
    };
    const hooked = EXPECTED_MERGED.feats.find((f) => f.name === 'Hooked Reach')!;
    const styleFeat: FeatOption = { ...hooked, id: 'lib:ashen:feat:lantern-guard', name: 'Lantern Guard', description: `Invented feat wording: you raise your lantern like a shield. ${guard}`, ref: { ...hooked.ref!, entryId: 'lib:ashen:feat:lantern-guard', entryName: 'Lantern Guard' } };
    // With the SRD's Paladin, whose Fighting Style prints Blessed Warrior.
    const paladin = SRD_BUILDER_DATA.classes.find((c) => c.id === 'srd:class:paladin')!;
    const classes = [...EXPECTED_MERGED.classes.map((c) => (c.id === wickwright.id ? { ...c, features: [...c.features, fightingStyle] } : c)), paladin];
    const builderData: BuilderData = { ...EXPECTED_MERGED, classes, feats: [...EXPECTED_MERGED.feats, styleFeat] };
    const expected = (part: string) => ({ kind: 'class', entryId: sense.ref!.entryId, part, textCopied: true });
    const h = setup({ builderData, character: fighter() });
    expect((await h.run('update_character', { features_add: [{ name: 'Lantern Guard', description: styleText, source: 'class' }, { name: 'Wick Lash', description: lashText, source: 'class' }] })).isError).toBeUndefined();
    expect(h.sheet().features.map((f) => f.ref)).toEqual([expect.objectContaining(expected('Lantern Guard')), expect.objectContaining(expected('Wick Lash'))]);
    const leveled = setup({ builderData, character: fighter() });
    expect((await leveled.run('level_up', { class_name: 'Fighter', new_features: [{ name: 'Lantern Guard', description: styleText }] })).isError).toBeUndefined();
    expect(leveled.sheet().features.find((f) => f.name === 'Lantern Guard')?.ref).toMatchObject(expected('Lantern Guard'));
    // A style named like one the SRD prints (the SRD Paladin's Blessed Warrior) is no book part's: the DM's words stay.
    const srdNamed = setup({ builderData, character: fighter() });
    expect((await srdNamed.run('update_character', { features_add: [{ name: 'Blessed Warrior', description: blessedText, source: 'class' }] })).isError).toBeUndefined();
    expect(srdNamed.sheet().features[0].ref).toBeUndefined();
    // In the feat's own words, the feat's.
    const feat = setup({ builderData, character: fighter() });
    expect((await feat.run('update_character', { features_add: [{ name: 'Lantern Guard', description: styleFeat.description, source: 'class' }] })).isError).toBeUndefined();
    expect(feat.sheet().features[0].ref).toMatchObject({ kind: 'feat', entryId: 'lib:ashen:feat:lantern-guard' });
  });

  it("a rewrite in the words of the feature it rewrites keeps that feature's own ref: a class's printed fighting style, a trait under an SRD name", async () => {
    // An invented style the Wickwright prints inline, on the sheet with its part's ref, and a 2024 book's style feat of
    // its name that shares one sentence with it.
    const guard = 'While you hold your lantern aloft, the first attack against you each round has Disadvantage.';
    const wickwright = EXPECTED_MERGED.classes.find((c) => c.name === 'Wickwright')!;
    const style = {
      id: 's-guard',
      name: 'Lantern Guard',
      source: 'class' as const,
      sourceName: 'Fighting Style (Wickwright 1)',
      description: `Invented style wording: a wickwright's lantern wards the hand that holds it. ${guard}`,
      ref: importedRef({ entryId: wickwright.id, kind: 'class', entryName: 'Wickwright', part: 'Lantern Guard', textHash: 'h', textCopied: true }),
    };
    const hooked = EXPECTED_MERGED.feats.find((f) => f.name === 'Hooked Reach')!;
    const styleFeat: FeatOption = { ...hooked, id: 'lib:ashen:feat:lantern-guard', name: 'Lantern Guard', description: `Invented feat wording: you raise your lantern like a shield. ${guard}`, ref: { ...hooked.ref!, entryId: 'lib:ashen:feat:lantern-guard', entryName: 'Lantern Guard' } };
    const builderData: BuilderData = { ...EXPECTED_MERGED, feats: [...EXPECTED_MERGED.feats, styleFeat] };
    for (const description of [style.description, `DM ruling: the ward also covers an ally within 5 feet. ${guard}`]) {
      const h = setup({ builderData, character: { ...fighter(), features: [style] } });
      expect((await h.run('update_character', { features_add: [{ name: 'Lantern Guard', description, source: 'class' }] })).isError).toBeUndefined();
      expect(h.sheet().features, description).toEqual([{ ...style, description }]);
    }
    // In the feat's own words, alone or the feat's whole text (more of them than the style's), it is the feat's.
    for (const description of ['Invented feat wording: you raise your lantern like a shield.', styleFeat.description]) {
      const h = setup({ builderData, character: { ...fighter(), features: [style] } });
      expect((await h.run('update_character', { features_add: [{ name: 'Lantern Guard', description, source: 'class' }] })).isError).toBeUndefined();
      expect(h.sheet().features[0].ref, description).toMatchObject({ kind: 'feat', entryId: 'lib:ashen:feat:lantern-guard' });
    }
    // A Mothkin trait under the SRD's feat name Grappler, resent in its words that share a run with a book's Grappler.
    const silk = 'Invented book wording: you learn the gloamwood hold, pinning a foe beneath a net of moth silk and lamplight.';
    const grappler: FeatOption = { ...hooked, id: 'lib:gloam:feat:grappler', name: 'Grappler', category: 'general', description: `${silk} Invented: a second sentence of the feat.`, ref: { ...hooked.ref!, entryId: 'lib:gloam:feat:grappler', entryName: 'Grappler' } };
    const trait = {
      id: 't-grappler',
      name: 'Grappler',
      source: 'species' as const,
      sourceName: 'Mothkin',
      description: `Invented trait wording: moth-folk wrestle with silk. ${silk}`,
      ref: importedRef({ entryId: mothkin.id, kind: 'species', entryName: 'Mothkin', part: 'Grappler', textHash: 'h', textCopied: true }),
    };
    const resent = setup({ builderData: { ...EXPECTED_MERGED, feats: [...EXPECTED_MERGED.feats, grappler] }, character: { ...fighter(), features: [trait] } });
    expect((await resent.run('update_character', { features_add: [{ name: 'Grappler', description: trait.description, source: 'species' }] })).isError).toBeUndefined();
    expect(resent.sheet().features).toEqual([trait]);
  });

  it("a species trait or class feature under a book feat's name the SRD doesn't print stays the DM's in words the SRD prints, on features_add and level_up alike", async () => {
    // The book's Lantern Bearer reprints a stock sentence an SRD entry prints too.
    const stock = 'Increase your Wisdom or Charisma score by 1, to a maximum of 20.';
    const ward = 'While you hold a lit lantern, you and allies within 10 feet of you have Advantage on saving throws to avoid or end the Frightened condition.';
    const rules = [...RULES, { ...entry('srd:feat:stock-wording', 'Stock Wording', 'feat'), text: `Stock Wording. ${stock}` }];
    const ruling = `DM ruling: the glow also wakes sleeping allies within 10 feet. ${stock}`;
    for (const source of ['species', 'class', 'subclass'] as const) {
      const h = setup({ rules, character: fighter() });
      expect((await h.run('update_character', { features_add: [{ name: 'Lantern Bearer', description: ruling, source }] })).isError).toBeUndefined();
      expect(h.sheet().features.find((f) => f.name === 'Lantern Bearer')?.ref, source).toBeUndefined();
      expect(exported(h.sheet()), source).toContain('wakes sleeping allies');
    }
    const h = setup({ rules, character: fighter() });
    expect((await h.run('level_up', { class_name: 'Fighter', new_features: [{ name: 'Lantern Bearer', description: ruling }] })).isError).toBeUndefined();
    expect(h.sheet().features.find((f) => f.name === 'Lantern Bearer')?.ref).toBeUndefined();
    // The feat's own words still link it.
    const own = setup({ rules, character: fighter() });
    expect((await own.run('level_up', { class_name: 'Fighter', new_features: [{ name: 'Lantern Bearer', description: `${ruling} ${ward}` }] })).isError).toBeUndefined();
    expect(own.sheet().features.find((f) => f.name === 'Lantern Bearer')?.ref).toMatchObject({ kind: 'feat', entryName: 'Lantern Bearer', textCopied: true });
  });

  it("features_add and level_up extras that name one of the book's parts get its ref; a name the SRD prints too stays the DM's", async () => {
    const wick = EXPECTED_MERGED.classes.find((c) => c.name === 'Wickwright')!.features.find((f) => f.name === 'Wick Sense')!;
    const smoke = EMBER.features.find((f) => f.name === 'Smoke Step')!;
    const h = setup({ character: fighter() });
    expect((await h.run('update_character', { features_add: [{ name: 'Wick Sense', description: wick.description, source: 'class' }] })).isError).toBeUndefined();
    expect((await h.run('update_character', { features_add: [{ name: 'Ability Score Improvement', description: 'Strength +2.', source: 'class' }] })).isError).toBeUndefined();
    expect((await h.run('level_up', { class_name: 'Fighter', subclass: 'Ember Warden', new_features: [{ name: 'Smoke Step', description: smoke.description }] })).isError).toBeUndefined();
    const c = h.sheet();
    expect(c.features.find((f) => f.name === 'Wick Sense')?.ref?.textCopied).toBe(true);
    expect(c.features.find((f) => f.name === 'Smoke Step')?.ref?.textCopied).toBe(true);
    expect(c.features.find((f) => f.name === 'Ability Score Improvement')?.ref).toBeUndefined();
    const text = exported(c);
    for (const marker of GLOAMWOOD_MARKERS) expect(text).not.toContain(marker);
  });

  it("a level_up extra that repeats a book subclass's words gets its ref though a 2024 book's class shares that subclass too", async () => {
    const smoke = EMBER.features.find((f) => f.name === 'Smoke Step')!;
    const srdFighter = EXPECTED_MERGED.classes.find((c) => c.id === FIGHTER.id)!;
    const bookFighter: ClassOption = {
      ...srdFighter,
      id: 'lib:gloam:class:fighter',
      subclasses: [],
      sharedSubclasses: [...srdFighter.subclasses],
      source: { sourceId: 'gloam', title: GLOAMWOOD_TITLE, recordId: 'rec:gloam:class:fighter', format: '2024', adaptations: [] },
    };
    const data: BuilderData = { ...EXPECTED_MERGED, classes: [...EXPECTED_MERGED.classes, bookFighter] };
    const h = setup({ builderData: data, character: fighter() });
    const out = await h.run('level_up', { class_name: 'Fighter', subclass: 'Ember Warden', new_features: [{ name: 'Smoke Step', description: smoke.description }] });
    expect(out.isError).toBeUndefined();
    expect(h.sheet().features.find((f) => f.name === 'Smoke Step')?.ref?.textCopied).toBe(true);
    const text = exported(h.sheet());
    for (const marker of GLOAMWOOD_MARKERS) expect(text).not.toContain(marker);
  });

  describe("free text that repeats a book's spell or item is marked copied, wherever the DM puts it (spec §7.1)", () => {
    // Invented book text; the Ember Burst line shares a sentence with the SRD's Fireball (SAMPLE_RULES).
    const CHOIR = `A choir of ash rises around you and sings until the end of your next turn. ${GLOAMWOOD_MARKERS[3]} Each creature of your choice that hears it has Disadvantage on its next attack roll.`;
    const LANTERN = `This lantern burns without oil and never gutters in the wind. ${GLOAMWOOD_MARKERS[5]} While it is lit, Invisible creatures within its light shed a pale glow of their own.`;
    const SRD_LINE = 'Each creature in a 20-foot-radius Sphere makes a Dexterity saving throw, taking 8d6 Fire damage';
    const book = (name: string, kind: CompendiumEntry['kind'], text: string, data: Record<string, unknown> = {}, id = gloamwoodEntryId(name)) => ({ ...entry(id, name, kind, data), text });
    // Stock wording two book weapons print alike; the SRD's Opportunity Attacks rule (SAMPLE_RULES) reprinted in a book
    // spell; a book's typographic apostrophes.
    const STOCK = 'You gain a +1 bonus to attack and damage rolls made with this magic weapon.';
    const OA = 'You can make an Opportunity Attack when a creature that you can see leaves your reach using its action, Bonus Action, Reaction, or one of its speeds.';
    const CALM = 'You can’t be Charmed while it’s attuned to you, and the amulet’s wearer doesn’t need to sleep.';
    const rules = [
      ...RULES.filter((e) => e.name !== 'Ashen Choir' && e.name !== 'Lantern of Hollow Light'),
      book('Ashen Choir', 'spell', CHOIR, { level: 2 }),
      book('Ember Burst', 'spell', `Embers burst at a point you choose. ${SRD_LINE} on a failed save.`, { level: 3 }, 'lib:gloam:900'),
      book('Lantern of Hollow Light', 'magic-item', LANTERN, { rarity: 'uncommon', attunement: true }),
      book('Grudgewick Axe', 'magic-item', `${STOCK} The axe remembers every grudge and mutters them at night.`, {}, 'lib:gloam:901'),
      book('Moonwick Blade', 'magic-item', `${STOCK} ${GLOAMWOOD_MARKERS[1]} Its edge shines like the moon on still water.`, {}, 'lib:gloam:902'),
      book('Binding Ash', 'spell', `Ash binds a foe in place. ${OA}`, { level: 1 }, 'lib:gloam:903'),
      book('Moth-Calm Amulet', 'magic-item', CALM, {}, 'lib:gloam:904'),
    ];
    const spellOf = (h: ReturnType<typeof setup>, name: string) => h.sheet().spellcasting?.spells.find((s) => s.name === name);
    const itemOf = (h: ReturnType<typeof setup>, name: string) => h.sheet().inventory.find((i) => i.name === name);
    const own = 'Once per dawn, at the old shrine, without a slot.';

    it("spells_add notes: a book's words on its own spell or on any other mark the ref copied; SRD wording and the DM's words don't", async () => {
      const h = setup({ rules });
      const out = await h.run('update_character', {
        spells_add: [
          { name: 'Ashen Choir', level: 2, notes: CHOIR.slice(0, 120) },
          { name: 'Hymn of Ash', level: 2, notes: `Granted by the choir: ${CHOIR}` },
          { name: 'Fireball', level: 3, notes: SRD_LINE },
          { name: 'Sleep', level: 1, notes: own },
        ],
      });
      expect(out.isError).toBeUndefined();
      const by = (name: string) => h.sheet().spellcasting?.spells.find((s) => s.name === name);
      expect(by('Ashen Choir')).toMatchObject({ id: gloamwoodEntryId('Ashen Choir'), ref: { entryName: 'Ashen Choir', textCopied: true } });
      expect(by('Ashen Choir')?.ref?.textHash).not.toBe('');
      expect(by('Hymn of Ash')).toMatchObject({ ref: { kind: 'spell', entryName: 'Ashen Choir', sourceTitle: GLOAMWOOD_TITLE, textCopied: true } });
      expect(by('Fireball')?.ref).toBeUndefined();
      expect(by('Sleep')?.ref).toBeUndefined();
      // The DM's sheet wraps the copied notes, and an export keeps only the DM's own.
      expect(characterSheetText(h.sheet())).toContain(`- Hymn of Ash: <imported-content source="${GLOAMWOOD_TITLE}">`);
      const text = exported(h.sheet());
      expect(text).not.toContain(GLOAMWOOD_MARKERS[3]);
      expect(text).toContain(own);
      expect(text).toContain(SRD_LINE);
    });

    it("an item's description: a book's item's words on a custom or an SRD item take that item's ref; the DM's words don't", async () => {
      const h = setup({ rules, character: fighter() });
      const out = await h.run('update_character', {
        inventory_add: [
          { name: 'Pale Lantern', quantity: 1, description: `My grandmother's. ${LANTERN}` },
          { name: 'Rope', quantity: 1, description: LANTERN.slice(0, 100) },
          { name: 'Odd Rock', quantity: 1, description: own },
        ],
      });
      expect(out.isError).toBeUndefined();
      const by = (name: string) => h.sheet().inventory.find((i) => i.name === name);
      expect(by('Pale Lantern')).toMatchObject({ description: `My grandmother's. ${LANTERN}`, ref: { kind: 'magic-item', entryName: 'Lantern of Hollow Light', textCopied: true } });
      expect(by('Pale Lantern')?.bonuses).toBeUndefined(); // marked, not linked: the DM's item keeps its own numbers
      expect(by('Rope')).toMatchObject({ compendiumId: 'srd:item:rope', ref: { entryName: 'Lantern of Hollow Light', textCopied: true } });
      expect(by('Odd Rock')?.ref).toBeUndefined();
      // inventory_update: the same words given later.
      expect((await h.run('update_character', { inventory_update: [{ name: 'Odd Rock', description: LANTERN }] })).isError).toBeUndefined();
      expect(by('Odd Rock')).toMatchObject({ description: LANTERN, ref: { entryName: 'Lantern of Hollow Light', textCopied: true } });
      const text = exported(h.sheet());
      expect(text).not.toContain(GLOAMWOOD_MARKERS[5]);
    });

    it('a spell re-added without notes (to unprepare it) keeps its notes, and so their copy mark (addSpell merges)', async () => {
      const h = setup({ rules });
      await h.run('update_character', { spells_add: [{ name: 'Ashen Choir', level: 2, notes: CHOIR.slice(0, 120) }] });
      await h.run('update_character', { spells_add: [{ name: 'Ashen Choir', level: 2, prepared: false }] });
      expect(spellOf(h, 'Ashen Choir')).toMatchObject({ prepared: false, notes: CHOIR.slice(0, 120), ref: { textCopied: true } });
      expect(exported(h.sheet())).not.toContain(GLOAMWOOD_MARKERS[3]);
    });

    it("reads a copy across kinds: a scroll quoting a book's spell, a spell's notes quoting a book's item", async () => {
      const h = setup({ rules });
      await h.run('update_character', {
        inventory_add: [{ name: 'Spell Scroll (Ashen Choir)', quantity: 1, magic: true, description: `Reading it casts the spell: ${CHOIR}` }],
        spells_add: [{ name: 'Faerie Fire', level: 1, notes: `From the lantern: ${LANTERN}` }],
      });
      expect(itemOf(h, 'Spell Scroll (Ashen Choir)')?.ref).toMatchObject({ kind: 'spell', entryName: 'Ashen Choir', textCopied: true });
      expect(spellOf(h, 'Faerie Fire')?.ref).toMatchObject({ kind: 'magic-item', entryName: 'Lantern of Hollow Light', textCopied: true });
      const text = exported(h.sheet());
      for (const marker of [GLOAMWOOD_MARKERS[3], GLOAMWOOD_MARKERS[5]]) expect(text).not.toContain(marker);
    });

    it('leaves stock wording the books print under several names to the DM, and credits a real copy to its own entry', async () => {
      const h = setup({ rules, character: fighter() });
      await h.run('update_character', {
        inventory_add: [
          { name: "Grandfather's Axe", quantity: 1, magic: true, description: STOCK },
          { name: 'Moon Sword', quantity: 1, magic: true, description: `${STOCK} ${GLOAMWOOD_MARKERS[1]} Its edge shines like the moon on still water.` },
        ],
      });
      expect(itemOf(h, "Grandfather's Axe")?.ref).toBeUndefined();
      expect(itemOf(h, 'Moon Sword')?.ref).toMatchObject({ entryName: 'Moonwick Blade', textCopied: true });
    });

    it("reads a book's typographic apostrophes and the DM's plain ones alike", async () => {
      const h = setup({ rules, character: fighter() });
      await h.run('update_character', { inventory_add: [{ name: 'Calm Charm', quantity: 1, description: CALM.replace(/’/g, "'") }] });
      expect(itemOf(h, 'Calm Charm')?.ref).toMatchObject({ entryName: 'Moth-Calm Amulet', textCopied: true });
    });

    it('leaves SRD wording alone: on a linked book spell, and an SRD rule a book spell reprints', async () => {
      const h = setup({ rules });
      await h.run('update_character', {
        spells_add: [
          { name: 'Ember Burst', level: 3, notes: `${SRD_LINE}; I rule it also lights dry grass.` },
          { name: 'Fireball', level: 3, notes: `As with any reach: ${OA}` },
        ],
      });
      expect(spellOf(h, 'Ember Burst')?.ref).toMatchObject({ entryName: 'Ember Burst', textCopied: false });
      expect(spellOf(h, 'Fireball')?.ref).toBeUndefined();
    });

    it('marks a text under 60 characters on one run of the book, and needs two in a longer one', async () => {
      const h = setup({ rules });
      await h.run('update_character', {
        spells_add: [
          { name: 'Hymn of Embers', level: 2, notes: CHOIR.slice(0, 50) },
          { name: 'Hymn of Smoke', level: 2, notes: `${CHOIR.slice(0, 45)} and then the hymn goes quiet for good.` },
        ],
      });
      expect(spellOf(h, 'Hymn of Embers')?.ref?.entryName).toBe('Ashen Choir');
      expect(spellOf(h, 'Hymn of Smoke')?.ref).toBeUndefined();
    });

    it('reads nothing as copied without the index, or from a text under 40 characters', async () => {
      const h = setup({ rules: rules.filter((e) => !e.id.startsWith('lib:')) });
      await h.run('update_character', { spells_add: [{ name: 'Hymn of Ash', level: 2, notes: CHOIR }], inventory_add: [{ name: 'Pale Lantern', quantity: 1, description: LANTERN }] });
      expect(h.sheet().spellcasting?.spells.find((s) => s.name === 'Hymn of Ash')?.ref).toBeUndefined();
      expect(h.sheet().inventory.find((i) => i.name === 'Pale Lantern')?.ref).toBeUndefined();
      const short = setup({ rules });
      await short.run('update_character', { inventory_add: [{ name: 'Pale Lantern', quantity: 1, description: 'This lantern burns without oil.' }] });
      expect(short.sheet().inventory.find((i) => i.name === 'Pale Lantern')?.ref).toBeUndefined();
    });
  });

  it('a refused call quotes long strings by their length, never their words', async () => {
    const long = `${'Lantern clause binds the wick to the hour of dusk. '.repeat(45)}${GLOAMWOOD_MARKERS[0]}`;
    const h = setup({ character: fighter() });
    const out = await h.run('level_up', { class_name: 'Fighter', new_features: [{ name: 'Lantern Lore', description: long }] });
    expect(out.isError).toBe(true);
    expect(out.content).toContain(`(${long.length} characters)`);
    expect(out.content).not.toContain('Lantern clause');
  });

  it('a refused call quotes even a short description by its length', async () => {
    const h = setup({ character: fighter() });
    const out = await h.run('level_up', { class_name: 'Fighter', new_features: [{ name: 'Thorn Hide', description: 'Your skin grows thorns.', uses_max: 'twice' }] });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('(23 characters)');
    expect(out.content).not.toContain('Your skin grows thorns.');
  });
});

describe('Hit Point maximum adjustments (update_character hp_max, hp.drain, hp_max_end; take_rest)', () => {
  const fighter4 = (extra: Partial<Character> = {}) => hero({ classId: FIGHTER.id, name: 'Fighter', level: 4, hitDie: 10 }, extra);
  const toolLogs = (h: ReturnType<typeof setup>) =>
    (h.s().log as { kind: string; tool?: string; icon?: string; summary?: string }[]).filter((e) => e.kind === 'tool' && e.tool === 'update_character');
  const wraith = { amount: 21, kind: 'damage', damage_type: 'necrotic', drain: 'Life Drain' } as const;

  it('hp_max raises the maximum and current HP for Aid, and the status line keeps it in view (srd:spell:aid)', async () => {
    // "Each target's Hit Point maximum and current Hit Points increase by 5 for the duration."
    const h = setup({ character: fighter4({ hp: { max: 30, current: 20, temp: 0 } }) });
    const out = await h.run('update_character', { hp_max: { name: 'Aid', change: 5, ends: 'long-rest' }, reason: 'Aid from the temple priest' });
    expect(out.isError).toBeUndefined();
    expect(h.sheet().hp).toEqual({ max: 35, current: 25, temp: 0 });
    expect(out.content).toContain('HP maximum 30 → 35, HP 20 → 25 (Aid +5, until a Long Rest)');
    expect(out.content).toContain('· HP 25/35 · HP max includes Aid +5 (until a Long Rest) · AC 12');
    expect(toolLogs(h).at(-1)).toMatchObject({ icon: 'heal', summary: 'HP max 30 → 35, HP 20 → 25 (Aid · until a Long Rest · Aid from the temple priest)' });
  });

  it("hp.drain lowers the maximum by the damage after the Defenses line, temporary HP included (srd:monster:wraith)", async () => {
    // "its Hit Point maximum decreases by an amount equal to the damage taken"; Resistance halves 21 to 10.
    const h = setup({ character: fighter4({ damageResistances: ['Necrotic'] }) });
    const out = await h.run('update_character', { hp: wraith, reason: 'Wraith: Life Drain' });
    expect(h.sheet().hp).toEqual({ max: 20, current: 20, temp: 0 });
    expect(out.content).toContain('Damage adjusted: Resistance to necrotic halves 21 → 10.\nHP 30 → 20 (10 necrotic)\nHP maximum 30 → 20 (Life Drain −10, until a Long Rest)');
    expect(toolLogs(h).at(-1)).toMatchObject({ icon: 'hp', summary: 'HP 30 → 20 (21 necrotic · Wraith: Life Drain) · HP max 30 → 20' });
    // Damage temporary HP absorb is still damage taken.
    const temp = setup({ character: fighter4({ hp: { max: 30, current: 30, temp: 8 } }) });
    await temp.run('update_character', { hp: wraith });
    expect(temp.sheet().hp).toEqual({ max: 9, current: 9, temp: 0 });
  });

  it('judges massive damage before the drain: at 10/30 a 25-point hit leaves the hero dying with a maximum of 5', async () => {
    // srd:rule:damage-and-healing-dropping-to-0-hit-points-instant-death: "the character dies if the remainder equals or
    // exceeds their Hit Point maximum" — 15 left over against 30.
    const h = setup({ character: fighter4({ hp: { max: 30, current: 10, temp: 0 } }) });
    const out = await h.run('update_character', { hp: { ...wraith, amount: 25 } });
    expect(h.sheet().hp).toEqual({ max: 5, current: 0, temp: 0 });
    expect(h.sheet().deathSaves.dead).toBe(false);
    expect(out.content).toContain('Status: Mira Voss (Fighter 4) · HP 0/5 · Dying');
  });

  it('a drain to 0 kills; hp_max is then refused, and hp_max_end gives the maximum back (srd:rule:...-instant-death)', async () => {
    // "A creature dies if its Hit Point maximum reaches 0."
    const h = setup({ character: fighter4({ hp: { max: 30, current: 30, temp: 0 } }) });
    await h.run('update_character', { hp: { amount: 10, kind: 'damage' } });
    const out = await h.run('update_character', { hp_max: { name: 'Mummy Rot', change: -30, ends: 'when-ended' } });
    expect(out.content).toContain('HP maximum 30 → 0 (Mummy Rot −30, until ended): a creature dies if its Hit Point maximum reaches 0.');
    expect(out.content).toContain('· DEAD ·');
    // No advice to end it or switch it at a Long Rest: the dead don't rest (srd:rule:long-rest).
    expect(out.content).not.toContain('stays until you end it');
    const refused = await h.run('update_character', { hp_max: { name: 'Aid', change: 5, ends: 'long-rest' } });
    expect(refused.content).toContain("The hero is dead: the Hit Point maximum doesn't change");
    await h.run('update_character', { hp_max_end: ['Mummy Rot'] });
    expect(h.sheet().hp).toEqual({ max: 30, current: 0, temp: 0 });
    expect(h.sheet().deathSaves.dead).toBe(true);
  });

  it("take_rest long ends Aid, then a drain; Heroes' Feast stays and the result says so (srd:rule:long-rest, srd:spell:heroes-feast)", async () => {
    // Aid's 8 hours are over before the rest finishes; Long Rest: "When you finish the rest … If your Hit Point maximum
    // was reduced, it returns to normal." Heroes' Feast: "which last for 24 hours".
    const h = setup({ character: fighter4() });
    await h.run('update_character', { hp_max: { name: 'Aid', change: 5, ends: 'long-rest' } });
    const feast = await h.run('update_character', { hp_max: { name: "Heroes' Feast", change: 11, ends: 'when-ended' } });
    expect(feast.content).toContain(
      `Heroes' Feast +11 stays until you end it: update_character hp_max_end ["Heroes' Feast"] when its time runs out or its cause ends (the status line keeps it in view).`,
    );
    // The guidance comes once: a later call that leaves the entry as it is doesn't repeat it.
    const hit = await h.run('update_character', { hp: { ...wraith, amount: 12 }, xp_gain: 50 });
    expect(hit.content).not.toContain('stays until you end it');
    expect(h.sheet().hp).toEqual({ max: 34, current: 34, temp: 0 });
    const rest = await h.run('take_rest', { kind: 'long' });
    expect(h.sheet().hp).toEqual({ max: 41, current: 41, temp: 0 });
    expect(h.sheet().hpMaxAdjustments).toEqual([{ name: "Heroes' Feast", amount: 11, ends: 'when-ended' }]);
    expect(rest.content).toContain('Aid +5 ends: HP maximum 34 → 29, HP 34 → 29\nLife Drain −12 ends: HP maximum 29 → 41\nLong rest: HP 29 → 41');
    expect(rest.content).toContain(
      "Still in effect after the rest: Heroes' Feast +11 (until ended). End each with update_character hp_max_end when its time runs out or its cause ends.",
    );
  });

  it('hp_max_end restores a drained maximum (srd:spell:greater-restoration) and names what is in effect for an unknown name', async () => {
    // Greater Restoration ends "Any reduction to the target's Hit Point maximum".
    const h = setup({ character: fighter4() });
    await h.run('update_character', { hp: wraith });
    const unknown = await h.run('update_character', { hp_max_end: ['Aid'] });
    expect(unknown.content).toContain('No Hit Point maximum adjustment named "Aid" (in effect: Life Drain −21 (until a Long Rest)).');
    const out = await h.run('update_character', { hp_max_end: ['Life Drain'], reason: 'Greater Restoration' });
    expect(h.sheet().hp).toEqual({ max: 30, current: 9, temp: 0 });
    expect(out.content).toContain('Life Drain −21 ends: HP maximum 9 → 30');
    expect(toolLogs(h).at(-1)).toMatchObject({ icon: 'info', summary: 'HP max 9 → 30 (ended: Life Drain · Greater Restoration)' });
  });

  it('hp_max_end ends its names together, whatever their order; the log names what ended, and a death (srd:spell:greater-restoration)', async () => {
    // Greater Restoration ends "Any reduction to the target's Hit Point maximum": with Aid still on, ending both in one
    // call never dips the maximum; Aid ended alone kills (srd:rule:...-instant-death).
    const drained = async () => {
      const h = setup({ character: fighter4() });
      await h.run('update_character', { hp_max: { name: 'Aid', change: 5, ends: 'long-rest' } });
      await h.run('update_character', { hp: { amount: 33, kind: 'damage', damage_type: 'necrotic', drain: 'Life Drain' } }); // 2/2
      return h;
    };
    const h = await drained();
    expect(h.sheet().hp).toEqual({ max: 2, current: 2, temp: 0 });
    const both = await h.run('update_character', { hp_max_end: ['Aid', 'Life Drain', 'Bless'], reason: 'Greater Restoration; Aid has run out' });
    expect(h.sheet().hp).toEqual({ max: 30, current: 2, temp: 0 });
    expect(h.sheet().deathSaves.dead).toBe(false);
    expect(toolLogs(h).at(-1)).toMatchObject({ summary: 'HP max 2 → 30 (ended: Aid, Life Drain · Greater Restoration; Aid has run out)' });
    // The name that found nothing is told against what is left, not what the call just ended.
    expect(both.content).toContain('Warning: No Hit Point maximum adjustment named "Bless".');
    // A lasting reduction is taken back before Aid ends too, so the order of the names never kills.
    const ruled = setup({ character: fighter4() });
    await ruled.run('update_character', { hp_max: { name: 'Aid', change: 5, ends: 'long-rest' } }); // 35
    await ruled.run('update_character', { hp_max: { name: 'Mummy Rot', change: -25, ends: 'when-ended' } }); // 10
    await ruled.run('update_character', { hp_max: { name: 'Lost an eye (ruling)', change: -6, ends: 'never' } }); // 4/4
    await ruled.run('update_character', { hp_max_end: ['Aid', 'Lost an eye (ruling)'] });
    expect(ruled.sheet().hp).toEqual({ max: 5, current: 5, temp: 0 });
    expect(ruled.sheet().deathSaves.dead).toBe(false);
    const alone = await drained();
    const out = await alone.run('update_character', { hp_max_end: ['Aid'] });
    expect(out.content).toContain('Aid +5 ends: HP maximum 2 → 0 — a creature dies if its Hit Point maximum reaches 0.');
    expect(toolLogs(alone).at(-1)).toMatchObject({ summary: 'HP max 2 → 0 (ended: Aid · the hero died)' });
  });

  it('hp_max_end logs only what ended: nothing for a lasting entry that stays', async () => {
    const h = setup({ character: fighter4() });
    await h.run('update_character', { hp_max: { name: 'Blessing of the Grove', change: 10, ends: 'never' } }); // 40
    await h.run('update_character', { hp_max: { name: 'Mummy Rot', change: -35, ends: 'when-ended' } }); // 5
    await h.run('update_character', { hp_max: { name: 'Aid', change: 5, ends: 'long-rest' } }); // 10
    const logged = toolLogs(h).length;
    const out = await h.run('update_character', { hp_max_end: ['Blessing of the Grove'] });
    expect(out.content).toContain('Blessing of the Grove +10 stays: taking it back would leave a Hit Point maximum below 1.');
    expect(toolLogs(h)).toHaveLength(logged);
    // With one that ends, the log names only that one.
    await h.run('update_character', { hp_max_end: ['Blessing of the Grove', 'Aid'] });
    expect(toolLogs(h).at(-1)).toMatchObject({ summary: 'HP max 10 → 5 (ended: Aid)' });
    // With the curse in the same call, the curse ends first, so the blessing can be taken back too.
    await h.run('update_character', { hp_max_end: ['Blessing of the Grove', 'Mummy Rot'] });
    expect(toolLogs(h).at(-1)).toMatchObject({ summary: 'HP max 5 → 30 (ended: Blessing of the Grove, Mummy Rot)' });
  });

  it("the hp_max log line gives the arrows, not the amount asked: Harm stops at 1 (srd:spell:harm)", async () => {
    // "This spell can't reduce a target's Hit Point maximum below 1."
    const h = setup({ character: fighter4() });
    await h.run('update_character', { hp_max: { name: 'Harm', change: -40, ends: 'long-rest' } });
    expect(h.sheet().hpMaxAdjustments).toEqual([{ name: 'Harm', amount: -29, ends: 'long-rest' }]);
    expect(toolLogs(h).at(-1)).toMatchObject({ summary: 'HP max 30 → 1, HP 30 → 1 (Harm · until a Long Rest)' });
  });

  it("a curse's reduction is told how to switch to ending at a Long Rest once the cause ends (srd:monster:mummy)", async () => {
    // Mummy: "its Hit Point maximum doesn't return to normal when finishing a Long Rest" while cursed; once the curse
    // ends, the next Long Rest returns it (srd:rule:long-rest).
    const h = setup({ character: fighter4() });
    const out = await h.run('update_character', { hp_max: { name: 'Mummy Rot', change: -10, ends: 'when-ended' } });
    expect(out.content).toContain(
      'Mummy Rot −10 stays until you end it (the status line keeps it in view): update_character hp_max_end ["Mummy Rot"] when its cause ends. If the cause only kept a Long Rest from restoring it (a Mummy\'s curse, a Death Dog\'s poison), it returns at the next Long Rest once the cause ends: then switch it with update_character hp_max_end ["Mummy Rot"] with hp_max {"name": "Mummy Rot", "change": -10, "ends": "long-rest"} in one call.',
    );
    const rest = await h.run('take_rest', { kind: 'long' });
    expect(rest.content).toContain('a Death Dog\'s poison) returns at the next Long Rest once the cause ends');
    // A call that leaves the curse as it is doesn't repeat the guidance.
    const xp = await h.run('update_character', { xp_gain: 50 });
    expect(xp.content).not.toContain('stays until you end it');
    // Mummy: "decreases by 10 (3d6) every 24 hours that elapse": as it grows the call is given again, with the new amount.
    const grown = await h.run('update_character', { hp_max: { name: 'Mummy Rot', change: -7, ends: 'when-ended' } });
    expect(grown.content).toContain('hp_max {"name": "Mummy Rot", "change": -17, "ends": "long-rest"} in one call.');
    // The switch: same maximum, same HP, ending at the next Long Rest.
    await h.run('update_character', { hp_max_end: ['Mummy Rot'], hp_max: { name: 'Mummy Rot', change: -17, ends: 'long-rest' }, reason: 'Remove Curse' });
    expect(h.sheet().hp).toEqual({ max: 13, current: 13, temp: 0 });
    expect(h.sheet().hpMaxAdjustments).toEqual([{ name: 'Mummy Rot', amount: -17, ends: 'long-rest' }]);
    await h.run('take_rest', { kind: 'long' });
    expect(h.sheet().hp).toEqual({ max: 30, current: 30, temp: 0 });
  });

  it('refuses a draining hit whole when its name goes by another end, or is blank: no damage without its drain', async () => {
    const h = setup({ character: fighter4() });
    await h.run('update_character', { hp_max: { name: 'Life Drain', change: -5, ends: 'when-ended' } }); // 25/25
    const logged = toolLogs(h).length;
    const out = await h.run('update_character', { hp: wraith, xp_gain: 50 });
    // The refusal is the hit's alone: the rest of the call applies.
    // hp applies before hp_max_end, so its advice is a name of its own, or the end in an earlier call.
    expect(out.content).toContain(
      'Life Drain −5 (until ended) goes by that name: give the drain a name of its own (as in "Life Drain (Wight)"), or end that one in an earlier call (hp applies before hp_max_end). This hit wasn\'t applied (neither its damage nor its drain).',
    );
    expect(out.content).toContain('+50 XP');
    expect(h.sheet().hp).toEqual({ max: 25, current: 25, temp: 0 });
    expect(toolLogs(h).filter((e) => e.icon !== 'xp')).toHaveLength(logged);
    const blank = await h.run('update_character', { hp: { ...wraith, drain: '   ' } });
    expect(blank.content).toContain('A drain needs a name (the effect, as in "Life Drain").');
    expect(h.sheet().hp).toEqual({ max: 25, current: 25, temp: 0 });
    // Both ways out work. Ending the holder in the same call doesn't (the hit is refused before it ends); in an earlier
    // call it does. A name of its own lands at once (srd:monster:wight: "Life Drain").
    const batched = await h.run('update_character', { hp: wraith, hp_max_end: ['Life Drain'] });
    expect(batched.content).toContain("This hit wasn't applied");
    expect(h.sheet().hp).toEqual({ max: 30, current: 25, temp: 0 });
    await h.run('update_character', { hp: wraith });
    expect(h.sheet().hp).toEqual({ max: 9, current: 4, temp: 0 });
    await h.run('update_character', { hp: { ...wraith, amount: 3, drain: 'Life Drain (Wight)' } });
    expect(h.sheet().hp).toEqual({ max: 6, current: 1, temp: 0 });
    expect(h.sheet().hpMaxAdjustments).toEqual([
      { name: 'Life Drain', amount: -21, ends: 'long-rest' },
      { name: 'Life Drain (Wight)', amount: -3, ends: 'long-rest' },
    ]);
  });

  it('a draining hit that changes nothing (Immunity) logs as a plain hit does', async () => {
    // srd:rule:damage-and-healing-immunity: "Immunity to a damage type means you don't take damage of that type."
    const h = setup({ character: fighter4({ damageImmunities: ['Necrotic'] }) });
    await h.run('update_character', { hp: wraith });
    expect(h.sheet().hp).toEqual({ max: 30, current: 30, temp: 0 });
    expect(toolLogs(h).at(-1)).toMatchObject({ icon: 'hp', summary: 'HP 30 → 30 (21 necrotic)' });
  });

  it('take_rest long: a drained hero Aid kept alive dies when Aid ends, before the rest finishes (srd:spell:aid, srd:rule:long-rest)', async () => {
    const h = setup({ character: fighter4() });
    await h.run('update_character', { hp_max: { name: 'Aid', change: 5, ends: 'long-rest' } });
    await h.run('update_character', { hp: { amount: 33, kind: 'damage', damage_type: 'necrotic', drain: 'Life Drain' } }); // 2/2
    const rest = await h.run('take_rest', { kind: 'long' });
    expect(rest.content).toContain('Long rest: the hero died (an HP maximum reached 0)');
    expect(rest.content).toContain('Aid +5 ends: HP maximum 2 → 0 — a creature dies if its Hit Point maximum reaches 0.');
    expect(h.sheet().deathSaves.dead).toBe(true);
    expect(h.sheet().hpMaxAdjustments).toEqual([{ name: 'Life Drain', amount: -30, ends: 'long-rest' }]);
  });

  it('refuses hp.drain with healing, naming the fix', async () => {
    const h = setup({ character: fighter4() });
    const out = await h.run('update_character', { hp: { amount: 5, kind: 'healing', drain: 'Life Drain' } });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('hp.drain lowers the HP maximum by the damage taken, so it needs kind "damage".');
    expect(h.sheet().hp).toEqual({ max: 30, current: 30, temp: 0 });
  });

  it("initiative_change mends an Alert the app didn't count, and level-ups keep growing it (srd:feat:alert)", async () => {
    // "When you roll Initiative, you can add your Proficiency Bonus to the roll": Fighter 4 (+2), then Fighter 5 (+3).
    const alert = { id: 'al', name: 'Alert', source: 'feat' as const, description: 'Initiative proficiency.' };
    const h = setup({ character: fighter4({ features: [alert] }) });
    const out = await h.run('update_character', { initiative_change: 2, reason: 'Alert the builder missed' });
    expect(out.content).toContain('Initiative +2 → +4');
    expect(out.content).not.toContain('already rolled');
    expect(h.sheet().initiativeBonusExtra).toBe(2);
    await h.run('level_up', { class_name: 'Fighter' });
    expect(h.sheet().initiativeBonusExtra).toBe(3);
    // During a fight: the roll already made stays.
    const fight = setup({ character: fighter4(), state: { combat: sampleCombat() } });
    const during = await fight.run('update_character', { initiative_change: 1 });
    expect(during.content).toContain('The initiative already rolled for this fight stays; the new bonus counts from the next Initiative roll.');
  });
});

// ---------------------------------------------------------------------------
// Spell effects (SPEC §3.3, §3.5): the hero's countdown in a fight, what ends with her Concentration, AC from spells
// ---------------------------------------------------------------------------

describe("update_character in a fight: the hero's countdown follows the sheet (srd:rule:casting-spells-duration)", () => {
  const heroCombatant = (h: ReturnType<typeof setup>) => h.s().combat?.combatants.find((c) => c.isPlayer);
  const concentrating = (spell: string, extra: Partial<Character> = {}) =>
    sampleCharacter({ ...extra, spellcasting: { ...sampleCharacter().spellcasting!, concentratingOn: spell } });
  const counting = (spell: string, roundsLeft: number) => ({
    ...sampleCombat(),
    combatants: sampleCombat().combatants.map((c) => (c.isPlayer ? { ...c, concentrationCountdown: { spell, roundsLeft } } : c)),
  });

  it('counts a spell the call starts from its full duration (srd:spell:bless: up to 1 minute), and says so', async () => {
    const h = setup({ state: { combat: sampleCombat() } });
    const out = await h.run('update_character', { spell_slots_spend: [{ level: 1 }], concentration: 'Bless' });
    expect(out.content).toContain('Concentrating on Bless.\nBless: 10 rounds left.\nStatus: ');
    expect(heroCombatant(h)?.concentrationCountdown).toEqual({ spell: 'Bless', roundsLeft: 10 });
  });

  it('restarts the count on a recast, though the sheet stays as it was (srd:rule:casting-spells-effects-combining-spell-effects)', async () => {
    const h = setup({ character: concentrating('Bless'), state: { combat: counting('Bless', 3) } });
    const out = await h.run('update_character', { concentration: 'Bless' });
    expect(out.content).toContain('Bless: 10 rounds left.');
    expect(heroCombatant(h)?.concentrationCountdown).toEqual({ spell: 'Bless', roundsLeft: 10 });
  });

  it("drops the count when the sheet's Concentration ends: null, another spell, 0 HP", async () => {
    const h = setup({ character: concentrating('Bless'), state: { combat: counting('Bless', 6) } });
    const out = await h.run('update_character', { concentration: null });
    expect(heroCombatant(h)).not.toHaveProperty('concentrationCountdown');
    expect(out.content).not.toContain('rounds left');
    const other = setup({ character: concentrating('Bless'), state: { combat: counting('Bless', 6) } });
    expect((await other.run('update_character', { concentration: 'Web' })).content).toContain('Web: about 60 minutes left.');
    expect(heroCombatant(other)?.concentrationCountdown).toEqual({ spell: 'Web', roundsLeft: 600 });
    // srd:rule:concentration: "Your Concentration ends if you have the Incapacitated condition or you die" (0 HP: Unconscious).
    const felled = setup({ character: concentrating('Bless'), state: { combat: counting('Bless', 6) } });
    await felled.run('update_character', { hp: { amount: 30, kind: 'damage' } });
    expect(felled.sheet().spellcasting?.concentratingOn).toBeNull();
    expect(heroCombatant(felled)).not.toHaveProperty('concentrationCountdown');
  });

  it("says when it can't count a spell, and gives the call that does", async () => {
    const h = setup({ state: { combat: sampleCombat() } });
    const out = await h.run('update_character', { concentration: 'Shadow Lash' });
    expect(out.content).toContain('No countdown for Shadow Lash: give rounds with update_combat concentrate target "Mira Voss" spell "Shadow Lash".');
    expect(heroCombatant(h)).not.toHaveProperty('concentrationCountdown');
  });

  it('writes nothing to a fight that is not there, and leaves the count alone when the call keeps the spell', async () => {
    const idle = setup();
    expect((await idle.run('update_character', { concentration: 'Bless' })).content).not.toContain('rounds left');
    const h = setup({ character: concentrating('Bless'), state: { combat: counting('Bless', 6) } });
    const combat = h.s().combat;
    await h.run('update_character', { hp: { amount: 2, kind: 'damage' } });
    expect(h.s().combat).toBe(combat);
  });
});

describe("what may end with the hero's Concentration (§3.5), named for the DM and never removed", () => {
  it('names the conditions its spell may hold, except those the call itself added', async () => {
    // Mira Voss holds Bandit 1 with Hold Person; an enemy's Hold Person paralyzes her in turn (srd:spell:hold-person).
    const combat = sampleCombat();
    combat.combatants[1] = { ...combat.combatants[1], conditions: [{ id: 'paralyzed', source: 'Hold Person' }] };
    const holder = sampleCharacter({ spellcasting: { ...sampleCharacter().spellcasting!, concentratingOn: 'Hold Person' } });
    const h = setup({ character: holder, state: { combat } });
    const out = await h.run('update_character', { conditions_add: [{ condition: 'Paralyzed', source: 'Hold Person' }] });
    expect(out.content).toContain('Concentration on Hold Person ends (Paralyzed).');
    expect(out.content).toContain('Bandit 1 is Paralyzed (source: Hold Person): if the spell caused it, remove it with update_combat conditions.');
    expect(out.content).not.toContain('Mira Voss is Paralyzed (source: Hold Person)');
    expect(h.s().combat?.combatants[1].conditions).toEqual([{ id: 'paralyzed', source: 'Hold Person' }]);
  });

  it("names the hero's own area on the map with the exact call (srd:spell:spirit-guardians)", async () => {
    const base = sampleMappedCombat({ heroTurn: true });
    const guardians: MapEffect = {
      id: 'e20',
      label: 'Spirit Guardians',
      spec: { shape: 'emanation', sizeFt: 15, fromId: 'c-1' },
      rects: [],
      terrain: ['difficult'],
      duration: 'lasting',
      round: 2,
      turnOfId: 'c-1',
    };
    const map = base.map as NonNullable<CombatState['map']>;
    const holder = sampleCharacter({ spellcasting: { ...sampleCharacter().spellcasting!, concentratingOn: 'Spirit Guardians' } });
    const h = setup({ character: holder, state: { combat: { ...base, map: { ...map, effects: [guardians] } } } });
    const out = await h.run('update_character', { concentration: null });
    expect(out.content).toContain(
      'Still on the map: Spirit Guardians (15-ft Emanation around Mira Voss) — if it was this spell\'s, end it with update_map effects_end ["Spirit Guardians"].',
    );
    expect(h.s().combat?.map?.effects).toHaveLength(1);
  });
});

describe('AC from spells: ac_spells_add and ac_spells_end, the call\'s last step', () => {
  const mail = { id: 'cm', name: 'Chain Mail', quantity: 1, equipped: true, category: 'armor' as const, armor: { kind: 'armor' as const, armorType: 'heavy' as const, baseAc: 16, dexCap: 0 } };
  const fighter = (extra: Partial<Character> = {}) => hero({ classId: FIGHTER.id, name: 'Fighter', level: 4, hitDie: 10 }, extra);
  const mageArmored = (extra: Partial<Character> = {}) => sampleCharacter({ armorClass: 15, acFormula: 'Mage Armor: 13 + DEX 2', acSpells: ['Mage Armor'], ...extra });
  const statusAc = (text: string) => /· (AC \d+(?: \([^)]*\))?)/.exec(text.split('Status: ')[1] ?? '')?.[1];

  it("Mage Armor: base AC 13 + Dexterity (srd:spell:mage-armor), its term for the DM only, and repeats that change nothing", async () => {
    const h = setup();
    const out = await h.run('update_character', { ac_spells_add: ['Mage Armor'] });
    expect(out.isError).toBeUndefined();
    expect(h.sheet()).toMatchObject({ armorClass: 15, acFormula: 'Mage Armor: 13 + DEX 2', acSpells: ['Mage Armor'] });
    expect(out.content).toContain('Mage Armor: AC 12 → 15\nMage Armor counts until a Long Rest (8 hours; no game clock) or ac_spells_end; not while armor is worn.');
    expect(statusAc(out.content)).toBe('AC 15 (Mage Armor)');
    const logged = JSON.stringify(h.s().log);
    expect(logged).toContain('Mage Armor: AC 12 → 15');
    expect(logged).not.toContain('ac_spells');
    const again = await h.run('update_character', { ac_spells_add: ['mage armor'] });
    expect(again.content).toContain('Warning: Mage Armor is already recorded.');
    expect(h.sheet().armorClass).toBe(15);
    const ended = await h.run('update_character', { ac_spells_end: ['Mage Armor'] });
    expect(ended.content).toContain('Mage Armor ends: AC 15 → 12');
    expect(h.sheet()).not.toHaveProperty('acSpells');
    expect((await h.run('update_character', { ac_spells_end: ['Mage Armor'] })).content).toContain("Warning: Mage Armor isn't recorded.");
  });

  it("Shield of Faith: +2 (srd:spell:shield-of-faith), with a nudge when the hero isn't concentrating on it", async () => {
    const h = setup();
    const out = await h.run('update_character', { ac_spells_add: ['Shield of Faith'] });
    expect(out.content).toContain('Shield of Faith: AC 12 → 14');
    expect(out.content).toContain(
      'Mira Voss isn\'t concentrating on Shield of Faith: if Mira Voss cast it, set concentration: "Shield of Faith" so it ends with Mira Voss\'s Concentration; if another caster did, end it with ac_spells_end when that caster\'s Concentration ends.',
    );
    const own = setup();
    const cast = await own.run('update_character', { spell_slots_spend: [{ level: 1 }], concentration: 'Shield of Faith', ac_spells_add: ['Shield of Faith'] });
    expect(cast.content).not.toContain("isn't concentrating on Shield of Faith");
    expect(statusAc(cast.content)).toBe('AC 14 (Shield of Faith)');
    // Its Concentration ends: so does the +2, and the record this call ended isn't "not recorded".
    const ended = await own.run('update_character', { concentration: null, ac_spells_end: ['Shield of Faith'] });
    expect(ended.content).toContain('No longer concentrating on Shield of Faith.\nShield of Faith ends: AC 14 → 12');
    expect(ended.content).not.toContain("isn't recorded");
    expect(own.sheet().armorClass).toBe(12);
  });

  it("never fails the call for a name the app doesn't count, and tells the DM how to count it (srd:spell:shield)", async () => {
    const h = setup();
    const out = await h.run('update_character', { spell_slots_spend: [{ level: 1 }], ac_spells_add: ['Shield'] });
    expect(out.isError).toBeUndefined();
    expect(h.sheet().spellcasting?.slots[1]?.used).toBe(2);
    expect(h.sheet()).not.toHaveProperty('acSpells');
    expect(out.content).toContain(
      "Warning: The app counts AC only for Mage Armor and Shield of Faith, not Shield.\n",
    );
    expect(out.content).toContain(
      "Count Shield yourself: fold its +5 into the dc of attacks on Mira Voss until the start of Mira Voss's next turn; for another lasting effect (Haste, Barkskin) set armor_class and set it back when it ends.",
    );
  });

  it("refuses Mage Armor over armor, and says why it adds nothing under a higher base AC (srd:rule:armor-class)", async () => {
    const armored = setup({ character: fighter({ inventory: [mail], armorClass: 16, acFormula: 'Chain Mail 16' }) });
    const refused = await armored.run('update_character', { ac_spells_add: ['Mage Armor'] });
    expect(refused.content).toContain("Warning: Mage Armor needs a target who isn't wearing armor: Mira Voss wears Chain Mail.");
    expect(armored.sheet()).not.toHaveProperty('acSpells');
    // A Barbarian's Unarmored Defense: 10 + DEX 2 + CON 4 = 16 beats Mage Armor's 15.
    const barbarian = hero(
      { classId: 'srd:class:barbarian', name: 'Barbarian', level: 2, hitDie: 12 },
      { abilityScores: { str: 16, dex: 14, con: 18, int: 8, wis: 12, cha: 8 }, armorClass: 16, acFormula: 'Unarmored Defense: 10 + DEX 2 + CON 4' },
    );
    const h = setup({ character: barbarian });
    const out = await h.run('update_character', { ac_spells_add: ['Mage Armor'] });
    expect(out.content).toContain("Mage Armor gives 15, less than Unarmored Defense's 16: AC stays 16.");
    expect(h.sheet()).toMatchObject({ armorClass: 16, acSpells: ['Mage Armor'] });
    expect(statusAc(out.content)).toBe('AC 16');
  });

  it("pins an old save's hand-set Shield of Faith: 18 on gear that gives 16 turns counted at 18, with no set-armor_class line", async () => {
    const h = setup({ character: fighter({ inventory: [mail], armorClass: 18, acFormula: 'set by the DM: Shield of Faith' }) });
    const out = await h.run('update_character', { ac_spells_add: ['Shield of Faith'] });
    expect(h.sheet()).toMatchObject({ armorClass: 18, acFormula: 'Chain Mail 16 + Shield of Faith 2', acSpells: ['Shield of Faith'] });
    expect(statusAc(out.content)).toBe('AC 18 (Shield of Faith)');
    expect(out.content).toContain('Shield of Faith: AC stays 18');
    expect(out.content).not.toContain('set armor_class');
    expect(out.content).not.toContain('stays as set by hand');
  });

  it('keeps counted spells in an AC set by hand, so their end takes their bonus off', async () => {
    const h = setup({ character: sampleCharacter({ armorClass: 14, acFormula: '10 + DEX 2 + Shield of Faith 2', acSpells: ['Shield of Faith'] }) });
    // srd:spell:haste: "a +2 bonus to Armor Class", set by hand.
    const out = await h.run('update_character', { armor_class: 16, reason: 'Haste' });
    expect(h.sheet()).toMatchObject({ armorClass: 16, acFormula: 'set by the DM: Haste + Shield of Faith 2' });
    expect(statusAc(out.content)).toBe('AC 16 (Shield of Faith)');
    expect(out.content).toContain('Shield of Faith stays recorded, and this AC is taken to include it (ending it takes 2 off). If it has ended, use ac_spells_end.');
    const ended = await h.run('update_character', { ac_spells_end: ['Shield of Faith'] });
    expect(ended.content).toContain('Shield of Faith ends: AC 16 → 14');
    expect(h.sheet()).toMatchObject({ armorClass: 14, acFormula: 'set by the DM: Haste' });
    // An AC the gear gives takes the gear's formula, spells and all: nothing to say.
    const derived = setup({ character: sampleCharacter({ armorClass: 14, acFormula: '10 + DEX 2 + Shield of Faith 2', acSpells: ['Shield of Faith'] }) });
    expect((await derived.run('update_character', { armor_class: 14 })).content).not.toContain('stays recorded');
  });

  it("tells the DM when armor goes on over Mage Armor, which the app doesn't end (srd:rule:armor: donning takes minutes)", async () => {
    const leather = { id: 'la', name: 'Leather Armor', quantity: 1, category: 'armor' as const, weight: 10 };
    const h = setup({ character: mageArmored({ inventory: [...sampleCharacter().inventory, leather] }) });
    const out = await h.run('update_character', { inventory_update: [{ name: 'Leather Armor', equipped: true }] });
    expect(out.content).toContain('Mage Armor isn\'t counted while Mira Voss wears armor: if Mira Voss really put it on, end it with ac_spells_end ["Mage Armor"].');
    expect(h.sheet().acSpells).toEqual(['Mage Armor']);
  });

  it('a Long Rest ends them, and the result says so (srd:spell:mage-armor: Duration 8 hours)', async () => {
    const h = setup({ character: mageArmored() });
    const out = await h.run('take_rest', { kind: 'long' });
    expect(out.content).toContain('Mage Armor ends: AC 15 → 12');
    expect(h.sheet()).toMatchObject({ armorClass: 12 });
    expect(h.sheet()).not.toHaveProperty('acSpells');
  });

  it('refuses armor_class beside ac_spells_add or ac_spells_end before anything changes (H3): the spells move the AC themselves', async () => {
    const refusal =
      'Send ac_spells_add / ac_spells_end and armor_class in separate calls: the spells first (the app moves the AC for them), then armor_class for anything else.';
    // srd:spell:haste ("a +2 bonus to Armor Class") set by hand as an ally's Shield of Faith ends: two calls, never one.
    const h = setup({ character: sampleCharacter({ armorClass: 14, acFormula: '10 + DEX 2 + Shield of Faith 2', acSpells: ['Shield of Faith'] }) });
    const start = h.sheet();
    expect(await h.run('update_character', { armor_class: 14, reason: 'Haste from the bard', ac_spells_end: ['Shield of Faith'] })).toEqual({ isError: true, content: refusal });
    expect(await h.run('update_character', { armor_class: 16, ac_spells_add: ['Mage Armor'], spell_slots_spend: [{ level: 1 }] })).toEqual({ isError: true, content: refusal });
    expect(h.sheet()).toBe(start);
    expect(h.s().log).toHaveLength(0);
    // In two calls, the spells first: the DM's AC is final.
    await h.run('update_character', { ac_spells_end: ['Shield of Faith'] });
    await h.run('update_character', { armor_class: 14, reason: 'Haste from the bard' });
    expect(h.sheet()).toMatchObject({ armorClass: 14, acFormula: 'set by the DM: Haste from the bard' });
  });

  it('says a spell "stays recorded" only while it is still recorded after the call (H3)', () => {
    // The tool refuses armor_class beside ac_spells_end; the line itself reads the records after the call too.
    const before = sampleCharacter({ armorClass: 14, acFormula: '10 + DEX 2 + Shield of Faith 2', acSpells: ['Shield of Faith'] });
    const ended = sampleCharacter({ armorClass: 14, acFormula: 'set by the DM' });
    const input = { armor_class: 16, ac_spells_end: ['Shield of Faith'] };
    expect(acSpellLines(input, before, ended, ['Shield of Faith'], []).join('\n')).not.toContain('stays recorded');
    expect(acSpellLines({ armor_class: 16 }, before, { ...ended, acFormula: 'set by the DM + Shield of Faith 2', acSpells: ['Shield of Faith'] }, ['Shield of Faith'], [])).toContain(
      'Shield of Faith stays recorded, and this AC is taken to include it (ending it takes 2 off). If it has ended, use ac_spells_end.',
    );
  });

  it('tells the DM how to count a name the app doesn\'t, by that name; Shield\'s +5 only for Shield (srd:spell:barkskin, srd:spell:shield)', async () => {
    // srd:spell:barkskin: "the target has an Armor Class of 17 if its AC is lower than that" (Duration: 1 hour).
    const h = setup();
    const bark = await h.run('update_character', { ac_spells_add: ['Barkskin'] });
    expect(bark.content).toContain('Count Barkskin yourself: for a lasting effect set armor_class and set it back when it ends.');
    expect(bark.content).not.toContain('Count Shield yourself');
    const both = await h.run('update_character', { ac_spells_add: ['Shield', 'barkskin'], ac_spells_end: ['Barkskin'] });
    expect(both.content).toContain(
      "Count Shield yourself: fold its +5 into the dc of attacks on Mira Voss until the start of Mira Voss's next turn; for another lasting effect (Haste, Barkskin) set armor_class and set it back when it ends.",
    );
    expect(both.content.match(/Count barkskin yourself|Count Barkskin yourself/g)).toEqual(['Count barkskin yourself']);
    expect(both.content).not.toContain('Count Shield yourself: for a lasting effect');
  });

  it('takes a Shield of Faith recorded while the hero concentrates on it to be that casting, and says so (H4; srd:rule:concentration)', async () => {
    const faithful = sampleCharacter({ spellcasting: { ...sampleCharacter().spellcasting!, concentratingOn: 'Shield of Faith' } });
    const h = setup({ character: faithful });
    const out = await h.run('update_character', { ac_spells_add: ['Shield of Faith'] });
    expect(out.content).toContain('Shield of Faith: AC 12 → 14');
    expect(out.content).toContain("Mira Voss is concentrating on Shield of Faith, so the app takes this +2 to be that casting: it ends with Mira Voss's Concentration.");
    expect(out.content).not.toContain("isn't concentrating on Shield of Faith");
    // Not concentrating on it: the nudge instead.
    const other = setup();
    expect((await other.run('update_character', { ac_spells_add: ['Shield of Faith'] })).content).not.toContain('so the app takes this +2 to be that casting');
  });
});
