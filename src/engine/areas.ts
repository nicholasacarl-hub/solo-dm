/**
 * Areas of effect on a battle map: the seven shapes, Total Cover exclusion, who is inside (with cover
 * against the origin), effect squares and parsing area text from spell descriptions. Pure.
 *
 * Grid conventions (app convention C19; shapes from srd:rule:area-of-effect, srd:rule:sphere, srd:rule:cylinder,
 * srd:rule:cone, srd:rule:line, srd:rule:cube, srd:rule:emanation):
 * - Sphere / Cylinder: round — a square is in when its centre is within the radius in a straight line (D8);
 *   the centre is a square's centre, a grid corner or a creature's centre.
 * - Cone: apex at the centre of the caster's space; a square is in when its centre lies in the 53.13° wedge
 *   (`along > 0` and `|lateral| ≤ along / 2`, edges inclusive) and its grid distance from the caster's space is
 *   within the length (D9).
 * - Line: stepped along its main axis from the apex; each step takes the `width / 5` squares nearest the axis
 *   (ties to the right of travel); squares inside the caster's space don't count (D10).
 * - Cube: axis-aligned; from a creature it sits against the face or corner the aim snaps to; placed, it centres
 *   on the given square (odd sides) or that square's south-east corner (even sides) (D11).
 * - Emanation: grid distance from the creature's space (D12). Squares: exactly the given squares.
 * Then squares off the map are counted, squares that fill their space (walls, closed doors, three-quarters cover)
 * are dropped, and a square is shielded when all 5 lines from the origin to its centre and corners are blocked by
 * Total Cover terrain (D13). A creature is inside when any square of its space is and the vertical test passes (D14).
 * All arithmetic is exact (doubled integer coordinates).
 */
import type {
  AreaShape,
  AreaSpec,
  BattleMap,
  Character,
  Combatant,
  CombatState,
  GridPoint,
  GridRect,
  MapEffect,
  MapRef,
} from '@/types';
import {
  cornerLabel,
  dirVector,
  footprint,
  mergeSquares,
  rectGap,
  segmentBlocked,
  segmentBlockers,
  sizeSquares,
  snapDirection,
  spaceSamplePoints,
  squareLabel,
  SQUARE_FT,
  type HalfPoint,
} from './grid';
import { CELL, combatantSize, coverFeatureName, mapCells, occupants, terrainCells, type MapCells, type Occupant } from './mapCells';
import { coverFromPointAs, rectSeesPoint, type CoverResult } from './sight';

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

type Perspective = 'dm' | 'player';

const DEFAULT_LINE_WIDTH_FT = 5;
const DEFAULT_CYLINDER_HEIGHT_FT = 40;

// ---------------------------------------------------------------------------
// Resolving references
// ---------------------------------------------------------------------------

interface Body {
  c: Combatant;
  rect: GridRect;
  elevationFt: number;
}

/** A point on the map with the squares that touch it (a point is measured from those) and its creature, if any. */
interface RefPoint {
  point: HalfPoint;
  touching: GridRect;
  body?: Body;
}

type Problem = { problem: string };

function isProblem<T extends object>(v: T | Problem): v is Problem {
  return 'problem' in v;
}

function centreOf(r: GridRect): HalfPoint {
  return { x2: r.x0 + r.x1 + 1, y2: r.y0 + r.y1 + 1 };
}

function bodyOf(state: CombatState, hero: Character | null, id: string, perspective: Perspective): Body | Problem {
  const c = state.combatants.find((x) => x.id === id);
  if (!c || (perspective === 'player' && c.hidden)) return { problem: "That creature isn't in this fight." };
  if (!c.position) return { problem: `${c.name} isn't on the map.` };
  return { c, rect: footprint(c.position, combatantSize(c, hero)), elevationFt: c.elevationFt ?? 0 };
}

