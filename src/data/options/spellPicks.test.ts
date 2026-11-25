import { describe, expect, it } from 'vitest';
import compendiumRaw from '../../../public/srd/compendium.json?raw';
import { nameKey } from '@/lib/id';
import { sampleCharacter } from '@/test/fixtures';
import { SRD_BUILDER_DATA } from '@/test/structuredFixtures';
import type { Character, ClassLevel, ClassOption, CompendiumEntry, Feature, KnownSpell } from '@/types';
import { cantripsKnown, preparedSpellCount } from './classFeatures';
import {
  alwaysPreparedGained,
  applyAlwaysPrepared,
  classSpellRules,
  closeSpellPicks,
  openSpellPicks,
  owedSpells,
  owedSpellsLine,
  owedSpellsSummary,
  recordingHint,
  spellPicksAfterLevel,
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
    expect(missing.missing).toEqual(['Divine Smite']);
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
    expect(owedSpellsLine(owed)).toBe('Wizard 4 (spells of level 1–2): up to 1 cantrip (the sheet has 3 of 4), 6 spellbook spells (6 of at least 12) and 2 prepared spells (5 of 7).');
    expect(recordingHint(owed)).toContain('source "Wizard" (prepared: false for a spell only added to the spellbook)');
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
