/**
 * The class table's counted cells (SPEC-v2 §3.2): a class feature named without a use count whose class table names it
 * with one (SRD 5.2.1 Fighter Features table: "Action Surge (one use)" at 2, "Action Surge (two uses)" at 17), read
 * from the real SRD builder data and from an invented 2024 book's Fighter ("The Lanternfall Handbook") as the offline
 * parser names it: features by their "Level N: Name" headings ("Action Surge", "Indomitable"), the table as printed.
 */
import { describe, expect, it } from 'vitest';
import builderRaw from '../../../public/srd/builder.json?raw';
import { levelUp } from '@/engine';
import { sampleCharacter } from '@/test/fixtures';
import type { BuilderData, ClassLevel, ClassOption, FeatOption, Feature, SpeciesOption, SubclassOption } from '@/types';
import { inferFeatureUses, refreshBookTableCounts, refreshTableCountedUses, type UsesContext } from './featureUses';
import { featureUseChanges, gainedFeatures, refreshFeatureUses } from './leveling';
import { applyFeatChoice, featChoiceTrigger, type FeatPick } from './levelUpChoices';
import { lineageFeatureText, speciesChoices } from './species';

const data = JSON.parse(builderRaw) as BuilderData;
const SRD_FIGHTER = data.classes.find((c) => c.id === 'srd:class:fighter')!;
const def = (cls: ClassOption, name: string) => cls.features.find((f) => f.name === name)!;
// srd:class:fighter, Action Surge: "Once you use this feature, you can't do so again until you finish a Short or Long
// Rest. Starting at level 17, you can use it twice before a rest but only once on a turn." Indomitable: "You can use
// this feature twice before a Long Rest starting at level 13 and three times before a Long Rest starting at level 17."
const SURGE = def(SRD_FIGHTER, 'Action Surge (one use)').description;
const INDOMITABLE = def(SRD_FIGHTER, 'Indomitable (one use)').description;
/** The Fighter Features table's counts by Fighter level (index 0 = level 1; 0 before the feature is gained). */
const SURGE_COUNTS = [0, ...Array<number>(15).fill(1), 2, 2, 2, 2];
const INDOMITABLE_COUNTS = [...Array<number>(8).fill(0), 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3];
const byTable = (values: number[]) => ({ by: 'table', className: 'Fighter', values });

/** The book's Fighter: the SRD's text and table, its features named by their headings, so none at 13 or 17. */
const BOOK: ClassOption = {
  ...SRD_FIGHTER,
  id: 'lib:lantern:class:fighter',
  source: { sourceId: 'lantern', title: 'The Lanternfall Handbook', recordId: 'r-fighter', format: '2024', adaptations: [] },
  subclasses: [],
  features: SRD_FIGHTER.features.filter((f) => !/\((two|three) uses\)$/.test(f.name)).map((f) => ({ ...f, name: f.name.replace(/\s*\(one use\)$/, '') })),
};
const BOOKS = { classes: [BOOK, ...data.classes], species: data.species };

const ctx = (cls: ClassOption | undefined, level: number): UsesContext => ({
  level,
  proficiencyBonus: 2 + Math.floor((level - 1) / 4),
  scores: sampleCharacter().abilityScores,
  ...(cls ? { cls } : {}),
});

const bookFighter = (level: number): ClassLevel => ({
  classId: BOOK.id,
  name: 'Fighter',
  level,
  hitDie: 10,
  casterType: 'none',
  ref: { sourceId: 'lantern', sourceTitle: 'The Lanternfall Handbook', entryId: BOOK.id, kind: 'class', entryName: 'Fighter', format: '2024', textHash: '', textCopied: false },
});
const WIZARD_1: ClassLevel = { classId: 'srd:class:wizard', name: 'Wizard', level: 1, hitDie: 6, casterType: 'full', spellcastingAbility: 'int' };
/** An older book Fighter's entries: "Action Surge" read as 2 from the level-17 sentence, "Indomitable" with no uses. */
const OLD_SURGE: Feature = { id: 'surge', name: 'Action Surge', source: 'class', sourceName: 'Fighter 2', description: SURGE, uses: { max: 2, used: 2, recharge: 'short' } };
const OLD_INDOMITABLE: Feature = { id: 'ind', name: 'Indomitable', source: 'class', sourceName: 'Fighter 9', description: INDOMITABLE };

