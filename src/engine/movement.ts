/**
 * Battle-map movement by the SRD 5.2.1 grid rules: teams, mover stats, the turn record and budget,
 * step rules, path search, Opportunity Attacks and the stop rule, planMove / applyMove for every move
 * kind, applyHeroMove (the player's own move: plan on the player view, replay on the true map) and
 * reachable squares. Pure; results are structured data only (DM text lives in src/dm/mapText.ts,
 * player text in src/ui/play/map/text.ts).
 *
 * Every function that needs the hero takes `hero: Character | null`: the hero's size, speeds, reach and
 * conditions are read live from the sheet.
 *
 * Path search (spec §3.4.5): Dijkstra over (anchor, provocations) — provocations capped at 4 for the safest
 * route, collapsed for the shortest — with priority (feet, diagonals, insertion order), the fixed neighbour
 * order N, E, S, W, NE, SE, SW, NW and labels replaced only when strictly better, so every route is
 * deterministic. Step legality and cost, reach masks, sight and Total Cover are computed lazily per search
 * and memoized; a square-count box test skips the exact segment tests wherever no blocker is near.
 */
import type {
  ActiveCondition,
  BattleMap,
  Character,
  Combatant,
  CombatSide,
  CombatState,
  CompassDirection,
  CreatureSize,
  CreatureSpeeds,
  GridPoint,
  GridRect,
  MapEffect,
  MapPlace,
  MapRef,
  MapStop,
  MapTurn,
  MoveKind,
  MoveMode,
  TerrainFeature,
  TurnMove,
} from '@/types';
import { CREATURE_SIZES, MAP_LIMITS } from '@/types';
import { effectSquares } from './areas';
import { playerView } from './battleMap';
import { currentCombatant, findCombatant } from './combat';
import { conditionKey, conditionName, INCAPACITATING_CONDITIONS, SPEED_ZERO_CONDITIONS } from './conditions';
import { dirVector, footprint, rectsOverlap, sizeSquares, snapDirection } from './grid';
import { CELL, combatantConditions, combatantSize, mapCells, occupants, type MapCells, type Occupant } from './mapCells';
import { speedDetails } from './rules';
import { rectsSeeEachOther, rectsTotalCover } from './sight';
import { toInt } from './util';

const MINUS = '−';
/** Neighbour order N, E, S, W, NE, SE, SW, NW (y grows south). Indices ≥ 4 are diagonals. */
const DX: readonly number[] = [0, 1, 0, -1, 1, 1, -1, -1];
const DY: readonly number[] = [-1, 0, 1, 0, -1, 1, 1, -1];
/** Provocations a safest search tells apart (spec §3.4.5). */
const SAFEST_CAP = 4;
const INF = 0x3fffffff;
const UNKNOWN = -2;
const ILLEGAL = -1;
/** A pit's depth when the map doesn't say (pits have no depth in v1; app convention). */
const PIT_DEPTH_FT = 10;

// ---------------------------------------------------------------------------
// Teams (app convention C6)
// ---------------------------------------------------------------------------

export type MapTeam = 'party' | 'foes' | 'neutral';

/** player/ally → party, enemy → foes, neutral → neutral. */
export function teamOf(side: CombatSide): MapTeam {
  if (side === 'player' || side === 'ally') return 'party';
  if (side === 'enemy') return 'foes';
  return 'neutral';
}

/** Same team, not neutral (C6). */
export function areAllies(a: MapTeam, b: MapTeam): boolean {
  return a === b && a !== 'neutral';
}

/** Party vs foes only. */
export function areHostile(a: MapTeam, b: MapTeam): boolean {
  return (a === 'party' && b === 'foes') || (a === 'foes' && b === 'party');
}

// ---------------------------------------------------------------------------
// Mover stats
// ---------------------------------------------------------------------------

export interface MoverStats {
  id: string;
  name: string;
  isHero: boolean;
  side: CombatSide;
  team: MapTeam;
  size: CreatureSize;
  /** Effective speeds (conditions, Exhaustion, heavy armor, speedChangeFt applied); 0 = can't use it. */
  walk: number;
  fly: number;
  swim: number;
  climb: number;
  burrow: number;
  hover: boolean;
  reachFt: number;
  prone: boolean;
  incapacitated: boolean;
  blinded: boolean;
  invisible: boolean;
  hidden: boolean;
  defeated: boolean;
  /** "Grappled" when a Speed-0 condition applies, else null. */
  speedZero: string | null;
  /** Combatant ids named by Frightened conditions' `source` (findCombatant rules). */
  frightenedOfIds: string[];
  /** "Exhaustion 2: −10 ft", "Haste: +30 ft". */
  notes: string[];
}

const SPEED_KEYS = ['walk', 'fly', 'swim', 'climb', 'burrow'] as const;
const OTHER_SPEEDS = ['fly', 'swim', 'climb', 'burrow'] as const;
type SpeedSet = Record<(typeof SPEED_KEYS)[number], number> & { hover: boolean };

function feet(n: unknown): number {
  return Math.max(0, toInt(n));
}

/**
 * The hero (spec §3.4.1): speedDetails gives walk after death, Speed-0 conditions, heavy armor and Exhaustion;
 * every other speed (the sheet's, max'd with Combatant.speeds granted for now) loses the same amount
 * (srd:rule:speed, Changes to Your Speeds).
 */
function heroSpeeds(sheet: Character, c: Combatant, notes: string[]): SpeedSet {
  const sd = speedDetails(sheet);
  notes.push(...sd.notes);
  const delta = Math.max(0, sd.base - sd.speed);
  const granted: CreatureSpeeds = c.speeds ?? {};
  const own = sheet.otherSpeeds ?? {};
  const out: SpeedSet = {
    walk: Math.max(0, Math.max(sd.base, feet(granted.walk)) - delta),
    fly: 0,
    swim: 0,
    climb: 0,
    burrow: 0,
    hover: granted.hover === true,
  };
  for (const k of OTHER_SPEEDS) {
    const v = Math.max(feet(own[k]), feet(granted[k]));
    out[k] = v > 0 ? Math.max(0, v - delta) : 0;
  }
  return out;
}

/** NPCs: `speeds ?? { walk: 30 }`, then 5 ft × level of Exhaustion off every speed (srd:condition:exhaustion). */
function npcSpeeds(c: Combatant, conditions: readonly ActiveCondition[], notes: string[]): SpeedSet {
  const s: CreatureSpeeds = c.speeds ?? { walk: 30 };
  const out: SpeedSet = {
    walk: feet(s.walk),
    fly: feet(s.fly),
    swim: feet(s.swim),
    climb: feet(s.climb),
    burrow: feet(s.burrow),
    hover: s.hover === true,
  };
  const exhaustion = conditions.find((k) => conditionKey(k.id) === 'exhaustion');
  if (exhaustion) {
    const lvl = Math.min(6, Math.max(1, toInt(exhaustion.level, 1)));
    const cut = 5 * lvl;
    for (const k of SPEED_KEYS) if (out[k] > 0) out[k] = Math.max(0, out[k] - cut);
    notes.push(`Exhaustion ${lvl}: ${MINUS}${cut} ft`);
  }
  return out;
}

/** findCombatant, also accepting a leading "the" ("the Ogre"). */
function findSource(state: CombatState, source: string): Combatant | undefined {
  return findCombatant(state, source) ?? findCombatant(state, source.replace(/^\s*the\s+/i, ''));
}

function frightenedSources(state: CombatState, c: Combatant, conditions: readonly ActiveCondition[]): string[] {
  const ids: string[] = [];
  for (const k of conditions) {
    if (conditionKey(k.id) !== 'frightened' || !k.source?.trim()) continue;
    const src = findSource(state, k.source);
    if (src && src.id !== c.id && !ids.includes(src.id)) ids.push(src.id);
  }
  return ids;
}

/** Null for an unknown id. */
export function moverStats(state: CombatState, hero: Character | null, id: string): MoverStats | null {
  const c = state.combatants.find((x) => x.id === id);
  if (!c) return null;
  const sheet = c.isPlayer ? hero : null;
  const conditions = combatantConditions(c, hero);
  const keys = conditions.map((k) => conditionKey(k.id));
  const notes: string[] = [];
  const zeroKey = keys.find((k) => SPEED_ZERO_CONDITIONS.has(k));
  let speedZero: string | null = zeroKey ? conditionName(zeroKey) : null;
  if (!speedZero && sheet?.deathSaves?.dead) speedZero = 'Dead';
  const speeds = sheet ? heroSpeeds(sheet, c, notes) : npcSpeeds(c, conditions, notes);
  const change = toInt(c.speedChangeFt);
  if (speedZero) {
    // A Speed-0 condition overrides every bonus (the condition "can't increase"; app convention C22).
    for (const k of SPEED_KEYS) speeds[k] = 0;
  } else if (change !== 0) {
    for (const k of SPEED_KEYS) if (speeds[k] > 0) speeds[k] = Math.max(0, speeds[k] + change);
    notes.push(`Speed change: ${change < 0 ? MINUS : '+'}${Math.abs(change)} ft`);
  }
  const ownReach = toInt(c.reachFt);
  return {
    id: c.id,
    name: c.name,
    isHero: c.isPlayer,
    side: c.side,
    team: teamOf(c.side),
    size: combatantSize(c, hero),
    walk: speeds.walk,
    fly: speeds.fly,
    swim: speeds.swim,
    climb: speeds.climb,
    burrow: speeds.burrow,
    hover: speeds.hover,
    reachFt: ownReach > 0 ? ownReach : sheet ? heroReachFt(sheet) : 5,
    prone: keys.includes('prone'),
    incapacitated: keys.some((k) => INCAPACITATING_CONDITIONS.has(k)),
    blinded: keys.includes('blinded'),
    invisible: keys.includes('invisible'),
    hidden: c.hidden === true,
    defeated: c.defeated,
    speedZero,
    frightenedOfIds: frightenedSources(state, c, conditions),
    notes,
  };
}

/** 10 when a sheet attack has the Reach property or a "10 ft." melee range, else 5 (srd:rule:reach; srd:rule:weapons-properties-reach). */
export function heroReachFt(c: Character): number {
  for (const a of c.attacks ?? []) {
    if (a.ability === 'spell') continue;
    if ((a.properties ?? []).some((p) => /^\s*reach\b/i.test(p))) return 10;
    const melee = (a.range ?? '').split(/\s+or\s+/i)[0];
    if (/^\s*10\s*(?:ft\.?|feet)\s*$/i.test(melee)) return 10;
  }
  return 5;
}

const REACH_LINE = /(?:Melee|Melee or Ranged) Attack Roll:[^.]*?reach (\d+) (?:ft\.|feet)/g;

/** Map stats from a stat-block entry: data.size, data.speeds, and the largest "reach N ft." / "reach N feet" on a melee attack line. */
export function statBlockMapStats(entry: {
  text: string;
  data?: Record<string, unknown>;
}): Partial<Pick<Combatant, 'size' | 'speeds' | 'reachFt'>> {
  const out: Partial<Pick<Combatant, 'size' | 'speeds' | 'reachFt'>> = {};
  const data = entry.data ?? {};
  const size = data.size;
  if (typeof size === 'string' && (CREATURE_SIZES as readonly string[]).includes(size)) out.size = size as CreatureSize;
  const raw = data.speeds;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const given = raw as Record<string, unknown>;
    const speeds: CreatureSpeeds = {};
    for (const k of SPEED_KEYS) {
      const v = given[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) speeds[k] = Math.trunc(v);
    }
    if (given.hover === true) speeds.hover = true;
    if (Object.keys(speeds).length > 0) out.speeds = speeds;
  }
  let reach = 0;
  for (const m of (typeof entry.text === 'string' ? entry.text : '').matchAll(REACH_LINE)) reach = Math.max(reach, Number(m[1]));
  if (reach > 0) out.reachFt = reach;
  return out;
}

// ---------------------------------------------------------------------------
// Turn record and budget
// ---------------------------------------------------------------------------

function freshTurn(combatantId: string, round: number): MapTurn {
  return { combatantId, round, movedFt: 0, dashFt: 0, dashes: 0, disengaged: false, stoodUp: false, moves: [] };
}

/** The current creature's record: map.turn when it matches (current id, round), else a fresh one. Null without a map. */
export function currentTurn(state: CombatState): MapTurn | null {
  if (!state.map) return null;
  const current = currentCombatant(state);
  if (!current) return null;
  const turn = state.map.turn;
  if (turn && turn.combatantId === current.id && turn.round === state.round) return turn;
  return freshTurn(current.id, state.round);
}

export interface TurnBudget {
  combatantId: string;
  mode: MoveMode;
  /** The speed for `mode` after modifiers. */
  speedFt: number;
  movedFt: number;
  dashFt: number;
  dashes: number;
  /** max(0, speedFt + dashFt − movedFt): the SRD speed-switching formula. */
  leftFt: number;
  /** What one more Dash would add: speedFt (0 at Speed 0). */
  dashAddsFt: number;
  disengaged: boolean;
  stoodUp: boolean;
  prone: boolean;
  /** floor(walk / 2) (srd:condition:prone; srd:rule:playing-the-game-round-down). */
  standCostFt: number;
  speedZero: string | null;
}

/** 'fly' when walk is 0 and fly > 0, or when airborne with a Fly Speed; else 'walk' (MoveRequest.mode default). */
function defaultMode(stats: MoverStats, elevationFt: number): MoveMode {
  if (stats.fly > 0 && (stats.walk === 0 || elevationFt > 0)) return 'fly';
  return 'walk';
}

/**
 * The budget for `mode`. A creature in deep water whose Swim Speed beats its moving speed reports the swimming
 * allowance: its Swim Speed, and each Dash taken with it (srd:rule:dash; R10), as turnCaps gives.
 */
function budgetOf(stats: MoverStats, mode: MoveMode, turn: MapTurn | null, prone = stats.prone, inDeepWater = false): TurnBudget {
  const moving = mode === 'fly' ? stats.fly : stats.walk;
  const swimming = inDeepWater && mode === 'walk' && stats.swim > moving;
  const speedFt = swimming ? stats.swim : moving;
  const movedFt = turn?.movedFt ?? 0;
  const dashes = turn?.dashes ?? 0;
  const dashFt = swimming ? turnCaps(stats, moving, turn?.dashFt ?? 0, dashes).swim - stats.swim : (turn?.dashFt ?? 0);
  return {
    combatantId: stats.id,
    mode,
    speedFt,
    movedFt,
    dashFt,
    dashes,
    leftFt: Math.max(0, speedFt + dashFt - movedFt),
    dashAddsFt: speedFt,
    disengaged: turn?.disengaged ?? false,
    stoodUp: turn?.stoodUp ?? false,
    prone,
    standCostFt: Math.floor(stats.walk / 2),
    speedZero: stats.speedZero,
  };
}

/** For the current creature (uses map.turn) or anyone else (a fresh budget: off-turn moves). */
export function turnBudget(state: CombatState, hero: Character | null, id: string, mode?: MoveMode): TurnBudget | null {
  const stats = moverStats(state, hero, id);
  if (!stats) return null;
  const c = state.combatants.find((x) => x.id === id) as Combatant;
  const turn = currentCombatant(state)?.id === id ? currentTurn(state) : null;
  const deep = inDeepWater(mapCells(state, hero), c.position, sizeSquares(stats.size));
  return budgetOf(stats, mode ?? defaultMode(stats, c.elevationFt ?? 0), turn, stats.prone, deep);
}

