/**
 * The battle map as the player sees it (D63): everything the map draws, says and computes comes from one redacted
 * player view of the fight (playerView), so a hidden creature can't reach the DOM, an accessible name, a path, a
 * band or a readout. "Show DM secrets" only adds `secretTokens`, which are drawn and never used in a computation.
 */
import { useDeferredValue, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  currentTurn,
  isToldAndAnswered,
  mapCells,
  mapSnapshot,
  playerView,
  reachableSquares,
  turnBudget,
  type MapCells,
  type MapSnapshot,
  type ReachableSquare,
  type SnapshotToken,
  type TurnBudget,
} from '@/engine';
import { isSeqAnswered } from '@/lib/answered';
import { canUndoHeroMove, heroMoveBlock, pendingPlayerStop, useGame, type DmPhase, type HeroMoveBlock } from '@/state/gameStore';
import type { BattleMap, Character, Combatant, CombatState, MapStop, TranscriptMessage, TurnMove } from '@/types';
import { isBusyPhase } from '../dmStatus';
import { usePlayView } from '../playView';
import { namesFor, type MapBlock, type NameOf } from './text';
import { tokenLabels } from './tokenLabels';

export interface BattleMapModel {
  /** playerView(combat): every computation uses it. */
  view: CombatState;
  map: BattleMap;
  /**
   * The key of this map's camera in usePlayView.cameras: the fight and the map. Every fight's first map is "map-1",
   * so the map id alone would hand a new fight the last fight's camera.
   */
  cameraKey: string;
  /** mapSnapshot(view, hero, { perspective: 'player' }). */
  snapshot: MapSnapshot;
  cells: MapCells;
  hero: Character;
  heroId: string;
  heroToken: SnapshotToken | null;
  /** The hero's movement this turn, while the player's view shows the hero acting. */
  budget: TurnBudget | null;
  /** Squares the hero can reach this turn (bands); [] unless the hero can move. */
  reachable: ReachableSquare[];
  /** The store's gates, mirrored for display (the store re-checks at commit). */
  canMove: boolean;
  block: MapBlock | null;
  /** "Show DM secrets": hidden tokens to draw only (never used in computation). */
  secretTokens: SnapshotToken[];
  /** The creature the player sees acting: the current one, or the last visible one before it (D42). */
  currentId: string | null;
  yourTurn: boolean;
  /** The player view's combatants and tokens by id, and their labels. */
  combatants: ReadonlyMap<string, Combatant>;
  tokens: ReadonlyMap<string, SnapshotToken>;
  labels: ReadonlyMap<string, string>;
  /** Labels for secretTokens (kept apart, so showing secrets never changes a visible label). */
  secretLabels: ReadonlyMap<string, string>;
  nameOf: NameOf;
  /** The player's stop the DM hasn't answered (player view: visible reactors only). */
  pendingStop: MapStop | null;
  /** The hero's moves this turn the DM hasn't answered yet (D48), oldest first. */
  unseenMoves: TurnMove[];
  canUndo: boolean;
  dmPhase: DmPhase;
  dmBusy: boolean;
  hasSession: boolean;
}

export interface ModelInputs {
  combat: CombatState;
  hero: Character;
  /** heroMoveBlock(state) from the store (the true fight). */
  rawBlock: Exclude<HeroMoveBlock, 'refused'> | null;
  canUndo: boolean;
  dmPhase: DmPhase;
  hasSession: boolean;
  transcript: readonly TranscriptMessage[];
}

/**
 * The block the player is shown. A hidden creature's turn reads 'not-your-turn' in the store while the player's
 * view still shows the hero acting (D42). It must look exactly like the hero's own turn: while the DM works that is
 * 'dm-busy' (what the hero's turn shows then); once the DM is idle it is the neutral 'waiting' — never "It isn't
 * your turn".
 */
export function displayBlock(rawBlock: ModelInputs['rawBlock'], yourTurnInView: boolean, dmBusy: boolean): MapBlock | null {
  if (rawBlock === 'not-your-turn' && yourTurnInView) return dmBusy ? 'dm-busy' : 'waiting';
  return rawBlock;
}

/**
 * The hero's movement as last shown on the hero's own turn. When a hidden creature acts right after the hero, the
 * player view keeps showing the hero's turn (D42), but the hidden creature's turn record replaces the hero's, so a
 * fresh budget ("30 ft" again) would give the hidden turn away: the readouts keep the last budget the hero had.
 * Shared by every map surface (pill, bar, chip), so a surface that mounts during the hidden turn agrees with them.
 */
let lastHeroBudget: { key: string; budget: TurnBudget | null } | null = null;

export function shownHeroBudget(view: CombatState, hero: Character | null, heroId: string, hiddenTurn: boolean): TurnBudget | null {
  const key = `${view.startedAt}:${view.round}:${heroId}`;
  if (hiddenTurn && lastHeroBudget?.key === key) return lastHeroBudget.budget;
  const budget = turnBudget(view, hero, heroId);
  if (!hiddenTurn) lastHeroBudget = { key, budget };
  return budget;
}

/** Tests: forget the cached budget. */
export function resetShownBudgetForTests(): void {
  lastHeroBudget = null;
}

