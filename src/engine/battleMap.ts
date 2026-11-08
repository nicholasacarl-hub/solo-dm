/**
 * The battle map as a whole: create / edit / remove, placement, the turn-start report, footprint re-fits,
 * stamping what the DM was told, the player view (the single redaction point for hidden creatures), the
 * snapshot every text renderer reads, warnings, the DM's glyph drawing and name lookup. Pure.
 *
 * Map-local ids t1…, p1…, e1… share BattleMap.nextId; the map id is "map-<n>"; nothing here reads the clock or
 * randomness. Results are structured data; DM text lives in src/dm/mapText.ts, player text in src/ui/play/map/text.ts.
 */
import type {
  AreaSpec,
  AreaTerrain,
  BattleMap,
  Character,
  Combatant,
  CombatSide,
  CombatState,
  CreatureSize,
  CreatureSpeeds,
  DoorState,
  GridPoint,
  GridRect,
  MapEffect,
  MapPlace,
  MapStop,
  MapTurn,
  TerrainFeature,
  TerrainKind,
  TurnMove,
} from '@/types';
import { AREA_TERRAIN, CREATURE_SIZES, MAP_LIMITS, TERRAIN_KINDS } from '@/types';
import { effectSquares, resolveArea, type AreaResult } from './areas';
import { currentCombatant, findCombatant } from './combat';
import { clipRect, cornerLabel, footprint, rectInBounds, rectsOverlap, sizeSquares, spaceDistanceFt, squareLabel, subtractRect, type MapDims, type Space } from './grid';
import { CELL, combatantSize, mapCells, occupants, type MapCells, type Occupant } from './mapCells';
import { areHostile, currentTurn, inReach, moverStats, teamOf, turnBudget, type MoverStats, type TurnBudget } from './movement';
import { coverAgainst, lineOfSight, type CoverResult } from './sight';
import { toInt } from './util';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = toInt(n, fallback);
  return Math.min(max, Math.max(min, v));
}

/** Trimmed, single-spaced, at most `max` characters; undefined when empty. */
function cleanText(text: unknown, max: number): string | undefined {
  if (typeof text !== 'string') return undefined;
  const t = text.replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return t || undefined;
}

/** Elevation in feet: 0–500, a multiple of 5. */
function cleanElevation(ft: unknown): number {
  const v = clampInt(ft, 0, MAP_LIMITS.maxElevationFt, 0);
  return Math.round(v / 5) * 5;
}

