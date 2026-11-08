/**
 * The single source of truth for reading battle-map data that came from outside memory: backup imports
 * (backup.ts `.transform`) and IndexedDB loads. Lenient and pure: it never throws, drops what it can't
 * read and keeps the combat (an unreadable map is dropped and the fight continues in the theater of the mind).
 *
 * Everything stays plain JSON (spec §2.1): integers, strings, booleans, arrays and plain objects. Fields this
 * version doesn't know pass through untouched (like the rest of a save file); the fields it knows are checked and
 * coerced, or left out when they can't be read. Valid data comes back deep-equal, so normalizing twice changes
 * nothing.
 */
import {
  AREA_SHAPES,
  AREA_TERRAIN,
  COMPASS_DIRECTIONS,
  CREATURE_SIZES,
  MAP_LIMITS,
  MOVE_KINDS,
  TERRAIN_KINDS,
  type ActiveCondition,
  type AreaSpec,
  type AreaTerrain,
  type BattleMap,
  type Combatant,
  type CombatState,
  type CreatureSpeeds,
  type DoorState,
  type GridPoint,
  type GridRect,
  type MapEffect,
  type MapPlace,
  type MapRef,
  type MapStop,
  type MapTurn,
  type TerrainFeature,
  type TurnMove,
} from '@/types';
import { clamp, toInt } from './util';

type Raw = Record<string, unknown>;

interface Dims {
  width: number;
  height: number;
}

/** Feet limits per combatant field (spec §6.4). */
const REACH_FT = { min: 5, max: 60 } as const;
const SPEED_CHANGE_FT = { min: -120, max: 120 } as const;
/** Area sizes, widths and heights: multiples of 5 in 5–500 ft (spec §2.1 AreaSpec). */
const AREA_FT = { min: 5, max: 500 } as const;
/** An area's stored squares are merged rects; a map has at most this many squares. */
const MAX_AREA_RECTS = MAP_LIMITS.maxSize * MAP_LIMITS.maxSize;
const SPEED_KEYS = ['walk', 'fly', 'swim', 'climb', 'burrow'] as const;
const DOOR_STATES: readonly DoorState[] = ['open', 'closed', 'locked'];

// ---------------------------------------------------------------------------
// Readers for small pieces
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** Trimmed text of at most `max` characters, or undefined for anything else (or nothing left). */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim().slice(0, max).trim();
  return t || undefined;
}

/** A finite number as a multiple of 5 within [min, max], or undefined. */
function feet(value: unknown, min: number, max: number): number | undefined {
  return isFiniteNumber(value) ? clamp(Math.round(value / 5) * 5, min, max) : undefined;
}

function elevation(value: unknown): number | undefined {
  return feet(value, 0, MAP_LIMITS.maxElevationFt);
}

/** A non-negative integer (movement, costs, counters). */
function count(value: unknown): number {
  return Math.max(0, toInt(value));
}

/** A transcript seq (D48): a positive integer, or undefined. */
function seq(value: unknown): number | undefined {
  return isFiniteNumber(value) && value >= 1 ? Math.trunc(value) : undefined;
}

