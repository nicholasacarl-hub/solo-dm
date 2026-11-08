/**
 * The player's own move on the battle map as pure functions: the gates of commitHeroMove (spec §6.2, in order), the
 * write it makes, and the undo it allows (D49). Shared by the game store and its test fakes
 * (src/dm/testing/fakeStore.ts, src/ui/play/testing/fakeGame.ts) so every store applies the same rules. No I/O and
 * no clock: the callers set the state, bump timestamps and persist.
 *
 * Imports the engine by path (a deliberate dependency, see gameStore.ts) and only types from the store, so test
 * files that replace '@/state/gameStore' with a stand-in can still use it.
 */
import { addCondition, removeCondition } from '@/engine/character';
import { currentCombatant } from '@/engine/combat';
import { applyHeroMove, type HeroMoveOutcome, type HeroMoveRequest, type MoveRefusal } from '@/engine/movement';
import { isToldAndAnswered } from '@/engine/battleMap';
import { isSeqAnswered } from '@/lib/answered';
import type { Character, CombatState, MapStop, TranscriptMessage } from '@/types';
import type { DmPhase, GameStoreState, HeroMoveBlock, HeroMoveResult, HeroMoveSnapshot } from './gameStore';

/** The DM is doing something: anything but idle or errored (the store can't import isBusyPhase from the UI). */
export function isBusyDmPhase(phase: DmPhase): boolean {
  return phase !== 'idle' && phase !== 'error';
}

/** What the hero-move rules read from the store. */
export type HeroMoveInputs = Pick<
  GameStoreState,
  'campaign' | 'character' | 'combat' | 'dm' | 'interaction' | 'activeSession' | 'transcript' | 'heroMoveUndo'
>;

/**
 * The player's stop the DM hasn't seen yet (D48): a stop by the player in this round whose stamped user message has
 * no assistant reply after it. A stop from an earlier round is stale and ignored (spec §2.3).
 */
export function pendingPlayerStop(combat: CombatState, transcript: readonly TranscriptMessage[]): MapStop | null {
  const stop = combat.map?.stop;
  if (!stop || stop.by !== 'player' || stop.round !== combat.round) return null;
  return isToldAndAnswered(stop, (seq) => isSeqAnswered(transcript, seq)) ? null : stop;
}

/**
 * The first gate that keeps the hero from moving right now, in the order of spec §6.2, or null when the engine
 * decides ('refused' needs the engine). Reads the true combat: a hidden current creature reads as
 * 'not-your-turn', the same as any other creature's turn, so nothing leaks.
 */
export function heroMoveBlock(s: HeroMoveInputs): Exclude<HeroMoveBlock, 'refused'> | null {
  const combat = s.combat;
  if (!s.campaign || !combat?.active || !combat.map) return 'no-map';
  const current = currentCombatant(combat);
  if (current?.isPlayer !== true) return 'not-your-turn';
  if (isBusyDmPhase(s.dm.phase)) return 'dm-busy';
  if (s.interaction !== null) return 'interaction';
  if (s.activeSession === null) return 'no-session';
  if (!current.position) return 'unplaced';
  if (pendingPlayerStop(combat, s.transcript)) return 'stop-pending';
  return null;
}

/** A committed move: what to write (the combat, the Character when the hero stood up) and the new undo stack. */
export interface HeroMoveWrite {
  ok: true;
  outcome: Extract<HeroMoveOutcome, { status: 'moved' | 'stopped' }>;
  /**
   * False when there is nothing to write: the move changed nothing (a move to the square the hero is on, spec §3.10)
   * and ran into nothing hidden.
   */
  changed: boolean;
  /** The Character without Prone when the move stood the hero up (its updatedAt is the caller's to bump), else null. */
  character: Character | null;
  /** This turn's snapshots with the new one on top. */
  heroMoveUndo: HeroMoveSnapshot[];
}

/** Gate, then resolve the move on the true map (applyHeroMove replays the player-view plan, C24). */
export function planHeroMoveCommit(
  s: HeroMoveInputs,
  req: HeroMoveRequest,
): HeroMoveWrite | Extract<HeroMoveResult, { ok: false }> {
  const block = heroMoveBlock(s);
  if (block) return { ok: false, block };
  // heroMoveBlock passed, so there is a combat with a map; a campaign at the table always has a character.
  const combat = s.combat as CombatState;
  if (!s.character) return refused({ code: 'bad-request', problem: 'No character is loaded.' });
  const outcome = applyHeroMove(combat, s.character, req, { stopResolved: true });
  if (outcome.status === 'refused') return refused(outcome.refusal);
  // A move that ran into something hidden always goes on the stack, even when it changed nothing: on top it can't be
  // undone, so neither can the moves under it (moving and undoing can't probe, D49).
  if (outcome.state === combat && !outcome.heroStoodUp && !outcome.revealedHidden) {
    return { ok: true, outcome, changed: false, character: null, heroMoveUndo: s.heroMoveUndo };
  }
  const character = outcome.heroStoodUp ? removeCondition(s.character, 'prone').character : null;
  const snapshot: HeroMoveSnapshot = {
    before: combat,
    after: outcome.state,
    stoodUp: outcome.heroStoodUp,
    revealedHidden: outcome.revealedHidden,
  };
  return { ok: true, outcome, changed: true, character, heroMoveUndo: [...currentStack(s.heroMoveUndo, combat), snapshot] };
}

function refused(refusal: MoveRefusal): Extract<HeroMoveResult, { ok: false }> {
  return { ok: false, block: 'refused', refusal };
}

/**
 * The snapshots still chained to `combat`: when anything else wrote the combat since the newest one (it isn't the
 * current state any more), none of them can be undone, so a new move starts a fresh stack.
 */
function currentStack(stack: readonly HeroMoveSnapshot[], combat: CombatState): HeroMoveSnapshot[] {
  return stack.at(-1)?.after === combat ? [...stack] : [];
}

/**
 * Would undoHeroMove succeed now? Only while the newest snapshot is still the combat (reference identity: any later
 * write, such as the <game_state> stamp at send or a DM tool, ends it), it ran into nothing hidden, the DM is idle
 * (or errored) and no interaction is open.
 */
export function canUndoHeroMove(s: Pick<GameStoreState, 'combat' | 'dm' | 'interaction' | 'heroMoveUndo'>): boolean {
  const top = s.heroMoveUndo.at(-1);
  return (
    top !== undefined && !top.revealedHidden && s.combat === top.after && !isBusyDmPhase(s.dm.phase) && s.interaction === null
  );
}

/** What undoing the newest move writes. */
export interface HeroMoveUndoWrite {
  combat: CombatState;
  /** The current Character with Prone again when the move stood the hero up (never a whole-sheet restore), else null. */
  character: Character | null;
  heroMoveUndo: HeroMoveSnapshot[];
}

/** The undo of the newest hero move, or null when it isn't allowed (canUndoHeroMove). */
export function planHeroMoveUndo(s: HeroMoveInputs): HeroMoveUndoWrite | null {
  if (!s.campaign || !canUndoHeroMove(s)) return null;
  const top = s.heroMoveUndo[s.heroMoveUndo.length - 1];
  const character = top.stoodUp && s.character ? addCondition(s.character, { id: 'prone' }).character : null;
  return { combat: top.before, character, heroMoveUndo: s.heroMoveUndo.slice(0, -1) };
}