/** Does any square of the footprint anchored at `at` hold deep water? */
function inDeepWater(cells: MapCells | null, at: GridPoint | undefined, n: number): boolean {
  if (!cells || !at || !fits(at, n, cells.width, cells.height)) return false;
  for (let y = at.y; y < at.y + n; y++) for (let x = at.x; x < at.x + n; x++) if (cells.flags[y * cells.width + x] & CELL.DEEP) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Moves: requests, outcomes, refusals
// ---------------------------------------------------------------------------

export type MoveTarget =
  | { kind: 'square'; at: GridPoint }
  /** withinFt default: the mover's reach. */
  | { kind: 'creature'; id: string; withinFt?: number }
  | { kind: 'place'; placeId: string };

export interface MoveRequest {
  moverId: string;
  kind: MoveKind;
  by: 'player' | 'dm';
  /** Required except for forced pushes (push). */
  to?: MoveTarget;
  /** Waypoints in order (kind move / off-turn). */
  via?: GridPoint[];
  /** Can't get all the way: move as far as possible toward `to` (to the closest square). */
  partial?: boolean;
  prefer?: 'safest' | 'shortest';
  /** Default: 'fly' when walk is 0 and fly > 0, or when airborne (elevationFt > 0) with a Fly Speed; else 'walk'. */
  mode?: MoveMode;
  /** End elevation for fly, teleport and place (default: unchanged). */
  elevationFt?: number;
  /** Take the Dash action with this move. Idempotent within the turn unless dashAgain. */
  dash?: boolean;
  dashAgain?: boolean;
  /** Took the Disengage action this turn (idempotent). */
  disengage?: boolean;
  /** Prone movers stand first (half walking Speed) unless stayProne. */
  stayProne?: boolean;
  /** kind 'off-turn': its allowance (default its Speed). */
  budgetFt?: number;
  /** kind 'forced': a straight push or pull; exactly one of awayFrom / toward / direction. */
  push?: { distanceFt: number; awayFrom?: MapRef; toward?: MapRef; direction?: CompassDirection };
  /** kind 'teleport': its range; the destination must be within it. */
  maxFt?: number;
  /** kind 'place': movement it spends this turn (a climb or jump the DM ruled on). Default 0. */
  spendFt?: number;
  /**
   * Reactors that let this move go. They never stop it. If one would have triggered at the step where the move stops
   * for others, it is recorded in stop.reactorIds and stop.declinedIds (so a repeat doesn't ask again or spend its
   * Reaction). When continuing a stop, every stop reactor not in these or stop.declinedIds has its Reaction spent.
   */
  declinedIds?: string[];
}

export interface ProvokedAttack {
  reactorId: string;
  /** The square the mover was in (still within reach) when it provoked. */
  at: GridPoint;
  stepIndex: number;
  reachFt: number;
  isHero: boolean;
  hidden: boolean;
}

export type MoveNote =
  | { kind: 'difficult'; squares: number }
  | { kind: 'stood-up'; costFt: number }
  | { kind: 'crawled'; feet: number }
  | { kind: 'swam'; squares: number }
  | { kind: 'passed-through'; ids: string[] }
  /** Hazards and lasting effects. */
  | { kind: 'entered'; label: string; at: GridPoint }
  /** Its own emanation now covers them. */
  | { kind: 'emanation-reached'; label: string; ids: string[] }
  /** Player moves: a hidden reactor (DM-only). */
  | { kind: 'oa-unseen'; reactorId: string; at: GridPoint }
  /** Player moves stopped early (DM-only detail). */
  | { kind: 'blocked-by-unseen'; byId: string; at: GridPoint }
  | { kind: 'stop-continued'; reactorIds: string[]; declinedIds: string[] }
  | { kind: 'shifted'; requested: GridPoint; reason: 'occupied' | 'blocked' }
  | { kind: 'teleported'; distanceFt: number; lineOfSight: boolean }
  /** by: "the pillar", "Bandit 2", "the map edge". */
  | { kind: 'push-stopped'; at: GridPoint; by: string; shortFt: number }
  /** dice per SRD Falling, null under 10 ft. */
  | { kind: 'fell'; into: string; feet: number; dice: string | null }
  | { kind: 'airborne-walker'; elevationFt: number }
  /** A forced move took a Grappled creature beyond its grappler's reach: the condition ends (srd:rule:grappling). The DM removes it. */
  | { kind: 'grapple-ended'; grapplerId: string };

interface MoveBase {
  moverId: string;
  kind: MoveKind;
  from: GridPoint;
  /** Anchor squares entered, start excluded. */
  path: GridPoint[];
  costFt: number;
  /** After the move (null for forced/teleport/place of a non-current creature). */
  budget: TurnBudget | null;
  provoked: ProvokedAttack[];
  notes: MoveNote[];
  /** The hero stood up: the caller removes 'prone' from the Character (NPC Prone is removed in the engine). */
  heroStoodUp: boolean;
}

export type MoveOutcome =
  | (MoveBase & { status: 'moved'; state: CombatState; to: GridPoint })
  | (MoveBase & {
      status: 'stopped';
      state: CombatState;
      at: GridPoint;
      triggerAt: GridPoint;
      destination: GridPoint;
      reactors: ProvokedAttack[];
      remainingPath: GridPoint[];
      remainingCostFt: number;
    })
  | { status: 'refused'; moverId: string; refusal: MoveRefusal };

export type MoveRefusal =
  | { code: 'unplaced' }
  | { code: 'off-map'; to: GridPoint }
  | { code: 'not-their-turn'; currentId: string | null }
  | { code: 'speed-zero'; because: string }
  | { code: 'cant-stand'; costFt: number; leftFt: number }
  /** what: "wall (pillar)", "door (office door, closed)", "pit". */
  | { code: 'blocked'; at: GridPoint; what: string }
  /** open: ≤ 3 nearest reachable end squares. */
  | { code: 'occupied'; at: GridPoint; byId: string; open: GridPoint[] }
  | { code: 'no-route'; closest?: { at: GridPoint; costFt: number } }
  | {
      code: 'too-far';
      needFt: number;
      leftFt: number;
      route: GridPoint[];
      closest?: { at: GridPoint; costFt: number };
      dashWouldReach: boolean;
    }
  | { code: 'frightened'; sourceId: string; alternative?: GridPoint }
  /** Player moves: the DM hasn't seen the stop yet. */
  | { code: 'stop-pending'; reactorIds: string[] }
  /** Teleport. */
  | { code: 'out-of-range'; distanceFt: number; maxFt: number }
  | { code: 'bad-request'; problem: string };

/** Same checks as applyMove; no state change. perspective 'player' plans on playerView(state). */
export type MovePlan =
  | Omit<Extract<MoveOutcome, { status: 'moved' }>, 'state'>
  | Omit<Extract<MoveOutcome, { status: 'stopped' }>, 'state'>
  | Extract<MoveOutcome, { status: 'refused' }>;

type Refused = Extract<MoveOutcome, { status: 'refused' }>;

// ---------------------------------------------------------------------------
// Small geometry helpers (hot paths keep to plain integers)
// ---------------------------------------------------------------------------

/** Integer coordinates (a square, not a stray number). */
function isSquare(p: GridPoint | undefined): p is GridPoint {
  return !!p && Number.isInteger(p.x) && Number.isInteger(p.y);
}

/** The n-square footprint anchored at p lies on a W × H map. */
function fits(p: GridPoint, n: number, W: number, H: number): boolean {
  return isSquare(p) && p.x >= 0 && p.y >= 0 && p.x + n <= W && p.y + n <= H;
}

function samePoint(a: GridPoint | undefined, b: GridPoint | undefined): boolean {
  return !!a && !!b && a.x === b.x && a.y === b.y;
}

function point(p: GridPoint): GridPoint {
  return { x: p.x, y: p.y };
}

function sizeIndex(size: CreatureSize): number {
  const i = CREATURE_SIZES.indexOf(size);
  return i < 0 ? 2 : i;
}

/** The 5-ft level an elevation sits on (C3). */
function levelOf(elevationFt: number): number {
  return Math.floor(Math.max(0, elevationFt) / 5);
}

function clampElevation(ft: number): number {
  return Math.min(MAP_LIMITS.maxElevationFt, Math.max(0, 5 * Math.floor(toInt(ft) / 5)));
}

/** A creature's space in 3D, in squares and 5-ft levels. */
interface Band {
  id: string;
  rect: GridRect;
  lo: number;
  hi: number;
}

function bandOf(c: Combatant, hero: Character | null, at: GridPoint = c.position as GridPoint): Band {
  const size = combatantSize(c, hero);
  const lo = levelOf(c.elevationFt ?? 0);
  return { id: c.id, rect: footprint(at, size), lo, hi: lo + sizeSquares(size) - 1 };
}

/**
 * Grid distance (srd:rule:combat-movement-and-position-playing-on-a-grid, Ranges; C3) between an n-square space
 * anchored at (ax, ay) at `elevFt` and a band: 5 × max(gapX, gapY, gapZ).
 */
function gapFt(ax: number, ay: number, n: number, elevFt: number, b: Band): number {
  const gx = Math.max(0, b.rect.x0 - (ax + n - 1), ax - b.rect.x1);
  const gy = Math.max(0, b.rect.y0 - (ay + n - 1), ay - b.rect.y1);
  const lo = levelOf(elevFt);
  const gz = Math.max(0, b.lo - (lo + n - 1), lo - b.hi);
  return 5 * Math.max(gx, gy, gz);
}

/** 2D grid distance between two rects. */
function rectGapFt(a: GridRect, b: GridRect): number {
  return 5 * Math.max(0, b.x0 - a.x1, a.x0 - b.x1, b.y0 - a.y1, a.y0 - b.y1);
}

function anchorRect(ax: number, ay: number, n: number): GridRect {
  return { x0: ax, y0: ay, x1: ax + n - 1, y1: ay + n - 1 };
}

function dirIndex(dx: number, dy: number): number {
  for (let d = 0; d < 8; d++) if (DX[d] === dx && DY[d] === dy) return d;
  return -1;
}

function popcount(v: number): number {
  let x = v - ((v >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * The tracker's name order: what localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }) gives, with one
 * collator made on first use instead of one per comparison.
 */
let nameCollator: Intl.Collator | null = null;
function compareNames(a: string, b: string): number {
  nameCollator ??= new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  return nameCollator.compare(a, b);
}

const ranksMemo = new WeakMap<readonly Combatant[], Map<string, number>>();

/** Canonical initiative ranks (the tracker's order, then id), so results never depend on array order. */
function initiativeRanks(state: CombatState): Map<string, number> {
  const memo = ranksMemo.get(state.combatants);
  if (memo) return memo;
  const sorted = [...state.combatants].sort(
    (a, b) =>
      b.initiative - a.initiative ||
      b.initiativeBonus - a.initiativeBonus ||
      Number(b.isPlayer) - Number(a.isPlayer) ||
      compareNames(a.name, b.name) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const ranks = new Map(sorted.map((c, i) => [c.id, i]));
  ranksMemo.set(state.combatants, ranks);
  return ranks;
}

/** Prefix sums of Total Cover squares and sight blockers (memoized per MapCells): a box with none needs no segment test. */
interface BlockerSums {
  stride: number;
  cover3: Int32Array;
  sight: Int32Array;
}
const sumsMemo = new WeakMap<MapCells, BlockerSums>();

function blockerSums(cells: MapCells): BlockerSums {
  const memo = sumsMemo.get(cells);
  if (memo) return memo;
  const { width: W, height: H } = cells;
  const S = W + 1;
  const cover3 = new Int32Array(S * (H + 1));
  const sight = new Int32Array(S * (H + 1));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const j = (y + 1) * S + x + 1;
      cover3[j] = (cells.cover[i] >= 3 ? 1 : 0) + cover3[j - 1] + cover3[j - S] - cover3[j - S - 1];
      sight[j] = (cells.flags[i] & CELL.BLOCKS_SIGHT ? 1 : 0) + sight[j - 1] + sight[j - S] - sight[j - S - 1];
    }
  }
  const sums = { stride: S, cover3, sight };
  sumsMemo.set(cells, sums);
  return sums;
}

const deepMemo = new WeakMap<MapCells, boolean>();

/** Does any square hold deep water (memoized per MapCells)? */
function hasDeepWater(cells: MapCells): boolean {
  let v = deepMemo.get(cells);
  if (v === undefined) {
    v = cells.flags.some((f) => (f & CELL.DEEP) !== 0);
    deepMemo.set(cells, v);
  }
  return v;
}

/** Any marked square in the box spanned by a and b (clipped to the map)? Segments between two spaces stay inside it. */
function anyIn(sums: Int32Array, stride: number, cells: MapCells, a: GridRect, b: GridRect): boolean {
  const x0 = Math.max(0, Math.min(a.x0, b.x0));
  const y0 = Math.max(0, Math.min(a.y0, b.y0));
  const x1 = Math.min(cells.width - 1, Math.max(a.x1, b.x1));
  const y1 = Math.min(cells.height - 1, Math.max(a.y1, b.y1));
  if (x0 > x1 || y0 > y1) return false;
  const n = sums[(y1 + 1) * stride + x1 + 1] - sums[y0 * stride + x1 + 1] - sums[(y1 + 1) * stride + x0] + sums[y0 * stride + x0];
  return n > 0;
}

/** D7: every line between the spaces is blocked by Total Cover terrain. */
function walled(cells: MapCells, a: GridRect, b: GridRect): boolean {
  const sums = blockerSums(cells);
  return anyIn(sums.cover3, sums.stride, cells, a, b) && rectsTotalCover(cells, a, b);
}

/** C20 line of sight between two spaces. */
function seeing(cells: MapCells, a: GridRect, b: GridRect): boolean {
  const sums = blockerSums(cells);
  return !anyIn(sums.sight, sums.stride, cells, a, b) || rectsSeeEachOther(cells, a, b);
}

// ---------------------------------------------------------------------------
// Terrain names (for refusals and push notes)
// ---------------------------------------------------------------------------

function featuresAt(map: BattleMap, x: number, y: number): TerrainFeature[] {
  return map.terrain.filter((f) => f.rects.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1));
}

/** The feature that blocks movement on a square (a door replaces any wall), or null. */
function blockingFeature(map: BattleMap, x: number, y: number, flying: boolean): TerrainFeature | null {
  const here = featuresAt(map, x, y);
  const door = [...here].reverse().find((f) => f.kind === 'door');
  if (door && door.door !== 'open') return door;
  for (const f of here) {
    if (f.kind === 'three-quarters-cover') return f;
    if (f.kind === 'wall' && !door) return f;
  }
  if (!flying) return here.find((f) => f.kind === 'pit') ?? null;
  return null;
}

/** "wall (pillar)", "door (office door, closed)", "three-quarters cover (arrow slit)", "pit". */
function blockedWhat(f: TerrainFeature | null): string {
  if (!f) return 'wall';
  const kind = f.kind === 'three-quarters-cover' ? 'three-quarters cover' : f.kind;
  if (f.kind === 'door') return f.label ? `door (${f.label}, ${f.door ?? 'closed'})` : `door (${f.door ?? 'closed'})`;
  return f.label ? `${kind} (${f.label})` : kind;
}

/** "the pillar", "the office door", "a wall", "a closed door". */
function obstacleName(f: TerrainFeature | null): string {
  if (f?.label) return `the ${f.label}`;
  if (f?.kind === 'door') return `a ${f.door ?? 'closed'} door`;
  if (f?.kind === 'three-quarters-cover') return 'three-quarters cover';
  if (f?.kind === 'pit') return 'a pit';
  return 'a wall';
}

/** SRD Falling: 1d6 per 10 ft, at most 20d6; nothing under 10 ft (srd:rule:falling; app convention C26). */
function fallDice(ft: number): string | null {
  const n = Math.min(20, Math.floor(ft / 10));
  return n > 0 ? `${n}d6` : null;
}

/** The pit feature on a square (a stand-in when only the flag is known). */
function pitAt(map: BattleMap, x: number, y: number): TerrainFeature {
  return featuresAt(map, x, y).find((t) => t.kind === 'pit') ?? { id: '', kind: 'pit', rects: [] };
}

function fellNote(pit: TerrainFeature, ft: number): MoveNote {
  return { kind: 'fell', into: pit.label ? `the ${pit.label}` : 'the pit', feet: ft, dice: fallDice(ft) };
}

// ---------------------------------------------------------------------------
// The search context: one mover on one state (the true map or the player view)
// ---------------------------------------------------------------------------

interface Reactor extends Band {
  /** Position in Ctx.allReactors (memo keys). */
  index: number;
  reachFt: number;
  hidden: boolean;
  isHero: boolean;
  declined: boolean;
}

interface ReachMasks {
  elevFt: number;
  chunks: number;
  /** Per anchor × chunk: the reactors close enough to reach the mover there, by distance alone (null: test them all). */
  near: Int32Array | null;
  done: Uint8Array;
  reach: Int32Array;
  seen: Int32Array;
}

interface Ctx {
  state: CombatState;
  hero: Character | null;
  map: BattleMap;
  /** The map with every effect where it is now: sight and cover. */
  cells: MapCells;
  /**
   * What the mover's own steps cross (terrain costs, labels entered): its own lasting emanations left out, since they
   * move with it (srd:rule:emanation; R4). The same object as `cells` when it has none.
   */
  moveCells: MapCells;
  /** Its own lasting emanation includes it and is Difficult Terrain: every step is in it (its creator's choice). */
  selfDifficult: boolean;
  /** Its own lasting emanation is obscuring: it moves inside it, so no reactor sees it (C14, C20). */
  selfObscured: boolean;
  W: number;
  H: number;
  mover: Combatant;
  stats: MoverStats;
  n: number;
  start: GridPoint;
  /** False while placing a creature that isn't on the map yet (its "start" is a stand-in). */
  placed: boolean;
  startElev: number;
  /** The level it moves at: max(start, end) — a flier climbs first and lands last. */
  pathElev: number;
  endElev: number;
  fly: boolean;
  swims: boolean;
  crawl: boolean;
  /** Initiative ranks, made on first use: only what a move reports needs an order (rankOf). */
  ranks: Map<string, number> | null;
  others: Occupant[];
  /** Per square, on the path band: an occupant it can't pass / a passable one whose space is Difficult Terrain. */
  sqBlock: Uint8Array;
  sqDT: Uint8Array;
  /** Per anchor: -1 unknown, 0 / 1. */
  anchorBlock: Int8Array;
  anchorEnd: Int8Array;
  /** Per square: some other creature on the end band stands there (built on first use; step rule 7). */
  endOcc: Uint8Array | null;
  /** Per anchor × 8 directions: UNKNOWN, ILLEGAL, else units × 2 + deep. */
  steps: Int8Array;
  fear: Band[];
  /** Eligible reactors counted by the search (not declined). */
  reactors: Reactor[];
  /** Eligible reactors that let the move go (recorded, never stop it). */
  declinedReactors: Reactor[];
  allReactors: Reactor[];
  masks: ReachMasks | null;
  startMasks: ReachMasks | null;
  coverMemo: Map<number, boolean>;
  sightMemo: Map<number, boolean>;
  goalCoverMemo: Map<number, boolean>;
}

interface CtxOpts {
  fly: boolean;
  /** Placing a creature that isn't on the map yet: `start` is only a stand-in. */
  unplaced?: boolean;
  startElev: number;
  endElev: number;
  crawl: boolean;
  fearIds: readonly string[];
  /** Reactors left out entirely (a continued stop's reactors). */
  ignore: ReadonlySet<string>;
  declined: ReadonlySet<string>;
  /** False for Disengage, forced, teleport and place: nobody reacts. */
  reactorsOn: boolean;
}

const ownEffectsMemo = new WeakMap<readonly MapEffect[], Map<string, { own: MapEffect[]; rest: MapEffect[] }>>();

/** A creature's own lasting emanations and the map's other effects (memoized per effects array), or null without any. */
function splitOwnEmanations(effects: readonly MapEffect[], moverId: string): { own: MapEffect[]; rest: MapEffect[] } | null {
  const isOwn = (e: MapEffect) => e.duration === 'lasting' && e.spec.shape === 'emanation' && e.spec.fromId === moverId;
  if (!effects.some(isOwn)) return null;
  let byMover = ownEffectsMemo.get(effects);
  if (!byMover) ownEffectsMemo.set(effects, (byMover = new Map()));
  let split = byMover.get(moverId);
  if (!split) byMover.set(moverId, (split = { own: effects.filter(isOwn), rest: effects.filter((e) => !isOwn(e)) }));
  return split;
}

/** D30 / C14: who may make an Opportunity Attack against this mover (line of sight is checked per step). */
function eligibleReactors(ctx: Ctx, o: CtxOpts): void {
  const { state, hero, stats } = ctx;
  if (!o.reactorsOn || stats.invisible) return;
  for (const c of state.combatants) {
    if (c.id === stats.id || !c.position || c.defeated || c.reactionUsed || o.ignore.has(c.id)) continue;
    if (!areHostile(teamOf(c.side), stats.team)) continue;
    const r = moverStats(state, hero, c.id) as MoverStats;
    if (r.incapacitated || r.blinded) continue;
    if (stats.hidden && r.team === 'party') continue;
    const reactor: Reactor = {
      ...bandOf(c, hero),
      index: 0,
      reachFt: r.reachFt,
      hidden: r.hidden,
      isHero: r.isHero,
      declined: o.declined.has(c.id),
    };
    (reactor.declined ? ctx.declinedReactors : ctx.reactors).push(reactor);
  }
  // In list order: a search only counts reactors; what a walk reports is put in initiative order (byRank).
  ctx.allReactors = [...ctx.reactors, ...ctx.declinedReactors];
  ctx.allReactors.forEach((r, i) => (r.index = i));
}

function buildCtx(state: CombatState, hero: Character | null, mover: Combatant, stats: MoverStats, o: CtxOpts): Ctx | null {
  const map = state.map;
  const cells = mapCells(state, hero);
  if (!map || !cells || !mover.position) return null;
  const split = splitOwnEmanations(map.effects, mover.id);
  const moveCells = split ? (mapCells({ ...state, map: { ...map, effects: split.rest } }, hero) as MapCells) : cells;
  const W = cells.width;
  const H = cells.height;
  const n = sizeSquares(stats.size);
  // A footprint that no longer fits (a stale save, a size change not yet re-fitted) counts as not on the map.
  if (!fits(mover.position, n, W, H)) return null;
  const N = W * H;
  const ctx: Ctx = {
    state,
    hero,
    map,
    cells,
    moveCells,
    selfDifficult: !!split && split.own.some((e) => e.spec.includeOrigin === true && e.terrain.includes('difficult')),
    selfObscured: !!split && split.own.some((e) => e.terrain.includes('obscured')),
    W,
    H,
    mover,
    stats,
    n,
    start: point(mover.position),
    placed: o.unplaced !== true,
    startElev: o.startElev,
    pathElev: Math.max(o.startElev, o.endElev),
    endElev: o.endElev,
    fly: o.fly,
    swims: !o.fly && stats.swim > 0,
    crawl: o.crawl,
    ranks: null,
    others: occupants(state, hero).filter((x) => x.id !== mover.id),
    sqBlock: new Uint8Array(N),
    sqDT: new Uint8Array(N),
    anchorBlock: new Int8Array(N).fill(-1),
    anchorEnd: new Int8Array(N).fill(-1),
    endOcc: null,
    steps: new Int8Array(N * 8).fill(UNKNOWN),
    fear: [],
    reactors: [],
    declinedReactors: [],
    allReactors: [],
    masks: null,
    startMasks: null,
    coverMemo: new Map(),
    sightMemo: new Map(),
    goalCoverMemo: new Map(),
  };
  // Other creatures on the path band (srd:rule:combat-movement-and-position-moving-around-other-creatures; C5).
  const plo = levelOf(ctx.pathElev);
  const phi = plo + n - 1;
  const moverSize = sizeIndex(stats.size);
  for (const occ of ctx.others) {
    const olo = levelOf(occ.elevationFt);
    const ohi = olo + sizeSquares(occ.size) - 1;
    if (olo > phi || plo > ohi) continue;
    const ally = areAllies(occ.team, stats.team);
    // An ally, an Incapacitated creature, a Tiny creature (the occupant: a Tiny mover still can't pass a Small foe)
    // or one two sizes apart (R13).
    const passable = ally || occ.incapacitated || occ.size === 'Tiny' || Math.abs(sizeIndex(occ.size) - moverSize) >= 2;
    const difficult = passable && !(ally || occ.size === 'Tiny');
    for (let y = Math.max(0, occ.rect.y0); y <= Math.min(H - 1, occ.rect.y1); y++) {
      for (let x = Math.max(0, occ.rect.x0); x <= Math.min(W - 1, occ.rect.x1); x++) {
        if (!passable) ctx.sqBlock[y * W + x] = 1;
        else if (difficult) ctx.sqDT[y * W + x] = 1;
      }
    }
  }
  for (const id of o.fearIds) {
    const src = state.combatants.find((c) => c.id === id);
    if (src?.position && !src.defeated) ctx.fear.push(bandOf(src, hero));
  }
  eligibleReactors(ctx, o);
  if (ctx.reactors.length > 0) {
    ctx.masks = withNear(ctx, newMasks(ctx, ctx.pathElev));
    ctx.startMasks = ctx.startElev === ctx.pathElev ? ctx.masks : newMasks(ctx, ctx.startElev);
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Reach, sight and Total Cover from a reactor to the mover at an anchor
// ---------------------------------------------------------------------------

function walledFrom(ctx: Ctx, r: Reactor, ax: number, ay: number): boolean {
  const key = r.index * ctx.W * ctx.H + ay * ctx.W + ax;
  let v = ctx.coverMemo.get(key);
  if (v === undefined) {
    v = walled(ctx.cells, r.rect, anchorRect(ax, ay, ctx.n));
    ctx.coverMemo.set(key, v);
  }
  return v;
}

/** D7: the mover at (ax, ay, elevFt) is within r's reach with no Total Cover between them. */
function reaches(ctx: Ctx, r: Reactor, ax: number, ay: number, elevFt: number): boolean {
  if (gapFt(ax, ay, ctx.n, elevFt, r) > r.reachFt) return false;
  return !walledFrom(ctx, r, ax, ay);
}

/** C14: r has line of sight to the mover at (ax, ay). */
function seesAt(ctx: Ctx, r: Reactor, ax: number, ay: number): boolean {
  if (ctx.selfObscured) return false;
  const key = r.index * ctx.W * ctx.H + ay * ctx.W + ax;
  let v = ctx.sightMemo.get(key);
  if (v === undefined) {
    v = seeing(ctx.cells, r.rect, anchorRect(ax, ay, ctx.n));
    ctx.sightMemo.set(key, v);
  }
  return v;
}

/** Step a → b leaves r's reach while r can see the mover at a (srd:rule:opportunity-attacks). */
function leaves(ctx: Ctx, r: Reactor, a: GridPoint, ea: number, b: GridPoint, eb: number): boolean {
  return reaches(ctx, r, a.x, a.y, ea) && seesAt(ctx, r, a.x, a.y) && !reaches(ctx, r, b.x, b.y, eb);
}

function newMasks(ctx: Ctx, elevFt: number): ReachMasks {
  const chunks = Math.ceil(ctx.reactors.length / 30);
  const N = ctx.W * ctx.H;
  return { elevFt, chunks, near: null, done: new Uint8Array(N), reach: new Int32Array(N * chunks), seen: new Int32Array(N * chunks) };
}

/** Reactor i's bits at anchor a, once its distance is known to be within reach: no Total Cover (D7), then sight (C14). */
function markAnchor(ctx: Ctx, m: ReachMasks, i: number, a: number, ax: number, ay: number): void {
  const r = ctx.reactors[i];
  if (walledFrom(ctx, r, ax, ay)) return;
  const slot = a * m.chunks + ((i / 30) | 0);
  const bit = 1 << i % 30;
  m.reach[slot] |= bit;
  if (seesAt(ctx, r, ax, ay)) m.seen[slot] |= bit;
}

/** The reactors' reach and sight at anchor a, on first use: the same bits as reaches / seesAt per reactor. */
function ensureMask(ctx: Ctx, m: ReachMasks, a: number): void {
  if (m.done[a]) return;
  m.done[a] = 1;
  const ax = a % ctx.W;
  const ay = (a - ax) / ctx.W;
  if (!m.near) {
    for (let i = 0; i < ctx.reactors.length; i++) {
      if (gapFt(ax, ay, ctx.n, m.elevFt, ctx.reactors[i]) <= ctx.reactors[i].reachFt) markAnchor(ctx, m, i, a, ax, ay);
    }
    return;
  }
  for (let k = 0; k < m.chunks; k++) {
    for (let bits = m.near[a * m.chunks + k]; bits !== 0; ) {
      const low = bits & -bits;
      bits ^= low;
      markAnchor(ctx, m, k * 30 + 31 - Math.clz32(low), a, ax, ay);
    }
  }
}

/**
 * Which reactors are close enough to reach the mover at each anchor, by distance alone, filled at once reactor by
 * reactor: 5 × max(gapX, gapY) ≤ reach puts the footprint within reach / 5 squares of the reactor's space. A visited
 * anchor then tests walls and sight only for those (spec §7.12), not for every reactor.
 */
function withNear(ctx: Ctx, m: ReachMasks): ReachMasks {
  const { W, H, n } = ctx;
  const near = new Int32Array(W * H * m.chunks);
  for (let i = 0; i < ctx.reactors.length; i++) {
    const r = ctx.reactors[i];
    const squares = Math.floor(r.reachFt / 5);
    const slot = (i / 30) | 0;
    const bit = 1 << i % 30;
    const x1 = Math.min(W - n, r.rect.x1 + squares);
    const y1 = Math.min(H - n, r.rect.y1 + squares);
    for (let ay = Math.max(0, r.rect.y0 - (n - 1) - squares); ay <= y1; ay++) {
      for (let ax = Math.max(0, r.rect.x0 - (n - 1) - squares); ax <= x1; ax++) {
        if (gapFt(ax, ay, n, m.elevFt, r) <= r.reachFt) near[(ay * W + ax) * m.chunks + slot] |= bit;
      }
    }
  }
  m.near = near;
  return m;
}

// ---------------------------------------------------------------------------
// Step rules (spec §3.4.2)
// ---------------------------------------------------------------------------

/** Some impassable creature overlaps the footprint at (ax, ay) (step rule 4). */
function anchorBlocked(ctx: Ctx, ax: number, ay: number): boolean {
  const a = ay * ctx.W + ax;
  if (ctx.anchorBlock[a] < 0) {
    let v = 0;
    for (let y = ay; y < ay + ctx.n && !v; y++) for (let x = ax; x < ax + ctx.n; x++) if (ctx.sqBlock[y * ctx.W + x]) v = 1;
    ctx.anchorBlock[a] = v;
  }
  return ctx.anchorBlock[a] === 1;
}

/** The occupants (on the end band) whose spaces overlap the footprint at (ax, ay). */
function occupantsAt(ctx: Ctx, ax: number, ay: number, lo: number): Occupant[] {
  const rect = anchorRect(ax, ay, ctx.n);
  const hi = lo + ctx.n - 1;
  return ctx.others.filter((o) => {
    const olo = levelOf(o.elevationFt);
    return rectsOverlap(o.rect, rect) && olo <= hi && lo <= olo + sizeSquares(o.size) - 1;
  });
}

/**
 * Step rule 7: a move can end at (ax, ay) when the footprint overlaps no other creature, except a Tiny mover
 * among fewer than 4 Tiny creatures (C4). Defeated movers (placed markers) share with anyone (C7).
 */
function endable(ctx: Ctx, ax: number, ay: number): boolean {
  if (ax < 0 || ay < 0 || ax + ctx.n > ctx.W || ay + ctx.n > ctx.H) return false;
  const a = ay * ctx.W + ax;
  if (ctx.anchorEnd[a] < 0) {
    let ok = true;
    if (!ctx.stats.defeated && !(ctx.placed && ax === ctx.start.x && ay === ctx.start.y)) {
      if (ctx.stats.size === 'Tiny') {
        const here = occupantsAt(ctx, ax, ay, levelOf(ctx.endElev));
        ok = here.length === 0 || (here.length < 4 && here.every((o) => o.size === 'Tiny'));
      } else {
        const occ = ctx.endOcc ?? endOccupancy(ctx);
        for (let y = ay; y < ay + ctx.n && ok; y++) for (let x = ax; x < ax + ctx.n; x++) if (occ[y * ctx.W + x]) ok = false;
      }
    }
    ctx.anchorEnd[a] = ok ? 1 : 0;
  }
  return ctx.anchorEnd[a] === 1;
}

/** The squares other creatures hold on the band the move ends on (the same test as occupantsAt, once per square). */
function endOccupancy(ctx: Ctx): Uint8Array {
  const occ = new Uint8Array(ctx.W * ctx.H);
  const lo = levelOf(ctx.endElev);
  const hi = lo + ctx.n - 1;
  for (const o of ctx.others) {
    const olo = levelOf(o.elevationFt);
    if (olo > hi || lo > olo + sizeSquares(o.size) - 1) continue;
    for (let y = Math.max(0, o.rect.y0); y <= Math.min(ctx.H - 1, o.rect.y1); y++) {
      for (let x = Math.max(0, o.rect.x0); x <= Math.min(ctx.W - 1, o.rect.x1); x++) occ[y * ctx.W + x] = 1;
    }
  }
  ctx.endOcc = occ;
  return occ;
}

/** C13: the step brings the mover closer to a source of its fear. */
function approachesFear(ctx: Ctx, ax: number, ay: number, bx: number, by: number): boolean {
  for (const src of ctx.fear) {
    if (gapFt(bx, by, ctx.n, ctx.pathElev, src) < gapFt(ax, ay, ctx.n, ctx.pathElev, src)) return true;
  }
  return false;
}

function computeStep(ctx: Ctx, ax: number, ay: number, d: number): number {
  const { n, W, H } = ctx;
  const dx = DX[d];
  const dy = DY[d];
  const bx = ax + dx;
  const by = ay + dy;
  // 1. Bounds.
  if (bx < 0 || by < 0 || bx + n > W || by + n > H) return ILLEGAL;
  const flags = ctx.moveCells.flags;
  let dt = ctx.selfDifficult && !ctx.fly ? 1 : 0;
  let deep = 0;
  // 2. Terrain of the newly entered squares; 6. their cost.
  for (let y = by; y < by + n; y++) {
    for (let x = bx; x < bx + n; x++) {
      if (x >= ax && x < ax + n && y >= ay && y < ay + n) continue;
      const i = y * W + x;
      const f = flags[i];
      if (f & CELL.BLOCKS_MOVE) return ILLEGAL;
      if (!ctx.fly) {
        if (f & CELL.PIT) return ILLEGAL;
        if (f & CELL.DIFFICULT) dt = 1;
        if (f & CELL.DEEP) deep = 1;
      }
      if (ctx.sqDT[i]) dt = 1;
    }
  }
  // 3. Corners (C8): the two squares across the corner must not fill their space.
  if (dx !== 0 && dy !== 0) {
    const cax = dx > 0 ? ax + n : ax - 1;
    const cay = dy > 0 ? ay : ay + n - 1;
    const cbx = dx > 0 ? ax : ax + n - 1;
    const cby = dy > 0 ? ay + n : ay - 1;
    if (flags[cay * W + cax] & CELL.FILLS || flags[cby * W + cbx] & CELL.FILLS) return ILLEGAL;
  }
  // 4. Other creatures.
  if (anchorBlocked(ctx, bx, by)) return ILLEGAL;
  // 5. Frightened (willing moves only; the context has no sources otherwise).
  if (ctx.fear.length > 0 && approachesFear(ctx, ax, ay, bx, by)) return ILLEGAL;
  const units = 1 + dt + (ctx.crawl ? 1 : 0);
  return units * 2 + deep;
}

function stepCode(ctx: Ctx, ax: number, ay: number, d: number): number {
  const key = (ay * ctx.W + ax) * 8 + d;
  let v = ctx.steps[key];
  if (v === UNKNOWN) {
    v = computeStep(ctx, ax, ay, d);
    ctx.steps[key] = v;
  }
  return v;
}

interface Caps {
  /** Highest total movement for a step paid with the moving speed (walk or fly), Dash included. */
  main: number;
  /** Highest total for a deep-water step paid with the Swim Speed (§3.4.4). */
  swim: number;
}

/**
 * A turn's allowances (spec §3.4.3–3.4.4): the moving speed plus the Dashes (dashFt: that speed at each Dash). A
 * Dash may be taken with the Swim Speed instead (srd:rule:dash: "you can use that speed instead of your Speed";
 * R10), so for steps paid with the Swim Speed each Dash adds the larger of the two.
 */
function turnCaps(stats: MoverStats, speedFt: number, dashFt: number, dashes: number): Caps {
  return { main: speedFt + dashFt, swim: stats.swim + Math.max(dashFt, dashes * stats.swim) };
}

/**
 * The cost of a step from total `g`, or -1 when it doesn't fit. A deep-water step is paid with the Swim Speed when
 * that fits (no extra), else walked at +5 ft (srd:rule:swimming; switching speeds, srd:rule:speed).
 */
function stepCost(ctx: Ctx, code: number, g: number, caps: Caps): number {
  let cost = 5 * (code >> 1);
  if (code & 1) {
    if (ctx.swims && g + cost <= caps.swim) return cost;
    cost += 5;
  }
  return g + cost <= caps.main ? cost : -1;
}

// ---------------------------------------------------------------------------
// Dijkstra over (anchor, provocations) (spec §3.4.5)
// ---------------------------------------------------------------------------

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, val: number): void {
    const keys = this.keys;
    const vals = this.vals;
    let i = keys.length;
    keys.push(key);
    vals.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }

  /** Removes the smallest entry; returns its value. */
  pop(): number {
    const keys = this.keys;
    const vals = this.vals;
    const top = vals[0];
    const lastKey = keys.pop() as number;
    const lastVal = vals.pop() as number;
    const n = keys.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= lastKey) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = lastKey;
      vals[i] = lastVal;
    }
    return top;
  }
}

