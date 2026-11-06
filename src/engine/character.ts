/**
 * Character state transitions. Every function is pure: it returns a NEW Character plus
 * GameEvents describing what happened (used for log lines and DM tool results).
 * Functions never throw for game-rule problems (e.g. not enough gold); they return the
 * unchanged character with a 'warning' event instead. updatedAt is bumped on change.
 */
import type {
  ActiveCondition,
  Character,
  Currency,
  Feature,
  GameEvent,
  InventoryItem,
  KnownSpell,
} from '@/types';

export interface EngineResult {
  character: Character;
  events: GameEvent[];
}

/** A blank level-1 character shell with sane defaults (used by the builder). */
export function createBlankCharacter(_campaignId: string): Character {
  throw new Error('not implemented');
}

/**
 * Apply damage (2024 rules): temporary HP absorb first; at 0 HP the character falls unconscious
 * (adds the Unconscious condition and resets death saves). Massive damage: if damage remaining
 * after reaching 0 HP is >= HP max, the character dies. Damage taken while already at 0 HP adds one
 * death-save failure (two if `critical`); three failures = dead.
 */
export function applyDamage(
  _c: Character,
  _amount: number,
  _opts?: { critical?: boolean; damageType?: string },
): EngineResult {
  throw new Error('not implemented');
}

/** Heal (capped at HP max). Healing from 0 HP revives: removes Unconscious and resets death saves. Dead characters cannot be healed. */
export function applyHealing(_c: Character, _amount: number): EngineResult {
  throw new Error('not implemented');
}

/** Temporary HP don't stack: keep the higher of current and new. */
export function setTempHp(_c: Character, _amount: number): EngineResult {
  throw new Error('not implemented');
}

/**
 * Record a death saving throw from the natural d20 (2024): 10+ success, 9- failure, natural 1 = two
 * failures, natural 20 = regain 1 HP (revived). Three successes = stable; three failures = dead.
 */
export function recordDeathSave(
  _c: Character,
  _natural: number,
): EngineResult & { outcome: 'success' | 'failure' | 'stable' | 'revived' | 'dead' } {
  throw new Error('not implemented');
}

/** Add a condition (no duplicates; refreshes source/duration). Use changeExhaustion for exhaustion. */
export function addCondition(_c: Character, _condition: ActiveCondition): EngineResult {
  throw new Error('not implemented');
}

export function removeCondition(_c: Character, _conditionId: string): EngineResult {
  throw new Error('not implemented');
}

/** Change exhaustion by delta, clamped 0–6. Reaching 6 = death (2024). */
export function changeExhaustion(_c: Character, _delta: number): EngineResult {
  throw new Error('not implemented');
}

/** Find a feature by (fuzzy, case-insensitive) name. */
export function findFeature(_c: Character, _name: string): Feature | undefined {
  throw new Error('not implemented');
}

/** Use `amount` (default 1) uses of a limited-use feature. Warns if not enough uses remain. */
export function useFeature(_c: Character, _name: string, _amount?: number): EngineResult {
  throw new Error('not implemented');
}

/** Restore all uses of a feature (or `amount` uses). */
export function restoreFeature(_c: Character, _name: string, _amount?: number): EngineResult {
  throw new Error('not implemented');
}

export function addFeature(_c: Character, _feature: Omit<Feature, 'id'> & { id?: string }): EngineResult {
  throw new Error('not implemented');
}

export function removeFeature(_c: Character, _name: string): EngineResult {
  throw new Error('not implemented');
}

/** Find an inventory item by (fuzzy, case-insensitive) name. */
export function findItem(_c: Character, _name: string): InventoryItem | undefined {
  throw new Error('not implemented');
}

/** Add an item; stacks onto an existing item with the same name (non-magic, no charges). */
export function addItem(_c: Character, _item: Omit<InventoryItem, 'id'> & { id?: string }): EngineResult {
  throw new Error('not implemented');
}

/** Remove `quantity` (default all) of an item. Warns if the item is missing or the quantity is too high. */
export function removeItem(_c: Character, _name: string, _quantity?: number): EngineResult {
  throw new Error('not implemented');
}

export function updateItem(
  _c: Character,
  _name: string,
  _patch: Partial<Omit<InventoryItem, 'id'>>,
): EngineResult {
  throw new Error('not implemented');
}

/**
 * Add (positive) or spend (negative) coins. When spending, make change automatically from larger
 * denominations (1 pp = 10 gp, 1 gp = 10 sp = 2 ep, 1 sp = 10 cp). Warns and changes nothing if the
 * character cannot afford it.
 */
export function changeCurrency(_c: Character, _delta: Partial<Currency>): EngineResult {
  throw new Error('not implemented');
}

/** Total wealth expressed in gp (fractional). */
export function totalGp(_currency: Currency): number {
  throw new Error('not implemented');
}

/** Add XP; reports whether the new total reaches the next level (for XP-based campaigns). */
export function gainXp(_c: Character, _amount: number): EngineResult & { levelUpAvailable: boolean } {
  throw new Error('not implemented');
}

export function addSpell(_c: Character, _spell: Omit<KnownSpell, 'id'> & { id?: string }): EngineResult {
  throw new Error('not implemented');
}

export function removeSpell(_c: Character, _name: string): EngineResult {
  throw new Error('not implemented');
}

/** Start (name) or end (null) concentration. Starting a new one ends the previous. */
export function setConcentration(_c: Character, _spellName: string | null): EngineResult {
  throw new Error('not implemented');
}
