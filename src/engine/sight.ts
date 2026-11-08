/**
 * Line of sight, cover and Total Cover between creatures on a battle map (app conventions C20, C21, C23).
 * Pure. Results are suggestions: "The GM determines whether the target has Cover" (srd:rule:combat-making-an-attack).
 *
 * - Line of sight: some sample point of each space sees the other (grid.segmentBlocked with BLOCKS_SIGHT: walls,
 *   closed/locked doors, obscured terrain and lasting obscured effects); the two spaces' own squares never block;
 *   a creature whose whole space is obscured can't see out or be seen (srd:rule:heavily-obscured). Light and
 *   Darkvision are not modelled (C23). Walls are as tall as needed: elevation doesn't change sight in v1.
 * - Cover (C21; degrees from srd:rule:combat-cover): from each attacker sample corner to each square of the
 *   target's space, 4 lines to that square's corners, each given a level (3 total-cover terrain, 2 three-quarters-cover
 *   terrain, 1 half-cover terrain or another creature's space, else 0); a pair is Total when all 4 lines are at 3,
 *   else by the number k of blocked lines: 0 none, 1–2 Half, 3–4 Three-Quarters, capped at Half when every blocked
 *   line is level 1. The result is the least cover over all pairs.
 * - Total Cover between spaces (D7): every segment between the two spaces' sample points blocked by level-3 terrain.
 */
import type { BattleMap, Character, Combatant, CombatState, GridPoint, GridRect } from '@/types';
import { combatantSize, CELL, coverFeatureName, mapCells, occupants, type MapCells } from './mapCells';
import { footprint, segmentBlocked, segmentBlockers, spaceSamplePoints, type HalfPoint } from './grid';

export type CoverDegree = 'none' | 'half' | 'three-quarters' | 'total';

export interface CoverResult {
  degree: CoverDegree;
  /** The terrain blockers of the chosen pair (the attacker's best corner, the target's least-covered square), by name. */
  byTerrain: string[];
  /** The creatures among the blockers of the chosen pair. */
  byCreatureIds: string[];
}

type Perspective = 'dm' | 'player';

const NO_COVER: CoverResult = { degree: 'none', byTerrain: [], byCreatureIds: [] };
const DEGREE_ORDER: Readonly<Record<CoverDegree, number>> = { none: 0, half: 1, 'three-quarters': 2, total: 3 };

function inRect(r: GridRect, x: number, y: number): boolean {
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

/** A combatant's space (at its position, or at `at`), or null when it isn't on the map or the perspective can't see it. */
function spaceOf(state: CombatState, hero: Character | null, id: string, at: GridPoint | undefined, perspective: Perspective | undefined): GridRect | null {
  const c: Combatant | undefined = state.combatants.find((x) => x.id === id);
  if (!c || (perspective === 'player' && c.hidden)) return null;
  const anchor = at ?? c.position;
  return anchor ? footprint(anchor, combatantSize(c, hero)) : null;
}

function flagAt(cells: MapCells, x: number, y: number): number {
  return x >= 0 && y >= 0 && x < cells.width && y < cells.height ? cells.flags[y * cells.width + x] : 0;
}

function coverAt(cells: MapCells, x: number, y: number): number {
  return x >= 0 && y >= 0 && x < cells.width && y < cells.height ? cells.cover[y * cells.width + x] : 0;
}

function whollyObscured(cells: MapCells, r: GridRect): boolean {
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) if (!(flagAt(cells, x, y) & CELL.OBSCURED)) return false;
  return true;
}

/** Can some sample point of `a` see some sample point of `b` (C20)? */
export function rectsSeeEachOther(cells: MapCells, a: GridRect, b: GridRect): boolean {
  if (whollyObscured(cells, a) || whollyObscured(cells, b)) return false;
  const blocks = (x: number, y: number) => !inRect(a, x, y) && !inRect(b, x, y) && (flagAt(cells, x, y) & CELL.BLOCKS_SIGHT) !== 0;
  const from = spaceSamplePoints(a, blocks);
  const to = spaceSamplePoints(b, blocks);
  for (const p of from) for (const q of to) if (!segmentBlocked(p, q, blocks)) return true;
  return false;
}