/** Priority (feet, diagonals, insertion order) packed into one exact integer (< 2^53). */
function heapKey(g: number, diag: number, seq: number): number {
  return (g * 4096 + Math.min(diag, 4095)) * 1048576 + seq;
}

interface Search {
  /** Labels per anchor: 5 when counting provocations, else 1. */
  L: number;
  g: Int32Array;
  diag: Int32Array;
  prev: Int32Array;
  startLabel: number;
  /** With `trackFired`: per label × mask chunk, the reactors its route has provoked (each counted once). */
  fired: Int32Array | null;
  chunks: number;
}

/**
 * Dijkstra from `from` with total `g0`. Safest: labels (anchor, provocations capped at 4); shortest: one per anchor.
 * A label is settled the first time it is popped (its best (feet, diagonals)); later pops of it are skipped.
 */
function runSearch(ctx: Ctx, from: GridPoint, g0: number, caps: Caps, safest: boolean, trackFired = false): Search {
  const W = ctx.W;
  const N = W * ctx.H;
  const counting = safest && ctx.reactors.length > 0;
  const tracking = trackFired && ctx.reactors.length > 0;
  const L = counting ? SAFEST_CAP + 1 : 1;
  const chunks = ctx.masks?.chunks ?? 0;
  const g = new Int32Array(N * L).fill(INF);
  const diag = new Int32Array(N * L);
  const prev = new Int32Array(N * L).fill(-1);
  const done = new Uint8Array(N * L);
  const fired = tracking ? new Int32Array(N * L * chunks) : null;
  const startIdx = from.y * W + from.x;
  const fromStart = ctx.start.y * W + ctx.start.x;
  const startLabel = startIdx * L;
  const steps = ctx.steps;
  const masked = counting || tracking;
  const mb = ctx.masks;
  const heap = new MinHeap();
  let seq = 0;
  g[startLabel] = g0;
  heap.push(heapKey(g0, 0, seq++), startLabel);
  while (heap.size > 0) {
    const label = heap.pop();
    if (done[label]) continue;
    done[label] = 1;
    const gl = g[label];
    const dl = diag[label];
    const a = (label / L) | 0;
    const p = label - a * L;
    if (p > 0 && dominated(g, done, a * L, p, gl)) continue;
    const ax = a % W;
    const ay = (a - ax) / W;
    // The reactors' reach around the mover at a (the start has its own height); per neighbour b below.
    const ma = masked ? ((a === fromStart ? ctx.startMasks : mb) as ReachMasks) : null;
    if (ma && !ma.done[a]) ensureMask(ctx, ma, a);
    for (let d = 0; d < 8; d++) {
      const key = a * 8 + d;
      let code = steps[key];
      if (code === UNKNOWN) {
        code = computeStep(ctx, ax, ay, d);
        steps[key] = code;
      }
      if (code < 0) continue;
      const b = a + DY[d] * W + DX[d];
      // A settled label of b with no more provocations costs no more than this one (labels settle in order and a step
      // costs at least 5 ft): every label this step could make is equal to it or dominated by it.
      if (settledUpTo(done, b * L, p)) continue;
      const cost = stepCost(ctx, code, gl, caps);
      if (cost < 0) continue;
      const ng = gl + cost;
      let np = 0;
      if (ma && mb) {
        if (!mb.done[b]) ensureMask(ctx, mb, b);
        if (counting) {
          // Reactors that see the mover at a and don't reach it at b: the step out of their reach (D30).
          let count = 0;
          for (let k = 0; k < chunks; k++) count += popcount(ma.seen[a * chunks + k] & ~mb.reach[b * chunks + k]);
          np = Math.min(SAFEST_CAP, p + count);
        }
      }
      const nl = b * L + np;
      const nd = dl + (d >= 4 ? 1 : 0);
      // Dominated already (a settled label of b with fewer provocations costs less): it would never be expanded.
      if (np > 0 && dominated(g, done, b * L, np, ng)) continue;
      if (ng < g[nl] || (ng === g[nl] && nd < diag[nl])) {
        g[nl] = ng;
        diag[nl] = nd;
        prev[nl] = label;
        if (fired && ma && mb) {
          for (let k = 0; k < chunks; k++) {
            fired[nl * chunks + k] = fired[label * chunks + k] | (ma.seen[a * chunks + k] & ~mb.reach[b * chunks + k]);
          }
        }
        heap.push(heapKey(ng, nd, seq++), nl);
      }
    }
  }
  return { L, g, diag, prev, startLabel, fired, chunks };
}

