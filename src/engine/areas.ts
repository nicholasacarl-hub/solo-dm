/**
 * Areas of effect on a battle map: the seven shapes, Total Cover exclusion, who is inside (with cover
 * against the origin), effect squares and parsing area text from spell descriptions. Pure.
 *
 * CONTRACT (battle map, Day 0) — implemented by engineer A. Grid conventions (C19): a square counts when
 * its centre is inside; spheres and cylinders are round; cones are the 53.13° wedge from the centre of the
 * caster's space with length by grid count; lines are stepped; cubes are axis-aligned; emanations use grid
 * distance; Total Cover excludes a square only when all 5 lines from the origin are blocked; a creature is
 * inside when any square of its space is.
 */
import type { AreaSpec, Character, CombatState, GridPoint, GridRect, MapEffect } from '@/types';
import type { CoverResult } from './sight';

export interface AreaHit {
  id: string;
  squaresInside: number;
  /** Cover against the origin (+2 / +5 to Dexterity saves). */
  cover: CoverResult;
  /** Cones and lines: the creature is airborne (elevation ft); the DM decides. */
  airborneFt?: number;
}

export interface AreaResult {
  /** Affected squares, merged rects, row-major. */
  squares: GridRect[];
  /** Placed, non-defeated creatures with ≥ 1 square inside, initiative order. */
  inside: AreaHit[];
  /** In the shape but every line from the origin is blocked by Total Cover. */
  shielded: { id: string; by: string[] }[];
  /** Every other placed, non-defeated creature. */
  outside: string[];
  /** Where it came from: distance and sight from `fromId` to the centre, and the range check. */
  origin: { fromId?: string; distanceFt?: number; lineOfSight?: boolean; withinRange?: boolean; corner?: { x: number; y: number } };
  /** Squares of the shape that fell off the map. */
  offMap: number;
}

/** `{ problem }` when the spec can't be resolved on this map. Out of range is not a problem: `origin.withinRange` is false. */
export function resolveArea(
  _state: CombatState,
  _hero: Character | null,
  _spec: AreaSpec,
  _opts?: { rangeFt?: number; perspective?: 'dm' | 'player' },
): AreaResult | { problem: string } {
  throw new Error('areas: resolveArea not implemented');
}

/** Squares only (for effects, templates and the preview). */
export function areaSquares(_state: CombatState, _hero: Character | null, _spec: AreaSpec): GridPoint[] {
  throw new Error('areas: areaSquares not implemented');
}

/** An effect's current squares (emanations follow their creature). */
export function effectSquares(_state: CombatState, _hero: Character | null, _effect: MapEffect): GridRect[] {
  throw new Error('areas: effectSquares not implemented');
}

/**
 * "20-foot-radius Sphere", "15-foot Cone", "100-foot-long, 5-foot-wide Line", "5-foot-radius, 40-foot-high Cylinder",
 * "15-foot Emanation", "15-foot Cube", "20-foot square" (→ squares-shaped cube) → shape and sizes; null if none.
 */
export function parseAreaText(_text: string): Pick<AreaSpec, 'shape' | 'sizeFt' | 'widthFt' | 'heightFt'> | null {
  throw new Error('areas: parseAreaText not implemented');
}
