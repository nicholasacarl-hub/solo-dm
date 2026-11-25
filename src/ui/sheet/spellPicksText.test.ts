import { describe, expect, it } from 'vitest';
import { owedSpells } from '@/data/options/spellPicks';
import { sampleCharacter } from '@/test/fixtures';
import { SRD_BUILDER_DATA } from '@/test/structuredFixtures';
import type { Character, ClassLevel, ClassOption, KnownSpell } from '@/types';
import { magicalSecretsText, membersOf, multiclassCapText, openPicksText, picksNoteText, picksStatus, restStatus } from './spellPicksText';

const cls = (name: string): ClassOption => {
  const found = SRD_BUILDER_DATA.classes.find((c) => c.name === name);
  if (!found) throw new Error(`no SRD class ${name}`);
  return found;
};
const entry = (name: string, level: number): ClassLevel => {
  const o = cls(name);
  return { classId: o.id, name: o.name, level, hitDie: o.hitDie, casterType: o.casterType };
};
const fill = (className: string, n: number, level: number): KnownSpell[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${className}-${level}-${i}`, name: `${className} ${level}-${i}`, level, prepared: true, source: className }));
const hero = (classes: ClassLevel[], spells: KnownSpell[]): Character => sampleCharacter({ classes, spellcasting: { ability: 'int', slots: {}, spells, concentratingOn: null } });
const open = (c: Character, i = 0, swaps = {}) => {
  const owed = owedSpells(c, c.classes[i], cls(c.classes[i].name));
  if (!owed) throw new Error('expected a count');
  return { cl: c.classes[i], owed, entry: { classId: c.classes[i].classId, ...swaps } };
};

describe('words for the sheet’s spell choices', () => {
  it('says what a level opens, and a level that only swaps (srd:rule:wizard-spellcasting, srd:rule:bard-spellcasting)', () => {
    // The sample Wizard 3 at Wizard 4: 3 of 4 cantrips, a 6-spell book of 12, 5 of 7 prepared.
    const base = sampleCharacter();
    const wizard = { ...base, classes: base.classes.map((cl) => ({ ...cl, level: 4 })) };
    expect(openPicksText(open(wizard))).toBe('Wizard 4: choose 1 cantrip, 6 spellbook spells and 2 prepared spells');
    // Bard 12's table doesn't grow: "Whenever you gain a Bard level, you can replace one spell on your list" and a cantrip.
    const bard = hero([entry('Bard', 12)], [...fill('Bard', 4, 0), ...fill('Bard', 16, 1)]);
    expect(openPicksText(open(bard, 0, { replaceSpell: true, replaceCantrip: true }))).toBe('Bard 12: you may replace a spell and a cantrip');
    // Sorcerer 6 owes one prepared spell and may swap one.
    const sorcerer = hero([entry('Sorcerer', 6)], [...fill('Sorcerer', 5, 0), ...fill('Sorcerer', 9, 1)]);
    expect(openPicksText(open(sorcerer, 0, { replaceSpell: true }))).toBe('Sorcerer 6: choose 1 prepared spell; you may also replace a spell');
    expect(picksNoteText([open(wizard), open(bard)])).toBe('Spells to choose: Wizard 4, Bard 12');
    expect(picksNoteText([open(bard, 0, { replaceSpell: true })])).toBe('Spells you may replace: Bard 12');
  });

  it("explains a multiclass hero's per-class cap once (srd:rule:multiclassing-class-features-spellcasting)", () => {
    // "You determine what spells you can prepare for each class individually, as if you were a single-classed member of
    // that class": a Wizard 3 / Cleric 1 has level 2 slots, but its Cleric spells stop at level 1.
    const c = hero([entry('Wizard', 3), entry('Cleric', 1)], []);
    expect(multiclassCapText(c, c.classes[1], 1)).toBe("Cleric spells of level 1 — as a Cleric 1; your other classes' slots don't raise this");
    expect(multiclassCapText(c, c.classes[0], 2)).toBe("Wizard spells of level 1–2 — as a Wizard 3; your other classes' slots don't raise this");
    // One class with slots (a Fighter's levels have none): nothing to explain.
    const single = hero([entry('Wizard', 3), entry('Fighter', 2)], []);
    expect(multiclassCapText(single, single.classes[0], 2)).toBeNull();
  });

  it('notes Magical Secrets from Bard 10 (srd:rule:bard-magical-secrets)', () => {
    expect(magicalSecretsText(entry('Bard', 10), cls('Bard'))).toBe(
      "Magical Secrets: spells from the Cleric, Druid and Wizard lists aren't listed here; choose those with your DM",
    );
    expect(magicalSecretsText(entry('Bard', 9), cls('Bard'))).toBeNull();
    expect(magicalSecretsText(entry('Cleric', 12), cls('Cleric'))).toBeNull();
  });

  it("puts the form's status in one line", () => {
    expect(picksStatus([
      { kind: 'cantrip', owed: 1, picked: 0 },
      { kind: 'book', owed: 6, picked: 4 },
      { kind: 'prepare', owed: 2, picked: 2 },
    ])).toBe('Still to choose: 1 cantrip, 2 for your book');
    expect(picksStatus([{ kind: 'prepared', owed: 1, picked: 1, giveUp: 'Burning Hands' }])).toBe('Still to choose: 1 prepared spell');
    expect(picksStatus([{ kind: 'prepared', owed: 1, picked: 0, giveUp: 'Burning Hands' }])).toBe('Still to choose: a replacement for Burning Hands, 1 prepared spell');
    expect(picksStatus([{ kind: 'cantrip', owed: 0, picked: 1, giveUp: 'Light' }])).toBe('Nothing left to choose');
    expect(restStatus([{ givenUp: 0, picked: 0 }])).toBe('Choose what to give up, then its replacement');
    expect(restStatus([{ givenUp: 2, picked: 1 }])).toBe('Still to choose: 1 replacement');
    expect(restStatus([{ givenUp: 1, picked: 1 }, { givenUp: 0, picked: 0 }])).toBe('Nothing left to choose');
    expect([membersOf('Cleric'), membersOf('Druids')]).toEqual(['Clerics', 'Druids']);
  });
});