/**
 * A settled label of the same anchor with fewer provocations and strictly fewer feet: every route through this label
 * does better through that one (no more provocations, fewer feet, so a deep-water step is never dearer), so nothing
 * the search reports can go through it and it needn't be expanded. Labels settle in (feet, diagonals) order, so any
 * such label is already settled.
 */
function dominated(g: Int32Array, done: Uint8Array, base: number, p: number, gl: number): boolean {
  for (let q = 0; q < p; q++) if (done[base + q] && g[base + q] < gl) return true;
  return false;
}

/** Is a label of this anchor with at most p provocations settled? */
function settledUpTo(done: Uint8Array, base: number, p: number): boolean {
  for (let q = 0; q <= p; q++) if (done[base + q]) return true;
  return false;
}

/** The number of reactors the route to `label` provokes (a search with trackFired). */
function firedCount(s: Search, label: number): number {
  if (!s.fired) return 0;
  let n = 0;
  for (let k = 0; k < s.chunks; k++) n += popcount(s.fired[label * s.chunks + k]);
  return n;
}

function labelPath(ctx: Ctx, s: Search, label: number): GridPoint[] {
  const out: GridPoint[] = [];
  for (let l = label; l >= 0; l = s.prev[l]) {
    const a = (l / s.L) | 0;
    out.push({ x: a % ctx.W, y: (a / ctx.W) | 0 });
  }
  return out.reverse();
}

// ---------------------------------------------------------------------------
// Goals and choosing the end (spec §3.4.5)
// ---------------------------------------------------------------------------

type Goal =
  | { kind: 'square'; at: GridPoint; transit: boolean }
  | { kind: 'creature'; band: Band; withinFt: number }
  | { kind: 'place'; place: MapPlace };

/** Is (ax, ay) a goal anchor, and how much is it to be avoided (places: 1 when not fully inside)? Null when not a goal. */
function goalPenalty(ctx: Ctx, goal: Goal, ax: number, ay: number): number | null {
  if (goal.kind === 'square') return goal.at.x === ax && goal.at.y === ay ? 0 : null;
  if (goal.kind === 'creature') {
    if (gapFt(ax, ay, ctx.n, ctx.endElev, goal.band) > goal.withinFt) return null;
    const key = ay * ctx.W + ax;
    let blocked = ctx.goalCoverMemo.get(key);
    if (blocked === undefined) {
      blocked = walled(ctx.cells, anchorRect(ax, ay, ctx.n), goal.band.rect);
      ctx.goalCoverMemo.set(key, blocked);
    }
    return blocked ? null : 0;
  }
  const rect = anchorRect(ax, ay, ctx.n);
  if (!goal.place.rects.some((r) => rectsOverlap(r, rect))) return null;
  for (let y = rect.y0; y <= rect.y1; y++) {
    for (let x = rect.x0; x <= rect.x1; x++) {
      if (!goal.place.rects.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1)) return 1;
    }
  }
  return 0;
}

/** Grid distance from the footprint at (ax, ay) to the goal (for "closest"). */
function goalDistance(ctx: Ctx, goal: Goal, ax: number, ay: number): number {
  const rect = anchorRect(ax, ay, ctx.n);
  if (goal.kind === 'square') return rectGapFt(rect, anchorRect(goal.at.x, goal.at.y, ctx.n));
  if (goal.kind === 'creature') return gapFt(ax, ay, ctx.n, ctx.endElev, goal.band);
  return Math.min(...goal.place.rects.map((r) => rectGapFt(rect, r)));
}

/**
 * The feet a move costs: its path, or for a flight the larger of the path and the climb or descent to the height it
 * ends at (C12). A flight stopped part-way has already climbed to its path height and pays for it (R11).
 */
function moveCostFt(ctx: Ctx, pathFt: number, endsAtFt: number = ctx.endElev): number {
  return ctx.fly ? Math.max(pathFt, Math.abs(endsAtFt - ctx.startElev)) : pathFt;
}

/** The goal label minimising (provocations [safest], place penalty, feet, diagonals, y, x), or -1. */
function chooseEnd(ctx: Ctx, s: Search, goal: Goal, g0: number, caps: Caps, safest: boolean): number {
  let best = -1;
  let bestKey: number[] | null = null;
  const consider = (a: number) => {
    const ax = a % ctx.W;
    const ay = (a - ax) / ctx.W;
    let checked = false;
    let penalty: number | null = null;
    for (let p = 0; p < s.L; p++) {
      const label = a * s.L + p;
      if (s.g[label] >= INF) continue;
      if (!checked) {
        checked = true;
        penalty = goalPenalty(ctx, goal, ax, ay);
        if (penalty === null) return;
        if (!(goal.kind === 'square' && goal.transit) && !endable(ctx, ax, ay)) return;
      }
      const cost = moveCostFt(ctx, s.g[label] - g0);
      if (ctx.fly && g0 + cost > caps.main) continue;
      const key = [safest ? p : 0, penalty as number, cost, s.diag[label], ay, ax];
      if (!bestKey || compareKeys(key, bestKey) < 0) {
        bestKey = key;
        best = label;
      }
    }
  };
  if (goal.kind === 'square') {
    if (goal.at.x >= 0 && goal.at.y >= 0 && goal.at.x < ctx.W && goal.at.y < ctx.H) consider(goal.at.y * ctx.W + goal.at.x);
  } else {
    for (let a = 0; a < ctx.W * ctx.H; a++) consider(a);
  }
  return best;
}

/** Every reached, endable anchor with its cheapest feet (the start included). */
function reachedAnchors(ctx: Ctx, s: Search, g0: number, caps: Caps): { at: GridPoint; costFt: number }[] {
  const out: { at: GridPoint; costFt: number }[] = [];
  for (let a = 0; a < ctx.W * ctx.H; a++) {
    let g = INF;
    for (let p = 0; p < s.L; p++) g = Math.min(g, s.g[a * s.L + p]);
    if (g >= INF) continue;
    const ax = a % ctx.W;
    const ay = (a - ax) / ctx.W;
    if (!endable(ctx, ax, ay)) continue;
    const cost = moveCostFt(ctx, g - g0);
    if (ctx.fly && g0 + cost > caps.main) continue;
    out.push({ at: { x: ax, y: ay }, costFt: cost });
  }
  return out;
}

/**
 * The endable anchor within the allowance minimising (grid distance to the goal, feet, y, x). `elsewhere` leaves
 * out the start (an alternative destination must be somewhere else).
 */
function closestTo(ctx: Ctx, s: Search, goal: Goal, g0: number, caps: Caps, elsewhere = false): { at: GridPoint; costFt: number } | undefined {
  let best: { at: GridPoint; costFt: number } | undefined;
  let bestKey: number[] | null = null;
  for (const r of reachedAnchors(ctx, s, g0, caps)) {
    if (elsewhere && samePoint(r.at, ctx.start)) continue;
    const key = [goalDistance(ctx, goal, r.at.x, r.at.y), r.costFt, r.at.y, r.at.x];
    if (!bestKey || compareKeys(key, bestKey) < 0) {
      bestKey = key;
      best = r;
    }
  }
  return best;
}

/** Up to 3 endable anchors within the allowance nearest the requested anchor (by grid distance, feet, y, x). */
function openNear(ctx: Ctx, s: Search, at: GridPoint, g0: number, caps: Caps): GridPoint[] {
  const goal: Goal = { kind: 'square', at, transit: false };
  return reachedAnchors(ctx, s, g0, caps)
    .filter((r) => !samePoint(r.at, ctx.start))
    .map((r) => ({ r, key: [goalDistance(ctx, goal, r.at.x, r.at.y), r.costFt, r.at.y, r.at.x] }))
    .sort((a, b) => compareKeys(a.key, b.key))
    .slice(0, 3)
    .map((x) => x.r.at);
}

interface Chain {
  ok: boolean;
  /** Start first. */
  path: GridPoint[];
  /** Total movement at the end of the path (or of the last leg reached). */
  g: number;
  /** The leg that failed and its search. */
  failedLeg: number;
  search: Search | null;
  legG0: number;
}

/** Waypoint to waypoint (via), then to the goal; each leg picks its best label (spec §3.4.5). */
function chainSearch(ctx: Ctx, legs: readonly Goal[], g0: number, caps: Caps, safest: boolean): Chain {
  let from = ctx.start;
  let g = g0;
  const path: GridPoint[] = [point(ctx.start)];
  for (let i = 0; i < legs.length; i++) {
    const s = runSearch(ctx, from, g, caps, safest);
    const label = chooseEnd(ctx, s, legs[i], g0, caps, safest);
    if (label < 0) return { ok: false, path, g, failedLeg: i, search: s, legG0: g };
    const leg = labelPath(ctx, s, label);
    path.push(...leg.slice(1));
    from = leg[leg.length - 1];
    g = s.g[label];
  }
  return { ok: true, path, g, failedLeg: -1, search: null, legG0: g };
}

// ---------------------------------------------------------------------------
// Walking a path: costs, Opportunity Attacks and the stop rule (spec §3.4.6)
// ---------------------------------------------------------------------------

type WalkStop =
  | { kind: 'oa'; triggerIdx: number; reactors: ProvokedAttack[]; declinedIds: string[] }
  | { kind: 'unseen'; byId: string; at: GridPoint }
  | { kind: 'out-of-movement' };

interface Walk {
  /** Index in the path where the mover ends. */
  endIdx: number;
  /** Total movement at each walked index (gAt[0] = g0). */
  gAt: number[];
  stop: WalkStop | null;
  /** Every Opportunity Attack provoked on the walked part, in order (stop reactors, declined ones, unseen ones). */
  provoked: ProvokedAttack[];
  /** Hidden reactors during a player's move: no stop, DM-only. */
  unseen: ProvokedAttack[];
}