function refPoint(state: CombatState, hero: Character | null, ref: MapRef, perspective: Perspective): RefPoint | Problem {
  const map = state.map;
  if (!map) return { problem: 'This fight has no battle map.' };
  switch (ref.kind) {
    case 'square': {
      const { x, y } = ref.at;
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) return { problem: `${squareLabel(ref.at)} is off the map.` };
      return { point: { x2: 2 * x + 1, y2: 2 * y + 1 }, touching: { x0: x, y0: y, x1: x, y1: y } };
    }
    case 'corner': {
      const { x, y } = ref;
      if (x < 0 || y < 0 || x > map.width || y > map.height) return { problem: `The corner ${cornerLabel(x, y)} is off the map.` };
      const touching = {
        x0: Math.max(0, x - 1),
        y0: Math.max(0, y - 1),
        x1: Math.min(map.width - 1, x),
        y1: Math.min(map.height - 1, y),
      };
      return { point: { x2: 2 * x, y2: 2 * y }, touching };
    }
    case 'creature': {
      const body = bodyOf(state, hero, ref.id, perspective);
      if (isProblem(body)) return body;
      return { point: centreOf(body.rect), touching: body.rect, body };
    }
    case 'direction':
      return { problem: 'A direction is an aim, not a place: give a square, a corner or a creature.' };
  }
}

/** The aim as a vector from `apex` (doubled units, any length). */
function aimVector(state: CombatState, hero: Character | null, apex: HalfPoint, toward: MapRef | undefined, perspective: Perspective): { x: number; y: number } | Problem {
  if (!toward) return { problem: 'It needs "toward": a square, a creature or a direction.' };
  if (toward.kind === 'direction') {
    const v = dirVector(toward.dir);
    return { x: v.dx, y: v.dy };
  }
  const aim = refPoint(state, hero, toward, perspective);
  if (isProblem(aim)) return aim;
  const v = { x: aim.point.x2 - apex.x2, y: aim.point.y2 - apex.y2 };
  if (v.x === 0 && v.y === 0) return { problem: "It can't aim at its own origin: give \"toward\" another square, a creature or a direction." };
  return v;
}

// ---------------------------------------------------------------------------
// Shapes (raw squares; exclusions come after)
// ---------------------------------------------------------------------------

/** Squares whose centre is within `radiusFt` of `c` in a straight line, boundary inclusive (D8). */
function roundSquares(c: HalfPoint, radiusFt: number): GridPoint[] {
  const r2 = (2 * radiusFt) / SQUARE_FT; // the radius in doubled units
  const limit = r2 * r2;
  const out: GridPoint[] = [];
  const x0 = Math.floor((c.x2 - r2) / 2) - 1;
  const x1 = Math.ceil((c.x2 + r2) / 2) + 1;
  const y0 = Math.floor((c.y2 - r2) / 2) - 1;
  const y1 = Math.ceil((c.y2 + r2) / 2) + 1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = 2 * x + 1 - c.x2;
      const dy = 2 * y + 1 - c.y2;
      if (dx * dx + dy * dy <= limit) out.push({ x, y });
    }
  }
  return out;
}

function inRect(r: GridRect | undefined, x: number, y: number): boolean {
  return !!r && x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

function rectPoints(r: GridRect): GridPoint[] {
  const out: GridPoint[] = [];
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) out.push({ x, y });
  return out;
}

/** D9: centre in the 53.13° wedge from `apex` along `u` (edges inclusive) and within `n` squares of `from`. */
function coneSquares(apex: HalfPoint, u: { x: number; y: number }, from: GridRect, n: number, skip: GridRect | undefined): GridPoint[] {
  const out: GridPoint[] = [];
  for (let y = from.y0 - n; y <= from.y1 + n; y++) {
    for (let x = from.x0 - n; x <= from.x1 + n; x++) {
      if (inRect(skip, x, y)) continue;
      const g = rectGap(from, { x0: x, y0: y, x1: x, y1: y });
      if (Math.max(g.x, g.y) > n) continue;
      const vx = 2 * x + 1 - apex.x2;
      const vy = 2 * y + 1 - apex.y2;
      const along = vx * u.x + vy * u.y;
      const lateral = vx * u.y - vy * u.x;
      if (along > 0 && 2 * Math.abs(lateral) <= along) out.push({ x, y });
    }
  }
  return out;
}

/** The square index a doubled coordinate falls in; on a grid line, the square ahead in direction `sign`. */
function aheadIndex(v2: number, sign: number): number {
  if (v2 % 2 !== 0) return Math.floor(v2 / 2);
  return sign > 0 ? v2 / 2 : v2 / 2 - 1;
}

/**
 * D10: step along the main axis (x when |ux| ≥ |uy|) one square at a time from the apex; at each step take the
 * `w` squares nearest the axis across it (ties toward the right of travel); a step whose squares are all inside
 * the caster's space doesn't count; stop after `n` counted steps.
 */