/** Can some sample point of space `a` see the point `q` (an area's centre)? */
export function rectSeesPoint(cells: MapCells, a: GridRect, q: HalfPoint): boolean {
  if (whollyObscured(cells, a)) return false;
  const blocks = (x: number, y: number) => !inRect(a, x, y) && (flagAt(cells, x, y) & CELL.BLOCKS_SIGHT) !== 0;
  for (const p of spaceSamplePoints(a, blocks)) if (!segmentBlocked(p, q, blocks)) return true;
  return false;
}

/** Some sample point of each space sees the other (C20). Positions default to the current ones. */
export function lineOfSight(
  state: CombatState,
  hero: Character | null,
  fromId: string,
  toId: string,
  opts: { fromAt?: GridPoint; toAt?: GridPoint; perspective?: Perspective } = {},
): boolean {
  const cells = mapCells(state, hero);
  if (!cells) return false;
  const a = spaceOf(state, hero, fromId, opts.fromAt, opts.perspective);
  const b = spaceOf(state, hero, toId, opts.toAt, opts.perspective);
  if (!a || !b) return false;
  return rectsSeeEachOther(cells, a, b);
}

// ---------------------------------------------------------------------------
// Cover
// ---------------------------------------------------------------------------

interface CoverInput {
  map: BattleMap;
  cells: MapCells;
  /** Attacker sample corners, or the area's origin point. */
  origins: readonly HalfPoint[];
  target: GridRect;
  /** Squares that never block: the attacker's and the target's spaces. */
  own: readonly GridRect[];
  /** Square index → creature id of every creature space that gives Half Cover. */
  creatureAt: ReadonlyMap<number, string>;
}

function degreeOf(levels: readonly number[]): { degree: CoverDegree; k: number } {
  const k = levels.filter((l) => l >= 1).length;
  if (levels.every((l) => l === 3)) return { degree: 'total', k };
  if (k === 0) return { degree: 'none', k };
  if (k <= 2) return { degree: 'half', k };
  return { degree: Math.max(...levels) === 1 ? 'half' : 'three-quarters', k };
}

