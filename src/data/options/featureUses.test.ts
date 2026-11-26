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
import type { BuilderData, ClassLevel, ClassOption, Feature } from '@/types';
import { inferFeatureUses, refreshTableCountedUses, type UsesContext } from './featureUses';
import { featureUseChanges, gainedFeatures, refreshFeatureUses } from './leveling';
import { applyFeatChoice, featChoiceTrigger } from './levelUpChoices';
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
  /** The trait's uses as the builder and the level-up's refresh read them: its preamble and the chosen heritage. */
  const traitUses = (trait: { name: string; description: string }, level: number) => inferFeatureUses(trait.name, lineageFeatureText(trait, SEPIA), ctx(undefined, level));

  it('reads no use off the paragraph at any character level, as off the SRD Elf and Tiefling', () => {
    for (const later of WORDINGS) for (let level = 1; level <= 20; level++) expect(traitUses(inkbound(later), level), `${later} at ${level}`).toBeUndefined();
    for (const species of data.species.filter((s) => s.name === 'Elf' || s.name === 'Tiefling')) {
      const { lineageTrait, lineages } = speciesChoices(species);
      expect(lineages).toHaveLength(3);
      for (const lineage of lineages) {
        for (let level = 1; level <= 20; level++) expect(inferFeatureUses(lineageTrait!.name, lineageFeatureText(lineageTrait!, lineage), ctx(undefined, level))).toBeUndefined();
      }
    }
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
