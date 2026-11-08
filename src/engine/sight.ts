/**
 * Line of sight, cover and Total Cover between creatures on a battle map (app conventions C20, C21, C23).
 * Pure. Results are suggestions: "The GM determines whether the target has Cover" (srd:rule:combat-making-an-attack).
 *
 * CONTRACT (battle map, Day 0) — implemented by engineer A.
 */
import type { Character, CombatState, GridPoint } from '@/types';
import type { HalfPoint } from './grid';

export type CoverDegree = 'none' | 'half' | 'three-quarters' | 'total';

export interface CoverResult {
  degree: CoverDegree;
  /** The terrain blockers of the chosen pair (the attacker's best corner, the target's least-covered square), by name. */
  byTerrain: string[];
  /** The creatures among the blockers of the chosen pair. */
  byCreatureIds: string[];
}

/** Some sample point of each space sees the other (C20). Positions default to the current ones. */
export function lineOfSight(
  _state: CombatState,
  _hero: Character | null,
  _fromId: string,
  _toId: string,
  _opts?: { fromAt?: GridPoint; toAt?: GridPoint; perspective?: 'dm' | 'player' },
): boolean {
  throw new Error('sight: lineOfSight not implemented');
}

/** Cover the target has against the attacker's attacks (C21). */
export function coverAgainst(
  _state: CombatState,
  _hero: Character | null,
  _attackerId: string,
  _targetId: string,
  _opts?: { attackerAt?: GridPoint; targetAt?: GridPoint; perspective?: 'dm' | 'player' },
): CoverResult {
  throw new Error('sight: coverAgainst not implemented');
}

/** Cover against an area's origin point (Dexterity saves). */
export function coverFromPoint(_state: CombatState, _hero: Character | null, _origin: HalfPoint, _targetId: string): CoverResult {
  throw new Error('sight: coverFromPoint not implemented');
}

/** True when every line between the two spaces is blocked by Total Cover terrain (used by inReach). */
export function totalCoverBetween(
  _state: CombatState,
  _hero: Character | null,
  _aId: string,
  _bId: string,
  _opts?: { aAt?: GridPoint; bAt?: GridPoint },
): boolean {
  throw new Error('sight: totalCoverBetween not implemented');
}
