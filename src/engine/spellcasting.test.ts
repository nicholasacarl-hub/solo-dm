import { describe, expect, it } from 'vitest';
import type { CasterType, Character, ClassLevel, HitDie, SpellSlots } from '@/types';
import { sampleCharacter } from '@/test/fixtures';
import { casterLevel, ordinal, recomputeSlots, restoreSlot, spellSlotsForClasses, spendSlot } from './spellcasting';

const cls = (name: string, level: number, casterType: CasterType, hitDie: HitDie = 8): ClassLevel => ({
  classId: `srd:class:${name.toLowerCase()}`,
  name,
  level,
  hitDie,
  casterType,
});
const wizard = (level: number) => cls('Wizard', level, 'full', 6);
const paladin = (level: number) => cls('Paladin', level, 'half', 10);
const ranger = (level: number) => cls('Ranger', level, 'half', 10);
const warlock = (level: number) => cls('Warlock', level, 'pact');

/** Slot maxima as an array, index 0 = level 1. */
function maxima(slots: SpellSlots): number[] {
  return Object.entries(slots)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, t]) => t?.max ?? 0);
}

describe('single-class slot tables (SRD 5.2.1 class tables)', () => {
  it('Wizard 1 / 5 / 11 / 20', () => {
    expect(maxima(spellSlotsForClasses([wizard(1)]).slots)).toEqual([2]);
    expect(maxima(spellSlotsForClasses([wizard(5)]).slots)).toEqual([4, 3, 2]);
    expect(maxima(spellSlotsForClasses([wizard(11)]).slots)).toEqual([4, 3, 3, 3, 2, 1]);
    expect(maxima(spellSlotsForClasses([wizard(20)]).slots)).toEqual([4, 3, 3, 3, 3, 2, 2, 1, 1]);
    expect(spellSlotsForClasses([wizard(5)]).slots[3]).toEqual({ max: 2, used: 0 });
  });

  it('Paladin 1 / 2 / 5 and Ranger 3 (2024 half casters have slots from level 1)', () => {
    expect(maxima(spellSlotsForClasses([paladin(1)]).slots)).toEqual([2]);
    expect(maxima(spellSlotsForClasses([paladin(2)]).slots)).toEqual([2]);
    expect(maxima(spellSlotsForClasses([paladin(5)]).slots)).toEqual([4, 2]);
    expect(maxima(spellSlotsForClasses([paladin(20)]).slots)).toEqual([4, 3, 3, 3, 2]);
    expect(maxima(spellSlotsForClasses([ranger(3)]).slots)).toEqual([3]);
  });

  it('Warlock Pact Magic 1 / 2 / 5 / 11 / 17', () => {
    expect(spellSlotsForClasses([warlock(1)])).toEqual({ slots: {}, pact: { slotLevel: 1, slots: { max: 1, used: 0 } } });
    expect(spellSlotsForClasses([warlock(2)]).pact).toEqual({ slotLevel: 1, slots: { max: 2, used: 0 } });
    expect(spellSlotsForClasses([warlock(5)]).pact).toEqual({ slotLevel: 3, slots: { max: 2, used: 0 } });
    expect(spellSlotsForClasses([warlock(11)]).pact).toEqual({ slotLevel: 5, slots: { max: 3, used: 0 } });
    expect(spellSlotsForClasses([warlock(17)]).pact?.slots.max).toBe(4);
  });

  it('non-casters and third casters', () => {
    expect(spellSlotsForClasses([cls('Fighter', 10, 'none', 10)])).toEqual({ slots: {} });
    expect(casterLevel([cls('Fighter', 2, 'third', 10)])).toBe(0);
    expect(casterLevel([cls('Fighter', 3, 'third', 10)])).toBe(1);
    expect(maxima(spellSlotsForClasses([cls('Fighter', 4, 'third', 10)]).slots)).toEqual([3]);
    expect(maxima(spellSlotsForClasses([cls('Fighter', 7, 'third', 10)]).slots)).toEqual([4, 2]);
  });
});

describe('multiclass spellcaster level (SRD 5.2.1 Multiclassing)', () => {
  it('adds full-caster levels', () => {
    const classes = [wizard(3), cls('Cleric', 2, 'full')];
    expect(casterLevel(classes)).toBe(5);
    expect(maxima(spellSlotsForClasses(classes).slots)).toEqual([4, 3, 2]);
  });

  it('rounds half-caster levels up', () => {
    const classes = [paladin(3), cls('Sorcerer', 2, 'full', 6)];
    expect(casterLevel(classes)).toBe(4); // ⌈3/2⌉ + 2
    expect(maxima(spellSlotsForClasses(classes).slots)).toEqual([4, 3]);
    expect(casterLevel([ranger(4), cls('Sorcerer', 3, 'full', 6)])).toBe(5); // the SRD's own example
    expect(casterLevel([paladin(1), ranger(1)])).toBe(2);
  });

  it('rounds third-caster levels down and excludes Warlock levels', () => {
    expect(casterLevel([cls('Fighter', 4, 'third', 10), wizard(1)])).toBe(2);
    const classes = [warlock(5), wizard(3)];
    expect(casterLevel(classes)).toBe(3);
    const result = spellSlotsForClasses(classes);
    expect(maxima(result.slots)).toEqual([4, 2]);
    expect(result.pact).toEqual({ slotLevel: 3, slots: { max: 2, used: 0 } });
    expect(casterLevel([])).toBe(0);
  });
});