function cleanRects(rects: readonly GridRect[] | undefined, dims: MapDims): GridRect[] {
  const out: GridRect[] = [];
  for (const r of rects ?? []) {
    if (out.length >= MAP_LIMITS.maxRectsPerFeature) break;
    if (![r?.x0, r?.y0, r?.x1, r?.y1].every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
    const clipped = clipRect({ x0: Math.trunc(r.x0), y0: Math.trunc(r.y0), x1: Math.trunc(r.x1), y1: Math.trunc(r.y1) }, dims);
    if (clipped) out.push(clipped);
  }
  return out;
}

const DOOR_STATES: readonly DoorState[] = ['open', 'closed', 'locked'];

function cleanFeature(f: Omit<TerrainFeature, 'id'>, dims: MapDims, id: string): TerrainFeature | null {
  if (!TERRAIN_KINDS.includes(f.kind as TerrainKind)) return null;
  const rects = cleanRects(f.rects, dims);
  if (rects.length === 0) return null;
  const label = cleanText(f.label, MAP_LIMITS.maxLabel);
  const feature: TerrainFeature = { id, kind: f.kind, rects, ...(label ? { label } : {}) };
  if (f.kind === 'door') feature.door = f.door && DOOR_STATES.includes(f.door) ? f.door : 'closed';
  return feature;
}

function cleanPlace(p: Omit<MapPlace, 'id'>, dims: MapDims, id: string): MapPlace | null {
  const name = cleanText(p.name, MAP_LIMITS.maxLabel);
  const rects = cleanRects(p.rects, dims);
  return name && rects.length ? { id, name, rects } : null;
}

function withoutKeys<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Omit<T, K> {
  const copy = { ...obj };
  for (const k of keys) delete copy[k];
  return copy;
}

function patchCombatant(state: CombatState, id: string, fn: (c: Combatant) => Combatant): CombatState {
  return { ...state, combatants: state.combatants.map((c) => (c.id === id ? fn(c) : c)) };
}

function flagAt(cells: MapCells, x: number, y: number): number {
  return cells.flags[y * cells.width + x];
}

function heroOf(state: CombatState): Combatant | undefined {
  return state.combatants.find((c) => c.isPlayer);
}

function spaceOf(c: Combatant, hero: Character | null, at?: GridPoint): Space | null {
  const anchor = at ?? c.position;
  if (!anchor) return null;
  const size = combatantSize(c, hero);
  return { rect: footprint(anchor, size), elevationFt: c.elevationFt ?? 0, size };
}

/** Is (round, current creature) the turn this record or effect belongs to? */
function isCurrentTurn(state: CombatState, round: number, combatantId: string): boolean {
  return round === state.round && currentCombatant(state)?.id === combatantId;
}

function stopIsValid(state: CombatState, stop: MapStop): boolean {
  return isCurrentTurn(state, stop.round, stop.moverId);
}

/**
 * Drop what every reader already ignores: turn-scoped effects of other turns, a stale stop and a stale turn record.
 * During a hidden creature's turn the player view still shows the last visible creature's turn (D42), so what belongs
 * to that turn stays until a visible creature's turn begins; otherwise the player would see it vanish mid-"turn".
 */
function pruneMap(state: CombatState, map: BattleMap): BattleMap {
  const shown = hiddenTurnShown(state);
  const live = (round: number, id: string) => isCurrentTurn(state, round, id) || (shown !== null && round === shown.round && id === shown.id);
  const effects = map.effects.filter((e) => e.duration === 'lasting' || live(e.round, e.turnOfId));
  let out: BattleMap = effects.length === map.effects.length ? map : { ...map, effects };
  if (out.stop && !live(out.stop.round, out.stop.moverId)) out = withoutKeys(out, ['stop']);
  if (out.turn && !live(out.turn.round, out.turn.combatantId)) out = withoutKeys(out, ['turn']);
  return out;
}

// ---------------------------------------------------------------------------
// Create, remove, place
// ---------------------------------------------------------------------------

export interface BattleMapInput {
  name?: string;
  width: number;
  height: number;
  terrain?: Omit<TerrainFeature, 'id'>[];
  places?: Omit<MapPlace, 'id'>[];
}

/**
 * Ids t1…/p1… from nextId; map id "map-<n>". `previous` (a replacement) carries `turn` over and continues the id counter.
 * Sizes are clamped to MAP_LIMITS, rects clipped to the map, empty rects and features dropped, arrays capped; the
 * map id uses the first number of the counter, and the counter always moves past it, so a replacement gets a new id.
 */
export function createBattleMap(input: BattleMapInput, previous?: BattleMap): BattleMap {
  const width = clampInt(input.width, MAP_LIMITS.minSize, MAP_LIMITS.maxSize, MAP_LIMITS.minSize);
  const height = clampInt(input.height, MAP_LIMITS.minSize, MAP_LIMITS.maxSize, MAP_LIMITS.minSize);
  const dims = { width, height };
  const start = Math.max(1, toInt(previous?.nextId, 1));
  let next = start;
  const terrain: TerrainFeature[] = [];
  for (const f of input.terrain ?? []) {
    if (terrain.length >= MAP_LIMITS.maxFeatures) break;
    const feature = cleanFeature(f, dims, `t${next}`);
    if (!feature) continue;
    terrain.push(feature);
    next++;
  }
  const places: MapPlace[] = [];
  for (const p of input.places ?? []) {
    if (places.length >= MAP_LIMITS.maxPlaces) break;
    const place = cleanPlace(p, dims, `p${next}`);
    if (!place) continue;
    places.push(place);
    next++;
  }
  const name = cleanText(input.name, MAP_LIMITS.maxMapName);
  return {
    id: `map-${start}`,
    ...(name ? { name } : {}),
    width,
    height,
    terrain,
    places,
    effects: [],
    ...(previous?.turn ? { turn: previous.turn } : {}),
    nextId: Math.max(next, start + 1),
    rev: previous ? previous.rev + 1 : 0,
  };
}

/** Drop the map and every position/elevation (size, speeds, reach, hidden and reactions stay). */
export function removeBattleMap(state: CombatState): CombatState {
  const rest = withoutKeys(state, ['map']);
  return { ...rest, combatants: state.combatants.map((c) => withoutKeys(c, ['position', 'elevationFt'])) };
}

export type PlacementAnchor =
  /** A group spreads out from it. */
  | { kind: 'square'; at: GridPoint }
  /** One per member, in order. */
  | { kind: 'squares'; at: GridPoint[] }
  | { kind: 'place'; placeId: string }
  /** arriving: mid-fight reinforcements. */
  | { kind: 'auto'; arriving?: boolean };

export interface PlacementRequest {
  ids: string[];
  anchor: PlacementAnchor;
  elevationFt?: number;
}

export interface PlacementResult {
  id: string;
  at: GridPoint | null;
  auto: boolean;
  shiftedFrom?: GridPoint;
  why?: string;
}

/** What makes a square wrong to stand on, in DM words: "a wall", "a pit". */
function terrainWord(flags: number, cover: number): string {
  if (flags & CELL.DOOR_CLOSED) return 'a closed door';
  if (flags & CELL.BLOCKS_MOVE) return cover >= 3 ? 'a wall' : 'three-quarters cover';
  if (flags & CELL.PIT) return 'a pit';
  if (flags & CELL.DEEP) return 'deep water';
  if (flags & CELL.HAZARD) return 'a hazard';
  return 'blocked';
}

const PLACE_BLOCKERS = CELL.BLOCKS_MOVE | CELL.PIT | CELL.DEEP | CELL.HAZARD;

interface PlaceCtx {
  hero: Character | null;
  cells: MapCells;
  dims: MapDims;
}

/** Why `c` can't start at `anchor`, or null when it can (C27). `exact`: this very square was requested. */
function placementProblem(state: CombatState, ctx: PlaceCtx, c: Combatant, anchor: GridPoint, exact: boolean): string | null {
  const size = combatantSize(c, ctx.hero);
  const rect = footprint(anchor, size);
  if (!rectInBounds(rect, ctx.dims)) return `${squareLabel(anchor)} is too close to the edge of the map for a ${size} creature`;
  for (let y = rect.y0; y <= rect.y1; y++) {
    for (let x = rect.x0; x <= rect.x1; x++) {
      const f = flagAt(ctx.cells, x, y);
      if (f & PLACE_BLOCKERS) return `${squareLabel({ x, y })} is ${terrainWord(f, ctx.cells.cover[y * ctx.cells.width + x])}`;
    }
  }
  for (const o of state.combatants) {
    if (o.id === c.id || o.defeated || !o.position) continue;
    const r = footprint(o.position, combatantSize(o, ctx.hero));
    if (!rectsOverlap(r, rect)) continue;
    const x = Math.max(r.x0, rect.x0);
    const y = Math.max(r.y0, rect.y0);
    return `${squareLabel({ x, y })} is ${o.name}'s space`;
  }
  const heroC = heroOf(state);
  if (!exact && c.side === 'enemy' && heroC && heroC.id !== c.id && heroC.position) {
    const heroSpace = spaceOf(heroC, ctx.hero);
    const here: Space = { rect, elevationFt: c.elevationFt ?? 0, size };
    if (heroSpace && spaceDistanceFt(here, heroSpace) <= 5) return `${squareLabel(anchor)} is next to the hero`;
  }
  return null;
}

/** Anchors in rings of growing grid distance from `seed`, by (ring, Euclidean distance, y, x) (C27). */
function* ringOrder(seed: GridPoint, dims: MapDims, n: number): Generator<GridPoint> {
  const maxX = dims.width - n;
  const maxY = dims.height - n;
  const maxRing = Math.max(dims.width, dims.height) * 2;
  for (let ring = 0; ring <= maxRing; ring++) {
    const list: GridPoint[] = [];
    for (let y = seed.y - ring; y <= seed.y + ring; y++) {
      for (let x = seed.x - ring; x <= seed.x + ring; x++) {
        if (Math.max(Math.abs(x - seed.x), Math.abs(y - seed.y)) !== ring) continue;
        if (x < 0 || y < 0 || x > maxX || y > maxY) continue;
        list.push({ x, y });
      }
    }
    list.sort((a, b) => dist2(a, seed) - dist2(b, seed) || a.y - b.y || a.x - b.x);
    yield* list;
  }
}

function dist2(a: GridPoint, b: GridPoint): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function nearestLegal(state: CombatState, ctx: PlaceCtx, c: Combatant, seed: GridPoint): GridPoint | null {
  const n = sizeSquares(combatantSize(c, ctx.hero));
  for (const p of ringOrder(seed, ctx.dims, n)) if (!placementProblem(state, ctx, c, p, false)) return p;
  return null;
}

/** The place's squares near its middle first; anchors whose space is wholly inside it before those that only overlap. */
function placeCandidates(place: MapPlace, n: number, dims: MapDims, from: GridPoint | null): GridPoint[] {
  const inPlace = (x: number, y: number) => place.rects.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
  const xs = place.rects.flatMap((r) => [r.x0, r.x1]);
  const ys = place.rects.flatMap((r) => [r.y0, r.y1]);
  const mid = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  const ref = from ?? mid;
  const out: { p: GridPoint; inside: boolean }[] = [];
  for (let y = 0; y <= dims.height - n; y++) {
    for (let x = 0; x <= dims.width - n; x++) {
      let all = true;
      let any = false;
      for (let dy = 0; dy < n; dy++) {
        for (let dx = 0; dx < n; dx++) {
          if (inPlace(x + dx, y + dy)) any = true;
          else all = false;
        }
      }
      if (any) out.push({ p: { x, y }, inside: all });
    }
  }
  out.sort((a, b) => Number(b.inside) - Number(a.inside) || dist2(a.p, ref) - dist2(b.p, ref) || a.p.y - b.p.y || a.p.x - b.p.x);
  return out.map((o) => o.p);
}

/** The midpoint of the map edge farthest from the hero (north, east, south, west on ties). */
function arrivalEdge(state: CombatState, dims: MapDims): { seed: GridPoint; edge: string } {
  const h = heroOf(state)?.position ?? { x: Math.floor(dims.width / 2), y: dims.height - 2 };
  const edges = [
    { edge: 'north', d: h.y, seed: { x: Math.floor(dims.width / 2), y: 0 } },
    { edge: 'east', d: dims.width - 1 - h.x, seed: { x: dims.width - 1, y: Math.floor(dims.height / 2) } },
    { edge: 'south', d: dims.height - 1 - h.y, seed: { x: Math.floor(dims.width / 2), y: dims.height - 1 } },
    { edge: 'west', d: h.x, seed: { x: 0, y: Math.floor(dims.height / 2) } },
  ];
  let best = edges[0];
  for (const e of edges) if (e.d > best.d) best = e;
  return { seed: best.seed, edge: best.edge };
}

/** Where an auto-placed creature starts looking (C27): the hero low and central, allies by the hero, foes across. */
function autoSeed(state: CombatState, c: Combatant, dims: MapDims): { seed: GridPoint; why?: string } {
  const heroSpot = { x: Math.floor(dims.width / 2), y: Math.max(0, dims.height - 2) };
  if (c.isPlayer) return { seed: heroSpot };
  const heroC = heroOf(state);
  const heroAt = heroC?.position;
  const centre = { x: Math.floor(dims.width / 2), y: Math.floor(dims.height / 2) };
  if (teamOf(c.side) === 'party') return heroAt && heroC ? { seed: heroAt, why: `next to ${heroC.name}` } : { seed: centre };
  if (c.side === 'enemy') {
    const from = heroAt ?? heroSpot;
    const seed = { x: dims.width - 1 - from.x, y: dims.height - 1 - from.y };
    return heroC ? { seed, why: `across the map from ${heroC.name}` } : { seed };
  }
  return { seed: centre, why: 'in the middle of the map' };
}

function withPosition(state: CombatState, id: string, at: GridPoint, elevationFt: number | undefined): CombatState {
  return patchCombatant(state, id, (c) => ({ ...c, position: { x: at.x, y: at.y }, ...(elevationFt !== undefined ? { elevationFt } : {}) }));
}

/**
 * Deterministic placement (C27): requests in order, ids in order; never puts an enemy within 5 ft of the hero
 * unless that exact square was requested; an illegal requested square shifts to the nearest legal one with `why`
 * ("E5 is a wall", "F4 is Bandit 1's space", "B5 is next to the hero"). Everyone named in the requests starts unplaced,
 * so a replacement map can re-place the whole fight. Legal: in bounds, no wall, closed door, three-quarters cover,
 * pit, deep water or hazard, and nobody else's space.
 */
export function placeCombatants(
  state: CombatState,
  hero: Character | null,
  requests: readonly PlacementRequest[],
): { state: CombatState; placed: PlacementResult[] } {
  const map = state.map;
  const allIds = requests.flatMap((r) => r.ids);
  if (!map) return { state, placed: allIds.map((id) => ({ id, at: null, auto: false, why: 'there is no battle map' })) };
  const dims = { width: map.width, height: map.height };
  const placing = new Set(allIds);
  let working: CombatState = {
    ...state,
    combatants: state.combatants.map((c) => (placing.has(c.id) ? withoutKeys(c, ['position']) : c)),
  };
  const placed: PlacementResult[] = [];
  for (const req of requests) {
    const elevationFt = req.elevationFt === undefined ? undefined : cleanElevation(req.elevationFt);
    let prev: Combatant | null = null;
    req.ids.forEach((id, i) => {
      const c = working.combatants.find((x) => x.id === id);
      if (!c) {
        placed.push({ id, at: null, auto: false, why: 'not in this fight' });
        return;
      }
      const ctx: PlaceCtx = { hero, cells: mapCells(working, hero) as MapCells, dims };
      const subject = elevationFt === undefined ? c : { ...c, elevationFt };
      const result = placeOne(working, ctx, subject, req.anchor, i, prev);
      placed.push(result);
      if (result.at) {
        working = withPosition(working, id, result.at, elevationFt);
        prev = working.combatants.find((x) => x.id === id) ?? null;
      }
    });
  }
  return { state: working, placed };
}

function placeOne(
  state: CombatState,
  ctx: PlaceCtx,
  c: Combatant,
  anchor: PlacementAnchor,
  index: number,
  prev: Combatant | null,
): PlacementResult {
  const spread = (seed: GridPoint, why?: string): PlacementResult => {
    const at = nearestLegal(state, ctx, c, seed);
    return at ? { id: c.id, at, auto: true, ...(why ? { why } : {}) } : { id: c.id, at: null, auto: true, why: 'there is no room left on the map' };
  };
  const requested = (at: GridPoint): PlacementResult => {
    const problem = placementProblem(state, ctx, c, at, true);
    if (!problem) return { id: c.id, at: { x: at.x, y: at.y }, auto: false };
    const shifted = nearestLegal(state, ctx, c, at);
    return shifted
      ? { id: c.id, at: shifted, auto: false, shiftedFrom: { x: at.x, y: at.y }, why: problem }
      : { id: c.id, at: null, auto: false, shiftedFrom: { x: at.x, y: at.y }, why: `${problem}, and there is no room left on the map` };
  };
  const nextToPrev = (): PlacementResult | null => (prev?.position ? spread(prev.position, `next to ${prev.name}`) : null);
  switch (anchor.kind) {
    case 'square':
      return index === 0 ? requested(anchor.at) : (nextToPrev() ?? requested(anchor.at));
    case 'squares': {
      const at = anchor.at[index];
      if (at) return requested(at);
      return nextToPrev() ?? (anchor.at.length ? spread(anchor.at[anchor.at.length - 1]) : spread(autoSeed(state, c, ctx.dims).seed));
    }
    case 'place': {
      const place = state.map?.places.find((p) => p.id === anchor.placeId);
      if (!place) return { id: c.id, at: null, auto: false, why: 'that place is not on the map' };
      const n = sizeSquares(combatantSize(c, ctx.hero));
      const candidates = placeCandidates(place, n, ctx.dims, prev?.position ?? null);
      for (const p of candidates) if (!placementProblem(state, ctx, c, p, false)) return { id: c.id, at: p, auto: false };
      const outside = spread(candidates[0] ?? { x: place.rects[0].x0, y: place.rects[0].y0 });
      return { ...outside, auto: false, why: `${place.name} is full` };
    }
    case 'auto': {
      if (index > 0 && !c.isPlayer) {
        const next = nextToPrev();
        if (next) return next;
      }
      if (anchor.arriving && !c.isPlayer) {
        const { seed, edge } = arrivalEdge(state, ctx.dims);
        return spread(seed, `arriving from the ${edge} edge`);
      }
      const { seed, why } = autoSeed(state, c, ctx.dims);
      return spread(seed, why);
    }
  }
}

// ---------------------------------------------------------------------------
// Edits and effects
// ---------------------------------------------------------------------------

export interface MapEdit {
  terrainAdd?: Omit<TerrainFeature, 'id'>[];
  terrainClear?: ({ rects: GridRect[] } | { label: string })[];
  doors?: { at: GridPoint | { label: string }; state: DoorState }[];
  placesAdd?: Omit<MapPlace, 'id'>[];
  placesRemove?: string[];
  creatures?: { id: string; size?: CreatureSize; speeds?: CreatureSpeeds; reachFt?: number; speedChangeFt?: number }[];
  effectsEnd?: string[];
}

export type MapChange =
  | { kind: 'terrain-added'; feature: TerrainFeature }
  | { kind: 'terrain-cleared'; squares: number; labels: string[] }
  | { kind: 'door'; at: GridPoint; state: DoorState; label?: string }
  | { kind: 'place-added' | 'place-removed'; name: string }
  | {
      kind: 'creature';
      id: string;
      patch: Partial<Pick<Combatant, 'size' | 'speeds' | 'reachFt' | 'speedChangeFt'>>;
      moved?: { from: GridPoint; to: GridPoint };
    }
  | { kind: 'effect-ended'; label: string };

type Fail = { ok: false; problem: string };

function sameText(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();
}

function listOr(items: readonly string[], none: string): string {
  return items.length ? items.join(', ') : none;
}

/** The first non-defeated creature standing on any square of `rects`. */
function standerOn(state: CombatState, hero: Character | null, rects: readonly GridRect[]): { c: Combatant; at: GridPoint } | null {
  for (const o of occupants(state, hero)) {
    for (const r of rects) {
      if (!rectsOverlap(o.rect, r)) continue;
      const c = state.combatants.find((x) => x.id === o.id) as Combatant;
      return { c, at: { x: Math.max(o.rect.x0, r.x0), y: Math.max(o.rect.y0, r.y0) } };
    }
  }
  return null;
}

function addTerrain(state: CombatState, hero: Character | null, map: BattleMap, adds: readonly Omit<TerrainFeature, 'id'>[], changes: MapChange[]): BattleMap | Fail {
  let out = map;
  for (const f of adds) {
    if (out.terrain.length >= MAP_LIMITS.maxFeatures) {
      return { ok: false, problem: `The map holds at most ${MAP_LIMITS.maxFeatures} terrain features: clear some with terrain_clear first.` };
    }
    const feature = cleanFeature(f, out, `t${out.nextId}`);
    if (!feature) return { ok: false, problem: `That ${f.kind} has no squares on the map.` };
    const solid = feature.kind === 'wall' || feature.kind === 'three-quarters-cover' || (feature.kind === 'door' && feature.door !== 'open');
    const stander = solid ? standerOn(state, hero, feature.rects) : null;
    if (stander) {
      const what = feature.kind === 'door' ? 'a closed door' : feature.kind === 'wall' ? 'a wall' : 'three-quarters cover';
      return { ok: false, problem: `${stander.c.name} stands at ${squareLabel(stander.at)}: clear that square before putting ${what} there` };
    }
    out = { ...out, terrain: [...out.terrain, feature], nextId: out.nextId + 1 };
    changes.push({ kind: 'terrain-added', feature });
  }
  return out;
}

function countSquares(rects: readonly GridRect[]): number {
  const seen = new Set<string>();
  for (const r of rects) for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) seen.add(`${x},${y}`);
  return seen.size;
}