function lineSquares(apex: HalfPoint, u: { x: number; y: number }, n: number, w: number, skip: GridRect | undefined): GridPoint[] {
  const xMain = Math.abs(u.x) >= Math.abs(u.y);
  const main = xMain ? u.x : u.y;
  const cross = xMain ? u.y : u.x;
  const sign = main > 0 ? 1 : -1;
  const d = Math.abs(main);
  // Right of travel (y grows south): (−uy, ux). Its component across the main axis:
  const rightCross = xMain ? u.x : -u.y;
  const apexMain = xMain ? apex.x2 : apex.y2;
  const apexCross = xMain ? apex.y2 : apex.x2;
  const out: GridPoint[] = [];
  let counted = 0;
  for (let k = 1; counted < n && k <= n + 8; k++) {
    const mainIndex = aheadIndex(apexMain + 2 * k * sign, sign);
    // The axis crosses at (apexCross + cross·2k/d) in doubled units; scaled by d to stay integer.
    const at = apexCross * d + 2 * k * cross;
    const base = Math.floor(at / (2 * d));
    const candidates: { i: number; dist: number; right: boolean }[] = [];
    for (let i = base - w - 1; i <= base + w + 1; i++) {
      const off = (2 * i + 1) * d - at;
      candidates.push({ i, dist: Math.abs(off), right: off * rightCross > 0 });
    }
    candidates.sort((a, b) => a.dist - b.dist || Number(b.right) - Number(a.right));
    const step = candidates.slice(0, w).map(({ i }) => (xMain ? { x: mainIndex, y: i } : { x: i, y: mainIndex }));
    if (skip && step.every((p) => inRect(skip, p.x, p.y))) continue;
    counted++;
    for (const p of step) if (!inRect(skip, p.x, p.y)) out.push(p);
  }
  return out;
}

/** D11: the squares along one axis of a cube from a creature: past the face it aims at, or centred (ties north/west). */
function cubeSpan(lo: number, hi: number, d: number, n: number): [number, number] {
  if (d > 0) return [hi + 1, hi + n];
  if (d < 0) return [lo - n, lo - 1];
  const start = Math.floor((lo + hi + 1 - n) / 2);
  return [start, start + n - 1];
}

/** D11: a placed cube of n squares centred on a point (odd sides on a square's centre, even sides on a corner). */
function placedCubeStart(c2: number, n: number): number {
  if (c2 % 2 !== 0) {
    // On a square's centre (that square's index is (c2 − 1) / 2).
    const col = (c2 - 1) / 2;
    return n % 2 === 1 ? col - (n - 1) / 2 : col + 1 - n / 2;
  }
  // On a grid line (a corner): even sides centre exactly; odd sides lean north/west.
  const line = c2 / 2;
  return n % 2 === 0 ? line - n / 2 : line - 1 - (n - 1) / 2;
}

