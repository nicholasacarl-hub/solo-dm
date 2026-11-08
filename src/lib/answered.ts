/**
 * "Has the DM seen it?" for battle-map items stamped with the transcript seq of the user message that first
 * carried them (D48). Pure; shared by the store (commitHeroMove's stop gate) and the DM session (<game_state>).
 */
import type { CombatState, TranscriptMessage } from '@/types';

/**
 * The stamp of a map item the DM saw and answered in an earlier session. Transcript seqs restart in every session,
 * so before a session's transcript goes away its answered stamps are frozen to this value (freezeAnswered), which
 * counts as answered against any transcript. It is stored like any seq (a whole number ≥ 1, so saves, reloads and
 * imports keep it), and no transcript ever reaches it.
 */
export const SEEN_SEQ = Number.MAX_SAFE_INTEGER;

/** True when the transcript holds the message with this seq and some assistant message after it (or seq is SEEN_SEQ). */
export function isSeqAnswered(messages: readonly TranscriptMessage[], seq: number): boolean {
  if (seq === SEEN_SEQ) return true;
  let found = false;
  for (const m of messages) {
    if (m.seq === seq) found = true;
    else if (found && m.seq > seq && m.param.role === 'assistant') return true;
  }
  return false;
}

/**
 * Freeze "seen" before a session ends: the player's map moves and the player's stop whose stamps `answered` accepts
 * get SEEN_SEQ, so the next session doesn't report them as new. Items not yet answered keep their stamp and are
 * reported again. Returns `state` itself when nothing changes.
 */
export function freezeAnswered(state: CombatState, answered: (seq: number) => boolean): CombatState {
  const map = state.map;
  if (!map) return state;
  const freeze = <T extends { by: 'player' | 'dm'; toldSeq?: number }>(item: T): T =>
    item.by === 'player' && typeof item.toldSeq === 'number' && item.toldSeq !== SEEN_SEQ && answered(item.toldSeq)
      ? { ...item, toldSeq: SEEN_SEQ }
      : item;
  const turn = map.turn;
  const moves = turn?.moves.map(freeze);
  const nextTurn = turn && moves && moves.some((m, i) => m !== turn.moves[i]) ? { ...turn, moves } : turn;
  const stop = map.stop && freeze(map.stop);
  if (nextTurn === turn && stop === map.stop) return state;
  return { ...state, map: { ...map, ...(nextTurn ? { turn: nextTurn } : {}), ...(stop ? { stop } : {}) } };
}
