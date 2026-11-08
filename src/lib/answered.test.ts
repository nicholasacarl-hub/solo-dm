import { describe, expect, it } from 'vitest';
import { normalizeCombatState } from '@/engine/mapNormalize';
import { sampleStopCombat } from '@/test/fixtures';
import type { BattleMap, CombatState, TranscriptMessage, TurnMove } from '@/types';
import { freezeAnswered, isSeqAnswered, SEEN_SEQ } from './answered';

function message(seq: number, role: 'user' | 'assistant', text: string = role): TranscriptMessage {
  return { id: `m-${seq}`, sessionId: 'sess-1', seq, param: { role, content: [{ type: 'text', text }] }, createdAt: seq };
}

describe('isSeqAnswered', () => {
  it('is true once an assistant message follows the user message', () => {
    const transcript = [message(1, 'user'), message(2, 'assistant'), message(3, 'user'), message(4, 'assistant')];
    expect(isSeqAnswered(transcript, 1)).toBe(true);
    expect(isSeqAnswered(transcript, 3)).toBe(true);
  });

  it('counts a reply that comes after tool results', () => {
    const transcript = [message(1, 'user'), message(2, 'assistant', 'tool_use'), message(3, 'user', 'tool_result'), message(4, 'assistant')];
    expect(isSeqAnswered(transcript, 3)).toBe(true);
  });

  it('is false while the user message has no reply yet (a failed or running request)', () => {
    const transcript = [message(1, 'user'), message(2, 'assistant'), message(3, 'user')];
    expect(isSeqAnswered(transcript, 3)).toBe(false);
  });

  it('is false when only a later user message follows', () => {
    const transcript = [message(1, 'user'), message(2, 'user')];
    expect(isSeqAnswered(transcript, 1)).toBe(false);
  });

  it('is false when the stamped message was trimmed from the transcript (a set-aside turn)', () => {
    // seq 3 was truncated after its request failed; replies to other messages don't count for it.
    expect(isSeqAnswered([message(1, 'user'), message(2, 'assistant')], 3)).toBe(false);
    expect(isSeqAnswered([message(1, 'user'), message(2, 'assistant'), message(4, 'user'), message(5, 'assistant')], 3)).toBe(false);
  });

  it('ignores an assistant message before the seq', () => {
    expect(isSeqAnswered([message(1, 'assistant'), message(2, 'user')], 2)).toBe(false);
    expect(isSeqAnswered([message(1, 'user'), message(2, 'assistant'), message(3, 'user')], 3)).toBe(false);
  });

  it('is false for an empty transcript', () => {
    expect(isSeqAnswered([], 1)).toBe(false);
  });

  it('P2: counts a stamp frozen in an earlier session as answered against any transcript', () => {
    expect(isSeqAnswered([], SEEN_SEQ)).toBe(true);
    expect(isSeqAnswered([message(1, 'user')], SEEN_SEQ)).toBe(true);
  });
});

describe('freezeAnswered (D3, P2: what the DM saw stays seen in the next session)', () => {
  /** Example 2's player stop and its move, stamped with seq 12; plus an older move stamped 10 and a newer unstamped one. */
  function stamped(): CombatState {
    const base = sampleStopCombat();
    const map = base.map as BattleMap;
    const turn = map.turn as NonNullable<BattleMap['turn']>;
    const older: TurnMove = { ...turn.moves[0], toldSeq: 10 };
    const stopMove: TurnMove = { ...turn.moves[0], toldSeq: 12 };
    const unstamped: TurnMove = { ...turn.moves[0] };
    const dmMove: TurnMove = { ...turn.moves[0], by: 'dm' };
    return {
      ...base,
      map: { ...map, turn: { ...turn, moves: [older, stopMove, dmMove, unstamped] }, stop: { ...(map.stop as NonNullable<BattleMap['stop']>), toldSeq: 12 } },
    };
  }
  const answered = (seq: number) => seq === 10 || seq === 12;

  it('freezes the answered player moves and stop, and leaves the rest alone', () => {
    const frozen = freezeAnswered(stamped(), answered);
    expect(frozen.map?.turn?.moves.map((m) => m.toldSeq)).toEqual([SEEN_SEQ, SEEN_SEQ, undefined, undefined]);
    expect(frozen.map?.stop?.toldSeq).toBe(SEEN_SEQ);
    // A stamp the DM never answered (a failed request, or the wrap-up) keeps pointing at its message.
    const pending = freezeAnswered(stamped(), (seq) => seq === 10);
    expect(pending.map?.turn?.moves.map((m) => m.toldSeq)).toEqual([SEEN_SEQ, 12, undefined, undefined]);
    expect(pending.map?.stop?.toldSeq).toBe(12);
  });

  it('returns the same state when there is nothing to freeze', () => {
    const state = stamped();
    const once = freezeAnswered(state, answered);
    expect(freezeAnswered(once, answered)).toBe(once);
    expect(freezeAnswered(state, () => false)).toBe(state);
    const unmapped: CombatState = { ...state, map: undefined };
    expect(freezeAnswered(unmapped, answered)).toBe(unmapped);
  });

  it('keeps the frozen stamp through a save and reload (normalizeCombatState)', () => {
    const reloaded = normalizeCombatState(JSON.parse(JSON.stringify(freezeAnswered(stamped(), answered))));
    expect(reloaded.map?.stop?.toldSeq).toBe(SEEN_SEQ);
    expect(reloaded.map?.turn?.moves[0].toldSeq).toBe(SEEN_SEQ);
    expect(isSeqAnswered([], reloaded.map?.stop?.toldSeq ?? 0)).toBe(true);
  });
});