function point(value: unknown, dims: Dims): GridPoint | undefined {
  if (!isRecord(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return undefined;
  const x = Math.trunc(value.x);
  const y = Math.trunc(value.y);
  return x >= 0 && y >= 0 && x < dims.width && y < dims.height ? { x, y } : undefined;
}

function points(value: unknown, dims: Dims, max: number): GridPoint[] {
  return list(value)
    .flatMap((p) => point(p, dims) ?? [])
    .slice(0, max);
}

/** An inclusive rect with its corners in order, clipped to the map; undefined when nothing of it is on the map. */
function rect(value: unknown, dims: Dims): GridRect | undefined {
  if (!isRecord(value)) return undefined;
  const corners = [value.x0, value.y0, value.x1, value.y1];
  if (!corners.every(isFiniteNumber)) return undefined;
  const [ax, ay, bx, by] = (corners as number[]).map(Math.trunc);
  const x0 = Math.max(0, Math.min(ax, bx));
  const y0 = Math.max(0, Math.min(ay, by));
  const x1 = Math.min(dims.width - 1, Math.max(ax, bx));
  const y1 = Math.min(dims.height - 1, Math.max(ay, by));
  return x0 <= x1 && y0 <= y1 ? { x0, y0, x1, y1 } : undefined;
}

function rects(value: unknown, dims: Dims, max: number): GridRect[] {
  return list(value)
    .flatMap((r) => rect(r, dims) ?? [])
    .slice(0, max);
}

/** Known combatant ids, kept in order and without duplicates. */
function knownIds(value: unknown, known: ReadonlySet<string>): string[] {
  const ids = list(value).filter((id): id is string => typeof id === 'string' && known.has(id));
  return [...new Set(ids)];
}

// ---------------------------------------------------------------------------
// Map-local ids (t1…, p1…, e1… share BattleMap.nextId)
// ---------------------------------------------------------------------------

const MAP_LOCAL_ID = /^(?:[tpe]|map-)(\d+)$/;
/** Far beyond any real map (each edit uses one id); larger numbers in a damaged save don't count. */
const MAX_ID_NUMBER = 1_000_000_000;

/** The number in a map-local id ("t12" → 12, "map-3" → 3), or 0. */
function idNumber(id: string): number {
  const match = MAP_LOCAL_ID.exec(id);
  const n = match ? Number(match[1]) : 0;
  return n <= MAX_ID_NUMBER ? n : 0;
}

/** A map item read from a save, with the id it came with (checked once the item is known to be kept). */
interface Read<T extends { id: string }> {
  item: T;
  rawId: unknown;
}

/**
 * Gives every kept item a unique id: a readable id is kept (the first holder of a duplicate keeps it), the rest get
 * fresh ones from the counter, which ends above every id in use.
 */
class IdRepair {
  private readonly used = new Set<string>();
  private readonly missing: { item: { id: string }; prefix: string }[] = [];
  private highest = 0;

  claimAll<T extends { id: string }>(read: readonly Read<T>[], prefix: string): T[] {
    return read.map(({ item, rawId }) => {
      this.claim(rawId, item, prefix);
      return item;
    });
  }

  claim(raw: unknown, item: { id: string }, prefix: string): void {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (id && !this.used.has(id)) {
      this.used.add(id);
      this.highest = Math.max(this.highest, idNumber(id));
      item.id = id;
    } else {
      this.missing.push({ item, prefix });
    }
  }

  /** Assign the fresh ids; returns the repaired nextId. */
  finish(rawNextId: unknown): number {
    let next = Math.max(1, Math.min(toInt(rawNextId, 1), MAX_ID_NUMBER + 1), this.highest + 1);
    for (const { item, prefix } of this.missing) item.id = `${prefix}${next++}`;
    return next;
  }
}

// ---------------------------------------------------------------------------
// Terrain, places, effects
// ---------------------------------------------------------------------------

function terrainFeature(value: unknown, dims: Dims): Read<TerrainFeature> | undefined {
  if (!isRecord(value) || !oneOf(TERRAIN_KINDS, value.kind)) return undefined;
  const feature: TerrainFeature = { id: '', kind: value.kind, rects: rects(value.rects, dims, MAP_LIMITS.maxRectsPerFeature) };
  if (feature.rects.length === 0) return undefined;
  const label = text(value.label, MAP_LIMITS.maxLabel);
  if (label) feature.label = label;
  if (value.kind === 'door' && oneOf(DOOR_STATES, value.door)) feature.door = value.door;
  return { item: feature, rawId: value.id };
}

function mapPlace(value: unknown, dims: Dims): Read<MapPlace> | undefined {
  if (!isRecord(value)) return undefined;
  const name = text(value.name, MAP_LIMITS.maxLabel);
  const area = rects(value.rects, dims, MAP_LIMITS.maxRectsPerFeature);
  if (!name || area.length === 0) return undefined;
  return { item: { id: '', name, rects: area }, rawId: value.id };
}

/** A map reference; undefined when unreadable, off the map, or naming a creature that isn't in the fight. */
function mapRef(value: unknown, dims: Dims, known: ReadonlySet<string>, allowDirection: boolean): MapRef | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.kind) {
    case 'square': {
      const at = point(value.at, dims);
      return at && { kind: 'square', at };
    }
    case 'corner': {
      if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return undefined;
      const x = Math.trunc(value.x);
      const y = Math.trunc(value.y);
      const inside = x >= 0 && y >= 0 && x <= dims.width && y <= dims.height;
      return inside ? { kind: 'corner', x, y } : undefined;
    }
    case 'creature':
      return typeof value.id === 'string' && known.has(value.id) ? { kind: 'creature', id: value.id } : undefined;
    case 'direction':
      return allowDirection && oneOf(COMPASS_DIRECTIONS, value.dir) ? { kind: 'direction', dir: value.dir } : undefined;
    default:
      return undefined;
  }
}