function coverCore(input: CoverInput): CoverResult {
  const { map, cells, origins, target, own, creatureAt } = input;
  const isOwn = (x: number, y: number) => own.some((r) => inRect(r, x, y));
  const level = (x: number, y: number) => {
    if (isOwn(x, y) || x < 0 || y < 0 || x >= cells.width || y >= cells.height) return 0;
    const terrain = coverAt(cells, x, y);
    return Math.max(terrain, creatureAt.has(y * cells.width + x) ? 1 : 0);
  };
  /** blocksAt[L]: does this square block a line at level L (1 half, 2 three-quarters, 3 total)? Index 0 is unused. */
  const blocksAt: readonly ((x: number, y: number) => boolean)[] = [
    () => false,
    (x, y) => level(x, y) >= 1,
    (x, y) => !isOwn(x, y) && coverAt(cells, x, y) >= 2,
    (x, y) => !isOwn(x, y) && coverAt(cells, x, y) >= 3,
  ];
  let best: { order: number; k: number; degree: CoverDegree; origin: HalfPoint; square: GridPoint; levels: number[]; wedged: boolean[] } | null = null;
  for (const o of origins) {
    for (let ty = target.y0; ty <= target.y1; ty++) {
      for (let tx = target.x0; tx <= target.x1; tx++) {
        const square = { x0: tx, y0: ty, x1: tx, y1: ty };
        const open = spaceSamplePoints(square, blocksAt[3], { centres: false });
        const levels: number[] = [];
        const wedged: boolean[] = [];
        for (const q of squareCorners(tx, ty)) {
          const isWedged = !open.some((p) => p.x2 === q.x2 && p.y2 === q.y2);
          wedged.push(isWedged);
          if (isWedged || segmentBlocked(o, q, blocksAt[3])) levels.push(3);
          else if (segmentBlocked(o, q, blocksAt[2])) levels.push(2);
          else if (segmentBlocked(o, q, blocksAt[1])) levels.push(1);
          else levels.push(0);
        }
        const { degree, k } = degreeOf(levels);
        const order = DEGREE_ORDER[degree];
        if (!best || order < best.order || (order === best.order && k < best.k)) {
          best = { order, k, degree, origin: o, square: { x: tx, y: ty }, levels, wedged };
        }
      }
    }
  }
  if (!best || best.degree === 'none') return { ...NO_COVER, byTerrain: [], byCreatureIds: [] };
  const chosen = best;
  // Name the blockers of the chosen pair: terrain strongest first (a pillar before crates), then creatures.
  const terrainNames: { name: string; level: number }[] = [];
  const byCreatureIds: string[] = [];
  const corners = squareCorners(chosen.square.x, chosen.square.y);
  const addSquare = (x: number, y: number, minLevel: number) => {
    const level = coverAt(cells, x, y);
    if (level >= minLevel) {
      const name = coverFeatureName(map, { x, y }, minLevel);
      const known = terrainNames.find((t) => t.name === name);
      if (name && !known) terrainNames.push({ name, level });
      else if (known && level > known.level) known.level = level;
    }
    const id = minLevel <= 1 ? creatureAt.get(y * cells.width + x) : undefined;
    if (id && !byCreatureIds.includes(id)) byCreatureIds.push(id);
  };
  corners.forEach((q, i) => {
    const l = chosen.levels[i];
    if (l === 0) return;
    if (chosen.wedged[i]) {
      for (const [x, y] of [
        [q.x2 / 2, q.y2 / 2 - 1],
        [q.x2 / 2 - 1, q.y2 / 2],
        [q.x2 / 2 - 1, q.y2 / 2 - 1],
        [q.x2 / 2, q.y2 / 2],
      ]) {
        if (blocksAt[3](x, y)) addSquare(x, y, 3);
      }
      return;
    }
    for (const p of segmentBlockers(chosen.origin, q, blocksAt[l])) addSquare(p.x, p.y, l);
  });
  const byTerrain = terrainNames
    .map((t, i) => ({ ...t, i }))
    .sort((a, b) => b.level - a.level || a.i - b.i)
    .map((t) => t.name);
  return { degree: chosen.degree, byTerrain, byCreatureIds };
}

/** The 4 corners of square (x, y), in doubled coordinates: NW, NE, SW, SE. */
function squareCorners(x: number, y: number): HalfPoint[] {
  return [
    { x2: 2 * x, y2: 2 * y },
    { x2: 2 * x + 2, y2: 2 * y },
    { x2: 2 * x, y2: 2 * y + 2 },
    { x2: 2 * x + 2, y2: 2 * y + 2 },
  ];
}

/** Square index → id for every placed, non-defeated, non-Tiny creature space except `exclude` (Half Cover, C21). */
function coverCreatures(
  state: CombatState,
  hero: Character | null,
  cells: MapCells,
  exclude: (o: { id: string; rect: GridRect }) => boolean,
  perspective: Perspective | undefined,
): Map<number, string> {
  const out = new Map<number, string>();
  for (const o of occupants(state, hero)) {
    if (o.size === 'Tiny' || exclude(o) || (perspective === 'player' && o.hidden)) continue;
    for (let y = o.rect.y0; y <= o.rect.y1; y++) {
      for (let x = o.rect.x0; x <= o.rect.x1; x++) {
        const index = y * cells.width + x;
        if (!out.has(index)) out.set(index, o.id);
      }
    }
  }
  return out;
}

/** Cover the target has against the attacker's attacks (C21). */
export function coverAgainst(
  state: CombatState,
  hero: Character | null,
  attackerId: string,
  targetId: string,
  opts: { attackerAt?: GridPoint; targetAt?: GridPoint; perspective?: Perspective } = {},
): CoverResult {
  const cells = mapCells(state, hero);
  if (!cells || !state.map || attackerId === targetId) return { ...NO_COVER, byTerrain: [], byCreatureIds: [] };
  const a = spaceOf(state, hero, attackerId, opts.attackerAt, opts.perspective);
  const t = spaceOf(state, hero, targetId, opts.targetAt, opts.perspective);
  if (!a || !t) return { ...NO_COVER, byTerrain: [], byCreatureIds: [] };
  const own = [a, t];
  const total = (x: number, y: number) => !inRect(a, x, y) && !inRect(t, x, y) && coverAt(cells, x, y) >= 3;
  const origins = spaceSamplePoints(a, total, { centres: false });
  const creatureAt = coverCreatures(state, hero, cells, (o) => o.id === attackerId || o.id === targetId, opts.perspective);
  return coverCore({ map: state.map, cells, origins, target: t, own, creatureAt });
}

