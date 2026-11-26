import { describe, expect, it } from 'vitest';
import compendiumRaw from '../../../public/srd/compendium.json?raw';
import { applyLongRest, useFeature } from '@/engine';
import { nameKey } from '@/lib/id';
import { sampleCharacter } from '@/test/fixtures';
import { EXPECTED_MERGED, SRD_BUILDER_DATA, TEXT } from '@/test/structuredFixtures';
import type { BuilderData, Character, ClassLevel, ClassOption, CompendiumEntry, Feature, KnownSpell, SpeciesOption } from '@/types';
import { lineageRowText, splitRow } from '../structured/parse/srdRulesOptions';
import { cantripsKnown, preparedSpellCount } from './classFeatures';
import {
  alwaysPreparedGained,
  applyAlwaysPrepared,
  bookCapBlock,
  bookCapsText,
  bookSpellsOf,
  classSpellRules,
  closeSpellPicks,
  fitsBookCaps,
  freeCastingLines,
  freeCastingNoticeParts,
  freeCastingRuling,
  keepsBookExtra,
  keptBookExtraLines,
  levelSpellsEdit,
  lineageSpellGrants,
  openSpellPicks,
  owedSpells,
  owedSpellsLine,
  owedSpellsSummary,
  recordingHint,
  settleSpellPicks,
  spellPicksAfterLevel,
  withLineageCastings,
  withoutSpellReview,
} from './spellPicks';

const SPELLS = (JSON.parse(compendiumRaw) as CompendiumEntry[]).filter((e) => e.kind === 'spell');
const findSpell = (name: string) => SPELLS.find((e) => nameKey(e.name) === nameKey(name));
const cls = (name: string): ClassOption => {
  const found = SRD_BUILDER_DATA.classes.find((c) => c.name === name);
  if (!found) throw new Error(`no SRD class ${name}`);
  return found;
};
const sub = (className: string, name: string) => {
  const found = cls(className).subclasses.find((s) => s.name === name);
  if (!found) throw new Error(`no SRD subclass ${name}`);
  return found;
};
const entry = (name: string, level: number, extra: Partial<ClassLevel> = {}): ClassLevel => {
  const o = cls(name);
  return { classId: o.id, name: o.name, level, hitDie: o.hitDie, casterType: o.casterType, ...(o.spellcastingAbility ? { spellcastingAbility: o.spellcastingAbility } : {}), ...extra };
};
const spell = (name: string, level: number, source: string, prepared = true, extra: Partial<KnownSpell> = {}): KnownSpell => ({ id: `id-${nameKey(name)}`, name, level, prepared, source, ...extra });
/** A hero of these class entries holding these spells. */
const hero = (classes: ClassLevel[], spells: KnownSpell[], features: Feature[] = []): Character =>
  sampleCharacter({ classes, features, spellcasting: { ability: 'int', slots: {}, spells, concentratingOn: null } });
/** `n` placeholder spells of a level for a class: exactly what counts, nothing the rules index knows. */
const fill = (className: string, n: number, level: number, prepared = true, tag = 'x'): KnownSpell[] =>
  Array.from({ length: n }, (_, i) => spell(`${className} ${tag}${level}-${i}`, level, className, prepared));

const CASTERS = ['Bard', 'Cleric', 'Druid', 'Paladin', 'Ranger', 'Sorcerer', 'Warlock', 'Wizard'];

describe('classSpellRules (srd:rule:gaining-spells, "Preparing Spells", read from each class\'s own Spellcasting text)', () => {
  it('gives each SRD caster its swaps and the Wizard its spellbook', () => {
    const none = { spells: null, fromSpellbook: false, cantrip: false };
    // Bard, Sorcerer, Warlock: "Gain a level, One"; their cantrips too.
    for (const name of ['Bard', 'Sorcerer', 'Warlock']) {
      expect(classSpellRules(cls(name)), name).toEqual({ levelGain: { spell: true, cantrip: true }, longRest: none, spellbook: { start: 0, perLevel: 0 } });
    }
    // Cleric, Druid: "Finish a Long Rest, Any"; a cantrip "Whenever you gain a Cleric level".
    for (const name of ['Cleric', 'Druid']) {
      expect(classSpellRules(cls(name)), name).toEqual({ levelGain: { spell: false, cantrip: true }, longRest: { spells: 'any', fromSpellbook: false, cantrip: false }, spellbook: { start: 0, perLevel: 0 } });
    }
    // Paladin, Ranger: "Finish a Long Rest, One"; no cantrips.
    for (const name of ['Paladin', 'Ranger']) {
      expect(classSpellRules(cls(name)), name).toEqual({ levelGain: { spell: false, cantrip: false }, longRest: { spells: 'one', fromSpellbook: false, cantrip: false }, spellbook: { start: 0, perLevel: 0 } });
    }
    // srd:rule:wizard-spellcasting: "It starts with six level 1 Wizard spells", "Whenever you gain a Wizard level after 1,
    // add two Wizard spells", prepared spells changed after a Long Rest "with spells from your spellbook", and a cantrip.
    expect(classSpellRules(cls('Wizard'))).toEqual({ levelGain: { spell: false, cantrip: false }, longRest: { spells: 'any', fromSpellbook: true, cantrip: true }, spellbook: { start: 6, perLevel: 2 } });
    expect(classSpellRules(cls('Fighter'))).toEqual({ levelGain: { spell: false, cantrip: false }, longRest: none, spellbook: { start: 0, perLevel: 0 } });
  });
});

describe('owedSpells: the class table against the sheet (srd:rule:<class>-spellcasting: "choose additional spells … until the number of spells on your list matches the number on the table")', () => {
  it('owes exactly what the table gains, at every level of every SRD caster, to a hero who chose every time', () => {
    for (const name of CASTERS) {
      const o = cls(name);
      for (let level = 1; level <= 20; level++) {
        const before = level - 1;
        const book = name === 'Wizard' && before >= 1 ? fill(name, 6 + 2 * (before - 1) - preparedSpellCount(o, before), 1, false, 'book') : [];
        const c = hero([entry(name, level)], [...fill(name, cantripsKnown(o, before), 0), ...fill(name, preparedSpellCount(o, before), 1), ...book]);
        const owed = owedSpells(c, c.classes[0], o);
        const where = `${name} ${before} → ${level}`;
        expect(owed, where).not.toBeNull();
        expect(owed?.cantrips?.owed ?? 0, where).toBe(Math.max(0, cantripsKnown(o, level) - cantripsKnown(o, before)));
        expect(owed?.prepared.owed, where).toBe(preparedSpellCount(o, level) - preparedSpellCount(o, before));
        // srd:rule:wizard-spellcasting: six at level 1, then "add two Wizard spells" each Wizard level after 1.
        expect(owed?.spellbook?.owed ?? 0, where).toBe(name === 'Wizard' ? (level === 1 ? 6 : 2) : 0);
      }
    }
  });

  it('counts each class on its own table and its own slots (srd:rule:multiclassing-class-features-spellcasting)', () => {
    // "If you are a level 4 Ranger / level 3 Sorcerer, for example, you can prepare five level 1 Ranger spells, and you
    // can prepare six Sorcerer spells of level 1 or 2 (as well as four Sorcerer cantrips)."
    const c = hero([entry('Ranger', 4), entry('Sorcerer', 3)], []);
    const ranger = owedSpells(c, c.classes[0], cls('Ranger'));
    const sorcerer = owedSpells(c, c.classes[1], cls('Sorcerer'));
    expect(ranger).toMatchObject({ maxLevel: 1, cantrips: null, prepared: { target: 5 } });
    expect(sorcerer).toMatchObject({ maxLevel: 2, cantrips: { target: 4 }, prepared: { target: 6 } });
    // A Warlock's picks follow its Slot Level column (srd:rule:warlock-pact-magic).
    const warlock = hero([entry('Warlock', 5)], []);
    expect(owedSpells(warlock, warlock.classes[0], cls('Warlock'))?.maxLevel).toBe(3);
  });

  it('two levels gained before choosing owe the table once, not twice (srd:rule:wizard-spellcasting)', () => {
    // A Wizard 3 at its table (3 cantrips, 6 prepared, a 10-spell book) taken to Wizard 5 without choosing.
    const spells = [...fill('Wizard', 3, 0), ...fill('Wizard', 6, 1), ...fill('Wizard', 4, 1, false, 'book')];
    const c = hero([entry('Wizard', 5)], spells);
    const owed = owedSpells(c, c.classes[0], cls('Wizard'));
    expect(owed).toMatchObject({ cantrips: { target: 4, held: 3, owed: 1 }, prepared: { target: 9, held: 6, owed: 3 }, spellbook: { target: 14, held: 10, owed: 4 } });
  });

  it("an older Wizard catches its spellbook up too, so its prepared spells can be met from the book", () => {
    // Built at level 1 and levelled to 5 before picks existed: a 6-spell book, 4 prepared. At Wizard 6 the book's
    // minimum is 6 + 2 × 5 = 16 and the table prepares 10.
    const c = hero([entry('Wizard', 6)], [...fill('Wizard', 3, 0), ...fill('Wizard', 4, 1), ...fill('Wizard', 2, 1, false, 'book')]);
    const owed = owedSpells(c, c.classes[0], cls('Wizard'));
    expect(owed).toMatchObject({ prepared: { target: 10, held: 4, owed: 6 }, spellbook: { target: 16, held: 6, owed: 10 } });
    // The book's unprepared spells and its new ones cover the prepared picks: 2 + 10 ≥ 6.
    expect(2 + (owed?.spellbook?.owed ?? 0)).toBeGreaterThanOrEqual(owed?.prepared.owed ?? 0);
  });

  it("counts the chosen Divine Order's extra cantrip on top of the table (srd:rule:cleric-divine-order)", () => {
    // "Thaumaturge. You know one extra cantrip from the Cleric spell list." The builder stores it as a Cleric cantrip.
    const thaumaturge: Feature = { id: 'f-order', name: 'Divine Order (Thaumaturge)', description: '', source: 'class', sourceName: 'Cleric 1' };
    const cantrips = fill('Cleric', 4, 0);
    const at3 = hero([entry('Cleric', 3)], cantrips, [thaumaturge]);
    expect(owedSpells(at3, at3.classes[0], cls('Cleric'))?.cantrips).toEqual({ target: 4, held: 4, owed: 0 });
    // Cleric 4's table gains a cantrip (3 → 4): the extra one doesn't hide it.
    const at4 = hero([entry('Cleric', 4)], cantrips, [thaumaturge]);
    expect(owedSpells(at4, at4.classes[0], cls('Cleric'))?.cantrips).toEqual({ target: 5, held: 4, owed: 1 });
  });

  it("counts only the class's own spells: always prepared, other classes', a species' and a feat's don't count (srd:rule:gaining-spells)", () => {
    const c = hero(
      [entry('Cleric', 1)],
      [
        spell('Bless', 1, 'Life Domain', true, { alwaysPrepared: true }),
        spell('Shield', 1, 'Wizard'),
        spell('Light', 0, 'High Elf'),
        spell('Guidance', 0, 'Magic Initiate (Cleric)'),
        spell('Sacred Flame', 0, 'cleric'),
        spell('Cure Wounds', 1, 'Cleric'),
      ],
    );
    expect(owedSpells(c, c.classes[0], cls('Cleric'))).toMatchObject({ cantrips: { held: 1 }, prepared: { held: 1 } });
  });

  it("can't count a class whose table has no spell columns, and says so with null", () => {
    const c = hero([entry('Fighter', 3)], []);
    expect(owedSpells(c, c.classes[0], cls('Fighter'))).toBeNull();
  });
});