/**
 * An area's parameters. Undefined (the effect is dropped) when its shape or size can't be read, or when `at`,
 * `fromId` or `toward` is present but unreadable or names a creature that isn't in the fight.
 */
function areaSpec(value: unknown, dims: Dims, known: ReadonlySet<string>): AreaSpec | undefined {
  if (!isRecord(value) || !oneOf(AREA_SHAPES, value.shape)) return undefined;
  const spec: AreaSpec = { shape: value.shape };
  if (value.shape !== 'squares') {
    const size = feet(value.sizeFt, AREA_FT.min, AREA_FT.max);
    if (size === undefined) return undefined;
    spec.sizeFt = size;
  }
  const width = feet(value.widthFt, AREA_FT.min, AREA_FT.max);
  if (width !== undefined) spec.widthFt = width;
  const height = feet(value.heightFt, AREA_FT.min, AREA_FT.max);
  if (height !== undefined) spec.heightFt = height;
  if (value.at !== undefined) {
    const at = mapRef(value.at, dims, known, false);
    if (!at) return undefined;
    spec.at = at;
  }
  if (value.fromId !== undefined) {
    if (typeof value.fromId !== 'string' || !known.has(value.fromId)) return undefined;
    spec.fromId = value.fromId;
  }
  if (value.toward !== undefined) {
    const toward = mapRef(value.toward, dims, known, true);
    if (!toward) return undefined;
    spec.toward = toward;
  }
  if (value.rects !== undefined) spec.rects = rects(value.rects, dims, MAX_AREA_RECTS);
  if (typeof value.includeOrigin === 'boolean') spec.includeOrigin = value.includeOrigin;
  const elevationFt = elevation(value.elevationFt);
  if (elevationFt !== undefined) spec.elevationFt = elevationFt;
  return spec;
}

function mapEffect(value: unknown, dims: Dims, known: ReadonlySet<string>): Read<MapEffect> | undefined {
  if (!isRecord(value)) return undefined;
  const label = text(value.label, MAP_LIMITS.maxLabel);
  const spec = areaSpec(value.spec, dims, known);
  const duration = value.duration === 'turn' || value.duration === 'lasting' ? value.duration : undefined;
  const turnOfId = typeof value.turnOfId === 'string' && known.has(value.turnOfId) ? value.turnOfId : undefined;
  if (!label || !spec || !duration || !turnOfId) return undefined;
  const terrain = [...new Set(list(value.terrain).filter((t): t is AreaTerrain => oneOf(AREA_TERRAIN, t)))];
  const effect: MapEffect = {
    id: '',
    label,
    spec,
    rects: rects(value.rects, dims, MAX_AREA_RECTS),
    terrain: duration === 'lasting' ? terrain : [],
    duration,
    round: Math.max(1, toInt(value.round, 1)),
    turnOfId,
  };
  return { item: effect, rawId: value.id };
}

// ---------------------------------------------------------------------------
// The turn record and the stop
// ---------------------------------------------------------------------------

function provokedAttack(value: unknown, dims: Dims, known: ReadonlySet<string>): TurnMove['provoked'][number] | undefined {
  if (!isRecord(value) || typeof value.reactorId !== 'string' || !known.has(value.reactorId)) return undefined;
  const at = point(value.at, dims);
  return at && { reactorId: value.reactorId, at, hidden: value.hidden === true };
}

function turnMove(value: unknown, dims: Dims, known: ReadonlySet<string>): TurnMove | undefined {
  if (!isRecord(value)) return undefined;
  const by = value.by === 'player' || value.by === 'dm' ? value.by : undefined;
  const kind = oneOf(MOVE_KINDS, value.kind) || value.kind === 'stand' ? value.kind : undefined;
  const from = point(value.from, dims);
  const to = point(value.to, dims);
  if (!by || !kind || !from || !to) return undefined;
  const move: TurnMove = {
    by,
    kind,
    from,
    to,
    path: points(value.path, dims, MAP_LIMITS.maxPathSquares),
    costFt: count(value.costFt),
    provoked: list(value.provoked).flatMap((p) => provokedAttack(p, dims, known) ?? []),
    entered: list(value.entered).flatMap((label) => text(label, MAP_LIMITS.maxLabel) ?? []),
  };
  for (const flag of ['dashed', 'disengaged', 'stoodUp', 'revealedHidden'] as const) {
    const set = value[flag];
    if (typeof set === 'boolean') move[flag] = set;
  }
  const toldSeq = seq(value.toldSeq);
  if (toldSeq !== undefined) move.toldSeq = toldSeq;
  return move;
}

