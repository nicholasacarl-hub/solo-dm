/**
 * The words the composer sends for the hero's battle-map turn (spec §7.4): an empty Send after the hero moved, and
 * End turn. They name only the hero's own squares and the map's places, so they never depend on hidden creatures.
 */
// By path: pure helpers only (the Play tests' '@/engine' stand-in doesn't carry combat.ts).
import { isToldAndAnswered } from '@/engine/battleMap';
import { currentCombatant } from '@/engine/combat';
import { rectsContain, squareLabel } from '@/engine/grid';
import { currentTurn } from '@/engine/movement';
import { isSeqAnswered } from '@/lib/answered';
import { pendingPlayerStop, useGame } from '@/state/gameStore';
import type { CombatState, TranscriptMessage } from '@/types';
import { isBusyPhase, sendToDm } from '../dmStatus';
import { usePlayView } from '../playView';

export const END_TURN_WORDS = 'I end my turn.';

/**
 * What an empty Send says on the hero's turn while the DM hasn't seen the hero's moves: "I keep moving to A7." with
 * a pending stop, else "I move to D8." ("I move to A7, by the loading door." inside a place), or "I stand up." when
 * the hero only stood up. Null when there is nothing new to tell (Send then needs words).
 */
export function emptySendWords(combat: CombatState | null, transcript: readonly TranscriptMessage[]): string | null {
  if (!combat?.active || !combat.map) return null;
  const hero = currentCombatant(combat);
  if (!hero?.isPlayer) return null;
  const stop = pendingPlayerStop(combat, transcript);
  if (stop) return `I keep moving to ${squareLabel(stop.destination)}.`;
  const turn = currentTurn(combat);
  const answered = (seq: number) => isSeqAnswered(transcript, seq);
  const unseen = turn?.moves.filter((m) => m.by === 'player' && !isToldAndAnswered(m, answered)) ?? [];
  if (unseen.length === 0) return null;
  if (unseen.every((m) => m.kind === 'stand')) return 'I stand up.';
  const at = hero.position;
  if (!at) return null;
  const place = combat.map.places.find((p) => rectsContain(p.rects, at));
  return place ? `I move to ${squareLabel(at)}, by ${place.name}.` : `I move to ${squareLabel(at)}.`;
}

/**
 * End turn (the map's action bar): with an empty draft it sends "I end my turn."; with words in the draft (or while
 * the DM is still busy) it adds the line to the draft and focuses the composer, so nothing typed is ever lost.
 */
export async function endTurn(): Promise<void> {
  const { draft } = usePlayView.getState();
  if (draft.trim() || isBusyPhase(useGame.getState().dm.phase)) {
    usePlayView.getState().appendToDraft(END_TURN_WORDS);
    return;
  }
  await sendToDm(END_TURN_WORDS);
}