describe('spellPicksAfterLevel: the mark that a level was gained, with its swaps', () => {
  const sorcerer = (level: number, extra: KnownSpell[] = []) => {
    const o = cls('Sorcerer');
    return hero([entry('Sorcerer', level)], [...fill('Sorcerer', cantripsKnown(o, level - 1), 0), ...fill('Sorcerer', preparedSpellCount(o, level - 1), 1), ...extra]);
  };

  it('opens the class with its level-gain swaps (srd:rule:sorcerer-spellcasting)', () => {
    // "Whenever you gain a Sorcerer level, you can replace one spell on your list" and "one of your cantrips".
    const c = sorcerer(6);
    const next = spellPicksAfterLevel(c, c.classes[0], cls('Sorcerer'));
    expect(next.spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:sorcerer', replaceSpell: true, replaceCantrip: true }]);
  });

  it("opens a swap-only level (Bard 12: the table doesn't grow) and closes a level that owes nothing and swaps nothing (Paladin 6)", () => {
    const bard = hero([entry('Bard', 12)], [...fill('Bard', 4, 0), ...fill('Bard', 16, 1)]);
    expect(spellPicksAfterLevel(bard, bard.classes[0], cls('Bard')).spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:bard', replaceSpell: true, replaceCantrip: true }]);
    const paladin = hero([entry('Paladin', 6)], fill('Paladin', 6, 1));
    const marked: Character = { ...paladin, spellcasting: { ...paladin.spellcasting!, spellPicks: [{ classId: 'srd:class:paladin' }] } };
    const after = spellPicksAfterLevel(marked, marked.classes[0], cls('Paladin'));
    expect(after.spellcasting).not.toHaveProperty('spellPicks');
    // Nothing to mark and nothing marked: the same character comes back.
    expect(spellPicksAfterLevel(paladin, paladin.classes[0], cls('Paladin'))).toBe(paladin);
  });

  it('keeps one entry per class, the newest level\'s, and no swaps at the class\'s level 1 or without a spell to give up', () => {
    const c = sorcerer(6);
    const once = spellPicksAfterLevel(c, c.classes[0], cls('Sorcerer'));
    const twice = spellPicksAfterLevel(once, { ...once.classes[0], level: 7 }, cls('Sorcerer'));
    expect(twice.spellcasting?.spellPicks).toHaveLength(1);
    // A new caster class at its level 1 has nothing to replace (srd: "Whenever you gain a Cleric level" swaps).
    const multiclass = hero([entry('Wizard', 3), entry('Cleric', 1)], fill('Wizard', 3, 0));
    expect(spellPicksAfterLevel(multiclass, multiclass.classes[1], cls('Cleric')).spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:cleric' }]);
    // An older Sorcerer with no spells under its name: picks owed, nothing to swap.
    const older = hero([entry('Sorcerer', 6)], [spell('Fire Bolt', 0, 'Granted in play')]);
    expect(spellPicksAfterLevel(older, older.classes[0], cls('Sorcerer')).spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:sorcerer' }]);
  });

  it("leaves a class it can't count as it is", () => {
    const c = hero([entry('Fighter', 3)], []);
    expect(spellPicksAfterLevel(c, c.classes[0], cls('Fighter'))).toBe(c);
  });
});

describe('openSpellPicks: what the sheet shows, live', () => {
  it('settles on its own when the sheet catches up (the DM recorded the picks), and skips a class that is gone', () => {
    const o = cls('Cleric');
    const c = hero([entry('Cleric', 2)], [...fill('Cleric', 3, 0), ...fill('Cleric', 2, 1)]);
    const marked: Character = { ...c, spellcasting: { ...c.spellcasting!, spellPicks: [{ classId: 'srd:class:cleric' }, { classId: 'srd:class:bard', replaceSpell: true }] } };
    const open = openSpellPicks(marked, SRD_BUILDER_DATA.classes);
    expect(open.map((p) => [p.cl.name, p.owed.prepared.owed])).toEqual([['Cleric', preparedSpellCount(o, 2) - 2]]);
    // The DM's spells_add with source "Cleric" fills the list: nothing is shown any more.
    const settled: Character = { ...marked, spellcasting: { ...marked.spellcasting!, spells: [...marked.spellcasting!.spells, ...fill('Cleric', preparedSpellCount(o, 2) - 2, 1, true, 'dm')] } };
    expect(openSpellPicks(settled, SRD_BUILDER_DATA.classes)).toEqual([]);
    expect(closeSpellPicks(marked, 'srd:class:cleric').spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:bard', replaceSpell: true }]);
  });
});

describe('alwaysPreparedGained: always-prepared spells added, or an ordinary pick turned always prepared', () => {
  it("turns a Life Cleric's own Bless and Cure Wounds always prepared, which frees their places (srd:rule:cleric-life-domain-spells, srd:rule:gaining-spells)", () => {
    // The builder recommends Bless, Cure Wounds, Guiding Bolt and Shield of Faith (srd:rule:cleric-spellcasting); at Cleric 3
    // the Life Domain's row grants Aid, Bless, Cure Wounds and Lesser Restoration: "you thereafter always have the listed
    // spells prepared", which "doesn't count against the number of spells on that list".
    const picks = ['Bless', 'Cure Wounds', 'Guiding Bolt', 'Shield of Faith', 'Sanctuary'].map((n) => spell(n, 1, 'Cleric'));
    const c = hero([entry('Cleric', 3, { subclass: 'Life Domain' })], [...fill('Cleric', 3, 0), ...picks]);
    const gain = alwaysPreparedGained(c, cls('Cleric'), sub('Cleric', 'Life Domain'), 3, findSpell);
    expect(gain.add.map((s) => [s.name, s.source, s.alwaysPrepared])).toEqual([
      ['Aid', 'Life Domain', true],
      ['Lesser Restoration', 'Life Domain', true],
    ]);
    expect(gain.flip.map((f) => [f.name, f.source])).toEqual([
      ['Bless', 'Life Domain'],
      ['Cure Wounds', 'Life Domain'],
    ]);
    expect(gain.missing).toEqual([]);
    const next = applyAlwaysPrepared(c, gain);
    expect(next.spellcasting?.spells.find((s) => s.name === 'Bless')).toMatchObject({ alwaysPrepared: true, prepared: true, source: 'Life Domain', id: 'id-bless' });
    // 3 of the table's 6 are now the Cleric's own: 3 picks owed, where skipping them would have owed 1.
    expect(owedSpells(next, next.classes[0], cls('Cleric'))?.prepared).toEqual({ target: 6, held: 3, owed: 3 });
  });

  it('reads every row at or below the class level, so a subclass chosen late catches up', () => {
    const c = hero([entry('Cleric', 5, { subclass: 'Life Domain' })], []);
    const gain = alwaysPreparedGained(c, cls('Cleric'), sub('Cleric', 'Life Domain'), 5, findSpell);
    expect(gain.add.map((s) => s.name)).toEqual(['Aid', 'Bless', 'Cure Wounds', 'Lesser Restoration', 'Mass Healing Word', 'Revivify']);
  });

  it("adds a class feature's spell: Divine Smite at Paladin 2, or turns a picked one always prepared (srd:rule:paladin-s-smite)", () => {
    // "You always have the _Divine Smite_ spell prepared."
    const fresh = hero([entry('Paladin', 2)], fill('Paladin', 2, 1));
    expect(alwaysPreparedGained(fresh, cls('Paladin'), undefined, 2, findSpell).add.map((s) => [s.name, s.source])).toEqual([['Divine Smite', "Paladin's Smite"]]);
    const picked = hero([entry('Paladin', 2)], [spell('Divine Smite', 1, 'Paladin'), ...fill('Paladin', 1, 1)]);
    expect(alwaysPreparedGained(picked, cls('Paladin'), undefined, 2, findSpell).flip.map((f) => f.name)).toEqual(['Divine Smite']);
  });

  it('reads the plural of Words of Creation (srd:rule:bard-words-of-creation)', () => {
    // "You therefore always have the _Power Word Heal_ and _Power Word Kill_  spells prepared."
    const c = hero([entry('Bard', 20)], []);
    expect(alwaysPreparedGained(c, cls('Bard'), undefined, 20, findSpell).add.map((s) => s.name)).toEqual(['Power Word Heal', 'Power Word Kill']);
  });

  it("never reads Circle of the Land's tables, whose spells change with each rest (srd:rule:druid-circle-of-the-land-spells)", () => {
    // "Whenever you finish a Long Rest, choose one type of land": the Druid's own Druidic spell is the only one.
    const c = hero([entry('Druid', 9, { subclass: 'Circle of the Land' })], []);
    expect(alwaysPreparedGained(c, cls('Druid'), sub('Druid', 'Circle of the Land'), 9, findSpell).add.map((s) => s.name)).toEqual(['Speak with Animals']);
  });

  it('leaves an always-prepared spell as it is and reports names the rules index lacks', () => {
    const c = hero([entry('Paladin', 2)], [spell('Divine Smite', 1, 'Magic Initiate (Cleric)', true, { alwaysPrepared: true })]);
    const gain = alwaysPreparedGained(c, cls('Paladin'), undefined, 2, () => undefined);
    expect(gain).toEqual({ add: [], flip: [], missing: [] });
    const missing = alwaysPreparedGained(hero([entry('Paladin', 2)], []), cls('Paladin'), undefined, 2, () => undefined);
    // With the feature granting it, so the DM adds it under that name, outside the Paladin's count.
    expect(missing.missing).toEqual([{ name: 'Divine Smite', source: "Paladin's Smite" }]);
  });
});

describe('words for the DM and the sheet', () => {
  it("says what is owed with the sheet's numbers, the spell levels and the swaps", () => {
    // The sample Wizard 3 (3 cantrips, a 6-spell book with 5 prepared) gaining Wizard 4.
    const base = sampleCharacter();
    const c: Character = { ...base, classes: base.classes.map((cl) => ({ ...cl, level: 4 })) };
    const owed = owedSpells(c, c.classes[0], cls('Wizard'));
    if (!owed) throw new Error('expected a count');
    expect(owedSpellsSummary(owed)).toBe('1 cantrip, 6 spellbook spells and 2 prepared spells');
    // The book catches up from its six (srd:rule:wizard-spellcasting): its Misty Step and Scorching Ray hold two of the
    // places of a level 2 limit (Wizard 3's or 4's), so the other two such places remain, and the rest are of level 1.
    expect(owedSpellsLine(owed)).toBe('Wizard 4 (spells of level 1–2): up to 1 cantrip (the sheet has 3 of 4), 6 spellbook spells (6 of at least 12: 2 up to level 2 and 4 of level 1) and 2 prepared spells (5 of 7).');
    // Copied spells and those a feature adds free (Evocation Savant: "add them to your spellbook for free") come on top of
    // each level's two; a book spell is prepared by name alone, so it keeps its own source.
    expect(recordingHint(owed)).toContain(
      'source "Wizard" (prepared: false for a spell only added to the spellbook; a spell copied into it, or one a feature adds to it free: source "Wizard (copied)", prepared false unless the player prepares it; to prepare a spell already in it: re-add it by name with prepared true and no source)',
    );
    const bard = hero([entry('Bard', 12)], [...fill('Bard', 4, 0), ...fill('Bard', 16, 1)]);
    const bardOwed = owedSpells(bard, bard.classes[0], cls('Bard'));
    if (!bardOwed) throw new Error('expected a count');
    expect(owedSpellsLine(bardOwed, { replaceSpell: true, replaceCantrip: true })).toBe('Bard 12 (spells of level 1–6): may replace one spell and one cantrip; nothing new to choose.');
    expect(recordingHint(bardOwed)).not.toContain('spellbook');
    // A replacement is recorded by removing the spell given up as well.
    expect(recordingHint(bardOwed, { replaceSpell: true })).toContain('and spells_remove for one they give up.');
    expect(recordingHint(bardOwed)).not.toContain('spells_remove');
  });

  it("drops exactly the engine's generic spell line", () => {
    const reminders = ['Wizard 4: choose an Ability Score Improvement or a feat.', 'Review your Wizard cantrips and prepared spells for level 4 (see the class table).'];
    expect(withoutSpellReview(reminders, 'Wizard', 4)).toEqual([reminders[0]]);
    expect(withoutSpellReview(reminders, 'Wizard', 5)).toEqual(reminders);
  });
});

describe('what a class holds, as the SRD counts it', () => {
  it("counts a spellbook's copied spells on top of each level's two (srd:rule:wizard-spellcasting)", () => {
    // "Whenever you gain a Wizard level after 1, add two Wizard spells of your choice to your spellbook", and apart from
    // those, "Copying a Spell into the Book": a Wizard 3 at its table (3 cantrips, a 10-spell book, 6 prepared) that
    // copied two spells from scrolls still adds two at Wizard 4. A copy is prepared "like the other spells in your
    // spellbook", so a prepared one counts against the Prepared Spells column.
    const copies = [spell('Invisibility', 2, 'Wizard (copied)', false), spell('Hold Person', 2, 'Wizard (copied)', true)];
    const c = hero([entry('Wizard', 4)], [...fill('Wizard', 3, 0), ...fill('Wizard', 5, 1), ...fill('Wizard', 5, 1, false, 'book'), ...copies]);
    expect(owedSpells(c, c.classes[0], cls('Wizard'))).toMatchObject({ spellbook: { target: 12, held: 10, owed: 2 }, prepared: { target: 7, held: 6, owed: 1 } });
    expect(bookSpellsOf(c, 'Wizard').map((s) => s.name)).toEqual(expect.arrayContaining(['Invisibility', 'Hold Person']));
    // "Magic Initiate (Wizard)" names a feat, not the book; nor does another class's copy.
    const other = hero([entry('Wizard', 4)], [spell('Sleep', 1, 'Magic Initiate (Wizard)'), spell('Bless', 1, 'Cleric (copied)')]);
    expect(bookSpellsOf(other, 'Wizard')).toEqual([]);
  });

  it("keeps a spellbook extra's source when it is re-added under the class's own name (srd:rule:wizard-spellcasting)", () => {
    // A copied spell is prepared "like the other spells in your spellbook", and stays apart from each level's two.
    const c = hero([entry('Wizard', 5), entry('Cleric', 1)], []);
    const classes = SRD_BUILDER_DATA.classes;
    expect(keepsBookExtra(c, 'Wizard (copied)', 'Wizard', classes)).toBe(true);
    expect(keepsBookExtra(c, 'Wizard (Evocation Savant)', 'wizard', classes)).toBe(true);
    // Another source given, or a spell that is the class's own already, takes what the call says.
    expect(keepsBookExtra(c, 'Wizard (copied)', 'Granted in play', classes)).toBe(false);
    expect(keepsBookExtra(c, 'Wizard', 'Wizard', classes)).toBe(false);
    // A class without a spellbook has no extras, nor does a feat named for a class, nor a class whose data isn't here.
    expect(keepsBookExtra(c, 'Cleric (Dusk Domain)', 'Cleric', classes)).toBe(false);
    expect(keepsBookExtra(c, 'Magic Initiate (Wizard)', 'Magic Initiate', classes)).toBe(false);
    expect(keepsBookExtra(c, 'Wizard (copied)', 'Wizard', [])).toBe(false);
  });

  it("tells the DM the number of spells a spellbook class's own levels add, read from its text (srd:rule:wizard-spellcasting)", () => {
    // "Whenever you gain a Wizard level after 1, add two Wizard spells of your choice to your spellbook": a book's class
    // with a spellbook may add another number, read from its own text as its counts are (an invented Archivist here).
    const wizard = cls('Wizard');
    const bookClass = (per: string): ClassOption => ({
      ...wizard,
      id: `lib:test:class:archivist-${per}`,
      name: 'Archivist',
      features: wizard.features.map((f) => ({ ...f, description: f.description.replaceAll('Wizard', 'Archivist').replace('add two Archivist spells', `add ${per} Archivist spell${per === 'one' ? '' : 's'}`) })),
    });
    const lineFor = (option: ClassOption) =>
      keptBookExtraLines([{ name: 'Fly', source: 'Archivist' }], hero([entry('Wizard', 5, { classId: option.id, name: 'Archivist' })], [spell('Fly', 3, 'Archivist (copied)', false)]), [option]);
    expect(lineFor(bookClass('one'))).toEqual([
      'Fly keeps its source "Archivist (copied)": a spell copied into the spellbook, or added to it free, stays outside the one spell each Archivist level adds to it. If it is that one, spells_remove it and spells_add it again with source "Archivist" and prepared false.',
    ]);
    expect(lineFor(bookClass('three'))[0]).toContain('stays outside the three spells each Archivist level adds to it. If it is one of those three, spells_remove it');
    // Without its class's data the number isn't known: the line only says the source stays.
    expect(keptBookExtraLines([{ name: 'Fly', source: 'Archivist' }], hero([entry('Wizard', 5, { classId: 'lib:test:class:gone', name: 'Archivist' })], [spell('Fly', 3, 'Archivist (copied)', false)]), [])).toEqual([
      'Fly keeps its source "Archivist (copied)": a spell copied into the spellbook, or added to it free, keeps that source.',
    ]);
  });

  it('counts only spells of a level the class has slots for (srd:rule:warlock-pact-magic, srd:rule:warlock-mystic-arcanum)', () => {
    // "The chosen spells must be of a level no higher than what's shown in the table's Slot Level column": a Warlock 11's
    // Mystic Arcanum, a level 6 spell recorded under "Warlock" ("you can cast your arcanum spell once without expending a
    // spell slot"), isn't one of its prepared spells, nor a cantrip.
    const warlock = cls('Warlock');
    const c = hero([entry('Warlock', 11)], [...fill('Warlock', 4, 0), ...fill('Warlock', 10, 1), spell('Circle of Death', 6, 'Warlock')]);
    const owed = owedSpells(c, c.classes[0], warlock);
    expect(owed).toMatchObject({ maxLevel: 5, cantrips: { held: 4 }, prepared: { target: preparedSpellCount(warlock, 11), held: 10 } });
    expect(owed?.prepared.owed).toBe(preparedSpellCount(warlock, 11) - 10);
  });

  it("offers a level's spell swap only with a spell on the list to give up (srd:rule:sorcerer-spellcasting)", () => {
    // "replace one spell on your list": a Sorcerer whose only level 1+ spell is unprepared has none on it.
    const c = hero([entry('Sorcerer', 2)], [...fill('Sorcerer', 4, 0), spell('Burning Hands', 1, 'Sorcerer', false)]);
    expect(spellPicksAfterLevel(c, c.classes[0], cls('Sorcerer')).spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:sorcerer', replaceCantrip: true }]);
  });
});

describe('always-prepared spells across classes (srd:rule:gaining-spells, "Always-Prepared Spells")', () => {
  it("leaves a spell another class keeps prepared in the Wizard's spellbook (srd:rule:wizard-spellcasting)", () => {
    // "The book contains the level 1+ spells you know": Draconic Sorcery keeps Chromatic Orb prepared now, so it stops
    // counting among the Wizard's prepared spells ("doesn't count against the number of spells on that list"), but the
    // book still holds it and its levels' two aren't owed again.
    const c = hero(
      [entry('Wizard', 3), entry('Sorcerer', 3)],
      [...fill('Wizard', 3, 0), spell('Chromatic Orb', 1, 'Wizard'), ...fill('Wizard', 5, 1), ...fill('Wizard', 4, 1, false, 'book'), ...fill('Sorcerer', 4, 0), ...fill('Sorcerer', 4, 1)],
    );
    const gain = alwaysPreparedGained(c, cls('Sorcerer'), sub('Sorcerer', 'Draconic Sorcery'), 3, findSpell, SRD_BUILDER_DATA.classes);
    expect(gain.flip).toEqual([{ id: 'id-chromatic-orb', name: 'Chromatic Orb', source: 'Draconic Sorcery', owner: 'Wizard', inBook: true, counted: true }]);
    const after = applyAlwaysPrepared(c, gain);
    expect(after.spellcasting?.spells.find((s) => s.name === 'Chromatic Orb')).toMatchObject({ source: 'Wizard', alwaysPrepared: true, prepared: true });
    expect(owedSpells(after, after.classes[0], cls('Wizard'))).toMatchObject({ spellbook: { target: 10, held: 10, owed: 0 }, prepared: { target: 6, held: 5, owed: 1 } });
    // Without the class data the owner isn't known to keep a book: the spell takes the grant's name, as before.
    expect(alwaysPreparedGained(c, cls('Sorcerer'), sub('Sorcerer', 'Draconic Sorcery'), 3, findSpell).flip).toEqual([
      { id: 'id-chromatic-orb', name: 'Chromatic Orb', source: 'Draconic Sorcery', owner: 'Wizard', counted: true },
    ]);
  });

  it('frees no place for a turned spell that was not prepared (srd:rule:gaining-spells)', () => {
    // "A spell that you always have prepared doesn't count against the number of spells on that list": an unprepared
    // book spell wasn't on the list, so turning it frees nothing there, and the book still holds it.
    const c = hero(
      [entry('Wizard', 3), entry('Sorcerer', 3)],
      [...fill('Wizard', 3, 0), spell('Chromatic Orb', 1, 'Wizard', false), ...fill('Wizard', 6, 1), ...fill('Wizard', 3, 1, false, 'book'), ...fill('Sorcerer', 4, 0), ...fill('Sorcerer', 4, 1)],
    );
    const gain = alwaysPreparedGained(c, cls('Sorcerer'), sub('Sorcerer', 'Draconic Sorcery'), 3, findSpell, SRD_BUILDER_DATA.classes);
    expect(gain.flip).toEqual([{ id: 'id-chromatic-orb', name: 'Chromatic Orb', source: 'Draconic Sorcery', owner: 'Wizard', inBook: true }]);
    const before = owedSpells(c, c.classes[0], cls('Wizard'));
    const after = applyAlwaysPrepared(c, gain);
    expect(owedSpells(after, after.classes[0], cls('Wizard'))).toEqual(before);
  });

  it("frees no place for a turned spell above its class's spell level (srd:rule:multiclassing-class-features-spellcasting)", () => {
    // "You determine what spells you can prepare for each class individually, as if you were a single-classed member of
    // that class": a Cleric 3 prepares no level 3 spell, so Fear recorded under "Cleric" was on no list, and Draconic
    // Sorcery's Sorcerer 5 row (Fear, Fly) turning it frees no Cleric place.
    const c = hero([entry('Cleric', 3), entry('Sorcerer', 4)], [...fill('Cleric', 3, 0), spell('Fear', 3, 'Cleric'), ...fill('Cleric', 5, 1), ...fill('Sorcerer', 5, 0), ...fill('Sorcerer', 5, 1)]);
    const draconic = sub('Sorcerer', 'Draconic Sorcery');
    const gain = alwaysPreparedGained(c, cls('Sorcerer'), draconic, 5, findSpell, SRD_BUILDER_DATA.classes);
    expect(gain.flip).toEqual([{ id: 'id-fear', name: 'Fear', source: 'Draconic Sorcery', owner: 'Cleric' }]);
    const before = owedSpells(c, c.classes[0], cls('Cleric'));
    expect(owedSpells(applyAlwaysPrepared(c, gain), c.classes[0], cls('Cleric'))).toEqual(before);
    // A Cleric 5 has level 3 spells on its list: there Fear counted, and its place is free.
    const five = { ...c, classes: [entry('Cleric', 5), entry('Sorcerer', 4)] };
    expect(alwaysPreparedGained(five, cls('Sorcerer'), draconic, 5, findSpell, SRD_BUILDER_DATA.classes).flip).toEqual([
      { id: 'id-fear', name: 'Fear', source: 'Draconic Sorcery', owner: 'Cleric', counted: true },
    ]);
    // The levelled class is counted at its new level, whether the hero is read before the level-up (the dialog) or after
    // it (the DM's level_up): a Sorcerer 5 has level 3 spells on its list.
    const own = hero([entry('Sorcerer', 4)], [...fill('Sorcerer', 5, 0), spell('Fly', 3, 'Sorcerer'), ...fill('Sorcerer', 4, 1)]);
    const flyFlip = { id: 'id-fly', name: 'Fly', source: 'Draconic Sorcery', owner: 'Sorcerer', counted: true };
    expect(alwaysPreparedGained(own, cls('Sorcerer'), draconic, 5, findSpell, SRD_BUILDER_DATA.classes).flip).toEqual([flyFlip]);
    const levelled = { ...own, classes: [entry('Sorcerer', 5)] };
    expect(alwaysPreparedGained(levelled, cls('Sorcerer'), draconic, 5, findSpell, SRD_BUILDER_DATA.classes).flip).toEqual([flyFlip]);
  });

  it('marks the other class open for the place its turned spell left', () => {
    // Cleric 5 / Paladin 2 → Paladin 3, Oath of Devotion: Shield of Faith, a Cleric pick, is now always prepared, so the
    // Cleric's list has room for another (srd:rule:cleric-spellcasting: "choose additional Cleric spells until the number
    // of spells on your list matches the number in the Cleric Features table"). It gained no level: no swaps.
    const c = hero(
      [entry('Cleric', 5), entry('Paladin', 3)],
      [...fill('Cleric', 4, 0), spell('Shield of Faith', 1, 'Cleric'), ...fill('Cleric', 8, 1), spell('Divine Smite', 1, "Paladin's Smite", true, { alwaysPrepared: true }), ...fill('Paladin', 3, 1)],
    );
    const r = levelSpellsEdit(c, c.classes[1], cls('Paladin'), sub('Paladin', 'Oath of Devotion'), findSpell, SRD_BUILDER_DATA.classes);
    expect(r.gain.flip).toEqual([{ id: 'id-shield-of-faith', name: 'Shield of Faith', source: 'Oath of Devotion', owner: 'Cleric', counted: true }]);
    expect(r.others).toEqual([{ cl: c.classes[0], owed: expect.objectContaining({ prepared: { target: preparedSpellCount(cls('Cleric'), 5), held: 8, owed: preparedSpellCount(cls('Cleric'), 5) - 8 } }), entry: { classId: 'srd:class:cleric' } }]);
    expect(r.character.spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:paladin' }, { classId: 'srd:class:cleric' }]);
    expect(r.entry).toEqual({ classId: 'srd:class:paladin' });
    // A class already open keeps its entry (and its swaps) as it is.
    const open = { ...c, spellcasting: { ...c.spellcasting!, spellPicks: [{ classId: 'srd:class:cleric', replaceCantrip: true }] } };
    const again = levelSpellsEdit(open, open.classes[1], cls('Paladin'), sub('Paladin', 'Oath of Devotion'), findSpell, SRD_BUILDER_DATA.classes);
    expect(again.character.spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:cleric', replaceCantrip: true }, { classId: 'srd:class:paladin' }]);
  });
});

describe("spellbook spells chosen late keep each level's limit (srd:rule:wizard-spellcasting)", () => {
  it('owes the newest places, each no higher than the level it belongs to allowed', () => {
    // "Each of these spells must be of a level for which you have spell slots": a Wizard 3 at its table (a 10-spell book)
    // taken to Wizard 5 before choosing owes Wizard 4's two (level 1–2 then) and Wizard 5's two (level 1–3).
    const c = hero([entry('Wizard', 5)], [...fill('Wizard', 3, 0), ...fill('Wizard', 6, 1), ...fill('Wizard', 4, 1, false, 'book')]);
    const caps = owedSpells(c, c.classes[0], cls('Wizard'))?.bookCaps ?? [];
    expect(caps).toEqual([3, 3, 2, 2]);
    expect(fitsBookCaps([3, 2, 3, 1], caps)).toBe(true);
    expect(fitsBookCaps([3, 3, 3], caps)).toBe(false);
    expect(fitsBookCaps([1, 1, 1, 1, 1], caps)).toBe(false);
    expect(bookCapBlock(3, [3, 3], caps)).toBe('Only 2 may be of level 3 here; the others are for earlier levels.');
    expect(bookCapBlock(2, [3, 3], caps)).toBeNull();
    expect(bookCapBlock(1, [3, 3, 2, 2], caps)).toBeNull();
    expect(bookCapBlock(2, [2, 2], [3, 2, 1, 1])).toBe('Only 2 may be of level 2 or higher here; the others are for earlier levels.');
    expect(bookCapsText(caps, 3)).toBe('2 up to level 3 and 2 up to level 2');
    // Part made: two of level 3 took Wizard 5's places, so Wizard 4's are left, of level 1–2; a level 2 pick would have
    // left one of each. Those two share a limit below the class's level 3 spells: the DM's line and the dialog's notice
    // say it, so a spell the player names to the DM keeps it too.
    const part = hero([entry('Wizard', 5)], [...fill('Wizard', 3, 0), ...fill('Wizard', 6, 1), ...fill('Wizard', 4, 1, false, 'book'), spell('Fireball', 3, 'Wizard', false), spell('Fly', 3, 'Wizard', false)]);
    const partOwed = owedSpells(part, part.classes[0], cls('Wizard'))!;
    expect(partOwed.bookCaps).toEqual([2, 2]);
    expect(bookCapsText(partOwed.bookCaps, partOwed.maxLevel)).toBe('2 up to level 2');
    expect(owedSpellsLine(partOwed)).toContain('2 spellbook spells (12 of at least 14: 2 up to level 2)');
    expect(owedSpellsSummary(partOwed, true)).toBe('1 cantrip, 2 spellbook spells (2 up to level 2) and 3 prepared spells');
    expect(owedSpellsSummary(partOwed)).toBe('1 cantrip, 2 spellbook spells and 3 prepared spells');
    expect(bookCapsText([1, 1], 2)).toBe('2 of level 1');
    const web = hero([entry('Wizard', 5)], [...fill('Wizard', 3, 0), ...fill('Wizard', 6, 1), ...fill('Wizard', 4, 1, false, 'book'), spell('Web', 2, 'Wizard', false)]);
    expect(owedSpells(web, web.classes[0], cls('Wizard'))?.bookCaps).toEqual([3, 3, 2]);
    // Chosen at each level: one limit, nothing more to say.
    const onTime = hero([entry('Wizard', 5)], [...fill('Wizard', 3, 0), ...fill('Wizard', 6, 1), ...fill('Wizard', 6, 1, false, 'book')]);
    expect(owedSpells(onTime, onTime.classes[0], cls('Wizard'))?.bookCaps).toEqual([3, 3]);
    expect(bookCapsText([3, 3], 3)).toBe('');
    expect(bookCapsText([], 3)).toBe('');
    // An older Wizard 7 with its starting six: each level's two, back to Wizard 2's of level 1.
    const older = hero([entry('Wizard', 7)], fill('Wizard', 6, 1, false, 'book'));
    expect(owedSpells(older, older.classes[0], cls('Wizard'))?.bookCaps).toEqual([4, 4, 3, 3, 3, 3, 2, 2, 2, 2, 1, 1]);
    expect(bookCapsText([4, 4, 3, 3, 3, 3, 2, 2, 2, 2, 1, 1], 4)).toBe('2 up to level 4, 4 up to level 3, 4 up to level 2 and 2 of level 1');
  });
});

describe('spells the DM records settle the open choices (update_character, as the level_up result says)', () => {
  const picks = (c: Character, list: { classId: string; replaceSpell?: boolean; replaceCantrip?: boolean }[]): Character => ({ ...c, spellcasting: { ...c.spellcasting!, spellPicks: list } });
  const withSpells = (c: Character, spells: KnownSpell[]): Character => ({ ...c, spellcasting: { ...c.spellcasting!, spells } });

  it("closes a class once nothing is owed: the level's swaps were made through the DM (srd:rule:sorcerer-spellcasting)", () => {
    // Sorcerer 6 owes its new spell, swaps open; the DM records the new spell and "replace one spell on your list".
    const base = hero([entry('Sorcerer', 6)], [...fill('Sorcerer', 5, 0), spell('Burning Hands', 1, 'Sorcerer'), ...fill('Sorcerer', 8, 1)]);
    const open = picks(base, [{ classId: 'srd:class:sorcerer', replaceSpell: true, replaceCantrip: true }]);
    const after = withSpells(open, [...open.spellcasting!.spells.filter((s) => s.name !== 'Burning Hands'), spell('Haste', 3, 'Sorcerer'), spell('Lightning Bolt', 3, 'Sorcerer')]);
    const r = settleSpellPicks(open, after, SRD_BUILDER_DATA.classes);
    expect(r.character.spellcasting).not.toHaveProperty('spellPicks');
    expect(r.settled).toEqual([{ className: 'Sorcerer', level: 6, owed: null }]);
    // Only the new spell, no swap named: the level's choices are made, and its swaps lapse with them, as on the sheet.
    const plain = withSpells(open, [...open.spellcasting!.spells, spell('Haste', 3, 'Sorcerer')]);
    expect(settleSpellPicks(open, plain, SRD_BUILDER_DATA.classes).character.spellcasting).not.toHaveProperty('spellPicks');
  });

  it('keeps what is still owed open without the swaps, and leaves a class whose spells it didn\'t touch alone', () => {
    const base = hero([entry('Bard', 6), entry('Cleric', 5)], [...fill('Bard', 3, 0), ...fill('Bard', 7, 1), ...fill('Cleric', 4, 0), ...fill('Cleric', 9, 1)]);
    const open = picks(base, [{ classId: 'srd:class:bard', replaceSpell: true, replaceCantrip: true }, { classId: 'srd:class:cleric', replaceCantrip: true }]);
    // One Bard spell of the two the table gained (srd:rule:bard-spellcasting); a spell of no class's, granted in play.
    const after = withSpells(open, [...open.spellcasting!.spells, spell('Hypnotic Pattern', 3, 'Bard'), spell('Fly', 3, 'Granted in play')]);
    const r = settleSpellPicks(open, after, SRD_BUILDER_DATA.classes);
    expect(r.character.spellcasting?.spellPicks).toEqual([{ classId: 'srd:class:bard' }, { classId: 'srd:class:cleric', replaceCantrip: true }]);
    expect(r.settled).toEqual([{ className: 'Bard', level: 6, owed: expect.objectContaining({ prepared: expect.objectContaining({ owed: preparedSpellCount(cls('Bard'), 6) - 8 }) }) }]);
    // Nothing of the class's changed: as it was.
    expect(settleSpellPicks(open, withSpells(open, [...open.spellcasting!.spells, spell('Fly', 3, 'Granted in play')]), SRD_BUILDER_DATA.classes).character.spellcasting?.spellPicks).toEqual(open.spellcasting?.spellPicks);
  });

  it("settles a spellbook's choices when the DM records its book spells, so a later loss doesn't reopen them", () => {
    // Wizard 4 at its table but for the level's two book spells (srd:rule:wizard-spellcasting): the DM records them.
    const base = hero([entry('Wizard', 4)], [...fill('Wizard', 4, 0), ...fill('Wizard', 7, 1), ...fill('Wizard', 3, 1, false, 'book')]);
    const open = picks(base, [{ classId: 'srd:class:wizard' }]);
    const after = withSpells(open, [...open.spellcasting!.spells, spell('Web', 2, 'Wizard', false), spell('Shatter', 2, 'Wizard', false)]);
    const settled = settleSpellPicks(open, after, SRD_BUILDER_DATA.classes).character;
    expect(settled.spellcasting).not.toHaveProperty('spellPicks');
    expect(openSpellPicks(withSpells(settled, settled.spellcasting!.spells.slice(2)), SRD_BUILDER_DATA.classes)).toEqual([]);
  });
});

describe("a lineage's spells at character levels 3 and 5 (srd:species:elf, srd:species:tiefling)", () => {
  // srd:species:elf, Elven Lineage (srd:species:tiefling, Fiendish Legacy, alike): "When you reach character levels 3 and 5,
  // you learn a higher-level spell, as shown on the table. You always have that spell prepared. You can cast it once without
  // a spell slot, and you regain the ability to cast it in that way when you finish a Long Rest. You can also cast the spell
  // using any spell slots you have of the appropriate level." and "Intelligence, Wisdom, or Charisma is your spellcasting
  // ability for the spells you cast with this trait (choose the ability when you select the lineage)."
  const classes = SRD_BUILDER_DATA.classes;
  const NOTE = 'Spellcasting ability: Wisdom. Once per Long Rest without a spell slot';
  const TRAIT = { Elf: 'Elven Lineage', Tiefling: 'Fiendish Legacy' } as const;
  const LINEAGES = {
    Drow: { species: 'Elf', cantrip: 'Dancing Lights', spells: ['Faerie Fire', 'Darkness'] },
    'High Elf': { species: 'Elf', cantrip: 'Prestidigitation', spells: ['Detect Magic', 'Misty Step'] },
    'Wood Elf': { species: 'Elf', cantrip: 'Druidcraft', spells: ['Longstrider', 'Pass without Trace'] },
    Abyssal: { species: 'Tiefling', cantrip: 'Poison Spray', spells: ['Ray of Sickness', 'Hold Person'] },
    Chthonic: { species: 'Tiefling', cantrip: 'Chill Touch', spells: ['False Life', 'Ray of Enfeeblement'] },
    Infernal: { species: 'Tiefling', cantrip: 'Fire Bolt', spells: ['Hellish Rebuke', 'Darkness'] },
  } as const;
  type Lineage = keyof typeof LINEAGES;
  /**
   * A hero of this lineage as the builder makes one: the lineage trait's feature named for it ("Elven Lineage (Drow)") and
   * the lineage's cantrip under its name, noted with the ability chosen with the lineage (null: no note, an older sheet).
   */
  const lineageHero = (lineage: Lineage, classLevels: ClassLevel[], spells: KnownSpell[] = [], features: Feature[] = [], ability: string | null = 'Wisdom'): Character => {
    const { species, cantrip } = LINEAGES[lineage];
    const trait: Feature = { id: 'f-lineage', name: `${TRAIT[species]} (${lineage})`, source: 'species', sourceName: species, description: `The ${lineage} benefits.` };
    return {
      ...hero(classLevels, [spell(cantrip, 0, lineage, true, ability ? { notes: `Spellcasting ability: ${ability}` } : {}), ...spells], [trait, ...features]),
      species: `${species} (${lineage} ${species === 'Elf' ? 'lineage' : 'legacy'})`,
      speciesId: `srd:species:${species.toLowerCase()}`,
    };
  };
  const classOptionOf = (cl: ClassLevel, data: BuilderData) => data.classes.find((o) => o.id === cl.classId) ?? cls(cl.name);
  /** The level-up's own spell edit with the lineage's grants, then the free castings, as the dialog and the DM's level_up run them. */
  const levelWithLineage = (c: Character, cl: ClassLevel, data: BuilderData = SRD_BUILDER_DATA) => {
    const grants = lineageSpellGrants(c, data, findSpell);
    const edit = levelSpellsEdit(c, cl, classOptionOf(cl, data), undefined, findSpell, data.classes, grants);
    return { grants, edit, cast: withLineageCastings(edit.character, data, grants) };
  };
  const names = (c: Character, data: BuilderData = SRD_BUILDER_DATA) => lineageSpellGrants(c, data, findSpell).map((g) => g.name);
  const sheetSpell = (c: Character, name: string) => c.spellcasting?.spells.find((s) => s.name === name);
  const counters = (c: Character) => c.features.filter((f) => f.name.endsWith('(free casting)'));

  it("grants none at character level 2, the Level 3 spell at 3 and 4, and both at 5: the table's column, not the spell's own level", () => {
    for (const [lineage, { spells }] of Object.entries(LINEAGES) as [Lineage, (typeof LINEAGES)[Lineage]][]) {
      const at = (level: number) => names(lineageHero(lineage, [entry('Fighter', level)]));
      expect(at(2), lineage).toEqual([]);
      expect(at(3), lineage).toEqual([spells[0]]);
      expect(at(4), lineage).toEqual([spells[0]]);
      expect(at(5), lineage).toEqual([...spells]);
    }
    // Named from the rules index, sourced to the lineage, noted with its ability and its free casting.
    expect(lineageSpellGrants(lineageHero('Infernal', [entry('Warlock', 3)], [], [], 'Charisma'), SRD_BUILDER_DATA, findSpell)).toEqual([
      { name: 'Hellish Rebuke', source: 'Infernal', notes: 'Spellcasting ability: Charisma. Once per Long Rest without a spell slot' },
    ]);
    // The dialog previews the hero before the level-up at the next character level.
    expect(lineageSpellGrants(lineageHero('Drow', [entry('Fighter', 2)]), SRD_BUILDER_DATA, findSpell, 3).map((g) => g.name)).toEqual(['Faerie Fire']);
  });

  it('counts the character level across classes: a Fighter level that makes a Bard 2 character level 3 (srd:rule:multiclassing-experience-points)', () => {
    // "your total character level, not your level in a particular class": the Fighter level reaches character level 3, so
    // Faerie Fire, a Bard pick until now, is always prepared and no longer counts among the Bard's prepared spells
    // (srd:rule:gaining-spells: "a spell that you always have prepared doesn't count against the number of spells on that
    // list"); the Bard, which gained no level, has that place to fill again (no swaps).
    const picks = [...fill('Bard', 2, 0), spell('Faerie Fire', 1, 'Bard'), ...fill('Bard', preparedSpellCount(cls('Bard'), 2) - 1, 1)];
    expect(names(lineageHero('Drow', [entry('Bard', 2)], picks))).toEqual([]);
    const c = lineageHero('Drow', [entry('Bard', 2), entry('Fighter', 1)], picks);
    const { edit, cast } = levelWithLineage(c, c.classes[1]);
    expect(edit.gain).toEqual({ add: [], flip: [{ id: 'id-faerie-fire', name: 'Faerie Fire', source: 'Drow', owner: 'Bard', counted: true, notes: NOTE }], missing: [] });
    const target = preparedSpellCount(cls('Bard'), 2);
    expect(edit.others).toEqual([{ cl: c.classes[0], owed: expect.objectContaining({ prepared: { target, held: target - 1, owed: 1 } }), entry: { classId: 'srd:class:bard' } }]);
    expect(edit.owed).toBeNull();
    expect(sheetSpell(edit.character, 'Faerie Fire')).toMatchObject({ source: 'Drow', alwaysPrepared: true, prepared: true, notes: NOTE });
    expect(cast.added).toEqual(['Faerie Fire']);
  });

  it('adds the Level 3 spell always prepared, with its free casting as a counter that a Long Rest resets', () => {
    const c = lineageHero('Drow', [entry('Fighter', 3)]);
    const { edit, cast } = levelWithLineage(c, c.classes[0]);
    expect(edit.gain).toEqual({
      add: [{ id: 'srd:spell:faerie-fire', name: 'Faerie Fire', level: 1, prepared: true, concentration: true, alwaysPrepared: true, source: 'Drow', notes: NOTE }],
      flip: [],
      missing: [],
    });
    expect(counters(cast.character)).toEqual([
      {
        id: expect.any(String),
        name: 'Faerie Fire (free casting)',
        source: 'species',
        sourceName: 'Drow',
        description: 'Faerie Fire once without a spell slot, using Wisdom; regained on a Long Rest (Elven Lineage: Drow). A spell slot of its level or higher also casts it.',
        uses: { max: 1, used: 0, recharge: 'long' },
      },
    ]);
    expect(cast).toMatchObject({ lineage: 'Drow', added: ['Faerie Fire'], withheldBy: null });
    expect(freeCastingLines(cast)).toEqual(['Free casting now, once per Long Rest without a spell slot: Faerie Fire (Drow); spend it with update_character features_use "Faerie Fire (free casting)".']);
    expect(freeCastingNoticeParts(cast)).toEqual(['free casting once per Long Rest: Faerie Fire (Drow)']);
    // The DM spends it with features_use, by the counter's name or the spell's; "you regain the ability to cast it in that
    // way when you finish a Long Rest".
    const spent = useFeature(cast.character, 'Faerie Fire (free casting)');
    expect(spent.events.map((e) => e.message)).toEqual(['Used Faerie Fire (free casting) (0/1 left; recharges on a Long Rest)']);
    expect(useFeature(cast.character, 'Faerie Fire').events.map((e) => e.message)).toEqual(['Used Faerie Fire (free casting) (0/1 left; recharges on a Long Rest)']);
    expect(counters(applyLongRest(spent.character).character)[0].uses).toEqual({ max: 1, used: 0, recharge: 'long' });
  });

  it('adds only the Level 5 spell to a hero who has the Level 3 one, and both to one who has neither (catch-up); again, nothing', () => {
    const faerie = spell('Faerie Fire', 1, 'Drow', true, { alwaysPrepared: true, notes: NOTE });
    const counter: Feature = { id: 'f-ff', name: 'Faerie Fire (free casting)', source: 'species', sourceName: 'Drow', description: '', uses: { max: 1, used: 1, recharge: 'long' } };
    const at5 = lineageHero('Drow', [entry('Fighter', 5)], [faerie], [counter]);
    const five = levelWithLineage(at5, at5.classes[0]);
    expect(five.edit.gain.add.map((s) => [s.name, s.source])).toEqual([['Darkness', 'Drow']]);
    expect(five.edit.gain.flip).toEqual([]);
    expect(five.cast.added).toEqual(['Darkness']);
    expect(counters(five.cast.character).map((f) => [f.name, f.uses?.used])).toEqual([
      ['Faerie Fire (free casting)', 1],
      ['Darkness (free casting)', 0],
    ]);
    expect(freeCastingLines(five.cast)).toEqual(['Free casting now, once per Long Rest without a spell slot: Darkness (Drow); spend it with update_character features_use "Darkness (free casting)".']);
    // An older save past character level 5 with neither: its next level-up, in any class, catches both up.
    const older = lineageHero('Drow', [entry('Fighter', 7)]);
    const caught = levelWithLineage(older, older.classes[0]);
    expect(caught.edit.gain.add.map((s) => s.name)).toEqual(['Faerie Fire', 'Darkness']);
    expect(caught.cast.added).toEqual(['Faerie Fire', 'Darkness']);
    expect(freeCastingLines(caught.cast)).toEqual([
      'Free castings now, each once per Long Rest without a spell slot: Faerie Fire, Darkness (Drow); spend one with update_character features_use and "<Spell> (free casting)".',
    ]);
    expect(freeCastingNoticeParts(caught.cast)).toEqual(['free casting once per Long Rest: Faerie Fire, Darkness (Drow)']);
    // The next level-up finds both kept and counted: nothing changes, nothing is said.
    const next: Character = { ...caught.cast.character, classes: [entry('Fighter', 8)] };
    const again = levelWithLineage(next, next.classes[0]);
    expect(again.edit.gain).toEqual({ add: [], flip: [], missing: [] });
    expect(again.cast.added).toEqual([]);
    expect(again.cast.character).toBe(again.edit.character);
    expect(freeCastingLines(again.cast)).toEqual([]);
  });

  it("turns the levelled class's own pick always prepared, counted after it (srd:rule:gaining-spells)", () => {
    // A Drow Bard 2 → 3 whose Faerie Fire is a Bard pick: it no longer counts among the Bard's prepared spells, so the Bard
    // 3 owes one more ("doesn't count against the number of spells on that list").
    const target = preparedSpellCount(cls('Bard'), 3);
    const picks = [...fill('Bard', 2, 0), spell('Faerie Fire', 1, 'Bard'), ...fill('Bard', preparedSpellCount(cls('Bard'), 2) - 1, 1)];
    const c = lineageHero('Drow', [entry('Bard', 3)], picks);
    const today = levelSpellsEdit(c, c.classes[0], cls('Bard'), undefined, findSpell, classes);
    expect(today.owed?.prepared).toEqual({ target, held: target - 1, owed: 1 });
    const { edit, cast } = levelWithLineage(c, c.classes[0]);
    expect(edit.gain.flip).toEqual([{ id: 'id-faerie-fire', name: 'Faerie Fire', source: 'Drow', owner: 'Bard', counted: true, notes: NOTE }]);
    expect(edit.owed?.prepared).toEqual({ target, held: target - 2, owed: 2 });
    expect(edit.others).toEqual([]);
    expect(sheetSpell(edit.character, 'Faerie Fire')).toEqual({ id: 'id-faerie-fire', name: 'Faerie Fire', level: 1, prepared: true, source: 'Drow', alwaysPrepared: true, notes: NOTE });
    expect(cast.added).toEqual(['Faerie Fire']);
    // A turned spell with notes of its own keeps them.
    const noted = lineageHero('Drow', [entry('Bard', 3)], [spell('Faerie Fire', 1, 'Bard', true, { notes: 'Learned from a moth-priest' })]);
    const kept = levelWithLineage(noted, noted.classes[0]);
    expect(kept.edit.gain.flip).toEqual([{ id: 'id-faerie-fire', name: 'Faerie Fire', source: 'Drow', owner: 'Bard', counted: true }]);
    expect(sheetSpell(kept.edit.character, 'Faerie Fire')).toMatchObject({ source: 'Drow', alwaysPrepared: true, notes: 'Learned from a moth-priest' });
  });

  it("keeps a Wizard's spellbook copy in the book, prepared spells counted after it (srd:rule:wizard-spellcasting)", () => {
    // A High Elf Wizard 2 → 3 whose starting book holds Detect Magic, prepared: "The book contains the level 1+ spells you
    // know", so it stays there (source "Wizard"), always prepared now, and no longer counted among the prepared spells.
    const book = [...fill('Wizard', 3, 0), spell('Detect Magic', 1, 'Wizard', true, { ritual: true, concentration: true }), ...fill('Wizard', 3, 1), ...fill('Wizard', 2, 1, false, 'book')];
    const c = lineageHero('High Elf', [entry('Wizard', 3)], book, [], 'Intelligence');
    const today = levelSpellsEdit(c, c.classes[0], cls('Wizard'), undefined, findSpell, classes);
    expect(today.owed).toMatchObject({ prepared: { target: 6, held: 4, owed: 2 }, spellbook: { target: 10, held: 6, owed: 4 } });
    const { edit, cast } = levelWithLineage(c, c.classes[0]);
    const note = 'Spellcasting ability: Intelligence. Once per Long Rest without a spell slot';
    expect(edit.gain.flip).toEqual([{ id: 'id-detect-magic', name: 'Detect Magic', source: 'High Elf', owner: 'Wizard', inBook: true, counted: true, notes: note }]);
    expect(edit.owed).toMatchObject({ prepared: { target: 6, held: 3, owed: 3 }, spellbook: { target: 10, held: 6, owed: 4 } });
    expect(edit.others).toEqual([]);
    expect(sheetSpell(edit.character, 'Detect Magic')).toMatchObject({ source: 'Wizard', alwaysPrepared: true, prepared: true, ritual: true, notes: note });
    expect(counters(cast.character).map((f) => f.description)).toEqual([
      'Detect Magic once without a spell slot, using Intelligence; regained on a Long Rest (Elven Lineage: High Elf). A spell slot of its level or higher also casts it.',
    ]);
  });

  it("leaves a Magic Initiate copy as it is, beside which the lineage's own free casting is counted (srd:feat:magic-initiate)", () => {
    // Magic Initiate: "You always have that spell prepared. You can cast it once without a spell slot, and you regain the
    // ability to cast it in that way when you finish a Long Rest." The lineage grants its own, so the hero has both.
    const initiate = spell('Detect Magic', 1, 'Magic Initiate (Wizard)', true, { alwaysPrepared: true, notes: 'Spellcasting ability: Intelligence. Once per Long Rest without a spell slot' });
    const feat: Feature = { id: 'f-mi', name: 'Magic Initiate (Wizard)', source: 'feat', sourceName: 'Sage (Origin feat)', description: '', uses: { max: 1, used: 0, recharge: 'long' } };
    const c = lineageHero('High Elf', [entry('Fighter', 3)], [initiate], [feat]);
    const { edit, cast } = levelWithLineage(c, c.classes[0]);
    expect(edit.gain).toEqual({ add: [], flip: [], missing: [] });
    expect(sheetSpell(edit.character, 'Detect Magic')).toEqual(initiate);
    expect(cast.added).toEqual(['Detect Magic']);
    expect(cast.character.features.filter((f) => f.uses).map((f) => [f.name, f.uses?.max])).toEqual([
      ['Magic Initiate (Wizard)', 1],
      ['Detect Magic (free casting)', 1],
    ]);
    // The lineage's casting uses the lineage's ability (Wisdom here), not the feat's.
    expect(counters(cast.character)[0].description).toContain('using Wisdom;');
  });

  it("adds no counter beside the DM's own record of a free casting, and none while the trait's uses count them (the DM's ruling)", () => {
    // The DM recorded Faerie Fire's free casting by hand: Darkness, at character level 5, gets the app's counter only.
    const dmCounter: Feature = { id: 'f-dm', name: 'Faerie Fire (Drow, free casting)', source: 'species', sourceName: 'Granted in play', description: '', uses: { max: 1, used: 0, recharge: 'long' } };
    const byHand = lineageHero('Drow', [entry('Bard', 5)], [spell('Faerie Fire', 1, 'Elven Lineage (Drow)')], [dmCounter]);
    const dm = levelWithLineage(byHand, byHand.classes[0]);
    expect(dm.edit.gain.add.map((s) => s.name)).toEqual(['Darkness']);
    expect(dm.cast.added).toEqual(['Darkness']);
    // A feature already of the counter's name, even without uses, is never doubled.
    const named = lineageHero('Drow', [entry('Fighter', 3)], [], [{ id: 'f-named', name: 'Faerie Fire (free casting)', source: 'other', sourceName: 'Granted in play', description: '' }]);
    expect(levelWithLineage(named, named.classes[0]).cast.added).toEqual([]);
    // Only a spell the sheet keeps always prepared gets one: before the gain (a level-up whose class data is missing, so
    // its spell edit didn't run), an ordinary Bard pick waits for the next level-up.
    const unturned = lineageHero('Drow', [entry('Bard', 3)], [spell('Faerie Fire', 1, 'Bard')]);
    const pending = withLineageCastings(unturned, SRD_BUILDER_DATA, lineageSpellGrants(unturned, SRD_BUILDER_DATA, findSpell));
    expect(pending).toEqual({ character: unturned, lineage: 'Drow', added: [], withheldBy: null });
    // The DM gave the lineage trait its own uses: the spells are still always prepared, but no counter is added, and the
    // DM hears why.
    const ruledTrait = (uses: Feature['uses']): Feature => ({ id: 'f-lineage', name: 'Elven Lineage (Drow)', source: 'species', sourceName: 'Elf', description: '', uses });
    const ruled: Character = { ...lineageHero('Drow', [entry('Fighter', 5)]), features: [ruledTrait({ max: 2, used: 1, recharge: 'long', ruled: true })] };
    const r = levelWithLineage(ruled, ruled.classes[0]);
    expect(r.edit.gain.add.map((s) => s.name)).toEqual(['Faerie Fire', 'Darkness']);
    expect(r.cast).toEqual({ character: r.edit.character, lineage: 'Drow', added: [], withheldBy: ruled.features[0] });
    expect(r.cast.character).toBe(r.edit.character);
    expect(freeCastingLines(r.cast)).toEqual(['Elven Lineage (Drow) already counts its free castings (your ruling: 2 uses): no free-casting counters added.']);
    expect(freeCastingNoticeParts(r.cast)).toEqual(['Elven Lineage (Drow) already counts its free castings (your ruling: 2 uses): no free-casting counters added']);
    expect(freeCastingRuling(ruledTrait({ max: 1, used: 0, recharge: 'long', ruled: true }))).toBe('Elven Lineage (Drow) already counts its free castings (your ruling: 1 use): no free-casting counters added');
    expect(freeCastingRuling(ruledTrait({ max: 2, used: 0, recharge: 'long' }))).toBe('Elven Lineage (Drow) already counts its free castings (2 uses): no free-casting counters added');
    // With nothing left to count (each spell has the DM's counter), nothing is said.
    const both: Feature[] = ['Faerie Fire', 'Darkness'].map((s) => ({ ...dmCounter, id: `f-${nameKey(s)}`, name: `${s} (Drow, free casting)` }));
    const settled: Character = { ...ruled, features: [...ruled.features, ...both] };
    expect(levelWithLineage(settled, settled.classes[0]).cast).toMatchObject({ added: [], withheldBy: null });
  });

  it("notes the ability the lineage's own cantrip names, and only the free casting without one", () => {
    const unnoted = lineageHero('Drow', [entry('Fighter', 3)], [spell('Light', 0, 'Magic Initiate (Wizard)', true, { notes: 'Spellcasting ability: Intelligence' })], [], null);
    const { grants, cast } = levelWithLineage(unnoted, unnoted.classes[0]);
    // Another feature's note (Magic Initiate's Intelligence) isn't the lineage's.
    expect(grants).toEqual([{ name: 'Faerie Fire', source: 'Drow', notes: 'Once per Long Rest without a spell slot' }]);
    expect(sheetSpell(cast.character, 'Faerie Fire')?.notes).toBe('Once per Long Rest without a spell slot');
    expect(counters(cast.character)[0].description).toBe('Faerie Fire once without a spell slot; regained on a Long Rest (Elven Lineage: Drow). A spell slot of its level or higher also casts it.');
  });

  describe("a book's lineage (the invented Gloamwood fixture)", () => {
    const mothkin = EXPECTED_MERGED.species.find((s) => s.name === 'Mothkin') as SpeciesOption;
    /** A Mothkin as the builder makes one from the book: the trait as printed and the lineage as its own feature, each with its ref. */
    const moth = (lineage: 'Ashwing' | 'Silverwing', level: number, species: SpeciesOption = mothkin): Character => {
      const option = (species.lineages ?? []).find((l) => l.name === lineage)!;
      const trait = species.traits.find((t) => t.name === 'Lamp-Drawn')!;
      return {
        ...hero(
          [entry('Fighter', level)],
          [spell(lineage === 'Ashwing' ? 'Light' : 'Dancing Lights', 0, lineage, true, { notes: 'Spellcasting ability: Charisma' })],
          [
            { id: 'f-lamp', name: `Lamp-Drawn (${lineage})`, source: 'species', sourceName: species.name, description: TEXT.lampDrawn.join('\n\n'), ...(trait.ref ? { ref: trait.ref } : {}) },
            { id: 'f-wing', name: lineage, source: 'species', sourceName: species.name, description: option.description, ...(option.ref ? { ref: option.ref } : {}) },
          ],
        ),
        species: `${species.name} (${lineage} lineage)`,
        speciesId: species.id,
      };
    };

    it('grants its table-row spells at 3 and 5, under the lineage, with a counter named for its trait', () => {
      expect(names(moth('Silverwing', 2), EXPECTED_MERGED)).toEqual([]);
      expect(names(moth('Silverwing', 3), EXPECTED_MERGED)).toEqual(['Faerie Fire']);
      expect(names(moth('Silverwing', 5), EXPECTED_MERGED)).toEqual(['Faerie Fire', 'Moonbeam']);
      expect(names(moth('Ashwing', 5), EXPECTED_MERGED)).toEqual(['Burning Hands', 'Continual Flame']);
      const c = moth('Silverwing', 3);
      const { edit, cast } = levelWithLineage(c, c.classes[0], EXPECTED_MERGED);
      expect(edit.gain.add.map((s) => [s.name, s.source, s.notes])).toEqual([['Faerie Fire', 'Silverwing', 'Spellcasting ability: Charisma. Once per Long Rest without a spell slot']]);
      expect(counters(cast.character).map((f) => [f.name, f.sourceName, f.description])).toEqual([
        ['Faerie Fire (free casting)', 'Silverwing', 'Faerie Fire once without a spell slot, using Charisma; regained on a Long Rest (Lamp-Drawn: Silverwing). A spell slot of its level or higher also casts it.'],
      ]);
      // The counter is the app's words: no ref, no book text.
      expect(counters(cast.character)[0]).not.toHaveProperty('ref');
    });

    /** The Mothkin with its Ashwing row laid out as `row` (a book whose table isn't Level 1/3/5). */
    const reshaped = (row: string): { data: BuilderData; species: SpeciesOption } => {
      const description = lineageRowText(splitRow(row));
      const species: SpeciesOption = { ...mothkin, lineages: (mothkin.lineages ?? []).map((l) => (l.name === 'Ashwing' ? { ...l, description } : l)) };
      return { species, data: { ...EXPECTED_MERGED, species: EXPECTED_MERGED.species.map((s) => (s.id === mothkin.id ? species : s)) } };
    };

    it('skips a cell the rules index finds as a cantrip (spec §2.1), whether the grant or the gain looks it up', () => {
      const { data, species } = reshaped('| Ashwing | Resistance to Necrotic damage. | Chill Touch | False Life | Ray of Enfeeblement |');
      const c = moth('Ashwing', 5, species);
      expect(names(c, data)).toEqual(['False Life']);
      // Without a lookup of its own the grant passes every cell on; the gain's lookup leaves the cantrip out all the same.
      expect(lineageSpellGrants(c, data).map((g) => g.name)).toEqual(['Chill Touch', 'False Life']);
      const gain = alwaysPreparedGained(c, undefined, undefined, 0, findSpell, [], lineageSpellGrants(c, data));
      expect(gain).toEqual({ add: [expect.objectContaining({ name: 'False Life', level: 1, source: 'Ashwing' })], flip: [], missing: [] });
    });

    it('lists a cell the rules lack among the spells to add by hand, quoting it only when it reads as a name, and counts none (spec §2.1)', () => {
      const { data, species } = reshaped('| Ashwing | You know the Light cantrip. | Cinder Mote | You learn the faerie fire spell |');
      const c = moth('Ashwing', 5, species);
      const { edit, cast } = levelWithLineage(c, c.classes[0], data);
      expect(edit.gain).toEqual({
        add: [],
        flip: [],
        missing: [
          { name: 'Cinder Mote', source: 'Ashwing' },
          { name: "a spell the app couldn't read from Ashwing's table", source: 'Ashwing' },
        ],
      });
      expect(cast.added).toEqual([]);
      expect(cast.character).toBe(edit.character);
    });
  });

  it('changes nothing for a hero without the lineage trait feature: Mira, a High Elf by name only', () => {
    // The sample hero predates "<Trait> (<Lineage>)" features; her Detect Magic and Misty Step stay Wizard picks.
    const mira = sampleCharacter();
    const at5: Character = { ...mira, classes: mira.classes.map((cl) => ({ ...cl, level: 5 })) };
    expect(lineageSpellGrants(at5, SRD_BUILDER_DATA, findSpell)).toEqual([]);
    const evoker = sub('Wizard', 'Evoker');
    expect(levelSpellsEdit(at5, at5.classes[0], cls('Wizard'), evoker, findSpell, classes, lineageSpellGrants(at5, SRD_BUILDER_DATA, findSpell))).toEqual(
      levelSpellsEdit(at5, at5.classes[0], cls('Wizard'), evoker, findSpell, classes),
    );
    const cast = withLineageCastings(at5, SRD_BUILDER_DATA, []);
    expect(cast).toEqual({ character: at5, lineage: '', added: [], withheldBy: null });
    expect(cast.character).toBe(at5);
    expect(freeCastingLines(cast)).toEqual([]);
    expect(freeCastingNoticeParts(cast)).toEqual([]);
    // Without the species data (it failed to load) nothing is read either.
    expect(lineageSpellGrants(lineageHero('Drow', [entry('Fighter', 5)]), null, findSpell)).toEqual([]);
  });
});