function mapTurn(value: unknown, dims: Dims, known: ReadonlySet<string>): MapTurn | undefined {
  if (!isRecord(value) || typeof value.combatantId !== 'string' || !known.has(value.combatantId)) return undefined;
  return {
    combatantId: value.combatantId,
    round: Math.max(1, toInt(value.round, 1)),
    movedFt: count(value.movedFt),
    dashFt: count(value.dashFt),
    dashes: count(value.dashes),
    disengaged: value.disengaged === true,
    stoodUp: value.stoodUp === true,
    moves: list(value.moves)
      .flatMap((m) => turnMove(m, dims, known) ?? [])
      .slice(0, MAP_LIMITS.maxTurnMoves),
  };
}

function stopOptions(value: unknown): MapStop['opts'] {
  const raw = isRecord(value) ? value : {};
  const opts: MapStop['opts'] = {};
  if (typeof raw.dash === 'boolean') opts.dash = raw.dash;
  if (typeof raw.disengage === 'boolean') opts.disengage = raw.disengage;
  if (raw.prefer === 'safest' || raw.prefer === 'shortest') opts.prefer = raw.prefer;
  if (raw.mode === 'walk' || raw.mode === 'fly') opts.mode = raw.mode;
  return opts;
}

/** A stop naming an unknown mover, or with no known reactor left, is dropped. */
function mapStop(value: unknown, dims: Dims, known: ReadonlySet<string>): MapStop | undefined {
  if (!isRecord(value) || typeof value.moverId !== 'string' || !known.has(value.moverId)) return undefined;
  const by = value.by === 'player' || value.by === 'dm' ? value.by : undefined;
  const at = point(value.at, dims);
  const destination = point(value.destination, dims);
  const reactorIds = knownIds(value.reactorIds, known);
  if (!by || !at || !destination || reactorIds.length === 0) return undefined;
  const stop: MapStop = {
    moverId: value.moverId,
    by,
    round: Math.max(1, toInt(value.round, 1)),
    at,
    destination,
    route: points(value.route, dims, MAP_LIMITS.maxPathSquares),
    reactorIds,
    declinedIds: knownIds(value.declinedIds, known),
    opts: stopOptions(value.opts),
  };
  const triggerAt = point(value.triggerAt, dims);
  if (triggerAt) stop.triggerAt = triggerAt;
  const toldSeq = seq(value.toldSeq);
  if (toldSeq !== undefined) stop.toldSeq = toldSeq;
  return stop;
}

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

/**
 * A valid BattleMap from untrusted data, or undefined for anything without a numeric width and height
 * (null, a string, NaN, an array…). Clamps the size to MAP_LIMITS, coerces numbers with toInt, clips rects
 * to the map, drops unknown kinds, caps arrays (MAP_LIMITS), drops `turn`, `stop` and effects that name combatants
 * not in `combatantIds`, and repairs `nextId` above every id in use. Idempotent.
 */
export function normalizeBattleMap(raw: unknown, combatantIds: readonly string[]): BattleMap | undefined {
  if (!isRecord(raw) || !isFiniteNumber(raw.width) || !isFiniteNumber(raw.height)) return undefined;
  const dims: Dims = {
    width: clamp(Math.trunc(raw.width), MAP_LIMITS.minSize, MAP_LIMITS.maxSize),
    height: clamp(Math.trunc(raw.height), MAP_LIMITS.minSize, MAP_LIMITS.maxSize),
  };
  const known = new Set(combatantIds);
  const ids = new IdRepair();
  const mapId = { id: '' };
  ids.claim(raw.id, mapId, 'map-');
  const terrain = ids.claimAll(
    list(raw.terrain)
      .flatMap((f) => terrainFeature(f, dims) ?? [])
      .slice(0, MAP_LIMITS.maxFeatures),
    't',
  );
  const places = ids.claimAll(
    list(raw.places)
      .flatMap((p) => mapPlace(p, dims) ?? [])
      .slice(0, MAP_LIMITS.maxPlaces),
    'p',
  );
  const effects = ids.claimAll(
    list(raw.effects)
      .flatMap((e) => mapEffect(e, dims, known) ?? [])
      .slice(0, MAP_LIMITS.maxEffects),
    'e',
  );
  const nextId = ids.finish(raw.nextId);
  const name = text(raw.name, MAP_LIMITS.maxMapName);
  const turn = mapTurn(raw.turn, dims, known);
  const stop = mapStop(raw.stop, dims, known);
  return {
    id: mapId.id,
    ...(name && { name }),
    width: dims.width,
    height: dims.height,
    terrain,
    places,
    effects,
    ...(turn && { turn }),
    ...(stop && { stop }),
    nextId,
    rev: count(raw.rev),
  };
}

