/**
 * Rasterises a battle map's terrain and lasting effects into per-square flags (memoized, never stored),
 * and lists the creatures standing on it. Pure.
 *
 * CONTRACT (battle map, Day 0) — implemented by engineer A.
 *
 * Terrain mechanics are fixed per kind (battle-map spec §3.3.1). Rasterising: features apply in stored order;
 * a door clears wall flags on its squares; every other kind ORs its flags in; the cover level is the maximum;
 * lasting effects then OR in DIFFICULT / OBSCURED (which also sets BLOCKS_SIGHT) / HAZARD over their squares
 * (an emanation's squares follow its creature).
 */
import type { Character, CombatState, CreatureSize, GridRect } from '@/types';
import type { MapTeam } from './movement';

export const CELL = {
  BLOCKS_MOVE: 1,
  FILLS: 2,
  BLOCKS_SIGHT: 4,
  DIFFICULT: 8,
  SHALLOW: 16,
  DEEP: 32,
  PIT: 64,
  HAZARD: 128,
  OBSCURED: 256,
  DOOR: 512,
  DOOR_CLOSED: 1024,
} as const;

export interface MapCells {
  readonly width: number;
  readonly height: number;
  /** CELL flags per square, index y * width + x: terrain plus lasting effects. */
  readonly flags: Uint16Array;
  /** Terrain cover level per square: 0 none, 1 half, 2 three-quarters, 3 total. */
  readonly cover: Uint8Array;
  /** Sparse: terrain labels, hazard/effect labels and place names per square index. */
  readonly labelsAt: ReadonlyMap<number, readonly string[]>;
  readonly hazardsAt: ReadonlyMap<number, readonly string[]>;
  readonly placesAt: ReadonlyMap<number, readonly string[]>;
  /** Door feature id per square index. */
  readonly doorAt: ReadonlyMap<number, string>;
}

/** Null without a map. Memoized per (map object, positions of emanation anchors); never stored. */
export function mapCells(_state: CombatState, _hero: Character | null): MapCells | null {
  throw new Error('mapCells: mapCells not implemented');
}

export interface Occupant {
  id: string;
  rect: GridRect;
  elevationFt: number;
  size: CreatureSize;
  team: MapTeam;
  incapacitated: boolean;
  hidden: boolean;
}

/** Placed, non-defeated combatants with their spaces (initiative order). */
export function occupants(_state: CombatState, _hero: Character | null): Occupant[] {
  throw new Error('mapCells: occupants not implemented');
}