describe("a book Fighter's counts from its class table (SRD 5.2.1 Fighter Features table)", () => {
  it('reads Action Surge 1 from Fighter 2 and 2 from 17, Indomitable 1, 2 and 3 from 9, 13 and 17, with the table as its scale', () => {
    const read = (name: string, text: string, level: number) => inferFeatureUses(name, text, ctx(BOOK, level));
    expect(read('Action Surge', SURGE, 2)).toEqual({ max: 1, used: 0, recharge: 'short', scale: byTable(SURGE_COUNTS) });
    expect([2, 16, 17, 20].map((level) => read('Action Surge', SURGE, level)?.max)).toEqual([1, 1, 2, 2]);
    expect(read('Indomitable', INDOMITABLE, 9)).toEqual({ max: 1, used: 0, recharge: 'long', scale: byTable(INDOMITABLE_COUNTS) });
    expect([9, 12, 13, 16, 17, 20].map((level) => read('Indomitable', INDOMITABLE, level)?.max)).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it("reads the SRD Fighter's own names as before, and a bare name on it (a DM's \"Action Surge\") by the table: 1 use, not the text's 2", () => {
    expect(inferFeatureUses('Action Surge (one use)', SURGE, ctx(SRD_FIGHTER, 2))).toEqual({ max: 1, used: 0, recharge: 'short' });
    expect(inferFeatureUses('Indomitable (three uses)', INDOMITABLE, ctx(SRD_FIGHTER, 17))).toEqual({ max: 3, used: 0, recharge: 'long' });
    expect(inferFeatureUses('Action Surge', SURGE, ctx(SRD_FIGHTER, 2))).toEqual({ max: 1, used: 0, recharge: 'short', scale: byTable(SURGE_COUNTS) });
  });

  it('keeps the reading of a table that counts nothing, a spell level in the name (srd:class:warlock "Mystic Arcanum (level 6 spell)") and a "(2/rest)" cell', () => {
    const uncounted: ClassOption = { ...BOOK, levelTable: BOOK.levelTable.map((row) => ({ ...row, features: String(row.features).replace(/\s*\(\w+ uses?\)/g, '') })) };
    // The text's own reading, as before: "use it twice" (the level-17 sentence) for Action Surge, none for Indomitable.
    expect(inferFeatureUses('Action Surge', SURGE, ctx(uncounted, 2))).toEqual({ max: 2, used: 0, recharge: 'short' });
    expect(inferFeatureUses('Indomitable', INDOMITABLE, ctx(uncounted, 13))).toBeUndefined();
    const warlock = data.classes.find((c) => c.id === 'srd:class:warlock')!;
    const arcanum = def(warlock, 'Mystic Arcanum (level 6 spell)').description;
    expect(inferFeatureUses('Mystic Arcanum', arcanum, ctx(warlock, 13))).toEqual(inferFeatureUses('Mystic Arcanum', arcanum, ctx(undefined, 13)));
    const lamplighter: ClassOption = {
      ...BOOK,
      id: 'lib:lantern:class:lamplighter',
      name: 'Lamplighter',
      features: [{ level: 2, name: 'Wick Ward', description: 'Invented: ward a wick against the dark.' }],
      levelTable: BOOK.levelTable.map((row) => ({ ...row, features: Number(row.level) === 2 ? 'Wick Ward (2/rest)' : '' })),
    };
    expect(inferFeatureUses('Wick Ward', 'Invented: ward a wick against the dark.', ctx(lamplighter, 2))).toBeUndefined();
  });

  it('reads a cell with emphasis or digits, in a column headed "Class Features"', () => {
    const styled: ClassOption = {
      ...BOOK,
      levelTable: BOOK.levelTable.map(({ features, ...row }) => ({ ...row, classFeatures: Number(row.level) === 17 ? '_Action Surge (2 uses)_, **Indomitable** (3 uses)' : String(features) })),
    };
    expect(inferFeatureUses('Action Surge', SURGE, ctx(styled, 17))?.max).toBe(2);
    expect(inferFeatureUses('Indomitable', INDOMITABLE, ctx(styled, 13))?.max).toBe(2);
    expect(inferFeatureUses('Indomitable', INDOMITABLE, ctx(styled, 17))?.max).toBe(3);
  });
});

describe("the SRD Fighter through the level-up dialog's steps (gainedFeatures, levelUp, refreshFeatureUses)", () => {
  it('keeps one Action Surge and one Indomitable from Fighter 2 to 17 at the table\'s counts, spent uses kept, and reports their growth', () => {
    const family = (features: readonly Feature[], base: string) => features.filter((f) => f.name.startsWith(base)).map((f) => [f.name, f.sourceName, f.uses]);
    let c = sampleCharacter({ classes: [{ classId: SRD_FIGHTER.id, name: 'Fighter', level: 1, hitDie: 10, casterType: 'none' }], spellcasting: undefined, features: [] });
    const spend = (base: string, used: number) => {
      c = { ...c, features: c.features.map((f) => (f.name.startsWith(base) && f.uses ? { ...f, uses: { ...f.uses, used } } : f)) };
    };
    const seen: Record<number, { surge: unknown[]; indomitable: unknown[]; uses: string[] }> = {};
    for (let level = 2; level <= 17; level++) {
      if (level === 13) spend('Indomitable', 1);
      if (level === 17) {
        spend('Action Surge', 1);
        spend('Indomitable', 2);
      }
      const newFeatures = gainedFeatures(SRD_FIGHTER, level, undefined, { scores: c.abilityScores, characterLevel: level });
      const before = c;
      c = refreshFeatureUses(levelUp(c, { className: 'Fighter', classId: SRD_FIGHTER.id, hpMethod: 'average', newFeatures }).character, data);
      seen[level] = { surge: family(c.features, 'Action Surge'), indomitable: family(c.features, 'Indomitable'), uses: featureUseChanges(before, c) };
    }
    expect(seen[2].surge).toEqual([['Action Surge (one use)', 'Fighter 2', { max: 1, used: 0, recharge: 'short' }]]);
    expect(seen[9].indomitable).toEqual([['Indomitable (one use)', 'Fighter 9', { max: 1, used: 0, recharge: 'long' }]]);
    expect(seen[13].indomitable).toEqual([['Indomitable (two uses)', 'Fighter 9', { max: 2, used: 1, recharge: 'long' }]]);
    expect(seen[13].uses).toEqual(['Indomitable (two uses) 1 → 2']);
    expect(seen[17].surge).toEqual([['Action Surge (two uses)', 'Fighter 2', { max: 2, used: 1, recharge: 'short' }]]);
    expect(seen[17].indomitable).toEqual([['Indomitable (three uses)', 'Fighter 9', { max: 3, used: 2, recharge: 'long' }]]);
    expect(seen[17].uses).toEqual(['Action Surge (two uses) 1 → 2', 'Indomitable (three uses) 2 → 3']);
  });

  it('Ability Score Improvement at Fighter 6 and 8 is still added and still opens the feat choice (srd:class:fighter table: "| 6 | +3 | Ability Score Improvement | 3 | 4 |")', () => {
    const asi = def(SRD_FIGHTER, 'Ability Score Improvement');
    let c = sampleCharacter({
      classes: [{ classId: SRD_FIGHTER.id, name: 'Fighter', level: 5, hitDie: 10, casterType: 'none' }],
      spellcasting: undefined,
      features: [{ id: 'asi4', name: asi.name, source: 'class', sourceName: 'Fighter 4', description: asi.description }],
    });
    for (const level of [6, 7, 8]) {
      const newFeatures = gainedFeatures(SRD_FIGHTER, level, undefined, { scores: c.abilityScores, characterLevel: level });
      const trigger = featChoiceTrigger(newFeatures);
      const before = new Set(c.features.map((f) => f.id));
      const r = levelUp(c, { className: 'Fighter', classId: SRD_FIGHTER.id, hpMethod: 'average', newFeatures });
      expect(r.folded).toBeUndefined();
      if (level === 7) {
        expect(trigger).toBeNull();
        c = r.character;
        continue;
      }
      expect(trigger).toMatchObject({ kind: 'asi', featureName: 'Ability Score Improvement' });
      const addedIds = new Set(r.character.features.filter((f) => !before.has(f.id)).map((f) => f.id));
      const applied = applyFeatChoice(r.character, trigger!, { kind: 'plus-two', ability: 'str' }, { className: 'Fighter', classLevel: level, addedIds });
      expect(applied.increases).toEqual([{ ability: 'str', amount: 2 }]);
      c = applied.character;
    }
    expect(c.features.map((f) => [f.name, f.sourceName])).toEqual([
      ['Ability Score Improvement', 'Fighter 4'],
      ['Ability Score Improvement (+2 Strength)', 'Fighter 6'],
      ['Ability Score Improvement (+2 Strength)', 'Fighter 8'],
    ]);
  });
});

describe("a book Fighter's held entries through both level-up paths", () => {
  it('the level-up dialog (refreshFeatureUses) re-reads them by the Fighter level: Fighter 12 / Wizard 1 levelling Wizard keeps 1 Indomitable, a Fighter level gives 2 (srd:rule:multiclassing-class-features)', () => {
    // srd:rule:multiclassing-class-features: "When you gain a new level in a class, you get its features for that level."
    const hero = sampleCharacter({ classes: [bookFighter(12), WIZARD_1], features: [OLD_SURGE, OLD_INDOMITABLE] });
    const wizard = refreshFeatureUses(levelUp(hero, { className: 'Wizard', hpMethod: 'average' }).character, BOOKS);
    expect(wizard.features.map((f) => [f.name, f.uses])).toEqual([
      ['Action Surge', { max: 1, used: 1, recharge: 'short', scale: byTable(SURGE_COUNTS) }],
      ['Indomitable', { max: 1, used: 0, recharge: 'long', scale: byTable(INDOMITABLE_COUNTS) }],
    ]);
    const fighter = refreshFeatureUses(levelUp(hero, { className: 'Fighter', classId: BOOK.id, hpMethod: 'average' }).character, BOOKS);
    expect(fighter.features.map((f) => [f.name, f.uses?.max])).toEqual([['Action Surge', 1], ['Indomitable', 2]]);
  });

  it("the DM's level_up (refreshTableCountedUses) re-reads them too, and the engine grows them at 17 by the table's scale", () => {
    const hero = sampleCharacter({ classes: [bookFighter(13)], spellcasting: undefined, features: [OLD_SURGE, OLD_INDOMITABLE] });
    const reread = refreshTableCountedUses(hero, BOOK, hero.classes[0]);
    expect(reread.features).toEqual([
      { ...OLD_SURGE, uses: { max: 1, used: 1, recharge: 'short', scale: byTable(SURGE_COUNTS) } },
      { ...OLD_INDOMITABLE, uses: { max: 2, used: 0, recharge: 'long', scale: byTable(INDOMITABLE_COUNTS) } },
    ]);
    // Nothing left to re-read: the same character.
    expect(refreshTableCountedUses(reread, BOOK, reread.classes[0])).toBe(reread);
    // A book's class has no SRD rows: its entries grow by their own scale (B8), on the DM's level_up as in the dialog.
    const r = levelUp({ ...reread, classes: [bookFighter(16)] }, { className: 'Fighter', hpMethod: 'average' });
    expect(r.character.features.map((f) => [f.name, f.uses?.max])).toEqual([['Action Surge', 2], ['Indomitable', 3]]);
    expect(r.events.map((e) => e.message)).toContain('Feature uses now: Action Surge 1 → 2 and Indomitable 2 → 3.');
    expect(r.reminders).toContain('Check the Fighter class table for level 17 features and choices.');
  });

  it("the re-read leaves a ruling, a name with its own count, the DM's entry and another class's features as they are", () => {
    const ruled: Feature = { ...OLD_SURGE, uses: { max: 3, used: 0, recharge: 'short', ruled: true } };
    const named: Feature = { ...OLD_INDOMITABLE, name: 'Indomitable (two uses)', uses: { max: 2, used: 0, recharge: 'long' } };
    const dm: Feature = { ...OLD_INDOMITABLE, id: 'dm', sourceName: 'Granted in play' };
    const wizards: Feature = { ...OLD_INDOMITABLE, id: 'wiz', sourceName: 'Wizard 1' };
    const hero = sampleCharacter({ classes: [bookFighter(13), WIZARD_1], features: [ruled, named, dm, wizards] });
    expect(refreshTableCountedUses(hero, BOOK, hero.classes[0])).toBe(hero);
  });

  it('before a level-up in any class, each book class the hero holds is re-read by its own table: one read per class whose entries it changed (refreshBookTableCounts)', () => {
    // srd:rule:fighter-action-surge: "Starting at level 17, you can use it twice before a rest"; srd:rule:fighter-indomitable:
    // "You can use this feature twice before a Long Rest starting at level 13". An older save's book Fighter 13 / Wizard 1.
    const hero = sampleCharacter({ classes: [bookFighter(13), WIZARD_1], spellcasting: undefined, features: [OLD_SURGE, OLD_INDOMITABLE] });
    const { character, reads } = refreshBookTableCounts(hero, BOOKS.classes);
    expect(character.features).toEqual([
      { ...OLD_SURGE, uses: { max: 1, used: 1, recharge: 'short', scale: byTable(SURGE_COUNTS) } },
      { ...OLD_INDOMITABLE, uses: { max: 2, used: 0, recharge: 'long', scale: byTable(INDOMITABLE_COUNTS) } },
    ]);
    expect(reads).toEqual([{ className: 'Fighter', before: hero, after: character }]);
    // Read once, nothing more to read; without the book's data, or for an SRD class (its own bare "Indomitable" without
    // uses on a hand-made sheet included: the dialog's re-read after the level reads that one), nothing at all.
    expect(refreshBookTableCounts(character, BOOKS.classes)).toEqual({ character, reads: [] });
    expect(refreshBookTableCounts(hero, data.classes)).toEqual({ character: hero, reads: [] });
    const srd = sampleCharacter({ classes: [{ classId: SRD_FIGHTER.id, name: 'Fighter', level: 13, hitDie: 10, casterType: 'none' }], spellcasting: undefined, features: [OLD_INDOMITABLE] });
    expect(refreshBookTableCounts(srd, BOOKS.classes)).toEqual({ character: srd, reads: [] });
    // An invented book's Lanternmancer whose table counts its Lantern Ward by name ("(two uses)" at 5) beside it: one
    // read each, in the hero's class order.
    const lantern: ClassOption = {
      ...BOOK,
      id: 'lib:lantern:class:lanternmancer',
      name: 'Lanternmancer',
      features: [{ name: 'Lantern Ward', level: 1, description: 'You raise a ward of lamplight.' }],
      levelTable: Array.from({ length: 20 }, (_, i) => ({ level: i + 1, features: i === 0 ? 'Lantern Ward (one use)' : i === 4 ? 'Lantern Ward (two uses)' : '' })),
    };
    const lanternmancer: ClassLevel = { ...bookFighter(5), classId: lantern.id, name: 'Lanternmancer', ref: { ...bookFighter(5).ref!, entryId: lantern.id, entryName: 'Lanternmancer' } };
    const ward: Feature = { id: 'ward', name: 'Lantern Ward', source: 'class', sourceName: 'Lanternmancer 1', description: 'You raise a ward of lamplight.', uses: { max: 1, used: 0, recharge: 'long' } };
    const both = sampleCharacter({ classes: [bookFighter(13), lanternmancer], spellcasting: undefined, features: [OLD_SURGE, OLD_INDOMITABLE, ward] });
    const two = refreshBookTableCounts(both, [lantern, ...BOOKS.classes]);
    expect(two.reads.map((r) => r.className)).toEqual(['Fighter', 'Lanternmancer']);
    expect(two.reads[1].before).toBe(two.reads[0].after);
    expect(two.character.features[2].uses).toEqual({ max: 2, used: 0, recharge: 'long', scale: { by: 'table', className: 'Lanternmancer', values: [1, 1, 1, 1, ...Array<number>(16).fill(2)] } });
  });
});

describe("a lineage trait's later spells are no use of the trait, however a book words or wraps that paragraph (srd:species:elf, Elven Lineage)", () => {
  // srd:species:elf (srd:species:tiefling's Fiendish Legacy alike): "When you reach character levels 3 and 5, you learn a
  // higher-level spell, as shown on the table. You always have that spell prepared. You can cast it once without a spell
  // slot, and you regain the ability to cast it in that way when you finish a Long Rest." Each spell has its own casting,
  // which the level-up counts beside it ("Faerie Fire (free casting)"), so the trait reads no use off that paragraph.
  const CASTING =
    'you learn a higher-level spell, as shown on the table. You always have that spell prepared. You can cast it once without a spell slot, and you regain the ability to cast it in that way when you finish a Long Rest.';
  /** The review's wordings of an invented book's paragraph: other openings, and the SRD's words wrapped across lines. */
  const WORDINGS = [
    `At character level 3 and again at character level 5, ${CASTING}`,
    `When you reach 3rd and 5th level, ${CASTING}`,
    `Starting at character level 3, and again at 5, ${CASTING}`,
    'When you reach character levels 3 and 5, you learn a\nhigher-level spell, as shown on the table. You always have that spell prepared. You can cast it once without a spell slot, and you regain the ability to cast it in that way when you finish a Long Rest.',
    'When you reach character levels 3 and 5, you learn a higher-level spell, as shown on the\ntable. You always have that spell prepared. You can cast it once without a spell slot, and\nyou regain the ability to cast it in that way when you finish a Long Rest.',
  ];
  /** An invented book's lineage trait (the Quillfolk's Inkbound Heritage) with that paragraph. */
  const inkbound = (later: string, opening = 'You are marked by an inkbound heritage. Choose a heritage from the table. You gain its level 1 benefit.') => ({
    name: 'Inkbound Heritage',
    description: `${opening}\n\n${later}\n\nIntelligence, Wisdom, or Charisma is your spellcasting ability for the spells you cast with this trait (choose the ability when you select the heritage).\n\n| Heritage | Level 1 | Level 3 | Level 5 |\n|---|---|---|---|\n| Sepia | You know the Light cantrip. | Faerie Fire | Darkness |`,
  });
  /** Its Sepia heritage as the app keeps a table row (lineageRowText). */
  const SEPIA = { name: 'Sepia', description: 'You know the Light cantrip. Level 3: Faerie Fire. Level 5: Darkness.' };
  /** A species trait's reading, as the builder's species step and refreshFeatureUses' species branch give it. */
  const asTrait = (level: number): UsesContext => ({ ...ctx(undefined, level), speciesTrait: true });
  /** The trait's uses as the builder and the level-up's refresh read them: its preamble and the chosen heritage. */
  const traitUses = (trait: { name: string; description: string }, level: number) => inferFeatureUses(trait.name, lineageFeatureText(trait, SEPIA), asTrait(level));
  /** The SRD's own free-casting sentence. */
  const CAST = 'You can cast it once without a spell slot, and you regain the ability to cast it in that way when you finish a Long Rest.';
  const ONE_USE = { max: 1, used: 0, recharge: 'long' };

  it('reads no use off the paragraph at any character level, as off the SRD Elf and Tiefling read as species traits', () => {
    for (const later of WORDINGS) for (let level = 1; level <= 20; level++) expect(traitUses(inkbound(later), level), `${later} at ${level}`).toBeUndefined();
    for (const species of data.species.filter((s) => s.name === 'Elf' || s.name === 'Tiefling')) {
      const { lineageTrait, lineages } = speciesChoices(species);
      expect(lineages).toHaveLength(3);
      for (const lineage of lineages) {
        for (let level = 1; level <= 20; level++) expect(inferFeatureUses(lineageTrait!.name, lineageFeatureText(lineageTrait!, lineage), asTrait(level))).toBeUndefined();
      }
    }
  });

  it('knows the paragraph by "learn a higher-level spell" alone, whatever follows: "…from your heritage\'s table" reads no use', () => {
    const own = `At character levels 3 and 5, you learn a higher-level spell from your heritage's table. You always have that spell prepared. ${CAST}`;
    for (let level = 1; level <= 20; level++) expect(traitUses(inkbound(own), level), `level ${level}`).toBeUndefined();
  });

  it('knows "learn a higher-level spell" however the import joined it: the SRD Elf\'s and Tiefling\'s paragraph run into the one before it, with "higherlevel", a U+2010 hyphen or the other spellings, reads no use', () => {
    // srd:species:elf: "You gain the level 1 benefit of that lineage." then "When you reach character levels 3 and 5, you
    // learn a higher-level spell, as shown on the table. … You can cast it once without a spell slot, …"
    // (srd:species:tiefling's Fiendish Legacy alike). The app's PDF reader joins a paragraph to the next when its last
    // line runs long, and re-joins a word hyphenated across lines ("higher-" and "level": "higherlevel"); a text layer
    // can give another hyphen (U+2010, U+2011), a copy a break or a space after the hyphen, or a space alone.
    for (const compound of ['higherlevel', 'higher\u2010level', 'higher\u2011level', 'higher level', 'higher-\nlevel', 'higher- level']) {
      const joined = (text: string) => text.replace('.\n\nWhen you reach character levels 3 and 5, you learn a higher-level spell', `. When you reach character levels 3 and 5, you learn a ${compound} spell`);
      for (const species of data.species.filter((s) => s.name === 'Elf' || s.name === 'Tiefling')) {
        const { lineageTrait, lineages } = speciesChoices(species);
        const trait = { ...lineageTrait!, description: joined(lineageTrait!.description) };
        expect(trait.description).toMatch(new RegExp(`(lineage|legacy)\\. When you reach character levels 3 and 5, you learn a ${compound} spell`));
        for (const lineage of lineages) {
          for (let level = 1; level <= 20; level++) expect(inferFeatureUses(trait.name, lineageFeatureText(trait, lineage), asTrait(level)), `${JSON.stringify(compound)}: ${lineage.name} at ${level}`).toBeUndefined();
        }
      }
    }
  });

  it('leaves out the free-casting sentence a blank line split from that paragraph, in the SRD Elf\'s and Tiefling\'s own words too', () => {
    // The SRD's paragraph (srd:species:elf) as an import broken at a page or column can give it: "You can cast it once
    // without a spell slot" opens a paragraph of its own, right after the one that teaches the spell.
    const split = (text: string) => text.replace('You always have that spell prepared. You can cast it once', 'You always have that spell prepared.\n\nYou can cast it once');
    for (const species of data.species.filter((s) => s.name === 'Elf' || s.name === 'Tiefling')) {
      const { lineageTrait, lineages } = speciesChoices(species);
      const trait = { ...lineageTrait!, description: split(lineageTrait!.description) };
      expect(trait.description).toContain('You always have that spell prepared.\n\nYou can cast it once without a spell slot');
      for (const lineage of lineages) {
        for (let level = 1; level <= 20; level++) expect(inferFeatureUses(trait.name, lineageFeatureText(trait, lineage), asTrait(level)), `${lineage.name} at ${level}`).toBeUndefined();
      }
    }
    // Another opening; "without expending a spell slot"; two blank lines; the sentence split off twice; a break in
    // mid-sentence ("…prepared, and" / "you can cast it once…").
    const opening = 'At character level 3 and again at character level 5, you learn a higher-level spell, as shown on the table. You always have that spell prepared.';
    const expending = 'You can cast it once without expending a spell slot, and you regain the ability to do so when you finish a Long Rest.';
    const midSentence = `${opening.replace(/\.$/, ', and')}\n\nyou can cast it once without a spell slot, regaining the ability to do so when you finish a Long Rest.`;
    for (const later of [`${opening}\n\n${CAST}`, `${opening}\n\n${expending}`, `${opening}\n\n\n\n${CAST}`, `${opening}\n \n${CAST}\n\n${expending}`, midSentence]) {
      for (const level of [1, 3, 5, 20]) expect(traitUses(inkbound(later), level), `${later} at ${level}`).toBeUndefined();
    }
  });

  it("leaves out that free-casting paragraph after three line breaks, or after a paragraph of spaces alone, in the SRD Elf's and Tiefling's own words", () => {
    // srd:species:elf: "You always have that spell prepared. You can cast it once without a spell slot, and you regain
    // the ability to cast it in that way when you finish a Long Rest." An import can leave a third line break, or a line
    // of spaces between two blank lines, where the paragraph was broken.
    for (const gap of ['\n\n\n', '\n\n \n\n']) {
      const split = (text: string) => text.replace('You always have that spell prepared. You can cast it once', `You always have that spell prepared.${gap}You can cast it once`);
      for (const species of data.species.filter((s) => s.name === 'Elf' || s.name === 'Tiefling')) {
        const { lineageTrait, lineages } = speciesChoices(species);
        const trait = { ...lineageTrait!, description: split(lineageTrait!.description) };
        expect(trait.description).toContain(`You always have that spell prepared.${gap}You can cast it once without a spell slot`);
        for (const lineage of lineages) {
          for (let level = 1; level <= 20; level++) {
            expect(inferFeatureUses(trait.name, lineageFeatureText(trait, lineage), asTrait(level)), `${JSON.stringify(gap)}: ${lineage.name} at ${level}`).toBeUndefined();
          }
        }
      }
    }
  });

  it('knows the paragraph by its opening "When you reach character levels 3 and 5" too, whatever it gives: its casting sentence after a blank line or on a wrapped line reads no use', () => {
    // srd:species:elf's paragraph opens "When you reach character levels 3 and 5, you learn a higher-level spell"; an
    // invented book's says "you gain" instead, its free-casting sentence after a blank line, or the paragraph wrapped by
    // single line breaks (a plain-text paste) with that sentence on its third line.
    const gain = 'When you reach character levels 3 and 5, you gain a higher-level spell, as shown on the table. You always have that spell prepared.';
    const wrapped = `When you reach character levels 3 and 5, you gain a higher-level spell, as shown on\nthe table. You always have that spell prepared.\n${CAST}`;
    const wrappedOtherwise =
      'When you reach character levels 3 and 5, you gain a higher-level\nspell, as shown on the table. You always have that spell prepared.\nYou can cast it once without a spell slot, and you regain the ability\nto cast it in that way when you finish a Long Rest.';
    // The last one after three line breaks.
    for (const later of [`${gain}\n\n${CAST}`, wrapped, wrappedOtherwise, `\n${wrapped}`]) {
      for (let level = 1; level <= 20; level++) expect(traitUses(inkbound(later), level), `${later} at ${level}`).toBeUndefined();
    }
    // Broken in mid-sentence ("…its level 1 benefit, and" / "when you reach character levels 3 and 5, …").
    const midSentence = inkbound(wrapped.replace('When you reach', 'when you reach'), 'You are marked by an inkbound heritage. Choose a heritage from the table. You gain its level 1 benefit, and');
    for (let level = 1; level <= 20; level++) expect(traitUses(midSentence, level), `mid-sentence at ${level}`).toBeUndefined();
    // The SRD Elf's and Tiefling's paragraph so worded and split, for every lineage.
    for (const species of data.species.filter((s) => s.name === 'Elf' || s.name === 'Tiefling')) {
      const { lineageTrait, lineages } = speciesChoices(species);
      const description = lineageTrait!.description.replace('you learn a higher-level spell', 'you gain a higher-level spell').replace('prepared. You can cast it once', 'prepared.\n\nYou can cast it once');
      expect(description).toContain('you gain a higher-level spell, as shown on the table. You always have that spell prepared.\n\nYou can cast it once');
      for (const lineage of lineages) {
        for (let level = 1; level <= 20; level++) {
          expect(inferFeatureUses(lineageTrait!.name, lineageFeatureText({ ...lineageTrait!, description }, lineage), asTrait(level)), `${lineage.name} at ${level}`).toBeUndefined();
        }
      }
    }
    // Only a species trait leaves the paragraph out: a feat so worded loses its first line alone, and the sentence on its
    // third line is the feat's own use.
    expect(inferFeatureUses('Starlit Gift', wrapped, ctx(undefined, 5))).toEqual(ONE_USE);
  });

  it("keeps the free-casting sentence anywhere else as the trait's own use: alone, before that paragraph, after another one, or later in the next", () => {
    // srd:feat:magic-initiate, Level 1 Spell: "You always have that spell prepared. You can cast it once without a
    // spell slot, and you regain the ability to cast it in that way when you finish a Long Rest." A trait's own spell
    // alike.
    expect(inferFeatureUses('Inkwell Gift', `You always have the Bless spell prepared.\n\n${CAST}`, asTrait(1))).toEqual(ONE_USE);
    const before = `You are marked by an inkbound heritage. You always have the Bless spell prepared.\n\n${CAST}`;
    expect(traitUses(inkbound(WORDINGS[0], before), 5)).toEqual(ONE_USE);
    expect(traitUses(inkbound(`${WORDINGS[0]}\n\nYou always have the Bless spell prepared.\n\n${CAST}`), 5)).toEqual(ONE_USE);
    // The paragraph right after the later spells' one, opening with a spell of the trait's own.
    expect(traitUses(inkbound(`${WORDINGS[0]}\n\nYou always have the Bless spell prepared. ${CAST}`), 5)).toEqual(ONE_USE);
  });

  it("keeps every other reading: a use the trait's other paragraphs give, the SRD's opening line and Magic Initiate's free casting", () => {
    // The paragraph ends at a blank line: a use the trait's opening gives still counts.
    const opening = "Choose a heritage from the table. Once you use this trait, you can't do so again until you finish a Long Rest.";
    expect(traitUses(inkbound(WORDINGS[3], opening), 3)).toEqual({ max: 1, used: 0, recharge: 'long' });
    // The SRD's own opening still takes its line away, however the rest of it is worded (as before).
    expect(traitUses(inkbound('When you reach character levels 3 and 5, you gain the spell your heritage names. You can cast it once without a spell slot.'), 5)).toBeUndefined();
    // srd:feat:magic-initiate, Level 1 Spell: "You always have that spell prepared. You can cast it once without a spell
    // slot, and you regain the ability to cast it in that way when you finish a Long Rest." Its paragraph learns no
    // higher-level spell: one use, at every level.
    const initiate = data.feats.find((f) => f.name === 'Magic Initiate')!;
    for (let level = 1; level <= 20; level++) expect(inferFeatureUses(initiate.name, initiate.description, ctx(undefined, level))).toEqual({ max: 1, used: 0, recharge: 'long' });
  });
});

describe("only a species trait leaves out the paragraph that teaches a higher-level spell: a class's, a subclass's or a feat's feature reads all of its text but a line that opens \"When you reach character levels 3 and 5\" and speaks of a spell", () => {
  // The paragraph left out is a lineage trait's (srd:species:elf, Elven Lineage: "When you reach character levels 3 and 5,
  // you learn a higher-level spell, as shown on the table."), whose spells' castings the level-up counts beside the trait.
  // Any other feature's free casting is its own use, as an SRD subclass feature's is
  // (srd:rule:sorcerer-draconic-sorcery-dragon-companion: "You can also cast it once without a spell slot, and you regain
  // the ability to cast it in this way when you finish a Long Rest.").
  const CLERIC = data.classes.find((c) => c.id === 'srd:class:cleric')!;
  const ONE_USE = { max: 1, used: 0, recharge: 'long' };
  /** An invented book's subclass of the SRD Cleric, whose level 6 feature teaches a spell and counts its own casting. */
  const ASCENT =
    'Starting at 6th level, you learn a higher-level spell of your choice from the Wizard spell list; it counts as a Cleric spell for you. You can cast it once without expending a spell slot, and you regain the ability to do so when you finish a Long Rest.';
  const STARLIT: SubclassOption = {
    id: 'lib:starbook:subclass:starlit-domain',
    name: 'Starlit Domain',
    summary: 'Invented: a domain of the night sky.',
    source: { sourceId: 'starbook', title: 'The Starbook', recordId: 'r-starlit', format: '2024', adaptations: [] },
    features: [{ level: 6, name: 'Starlit Ascent', description: ASCENT }],
  };
  const cleric6: ClassLevel = { classId: CLERIC.id, name: 'Cleric', level: 6, hitDie: 8, casterType: 'full', spellcastingAbility: 'wis', subclass: 'Starlit Domain', subclassId: STARLIT.id };

  it("an invented book subclass's feature keeps its free casting, 1/1 per Long Rest: read, gained at the level and read again by the dialog", () => {
    expect(inferFeatureUses('Starlit Ascent', ASCENT, ctx(CLERIC, 6))).toEqual(ONE_USE);
    // The level's new feature, as the level-up dialog and the DM's level_up take it.
    const gained = gainedFeatures(CLERIC, 6, STARLIT, { scores: sampleCharacter().abilityScores, characterLevel: 6 }).find((f) => f.name === 'Starlit Ascent');
    expect(gained).toMatchObject({ source: 'subclass', sourceName: 'Starlit Domain 6', uses: ONE_USE });
    // The dialog's re-read after the level: a sheet whose feature holds no uses (as the change before this one read
    // it) gets them.
    const hero = sampleCharacter({ classes: [cleric6], features: [{ id: 'ascent', name: 'Starlit Ascent', source: 'subclass', sourceName: 'Starlit Domain 6', description: ASCENT }] });
    expect(refreshFeatureUses(hero, data).features.find((f) => f.id === 'ascent')?.uses).toEqual(ONE_USE);
    // The same words in a species trait: the paragraph that teaches the spell is left out.
    expect(inferFeatureUses('Starlit Ascent', ASCENT, { ...ctx(undefined, 6), speciesTrait: true })).toBeUndefined();
  });

  it('an invented feat that teaches a higher-level spell keeps its Proficiency Bonus uses: read, taken at an Ability Score Improvement and read again', () => {
    // srd:species:gnome, Forest Gnome: "You can cast it without a spell slot a number of times equal to your Proficiency
    // Bonus, and you regain all expended uses when you finish a Long Rest." The invented feat counts its casting alike.
    const TEXT =
      "You learn a higher-level spell: choose a level 2 spell from any class's spell list. You can cast the spell without a spell slot a number of times equal to your Proficiency Bonus, and you regain all expended uses when you finish a Long Rest.";
    const byPb = (max: number) => ({ max, used: 0, recharge: 'long', scale: { by: 'proficiency-bonus' } });
    expect(inferFeatureUses('Starlit Initiate', TEXT, ctx(undefined, 4))).toEqual(byPb(2));
    expect(inferFeatureUses('Starlit Initiate', TEXT, { ...ctx(undefined, 4), speciesTrait: true })).toBeUndefined();
    // The level-up dialog's feat panel at Fighter 4's Ability Score Improvement, then its re-read at character level 5.
    const feat: FeatOption = { id: 'lib:starbook:feat:starlit-initiate', name: 'Starlit Initiate', category: 'general', description: TEXT };
    const pick: FeatPick = { id: feat.id, name: feat.name, description: TEXT, feat, sourceLabel: 'The Starbook', meetsLevel: true, taken: false, category: 'general' };
    const fighter3 = sampleCharacter({ classes: [{ classId: SRD_FIGHTER.id, name: 'Fighter', level: 3, hitDie: 10, casterType: 'none' }], spellcasting: undefined, features: [] });
    const newFeatures = gainedFeatures(SRD_FIGHTER, 4, undefined, { scores: fighter3.abilityScores, characterLevel: 4 });
    const r = levelUp(fighter3, { className: 'Fighter', classId: SRD_FIGHTER.id, hpMethod: 'average', newFeatures });
    const addedIds = new Set(r.character.features.map((f) => f.id));
    const taken = applyFeatChoice(r.character, featChoiceTrigger(newFeatures)!, { kind: 'feat', pick }, { className: 'Fighter', classLevel: 4, addedIds }).character;
    expect(taken.features.find((f) => f.name === 'Starlit Initiate')?.uses).toEqual(byPb(2));
    const five = refreshFeatureUses(levelUp(taken, { className: 'Fighter', classId: SRD_FIGHTER.id, hpMethod: 'average' }).character, data);
    expect(five.features.find((f) => f.name === 'Starlit Initiate')?.uses).toEqual(byPb(3));
    // The dialog's re-read of a sheet whose feat holds no uses (as the change before this one read it) gives them.
    const older = sampleCharacter({
      classes: [{ classId: SRD_FIGHTER.id, name: 'Fighter', level: 5, hitDie: 10, casterType: 'none' }],
      spellcasting: undefined,
      features: [{ id: 'initiate', name: 'Starlit Initiate', source: 'feat', sourceName: 'Ability Score Improvement (Fighter 4)', description: TEXT }],
    });
    expect(refreshFeatureUses(older, data).features.find((f) => f.id === 'initiate')?.uses).toEqual(byPb(3));
  });
});

describe("the level-up's refresh reads a species trait as one (UsesContext.speciesTrait), the lineage trait and the others", () => {
  // srd:species:elf, Elven Lineage: "When you reach character levels 3 and 5, you learn a higher-level spell, as shown
  // on the table. You always have that spell prepared. You can cast it once without a spell slot, and you regain the
  // ability to cast it in that way when you finish a Long Rest." Read again at each level-up, an invented book's lineage
  // trait and another of its traits worded so read no use off that paragraph; a trait's own Proficiency Bonus uses
  // still grow.
  const later = (spells: string) =>
    `At character level 3 and again at character level 5, you learn a higher-level spell, ${spells}. You always have that spell prepared. You can cast it once without a spell slot, and you regain the ability to cast it in that way when you finish a Long Rest.`;
  const QUILLFOLK: SpeciesOption = {
    id: 'lib:quill:species:quillfolk',
    name: 'Quillfolk',
    summary: 'Medium Humanoid',
    creatureType: 'Humanoid',
    sizes: ['Medium'],
    speed: 30,
    source: { sourceId: 'quill', title: 'The Quillfolk Primer', recordId: 'r-quill', format: '2024', adaptations: [] },
    lineageTrait: 'Inkbound Heritage',
    traits: [
      {
        name: 'Inkbound Heritage',
        description: `You are marked by an inkbound heritage. Choose a heritage from the table.\n\n${later('as shown on the table')}\n\n| Heritage | Level 1 | Level 3 | Level 5 |\n|---|---|---|---|\n| Sepia | You know the Light cantrip. | Faerie Fire | Darkness |`,
      },
      { name: 'Inkwell Gift', description: later('which your inkwell names') },
      { name: 'Blot Step', description: 'You can use this trait a number of times equal to your Proficiency Bonus, and you regain all expended uses when you finish a Long Rest.' },
    ],
    lineages: [{ name: 'Sepia', description: 'You know the Light cantrip. Level 3: Faerie Fire. Level 5: Darkness.' }],
  };

  it("leaves both traits' later-spells paragraphs unread at every level, and grows the other trait's uses", () => {
    const quillData = { classes: data.classes, species: [...data.species, QUILLFOLK] };
    const trait = (name: string, description: string): Feature => ({ id: `f-${name}`, name, source: 'species', sourceName: 'Quillfolk', description });
    let c = sampleCharacter({
      classes: [{ classId: SRD_FIGHTER.id, name: 'Fighter', level: 1, hitDie: 10, casterType: 'none' }],
      species: 'Quillfolk (Sepia heritage)',
      speciesId: QUILLFOLK.id,
      spellcasting: undefined,
      features: [trait('Inkbound Heritage (Sepia)', QUILLFOLK.traits[0].description), trait('Inkwell Gift', QUILLFOLK.traits[1].description), trait('Blot Step', QUILLFOLK.traits[2].description)],
    });
    for (let level = 2; level <= 5; level++) {
      c = refreshFeatureUses(levelUp(c, { className: 'Fighter', classId: SRD_FIGHTER.id, hpMethod: 'average' }).character, quillData);
      expect(
        c.features.map((f) => [f.name, f.uses?.max ?? null]),
        `level ${level}`,
      ).toEqual([
        ['Inkbound Heritage (Sepia)', null],
        ['Inkwell Gift', null],
        ['Blot Step', level < 5 ? 2 : 3],
      ]);
    }
  });
});

describe('a line that opens "When you reach character levels 3 and 5" and speaks of a spell is all any feature leaves out for those words: about anything else, or in mid-line, they take nothing away', () => {
  // srd:species:elf opens its paragraph with them: "When you reach character levels 3 and 5, you learn a higher-level
  // spell". An invented book's lineage trait, feat and subclass feature have them in mid-line, before a use of their own
  // in the SRD's words: srd:species:dragonborn, Breath Weapon: "You can use this Breath Weapon a number of times equal to
  // your Proficiency Bonus, and you regain all expended uses when you finish a Long Rest."; srd:rule:fighter-indomitable:
  // "You can use this feature twice before a Long Rest starting at level 13".
  const byPb = (max: number) => ({ max, used: 0, recharge: 'long', scale: { by: 'proficiency-bonus' } });
  const TWICE = { max: 2, used: 0, recharge: 'long' };
  const CLERIC = data.classes.find((c) => c.id === 'srd:class:cleric')!;
  /** An invented book's Quillfolk: the SRD Elf's later-spells paragraph, then a paragraph with the trait's own uses. */
  const QUILLFOLK: SpeciesOption = {
    id: 'lib:quill:species:quillfolk',
    name: 'Quillfolk',
    summary: 'Medium Humanoid',
    creatureType: 'Humanoid',
    sizes: ['Medium'],
    speed: 30,
    source: { sourceId: 'quill', title: 'The Quillfolk Primer', recordId: 'r-quill', format: '2024', adaptations: [] },
    lineageTrait: 'Inkbound Heritage',
    traits: [
      {
        name: 'Inkbound Heritage',
        description: [
          'You are marked by an inkbound heritage. Choose a heritage from the table. You gain its level 1 benefit.',
          'When you reach character levels 3 and 5, you learn a higher-level spell, as shown on the table. You always have that spell prepared. You can cast it once without a spell slot, and you regain the ability to cast it in that way when you finish a Long Rest. You can also cast the spell using any spell slots you have of the appropriate level.',
          'Your heritage also marks your shadow. When you reach character levels 5 and 9, the mark darkens. You can use this trait a number of times equal to your Proficiency Bonus, and you regain all expended uses when you finish a Long Rest.',
          'Intelligence, Wisdom, or Charisma is your spellcasting ability for the spells you cast with this trait (choose the ability when you select the heritage).',
          '| Heritage | Level 1 | Level 3 | Level 5 |\n|---|---|---|---|\n| Sepia | You know the Light cantrip. | Faerie Fire | Darkness |',
        ].join('\n\n'),
      },
    ],
    lineages: [{ name: 'Sepia', description: 'You know the Light cantrip. Level 3: Faerie Fire. Level 5: Darkness.' }],
  };

  it('an invented lineage trait keeps its own Proficiency Bonus uses after its later-spells paragraph: 2, 3 and 4 at character levels 1, 5 and 9, read and read again', () => {
    const trait = QUILLFOLK.traits[0];
    const text = lineageFeatureText(trait, QUILLFOLK.lineages![0]);
    // Read as a species trait, as the builder's species step reads it.
    expect([1, 5, 9].map((level) => inferFeatureUses(trait.name, text, { ...ctx(undefined, level), speciesTrait: true }))).toEqual([byPb(2), byPb(3), byPb(4)]);
    // The level-up dialog's re-read (refreshFeatureUses' species branch) of a sheet whose trait holds no uses, and at each
    // level-up from Fighter 1 to 9.
    const quillData = { classes: data.classes, species: [...data.species, QUILLFOLK] };
    const fighter = (level: number) =>
      sampleCharacter({
        classes: [{ classId: SRD_FIGHTER.id, name: 'Fighter', level, hitDie: 10, casterType: 'none' }],
        species: 'Quillfolk (Sepia heritage)',
        speciesId: QUILLFOLK.id,
        spellcasting: undefined,
        features: [{ id: 'ink', name: 'Inkbound Heritage (Sepia)', source: 'species', sourceName: 'Quillfolk', description: text }],
      });
    expect([1, 5, 9].map((level) => refreshFeatureUses(fighter(level), quillData).features[0].uses)).toEqual([byPb(2), byPb(3), byPb(4)]);
    let c = fighter(1);
    for (let level = 2; level <= 9; level++) {
      c = refreshFeatureUses(levelUp(c, { className: 'Fighter', classId: SRD_FIGHTER.id, hpMethod: 'average' }).character, quillData);
      expect(c.features[0].uses, `level ${level}`).toEqual(byPb(2 + Math.floor((level - 1) / 4)));
    }
  });

  it('an invented feat keeps its Proficiency Bonus uses: read, taken at an Ability Score Improvement and read again', () => {
    const TEXT =
      'You learn the Starlit tongue. When you reach character levels 4 and 8, your star brightens. You can use this feature a number of times equal to your Proficiency Bonus, and you regain all expended uses when you finish a Long Rest.';
    expect([4, 8].map((level) => inferFeatureUses('Starlit Tongue', TEXT, ctx(undefined, level)))).toEqual([byPb(2), byPb(3)]);
    // The level-up dialog's feat panel at Fighter 4's Ability Score Improvement.
    const feat: FeatOption = { id: 'lib:starbook:feat:starlit-tongue', name: 'Starlit Tongue', category: 'general', description: TEXT };
    const pick: FeatPick = { id: feat.id, name: feat.name, description: TEXT, feat, sourceLabel: 'The Starbook', meetsLevel: true, taken: false, category: 'general' };
    const fighter3 = sampleCharacter({ classes: [{ classId: SRD_FIGHTER.id, name: 'Fighter', level: 3, hitDie: 10, casterType: 'none' }], spellcasting: undefined, features: [] });
    const newFeatures = gainedFeatures(SRD_FIGHTER, 4, undefined, { scores: fighter3.abilityScores, characterLevel: 4 });
    const r = levelUp(fighter3, { className: 'Fighter', classId: SRD_FIGHTER.id, hpMethod: 'average', newFeatures });
    const addedIds = new Set(r.character.features.map((f) => f.id));
    const taken = applyFeatChoice(r.character, featChoiceTrigger(newFeatures)!, { kind: 'feat', pick }, { className: 'Fighter', classLevel: 4, addedIds }).character;
    expect(taken.features.find((f) => f.name === 'Starlit Tongue')?.uses).toEqual(byPb(2));
    // The dialog's re-read of a Fighter 8 whose feat holds no uses.
    const older = sampleCharacter({
      classes: [{ classId: SRD_FIGHTER.id, name: 'Fighter', level: 8, hitDie: 10, casterType: 'none' }],
      spellcasting: undefined,
      features: [{ id: 'tongue', name: 'Starlit Tongue', source: 'feat', sourceName: 'Ability Score Improvement (Fighter 4)', description: TEXT }],
    });
    expect(refreshFeatureUses(older, data).features.find((f) => f.id === 'tongue')?.uses).toEqual(byPb(3));
  });

  it('an invented subclass feature keeps its two uses: read, gained at the level and read again by the dialog', () => {
    const TEXT = 'Your star guides you. When you reach character levels 7 and 11, your star burns brighter. You can use this feature twice, and you regain all expended uses when you finish a Long Rest.';
    const STARFALL: SubclassOption = {
      id: 'lib:starbook:subclass:starfall-domain',
      name: 'Starfall Domain',
      summary: 'Invented: a domain of falling stars.',
      source: { sourceId: 'starbook', title: 'The Starbook', recordId: 'r-starfall', format: '2024', adaptations: [] },
      features: [{ level: 6, name: 'Falling Star', description: TEXT }],
    };
    expect(inferFeatureUses('Falling Star', TEXT, ctx(CLERIC, 6))).toEqual(TWICE);
    // The level's new feature, as the level-up dialog and the DM's level_up take it.
    const gained = gainedFeatures(CLERIC, 6, STARFALL, { scores: sampleCharacter().abilityScores, characterLevel: 6 }).find((f) => f.name === 'Falling Star');
    expect(gained).toMatchObject({ source: 'subclass', sourceName: 'Starfall Domain 6', uses: TWICE });
    const cleric6: ClassLevel = { classId: CLERIC.id, name: 'Cleric', level: 6, hitDie: 8, casterType: 'full', spellcastingAbility: 'wis', subclass: 'Starfall Domain', subclassId: STARFALL.id };
    const hero = sampleCharacter({ classes: [cleric6], features: [{ id: 'star', name: 'Falling Star', source: 'subclass', sourceName: 'Starfall Domain 6', description: TEXT }] });
    expect(refreshFeatureUses(hero, data).features.find((f) => f.id === 'star')?.uses).toEqual(TWICE);
  });

  it('the first line that opens with them and speaks of a spell goes, after spaces or a tab too, whole and alone: the next line, a second such line and a mid-line use stay', () => {
    const USE = 'You can use this feature twice, and you regain all expended uses when you finish a Long Rest.';
    const read = (text: string) => inferFeatureUses('Falling Star', text, ctx(CLERIC, 7));
    for (const text of [
      `When you reach character levels 7 and 11, you learn a spell of your choice. ${USE}`,
      `Your star guides you.\nWhen you reach character levels 7 and 11, you learn a spell of your choice. ${USE}`,
      `Your star guides you.\n  When you reach character levels 7 and 11, you learn a spell of your choice. ${USE}`,
      `Your star guides you.\n\tWhen you reach character levels 7 and 11, you learn a spell of your choice. ${USE}`,
      // The spell named later in the line, in capitals or as "spells".
      `When you reach character levels 7 and 11, your star teaches you two Spells of your choice. ${USE}`,
      // An invented book subclass's feature on one line: its free casting goes with its line, as before.
      'When you reach character levels 3 and 5, you gain a spell of your choice from the Wizard list. You can cast it once without a spell slot, and you regain the ability to do so when you finish a Long Rest.',
    ]) {
      expect(read(text), text).toBeUndefined();
    }
    expect(read(`When you reach character levels 7 and 11, you learn a spell of your choice.\n${USE}`)).toEqual(TWICE);
    expect(read(`When you reach character levels 7 and 11, you learn a spell of your choice.\nWhen you reach character levels 15 and 19, you learn another spell. ${USE}`)).toEqual(TWICE);
    expect(read(`Your star guides you. When you reach character levels 7 and 11, you learn a spell of your choice. ${USE}`)).toEqual(TWICE);
    // A species trait alike, within a paragraph that opens otherwise (one that opens with them it leaves out whole).
    const asTrait = (text: string) => inferFeatureUses('Inkbound Heritage', text, { ...ctx(undefined, 7), speciesTrait: true });
    const TRAIT_USE = 'You can use this trait twice, and you regain all expended uses when you finish a Long Rest.';
    expect(asTrait(`Your heritage marks your shadow.\nWhen you reach character levels 5 and 9, you learn a spell of shadow. ${TRAIT_USE}`)).toBeUndefined();
    expect(asTrait(`Your heritage marks your shadow. When you reach character levels 5 and 9, you learn a spell of shadow. ${TRAIT_USE}`)).toEqual(TWICE);
    expect(asTrait(`Your heritage marks your shadow.\n\nWhen you reach character levels 5 and 9, you learn a spell of shadow.\n${TRAIT_USE}`)).toBeUndefined();
  });

  it('a line or a species paragraph that opens with them about anything but a spell stays, with its use: the first one that speaks of a spell is the line that goes (srd:species:elf; srd:species:dragonborn)', () => {
    // srd:species:elf: "When you reach character levels 3 and 5, you learn a higher-level spell, as shown on the table."
    // Both rules are for such words about spells. An invented book's trait and feat open a paragraph or a line with the
    // same words about something else, then give a use in the SRD's words (srd:species:dragonborn, Breath Weapon: "You can
    // use this Breath Weapon a number of times equal to your Proficiency Bonus, and you regain all expended uses when you
    // finish a Long Rest.").
    const pb = (level: number) => 2 + Math.floor((level - 1) / 4);
    const asTrait = (level: number): UsesContext => ({ ...ctx(undefined, level), speciesTrait: true });
    const TRAIT_PB = 'You can use this trait a number of times equal to your Proficiency Bonus, and you regain all expended uses when you finish a Long Rest.';
    const mark = (opening: string) => `Your heritage marks your shadow.\n\n${opening}\n${TRAIT_PB}`;
    for (let level = 1; level <= 20; level++) {
      // A species trait's paragraph that opens "When you reach character levels 5 and 9, the mark darkens": its use on
      // its second line, or on its opening line, or after "spellcasting" (no spell), stays.
      for (const text of [
        mark('When you reach character levels 5 and 9, the mark darkens and spreads.'),
        `Your heritage marks your shadow.\n\nWhen you reach character levels 5 and 9, the mark darkens and spreads. ${TRAIT_PB}`,
        mark('When you reach character levels 5 and 9, your spellcasting focus darkens with the mark.'),
      ]) {
        expect(inferFeatureUses('Shadow Mark', text, asTrait(level)), `${text} at ${level}`).toEqual(byPb(pb(level)));
      }
      // So worded with a spell (or spells, in any case), the paragraph goes, as the SRD's does.
      for (const spell of ['a spell', 'a Spell', 'two spells', 'two Spells']) {
        expect(inferFeatureUses('Shadow Mark', mark(`When you reach character levels 5 and 9, the mark teaches you ${spell}.`), asTrait(level)), `${spell} at ${level}`).toBeUndefined();
      }
    }
    // A feat whose line opens "When you reach character levels 4 and 8, your star brightens" keeps the use on it,
    // opening the text or a later line, and so does one about spellcasting (no spell).
    const STAR = 'When you reach character levels 4 and 8, your star brightens. You can use this feature a number of times equal to your Proficiency Bonus, and you regain all expended uses when you finish a Long Rest.';
    for (const text of [STAR, `You learn the Starlit tongue.\n${STAR}`, STAR.replace('your star brightens', 'your spellcasting focus brightens')]) {
      expect([4, 8].map((level) => inferFeatureUses('Starlit Tongue', text, ctx(undefined, level))), text).toEqual([byPb(2), byPb(3)]);
    }
    // Such a line before one that speaks of a spell: the spell's line is the one that goes, its use with it.
    expect(inferFeatureUses('Starlit Tongue', `When you reach character levels 4 and 8, your star brightens.\n${STAR.replace('your star brightens', 'you learn a spell')}`, ctx(undefined, 8))).toBeUndefined();
    // The SRD Elf's and Tiefling's paragraph, as the SRD words it or with "gain", still reads none as a species trait,
    // and without the flag loses its line (the round-3 and round-4 "gain a higher-level spell" wordings are above).
    for (const species of data.species.filter((s) => s.name === 'Elf' || s.name === 'Tiefling')) {
      const { lineageTrait, lineages } = speciesChoices(species);
      for (const description of [lineageTrait!.description, lineageTrait!.description.replace('you learn a higher-level spell', 'you gain a higher-level spell')]) {
        for (const lineage of lineages) {
          const text = lineageFeatureText({ ...lineageTrait!, description }, lineage);
          for (let level = 1; level <= 20; level++) {
            expect(inferFeatureUses(lineageTrait!.name, text, asTrait(level)), `${lineage.name} at ${level}`).toBeUndefined();
            expect(inferFeatureUses(lineageTrait!.name, text, ctx(undefined, level)), `${lineage.name} at ${level}, no flag`).toBeUndefined();
          }
        }
      }
    }
  });
});
