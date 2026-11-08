/**
 * The battle map as a whole: create / edit / remove, placement, the turn-start report, footprint re-fits,
 * stamping what the DM was told, the player view (the single redaction point for hidden creatures), the
 * snapshot every text renderer reads, warnings, the DM's glyph drawing and name lookup. Pure.
 *
 * CONTRACT (battle map, Day 0) — implemented by engineer A. Map-local ids t1…, p1…, e1… share
 * BattleMap.nextId; the map id is "map-<n>"; nothing here reads the clock or randomness.
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
  TerrainFeature,
  TurnMove,
} from '@/types';
import type { AreaResult } from './areas';
import type { TurnBudget } from './movement';
import type { CoverResult } from './sight';

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

/** Ids t1…/p1… from nextId; map id "map-<n>". `previous` (a replacement) carries `turn` over and continues the id counter. */
export function createBattleMap(_input: BattleMapInput, _previous?: BattleMap): BattleMap {
  throw new Error('battleMap: createBattleMap not implemented');
}

/** Drop the map and every position/elevation (size, speeds, reach, hidden and reactions stay). */
export function removeBattleMap(_state: CombatState): CombatState {
  throw new Error('battleMap: removeBattleMap not implemented');
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

/**
 * Deterministic placement (C27): requests in order, ids in order; never puts an enemy within 5 ft of the hero
 * unless that exact square was requested; an illegal requested square shifts to the nearest legal one with `why`
 * ("E5 is a wall", "F4 is Bandit 1's space", "B5 is next to the hero").
 */
export function placeCombatants(
  _state: CombatState,
  _hero: Character | null,
  _requests: readonly PlacementRequest[],
): { state: CombatState; placed: PlacementResult[] } {
  throw new Error('battleMap: placeCombatants not implemented');
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

/** Atomic: every item is checked first; any problem returns { ok: false } and nothing changes. */
export function editMap(
  _state: CombatState,
  _hero: Character | null,
  _edit: MapEdit,
): { ok: true; state: CombatState; changes: MapChange[] } | { ok: false; problem: string } {
  throw new Error('battleMap: editMap not implemented');
}

/** Resolve an area and draw it on the map (a turn-scoped effect, or a lasting one with optional terrain). */
export function addAreaEffect(
  _state: CombatState,
  _hero: Character | null,
  _spec: AreaSpec,
  _opts: { label: string; lasting: boolean; terrain?: AreaTerrain[]; rangeFt?: number },
): { ok: true; state: CombatState; effect: MapEffect; result: AreaResult } | { ok: false; problem: string } {
  throw new Error('battleMap: addAreaEffect not implemented');
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

/** Null when (round, current id) didn't change. Pure: it reads, the handler renders. */
export function turnStartReport(_before: CombatState, _after: CombatState, _hero: Character | null): TurnStartReport | null {
  throw new Error('battleMap: turnStartReport not implemented');
}

/** After a size change: shift every footprint that no longer fits to the nearest legal anchor (D39). */
export function refitFootprints(
  _state: CombatState,
  _hero: Character | null,
): { state: CombatState; moved: { id: string; from: GridPoint; to: GridPoint }[]; unplaced: string[] } {
  throw new Error('battleMap: refitFootprints not implemented');
}

/** Stamp every unseen player move and an unseen player stop with `seq` (D48). Returns `state` itself when nothing changes. */
export function stampMapTold(_state: CombatState, _seq: number, _isAnswered: (seq: number) => boolean): CombatState {
  throw new Error('battleMap: stampMapTold not implemented');
}

/** A player move or stop counts as seen by the DM. */
export function isToldAndAnswered(_item: { toldSeq?: number }, _isAnswered: (seq: number) => boolean): boolean {
  throw new Error('battleMap: isToldAndAnswered not implemented');
}

// ---------------------------------------------------------------------------
// The player's view and lookups
// ---------------------------------------------------------------------------

/**
 * The player's world (D63): hidden combatants removed; `turn`/`stop` records rewritten to drop hidden reactors and
 * hidden-only notes; turnIndex moved to playerTurnIndex. Memoized on the state object.
 */
export function playerView(_state: CombatState): CombatState {
  throw new Error('battleMap: playerView not implemented');
}

/** D42: the index the player sees as "current": the current creature, or the last visible one before it in order. */
export function playerTurnIndex(_state: CombatState): number {
  throw new Error('battleMap: playerTurnIndex not implemented');
}

/** findCombatant rules (id, exact name, unique partial name) plus "hero" / "the hero" / "you". */
export function findMapCombatant(_state: CombatState, _who: string): Combatant | undefined {
  throw new Error('battleMap: findMapCombatant not implemented');
}

/** Case-insensitive, with or without a leading "the". */
export function findPlace(_map: BattleMap, _name: string): MapPlace | undefined {
  throw new Error('battleMap: findPlace not implemented');
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

/** Null without a map. */
export function mapSnapshot(_state: CombatState, _hero: Character | null, _opts: { perspective: 'dm' | 'player' }): MapSnapshot | null {
  throw new Error('battleMap: mapSnapshot not implemented');
}

export function mapWarnings(_state: CombatState, _hero: Character | null): MapWarning[] {
  throw new Error('battleMap: mapWarnings not implemented');
}

/** Terrain and tokens as text glyphs (DM only): rows[y] is a string of width chars. */
export function mapGlyphGrid(_state: CombatState, _hero: Character | null): { rows: string[]; legend: { glyph: string; id: string }[] } {
  throw new Error('battleMap: mapGlyphGrid not implemented');
}