describe('recomputeSlots', () => {
  it('keeps used counts when slots grow', () => {
    const c = sampleCharacter({ classes: [{ ...sampleCharacter().classes[0], level: 5 }] });
    const next = recomputeSlots(c);
    expect(next.spellcasting?.slots).toEqual({ 1: { max: 4, used: 1 }, 2: { max: 3, used: 0 }, 3: { max: 2, used: 0 } });
    expect(next.spellcasting?.spells).toHaveLength(c.spellcasting?.spells.length ?? -1);
  });

  it('clamps used counts when slots shrink and adds pact magic', () => {
    const base = sampleCharacter();
    const c: Character = {
      ...base,
      classes: [{ ...base.classes[0], level: 1 }, warlock(2)],
      spellcasting: { ...base.spellcasting!, slots: { 1: { max: 4, used: 4 }, 2: { max: 2, used: 2 } } },
    };
    const next = recomputeSlots(c);
    expect(next.spellcasting?.slots).toEqual({ 1: { max: 2, used: 2 } });
    expect(next.spellcasting?.pact).toEqual({ slotLevel: 1, slots: { max: 2, used: 0 } });
  });

  it('creates a spellcasting block for a new caster and leaves non-casters alone', () => {
    const fighter = sampleCharacter({ spellcasting: undefined, classes: [cls('Fighter', 1, 'none', 10)] });
    expect(recomputeSlots(fighter)).toBe(fighter);
    const nowPaladin = { ...fighter, classes: [{ ...paladin(1), spellcastingAbility: 'cha' as const }] };
    const next = recomputeSlots(nowPaladin);
    expect(next.spellcasting?.ability).toBe('cha');
    expect(next.spellcasting?.slots).toEqual({ 1: { max: 2, used: 0 } });
  });

  it('returns the same character when nothing changed', () => {
    const c = sampleCharacter();
    expect(recomputeSlots(c)).toBe(c);
  });
});

describe('spending and restoring slots', () => {
  it('spends a slot and warns when none are left', () => {
    const first = spendSlot(sampleCharacter(), 2);
    expect(first.ok).toBe(true);
    expect(first.character.spellcasting?.slots[2]).toEqual({ max: 2, used: 1 });
    expect(first.events[0]).toEqual({ type: 'slot-spent', message: 'Spent a level 2 spell slot (1/2 left)' });
    const second = spendSlot(first.character, 2);
    const third = spendSlot(second.character, 2);
    expect(third.ok).toBe(false);
    expect(third.character).toBe(second.character);
    expect(third.events[0].type).toBe('warning');
    expect(spendSlot(sampleCharacter(), 3).ok).toBe(false);
  });

  it('spends Pact Magic slots (explicitly, or when a Warlock has no regular slot)', () => {
    const lock = recomputeSlots(sampleCharacter({ spellcasting: undefined, classes: [warlock(5)] }));
    const explicit = spendSlot(lock, 3, { pact: true });
    expect(explicit.ok).toBe(true);
    expect(explicit.character.spellcasting?.pact?.slots.used).toBe(1);
    const implicit = spendSlot(lock, 1);
    expect(implicit.ok).toBe(true);
    expect(implicit.character.spellcasting?.pact?.slots.used).toBe(1);
    expect(spendSlot(lock, 4).ok).toBe(false);
    const drained = spendSlot(explicit.character, 3, { pact: true });
    expect(spendSlot(drained.character, 3, { pact: true }).ok).toBe(false);
  });

  it('restores slots without exceeding the maximum', () => {
    const c = sampleCharacter(); // 1st: 1 of 4 used
    const restored = restoreSlot(c, 1);
    expect(restored.character.spellcasting?.slots[1]).toEqual({ max: 4, used: 0 });
    expect(restored.events[0].type).toBe('slot-restored');
    expect(restoreSlot(restored.character, 1).events[0].type).toBe('warning');
    expect(restoreSlot(c, 1, 5).character.spellcasting?.slots[1]?.used).toBe(0);
    expect(restoreSlot(c, 7).events[0].type).toBe('warning');
  });
});

describe('ordinal', () => {
  it('labels slot levels', () => {
    expect([1, 2, 3, 4, 9, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual([
      '1st', '2nd', '3rd', '4th', '9th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th',
    ]);
  });
});