// ---------------------------------------------------------------------------
// The combat
// ---------------------------------------------------------------------------

function conditions(value: unknown): ActiveCondition[] {
  return list(value).filter((c): c is ActiveCondition => isRecord(c) && typeof c.id === 'string');
}

function speeds(value: unknown): CreatureSpeeds | undefined {
  if (!isRecord(value)) return undefined;
  const out: CreatureSpeeds = {};
  for (const key of SPEED_KEYS) if (isFiniteNumber(value[key])) out[key] = count(value[key]);
  // With no speed in feet, the defaults (walk 30) are better than a creature that can't move at all.
  if (Object.keys(out).length === 0) return undefined;
  if (typeof value.hover === 'boolean') out.hover = value.hover;
  return out;
}

/** The map fields of one combatant (spec §6.4); a position only on a map, inside it. */
function mapFields(raw: Raw, dims: Dims | null): Partial<Combatant> {
  const fields: Partial<Combatant> = {};
  const position = dims ? point(raw.position, dims) : undefined;
  if (position) fields.position = position;
  const elevationFt = elevation(raw.elevationFt);
  if (elevationFt !== undefined) fields.elevationFt = elevationFt;
  if (oneOf(CREATURE_SIZES, raw.size)) fields.size = raw.size;
  const speed = speeds(raw.speeds);
  if (speed) fields.speeds = speed;
  const reachFt = feet(raw.reachFt, REACH_FT.min, REACH_FT.max);
  if (reachFt !== undefined) fields.reachFt = reachFt;
  if (isFiniteNumber(raw.speedChangeFt)) {
    fields.speedChangeFt = clamp(Math.trunc(raw.speedChangeFt), SPEED_CHANGE_FT.min, SPEED_CHANGE_FT.max);
  }
  if (typeof raw.hidden === 'boolean') fields.hidden = raw.hidden;
  if (typeof raw.reactionUsed === 'boolean') fields.reactionUsed = raw.reactionUsed;
  return fields;
}

function combatant(raw: Raw & { id: string }, dims: Dims | null): Combatant {
  const {
    position: _position,
    elevationFt: _elevation,
    size: _size,
    speeds: _speeds,
    reachFt: _reach,
    speedChangeFt: _speedChange,
    hidden: _hidden,
    reactionUsed: _reaction,
    ...rest
  } = raw;
  // The other fields (side, HP, AC, notes…) pass through as before; conditions must be a list (the tracker maps it).
  return {
    ...(rest as unknown as Combatant),
    name: typeof raw.name === 'string' ? raw.name : 'Unnamed',
    conditions: conditions(raw.conditions),
    ...mapFields(raw, dims),
  };
}

function hasId(value: unknown): value is Raw & { id: string } {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0;
}

/**
 * A CombatState from a stored row or an import: copies the known fields; per combatant keeps `position` only as
 * integer {x, y} inside the map, `elevationFt` 0–500 (multiple of 5), `size` in CREATURE_SIZES, `speeds` with
 * non-negative integer fields and a boolean `hover`, `reachFt` 5–60, `speedChangeFt` −120–120, boolean `hidden` /
 * `reactionUsed`, and `conditions` as an array; drops every `position` when the map is missing;
 * `map: normalizeBattleMap(raw.map, ids)`. Never throws. Idempotent.
 */
export function normalizeCombatState(raw: unknown): CombatState {
  if (!isRecord(raw)) return { active: false, round: 1, turnIndex: 0, combatants: [], startedAt: 0 };
  const { active, round, turnIndex, combatants: rawCombatants, startedAt, encounterName, map: rawMap, ...rest } = raw;
  const readable = list(rawCombatants).filter(hasId);
  const map = normalizeBattleMap(rawMap, readable.map((c) => c.id));
  const combatants = readable.map((c) => combatant(c, map ?? null));
  return {
    ...rest,
    active: typeof active === 'boolean' ? active : true,
    round: Math.max(1, toInt(round, 1)),
    turnIndex: clamp(toInt(turnIndex), 0, Math.max(0, combatants.length - 1)),
    combatants,
    ...(typeof encounterName === 'string' && { encounterName }),
    startedAt: isFiniteNumber(startedAt) ? startedAt : 0,
    ...(map && { map }),
  };
}