function clearTerrain(map: BattleMap, clears: NonNullable<MapEdit['terrainClear']>, changes: MapChange[]): BattleMap | Fail {
  let out = map;
  for (const clear of clears) {
    if ('label' in clear) {
      const hit = out.terrain.filter((f) => f.label && sameText(f.label, clear.label));
      if (hit.length === 0) {
        const labels = [...new Set(out.terrain.map((f) => f.label).filter((l): l is string => !!l))];
        return { ok: false, problem: `No terrain is labelled "${clear.label}". Labels on this map: ${listOr(labels, 'none')}.` };
      }
      out = { ...out, terrain: out.terrain.filter((f) => !hit.includes(f)) };
      changes.push({ kind: 'terrain-cleared', squares: countSquares(hit.flatMap((f) => f.rects)), labels: [...new Set(hit.map((f) => f.label as string))] });
      continue;
    }
    const cut = cleanRects(clear.rects, out);
    const covered: GridRect[] = [];
    const labels: string[] = [];
    const terrain: TerrainFeature[] = [];
    for (const f of out.terrain) {
      let rects = f.rects;
      for (const c of cut) {
        for (const r of rects) {
          if (!rectsOverlap(r, c)) continue;
          covered.push({ x0: Math.max(r.x0, c.x0), y0: Math.max(r.y0, c.y0), x1: Math.min(r.x1, c.x1), y1: Math.min(r.y1, c.y1) });
          if (f.label && !labels.includes(f.label)) labels.push(f.label);
        }
        rects = subtractRect(rects, c);
      }
      if (rects.length > MAP_LIMITS.maxRectsPerFeature) {
        return { ok: false, problem: 'That clear would cut a feature into too many pieces: clear it whole (by its label) and add the rest again.' };
      }
      if (rects.length) terrain.push(rects === f.rects ? f : { ...f, rects });
    }
    out = { ...out, terrain };
    changes.push({ kind: 'terrain-cleared', squares: countSquares(covered), labels });
  }
  return out;
}

