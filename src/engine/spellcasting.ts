/**
 * Spell slot math under the 2024 rules: single-class tables and multiclass spellcaster level.
 * - full casters: class level; half casters (Paladin, Ranger): half, rounded UP (SRD 5.2.1
 *   "Multiclassing"), which also reproduces their own single-class tables exactly;
 * - third casters (e.g. Eldritch Knight, not in the SRD): a third, rounded down when multiclassing;
 *   on their own they follow their class table (no slots before class level 3, then ⌈level/3⌉);
 * - pact magic (Warlock) is separate and never adds to the multiclass total.
 */
import type {
  Ability,
  Character,
  ClassLevel,
  GameEvent,
  PactMagic,
  SlotTrack,
  SpellSlotLevel,
  SpellSlots,
  Spellcasting,
} from '@/types';
import { srdClassFor } from './classData';
import { clamp, gameEvent, toInt, touch, warning } from './util';

/** Spell slots per slot level (index 0 = 1st) for each spellcaster level 0–20 (SRD 5.2.1 Multiclass Spellcaster table). */
export const SPELL_SLOT_TABLE: readonly (readonly number[])[] = [
  [],
  [2],
  [3],
  [4, 2],
  [4, 3],
  [4, 3, 2],
  [4, 3, 3],
  [4, 3, 3, 1],
  [4, 3, 3, 2],
  [4, 3, 3, 3, 1],
  [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2, 1],
  [4, 3, 3, 3, 2, 1],
  [4, 3, 3, 3, 2, 1, 1],
  [4, 3, 3, 3, 2, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 2, 1, 1],
];

/** Warlock Pact Magic by Warlock level (index 0 = level 1), SRD 5.2.1 Warlock Features table. */
export const PACT_MAGIC_TABLE: readonly { slots: number; slotLevel: SpellSlotLevel }[] = [
  { slots: 1, slotLevel: 1 },
  { slots: 2, slotLevel: 1 },
  { slots: 2, slotLevel: 2 },
  { slots: 2, slotLevel: 2 },
  { slots: 2, slotLevel: 3 },
  { slots: 2, slotLevel: 3 },
  { slots: 2, slotLevel: 4 },
  { slots: 2, slotLevel: 4 },
  { slots: 2, slotLevel: 5 },
  { slots: 2, slotLevel: 5 },
  { slots: 3, slotLevel: 5 },
  { slots: 3, slotLevel: 5 },
  { slots: 3, slotLevel: 5 },
  { slots: 3, slotLevel: 5 },
  { slots: 3, slotLevel: 5 },
  { slots: 3, slotLevel: 5 },
  { slots: 4, slotLevel: 5 },
  { slots: 4, slotLevel: 5 },
  { slots: 4, slotLevel: 5 },
  { slots: 4, slotLevel: 5 },
];

const SLOT_LEVELS: readonly SpellSlotLevel[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];

function classLevel(cl: ClassLevel): number {
  return clamp(toInt(cl.level), 0, 20);
}

function contributes(cl: ClassLevel): boolean {
  return classLevel(cl) > 0 && (cl.casterType === 'full' || cl.casterType === 'half' || cl.casterType === 'third');
}

/** Combined spellcaster level for the multiclass slot table (pact magic excluded). */
export function casterLevel(classes: ClassLevel[]): number {
  const casters = classes.filter(contributes);
  if (casters.length === 1) {
    // One Spellcasting class: follow that class's own table.
    const [cl] = casters;
    const level = classLevel(cl);
    if (cl.casterType === 'full') return level;
    if (cl.casterType === 'half') return Math.ceil(level / 2);
    return level >= 3 ? Math.ceil(level / 3) : 0;
  }
  const total = casters.reduce((sum, cl) => {
    const level = classLevel(cl);
    if (cl.casterType === 'full') return sum + level;
    if (cl.casterType === 'half') return sum + Math.ceil(level / 2);
    return sum + Math.floor(level / 3);
  }, 0);
  return Math.min(20, total);
}

