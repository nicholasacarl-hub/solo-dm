/**
 * Battle map types. A battle map belongs to the active combat (CombatState.map) and goes away with it.
 * Squares are 5 ft. A1 is the top-left (north-west) square; letters run east (A…Z, AA…AN), numbers run south.
 * Everything here is plain JSON: integers, strings, booleans, arrays and plain objects — no Map, Set, NaN,
 * Infinity, Date or undefined inside arrays (backup.ts serializes with JSON.stringify).
 * Creature sizes are `CreatureSize` / `CREATURE_SIZES` in ./character.
 */

/** A square: x = column (0 = "A"), y = row (0 = "1"). Integers, 0 ≤ x < width, 0 ≤ y < height. */
export interface GridPoint {
  x: number;
  y: number;
}

/** An inclusive rectangle of squares, x0 ≤ x1 and y0 ≤ y1. "B2:D4" = { x0: 1, y0: 1, x1: 3, y1: 3 }; one square has x0 === x1, y0 === y1. */
export interface GridRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const MAP_LIMITS = {
  /** Columns and rows: 4–40 each (A–AN, 1–40), i.e. at most 200 × 200 ft. */
  minSize: 4,
  maxSize: 40,
  maxFeatures: 60,
  maxRectsPerFeature: 40,
  maxPlaces: 16,
  maxEffects: 12,
  /** Moves kept in one turn record; further moves still apply but are not itemised. */
  maxTurnMoves: 40,
  /** Squares kept per move path. */
  maxPathSquares: 80,
  maxLabel: 40,
  maxMapName: 60,
  /** Elevation in feet, multiples of 5. */
  maxElevationFt: 500,
} as const;

/** The fixed terrain vocabulary; each kind has fixed mechanics (battle-map spec §3.3.1, in src/engine/mapCells.ts). */
export type TerrainKind =
  | 'wall'
  | 'door'
  | 'difficult'
  | 'shallow-water'
  | 'deep-water'
  | 'pit'
  | 'hazard'
  | 'half-cover'
  | 'three-quarters-cover'
  | 'obscured';
export const TERRAIN_KINDS: readonly TerrainKind[] = [
  'wall',
  'door',
  'difficult',
  'shallow-water',
  'deep-water',
  'pit',
  'hazard',
  'half-cover',
  'three-quarters-cover',
  'obscured',
];

export type DoorState = 'open' | 'closed' | 'locked';

/** Square-filling terrain. Overlapping features combine; a door replaces any wall on its squares. */
export interface TerrainFeature {
  /** Map-local id ("t1", "t2"…), from BattleMap.nextId. Never shown to the DM or the player. */
  id: string;
  kind: TerrainKind;
  /** 1–40 rects, clipped to the map. */
  rects: GridRect[];
  /** Shown on the map and in DM text: "crates", "bar counter", "chasm". ≤ 40 chars. */
  label?: string;
  /** kind 'door' only. Default 'closed'. */
  door?: DoorState;
}

/** A named place the DM narrates ("the balcony"). Places have no mechanics; positions can name them. */
export interface MapPlace {
  /** Map-local id ("p1"…). */
  id: string;
  /** ≤ 40 chars; matched case-insensitively, with or without a leading "the". */
  name: string;
  rects: GridRect[];
}

export type AreaShape = 'sphere' | 'cylinder' | 'cone' | 'line' | 'cube' | 'emanation' | 'squares';
export const AREA_SHAPES: readonly AreaShape[] = ['sphere', 'cylinder', 'cone', 'line', 'cube', 'emanation', 'squares'];

export type CompassDirection =
  | 'north'
  | 'north-east'
  | 'east'
  | 'south-east'
  | 'south'
  | 'south-west'
  | 'west'
  | 'north-west';
export const COMPASS_DIRECTIONS: readonly CompassDirection[] = [
  'north',
  'north-east',
  'east',
  'south-east',
  'south',
  'south-west',
  'west',
  'north-west',
];

/**
 * A resolved anchor or aim on the map.
 * - square: the centre of a square ("G4");
 * - corner: a grid intersection in corner coordinates 0..width × 0..height ("D4/E5" = { x: 4, y: 4 },
 *   the top-left corner of E5);
 * - creature: the centre of that combatant's space, wherever it stands when the area is evaluated;
 * - direction: an aim only (cones, lines, cubes from a creature).
 */
export type MapRef =
  | { kind: 'square'; at: GridPoint }
  | { kind: 'corner'; x: number; y: number }
  | { kind: 'creature'; id: string }
  | { kind: 'direction'; dir: CompassDirection };

/** An area of effect after parsing (the DM's resolve_area / check_map input, or the player's template). */
export interface AreaSpec {
  shape: AreaShape;
  /** Feet (multiple of 5, 5–500): sphere/cylinder radius, cone/line length, cube side, emanation distance. Absent for 'squares'. */
  sizeFt?: number;
  /** Line width in feet (default 5). */
  widthFt?: number;
  /** Cylinder height in feet (default 40), from `elevationFt` up. */
  heightFt?: number;
  /** Sphere/cylinder centre, a placed cube's centre, or a cone/line apex that comes from no creature. Never 'direction'. */
  at?: MapRef;
  /** The creature it comes from (cone, line, emanation, a cube from a creature); for other shapes it is used for range and line of sight. */
  fromId?: string;
  /** Aim of a cone, a line, or a cube from a creature. */
  toward?: MapRef;
  /** shape 'squares': exactly these squares ("N-foot square" ground effects such as Entangle or Grease; DM overrides). */
  rects?: GridRect[];
  /** Include the origin creature's space (cone, line, cube from a creature, emanation). Default false (SRD defaults). */
  includeOrigin?: boolean;
  /** Elevation in feet of the centre (sphere), base (cylinder) or apex (cone, line). Default: `fromId`'s elevation, else 0. */
  elevationFt?: number;
}