function setDoors(state: CombatState, hero: Character | null, map: BattleMap, doors: NonNullable<MapEdit['doors']>, changes: MapChange[]): BattleMap | Fail {
  let out = map;
  const doorList = () =>
    out.terrain
      .filter((f) => f.kind === 'door')
      .map((f) => `${f.label ?? 'door'} (${squareLabel({ x: f.rects[0].x0, y: f.rects[0].y0 })})`);
  for (const d of doors) {
    const isLabel = 'label' in d.at;
    const door = isLabel
      ? out.terrain.find((f) => f.kind === 'door' && f.label && sameText(f.label, (d.at as { label: string }).label))
      : out.terrain.find((f) => f.kind === 'door' && f.rects.some((r) => rectsOverlap(r, { x0: (d.at as GridPoint).x, y0: (d.at as GridPoint).y, x1: (d.at as GridPoint).x, y1: (d.at as GridPoint).y })));
    if (!door) {
      const where = isLabel ? `labelled "${(d.at as { label: string }).label}"` : `at ${squareLabel(d.at as GridPoint)}`;
      return { ok: false, problem: `There is no door ${where}. Doors on this map: ${listOr(doorList(), 'none')}.` };
    }
    if (d.state !== 'open') {
      const stander = standerOn(state, hero, door.rects);
      if (stander) return { ok: false, problem: `${stander.c.name} stands in the door at ${squareLabel(stander.at)}` };
    }
    const at = isLabel ? { x: door.rects[0].x0, y: door.rects[0].y0 } : { x: (d.at as GridPoint).x, y: (d.at as GridPoint).y };
    out = { ...out, terrain: out.terrain.map((f) => (f === door ? { ...f, door: d.state } : f)) };
    changes.push({ kind: 'door', at, state: d.state, ...(door.label ? { label: door.label } : {}) });
  }
  return out;
}

function editPlaces(map: BattleMap, adds: readonly Omit<MapPlace, 'id'>[], removes: readonly string[], changes: MapChange[]): BattleMap | Fail {
  let out = map;
  for (const p of adds) {
    if (out.places.length >= MAP_LIMITS.maxPlaces) return { ok: false, problem: `The map holds at most ${MAP_LIMITS.maxPlaces} places: remove one first.` };
    const place = cleanPlace(p, out, `p${out.nextId}`);
    if (!place) return { ok: false, problem: `The place "${p.name}" needs a name and squares on the map.` };
    if (findPlace(out, place.name)) return { ok: false, problem: `There is already a place called "${place.name}".` };
    out = { ...out, places: [...out.places, place], nextId: out.nextId + 1 };
    changes.push({ kind: 'place-added', name: place.name });
  }
  for (const name of removes) {
    const place = findPlace(out, name);
    if (!place) return { ok: false, problem: `There is no place called "${name}". Places on this map: ${listOr(out.places.map((p) => p.name), 'none')}.` };
    out = { ...out, places: out.places.filter((p) => p !== place) };
    changes.push({ kind: 'place-removed', name: place.name });
  }
  return out;
}

function editCreatures(state: CombatState, hero: Character | null, creatures: NonNullable<MapEdit['creatures']>, changes: MapChange[]): CombatState | Fail {
  let out = state;
  for (const edit of creatures) {
    const c = out.combatants.find((x) => x.id === edit.id);
    if (!c) return { ok: false, problem: `There is no creature "${edit.id}" in this fight.` };
    const patch: Partial<Pick<Combatant, 'size' | 'speeds' | 'reachFt' | 'speedChangeFt'>> = {};
    if (edit.size !== undefined) {
      if (!CREATURE_SIZES.includes(edit.size)) return { ok: false, problem: `"${edit.size}" isn't a creature size.` };
      patch.size = edit.size;
    }
    if (edit.speeds !== undefined) patch.speeds = cleanSpeeds(edit.speeds);
    if (edit.reachFt !== undefined) patch.reachFt = clampInt(edit.reachFt, 5, 60, 5);
    if (edit.speedChangeFt !== undefined) patch.speedChangeFt = clampInt(edit.speedChangeFt, -120, 120, 0);
    const before = c.position;
    out = patchCombatant(out, c.id, (x) => {
      let next: Combatant = { ...x, ...patch };
      if (patch.speedChangeFt === 0) next = withoutKeys(next, ['speedChangeFt']);
      return next;
    });
    const change: Extract<MapChange, { kind: 'creature' }> = { kind: 'creature', id: c.id, patch };
    if (patch.size !== undefined && before) {
      // Re-fit only the creature that changed size; anything else is the DM's to see in mapWarnings.
      const refit = refitSome(out, hero, new Set([c.id]));
      out = refit.state;
      const moved = refit.moved.find((m) => m.id === c.id);
      if (moved) change.moved = { from: moved.from, to: moved.to };
      if (refit.unplaced.includes(c.id)) {
        return { ok: false, problem: `${c.name} doesn't fit anywhere on the map as a ${patch.size} creature.` };
      }
    }
    changes.push(change);
  }
  return out;
}