/** The hero's moves this turn (in the player view) that the DM hasn't seen and answered. */
export function unseenHeroMoves(view: CombatState, heroId: string, transcript: readonly TranscriptMessage[]): TurnMove[] {
  const turn = currentTurn(view);
  if (!turn || turn.combatantId !== heroId) return [];
  const answered = (seq: number) => isSeqAnswered(transcript, seq);
  return turn.moves.filter((m) => m.by === 'player' && !isToldAndAnswered(m, answered));
}

/** The pure part of the model: everything except the reachable squares and the secret tokens. */
export function buildModelCore(input: ModelInputs): Omit<BattleMapModel, 'reachable' | 'secretTokens' | 'secretLabels'> | null {
  const { combat, hero } = input;
  if (!combat.active || !combat.map) return null;
  const view = playerView(combat);
  const map = view.map as BattleMap;
  const snapshot = mapSnapshot(view, hero, { perspective: 'player' });
  const cells = mapCells(view, hero);
  const heroC = view.combatants.find((c) => c.isPlayer);
  if (!snapshot || !cells || !heroC) return null;
  const current = view.combatants[view.turnIndex] ?? null;
  const yourTurn = current?.id === heroC.id;
  const dmBusy = isBusyPhase(input.dmPhase);
  const block = displayBlock(input.rawBlock, yourTurn, dmBusy);
  const hiddenTurn = yourTurn && input.rawBlock === 'not-your-turn';
  const tokens = new Map(snapshot.tokens.map((t) => [t.id, t]));
  const combatants = new Map(view.combatants.map((c) => [c.id, c]));
  const stop = pendingPlayerStop(view, input.transcript);
  return {
    view,
    map,
    cameraKey: `${view.startedAt}:${map.id}`,
    snapshot,
    cells,
    hero,
    heroId: heroC.id,
    heroToken: tokens.get(heroC.id) ?? null,
    budget: yourTurn ? shownHeroBudget(view, hero, heroC.id, hiddenTurn) : null,
    canMove: block === null,
    block,
    currentId: current?.id ?? null,
    yourTurn,
    combatants,
    tokens,
    labels: tokenLabels(view.combatants),
    nameOf: namesFor(view.combatants),
    pendingStop: stop && stop.moverId === heroC.id ? stop : null,
    unseenMoves: yourTurn ? unseenHeroMoves(view, heroC.id, input.transcript) : [],
    canUndo: input.canUndo,
    dmPhase: input.dmPhase,
    dmBusy,
    hasSession: input.hasSession,
  };
}

/** Hidden tokens for "Show DM secrets" (drawn only). */
export function secretTokensOf(combat: CombatState, hero: Character | null): SnapshotToken[] {
  if (!combat.combatants.some((c) => c.hidden)) return [];
  return mapSnapshot(combat, hero, { perspective: 'dm' })?.tokens.filter((t) => t.hidden && t.space) ?? [];
}

/** Subscribes narrowly (never to the log, which changes on every streamed delta). */
export function useBattleMapModel(): BattleMapModel | null {
  const { combat, hero, dmPhase, hasSession, transcript, rawBlock, canUndo } = useGame(
    useShallow((s) => ({
      combat: s.combat,
      hero: s.character,
      dmPhase: s.dm.phase,
      hasSession: s.activeSession !== null,
      transcript: s.transcript,
      rawBlock: heroMoveBlock(s),
      canUndo: canUndoHeroMove(s),
    })),
  );
  const showSecrets = usePlayView((s) => s.showSpoilers);
  const standUp = usePlayView((s) => s.plan?.standUp ?? false);

  const core = useMemo(
    () => (combat && hero ? buildModelCore({ combat, hero, rawBlock, canUndo, dmPhase, hasSession, transcript }) : null),
    [combat, hero, rawBlock, canUndo, dmPhase, hasSession, transcript],
  );
  const view = core?.view ?? null;
  const heroId = core?.heroId ?? null;
  const canMove = core?.canMove ?? false;
  // The bands: the expensive search, only while the hero can move, and only when the fight or the sheet changes.
  // Deferred, so the map paints first and the bands follow (spec §7.12, first paint).
  const bandsInput = useMemo(() => (view && hero && heroId && canMove ? { view, hero, heroId, standUp } : null), [view, hero, heroId, canMove, standUp]);
  const bandsKey = useDeferredValue(bandsInput, null);
  const reachable = useMemo(
    () => (bandsKey ? reachableSquares(bandsKey.view, bandsKey.hero, bandsKey.heroId, { perspective: 'player', standUp: bandsKey.standUp }) : []),
    [bandsKey],
  );
  const secret = useMemo(() => {
    if (!showSecrets || !combat?.map) return { tokens: [] as SnapshotToken[], labels: new Map<string, string>() };
    const tokens = secretTokensOf(combat, hero);
    return { tokens, labels: tokenLabels(tokens) };
  }, [showSecrets, combat, hero]);

  return useMemo(
    () => (core ? { ...core, reachable, secretTokens: secret.tokens, secretLabels: secret.labels } : null),
    [core, reachable, secret],
  );
}