function pactMagicFor(classes: ClassLevel[]): PactMagic | undefined {
  const warlockLevels = Math.min(
    20,
    classes.filter((cl) => cl.casterType === 'pact').reduce((sum, cl) => sum + classLevel(cl), 0),
  );
  if (warlockLevels < 1) return undefined;
  const row = PACT_MAGIC_TABLE[warlockLevels - 1];
  return { slotLevel: row.slotLevel, slots: { max: row.slots, used: 0 } };
}

/** Spell slot maxima (used = 0) and pact magic for a set of class levels. */
export function spellSlotsForClasses(classes: ClassLevel[]): { slots: SpellSlots; pact?: PactMagic } {
  const slots: SpellSlots = {};
  SPELL_SLOT_TABLE[casterLevel(classes)].forEach((max, i) => {
    slots[SLOT_LEVELS[i]] = { max, used: 0 };
  });
  const pact = pactMagicFor(classes);
  return pact ? { slots, pact } : { slots };
}

/** The spellcasting ability of the character's first spellcasting class (by its sheet entry, else the SRD class). */
function defaultSpellcastingAbility(c: Character): Ability {
  for (const cl of c.classes) {
    if (cl.casterType === 'none') continue;
    const ability = cl.spellcastingAbility ?? srdClassFor(cl)?.spellcastingAbility;
    if (ability) return ability;
  }
  return 'int';
}

function keepUsed(max: number, previous: SlotTrack | undefined): SlotTrack {
  return { max, used: clamp(toInt(previous?.used), 0, max) };
}

function sameSlots(a: SpellSlots, b: SpellSlots): boolean {
  return SLOT_LEVELS.every((l) => a[l]?.max === b[l]?.max && a[l]?.used === b[l]?.used);
}

function samePact(a: PactMagic | undefined, b: PactMagic | undefined): boolean {
  if (!a || !b) return a === b;
  return a.slotLevel === b.slotLevel && a.slots.max === b.slots.max && a.slots.used === b.slots.used;
}

/** Recompute slot maxima after a level change, keeping used counts (clamped to the new max). */
export function recomputeSlots(c: Character): Character {
  const fresh = spellSlotsForClasses(c.classes);
  const previous = c.spellcasting;
  if (!previous && Object.keys(fresh.slots).length === 0 && !fresh.pact) return c;

  const slots: SpellSlots = {};
  for (const level of SLOT_LEVELS) {
    const track = fresh.slots[level];
    if (track) slots[level] = keepUsed(track.max, previous?.slots[level]);
  }
  const pact = fresh.pact
    ? { slotLevel: fresh.pact.slotLevel, slots: keepUsed(fresh.pact.slots.max, previous?.pact?.slots) }
    : undefined;
  if (previous && sameSlots(previous.slots, slots) && samePact(previous.pact, pact)) return c;

  const { pact: _oldPact, ...rest } = previous ?? {
    ability: defaultSpellcastingAbility(c),
    spells: [],
    concentratingOn: null,
  };
  const spellcasting: Spellcasting = { ...rest, slots, ...(pact ? { pact } : {}) };
  return touch({ ...c, spellcasting });
}

/** Ordinal label: 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 4 -> "4th". */
export function ordinal(n: number): string {
  const v = Math.trunc(n);
  const lastTwo = Math.abs(v) % 100;
  const last = Math.abs(v) % 10;
  const suffix = lastTwo >= 11 && lastTwo <= 13 ? 'th' : last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th';
  return `${v}${suffix}`;
}

function slotsLeft(track: SlotTrack): string {
  return `${track.max - track.used}/${track.max} left`;
}

function withSpellcasting(c: Character, spellcasting: Spellcasting): Character {
  return touch({ ...c, spellcasting });
}

function spendPact(c: Character, sc: Spellcasting, pact: PactMagic, note = ''): { character: Character; events: GameEvent[]; ok: boolean } {
  const slots = { ...pact.slots, used: pact.slots.used + 1 };
  const character = withSpellcasting(c, { ...sc, pact: { ...pact, slots } });
  return {
    character,
    events: [gameEvent('slot-spent', `Spent a Pact Magic slot (level ${pact.slotLevel}; ${slotsLeft(slots)})${note}`)],
    ok: true,
  };
}

