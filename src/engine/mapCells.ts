/**
 * Rasterises a battle map's terrain and lasting effects into per-square flags (memoized, never stored),
 * and lists the creatures standing on it. Pure.
 *
 * Terrain mechanics are fixed per kind (battle-map spec §3.3.1). Rasterising: features apply in stored order;
 * a door replaces any wall on its squares (doors sit in walls); every other kind ORs its flags in; the cover
 * level is the maximum; lasting effects then OR in DIFFICULT / OBSCURED (which also sets BLOCKS_SIGHT) / HAZARD
 * over their squares (an emanation's squares follow its creature).
 */
import type {
  ActiveCondition,
  BattleMap,
  Character,
  Combatant,
  CombatSide,
  CombatState,
  CreatureSize,
  GridPoint,
  GridRect,
  MapEffect,
  MapPlace,
  TerrainFeature,
} from '@/types';
import { CREATURE_SIZES } from '@/types';
import { effectSquares } from './areas';
import { conditionKey, INCAPACITATING_CONDITIONS } from './conditions';
import { footprint } from './grid';
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

// ---------------------------------------------------------------------------
// Terrain (memoized per terrain + places arrays and map size)
// ---------------------------------------------------------------------------

const KIND_BIT = {
  wall: 1,
  difficult: 2,
  'shallow-water': 4,
  'deep-water': 8,
  pit: 16,
  hazard: 32,
  'half-cover': 64,
  'three-quarters-cover': 128,
  obscured: 256,
} as const;

/** Flags and cover level each non-door kind contributes (spec §3.3.1). */
const KIND_FLAGS: readonly { bit: number; flags: number; cover: number }[] = [
  { bit: KIND_BIT.difficult, flags: CELL.DIFFICULT, cover: 0 },
  { bit: KIND_BIT['shallow-water'], flags: CELL.SHALLOW | CELL.DIFFICULT, cover: 0 },
  { bit: KIND_BIT['deep-water'], flags: CELL.DEEP, cover: 0 },
  { bit: KIND_BIT.pit, flags: CELL.PIT, cover: 0 },
  { bit: KIND_BIT.hazard, flags: CELL.HAZARD, cover: 0 },
  { bit: KIND_BIT['half-cover'], flags: CELL.DIFFICULT, cover: 1 },
  { bit: KIND_BIT['three-quarters-cover'], flags: CELL.BLOCKS_MOVE | CELL.FILLS, cover: 2 },
  { bit: KIND_BIT.obscured, flags: CELL.OBSCURED | CELL.BLOCKS_SIGHT, cover: 0 },
];

const SOLID = CELL.BLOCKS_MOVE | CELL.FILLS | CELL.BLOCKS_SIGHT;

function pushLabel(into: Map<number, string[]>, index: number, label: string): void {
  const list = into.get(index);
  if (!list) into.set(index, [label]);
  else if (!list.includes(label)) list.push(label);
}

/** Each in-map square of `rects` (clipped), once per rect. */
function forEachSquare(rects: readonly GridRect[], width: number, height: number, fn: (index: number) => void): void {
  for (const r of rects) {
    const x0 = Math.max(0, Math.min(r.x0, r.x1));
    const x1 = Math.min(width - 1, Math.max(r.x0, r.x1));
    const y0 = Math.max(0, Math.min(r.y0, r.y1));
    const y1 = Math.min(height - 1, Math.max(r.y0, r.y1));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) fn(y * width + x);
  }
}