function cleanSpeeds(s: CreatureSpeeds): CreatureSpeeds {
  const out: CreatureSpeeds = {};
  for (const k of ['walk', 'fly', 'swim', 'climb', 'burrow'] as const) {
    const v = s[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = clampInt(v, 0, 1000, 0);
  }
  if (s.hover === true) out.hover = true;
  return out;
}

function endEffects(map: BattleMap, labels: readonly string[], changes: MapChange[]): BattleMap | Fail {
  let out = map;
  for (const label of labels) {
    const hit = out.effects.filter((e) => sameText(e.label, label));
    if (hit.length === 0) {
      return { ok: false, problem: `No effect called "${label}" is on the map. Effects: ${listOr(out.effects.map((e) => e.label), 'none')}.` };
    }
    out = { ...out, effects: out.effects.filter((e) => !hit.includes(e)) };
    changes.push({ kind: 'effect-ended', label: hit[0].label });
  }
  return out;
}

/** Atomic: every item is checked first; any problem returns { ok: false } and nothing changes. */
export function editMap(
  state: CombatState,
  hero: Character | null,
  edit: MapEdit,
): { ok: true; state: CombatState; changes: MapChange[] } | { ok: false; problem: string } {
  if (!state.map) return { ok: false, problem: 'This fight has no battle map.' };
  const changes: MapChange[] = [];
  let map: BattleMap | Fail = state.map;
  const fail = (m: BattleMap | Fail): m is Fail => 'ok' in m;
  map = addTerrain(state, hero, map, edit.terrainAdd ?? [], changes);
  if (fail(map)) return map;
  map = clearTerrain(map, edit.terrainClear ?? [], changes);
  if (fail(map)) return map;
  map = setDoors(state, hero, map, edit.doors ?? [], changes);
  if (fail(map)) return map;
  map = editPlaces(map, edit.placesAdd ?? [], edit.placesRemove ?? [], changes);
  if (fail(map)) return map;
  map = endEffects(map, edit.effectsEnd ?? [], changes);
  if (fail(map)) return map;
  const layoutChanged = map.terrain !== state.map.terrain || map.places !== state.map.places || map.effects !== state.map.effects;
  let next: CombatState = { ...state, map: layoutChanged ? { ...map, rev: state.map.rev + 1 } : map };
  if (edit.creatures?.length) {
    const edited = editCreatures(next, hero, edit.creatures, changes);
    if ('ok' in edited) return edited;
    next = edited;
  }
  if (changes.length === 0) return { ok: true, state, changes };
  return { ok: true, state: { ...next, map: pruneMap(next, next.map as BattleMap) }, changes };
}

/** "G4", "D4/E5" or the creature's name: where an area is centred, for a range problem. */
function centreName(state: CombatState, spec: AreaSpec): string {
  const at = spec.at;
  if (!at) return 'its centre';
  if (at.kind === 'square') return squareLabel(at.at);
  if (at.kind === 'corner') return cornerLabel(at.x, at.y);
  if (at.kind === 'creature') return state.combatants.find((c) => c.id === at.id)?.name ?? 'that creature';
  return 'its centre';
}

/** Resolve an area and draw it on the map (a turn-scoped effect, or a lasting one with optional terrain). */
export function addAreaEffect(
  state: CombatState,
  hero: Character | null,
  spec: AreaSpec,
  opts: { label: string; lasting: boolean; terrain?: AreaTerrain[]; rangeFt?: number },
): { ok: true; state: CombatState; effect: MapEffect; result: AreaResult } | { ok: false; problem: string } {
  const map = state.map;
  if (!map) return { ok: false, problem: 'This fight has no battle map.' };
  const label = cleanText(opts.label, MAP_LIMITS.maxLabel) ?? 'Area';
  const result = resolveArea(state, hero, spec, { rangeFt: opts.rangeFt });
  if ('problem' in result) return { ok: false, problem: `${label}: ${result.problem}` };
  if (opts.rangeFt !== undefined && result.origin.withinRange === false) {
    const from = state.combatants.find((c) => c.id === spec.fromId)?.name ?? 'its caster';
    return { ok: false, problem: `${label}: ${centreName(state, spec)} is ${result.origin.distanceFt} ft from ${from}, beyond its ${opts.rangeFt}-ft range.` };
  }
  const pruned = pruneMap(state, map);
  let effects = pruned.effects;
  if (opts.lasting) {
    if (effects.filter((e) => e.duration === 'lasting').length >= MAP_LIMITS.maxEffects) {
      return { ok: false, problem: `${label}: the map already shows ${MAP_LIMITS.maxEffects} lasting effects; end one with update_map effects_end first.` };
    }
  }
  while (effects.length >= MAP_LIMITS.maxEffects) {
    const oldestTurn = effects.findIndex((e) => e.duration === 'turn');
    if (oldestTurn < 0) break;
    effects = effects.filter((_, i) => i !== oldestTurn);
  }
  const terrain = opts.lasting ? AREA_TERRAIN.filter((t) => (opts.terrain ?? []).includes(t)) : [];
  const effect: MapEffect = {
    id: `e${pruned.nextId}`,
    label,
    spec,
    rects: result.squares,
    terrain,
    duration: opts.lasting ? 'lasting' : 'turn',
    round: state.round,
    turnOfId: currentCombatant(state)?.id ?? '',
  };
  const nextMap: BattleMap = { ...pruned, effects: [...effects, effect], nextId: pruned.nextId + 1, rev: pruned.rev + 1 };
  return { ok: true, state: { ...state, map: nextMap }, effect, result };
}

// ---------------------------------------------------------------------------
// Turns, re-fits and what the DM was told
// ---------------------------------------------------------------------------

export interface TurnStartReport {
  currentId: string | null;
  position: GridPoint | null;
  elevationFt: number;
  budget: TurnBudget | null;
  /** Hazards and lasting effects its space overlaps as its turn starts. */
  startsInside: string[];
  /** The creature whose turn just ended, and what it ended inside. */
  previous: { id: string; endedInside: string[] } | null;
  /** Turn-scoped effects that just expired. */
  expired: string[];
}

/** Hazard and lasting-effect labels on a creature's space. */
function insideOf(state: CombatState, hero: Character | null, c: Combatant | undefined): string[] {
  const cells = mapCells(state, hero);
  if (!cells || !c?.position || c.defeated) return [];
  const rect = footprint(c.position, combatantSize(c, hero));
  const out: string[] = [];
  for (let y = rect.y0; y <= rect.y1; y++) {
    for (let x = rect.x0; x <= rect.x1; x++) {
      for (const label of cells.hazardsAt.get(y * cells.width + x) ?? []) if (!out.includes(label)) out.push(label);
    }
  }
  return out;
}

/** Null when (round, current id) didn't change. Pure: it reads, the handler renders. */
export function turnStartReport(before: CombatState, after: CombatState, hero: Character | null): TurnStartReport | null {
  const was = currentCombatant(before);
  const now = currentCombatant(after);
  if (before.round === after.round && was?.id === now?.id) return null;
  const expired = (before.map?.effects ?? [])
    .filter((e) => e.duration === 'turn' && isCurrentTurn(before, e.round, e.turnOfId) && !isCurrentTurn(after, e.round, e.turnOfId))
    .map((e) => e.label);
  const prevNow = was ? after.combatants.find((c) => c.id === was.id) : undefined;
  return {
    currentId: now?.id ?? null,
    position: now?.position ? { x: now.position.x, y: now.position.y } : null,
    elevationFt: now?.elevationFt ?? 0,
    budget: now && after.map ? turnBudget(after, hero, now.id) : null,
    startsInside: insideOf(after, hero, now ?? undefined),
    previous: was ? { id: was.id, endedInside: prevNow ? insideOf(after, hero, prevNow) : insideOf(before, hero, was) } : null,
    expired,
  };
}

/**
 * Where `c` can't stay after a re-fit: off the map, in a wall, or sharing a space. A creature whose size just changed
 * (`resized`) moves out of any space it now shares, whatever the other creature's size (D39; shared as mapWarnings
 * counts it: the 5-ft levels meet, and Tiny creatures may share); anyone else only from over a smaller creature (the
 * one that grew moves).
 */
function misfit(state: CombatState, hero: Character | null, cells: MapCells, c: Combatant, anchor: GridPoint, resized: boolean): boolean {
  const size = combatantSize(c, hero);
  const rect = footprint(anchor, size);
  if (!rectInBounds(rect, cells)) return true;
  for (let y = rect.y0; y <= rect.y1; y++) for (let x = rect.x0; x <= rect.x1; x++) if (flagAt(cells, x, y) & CELL.BLOCKS_MOVE) return true;
  const n = sizeSquares(size);
  const me = { elevationFt: c.elevationFt ?? 0, size };
  for (const o of state.combatants) {
    if (o.id === c.id || o.defeated || !o.position) continue;
    const oSize = combatantSize(o, hero);
    if (!rectsOverlap(footprint(o.position, oSize), rect)) continue;
    const shares = !(size === 'Tiny' && oSize === 'Tiny') && levelsOverlap(me, { elevationFt: o.elevationFt ?? 0, size: oSize });
    if (resized ? shares : sizeSquares(oSize) < n) return true;
  }
  return false;
}

/** A free anchor for a re-fit: in bounds, no BLOCKS_MOVE, PIT, DEEP or HAZARD, and nobody else's space. */
function refitFree(state: CombatState, hero: Character | null, cells: MapCells, c: Combatant, anchor: GridPoint): boolean {
  const size = combatantSize(c, hero);
  const rect = footprint(anchor, size);
  if (!rectInBounds(rect, cells)) return false;
  for (let y = rect.y0; y <= rect.y1; y++) for (let x = rect.x0; x <= rect.x1; x++) if (flagAt(cells, x, y) & PLACE_BLOCKERS) return false;
  for (const o of state.combatants) {
    if (o.id === c.id || o.defeated || !o.position) continue;
    if (rectsOverlap(footprint(o.position, combatantSize(o, hero)), rect)) return false;
  }
  return true;
}

/**
 * After a size change: shift every footprint that no longer fits to the nearest legal anchor (D39). The hero's size is
 * read live from the sheet, so this is the re-fit after the hero's size changed (update_character,
 * transform_character): the hero moves out of any space it now shares, even a creature of its own size or larger.
 */
export function refitFootprints(
  state: CombatState,
  hero: Character | null,
): { state: CombatState; moved: { id: string; from: GridPoint; to: GridPoint }[]; unplaced: string[] } {
  return refitSome(state, hero, null);
}

/**
 * refitFootprints for `only` these creatures, whose size just changed (null: everyone, the hero counting as the one
 * that changed), in initiative order.
 */
function refitSome(
  state: CombatState,
  hero: Character | null,
  only: ReadonlySet<string> | null,
): { state: CombatState; moved: { id: string; from: GridPoint; to: GridPoint }[]; unplaced: string[] } {
  const cells = mapCells(state, hero);
  if (!cells) return { state, moved: [], unplaced: [] };
  let working = state;
  const moved: { id: string; from: GridPoint; to: GridPoint }[] = [];
  const unplaced: string[] = [];
  for (const original of state.combatants) {
    if (only && !only.has(original.id)) continue;
    const c = working.combatants.find((x) => x.id === original.id) as Combatant;
    const resized = only ? only.has(c.id) : c.isPlayer;
    if (c.defeated || !c.position || !misfit(working, hero, cells, c, c.position, resized)) continue;
    const from = c.position;
    let to: GridPoint | null = null;
    const n = sizeSquares(combatantSize(c, hero));
    // Shrink the anchor back onto the map first, then search outward from there.
    const seed = { x: Math.min(from.x, cells.width - n), y: Math.min(from.y, cells.height - n) };
    for (const p of ringOrder({ x: Math.max(0, seed.x), y: Math.max(0, seed.y) }, cells, n)) {
      if (refitFree(working, hero, cells, c, p)) {
        to = p;
        break;
      }
    }
    if (to) {
      working = withPosition(working, c.id, to, undefined);
      moved.push({ id: c.id, from: { x: from.x, y: from.y }, to });
    } else {
      working = patchCombatant(working, c.id, (x) => withoutKeys(x, ['position']));
      unplaced.push(c.id);
    }
  }
  return { state: working, moved, unplaced };
}

/** A player move or stop counts as seen by the DM. */
export function isToldAndAnswered(item: { toldSeq?: number }, isAnswered: (seq: number) => boolean): boolean {
  return typeof item.toldSeq === 'number' && isAnswered(item.toldSeq);
}

/** Stamp every unseen player move and an unseen player stop with `seq` (D48). Returns `state` itself when nothing changes. */
export function stampMapTold(state: CombatState, seq: number, isAnswered: (seq: number) => boolean): CombatState {
  const map = state.map;
  if (!map) return state;
  const stamp = <T extends { toldSeq?: number }>(item: T): T =>
    isToldAndAnswered(item, isAnswered) || item.toldSeq === seq ? item : { ...item, toldSeq: seq };
  let turn: MapTurn | undefined = map.turn;
  if (turn && isCurrentTurn(state, turn.round, turn.combatantId)) {
    const moves = turn.moves.map((m) => (m.by === 'player' ? stamp(m) : m));
    if (moves.some((m, i) => m !== turn?.moves[i])) turn = { ...turn, moves };
  }
  let stop: MapStop | undefined = map.stop;
  if (stop && stop.by === 'player' && stopIsValid(state, stop)) stop = stamp(stop);
  if (turn === map.turn && stop === map.stop) return state;
  return { ...state, map: { ...map, ...(turn ? { turn } : {}), ...(stop ? { stop } : {}) } };
}

// ---------------------------------------------------------------------------
// The player's view and lookups
// ---------------------------------------------------------------------------

/** D42: the creature the player sees as current, and whether finding it wrapped back past the top of the order. */
function shownTurnIndex(state: CombatState): { index: number; wrapped: boolean } {
  const n = state.combatants.length;
  if (n === 0) return { index: 0, wrapped: false };
  const start = Math.min(Math.max(0, state.turnIndex), n - 1);
  for (let step = 0; step < n; step++) {
    const i = (start - step + n) % n;
    if (!state.combatants[i].hidden) return { index: i, wrapped: i > start };
  }
  return { index: start, wrapped: false };
}

/** D42: the index the player sees as "current": the current creature, or the last visible one before it in order. */
export function playerTurnIndex(state: CombatState): number {
  return shownTurnIndex(state).index;
}

/**
 * The round the player sees: when the last visible creature before a hidden current creature acted in the previous
 * round (the order wrapped), the view stays in that round, so "Round N" doesn't tick over before anyone visible acts.
 * Never below 1 (a hidden creature first in round 1).
 */
function shownRound(state: CombatState, wrapped: boolean): number {
  return wrapped ? Math.max(1, state.round - 1) : state.round;
}

/** During a hidden creature's turn: the turn the player view shows in its place (D42); null otherwise. */
function hiddenTurnShown(state: CombatState): { id: string; round: number } | null {
  if (!currentCombatant(state)?.hidden) return null;
  const { index, wrapped } = shownTurnIndex(state);
  const shown = state.combatants[index];
  return shown && !shown.hidden ? { id: shown.id, round: shownRound(state, wrapped) } : null;
}

const viewMemo = new WeakMap<CombatState, CombatState>();

/** What the player sees for an effect label that names a hidden creature: what an unlabelled area is called. */
const NEUTRAL_EFFECT_LABEL = 'Area';

/** Lower-case words of a name or a label ("Cutthroat's smoke" → cutthroat, s, smoke). */
function nameWords(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Does the word list `label` contain `phrase` as a run of whole words (its last word also as a plural)? */
function containsPhrase(label: readonly string[], phrase: readonly string[]): boolean {
  const last = phrase.length - 1;
  const same = (word: string, w: string, j: number) => word === w || (j === last && (word === `${w}s` || word === `${w}es`));
  for (let i = 0; i + phrase.length <= label.length; i++) if (phrase.every((w, j) => same(label[i + j], w, j))) return true;
  return false;
}

/**
 * The words that single out a hidden creature in DM text: its name, its name without the number duplicates get
 * ("Goblin 2" → "Goblin") and its stat block name — except words a visible creature also answers to (they say
 * nothing the player doesn't know).
 */
function hiddenNamePhrases(state: CombatState): string[][] {
  const phrasesOf = (c: Combatant) => [c.name, c.name.replace(/\s+\d+$/, ''), c.statBlockName ?? ''].map(nameWords).filter((w) => w.length > 0);
  const visible = new Set(state.combatants.filter((c) => !c.hidden).flatMap(phrasesOf).map((w) => w.join(' ')));
  const out = new Map<string, string[]>();
  for (const c of state.combatants) {
    if (!c.hidden) continue;
    for (const words of phrasesOf(c)) if (!visible.has(words.join(' '))) out.set(words.join(' '), words);
  }
  return [...out.values()];
}

function shownLabel(label: string, phrases: readonly string[][]): string {
  if (phrases.length === 0) return label;
  const words = nameWords(label);
  return phrases.some((p) => containsPhrase(words, p)) ? NEUTRAL_EFFECT_LABEL : label;
}

/**
 * The label the player may see for an effect (the DM's free text): "Area" when it names a hidden creature, else the
 * label itself. playerView applies it to every effect and entered-area label; for player text built elsewhere.
 */
export function playerEffectLabel(state: CombatState, label: string): string {
  return shownLabel(label, hiddenNamePhrases(state));
}

function viewTurn(turn: MapTurn, hiddenIds: ReadonlySet<string>, phrases: readonly string[][]): MapTurn | undefined {
  if (hiddenIds.has(turn.combatantId)) return undefined;
  let changed = false;
  const moves = turn.moves.map((m): TurnMove => {
    const provoked = m.provoked.filter((p) => !p.hidden && !hiddenIds.has(p.reactorId));
    const entered = m.entered.map((label) => shownLabel(label, phrases));
    const relabelled = entered.some((label, i) => label !== m.entered[i]);
    if (provoked.length === m.provoked.length && m.blockedById === undefined && !relabelled) return m;
    changed = true;
    const { blockedById: _dmOnly, ...shown } = m;
    return { ...shown, provoked, entered: relabelled ? entered : m.entered };
  });
  return changed ? { ...turn, moves } : turn;
}

/** K5: effects whose label names a hidden creature get a neutral label; the same array when none does. */
function viewEffects(effects: MapEffect[], phrases: readonly string[][]): MapEffect[] {
  if (phrases.length === 0) return effects;
  let changed = false;
  const out = effects.map((e) => {
    const label = shownLabel(e.label, phrases);
    if (label === e.label) return e;
    changed = true;
    return { ...e, label };
  });
  return changed ? out : effects;
}

function viewStop(stop: MapStop, hiddenIds: ReadonlySet<string>): MapStop | undefined {
  if (hiddenIds.has(stop.moverId)) return undefined;
  const reactorIds = stop.reactorIds.filter((id) => !hiddenIds.has(id));
  const declinedIds = stop.declinedIds.filter((id) => !hiddenIds.has(id));
  if (reactorIds.length === stop.reactorIds.length && declinedIds.length === stop.declinedIds.length) return stop;
  if (reactorIds.length === 0) return undefined;
  return { ...stop, reactorIds, declinedIds };
}

/**
 * The player's world (D63): hidden combatants removed; `turn`/`stop` records rewritten to drop hidden reactors and
 * hidden-only notes; turnIndex moved to playerTurnIndex, and the round to the one that creature's turn belongs to
 * (the previous round when the order wrapped to find it). Memoized on the state object. A turn record or stop that
 * belongs to a hidden creature is dropped whole; effects stay, but an effect label (or an entered-area label) that
 * names a hidden creature reads "Area" (playerEffectLabel). Returns `state` itself when nothing is hidden.
 */
export function playerView(state: CombatState): CombatState {
  const memo = viewMemo.get(state);
  if (memo) return memo;
  const hiddenIds = new Set(state.combatants.filter((c) => c.hidden).map((c) => c.id));
  const { index: shownIndex, wrapped } = shownTurnIndex(state);
  const shownId = state.combatants[shownIndex]?.id;
  const round = shownRound(state, wrapped);
  const combatants = hiddenIds.size ? state.combatants.filter((c) => !c.hidden) : state.combatants;
  const turnIndex = hiddenIds.size ? Math.max(0, combatants.findIndex((c) => c.id === shownId)) : state.turnIndex;
  let map = state.map;
  if (map) {
    const phrases = hiddenIds.size ? hiddenNamePhrases(state) : [];
    const turn = map.turn ? viewTurn(map.turn, hiddenIds, phrases) : undefined;
    const stop = map.stop ? viewStop(map.stop, hiddenIds) : undefined;
    const effects = viewEffects(map.effects, phrases);
    if (turn !== map.turn || stop !== map.stop || effects !== map.effects) {
      let next: BattleMap = { ...withoutKeys(map, ['turn', 'stop']), effects };
      if (turn) next = { ...next, turn };
      if (stop) next = { ...next, stop };
      map = next;
    }
  }
  const same = combatants === state.combatants && map === state.map && turnIndex === state.turnIndex && round === state.round;
  const view = same ? state : { ...state, round, combatants, turnIndex, ...(map ? { map } : {}) };
  viewMemo.set(state, view);
  return view;
}

const HERO_WORDS = new Set(['hero', 'the hero', 'you']);

/** findCombatant rules (id, exact name, unique partial name) plus "hero" / "the hero" / "you". */
export function findMapCombatant(state: CombatState, who: string): Combatant | undefined {
  const key = (typeof who === 'string' ? who : '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!key) return undefined;
  if (HERO_WORDS.has(key)) return heroOf(state);
  return findCombatant(state, who);
}

function placeKey(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLowerCase().replace(/^the /, '');
}

/** Case-insensitive, with or without a leading "the" (a place id also matches). */
export function findPlace(map: BattleMap, name: string): MapPlace | undefined {
  if (typeof name !== 'string' || !name.trim()) return undefined;
  const key = placeKey(name);
  return map.places.find((p) => placeKey(p.name) === key) ?? map.places.find((p) => p.id === name.trim());
}

// ---------------------------------------------------------------------------
// Snapshot, warnings and the glyph drawing
// ---------------------------------------------------------------------------

export interface SnapshotToken {
  id: string;
  name: string;
  side: CombatSide;
  isHero: boolean;
  hidden: boolean;
  defeated: boolean;
  space: GridRect | null;
  size: CreatureSize;
  elevationFt: number;
  places: string[];
  distanceFromHeroFt: number | null;
  /** Its cover against the hero's attacks, and the hero's cover against its attacks. */
  coverFromHero: CoverResult | null;
  heroCoverFromIt: CoverResult | null;
  heroCanSee: boolean;
  reachFt: number;
  reactionUsed: boolean;
  prone: boolean;
  /** The hero only: non-Incapacitated enemies within 5 ft that can see the hero (the hero's ranged attacks have Disadvantage). */
  enemiesWithin5?: string[];
}

export interface ReachPair {
  aId: string;
  bId: string;
  aReachesB: boolean;
  bReachesA: boolean;
  distanceFt: number;
}

export type MapWarning =
  | { kind: 'unplaced'; id: string }
  /** SRD: Prone unless Tiny or larger — the DM applies it. */
  | { kind: 'shared-space'; ids: [string, string] }
  | { kind: 'airborne-walker'; id: string; elevationFt: number }
  | { kind: 'must-fall'; id: string; elevationFt: number; dice: string | null }
  | { kind: 'does-not-fit'; id: string }
  | { kind: 'orphan-effect'; label: string };

export interface MapSnapshot {
  mapId: string;
  name?: string;
  width: number;
  height: number;
  /** Initiative order; perspective 'player' omits hidden creatures. */
  tokens: SnapshotToken[];
  unplacedIds: string[];
  /** Hostile pairs where at least one reaches the other (D7). */
  reach: ReachPair[];
  effects: {
    id: string;
    label: string;
    rects: GridRect[];
    terrain: AreaTerrain[];
    duration: 'turn' | 'lasting';
    emanationOfId?: string;
    sizeFt?: number;
  }[];
  /** The current creature (perspective 'player': as playerTurnIndex shows it). */
  current: { id: string; budget: TurnBudget | null; moves: TurnMove[] } | null;
  stop: MapStop | null;
  warnings: MapWarning[];
}

function placesOf(cells: MapCells, rect: GridRect): string[] {
  const out: string[] = [];
  for (let y = rect.y0; y <= rect.y1; y++) {
    for (let x = rect.x0; x <= rect.x1; x++) {
      if (x < 0 || y < 0 || x >= cells.width || y >= cells.height) continue;
      for (const name of cells.placesAt.get(y * cells.width + x) ?? []) if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** Can `who` see the hero for close-combat Disadvantage: line of sight, not Blinded, the hero not Invisible. */
function seesHero(state: CombatState, hero: Character | null, who: MoverStats, heroStats: MoverStats): boolean {
  return !who.blinded && !heroStats.invisible && lineOfSight(state, hero, who.id, heroStats.id);
}

/**
 * Make `obj[key]` a value computed on its first read and kept. The property stays enumerable, so copies, JSON and
 * equality checks see the value; assigning to it replaces it with a plain value.
 */
function defineLazy<T extends object, K extends keyof T>(obj: T, key: K, compute: () => T[K]): void {
  let cached: { value: T[K] } | null = null;
  Object.defineProperty(obj, key, {
    enumerable: true,
    configurable: true,
    get: () => (cached ??= { value: compute() }).value,
    set: (value: T[K]) => Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true }),
  });
}

function tokenOf(state: CombatState, hero: Character | null, cells: MapCells, c: Combatant, heroC: Combatant | undefined): SnapshotToken {
  const stats = moverStats(state, hero, c.id) as MoverStats;
  const space = spaceOf(c, hero);
  const heroSpace = heroC ? spaceOf(heroC, hero) : null;
  const both = !!space && !!heroSpace && !!heroC && heroC.id !== c.id;
  const live = both && !c.defeated && !heroC.defeated;
  const token: SnapshotToken = {
    id: c.id,
    name: c.name,
    side: c.side,
    isHero: c.isPlayer,
    hidden: c.hidden === true,
    defeated: c.defeated,
    space: space?.rect ?? null,
    size: stats.size,
    elevationFt: c.elevationFt ?? 0,
    places: space ? placesOf(cells, space.rect) : [],
    distanceFromHeroFt: both ? spaceDistanceFt(heroSpace, space) : null,
    coverFromHero: null,
    heroCoverFromIt: null,
    heroCanSee: c.isPlayer ? true : both ? lineOfSight(state, hero, heroC.id, c.id) : false,
    reachFt: stats.reachFt,
    reactionUsed: c.reactionUsed === true,
    prone: stats.prone,
  };
  // Cover both ways for every creature is most of a snapshot's cost on a big map, and few readers need it (a token's
  // card, the positions list): it is worked out when first read (K2). The values are the same either way.
  if (live) {
    defineLazy(token, 'coverFromHero', () => coverAgainst(state, hero, heroC.id, c.id));
    defineLazy(token, 'heroCoverFromIt', () => coverAgainst(state, hero, c.id, heroC.id));
  }
  if (c.isPlayer && space) {
    const enemies: string[] = [];
    for (const o of state.combatants) {
      if (o.defeated || !o.position || !areHostile(teamOf(c.side), teamOf(o.side))) continue;
      const oSpace = spaceOf(o, hero);
      if (!oSpace || spaceDistanceFt(space, oSpace) > 5) continue;
      const oStats = moverStats(state, hero, o.id) as MoverStats;
      if (oStats.incapacitated || !seesHero(state, hero, oStats, stats)) continue;
      enemies.push(o.id);
    }
    token.enemiesWithin5 = enemies;
  }
  return token;
}

function reachPairs(state: CombatState, hero: Character | null): ReachPair[] {
  const placed = state.combatants.filter((c) => c.position && !c.defeated);
  const pairs: ReachPair[] = [];
  // Each pair is (foe, party member), in the foe's initiative order, then the party member's.
  for (const a of placed) {
    if (teamOf(a.side) !== 'foes') continue;
    for (const b of placed) {
      if (!areHostile(teamOf(a.side), teamOf(b.side))) continue;
      const aReachesB = inReach(state, hero, a.id, b.id);
      const bReachesA = inReach(state, hero, b.id, a.id);
      if (!aReachesB && !bReachesA) continue;
      const sa = spaceOf(a, hero) as Space;
      const sb = spaceOf(b, hero) as Space;
      pairs.push({ aId: a.id, bId: b.id, aReachesB, bReachesA, distanceFt: spaceDistanceFt(sa, sb) });
    }
  }
  return pairs;
}

function visibleEffects(state: CombatState, hero: Character | null): MapSnapshot['effects'] {
  const map = state.map as BattleMap;
  return map.effects
    .filter((e) => e.duration === 'lasting' || isCurrentTurn(state, e.round, e.turnOfId))
    .map((e) => {
      const emanationOf = e.spec.shape === 'emanation' && e.spec.fromId && state.combatants.some((c) => c.id === e.spec.fromId) ? e.spec.fromId : undefined;
      return {
        id: e.id,
        label: e.label,
        rects: effectSquares(state, hero, e),
        terrain: [...e.terrain],
        duration: e.duration,
        ...(emanationOf ? { emanationOfId: emanationOf } : {}),
        ...(typeof e.spec.sizeFt === 'number' ? { sizeFt: e.spec.sizeFt } : {}),
      };
    });
}

/** Null without a map. */
export function mapSnapshot(state: CombatState, hero: Character | null, opts: { perspective: 'dm' | 'player' }): MapSnapshot | null {
  if (!state.map) return null;
  const view = opts.perspective === 'player' ? playerView(state) : state;
  const map = view.map as BattleMap;
  const cells = mapCells(view, hero) as MapCells;
  const heroC = heroOf(view);
  const current = currentCombatant(view);
  const turn = currentTurn(view);
  const stop = map.stop && stopIsValid(view, map.stop) ? map.stop : null;
  return {
    mapId: map.id,
    ...(map.name ? { name: map.name } : {}),
    width: map.width,
    height: map.height,
    tokens: view.combatants.map((c) => tokenOf(view, hero, cells, c, heroC)),
    unplacedIds: view.combatants.filter((c) => !c.defeated && !c.position).map((c) => c.id),
    reach: reachPairs(view, hero),
    effects: visibleEffects(view, hero),
    current: current ? { id: current.id, budget: turnBudget(view, hero, current.id), moves: turn?.moves ?? [] } : null,
    stop,
    warnings: mapWarnings(view, hero),
  };
}

type Body = Pick<Occupant, 'elevationFt' | 'size'>;

/** Do two creatures' 5-ft levels meet (C3)? A flier above another creature doesn't share its space. */
function levelsOverlap(a: Body, b: Body): boolean {
  const lo = (o: Body) => Math.floor(o.elevationFt / 5);
  const hi = (o: Body) => lo(o) + sizeSquares(o.size) - 1;
  return lo(a) <= hi(b) && lo(b) <= hi(a);
}

/** A Fly Speed the creature has before conditions (the sheet's, granted ones, or its stat block's). */
function naturalFly(c: Combatant, hero: Character | null): number {
  const own = c.isPlayer && hero ? toInt(hero.otherSpeeds?.fly) : 0;
  return Math.max(own, toInt(c.speeds?.fly));
}

/** Falling damage dice (srd:rule:falling; C26): 1d6 per 10 ft, at most 20d6; null under 10 ft. */
function fallDice(ft: number): string | null {
  const n = Math.min(20, Math.floor(ft / 10));
  return n >= 1 ? `${n}d6` : null;
}

export function mapWarnings(state: CombatState, hero: Character | null): MapWarning[] {
  const map = state.map;
  if (!map) return [];
  const cells = mapCells(state, hero) as MapCells;
  const out: MapWarning[] = [];
  for (const c of state.combatants) if (!c.defeated && !c.position) out.push({ kind: 'unplaced', id: c.id });
  const placed = occupants(state, hero);
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      if (a.size === 'Tiny' && b.size === 'Tiny') continue;
      if (rectsOverlap(a.rect, b.rect) && levelsOverlap(a, b)) out.push({ kind: 'shared-space', ids: [a.id, b.id] });
    }
  }
  for (const o of placed) {
    const c = state.combatants.find((x) => x.id === o.id) as Combatant;
    const stats = moverStats(state, hero, o.id) as MoverStats;
    if (o.elevationFt > 0) {
      const flier = stats.fly > 0 || naturalFly(c, hero) > 0;
      if (!flier) out.push({ kind: 'airborne-walker', id: o.id, elevationFt: o.elevationFt });
      // srd:rule:flying: a flier falls when Incapacitated, Prone or its Fly Speed is 0, unless it can hover.
      else if (!stats.hover && (stats.prone || stats.incapacitated || stats.fly === 0)) {
        out.push({ kind: 'must-fall', id: o.id, elevationFt: o.elevationFt, dice: fallDice(o.elevationFt) });
      }
    }
    let fits = rectInBounds(o.rect, cells);
    if (fits) for (let y = o.rect.y0; y <= o.rect.y1 && fits; y++) for (let x = o.rect.x0; x <= o.rect.x1; x++) if (flagAt(cells, x, y) & CELL.BLOCKS_MOVE) fits = false;
    if (!fits) out.push({ kind: 'does-not-fit', id: o.id });
  }
  for (const e of map.effects) {
    if (e.duration !== 'lasting' || e.spec.shape !== 'emanation') continue;
    const c = state.combatants.find((x) => x.id === e.spec.fromId);
    if (!c?.position) out.push({ kind: 'orphan-effect', label: e.label });
  }
  return out;
}

/** Terrain glyphs, strongest first (the §4.5 Key). */
const TERRAIN_GLYPHS: readonly { flags: number; glyph: string }[] = [
  { flags: CELL.DOOR | CELL.DOOR_CLOSED, glyph: '+' },
  { flags: CELL.DOOR, glyph: '/' },
  { flags: CELL.BLOCKS_MOVE | CELL.BLOCKS_SIGHT, glyph: '#' },
  { flags: CELL.BLOCKS_MOVE, glyph: ']' },
  { flags: CELL.PIT, glyph: '_' },
  { flags: CELL.HAZARD, glyph: '!' },
  { flags: CELL.DEEP, glyph: '~' },
  { flags: CELL.SHALLOW, glyph: ',' },
  { flags: CELL.DIFFICULT, glyph: ':' },
  { flags: CELL.OBSCURED, glyph: '%' },
];

function terrainGlyph(cells: MapCells, x: number, y: number): string {
  const f = flagAt(cells, x, y);
  // Half cover is difficult terrain with cover 1.
  if (cells.cover[y * cells.width + x] === 1 && !(f & (CELL.BLOCKS_MOVE | CELL.PIT | CELL.HAZARD | CELL.DEEP))) return ')';
  for (const g of TERRAIN_GLYPHS) if ((f & g.flags) === g.flags) return g.glyph;
  return '.';
}

const TOKEN_GLYPHS = '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Terrain and tokens as text glyphs (DM only): rows[y] is a string of width chars. */
export function mapGlyphGrid(state: CombatState, hero: Character | null): { rows: string[]; legend: { glyph: string; id: string }[] } {
  const cells = mapCells(state, hero);
  if (!cells) return { rows: [], legend: [] };
  const grid: string[][] = [];
  for (let y = 0; y < cells.height; y++) {
    const row: string[] = [];
    for (let x = 0; x < cells.width; x++) row.push(terrainGlyph(cells, x, y));
    grid.push(row);
  }
  const legend: { glyph: string; id: string }[] = [];
  let n = 0;
  const drawn = new Set<string>();
  for (const o of occupants(state, hero)) {
    const c = state.combatants.find((x) => x.id === o.id) as Combatant;
    const glyph = c.isPlayer ? '@' : (TOKEN_GLYPHS[n++] ?? '*');
    legend.push({ glyph, id: o.id });
    for (let y = o.rect.y0; y <= o.rect.y1; y++) {
      for (let x = o.rect.x0; x <= o.rect.x1; x++) {
        if (y < 0 || x < 0 || y >= cells.height || x >= cells.width) continue;
        const key = `${x},${y}`;
        if (drawn.has(key)) continue;
        drawn.add(key);
        grid[y][x] = glyph;
      }
    }
  }
  return { rows: grid.map((r) => r.join('')), legend };
}
