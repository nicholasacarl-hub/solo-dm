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

import { characterSheetText, levelUp, weaponCritRange } from '@/engine';
import { sampleCharacter } from '@/test/fixtures';
import { EXPECTED_MERGED, GLOAMWOOD_MARKERS, GLOAMWOOD_TITLE, gloamwoodEntryId, importedRef, SRD_BUILDER_DATA, TEXT } from '@/test/structuredFixtures';
import type { BuilderData, Character, ClassFeatureDef, ClassLevel, ClassOption, CompendiumEntry, FeatOption, OptionSource, SubclassOption, TranscriptMessage } from '@/types';
import { redactImportedDeep } from '@/storage/backup';
import { redactCopiedImports } from '@/storage/redact';
import { campaignGraph } from '@/storage/testData';
import type { CampaignData } from '@/storage/types';
import { deps, resetDmDeps, setDmDeps } from '../deps';
import { SAMPLE_RULES } from '../testing/fakeData';
import { setupHarness, type HarnessOptions } from '../testing/harness';
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
    expect(out.content).toContain('Always-prepared Dusk Domain spells added: Faerie Fire, Sleep, Ashen Choir.');
    expect(out.content).toContain('Not in the rules you can consult: Darkness');
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