function rasteriseTerrain(width: number, height: number, terrain: readonly TerrainFeature[], places: readonly MapPlace[]): MapCells {
  const n = width * height;
  const kinds = new Uint16Array(n);
  /** 0 no door, 1 open, 2 closed or locked (the last door feature on a square wins). */
  const door = new Uint8Array(n);
  const doorAt = new Map<number, string>();
  const wallLabels = new Map<number, string[]>();
  const otherLabels = new Map<number, string[]>();
  const hazardsAt = new Map<number, string[]>();
  for (const f of terrain) {
    if (f.kind === 'door') {
      const state = f.door === 'open' ? 1 : 2;
      forEachSquare(f.rects, width, height, (i) => {
        door[i] = state;
        doorAt.set(i, f.id);
        if (f.label) pushLabel(otherLabels, i, f.label);
      });
      continue;
    }
    const bit: number | undefined = (KIND_BIT as Readonly<Record<string, number>>)[f.kind];
    if (!bit) continue; // an unknown kind (normalizeBattleMap drops them; never trust stored data)
    forEachSquare(f.rects, width, height, (i) => {
      kinds[i] |= bit;
      if (f.label) pushLabel(f.kind === 'wall' ? wallLabels : otherLabels, i, f.label);
      if (f.kind === 'hazard') pushLabel(hazardsAt, i, f.label ?? 'hazard');
    });
  }
  const flags = new Uint16Array(n);
  const cover = new Uint8Array(n);
  const labelsAt = new Map<number, string[]>();
  for (let i = 0; i < n; i++) {
    let f = 0;
    let c = 0;
    if (door[i] === 2) {
      f |= CELL.DOOR | CELL.DOOR_CLOSED | SOLID;
      c = 3;
    } else if (door[i] === 1) {
      f |= CELL.DOOR;
    } else if (kinds[i] & KIND_BIT.wall) {
      f |= SOLID;
      c = 3;
    }
    const k = kinds[i];
    if (k) {
      for (const kf of KIND_FLAGS) {
        if (!(k & kf.bit)) continue;
        f |= kf.flags;
        if (kf.cover > c) c = kf.cover;
      }
    }
    flags[i] = f;
    cover[i] = c;
    // A door replaces the wall it sits in, label included.
    const labels = [...(door[i] ? [] : (wallLabels.get(i) ?? [])), ...(otherLabels.get(i) ?? [])];
    if (labels.length) labelsAt.set(i, labels);
  }
  const placesAt = new Map<number, string[]>();
  for (const p of places) forEachSquare(p.rects, width, height, (i) => pushLabel(placesAt, i, p.name));
  return { width, height, flags, cover, labelsAt, hazardsAt, placesAt, doorAt };
}

interface TerrainMemo {
  places: readonly MapPlace[];
  width: number;
  height: number;
  cells: MapCells;
}
const terrainMemo = new WeakMap<readonly TerrainFeature[], TerrainMemo>();

/**
 * The map's terrain and places only (no effects). Lasting effects never change FILLS, BLOCKS_MOVE or cover,
 * so areas measure Total Cover on these. Memoized per (terrain array, places array, size).
 */
export function terrainCells(map: BattleMap): MapCells {
  const memo = terrainMemo.get(map.terrain);
  if (memo && memo.places === map.places && memo.width === map.width && memo.height === map.height) return memo.cells;
  const cells = rasteriseTerrain(map.width, map.height, map.terrain, map.places);
  terrainMemo.set(map.terrain, { places: map.places, width: map.width, height: map.height, cells });
  return cells;
}

/** The cover level each kind gives (§3.3.1); a closed or locked door is a wall. */
function featureCover(f: TerrainFeature): number {
  switch (f.kind) {
    case 'wall':
      return 3;
    case 'door':
      return f.door === 'open' ? 0 : 3;
    case 'three-quarters-cover':
      return 2;
    case 'half-cover':
      return 1;
    default:
      return 0;
  }
}

const UNLABELLED: Readonly<Record<string, string>> = {
  wall: 'wall',
  door: 'door',
  'three-quarters-cover': 'three-quarters cover',
  'half-cover': 'half cover',
};

/**
 * The name of the feature that gives a square at least `minLevel` cover (1 half, 2 three-quarters, 3 total), for
 * DM text: its label ("crates", "pillar"), else its kind ("wall", "door"); null when nothing there gives that cover.
 * The first such feature in stored order wins; a wall under a door doesn't count (the door replaced it).
 */