/** The mover's elevation at path index i of a route whose last index is `last` (a flier climbs first, lands last). */
function elevationAt(ctx: Ctx, i: number, last: number): number {
  if (i === 0) return ctx.startElev;
  return i === last ? ctx.endElev : ctx.pathElev;
}

/** Where the mover's height ends up: the requested end when the move completed, else where it stopped. */
function finalElevation(ctx: Ctx, endIdx: number, completed: boolean): number {
  if (completed) return ctx.endElev;
  return endIdx === 0 ? ctx.startElev : ctx.pathElev;
}

function provokedBy(r: Reactor, at: GridPoint, stepIndex: number): ProvokedAttack {
  return { reactorId: r.id, at: point(at), stepIndex, reachFt: r.reachFt, isHero: r.isHero, hidden: r.hidden };
}

/** The last index ≤ i where the mover can end (the start always can). */
function lastEndable(ctx: Ctx, path: readonly GridPoint[], i: number): number {
  for (let j = i; j > 0; j--) if (endable(ctx, path[j].x, path[j].y)) return j;
  return 0;
}

/** The first creature (initiative order) holding the footprint at p that the mover can't pass or end on. */
function blockerAt(ctx: Ctx, p: GridPoint, lo: number): string {
  const here = occupantsAt(ctx, p.x, p.y, lo).sort((a, b) => rankOf(ctx, a.id) - rankOf(ctx, b.id));
  return here[0]?.id ?? '';
}

/**
 * Walk `path` step by step on ctx's state (the stop rule, D31). `planned` (the player's move replayed on the true
 * map, C24) holds the totals the player view priced the path at: a step something unseen blocks, or makes dearer
 * than the preview (R9), ends the move at the last square before it the mover can end on. Without `planned` the
 * path always fits (it comes from a search on the same state).
 */
function walkPath(ctx: Ctx, path: readonly GridPoint[], g0: number, caps: Caps, by: 'player' | 'dm', planned?: readonly number[]): Walk {
  const k = path.length - 1;
  const fired = new Set<string>();
  const provoked: ProvokedAttack[] = [];
  const unseen: ProvokedAttack[] = [];
  const gAt = [g0];
  let g = g0;
  /** The Opportunity Attacks of one step; an 'oa' stop when a reactor that can stop the move triggers. */
  const trigger = (i: number, a: GridPoint, ea: number, b: GridPoint, eb: number): WalkStop | null => {
    const stopping: ProvokedAttack[] = [];
    const declinedHere: ProvokedAttack[] = [];
    const unseenHere: ProvokedAttack[] = [];
    for (const r of ctx.allReactors) {
      if (fired.has(r.id) || !leaves(ctx, r, a, ea, b, eb)) continue;
      fired.add(r.id);
      const pa = provokedBy(r, a, i);
      if (r.declined) declinedHere.push(pa);
      // D35: a hidden reactor never stops (or warns) the player's own move.
      else if (r.hidden && by === 'player') unseenHere.push(pa);
      else stopping.push(pa);
    }
    unseen.push(...byRank(ctx, unseenHere));
    provoked.push(...declinedHere, ...unseenHere);
    if (stopping.length === 0) return null;
    byRank(ctx, stopping);
    byRank(ctx, declinedHere);
    provoked.push(...stopping);
    return { kind: 'oa', triggerIdx: i, reactors: [...stopping, ...declinedHere], declinedIds: declinedHere.map((x) => x.reactorId) };
  };
  const finish = (endIdx: number, stop: WalkStop | null): Walk => {
    provoked.sort((x, y) => x.stepIndex - y.stepIndex || rankOf(ctx, x.reactorId) - rankOf(ctx, y.reactorId));
    return { endIdx, gAt, stop, provoked, unseen };
  };
  for (let i = 0; i < k; i++) {
    const a = path[i];
    const b = path[i + 1];
    const d = dirIndex(b.x - a.x, b.y - a.y);
    const code = d < 0 ? ILLEGAL : stepCode(ctx, a.x, a.y, d);
    if (code < 0) return finish(lastEndable(ctx, path, i), { kind: 'unseen', byId: blockerAt(ctx, b, levelOf(ctx.pathElev)), at: point(b) });
    const cost = stepCost(ctx, code, g, caps);
    if (planned && (cost < 0 || cost > planned[i + 1] - planned[i])) {
      return finish(lastEndable(ctx, path, i), { kind: 'unseen', byId: dearerBy(ctx, a, b), at: point(b) });
    }
    if (cost < 0) return finish(lastEndable(ctx, path, i), { kind: 'out-of-movement' });
    const stop = trigger(i, a, elevationAt(ctx, i, k), b, elevationAt(ctx, i + 1, k));
    if (stop) return finish(lastEndable(ctx, path, i), stop);
    g += cost;
    gAt.push(g);
  }
  if (k === 0 && ctx.startElev !== ctx.endElev) {
    // Straight up or down: leaving reach vertically provokes too.
    const stop = trigger(0, path[0], ctx.startElev, path[0], ctx.endElev);
    if (stop) return finish(0, stop);
  }
  if (k > 0 && !endable(ctx, path[k].x, path[k].y)) {
    // Replay: an unseen creature holds the square the plan ends on.
    return finish(lastEndable(ctx, path, k - 1), { kind: 'unseen', byId: blockerAt(ctx, path[k], levelOf(ctx.endElev)), at: point(path[k]) });
  }
  return finish(k, null);
}

/**
 * R9: the hidden creature that makes the step a → b dearer than the player's preview — a hostile one whose space is
 * Difficult Terrain, or one whose lasting Difficult Terrain aura covers a square entered (neither is in the player
 * view).
 */
function dearerBy(ctx: Ctx, a: GridPoint, b: GridPoint): string {
  const lo = levelOf(ctx.pathElev);
  const spaces = occupantsAt(ctx, b.x, b.y, lo).filter((o) => o.hidden && !areAllies(o.team, ctx.stats.team) && o.size !== 'Tiny');
  if (spaces.length > 0) return spaces.sort((x, y) => rankOf(ctx, x.id) - rankOf(ctx, y.id))[0].id;
  const entered: GridPoint[] = [];
  for (let y = b.y; y < b.y + ctx.n; y++) {
    for (let x = b.x; x < b.x + ctx.n; x++) if (!(x >= a.x && x < a.x + ctx.n && y >= a.y && y < a.y + ctx.n)) entered.push({ x, y });
  }
  for (const e of ctx.map.effects) {
    if (e.duration !== 'lasting' || e.spec.shape !== 'emanation' || !e.terrain.includes('difficult')) continue;
    const src = ctx.state.combatants.find((c) => c.id === e.spec.fromId);
    if (!src?.hidden || src.id === ctx.stats.id) continue;
    const rects = effectSquares(ctx.state, ctx.hero, e);
    if (entered.some((q) => rects.some((r) => q.x >= r.x0 && q.x <= r.x1 && q.y >= r.y0 && q.y <= r.y1))) return src.id;
  }
  return blockerAt(ctx, b, lo);
}

function rankOf(ctx: Ctx, id: string): number {
  ctx.ranks ??= initiativeRanks(ctx.state);
  return ctx.ranks.get(id) ?? 0;
}

/** Opportunity Attacks in initiative order (a no-op for fewer than two). */
function byRank(ctx: Ctx, list: ProvokedAttack[]): ProvokedAttack[] {
  return list.length < 2 ? list : list.sort((x, y) => rankOf(ctx, x.reactorId) - rankOf(ctx, y.reactorId));
}

/** Cumulative totals along a path that fits (the planned route). */
function pathTotals(ctx: Ctx, path: readonly GridPoint[], g0: number, caps: Caps): number[] {
  const out = [g0];
  let g = g0;
  for (let i = 0; i + 1 < path.length; i++) {
    const d = dirIndex(path[i + 1].x - path[i].x, path[i + 1].y - path[i].y);
    const code = d < 0 ? ILLEGAL : stepCode(ctx, path[i].x, path[i].y, d);
    const cost = code < 0 ? -1 : stepCost(ctx, code, g, caps);
    g += cost < 0 ? 5 * Math.max(1, code >> 1) : cost;
    out.push(g);
  }
  return out;
}

interface StepFacts {
  difficult: number;
  swam: number;
  passed: string[];
  entered: { label: string; at: GridPoint }[];
}

function labelsUnder(ctx: Ctx, ax: number, ay: number): Set<string> {
  const out = new Set<string>();
  for (let y = ay; y < ay + ctx.n; y++) {
    for (let x = ax; x < ax + ctx.n; x++) for (const l of ctx.moveCells.hazardsAt.get(y * ctx.W + x) ?? []) out.add(l);
  }
  return out;
}

/** Difficult and deep-water steps, creatures passed through, hazards and lasting effects entered (walked part). */
function stepFacts(ctx: Ctx, path: readonly GridPoint[], endIdx: number): StepFacts {
  const facts: StepFacts = { difficult: 0, swam: 0, passed: [], entered: [] };
  const seen = labelsUnder(ctx, path[0].x, path[0].y);
  const noticeEntries = !ctx.fly || ctx.pathElev === 0;
  for (let i = 0; i < endIdx; i++) {
    const a = path[i];
    const b = path[i + 1];
    const d = dirIndex(b.x - a.x, b.y - a.y);
    const code = d < 0 ? ILLEGAL : stepCode(ctx, a.x, a.y, d);
    if (code >= 0) {
      if ((code >> 1) - 1 - (ctx.crawl ? 1 : 0) > 0) facts.difficult++;
      if (code & 1) facts.swam++;
    }
    if (i + 1 < endIdx) {
      for (const o of occupantsAt(ctx, b.x, b.y, levelOf(ctx.pathElev))) if (!facts.passed.includes(o.id)) facts.passed.push(o.id);
    }
    if (noticeEntries) {
      for (const label of labelsUnder(ctx, b.x, b.y)) {
        if (seen.has(label)) continue;
        seen.add(label);
        facts.entered.push({ label, at: point(b) });
      }
    }
  }
  facts.passed.sort((x, y) => rankOf(ctx, x) - rankOf(ctx, y));
  return facts;
}

