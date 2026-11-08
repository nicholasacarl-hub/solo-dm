/**
 * Battle-map movement by the SRD 5.2.1 grid rules: teams, mover stats, the turn record and budget,
 * step rules, path search, Opportunity Attacks and the stop rule, planMove / applyMove for every move
 * kind, applyHeroMove (the player's own move: plan on the player view, replay on the true map) and
 * reachable squares. Pure; results are structured data only (DM text lives in src/dm/mapText.ts,
 * player text in src/ui/play/map/text.ts).
 *
 * CONTRACT (battle map, Day 0) — implemented by engineer A. Every function that needs the hero takes
 * `hero: Character | null`: the hero's size, speeds, reach and conditions are read live from the sheet.
 */
import type {
  Character,
  Combatant,
  CombatSide,
  CombatState,
  CompassDirection,
  CreatureSize,
  GridPoint,
  MapRef,
  MapTurn,
  MoveKind,
  MoveMode,
  TurnMove,
} from '@/types';

// ---------------------------------------------------------------------------
// Teams (app convention C6)
// ---------------------------------------------------------------------------

export type MapTeam = 'party' | 'foes' | 'neutral';

/** player/ally → party, enemy → foes, neutral → neutral. */
export function teamOf(_side: CombatSide): MapTeam {
  throw new Error('movement: teamOf not implemented');
}

/** Same team, not neutral (C6). */
export function areAllies(_a: MapTeam, _b: MapTeam): boolean {
  throw new Error('movement: areAllies not implemented');
}

/** Party vs foes only. */
export function areHostile(_a: MapTeam, _b: MapTeam): boolean {
  throw new Error('movement: areHostile not implemented');
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

/** Null for an unknown id. */
export function moverStats(_state: CombatState, _hero: Character | null, _id: string): MoverStats | null {
  throw new Error('movement: moverStats not implemented');
}

/** 10 when a sheet attack has the Reach property or a "10 ft." melee range, else 5 (srd:rule:reach; srd:rule:weapons-properties-reach). */
export function heroReachFt(_c: Character): number {
  throw new Error('movement: heroReachFt not implemented');
}

/** Map stats from a stat-block entry: data.size, data.speeds, and the largest "reach N ft." / "reach N feet" on a melee attack line. */
export function statBlockMapStats(_entry: {
  text: string;
  data?: Record<string, unknown>;
}): Partial<Pick<Combatant, 'size' | 'speeds' | 'reachFt'>> {
  throw new Error('movement: statBlockMapStats not implemented');
}

// ---------------------------------------------------------------------------
// Turn record and budget
// ---------------------------------------------------------------------------

/** The current creature's record: map.turn when it matches (current id, round), else a fresh one. Null without a map. */
export function currentTurn(_state: CombatState): MapTurn | null {
  throw new Error('movement: currentTurn not implemented');
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

/** For the current creature (uses map.turn) or anyone else (a fresh budget: off-turn moves). */
export function turnBudget(_state: CombatState, _hero: Character | null, _id: string, _mode?: MoveMode): TurnBudget | null {
  throw new Error('movement: turnBudget not implemented');
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
  | { kind: 'airborne-walker'; elevationFt: number };

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

export function planMove(
  _state: CombatState,
  _hero: Character | null,
  _req: MoveRequest,
  _opts?: { perspective?: 'dm' | 'player' },
): MovePlan {
  throw new Error('movement: planMove not implemented');
}

/** DM-made moves, on the true map. Writes position, map.turn, map.stop, Prone (NPCs) and reactionUsed. */
export function applyMove(_state: CombatState, _hero: Character | null, _req: MoveRequest): MoveOutcome {
  throw new Error('movement: applyMove not implemented');
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
export function applyHeroMove(
  _state: CombatState,
  _hero: Character,
  _req: HeroMoveRequest,
  _opts: { stopResolved: boolean },
): HeroMoveOutcome {
  throw new Error('movement: applyHeroMove not implemented');
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

/** Every anchor reachable this turn (band 'dash' needs one more Dash). For the UI's bands and check_map. */
export function reachableSquares(
  _state: CombatState,
  _hero: Character | null,
  _id: string,
  _opts?: { mode?: MoveMode; standUp?: boolean; perspective?: 'dm' | 'player'; prefer?: 'safest' | 'shortest' },
): ReachableSquare[] {
  throw new Error('movement: reachableSquares not implemented');
}

/** Each step of `path` (anchors, start first) that leaves an eligible reactor's reach (D30). */
export function opportunityTriggers(
  _state: CombatState,
  _hero: Character | null,
  _moverId: string,
  _path: readonly GridPoint[],
  _opts: { disengaged: boolean; kind: MoveKind; ignoreIds?: readonly string[]; perspective?: 'dm' | 'player' },
): ProvokedAttack[] {
  throw new Error('movement: opportunityTriggers not implemented');
}

/** D7: distance ≤ attacker's reach and no Total Cover between them (optionally with the target at another anchor). */
export function inReach(
  _state: CombatState,
  _hero: Character | null,
  _attackerId: string,
  _targetId: string,
  _targetAt?: GridPoint,
): boolean {
  throw new Error('movement: inReach not implemented');
}