export function coverFeatureName(map: BattleMap, p: GridPoint, minLevel: number): string | null {
  const inside = (f: TerrainFeature) => f.rects.some((r) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1);
  const doorHere = map.terrain.find((f) => f.kind === 'door' && inside(f));
  for (const f of map.terrain) {
    if (featureCover(f) < minLevel || !inside(f)) continue;
    if (f.kind === 'wall' && doorHere) continue;
    return f.label ?? UNLABELLED[f.kind] ?? f.kind;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lasting effects on top (memoized per effects array, terrain and emanation anchors)
// ---------------------------------------------------------------------------

/** The size of a combatant's space: the hero's from the sheet unless overridden; NPCs default Medium (§2.3). */
export function combatantSize(c: Combatant, hero: Character | null): CreatureSize {
  const size = c.size ?? (c.isPlayer && hero ? hero.size : undefined);
  return size && CREATURE_SIZES.includes(size) ? size : 'Medium';
}

/** The conditions that apply to a combatant: the hero's live from the sheet, NPCs' from the tracker. */
export function combatantConditions(c: Combatant, hero: Character | null): readonly ActiveCondition[] {
  return c.isPlayer && hero ? hero.conditions : c.conditions;
}

function isLasting(e: MapEffect): boolean {
  return e.duration === 'lasting';
}

/** What the lasting effects' squares depend on beyond the map: where each emanation's creature stands. */
function emanationKey(state: CombatState, hero: Character | null, effects: readonly MapEffect[]): string {
  const parts: string[] = [];
  for (const e of effects) {
    if (e.spec.shape !== 'emanation') continue;
    const c = e.spec.fromId ? state.combatants.find((x) => x.id === e.spec.fromId) : undefined;
    parts.push(c?.position ? `${e.id}@${c.position.x},${c.position.y},${combatantSize(c, hero)}` : `${e.id}@-`);
  }
  return parts.join('|');
}

interface EffectsMemo {
  base: MapCells;
  key: string;
  cells: MapCells;
}
/** A few entries per effects array: the DM's and the player's views of one state differ in their emanation anchors. */
const effectsMemo = new WeakMap<readonly MapEffect[], EffectsMemo[]>();
const EFFECTS_MEMO_SIZE = 4;

function withEffects(base: MapCells, state: CombatState, hero: Character | null, lasting: readonly MapEffect[]): MapCells {
  const flags = new Uint16Array(base.flags);
  const hazardsAt = new Map<number, string[]>();
  for (const [i, list] of base.hazardsAt) hazardsAt.set(i, [...list]);
  for (const e of lasting) {
    let add = 0;
    if (e.terrain.includes('difficult')) add |= CELL.DIFFICULT;
    if (e.terrain.includes('obscured')) add |= CELL.OBSCURED | CELL.BLOCKS_SIGHT;
    if (e.terrain.includes('hazard')) add |= CELL.HAZARD;
    forEachSquare(effectSquares(state, hero, e), base.width, base.height, (i) => {
      flags[i] |= add;
      pushLabel(hazardsAt, i, e.label);
    });
  }
  return { ...base, flags, hazardsAt };
}

/** Null without a map. Memoized per (map object, positions of emanation anchors); never stored. */
export function mapCells(state: CombatState, hero: Character | null): MapCells | null {
  const map = state.map;
  if (!map) return null;
  const base = terrainCells(map);
  const lasting = map.effects.filter(isLasting);
  if (lasting.length === 0) return base;
  const key = emanationKey(state, hero, lasting);
  const memo = effectsMemo.get(map.effects) ?? [];
  const hit = memo.find((m) => m.base === base && m.key === key);
  if (hit) return hit.cells;
  const cells = withEffects(base, state, hero, lasting);
  effectsMemo.set(map.effects, [{ base, key, cells }, ...memo].slice(0, EFFECTS_MEMO_SIZE));
  return cells;
}

// ---------------------------------------------------------------------------
// Occupants
// ---------------------------------------------------------------------------

/** C6, the same table as movement's teamOf (kept here so occupancy never waits on the movement module). */
const SIDE_TEAM: Readonly<Record<CombatSide, MapTeam>> = { player: 'party', ally: 'party', enemy: 'foes', neutral: 'neutral' };

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
export function occupants(state: CombatState, hero: Character | null): Occupant[] {
  const out: Occupant[] = [];
  for (const c of state.combatants) {
    if (c.defeated || !c.position) continue;
    const size = combatantSize(c, hero);
    out.push({
      id: c.id,
      rect: footprint(c.position, size),
      elevationFt: c.elevationFt ?? 0,
      size,
      team: SIDE_TEAM[c.side] ?? 'neutral',
      incapacitated: combatantConditions(c, hero).some((k) => INCAPACITATING_CONDITIONS.has(conditionKey(k.id))),
      hidden: c.hidden === true,
    });
  }
  return out;
}
