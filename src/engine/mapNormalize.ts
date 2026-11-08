/**
 * The single source of truth for reading battle-map data that came from outside memory: backup imports
 * (backup.ts `.transform`) and IndexedDB loads. Lenient and pure: it never throws, drops what it can't
 * read and keeps the combat (an unreadable map is dropped and the fight continues in the theater of the mind).
 *
 * CONTRACT (battle map, Day 0) — implemented by engineer D.
 */
import type { BattleMap, CombatState } from '@/types';

/**
 * A valid BattleMap from untrusted data, or undefined for anything without a numeric width and height
 * (null, a string, NaN, an array…). Clamps the size to MAP_LIMITS, coerces numbers with toInt, clips rects
 * to the map, drops unknown kinds, caps arrays (MAP_LIMITS), drops `turn`, `stop` and effects that name combatants
 * not in `combatantIds`, and repairs `nextId` above every id in use. Idempotent.
 */
export function normalizeBattleMap(_raw: unknown, _combatantIds: readonly string[]): BattleMap | undefined {
  throw new Error('mapNormalize: normalizeBattleMap not implemented');
}

/**
 * A CombatState from a stored row or an import: copies the known fields; per combatant keeps `position` only as
 * integer {x, y} inside the map, `elevationFt` 0–500 (multiple of 5), `size` in CREATURE_SIZES, `speeds` with
 * non-negative integer fields and a boolean `hover`, `reachFt` 5–60, `speedChangeFt` −120–120, boolean `hidden` /
 * `reactionUsed`, and `conditions` as an array; drops every `position` when the map is missing;
 * `map: normalizeBattleMap(raw.map, ids)`. Never throws. Idempotent.
 */
export function normalizeCombatState(_raw: unknown): CombatState {
  throw new Error('mapNormalize: normalizeCombatState not implemented');
}
