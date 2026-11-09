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
import { EXPECTED_MERGED, GLOAMWOOD_MARKERS, GLOAMWOOD_TITLE, gloamwoodEntryId, importedRef, TEXT } from '@/test/structuredFixtures';
import type { BuilderData, Character, ClassLevel, ClassOption, CompendiumEntry, SubclassOption } from '@/types';
import { deps, resetDmDeps } from '../deps';
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
    expect(out.content).toContain('- Ember Ward (The Gloamwood Almanac) — its text is on the sheet');
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

  it('names a tie between classes of the same name and uses the hero’s own', async () => {
    const importedFighter: ClassOption = { ...FIGHTER, id: 'lib:gloam:class:fighter', subclasses: [], source: { sourceId: 'gloam', title: GLOAMWOOD_TITLE, recordId: 'rec:gloam:class:fighter', format: '2024', adaptations: [] } };
    const data: BuilderData = { ...EXPECTED_MERGED, classes: [...EXPECTED_MERGED.classes, importedFighter] };
    const h = setup({ builderData: data, character: hero({ classId: FIGHTER.id, name: 'Fighter', level: 3, hitDie: 10, subclass: 'Champion' }) });
    const out = await h.run('level_up', { class_name: 'Fighter' });
    expect(out.content).toContain("Two classes are named Fighter (SRD 5.2.1, The Gloamwood Almanac); used the hero's own.");
    expect(h.sheet().classes).toHaveLength(1);
    expect(h.sheet().classes[0]).toMatchObject({ classId: FIGHTER.id, level: 4 });
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
      expect(out.content).toContain('- Lantern Stride (The Gloamwood Almanac) — its text is on the sheet');
    });

    it('a new name two subclasses share takes the SRD one, says so, and keeps no book ref on it', async () => {
      const h = setup({ builderData: data, character: hero({ classId: FIGHTER.id, name: 'Fighter', level: 2, hitDie: 10 }) });
      const out = await h.run('level_up', { class_name: 'Fighter', subclass: 'Champion' });
      expect(h.sheet().classes[0]).toMatchObject({ level: 3, subclass: 'Champion', subclassId: 'srd:subclass:champion' });
      expect(h.sheet().classes[0].subclassRef).toBeUndefined();
      expect(out.content).toContain('Two subclasses of Fighter are named Champion (SRD 5.2.1, The Gloamwood Almanac); used the one from SRD 5.2.1.');
    });
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