/** What a lasting area does to its squares. */
export type AreaTerrain = 'difficult' | 'obscured' | 'hazard';
export const AREA_TERRAIN: readonly AreaTerrain[] = ['difficult', 'obscured', 'hazard'];

/** An area drawn on the map. */
export interface MapEffect {
  /** Map-local id ("e1"…). */
  id: string;
  /** "Fireball", "Web". ≤ 40 chars; effects_end matches it case-insensitively. */
  label: string;
  spec: AreaSpec;
  /** Squares covered when it was made (merged rects). An emanation's squares are recomputed from its creature's space on every read. */
  rects: GridRect[];
  /** Lasting effects only; [] otherwise. */
  terrain: AreaTerrain[];
  /** 'turn': shown while (round, turnOfId) is the current turn, then ignored and pruned on the next map write. 'lasting': until effects_end or combat ends. */
  duration: 'turn' | 'lasting';
  round: number;
  turnOfId: string;
}

export type MoveKind = 'move' | 'off-turn' | 'forced' | 'teleport' | 'place';
export const MOVE_KINDS: readonly MoveKind[] = ['move', 'off-turn', 'forced', 'teleport', 'place'];
/** The speed a move uses. Swimming is chosen per step automatically (§3.4.4); climb and burrow are unused in v1. */
export type MoveMode = 'walk' | 'fly';

/** One move in the current creature's turn record. */
export interface TurnMove {
  by: 'player' | 'dm';
  /** 'stand': stood up from Prone without moving. */
  kind: MoveKind | 'stand';
  from: GridPoint;
  to: GridPoint;
  /** Anchor squares entered, in order, start excluded; ≤ MAP_LIMITS.maxPathSquares. [] for teleport/place/stand. */
  path: GridPoint[];
  /** Movement spent (0 for forced, teleport and place unless the DM charged it). */
  costFt: number;
  /** This move took the Dash action / the Disengage action / stood up first. */
  dashed?: boolean;
  disengaged?: boolean;
  stoodUp?: boolean;
  /** Opportunity Attacks it provoked, computed on the true map. `hidden` reactors are DM-only. */
  provoked: { reactorId: string; at: GridPoint; hidden: boolean }[];
  /** Labels of hazards and lasting effects it entered. */
  entered: string[];
  /** It stopped early on something the hero couldn't see. Never undoable. */
  revealedHidden?: boolean;
  /** DM-only: the hidden creature whose space stopped it. playerView removes it. */
  blockedById?: string;
  /** by 'player': transcript seq of the user message that first carried it in <game_state> (D48). */
  toldSeq?: number;
}

/** The current creature's movement this turn. Stale (= a fresh turn) unless combatantId and round match the current turn. */
export interface MapTurn {
  combatantId: string;
  round: number;
  /** Feet moved this turn with any speed (SRD Speed: switching speeds subtracts what you've already moved). */
  movedFt: number;
  /** Extra movement from Dash this turn: the moving speed's value at each Dash. */
  dashFt: number;
  /** Dash actions taken this turn (a repeated `dash: true` doesn't add another unless `dash_again`). */
  dashes: number;
  disengaged: boolean;
  stoodUp: boolean;
  /** ≤ MAP_LIMITS.maxTurnMoves, oldest first. */
  moves: TurnMove[];
}

/** A move that stopped where it provokes Opportunity Attacks. Cleared when that mover moves again or the turn changes. */
export interface MapStop {
  moverId: string;
  by: 'player' | 'dm';
  round: number;
  /** Where the mover stands: the last square inside the reactors' reach, or the last square it could end on before it. */
  at: GridPoint;
  /** The trigger square, when it differs from `at` (the mover was passing through an ally's space). */
  triggerAt?: GridPoint;
  /** Where it was going, and the rest of its planned route (anchor squares after `at`). */
  destination: GridPoint;
  route: GridPoint[];
  /** Every reactor that triggered at the stop (ignored when the move is repeated). */
  reactorIds: string[];
  /** Reactors that let it go (the hero's "Let it go"); the others' Reactions are spent when the move continues. */
  declinedIds: string[];
  /** The stopped move's options, so "repeat the move" is exact. */
  opts: { dash?: boolean; disengage?: boolean; prefer?: 'safest' | 'shortest'; mode?: MoveMode };
  /** by 'player': transcript seq of the user message that first carried it (D48). */
  toldSeq?: number;
}

export interface BattleMap {
  /** Stable map id ("map-<nextId>") for per-map UI state (camera). A replaced map gets a new id. */
  id: string;
  /** ≤ 60 chars. */
  name?: string;
  /** Columns (A…), MAP_LIMITS.minSize–maxSize. */
  width: number;
  /** Rows (1…), MAP_LIMITS.minSize–maxSize. */
  height: number;
  terrain: TerrainFeature[];
  places: MapPlace[];
  effects: MapEffect[];
  turn?: MapTurn;
  stop?: MapStop;
  /** Next map-local id number (t1, p1, e1 share one counter). */
  nextId: number;
  /** Bumped when terrain, places or effects change — not on token moves. The UI's memo key for static layers. */
  rev: number;
}

/** Speeds in feet. NPC default: walk 30. */
export interface CreatureSpeeds {
  walk?: number;
  fly?: number;
  swim?: number;
  climb?: number;
  burrow?: number;
  /** It can hover: it stays aloft while Prone or Incapacitated. */
  hover?: boolean;
}

/** Campaign table rule. Missing = 'auto'. */
export type BattleMapsMode = 'off' | 'auto' | 'always';
export const BATTLE_MAPS_MODES: readonly BattleMapsMode[] = ['off', 'auto', 'always'];