/** Does `r` strictly contain the point (doubled coordinates)? The creature an area comes from never shields anyone. */
function containsPoint(r: GridRect, p: HalfPoint): boolean {
  return p.x2 > 2 * r.x0 && p.x2 < 2 * (r.x1 + 1) && p.y2 > 2 * r.y0 && p.y2 < 2 * (r.y1 + 1);
}

/** The square a point lies strictly inside (a square's centre), as a rect; none for a grid corner or an edge. */
function squareContaining(p: HalfPoint): GridRect[] {
  if (p.x2 % 2 === 0 || p.y2 % 2 === 0) return [];
  const x = (p.x2 - 1) / 2;
  const y = (p.y2 - 1) / 2;
  return [{ x0: x, y0: y, x1: x, y1: y }];
}

/** Cover against an area's origin point (Dexterity saves). */
export function coverFromPoint(state: CombatState, hero: Character | null, origin: HalfPoint, targetId: string): CoverResult {
  return coverFromPointAs(state, hero, origin, targetId, 'dm');
}

/**
 * coverFromPoint, in a perspective ('player': hidden creatures give no cover). Lines leave the origin's own spaces
 * as an attack leaves the attacker's (coverAgainst): neither the square the point lies in nor the space of a creature
 * it lies in (the caster's) gives cover against it — cover counts only when the effect comes from the far side of it
 * (srd:rule:combat-cover).
 */
export function coverFromPointAs(state: CombatState, hero: Character | null, origin: HalfPoint, targetId: string, perspective: Perspective): CoverResult {
  const cells = mapCells(state, hero);
  if (!cells || !state.map) return { ...NO_COVER, byTerrain: [], byCreatureIds: [] };
  const t = spaceOf(state, hero, targetId, undefined, perspective);
  if (!t) return { ...NO_COVER, byTerrain: [], byCreatureIds: [] };
  const seen = (o: { hidden: boolean }) => perspective !== 'player' || !o.hidden;
  const sources = occupants(state, hero).filter((o) => seen(o) && containsPoint(o.rect, origin));
  const own = [t, ...squareContaining(origin), ...sources.map((o) => o.rect)];
  const creatureAt = coverCreatures(state, hero, cells, (o) => o.id === targetId || containsPoint(o.rect, origin), perspective);
  return coverCore({ map: state.map, cells, origins: [origin], target: t, own, creatureAt });
}

/** True when every line between the two spaces is blocked by Total Cover terrain (used by inReach). */
export function totalCoverBetween(
  state: CombatState,
  hero: Character | null,
  aId: string,
  bId: string,
  opts: { aAt?: GridPoint; bAt?: GridPoint } = {},
): boolean {
  const cells = mapCells(state, hero);
  if (!cells) return false;
  const a = spaceOf(state, hero, aId, opts.aAt, 'dm');
  const b = spaceOf(state, hero, bId, opts.bAt, 'dm');
  if (!a || !b) return false;
  return rectsTotalCover(cells, a, b);
}

/** Every segment between the sample points of the two spaces is blocked by total-cover terrain (D7). */
export function rectsTotalCover(cells: MapCells, a: GridRect, b: GridRect): boolean {
  const blocks = (x: number, y: number) => !inRect(a, x, y) && !inRect(b, x, y) && coverAt(cells, x, y) >= 3;
  const from = spaceSamplePoints(a, blocks);
  const to = spaceSamplePoints(b, blocks);
  for (const p of from) for (const q of to) if (!segmentBlocked(p, q, blocks)) return false;
  return true;
}