/** Lasting emanations of the mover that now cover creatures they didn't (srd:spell:spirit-guardians). */
function emanationsReached(before: CombatState, after: CombatState, hero: Character | null, moverId: string): MoveNote[] {
  const notes: MoveNote[] = [];
  const own = (after.map?.effects ?? []).filter(
    (e: MapEffect) => e.duration === 'lasting' && e.spec.shape === 'emanation' && e.spec.fromId === moverId,
  );
  if (own.length === 0) return notes;
  const covered = (state: CombatState, e: MapEffect): Set<string> => {
    const rects = effectSquares(state, hero, e);
    return new Set(occupants(state, hero).filter((o) => o.id !== moverId && rects.some((r) => rectsOverlap(r, o.rect))).map((o) => o.id));
  };
  for (const e of own) {
    const was = covered(before, e);
    const ids = [...covered(after, e)].filter((id) => !was.has(id));
    if (ids.length > 0) notes.push({ kind: 'emanation-reached', label: e.label, ids });
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

interface Write {
  moverId: string;
  to: GridPoint;
  elevationFt: number;
  removeProne: boolean;
  /** The new turn record (null: map.turn untouched). */
  turn: MapTurn | null;
  /** A new stop, or null: none from this move (the mover's old stop is cleared either way). */
  stop: MapStop | null;
  reactionsUsed: string[];
}

/** §2.3: a stop counts only in its round, while its mover is the current creature. */
function stopIsValid(state: CombatState, stop: MapStop): boolean {
  return stop.round === state.round && currentCombatant(state)?.id === stop.moverId;
}

/**
 * R12: the mover's own valid stop that a forced move, a teleport or a placement ends. Its reactors made their
 * Opportunity Attacks (that is often why it was pushed), so those that didn't let it go spend their Reactions, as
 * when the move goes on (D33); the note says so.
 */
function endedStop(state: CombatState, moverId: string): { reactionsUsed: string[]; note: MoveNote } | null {
  const stop = state.map?.stop;
  if (!stop || stop.moverId !== moverId || !stopIsValid(state, stop)) return null;
  return {
    reactionsUsed: stop.reactorIds.filter((id) => !stop.declinedIds.includes(id)),
    note: { kind: 'stop-continued', reactorIds: [...stop.reactorIds], declinedIds: [...stop.declinedIds] },
  };
}

/**
 * D42: during a hidden creature's turn, the turn the player view shows in its place (the last visible creature's),
 * else null. Its turn record and stop stay until a visible creature's turn begins (battleMap's pruneMap rule).
 */
function shownTurnWhileHidden(state: CombatState): { id: string; round: number } | null {
  if (!currentCombatant(state)?.hidden) return null;
  const view = playerView(state);
  const shown = currentCombatant(view);
  return shown ? { id: shown.id, round: view.round } : null;
}

function commit(state: CombatState, w: Write): CombatState {
  const map = state.map as BattleMap;
  const combatants = state.combatants.map((c) => {
    let next = c;
    if (c.id === w.moverId) {
      next = { ...c, position: point(w.to) };
      if (w.elevationFt > 0) next.elevationFt = w.elevationFt;
      else delete next.elevationFt;
      if (w.removeProne) next.conditions = c.conditions.filter((k) => conditionKey(k.id) !== 'prone');
    }
    if (w.reactionsUsed.includes(c.id) && !c.reactionUsed) next = { ...next, reactionUsed: true };
    return next;
  });
  const nextMap: BattleMap = { ...map };
  // While a hidden creature has the turn, the player still sees the shown turn's record and stop: neither may change
  // (amendment 8). The hidden creature's own record and stop then aren't kept (the map holds one of each).
  const shown = shownTurnWhileHidden(state);
  const isShown = (round: number, id: string) => shown !== null && round === shown.round && id === shown.id;
  if (w.turn && !(map.turn && isShown(map.turn.round, map.turn.combatantId))) nextMap.turn = w.turn;
  // The mover's own stop ends when it moves again; anyone else's is kept while it still counts (pruned otherwise).
  const old = map.stop;
  const othersStop = old && old.moverId !== w.moverId ? old : undefined;
  const stop =
    othersStop && isShown(othersStop.round, othersStop.moverId)
      ? othersStop
      : (w.stop ?? (othersStop && stopIsValid(state, othersStop) ? othersStop : undefined));
  if (stop) nextMap.stop = stop;
  else delete nextMap.stop;
  return { ...state, combatants, map: nextMap };
}

function appendMove(turn: MapTurn, move: TurnMove | null): TurnMove[] {
  if (!move || turn.moves.length >= MAP_LIMITS.maxTurnMoves) return turn.moves;
  return [...turn.moves, move];
}

function refused(moverId: string, refusal: MoveRefusal): Refused {
  return { status: 'refused', moverId, refusal };
}

function bad(moverId: string, problem: string): Refused {
  return refused(moverId, { code: 'bad-request', problem });
}

type Planned = { plan: MovePlan; write: Write | null };

// ---------------------------------------------------------------------------
// Willing moves: kind 'move' and 'off-turn' (spec §3.4.2–3.4.6)
// ---------------------------------------------------------------------------

interface WillingPlan {
  ctx: Ctx;
  req: MoveRequest;
  mover: Combatant;
  stats: MoverStats;
  mode: MoveMode;
  /** The full planned route, start first. */
  path: GridPoint[];
  g0: number;
  caps: Caps;
  standing: boolean;
  standCost: number;
  tookDash: boolean;
  dashFt: number;
  dashes: number;
  disengaged: boolean;
  newlyDisengaged: boolean;
  continuing: MapStop | null;
  /** kind 'move': the current turn record (fresh when stale); null for off-turn. */
  turn: MapTurn | null;
  offTurnAllowance: number;
}

type WillingResult = { ok: true; plan: WillingPlan } | { ok: false; refused: Refused };

/**
 * A creature on the ground that can't simply fly over drops into a pit it is moved over (pits have no depth in v1:
 * PIT_DEPTH_FT; app convention C26). Anything above the ground stays where it is.
 */
function canFall(stats: MoverStats, elevationFt: number): boolean {
  return elevationFt === 0 && !(stats.fly > 0 && noFly(stats, 0, false) === null);
}

/** Why this creature can't fly now (srd:rule:flying; srd:rule:hover), or null. */
function noFly(stats: MoverStats, elevationFt: number, stayProne: boolean): string | null {
  if (stats.hover) return null;
  if (stats.incapacitated) return elevationFt > 0 ? 'Incapacitated: it falls instead' : "Incapacitated: it can't fly";
  if (stats.prone && elevationFt > 0) return 'Prone: it falls instead';
  if (stats.prone && stayProne) return "Prone: it can't fly without standing up";
  return null;
}

/** The goal of a willing move, or a refusal that needs no search. */
function resolveGoal(ctx: Ctx, req: MoveRequest, stats: MoverStats): Goal | MoveRefusal {
  const to = req.to;
  if (!to) return { code: 'bad-request', problem: 'A move needs "to": a square, a creature or a place.' };
  if (to.kind === 'square') return squareGoal(ctx, to.at, false);
  if (to.kind === 'creature') {
    const target = ctx.state.combatants.find((c) => c.id === to.id);
    if (!target) return { code: 'bad-request', problem: `No combatant "${to.id}" on the map.` };
    if (target.id === stats.id) return { code: 'bad-request', problem: `${stats.name} can't move to itself.` };
    if (!target.position) return { code: 'bad-request', problem: `${target.name} isn't on the map.` };
    const within = to.withinFt !== undefined ? Math.max(0, toInt(to.withinFt)) : stats.reachFt;
    return { kind: 'creature', band: bandOf(target, ctx.hero), withinFt: within };
  }
  const place = ctx.map.places.find((p) => p.id === to.placeId);
  if (!place) return { code: 'bad-request', problem: `No place "${to.placeId}" on the map.` };
  return { kind: 'place', place };
}

function squareGoal(ctx: Ctx, at: GridPoint, transit: boolean): Goal | MoveRefusal {
  if (!isSquare(at)) return { code: 'bad-request', problem: 'A square needs whole-number coordinates.' };
  if (!fits(at, ctx.n, ctx.W, ctx.H)) return { code: 'off-map', to: point(at) };
  const own = anchorRect(ctx.start.x, ctx.start.y, ctx.n);
  for (let y = at.y; y < at.y + ctx.n; y++) {
    for (let x = at.x; x < at.x + ctx.n; x++) {
      // The squares it already stands on never block it (R8: a creature in a pit can stand up where it fell).
      if (ctx.placed && x >= own.x0 && x <= own.x1 && y >= own.y0 && y <= own.y1) continue;
      const f = ctx.cells.flags[y * ctx.W + x];
      if (f & CELL.BLOCKS_MOVE || (!ctx.fly && f & CELL.PIT)) {
        return { code: 'blocked', at: { x, y }, what: blockedWhat(blockingFeature(ctx.map, x, y, ctx.fly)) };
      }
    }
  }
  return { kind: 'square', at: point(at), transit };
}

function isRefusal(x: Goal | MoveRefusal): x is MoveRefusal {
  return 'code' in x;
}

/** The first source the end is closer to than the start, else the first source a step of the path approaches. */
function fearSource(ctx: Ctx, path: readonly GridPoint[]): string | null {
  const end = path[path.length - 1];
  for (const src of ctx.fear) {
    if (gapFt(end.x, end.y, ctx.n, ctx.endElev, src) < gapFt(ctx.start.x, ctx.start.y, ctx.n, ctx.startElev, src)) return src.id;
  }
  for (let i = 0; i + 1 < path.length; i++) {
    for (const src of ctx.fear) {
      if (gapFt(path[i + 1].x, path[i + 1].y, ctx.n, ctx.pathElev, src) < gapFt(path[i].x, path[i].y, ctx.n, ctx.pathElev, src)) return src.id;
    }
  }
  return ctx.fear[0]?.id ?? null;
}

/**
 * R5: the waypoints a repeated stopped move still has ahead (D33: "repeat the same call"). One it already passed is
 * off the stop's remaining route and was walked this turn (with no turn record, an off-turn move: just off the
 * route); any other, a new one included, still counts.
 */
function waypointsAhead(state: CombatState, stop: MapStop, via: readonly GridPoint[]): GridPoint[] {
  const turn = state.map?.turn;
  const walked = turn && turn.combatantId === stop.moverId && turn.round === stop.round ? turn.moves.flatMap((m) => [m.from, ...m.path]) : null;
  const on = (list: readonly GridPoint[], p: GridPoint) => list.some((q) => samePoint(p, q));
  return via.filter((p) => on(stop.route, p) || (walked !== null && !on(walked, p)));
}

function planWilling(state: CombatState, hero: Character | null, req: MoveRequest): WillingResult {
  const fail = (refusal: MoveRefusal): WillingResult => ({ ok: false, refused: refused(req.moverId, refusal) });
  const map = state.map;
  if (!map) return fail({ code: 'bad-request', problem: 'This fight has no battle map.' });
  const mover = state.combatants.find((c) => c.id === req.moverId);
  if (!mover) return fail({ code: 'bad-request', problem: `No combatant "${req.moverId}".` });
  if (!mover.position) return fail({ code: 'unplaced' });
  const stats = moverStats(state, hero, mover.id) as MoverStats;
  const current = currentCombatant(state);
  const kindMove = req.kind === 'move';
  if (kindMove && current?.id !== mover.id) return fail({ code: 'not-their-turn', currentId: current?.id ?? null });
  // A defeated creature doesn't move by itself (app convention; the DM can still place its marker).
  if (stats.defeated) return fail({ code: 'speed-zero', because: 'Defeated' });
  if (stats.speedZero) return fail({ code: 'speed-zero', because: stats.speedZero });
  const startElev = clampElevation(mover.elevationFt ?? 0);
  const mode = req.mode ?? defaultMode(stats, startElev);
  const fly = mode === 'fly';
  if (fly) {
    if (stats.fly <= 0) return fail({ code: 'bad-request', problem: `${stats.name} has no Fly Speed.` });
    const why = noFly(stats, startElev, req.stayProne === true);
    if (why) return fail({ code: 'speed-zero', because: why });
  }
  const endElev = fly && req.elevationFt !== undefined ? clampElevation(req.elevationFt) : startElev;
  const turn = kindMove ? (currentTurn(state) as MapTurn) : null;
  const speedFt = fly ? stats.fly : stats.walk;
  // Dash (srd:rule:dash): the moving speed's value per Dash; a repeated dash: true is a no-op unless dashAgain.
  const tookDash = kindMove && (req.dash === true || req.dashAgain === true) && ((turn?.dashes ?? 0) === 0 || req.dashAgain === true);
  const dashFt = (turn?.dashFt ?? 0) + (tookDash ? speedFt : 0);
  const dashes = (turn?.dashes ?? 0) + (tookDash ? 1 : 0);
  const wasDisengaged = turn?.disengaged ?? false;
  const disengaged = wasDisengaged || req.disengage === true;
  const moved = turn?.movedFt ?? 0;
  const offTurnAllowance = kindMove ? 0 : req.budgetFt !== undefined ? Math.max(0, toInt(req.budgetFt)) : speedFt;
  const caps: Caps = kindMove
    ? turnCaps(stats, speedFt, dashFt, dashes)
    : { main: offTurnAllowance, swim: req.budgetFt !== undefined ? offTurnAllowance : stats.swim };
  // Standing up (srd:condition:prone): half the walking Speed, before moving; DM-made moves stand by default.
  const standing = stats.prone && req.stayProne !== true;
  const standCost = Math.floor(stats.walk / 2);
  if (standing) {
    const left = caps.main - moved;
    if (stats.walk <= 0 || left < standCost) return fail({ code: 'cant-stand', costFt: standCost, leftFt: Math.max(0, left) });
  }
  const stop = map.stop;
  const continuing = stop && stop.moverId === mover.id && stop.round === state.round && samePoint(stop.at, mover.position) ? stop : null;
  const ctxOpts: CtxOpts = {
    fly,
    startElev,
    endElev,
    crawl: stats.prone && !standing,
    fearIds: stats.frightenedOfIds,
    ignore: new Set(continuing?.reactorIds ?? []),
    declined: new Set(req.declinedIds ?? []),
    reactorsOn: !disengaged,
  };
  const ctx = buildCtx(state, hero, mover, stats, ctxOpts);
  if (!ctx) return fail({ code: 'unplaced' });
  const g0 = moved + (standing ? standCost : 0);
  const goal = resolveGoal(ctx, req, stats);
  if (isRefusal(goal)) return fail(goal);
  const legs: Goal[] = [];
  for (const wp of continuing && req.via?.length ? waypointsAhead(state, continuing, req.via) : (req.via ?? [])) {
    const leg = squareGoal(ctx, wp, true);
    if (isRefusal(leg)) return fail(leg);
    legs.push(leg);
  }
  legs.push(goal);
  const safest = (req.prefer ?? 'safest') === 'safest';
  const base = {
    ctx,
    req,
    mover,
    stats,
    mode,
    g0,
    caps,
    standing,
    standCost,
    tookDash,
    dashFt,
    dashes,
    disengaged,
    newlyDisengaged: disengaged && !wasDisengaged,
    continuing,
    turn,
    offTurnAllowance,
  };
  const ok = (path: GridPoint[]): WillingResult => ({ ok: true, plan: { ...base, path } });
  /** partial: true turns a refusal into a move to the suggested square (the legs before `leg`, then there). */
  const toward = (leg: number, target: GridPoint | undefined, refusal: MoveRefusal): WillingResult => {
    if (!req.partial || !target) return fail(refusal);
    const chain = chainSearch(ctx, [...legs.slice(0, leg), { kind: 'square', at: target, transit: false }], g0, caps, safest);
    return chain.ok ? ok(chain.path) : fail(refusal);
  };
  const last = legs.length - 1;
  // C13: a square closer to a source of fear can't be reached willingly at all.
  if (goal.kind === 'square' && ctx.fear.length > 0) {
    const src = ctx.fear.find(
      (f) => gapFt(goal.at.x, goal.at.y, ctx.n, endElev, f) < gapFt(ctx.start.x, ctx.start.y, ctx.n, startElev, f),
    );
    if (src) {
      const near = chainSearch(ctx, legs, g0, caps, safest);
      const alternative = near.search ? closestTo(ctx, near.search, legs[near.failedLeg], g0, caps, true)?.at : undefined;
      const refusal: MoveRefusal = { code: 'frightened', sourceId: src.id, ...(alternative ? { alternative } : {}) };
      return toward(Math.max(0, near.failedLeg), alternative, refusal);
    }
  }
  const chain = chainSearch(ctx, legs, g0, caps, safest);
  if (chain.ok) return ok(chain.path);
  const failed = chain.search as Search;
  const failedLeg = chain.failedLeg;
  // The goal square is someone's space: say so, with the nearest open squares.
  if (goal.kind === 'square' && failedLeg === last && !endable(ctx, goal.at.x, goal.at.y)) {
    const open = openNear(ctx, failed, goal.at, g0, caps);
    const byId = blockerAt(ctx, goal.at, levelOf(endElev));
    return toward(failedLeg, open[0], { code: 'occupied', at: point(goal.at), byId, open });
  }
  const closest = closestTo(ctx, failed, legs[failedLeg], g0, caps);
  // Frightened: it could get there if only it dared.
  if (ctx.fear.length > 0) {
    const brave = buildCtx(state, hero, mover, stats, { ...ctxOpts, fearIds: [] }) as Ctx;
    const daring = chainSearch(brave, legs, g0, caps, safest);
    if (daring.ok) {
      const alternative = closestTo(ctx, failed, legs[failedLeg], g0, caps, true)?.at;
      const refusal: MoveRefusal = { code: 'frightened', sourceId: fearSource(ctx, daring.path) ?? '', ...(alternative ? { alternative } : {}) };
      return toward(failedLeg, alternative, refusal);
    }
  }
  const unlimited = chainSearch(ctx, legs, g0, { main: INF, swim: INF }, safest);
  if (!unlimited.ok) return toward(failedLeg, closest?.at, { code: 'no-route', ...(closest ? { closest } : {}) });
  // A Dash adds the moving speed, or the Swim Speed for a swimmer (R10).
  const dashAvailable = kindMove && !tookDash && (turn?.dashes ?? 0) === 0 && (speedFt > 0 || ctx.swims);
  const dashWouldReach = dashAvailable && chainSearch(ctx, legs, g0, turnCaps(stats, speedFt, dashFt + speedFt, dashes + 1), safest).ok;
  // In deep water a swimmer has what its Swim Speed allows, if that is more.
  const allowance = ctx.swims && inDeepWater(ctx.cells, ctx.start, ctx.n) ? Math.max(caps.main, caps.swim) : caps.main;
  return toward(failedLeg, closest?.at, {
    code: 'too-far',
    needFt: moveCostFt(ctx, unlimited.g - g0),
    leftFt: Math.max(0, allowance - g0),
    route: unlimited.path.slice(1),
    ...(closest ? { closest } : {}),
    dashWouldReach,
  });
}

function stopOpts(req: MoveRequest, mode: MoveMode): MapStop['opts'] {
  const opts: MapStop['opts'] = {};
  if (req.dash) opts.dash = true;
  if (req.disengage) opts.disengage = true;
  opts.prefer = req.prefer ?? 'safest';
  if (req.mode) opts.mode = mode;
  return opts;
}

/**
 * The walk, the notes, the turn record and the stop of a willing move (DM-made, or the player's replay: `preview`
 * holds the totals the player view priced its path at).
 */
function finishWilling(state: CombatState, wp: WillingPlan, ctx: Ctx, preview?: readonly number[]): { planned: Planned; walk: Walk } {
  const { req, stats, path, g0, caps } = wp;
  const by = req.by;
  const walk = walkPath(ctx, path, g0, caps, by, preview);
  const k = path.length - 1;
  const endIdx = walk.endIdx;
  const end = path[endIdx];
  const taken = path.slice(1, endIdx + 1).map(point);
  const completed = walk.stop === null;
  const elevationFt = finalElevation(ctx, endIdx, completed);
  const costFt = moveCostFt(ctx, walk.gAt[endIdx] - g0, elevationFt);
  const facts = stepFacts(ctx, path, endIdx);
  const oaStop = walk.stop?.kind === 'oa' ? walk.stop : null;

  const notes: MoveNote[] = [];
  if (wp.standing) notes.push({ kind: 'stood-up', costFt: wp.standCost });
  if (ctx.crawl && taken.length > 0) notes.push({ kind: 'crawled', feet: 5 * taken.length });
  if (facts.difficult > 0) notes.push({ kind: 'difficult', squares: facts.difficult });
  if (facts.swam > 0) notes.push({ kind: 'swam', squares: facts.swam });
  if (facts.passed.length > 0) notes.push({ kind: 'passed-through', ids: facts.passed });
  for (const e of facts.entered) notes.push({ kind: 'entered', label: e.label, at: e.at });
  for (const u of walk.unseen) notes.push({ kind: 'oa-unseen', reactorId: u.reactorId, at: point(u.at) });
  if (walk.stop?.kind === 'unseen') notes.push({ kind: 'blocked-by-unseen', byId: walk.stop.byId, at: walk.stop.at });
  const declinedAll = new Set([...(req.declinedIds ?? []), ...(wp.continuing?.declinedIds ?? [])]);
  if (wp.continuing) {
    notes.push({ kind: 'stop-continued', reactorIds: [...wp.continuing.reactorIds], declinedIds: [...declinedAll] });
  }
  if (!ctx.fly && elevationFt > 0 && stats.fly === 0) notes.push({ kind: 'airborne-walker', elevationFt });

  // The turn record (kind move only; srd:rule:speed — one movedFt counter for every speed).
  const stoppedHere = walk.stop !== null;
  const recordMove = taken.length > 0 || wp.standing || walk.provoked.length > 0 || stoppedHere;
  const move: TurnMove | null = recordMove
    ? {
        by,
        kind: taken.length === 0 && wp.standing && !stoppedHere && walk.provoked.length === 0 ? 'stand' : req.kind,
        from: point(path[0]),
        to: point(end),
        path: taken.slice(0, MAP_LIMITS.maxPathSquares),
        costFt: taken.length === 0 && wp.standing && !stoppedHere ? wp.standCost : costFt,
        ...(wp.tookDash ? { dashed: true } : {}),
        ...(wp.newlyDisengaged ? { disengaged: true } : {}),
        ...(wp.standing ? { stoodUp: true } : {}),
        provoked: walk.provoked.map((p) => ({ reactorId: p.reactorId, at: point(p.at), hidden: p.hidden })),
        entered: facts.entered.map((e) => e.label),
        ...(walk.stop && walk.stop.kind !== 'oa' ? { revealedHidden: true } : {}),
        ...(walk.stop?.kind === 'unseen' ? { blockedById: walk.stop.byId } : {}),
      }
    : null;
  let turn: MapTurn | null = null;
  if (wp.turn) {
    turn = {
      ...wp.turn,
      movedFt: g0 + costFt,
      dashFt: wp.dashFt,
      dashes: wp.dashes,
      disengaged: wp.disengaged,
      stoodUp: wp.turn.stoodUp || wp.standing,
      moves: appendMove(wp.turn, move),
    };
  }
  const budget: TurnBudget = turn
    ? budgetOf(stats, wp.mode, turn, stats.prone && !wp.standing, inDeepWater(ctx.cells, end, ctx.n))
    : {
        ...budgetOf(stats, wp.mode, null, stats.prone && !wp.standing),
        speedFt: wp.offTurnAllowance,
        movedFt: g0 + costFt,
        leftFt: Math.max(0, wp.offTurnAllowance - g0 - costFt),
        dashAddsFt: 0,
        disengaged: wp.disengaged,
        stoodUp: wp.standing,
      };

  const totals = pathTotals(ctx, path, g0, caps);
  const newStop: MapStop | null = oaStop
    ? {
        moverId: stats.id,
        by,
        round: state.round,
        at: point(end),
        ...(oaStop.triggerIdx !== endIdx ? { triggerAt: point(path[oaStop.triggerIdx]) } : {}),
        destination: point(path[k]),
        route: path.slice(endIdx + 1, endIdx + 1 + MAP_LIMITS.maxPathSquares).map(point),
        reactorIds: oaStop.reactors.map((r) => r.reactorId),
        declinedIds: oaStop.declinedIds,
        opts: stopOpts(req, wp.mode),
      }
    : null;
  const reactionsUsed = wp.continuing ? wp.continuing.reactorIds.filter((id) => !declinedAll.has(id)) : [];
  // A stop for something unseen is news for the DM even on the first step (P3): its 0-ft record is written.
  const nothingChanged =
    walk.stop === null &&
    taken.length === 0 &&
    !wp.standing &&
    !wp.tookDash &&
    !wp.newlyDisengaged &&
    !wp.continuing &&
    !newStop &&
    walk.provoked.length === 0 &&
    elevationFt === ctx.startElev &&
    !(state.map?.stop && state.map.stop.moverId === stats.id);
  const write: Write | null = nothingChanged
    ? null
    : {
        moverId: stats.id,
        to: end,
        elevationFt,
        removeProne: wp.standing && !stats.isHero,
        turn,
        stop: newStop,
        reactionsUsed,
      };

  const base = {
    moverId: stats.id,
    kind: req.kind,
    from: point(path[0]),
    path: taken,
    costFt,
    budget,
    provoked: walk.provoked,
    notes,
    heroStoodUp: wp.standing && stats.isHero,
  };
  const plan: MovePlan = oaStop
    ? {
        ...base,
        status: 'stopped',
        at: point(end),
        triggerAt: point(path[oaStop.triggerIdx]),
        destination: point(path[k]),
        reactors: oaStop.reactors,
        remainingPath: path.slice(endIdx + 1).map(point),
        // What the repeat costs from here: the rest of the path (a flight: or the height still to change).
        remainingCostFt: ctx.fly
          ? Math.max(totals[k] - walk.gAt[endIdx], Math.abs(ctx.endElev - elevationFt))
          : Math.max(0, totals[k] - walk.gAt[endIdx]),
      }
    : { ...base, status: 'moved', to: point(end) };
  return { planned: { plan, write }, walk };
}

// ---------------------------------------------------------------------------
// Forced movement, teleportation and placement (spec §3.4.7)
// ---------------------------------------------------------------------------

/** A point in doubled coordinates for an aim or a source. */
function refPoint(state: CombatState, hero: Character | null, ref: MapRef): { x2: number; y2: number } | null {
  if (ref.kind === 'square') return { x2: 2 * ref.at.x + 1, y2: 2 * ref.at.y + 1 };
  if (ref.kind === 'corner') return { x2: 2 * ref.x, y2: 2 * ref.y };
  if (ref.kind === 'creature') {
    const c = state.combatants.find((x) => x.id === ref.id);
    if (!c?.position) return null;
    const r = footprint(c.position, combatantSize(c, hero));
    return { x2: r.x0 + r.x1 + 1, y2: r.y0 + r.y1 + 1 };
  }
  return null;
}

/** An 8-connected straight line of anchors from a to b (a excluded). */
function lineAnchors(a: GridPoint, b: GridPoint): GridPoint[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const n = Math.max(Math.abs(dx), Math.abs(dy));
  const round = (v: number) => Math.sign(v) * Math.round(Math.abs(v));
  const out: GridPoint[] = [];
  for (let i = 1; i <= n; i++) out.push({ x: a.x + round((dx * i) / n), y: a.y + round((dy * i) / n) });
  return out;
}

/** The current creature's record after a move of `kind` that spent `spendFt` (forced/teleport/place). */
function recordOther(
  state: CombatState,
  stats: MoverStats,
  move: { kind: MoveKind; by: 'player' | 'dm'; from: GridPoint; to: GridPoint; path: GridPoint[]; spendFt: number; entered: string[] },
): MapTurn | null {
  if (currentCombatant(state)?.id !== stats.id) return null;
  const turn = currentTurn(state) as MapTurn;
  const record: TurnMove = {
    by: move.by,
    kind: move.kind,
    from: point(move.from),
    to: point(move.to),
    path: move.path.slice(0, MAP_LIMITS.maxPathSquares),
    costFt: move.spendFt,
    provoked: [],
    entered: move.entered,
  };
  return { ...turn, movedFt: turn.movedFt + move.spendFt, moves: appendMove(turn, record) };
}

/** The current creature's budget after a forced move, teleport or placement; null for anyone else. */
function otherBudget(stats: MoverStats, turn: MapTurn | null, elevationFt: number, inDeep: boolean): TurnBudget | null {
  return turn ? budgetOf(stats, defaultMode(stats, elevationFt), turn, stats.prone, inDeep) : null;
}

function planForced(state: CombatState, hero: Character | null, req: MoveRequest, ctx: Ctx): Planned {
  const { stats, map } = ctx;
  const id = stats.id;
  const start = ctx.start;
  const n = ctx.n;
  let steps: GridPoint[];
  let wanted: number;
  if (req.push && req.to) return { plan: bad(id, 'A forced move takes either "to" or "push", not both.'), write: null };
  if (req.push) {
    const push = req.push;
    const given = [push.awayFrom, push.toward, push.direction].filter((x) => x !== undefined).length;
    if (given !== 1) return { plan: bad(id, 'A push needs exactly one of "away from", "toward" or "direction".'), write: null };
    wanted = Math.max(1, Math.floor(toInt(push.distanceFt) / 5));
    let dir: CompassDirection;
    if (push.direction) dir = push.direction;
    else {
      const ref = (push.awayFrom ?? push.toward) as MapRef;
      const src = refPoint(state, hero, ref);
      if (!src) return { plan: bad(id, 'The push needs a square, a corner or a creature on the map to push from.'), write: null };
      const cx = 2 * start.x + n;
      const cy = 2 * start.y + n;
      const vx = push.awayFrom ? cx - src.x2 : src.x2 - cx;
      const vy = push.awayFrom ? cy - src.y2 : src.y2 - cy;
      if (vx === 0 && vy === 0) return { plan: bad(id, `${stats.name} is at the centre of the push: give a direction.`), write: null };
      dir = snapDirection(vx, vy);
    }
    const v = dirVector(dir);
    steps = Array.from({ length: wanted }, (_, i) => ({ x: start.x + v.dx * (i + 1), y: start.y + v.dy * (i + 1) }));
  } else if (req.to?.kind === 'square' && isSquare(req.to.at)) {
    steps = lineAnchors(start, req.to.at);
    wanted = steps.length;
  } else {
    return { plan: bad(id, 'A forced move needs "push" (a distance and a direction or source) or a square "to".'), write: null };
  }
  const notes: MoveNote[] = [];
  const path: GridPoint[] = [];
  const falls = canFall(stats, ctx.startElev);
  const seen = labelsUnder(ctx, start.x, start.y);
  const entered: string[] = [];
  let cur = start;
  for (const next of steps) {
    // C17: stop before the map edge, blocking terrain or any creature (no costs, no corner rule).
    let by: string | null = null;
    if (next.x < 0 || next.y < 0 || next.x + n > ctx.W || next.y + n > ctx.H) by = 'the map edge';
    let pit: TerrainFeature | null = null;
    if (!by) {
      for (let y = next.y; y < next.y + n && !by; y++) {
        for (let x = next.x; x < next.x + n; x++) {
          if (x >= cur.x && x < cur.x + n && y >= cur.y && y < cur.y + n) continue;
          const f = ctx.cells.flags[y * ctx.W + x];
          if (f & CELL.BLOCKS_MOVE) {
            by = obstacleName(blockingFeature(map, x, y, true));
            break;
          }
          if (f & CELL.PIT && falls && !pit) pit = pitAt(map, x, y);
        }
      }
    }
    if (!by) {
      const here = occupantsAt(ctx, next.x, next.y, levelOf(ctx.startElev)).sort((a, b) => rankOf(ctx, a.id) - rankOf(ctx, b.id));
      if (here.length > 0) by = state.combatants.find((c) => c.id === here[0].id)?.name ?? 'a creature';
    }
    if (by) {
      notes.push({ kind: 'push-stopped', at: point(cur), by, shortFt: 5 * (wanted - path.length) });
      break;
    }
    path.push(point(next));
    for (const label of labelsUnder(ctx, next.x, next.y)) {
      if (seen.has(label)) continue;
      seen.add(label);
      entered.push(label);
      notes.push({ kind: 'entered', label, at: point(next) });
    }
    cur = next;
    if (pit) {
      notes.push(fellNote(pit, PIT_DEPTH_FT));
      break;
    }
  }
  const fell = notes.some((x) => x.kind === 'fell');
  const elevationFt = fell ? 0 : ctx.startElev;
  // A Grappled creature taken beyond its grappler's reach is free (srd:rule:grappling).
  for (const k of combatantConditions(ctx.mover, hero)) {
    if (conditionKey(k.id) !== 'grappled' || !k.source?.trim()) continue;
    const grappler = findSource(state, k.source);
    if (!grappler?.position || grappler.id === id) continue;
    const reach = moverStats(state, hero, grappler.id)?.reachFt ?? 5;
    if (gapFt(cur.x, cur.y, n, elevationFt, bandOf(grappler, hero)) > reach) notes.push({ kind: 'grapple-ended', grapplerId: grappler.id });
  }
  const turn = recordOther(state, stats, { kind: 'forced', by: req.by, from: start, to: cur, path, spendFt: 0, entered });
  const ended = path.length > 0 ? endedStop(state, id) : null;
  if (ended) notes.push(ended.note);
  const plan: MovePlan = {
    status: 'moved',
    moverId: id,
    kind: 'forced',
    from: point(start),
    path,
    to: point(cur),
    costFt: 0,
    budget: otherBudget(stats, turn, elevationFt, inDeepWater(ctx.cells, cur, n)),
    provoked: [],
    notes,
    heroStoodUp: false,
  };
  const write: Write | null =
    path.length === 0
      ? null
      : { moverId: id, to: cur, elevationFt, removeProne: false, turn, stop: null, reactionsUsed: ended?.reactionsUsed ?? [] };
  return { plan, write };
}

/** C18: a footprint a creature can appear in: on the map, no blocking terrain, nobody else there (Tiny sharing aside). */
function legalSpot(ctx: Ctx, ax: number, ay: number): 'ok' | 'blocked' | 'occupied' {
  if (ax < 0 || ay < 0 || ax + ctx.n > ctx.W || ay + ctx.n > ctx.H) return 'blocked';
  for (let y = ay; y < ay + ctx.n; y++) {
    for (let x = ax; x < ax + ctx.n; x++) if (ctx.cells.flags[y * ctx.W + x] & CELL.BLOCKS_MOVE) return 'blocked';
  }
  return endable(ctx, ax, ay) ? 'ok' : 'occupied';
}

/** The nearest legal anchor by (grid distance from the requested anchor, grid distance from the start, y, x). */
function nearestSpot(ctx: Ctx, requested: GridPoint, start: GridPoint | null): GridPoint | null {
  const want = anchorRect(requested.x, requested.y, ctx.n);
  const from = start ? anchorRect(start.x, start.y, ctx.n) : null;
  let best: GridPoint | null = null;
  let bestKey: number[] | null = null;
  for (let y = 0; y + ctx.n <= ctx.H; y++) {
    for (let x = 0; x + ctx.n <= ctx.W; x++) {
      if (legalSpot(ctx, x, y) !== 'ok') continue;
      const rect = anchorRect(x, y, ctx.n);
      const key = [rectGapFt(want, rect), from ? rectGapFt(from, rect) : 0, y, x];
      if (!bestKey || compareKeys(key, bestKey) < 0) {
        bestKey = key;
        best = { x, y };
      }
    }
  }
  return best;
}

/** Where a teleport or a placement asks to go: a square, near a creature, or into a place. */
function requestedSpot(ctx: Ctx, req: MoveRequest, start: GridPoint | null): GridPoint | MoveRefusal {
  const to = req.to;
  if (!to) return { code: 'bad-request', problem: `kind "${req.kind}" needs "to": a square, a creature or a place.` };
  if (to.kind === 'square') {
    if (!isSquare(to.at)) return { code: 'bad-request', problem: 'A square needs whole-number coordinates.' };
    if (!fits(to.at, ctx.n, ctx.W, ctx.H)) return { code: 'off-map', to: point(to.at) };
    return point(to.at);
  }
  const from = start ? anchorRect(start.x, start.y, ctx.n) : null;
  let best: GridPoint | null = null;
  let bestKey: number[] | null = null;
  const target = to.kind === 'creature' ? ctx.state.combatants.find((c) => c.id === to.id) : undefined;
  if (to.kind === 'creature' && !target?.position) return { code: 'bad-request', problem: `No creature "${to.id}" on the map.` };
  const place = to.kind === 'place' ? ctx.map.places.find((p) => p.id === to.placeId) : undefined;
  if (to.kind === 'place' && !place) return { code: 'bad-request', problem: `No place "${to.placeId}" on the map.` };
  const goal: Goal = target
    ? { kind: 'creature', band: bandOf(target, ctx.hero), withinFt: to.kind === 'creature' ? (to.withinFt ?? 5) : 5 }
    : { kind: 'place', place: place as MapPlace };
  for (let y = 0; y + ctx.n <= ctx.H; y++) {
    for (let x = 0; x + ctx.n <= ctx.W; x++) {
      if (legalSpot(ctx, x, y) !== 'ok') continue;
      const penalty = goalPenalty(ctx, goal, x, y);
      if (penalty === null) continue;
      const rect = anchorRect(x, y, ctx.n);
      const key = [penalty, goalDistance(ctx, goal, x, y), from ? rectGapFt(from, rect) : 0, y, x];
      if (!bestKey || compareKeys(key, bestKey) < 0) {
        bestKey = key;
        best = { x, y };
      }
    }
  }
  return best ?? { code: 'no-route' };
}

function planTeleportOrPlace(
  state: CombatState,
  hero: Character | null,
  req: MoveRequest,
  ctx: Ctx | null,
  mover: Combatant,
  stats: MoverStats,
): Planned {
  const id = stats.id;
  const teleport = req.kind === 'teleport';
  const start = mover.position ? point(mover.position) : null;
  if (teleport && !start) return { plan: refused(id, { code: 'unplaced' }), write: null };
  // An unplaced creature being placed: a context anchored nowhere in particular.
  const anchorCtx = ctx ?? buildCtx(state, hero, { ...mover, position: { x: 0, y: 0 } }, stats, {
    fly: false,
    unplaced: true,
    startElev: 0,
    endElev: 0,
    crawl: false,
    fearIds: [],
    ignore: new Set(),
    declined: new Set(),
    reactorsOn: false,
  });
  if (!anchorCtx) return { plan: bad(id, 'This fight has no battle map.'), write: null };
  const want = requestedSpot(anchorCtx, req, start);
  if ('code' in want) return { plan: refused(id, want), write: null };
  const startElev = clampElevation(mover.elevationFt ?? 0);
  const elevationFt = req.elevationFt !== undefined ? clampElevation(req.elevationFt) : startElev;
  const notes: MoveNote[] = [];
  /** The grid distance from the start to a destination anchor at the end height. */
  const distanceTo = (p: GridPoint) =>
    start
      ? gapFt(start.x, start.y, anchorCtx.n, startElev, {
          id,
          rect: anchorRect(p.x, p.y, anchorCtx.n),
          lo: levelOf(elevationFt),
          hi: levelOf(elevationFt) + anchorCtx.n - 1,
        })
      : 0;
  if (teleport && start && req.maxFt !== undefined) {
    const dist = distanceTo(want);
    const maxFt = Math.max(0, toInt(req.maxFt));
    if (dist > maxFt) return { plan: refused(id, { code: 'out-of-range', distanceFt: dist, maxFt }), write: null };
  }
  let to = want;
  const legal = legalSpot(anchorCtx, want.x, want.y);
  if (legal !== 'ok' && !(start && samePoint(want, start))) {
    const shifted = nearestSpot(anchorCtx, want, start);
    if (!shifted) return { plan: refused(id, { code: 'no-route' }), write: null };
    to = shifted;
    notes.push({ kind: 'shifted', requested: point(want), reason: legal });
  }
  if (teleport && start) {
    // srd:rule:teleportation: the effect says whether the destination must be seen (a Blinded creature sees nothing).
    const n = anchorCtx.n;
    const sees = !stats.blinded && seeing(anchorCtx.cells, anchorRect(start.x, start.y, n), anchorRect(to.x, to.y, n));
    notes.push({ kind: 'teleported', distanceFt: distanceTo(to), lineOfSight: sees });
    if (anchorCtx.cells.flags[to.y * anchorCtx.W + to.x] & CELL.PIT && canFall(stats, elevationFt)) {
      notes.push(fellNote(pitAt(anchorCtx.map, to.x, to.y), PIT_DEPTH_FT));
    }
  }
  const spendFt = teleport ? 0 : Math.max(0, toInt(req.spendFt));
  const turn = recordOther(state, stats, { kind: req.kind, by: req.by, from: start ?? to, to, path: [], spendFt, entered: [] });
  const unchanged = start !== null && samePoint(start, to) && elevationFt === startElev && spendFt === 0;
  const ended = unchanged ? null : endedStop(state, id);
  if (ended) notes.push(ended.note);
  const plan: MovePlan = {
    status: 'moved',
    moverId: id,
    kind: req.kind,
    from: start ?? point(to),
    path: [],
    to: point(to),
    costFt: spendFt,
    budget: otherBudget(stats, turn, elevationFt, inDeepWater(anchorCtx.cells, to, anchorCtx.n)),
    provoked: [],
    notes,
    heroStoodUp: false,
  };
  const write: Write | null = unchanged
    ? null
    : { moverId: id, to, elevationFt, removeProne: false, turn, stop: null, reactionsUsed: ended?.reactionsUsed ?? [] };
  return { plan, write };
}

function planAny(state: CombatState, hero: Character | null, req: MoveRequest): Planned {
  if (req.kind === 'move' || req.kind === 'off-turn') {
    const r = planWilling(state, hero, req);
    if (!r.ok) return { plan: r.refused, write: null };
    return finishWilling(state, r.plan, r.plan.ctx).planned;
  }
  if (!state.map) return { plan: bad(req.moverId, 'This fight has no battle map.'), write: null };
  const mover = state.combatants.find((c) => c.id === req.moverId);
  if (!mover) return { plan: bad(req.moverId, `No combatant "${req.moverId}".`), write: null };
  const stats = moverStats(state, hero, mover.id) as MoverStats;
  const elev = clampElevation(mover.elevationFt ?? 0);
  const ctx = mover.position
    ? buildCtx(state, hero, mover, stats, {
        fly: false,
        startElev: elev,
        endElev: req.kind === 'forced' ? elev : clampElevation(req.elevationFt ?? elev),
        crawl: false,
        fearIds: [],
        ignore: new Set(),
        declined: new Set(),
        reactorsOn: false,
      })
    : null;
  if (req.kind === 'forced') {
    if (!ctx) return { plan: refused(mover.id, { code: 'unplaced' }), write: null };
    return planForced(state, hero, req, ctx);
  }
  if (req.kind === 'teleport' || req.kind === 'place') return planTeleportOrPlace(state, hero, req, ctx, mover, stats);
  return { plan: bad(mover.id, `Unknown kind of move "${String(req.kind)}".`), write: null };
}

/** Same checks as applyMove; no state change. perspective 'player' plans on playerView(state). */
export function planMove(
  state: CombatState,
  hero: Character | null,
  req: MoveRequest,
  opts: { perspective?: 'dm' | 'player' } = {},
): MovePlan {
  return planAny(opts.perspective === 'player' ? playerView(state) : state, hero, req).plan;
}

/** DM-made moves, on the true map. Writes position, map.turn, map.stop, Prone (NPCs) and reactionUsed. */
export function applyMove(state: CombatState, hero: Character | null, req: MoveRequest): MoveOutcome {
  const { plan, write } = planAny(state, hero, req);
  if (plan.status === 'refused') return plan;
  const next = write ? commit(state, write) : state;
  const notes = write ? [...plan.notes, ...emanationsReached(state, next, hero, plan.moverId)] : plan.notes;
  return { ...plan, notes, state: next };
}

// ---------------------------------------------------------------------------
// The player's own move (C24)
// ---------------------------------------------------------------------------

export interface HeroMoveRequest {
  /** Destination anchor; omit (with standUp) to only stand up. */
  to?: GridPoint;
  prefer: 'safest' | 'shortest';
  dash: boolean;
  disengage: boolean;
  standUp: boolean;
}

export type HeroMoveOutcome =
  | {
      status: 'moved' | 'stopped';
      state: CombatState;
      /** The record appended to map.turn.moves (toldSeq unset). */
      move: TurnMove;
      heroStoodUp: boolean;
      /** Why it ended short of `to`, in player-safe terms. */
      stoppedFor?: { kind: 'opportunity-attack'; reactorIds: string[] } | { kind: 'unseen' } | { kind: 'out-of-movement' };
      revealedHidden: boolean;
    }
  | { status: 'refused'; refusal: MoveRefusal };

/**
 * The player's own move: plan on playerView(state) exactly as the UI previewed it, then replay step by step on
 * the true map (C24). `stopResolved`: the DM has replied since the player's pending stop (else `stop-pending`).
 */
export function applyHeroMove(state: CombatState, hero: Character, req: HeroMoveRequest, opts: { stopResolved: boolean }): HeroMoveOutcome {
  const refuse = (refusal: MoveRefusal): HeroMoveOutcome => ({ status: 'refused', refusal });
  const map = state.map;
  if (!map) return refuse({ code: 'bad-request', problem: 'This fight has no battle map.' });
  const heroC = state.combatants.find((c) => c.isPlayer);
  if (!heroC) return refuse({ code: 'bad-request', problem: 'The hero is not in this fight.' });
  if (!heroC.position) return refuse({ code: 'unplaced' });
  if (req.to !== undefined && !isSquare(req.to)) {
    return refuse({ code: 'bad-request', problem: 'A square needs whole-number coordinates.' });
  }
  const view = playerView(state);
  if (currentCombatant(state)?.id !== heroC.id) {
    const shown = currentCombatant(view);
    return refuse({ code: 'not-their-turn', currentId: shown && shown.id !== heroC.id ? shown.id : null });
  }
  const stop = map.stop;
  if (stop && stop.by === 'player' && stop.moverId === heroC.id && stop.round === state.round && !opts.stopResolved) {
    const visible = new Set(view.combatants.map((c) => c.id));
    return refuse({ code: 'stop-pending', reactorIds: stop.reactorIds.filter((id) => visible.has(id)) });
  }
  const moveReq: MoveRequest = {
    moverId: heroC.id,
    kind: 'move',
    by: 'player',
    to: { kind: 'square', at: req.to ? point(req.to) : point(heroC.position) },
    prefer: req.prefer,
    dash: req.dash,
    disengage: req.disengage,
    stayProne: !req.standUp,
  };
  // 1–2. The gates and the plan, on the player view (exactly what the UI previewed).
  const planned = planWilling(view, hero, moveReq);
  if (!planned.ok) return refuse(planned.refused.refusal);
  const wp = planned.plan;
  // 3. Replay on the true map: the same speeds, standing and fear; every creature (hidden ones included). A stop
  // being continued is read from the true map too (one whose reactors are all hidden isn't in the player view).
  const continuing = stop && stop.moverId === heroC.id && stop.round === state.round && samePoint(stop.at, heroC.position) ? stop : null;
  const trueCtx = buildCtx(state, hero, heroC, moverStats(state, hero, heroC.id) as MoverStats, {
    fly: wp.ctx.fly,
    startElev: wp.ctx.startElev,
    endElev: wp.ctx.endElev,
    crawl: wp.ctx.crawl,
    fearIds: wp.ctx.fear.map((f) => f.id),
    ignore: new Set(continuing?.reactorIds ?? []),
    declined: new Set(),
    reactorsOn: !wp.disengaged,
  });
  if (!trueCtx) return refuse({ code: 'unplaced' });
  // The view's turn record drops DM-only detail (hidden reactors): write the true one.
  const trueWp: WillingPlan = { ...wp, ctx: trueCtx, turn: currentTurn(state), continuing };
  const { planned: result, walk } = finishWilling(state, trueWp, trueCtx, pathTotals(wp.ctx, wp.path, wp.g0, wp.caps));
  const plan = result.plan;
  if (plan.status === 'refused') return refuse(plan.refusal);
  // 4. The write: position, the turn record (by 'player'), the stop; continuing marks the stop's reactors used.
  const next = result.write ? commit(state, result.write) : state;
  const turnMoves = next.map?.turn?.moves ?? [];
  const recorded = result.write?.turn && turnMoves.length > (trueWp.turn?.moves.length ?? 0) ? turnMoves[turnMoves.length - 1] : null;
  const move: TurnMove = recorded ?? {
    by: 'player',
    kind: 'move',
    from: point(heroC.position),
    to: plan.status === 'stopped' ? plan.at : plan.to,
    path: plan.path,
    costFt: plan.costFt,
    provoked: plan.provoked.map((p) => ({ reactorId: p.reactorId, at: point(p.at), hidden: p.hidden })),
    entered: [],
  };
  const revealedHidden = walk.stop !== null && walk.stop.kind !== 'oa';
  let stoppedFor: Extract<HeroMoveOutcome, { status: 'moved' | 'stopped' }>['stoppedFor'];
  if (walk.stop?.kind === 'oa') {
    stoppedFor = { kind: 'opportunity-attack', reactorIds: walk.stop.reactors.filter((r) => !r.hidden).map((r) => r.reactorId) };
  }
  else if (walk.stop?.kind === 'unseen') stoppedFor = { kind: 'unseen' };
  else if (walk.stop?.kind === 'out-of-movement') stoppedFor = { kind: 'out-of-movement' };
  // The outcome goes to the player's side: the hidden blocker stays in the DM's turn record only.
  const { blockedById: _dmOnly, ...shownMove } = move;
  return {
    status: stoppedFor ? 'stopped' : 'moved',
    state: next,
    move: shownMove,
    heroStoodUp: plan.heroStoodUp,
    ...(stoppedFor ? { stoppedFor } : {}),
    revealedHidden,
  };
}

// ---------------------------------------------------------------------------
// Reach, triggers and reachable squares
// ---------------------------------------------------------------------------

export interface ReachableSquare {
  at: GridPoint;
  costFt: number;
  band: 'move' | 'dash';
  provokes: number;
  canEnd: boolean;
}

/**
 * Every anchor reachable this turn (band 'dash' needs one more Dash). For the UI's bands and check_map.
 * The current creature uses its turn record, anyone else a fresh turn. A Prone mover stands first unless
 * `standUp: false` (then it crawls). `provokes` counts the reactors whose Opportunity Attacks its route provokes
 * (the route planMove takes; nothing stops it here).
 */
export function reachableSquares(
  state: CombatState,
  hero: Character | null,
  id: string,
  opts: { mode?: MoveMode; standUp?: boolean; perspective?: 'dm' | 'player'; prefer?: 'safest' | 'shortest' } = {},
): ReachableSquare[] {
  const view = opts.perspective === 'player' ? playerView(state) : state;
  const mover = view.combatants.find((c) => c.id === id);
  if (!view.map || !mover?.position) return [];
  const stats = moverStats(view, hero, id) as MoverStats;
  if (stats.defeated || stats.speedZero) return [];
  const startElev = clampElevation(mover.elevationFt ?? 0);
  const mode = opts.mode ?? defaultMode(stats, startElev);
  const fly = mode === 'fly';
  const standing = stats.prone && opts.standUp !== false;
  if (fly && (stats.fly <= 0 || noFly(stats, startElev, !standing))) return [];
  const turn = currentCombatant(view)?.id === id ? currentTurn(view) : null;
  const budget = budgetOf(stats, mode, turn);
  const speedFt = budget.speedFt;
  const standCost = standing ? budget.standCostFt : 0;
  // Standing may be paid out of a Dash it hasn't taken yet (as planMove allows): then there is only the Dash band (R14).
  const standsNow = budget.leftFt >= standCost;
  if (standing && (stats.walk <= 0 || (!standsNow && !(budget.dashes === 0 && budget.leftFt + speedFt >= standCost)))) return [];
  const ctx = buildCtx(view, hero, mover, stats, {
    fly,
    startElev,
    endElev: startElev,
    crawl: stats.prone && !standing,
    fearIds: stats.frightenedOfIds,
    ignore: new Set(),
    declined: new Set(),
    reactorsOn: !budget.disengaged,
  });
  if (!ctx) return [];
  const safest = (opts.prefer ?? 'safest') === 'safest';
  const g0 = budget.movedFt + standCost;
  const capMove = turnCaps(stats, speedFt, budget.dashFt, budget.dashes);
  // One more Dash: the moving speed, or the Swim Speed for a swimmer (R10).
  const dashAvailable = budget.dashes === 0 && (speedFt > 0 || ctx.swims);
  const capDash = dashAvailable ? turnCaps(stats, speedFt, budget.dashFt + speedFt, budget.dashes + 1) : null;
  const far = capDash ? runSearch(ctx, ctx.start, g0, capDash, safest, true) : null;
  // One search serves both bands unless a step's price depends on the allowance (a swimmer in deep water pays a
  // step with its Swim Speed only while that allowance lasts): every label the Dash search settles within the move
  // allowance has the same route, cost and provocations as in a search capped there (spec §7.12).
  const shared = far !== null && !(ctx.swims && hasDeepWater(ctx.cells));
  const near = !standsNow ? null : shared ? (far as Search) : runSearch(ctx, ctx.start, g0, capMove, safest, true);
  const nearMaxG = shared ? capMove.main : INF - 1;
  const out: ReachableSquare[] = [];
  /** The route planMove would take there: fewest provocations first (one label per anchor when shortest). */
  const best = (s: Search | null, a: number, maxG: number): { g: number; provokes: number } | null => {
    if (!s) return null;
    for (let p = 0; p < s.L; p++) {
      const label = a * s.L + p;
      if (s.g[label] <= maxG) return { g: s.g[label], provokes: firedCount(s, label) };
    }
    return null;
  };
  // Every step costs at least 5 ft and moves one square, so nothing lies further than the allowance / 5 squares away.
  const widest = capDash ?? capMove;
  const range = Math.floor((Math.max(widest.main, widest.swim) - g0) / 5);
  const { x: sx, y: sy } = ctx.start;
  for (let ay = Math.max(0, sy - range); ay <= Math.min(ctx.H - 1, sy + range); ay++) {
    for (let ax = Math.max(0, sx - range); ax <= Math.min(ctx.W - 1, sx + range); ax++) {
      if (ax === sx && ay === sy) continue;
      const a = ay * ctx.W + ax;
      const inMove = best(near, a, nearMaxG);
      const hit = inMove ?? best(far, a, INF - 1);
      if (!hit) continue;
      out.push({
        at: { x: ax, y: ay },
        costFt: hit.g - g0,
        band: inMove ? 'move' : 'dash',
        provokes: hit.provokes,
        canEnd: endable(ctx, ax, ay),
      });
    }
  }
  return out;
}

/** Each step of `path` (anchors, start first) that leaves an eligible reactor's reach (D30). */
export function opportunityTriggers(
  state: CombatState,
  hero: Character | null,
  moverId: string,
  path: readonly GridPoint[],
  opts: { disengaged: boolean; kind: MoveKind; ignoreIds?: readonly string[]; perspective?: 'dm' | 'player' },
): ProvokedAttack[] {
  if (opts.disengaged || (opts.kind !== 'move' && opts.kind !== 'off-turn') || path.length < 2) return [];
  const view = opts.perspective === 'player' ? playerView(state) : state;
  const mover = view.combatants.find((c) => c.id === moverId);
  if (!mover?.position) return [];
  const stats = moverStats(view, hero, moverId) as MoverStats;
  const elev = clampElevation(mover.elevationFt ?? 0);
  const ctx = buildCtx(view, hero, { ...mover, position: point(path[0]) }, stats, {
    fly: false,
    startElev: elev,
    endElev: elev,
    crawl: false,
    fearIds: [],
    ignore: new Set(opts.ignoreIds ?? []),
    declined: new Set(),
    reactorsOn: true,
  });
  if (!ctx) return [];
  const out: ProvokedAttack[] = [];
  for (const r of ctx.reactors) {
    for (let i = 0; i + 1 < path.length; i++) {
      if (leaves(ctx, r, path[i], elev, path[i + 1], elev)) {
        out.push(provokedBy(r, path[i], i));
        break;
      }
    }
  }
  return out.sort((a, b) => a.stepIndex - b.stepIndex || rankOf(ctx, a.reactorId) - rankOf(ctx, b.reactorId));
}

/** D7: distance ≤ attacker's reach and no Total Cover between them (optionally with the target at another anchor). */
export function inReach(state: CombatState, hero: Character | null, attackerId: string, targetId: string, targetAt?: GridPoint): boolean {
  const attacker = state.combatants.find((c) => c.id === attackerId);
  const target = state.combatants.find((c) => c.id === targetId);
  const cells = mapCells(state, hero);
  if (!cells || !attacker?.position || !target || attackerId === targetId) return false;
  const at = targetAt ?? target.position;
  if (!at) return false;
  const a = bandOf(attacker, hero);
  const t = bandOf(target, hero, at);
  const reachFt = (moverStats(state, hero, attackerId) as MoverStats).reachFt;
  if (gapFt(t.rect.x0, t.rect.y0, t.rect.x1 - t.rect.x0 + 1, (target.elevationFt ?? 0), a) > reachFt) return false;
  return !walled(cells, a.rect, t.rect);
}