/** Spend one slot of the given level (pact: true spends a pact magic slot). Emits a warning event if none is left. */
export function spendSlot(
  c: Character,
  level: SpellSlotLevel,
  opts: { pact?: boolean } = {},
): { character: Character; events: GameEvent[]; ok: boolean } {
  const sc = c.spellcasting;
  const pact = sc?.pact;
  const pactAvailable = !!pact && pact.slots.used < pact.slots.max;
  if (opts.pact) {
    if (!sc || !pact) return { character: c, events: [warning('No Pact Magic slots to spend.')], ok: false };
    if (!pactAvailable) return { character: c, events: [warning(`No Pact Magic slots left (0/${pact.slots.max}).`)], ok: false };
    return spendPact(c, sc, pact);
  }
  const track = sc?.slots[level];
  if (sc && track && track.used < track.max) {
    const next = { ...track, used: track.used + 1 };
    const character = withSpellcasting(c, { ...sc, slots: { ...sc.slots, [level]: next } });
    return { character, events: [gameEvent('slot-spent', `Spent a level ${level} spell slot (${slotsLeft(next)})`)], ok: true };
  }
  // A Warlock casting without the pact flag: Pact Magic slots cast spells of their level or lower.
  if (sc && pact && pactAvailable && !track?.max && level <= pact.slotLevel) {
    return spendPact(c, sc, pact, ` — no level ${level} spell slots, so a Pact Magic slot was used`);
  }
  const hint = pactAvailable ? ' Pact Magic slots remain (spend one with pact: true).' : '';
  const message = track?.max
    ? `No level ${level} spell slots left (0/${track.max}).${hint}`
    : `No level ${level} spell slots.${hint}`;
  return { character: c, events: [warning(message)], ok: false };
}

/** Restore `count` (default 1) slots of the given level. */
export function restoreSlot(
  c: Character,
  level: SpellSlotLevel,
  count = 1,
  opts: { pact?: boolean } = {},
): { character: Character; events: GameEvent[] } {
  const sc = c.spellcasting;
  const n = Math.max(1, toInt(count, 1));
  if (opts.pact) {
    const pact = sc?.pact;
    if (!sc || !pact) return { character: c, events: [warning('No Pact Magic slots to restore.')] };
    if (pact.slots.used === 0) return { character: c, events: [warning('Pact Magic slots are already full.')] };
    const slots = { ...pact.slots, used: Math.max(0, pact.slots.used - n) };
    return {
      character: withSpellcasting(c, { ...sc, pact: { ...pact, slots } }),
      events: [gameEvent('slot-restored', `Regained ${pact.slots.used - slots.used} Pact Magic slot(s) (${slots.max - slots.used}/${slots.max})`)],
    };
  }
  const track = sc?.slots[level];
  if (!sc || !track?.max) return { character: c, events: [warning(`No level ${level} spell slots to restore.`)] };
  if (track.used === 0) return { character: c, events: [warning(`Level ${level} spell slots are already full (${track.max}/${track.max}).`)] };
  const next = { ...track, used: Math.max(0, track.used - n) };
  return {
    character: withSpellcasting(c, { ...sc, slots: { ...sc.slots, [level]: next } }),
    events: [gameEvent('slot-restored', `Regained ${track.used - next.used} level ${level} spell slot(s) (${next.max - next.used}/${next.max})`)],
  };
}

/** All spell slots and Pact Magic slots unused again (a Long Rest). */
export function resetSpellSlots(sc: Spellcasting): Spellcasting {
  const slots: SpellSlots = {};
  for (const level of SLOT_LEVELS) {
    const track = sc.slots[level];
    if (track) slots[level] = { ...track, used: 0 };
  }
  return { ...sc, slots, ...(sc.pact ? { pact: { ...sc.pact, slots: { ...sc.pact.slots, used: 0 } } } : {}) };
}

/** Highest slot level the character can currently cast with (regular or pact), 0 if none. */
export function highestSlotLevel(c: Character): number {
  const sc = c.spellcasting;
  if (!sc) return 0;
  const regular = SLOT_LEVELS.filter((l) => (sc.slots[l]?.max ?? 0) > 0);
  return Math.max(0, ...regular, sc.pact?.slots.max ? sc.pact.slotLevel : 0);
}
