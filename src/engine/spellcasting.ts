/**
 * Spell slot math under the 2024 rules: single-class tables and multiclass spellcaster level.
 * - full casters: class level; half casters (Paladin, Ranger): half, rounded UP;
 *   third casters (e.g. Eldritch Knight): a third, rounded down; pact magic (Warlock) is separate.
 */
import type { Character, ClassLevel, PactMagic, SpellSlotLevel, SpellSlots, GameEvent } from '@/types';

/** Combined spellcaster level for the multiclass slot table (pact magic excluded). */
export function casterLevel(_classes: ClassLevel[]): number {
  throw new Error('not implemented');
}

/** Spell slot maxima (used = 0) and pact magic for a set of class levels. */
export function spellSlotsForClasses(_classes: ClassLevel[]): { slots: SpellSlots; pact?: PactMagic } {
  throw new Error('not implemented');
}

/** Recompute slot maxima after a level change, keeping used counts (clamped to the new max). */
export function recomputeSlots(_c: Character): Character {
  throw new Error('not implemented');
}

/** Spend one slot of the given level (pact: true spends a pact magic slot). Emits a warning event if none is left. */
export function spendSlot(
  _c: Character,
  _level: SpellSlotLevel,
  _opts?: { pact?: boolean },
): { character: Character; events: GameEvent[]; ok: boolean } {
  throw new Error('not implemented');
}

/** Restore `count` (default 1) slots of the given level. */
export function restoreSlot(
  _c: Character,
  _level: SpellSlotLevel,
  _count?: number,
  _opts?: { pact?: boolean },
): { character: Character; events: GameEvent[] } {
  throw new Error('not implemented');
}

/** Ordinal label: 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 4 -> "4th". */
export function ordinal(_n: number): string {
  throw new Error('not implemented');
}
