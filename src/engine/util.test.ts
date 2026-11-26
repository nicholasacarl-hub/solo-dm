import { describe, expect, it } from 'vitest';
import * as engine from '@/engine';
import { namesSpell, withoutNote } from './util';

// A Concentration can be recorded under a sheet copy's noted name ("Hold Person (scroll)", a multiclass sheet's "Shield
// of Faith (Paladin)") or a casting's ("Hold Person (3rd level)"; srd:spell:hold-person: "Using a Higher-Level Spell
// Slot"): whatever reads that Concentration's spell reads it without the note (H1/HN1/HX1).
describe('withoutNote and namesSpell: a noted name is read as its spell (H1; srd:spell:hold-person: "Concentration, up to 1 minute")', () => {
  it('withoutNote leaves off one trailing parenthetical; a name with none, or only one, is returned as it is', () => {
    expect(withoutNote('Hold Person (3rd level)')).toBe('Hold Person');
    expect(withoutNote('Hold Person (scroll)')).toBe('Hold Person');
    expect(withoutNote('Shield of Faith(Paladin) ')).toBe('Shield of Faith');
    // One note only: the one before it stays.
    expect(withoutNote('Hold Person (scroll) (3rd level)')).toBe('Hold Person (scroll)');
    for (const name of ['Hold Person', '(scroll)', ' (scroll) ', 'Hold Person (scroll', 'Hold (Person) of Doom', '']) expect(withoutNote(name), name).toBe(name);
    // The DM tools read it from the engine barrel, one rule for both.
    expect(engine.withoutNote).toBe(withoutNote);
  });

  it('namesSpell: the text names the spell as whole words, or the spell without its note', () => {
    // srd:spell:haste: "it gains a +2 bonus to Armor Class": the DM's words for a copy recorded as "Haste (scroll)".
    expect(namesSpell('set by the DM: Haste', 'Haste (scroll)')).toBe(true);
    expect(namesSpell('Hold Person', 'Hold Person (scroll)')).toBe(true);
    // As namesPhrase reads the name itself: a note in the text, a plural.
    expect(namesSpell('Hold Person (Cultist Fanatic)', 'Hold Person')).toBe(true);
    expect(namesSpell('Webs over the door', 'Web (scroll)')).toBe(true);
    // Whole words only, and a note alone names no spell.
    expect(namesSpell('set by the DM: Hasted', 'Haste (scroll)')).toBe(false);
    expect(namesSpell('Shield', 'Shield of Faith (scroll)')).toBe(false);
    expect(namesSpell('set by the DM: Haste', '(scroll)')).toBe(false);
    expect(namesSpell(undefined, 'Haste (scroll)')).toBe(false);
  });
});