/** Squares within `n` squares (grid count) of a space; the space itself only with includeOrigin. */
function emanationSquares(space: GridRect, n: number, includeOrigin: boolean): GridPoint[] {
  const out: GridPoint[] = [];
  for (let y = space.y0 - n; y <= space.y1 + n; y++) {
    for (let x = space.x0 - n; x <= space.x1 + n; x++) {
      if (!includeOrigin && inRect(space, x, y)) continue;
      out.push({ x, y });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// One area, resolved
// ---------------------------------------------------------------------------

/** 'levels': a creature's 5-ft levels must meet [lo, hi]; '3d': within sizeFt by the 3D grid count; 'flag': ignore height, flag fliers. */
type Vertical = { kind: 'levels'; lo: number; hi: number } | { kind: 'emanation'; body: Body; sizeFt: number } | { kind: 'flag' };

interface Shape {
  raw: GridPoint[];
  /** Points the Total Cover test traces from (D13); empty = no exclusion ('squares'). */
  origins: HalfPoint[];
  /** The point hit cover is measured from; null = no cover ('squares'). */
  coverOrigin: HalfPoint | null;
  vertical: Vertical;
  /** Where it is measured to from `fromId` (range, distance, sight): a centre / apex with its touching squares. */
  target: RefPoint | null;
  /** The area comes out of this creature (cones, lines, cubes from a creature, emanations). */
  source?: Body;
}

const SHAPE_NAMES: Readonly<Record<AreaShape, string>> = {
  sphere: 'A Sphere',
  cylinder: 'A Cylinder',
  cone: 'A Cone',
  line: 'A Line',
  cube: 'A Cube',
  emanation: 'An Emanation',
  squares: 'A squares area',
};

function sizeSquaresOf(spec: AreaSpec): number | Problem {
  const size = spec.sizeFt;
  if (typeof size !== 'number' || !Number.isFinite(size) || size < SQUARE_FT) {
    return { problem: `${SHAPE_NAMES[spec.shape]} needs a size of at least 5 ft.` };
  }
  return Math.floor(size / SQUARE_FT);
}

function levelOf(elevationFt: number): number {
  return Math.floor(elevationFt / SQUARE_FT);
}

/** The default elevation of an area's centre / base / apex (AreaSpec.elevationFt). */
function baseElevation(spec: AreaSpec, from: Body | undefined, at: RefPoint | undefined): number {
  if (typeof spec.elevationFt === 'number' && Number.isFinite(spec.elevationFt)) return spec.elevationFt;
  if (at?.body) return at.body.elevationFt;
  return from?.elevationFt ?? 0;
}

/** The area's apex: the caster's centre (`fromId`) or `at`; its origin space is the caster's space or the `at` square. */
function apexOf(
  state: CombatState,
  hero: Character | null,
  spec: AreaSpec,
  perspective: Perspective,
): { apex: HalfPoint; space: GridRect; skip: GridRect | undefined; source?: Body; at?: RefPoint } | Problem {
  if (spec.fromId) {
    const body = bodyOf(state, hero, spec.fromId, perspective);
    if (isProblem(body)) return body;
    return { apex: centreOf(body.rect), space: body.rect, skip: body.rect, source: body };
  }
  if (!spec.at) return { problem: `${SHAPE_NAMES[spec.shape]} needs "from" (who makes it) or "at" (the square it starts in).` };
  const at = refPoint(state, hero, spec.at, perspective);
  if (isProblem(at)) return at;
  if (at.body) return { apex: at.point, space: at.body.rect, skip: at.body.rect, source: at.body, at };
  // A square apex: that square is the origin space; a corner apex: measured from the squares around it, none skipped.
  const isSquare = spec.at.kind === 'square';
  return { apex: at.point, space: at.touching, skip: isSquare ? at.touching : undefined, at };
}

function buildShape(state: CombatState, hero: Character | null, spec: AreaSpec, perspective: Perspective): Shape | Problem {
  const from = spec.fromId ? bodyOf(state, hero, spec.fromId, perspective) : undefined;
  if (from && isProblem(from)) return from;
  switch (spec.shape) {
    case 'sphere':
    case 'cylinder': {
      const n = sizeSquaresOf(spec);
      if (typeof n !== 'number') return n;
      if (!spec.at) return { problem: `${SHAPE_NAMES[spec.shape]} needs "at": its centre (a square, a corner or a creature).` };
      const at = refPoint(state, hero, spec.at, perspective);
      if (isProblem(at)) return at;
      const radiusFt = spec.sizeFt as number; // checked by sizeSquaresOf
      const level = levelOf(baseElevation(spec, from, at));
      let vertical: Vertical;
      if (spec.shape === 'sphere') vertical = { kind: 'levels', lo: level - n, hi: level + n };
      else {
        const heightFt = spec.heightFt && spec.heightFt > 0 ? spec.heightFt : DEFAULT_CYLINDER_HEIGHT_FT;
        vertical = { kind: 'levels', lo: level, hi: level + Math.max(1, Math.ceil(heightFt / SQUARE_FT)) - 1 };
      }
      return { raw: roundSquares(at.point, radiusFt), origins: [at.point], coverOrigin: at.point, vertical, target: at };
    }
    case 'cone':
    case 'line': {
      const n = sizeSquaresOf(spec);
      if (typeof n !== 'number') return n;
      const a = apexOf(state, hero, spec, perspective);
      if (isProblem(a)) return a;
      const u = aimVector(state, hero, a.apex, spec.toward, perspective);
      if (isProblem(u)) return u;
      let raw: GridPoint[];
      if (spec.shape === 'cone') raw = coneSquares(a.apex, u, a.space, n, a.skip);
      else {
        const w = Math.max(1, Math.floor((spec.widthFt ?? DEFAULT_LINE_WIDTH_FT) / SQUARE_FT));
        raw = lineSquares(a.apex, u, n, w, a.skip);
      }
      if (spec.includeOrigin && a.skip) raw = [...rectPoints(a.skip), ...raw];
      const target: RefPoint = a.at ?? { point: a.apex, touching: a.space, body: a.source };
      return { raw, origins: [a.apex], coverOrigin: a.apex, vertical: { kind: 'flag' }, target, source: a.source };
    }
    case 'cube': {
      const n = sizeSquaresOf(spec);
      if (typeof n !== 'number') return n;
      if (spec.at) {
        const at = refPoint(state, hero, spec.at, perspective);
        if (isProblem(at)) return at;
        const x0 = placedCubeStart(at.point.x2, n);
        const y0 = placedCubeStart(at.point.y2, n);
        const level = levelOf(baseElevation(spec, from, at));
        return {
          raw: rectPoints({ x0, y0, x1: x0 + n - 1, y1: y0 + n - 1 }),
          origins: [at.point],
          coverOrigin: at.point,
          vertical: { kind: 'levels', lo: level, hi: level + n - 1 },
          target: at,
        };
      }
      if (!from) return { problem: 'A Cube needs "at" (its centre) or "from" and "toward" (a cube coming out of a creature).' };
      const apex = centreOf(from.rect);
      const u = aimVector(state, hero, apex, spec.toward, perspective);
      if (isProblem(u)) return u;
      const d = dirVector(snapDirection(u.x, u.y));
      const [x0, x1] = cubeSpan(from.rect.x0, from.rect.x1, d.dx, n);
      const [y0, y1] = cubeSpan(from.rect.y0, from.rect.y1, d.dy, n);
      let raw = rectPoints({ x0, y0, x1, y1 });
      if (spec.includeOrigin) raw = [...rectPoints(from.rect), ...raw];
      const level = levelOf(baseElevation(spec, from, undefined));
      return {
        raw,
        origins: [apex],
        coverOrigin: apex,
        vertical: { kind: 'levels', lo: level, hi: level + n - 1 },
        target: { point: apex, touching: from.rect, body: from },
        source: from,
      };
    }
    case 'emanation': {
      const n = sizeSquaresOf(spec);
      if (typeof n !== 'number') return n;
      if (!from) return { problem: 'An Emanation needs "from": the creature it surrounds.' };
      const blocks = (x: number, y: number) => totalCoverAt(state.map, x, y) && !inRect(from.rect, x, y);
      return {
        raw: emanationSquares(from.rect, n, spec.includeOrigin === true),
        origins: spaceSamplePoints(from.rect, blocks),
        coverOrigin: centreOf(from.rect),
        vertical: { kind: 'emanation', body: from, sizeFt: n * SQUARE_FT },
        target: { point: centreOf(from.rect), touching: from.rect, body: from },
        source: from,
      };
    }
    case 'squares': {
      const rects = spec.rects ?? [];
      if (rects.length === 0) return { problem: 'A squares area needs its squares.' };
      const raw = rects.flatMap((r) => rectPoints({ x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1), x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1) }));
      return { raw, origins: [], coverOrigin: null, vertical: { kind: 'flag' }, target: null };
    }
  }
}

function totalCoverAt(map: BattleMap | undefined, x: number, y: number): boolean {
  if (!map || x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
  return terrainCells(map).cover[y * map.width + x] >= 3;
}

interface SquareSets {
  /** Final affected squares (in bounds, not filling, not shielded), row-major, unique. */
  kept: GridPoint[];
  /** In bounds and not filling, but behind Total Cover from every origin. */
  shielded: GridPoint[];
  offMap: number;
}

/** D13: off-map squares are counted, filling squares dropped, Total-Cover-shielded squares set aside. */
function classify(map: BattleMap, cells: MapCells, shape: Shape): SquareSets {
  const seen = new Set<number>();
  const kept: GridPoint[] = [];
  const shielded: GridPoint[] = [];
  let offMap = 0;
  const offSeen = new Set<string>();
  const total = (x: number, y: number) => x >= 0 && y >= 0 && x < map.width && y < map.height && cells.cover[y * map.width + x] >= 3;
  const sorted = [...shape.raw].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const p of sorted) {
    if (p.x < 0 || p.y < 0 || p.x >= map.width || p.y >= map.height) {
      const key = `${p.x},${p.y}`;
      if (!offSeen.has(key)) {
        offSeen.add(key);
        offMap++;
      }
      continue;
    }
    const index = p.y * map.width + p.x;
    if (seen.has(index)) continue;
    seen.add(index);
    if (cells.flags[index] & CELL.FILLS) continue;
    if (shape.origins.length > 0 && allLinesBlocked(shape.origins, p, total)) shielded.push(p);
    else kept.push(p);
  }
  return { kept, shielded, offMap };
}

/** The square's centre and 4 corners, in doubled coordinates. */
function fivePoints(p: GridPoint): HalfPoint[] {
  return [
    { x2: 2 * p.x + 1, y2: 2 * p.y + 1 },
    { x2: 2 * p.x, y2: 2 * p.y },
    { x2: 2 * p.x + 2, y2: 2 * p.y },
    { x2: 2 * p.x, y2: 2 * p.y + 2 },
    { x2: 2 * p.x + 2, y2: 2 * p.y + 2 },
  ];
}

function allLinesBlocked(origins: readonly HalfPoint[], p: GridPoint, total: (x: number, y: number) => boolean): boolean {
  for (const o of origins) for (const t of fivePoints(p)) if (!segmentBlocked(o, t, total)) return false;
  return true;
}

function verticalPasses(v: Vertical, o: Occupant, hero: Character | null): boolean {
  if (v.kind === 'flag') return true;
  const lo = levelOf(o.elevationFt);
  const hi = lo + sizeSquares(o.size) - 1;
  if (v.kind === 'levels') return lo <= v.hi && hi >= v.lo;
  // Emanation: the 3D grid count from its creature's space (srd:rule:emanation; C3).
  const src = v.body;
  const srcLo = levelOf(src.elevationFt);
  const srcHi = srcLo + sizeSquares(combatantSize(src.c, hero)) - 1;
  const g = rectGap(src.rect, o.rect);
  const gz = Math.max(0, lo - srcHi, srcLo - hi);
  return SQUARE_FT * Math.max(g.x, g.y, gz) <= v.sizeFt;
}

function visibleOccupants(state: CombatState, hero: Character | null, perspective: Perspective): Occupant[] {
  const all = occupants(state, hero);
  return perspective === 'player' ? all.filter((o) => !o.hidden) : all;
}

/** 5 × the grid count from a space to a point's touching squares, with the point at `pointLevel` (C3). */
function distanceToPoint(from: Body, hero: Character | null, touching: GridRect, pointLevel: number): number {
  const g = rectGap(from.rect, touching);
  const lo = levelOf(from.elevationFt);
  const hi = lo + sizeSquares(combatantSize(from.c, hero)) - 1;
  const gz = Math.max(0, pointLevel - hi, lo - pointLevel);
  return SQUARE_FT * Math.max(g.x, g.y, gz);
}

function originInfo(
  state: CombatState,
  hero: Character | null,
  spec: AreaSpec,
  shape: Shape,
  kept: readonly GridPoint[],
  cells: MapCells,
  rangeFt: number | undefined,
  perspective: Perspective,
): AreaResult['origin'] {
  const out: AreaResult['origin'] = {};
  const at = shape.target;
  if (at && at.point.x2 % 2 === 0 && at.point.y2 % 2 === 0 && (spec.at?.kind === 'corner' || spec.at?.kind === 'creature')) {
    out.corner = { x: at.point.x2 / 2, y: at.point.y2 / 2 };
  }
  if (!spec.fromId) return out;
  out.fromId = spec.fromId;
  const from = bodyOf(state, hero, spec.fromId, perspective);
  if (isProblem(from)) return out;
  if (shape.source && shape.source.c.id === from.c.id) {
    // It comes out of the caster: no distance to cover.
    out.distanceFt = 0;
    out.lineOfSight = true;
  } else if (at) {
    out.distanceFt = distanceToPoint(from, hero, at.touching, levelOf(baseElevation(spec, from, at)));
    out.lineOfSight = at.body ? rectSeesPoint(cells, from.rect, at.point) || at.body.c.id === from.c.id : rectSeesPoint(cells, from.rect, at.point);
  } else if (kept.length > 0) {
    // 'squares': the nearest affected square.
    let best: GridPoint = kept[0];
    let bestFt = Number.POSITIVE_INFINITY;
    for (const p of kept) {
      const d = distanceToPoint(from, hero, { x0: p.x, y0: p.y, x1: p.x, y1: p.y }, 0);
      if (d < bestFt) {
        bestFt = d;
        best = p;
      }
    }
    out.distanceFt = bestFt;
    out.lineOfSight = rectSeesPoint(cells, from.rect, { x2: 2 * best.x + 1, y2: 2 * best.y + 1 });
  }
  if (typeof rangeFt === 'number' && out.distanceFt !== undefined) out.withinRange = out.distanceFt <= rangeFt;
  return out;
}

function shieldedBy(map: BattleMap, cells: MapCells, origins: readonly HalfPoint[], squares: readonly GridPoint[]): string[] {
  const total = (x: number, y: number) => x >= 0 && y >= 0 && x < map.width && y < map.height && cells.cover[y * map.width + x] >= 3;
  const names: string[] = [];
  const o = origins[0];
  if (!o) return names;
  for (const p of squares) {
    for (const b of segmentBlockers(o, { x2: 2 * p.x + 1, y2: 2 * p.y + 1 }, total)) {
      const name = coverFeatureName(map, b, 3);
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

function resolveWith(state: CombatState, hero: Character | null, spec: AreaSpec, perspective: Perspective): { shape: Shape; sets: SquareSets } | Problem {
  const map = state.map;
  if (!map) return { problem: 'This fight has no battle map.' };
  const shape = buildShape(state, hero, spec, perspective);
  if (isProblem(shape)) return shape;
  return { shape, sets: classify(map, terrainCells(map), shape) };
}

/** `{ problem }` when the spec can't be resolved on this map. Out of range is not a problem: `origin.withinRange` is false. */
export function resolveArea(
  state: CombatState,
  hero: Character | null,
  spec: AreaSpec,
  opts: { rangeFt?: number; perspective?: Perspective } = {},
): AreaResult | { problem: string } {
  const perspective = opts.perspective ?? 'dm';
  const resolved = resolveWith(state, hero, spec, perspective);
  if (isProblem(resolved)) return resolved;
  const { shape, sets } = resolved;
  const map = state.map as BattleMap;
  const cells = mapCells(state, hero) ?? terrainCells(map);
  const keptIndex = new Set(sets.kept.map((p) => p.y * map.width + p.x));
  const shieldedIndex = new Set(sets.shielded.map((p) => p.y * map.width + p.x));
  const inside: AreaHit[] = [];
  const shielded: AreaResult['shielded'] = [];
  const outside: string[] = [];
  for (const o of visibleOccupants(state, hero, perspective)) {
    let count = 0;
    const behind: GridPoint[] = [];
    for (let y = o.rect.y0; y <= o.rect.y1; y++) {
      for (let x = o.rect.x0; x <= o.rect.x1; x++) {
        const index = y * map.width + x;
        if (keptIndex.has(index)) count++;
        else if (shieldedIndex.has(index)) behind.push({ x, y });
      }
    }
    const vertical = verticalPasses(shape.vertical, o, hero);
    if (count > 0 && vertical) {
      const hit: AreaHit = {
        id: o.id,
        squaresInside: count,
        cover: shape.coverOrigin
          ? coverFromPointAs(state, hero, shape.coverOrigin, o.id, perspective)
          : { degree: 'none', byTerrain: [], byCreatureIds: [] },
      };
      if (shape.vertical.kind === 'flag' && o.elevationFt > 0) hit.airborneFt = o.elevationFt;
      inside.push(hit);
    } else if (behind.length > 0 && vertical) {
      shielded.push({ id: o.id, by: shieldedBy(map, cells, shape.origins, behind) });
    } else {
      outside.push(o.id);
    }
  }
  return {
    squares: mergeSquares(sets.kept),
    inside,
    shielded,
    outside,
    origin: originInfo(state, hero, spec, shape, sets.kept, cells, opts.rangeFt, perspective),
    offMap: sets.offMap,
  };
}

/** Squares only (for effects, templates and the preview), row-major; [] when the spec can't be resolved. */
export function areaSquares(state: CombatState, hero: Character | null, spec: AreaSpec): GridPoint[] {
  const resolved = resolveWith(state, hero, spec, 'dm');
  return isProblem(resolved) ? [] : resolved.sets.kept;
}

/**
 * An effect's current squares (emanations follow their creature). A lasting emanation whose creature is gone
 * or off the map has no squares (mapWarnings reports it); other effects keep the squares they were made with.
 */
export function effectSquares(state: CombatState, hero: Character | null, effect: MapEffect): GridRect[] {
  if (effect.spec.shape !== 'emanation') return effect.rects;
  const id = effect.spec.fromId;
  const c = id ? state.combatants.find((x) => x.id === id) : undefined;
  if (!c?.position) return [];
  return mergeSquares(areaSquares(state, hero, effect.spec));
}

// ---------------------------------------------------------------------------
// Area text (spell and stat-block descriptions)
// ---------------------------------------------------------------------------

/** "20-foot", "20 foot", "20 feet", "40-foothigh" (SRD typos included) + an optional qualifier. */
const MEASURE = String.raw`(\d+)\s*-?\s*(?:foot|feet)\s*-?\s*(long|wide|radius|high|tall)?`;
const SHAPE_WORDS = String.raw`(Line|Cylinder|Sphere|Cone|Cube|Emanation|square|circle)`;
/** "a 100-foot-long, 5-foot-wide Line", "a 40-foot-tall, 20-foot-radius Cylinder", "a 10-foot-square area". */
const BEFORE = new RegExp(String.raw`\b${MEASURE}(?:\s*,?\s*(?:and\s+)?${MEASURE})?[\s-]+${SHAPE_WORDS}\b`, 'gi');
/** "a Line of strong wind 60 feet long and 10 feet wide", "a Cylinder that is 10 feet tall with a 60-foot radius". */
const AFTER = new RegExp(String.raw`\b(Line|Cylinder)\b(?:\s+(?:of\s+[a-z ]+?|that\s+is))?\s+${MEASURE}(?:\s*(?:,|and|with\s+a)\s*${MEASURE})?`, 'gi');

type AreaText = Pick<AreaSpec, 'shape' | 'sizeFt' | 'widthFt' | 'heightFt'>;

/** Feet rounded to a whole number of squares (at least one). */
function toSquaresFt(n: number): number {
  return Math.max(SQUARE_FT, Math.round(n / SQUARE_FT) * SQUARE_FT);
}

function fromMeasures(word: string, measures: { ft: number; qualifier: string }[]): AreaText | null {
  const by = (q: string) => measures.find((m) => m.qualifier === q)?.ft;
  const plain = measures.find((m) => !m.qualifier)?.ft;
  switch (word.toLowerCase()) {
    case 'line': {
      const length = by('long') ?? plain ?? measures.find((m) => m.qualifier !== 'wide')?.ft;
      if (length === undefined) return null;
      const width = by('wide');
      return { shape: 'line', sizeFt: toSquaresFt(length), ...(width !== undefined ? { widthFt: toSquaresFt(width) } : {}) };
    }
    case 'cylinder':
    case 'circle': {
      const radius = by('radius') ?? plain;
      if (radius === undefined) return null;
      const height = by('high') ?? by('tall');
      return { shape: 'cylinder', sizeFt: toSquaresFt(radius), ...(height !== undefined ? { heightFt: toSquaresFt(height) } : {}) };
    }
    case 'sphere': {
      const radius = by('radius');
      return radius === undefined ? null : { shape: 'sphere', sizeFt: toSquaresFt(radius) };
    }
    case 'cone':
    case 'cube':
    case 'emanation':
    case 'square': {
      const size = plain ?? measures[0]?.ft;
      if (size === undefined || measures.some((m) => m.qualifier === 'radius')) return null;
      const shape = word.toLowerCase() === 'square' ? 'cube' : (word.toLowerCase() as 'cone' | 'cube' | 'emanation');
      return { shape, sizeFt: toSquaresFt(size) };
    }
    default:
      return null;
  }
}

/**
 * "20-foot-radius Sphere", "15-foot Cone", "100-foot-long, 5-foot-wide Line", "5-foot-radius, 40-foot-high Cylinder",
 * "15-foot Emanation", "15-foot Cube", "20-foot square" (→ squares-shaped cube) → shape and sizes; null if none.
 * The first area phrase in the text wins (Darkness: its Sphere, not the Emanation alternative).
 */
export function parseAreaText(text: string): Pick<AreaSpec, 'shape' | 'sizeFt' | 'widthFt' | 'heightFt'> | null {
  if (typeof text !== 'string' || !text) return null;
  const found: { index: number; area: AreaText }[] = [];
  for (const m of text.matchAll(BEFORE)) {
    const measures = [
      { ft: Number(m[1]), qualifier: (m[2] ?? '').toLowerCase() },
      ...(m[3] ? [{ ft: Number(m[3]), qualifier: (m[4] ?? '').toLowerCase() }] : []),
    ];
    const area = fromMeasures(m[5], measures);
    if (area) found.push({ index: m.index ?? 0, area });
  }
  for (const m of text.matchAll(AFTER)) {
    const measures = [
      { ft: Number(m[2]), qualifier: (m[3] ?? '').toLowerCase() },
      ...(m[4] ? [{ ft: Number(m[4]), qualifier: (m[5] ?? '').toLowerCase() }] : []),
    ];
    const area = fromMeasures(m[1], measures);
    if (area) found.push({ index: m.index ?? 0, area });
  }
  if (found.length === 0) return null;
  found.sort((a, b) => a.index - b.index);
  return found[0].area;
}
