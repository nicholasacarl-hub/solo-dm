/**
 * "Has the DM seen it?" for battle-map items stamped with the transcript seq of the user message that first
 * carried them (D48). Pure; shared by the store (commitHeroMove's stop gate) and the DM session (<game_state>).
 */
import type { TranscriptMessage } from '@/types';

/** True when the transcript holds the message with this seq and some assistant message after it. */
export function isSeqAnswered(messages: readonly TranscriptMessage[], seq: number): boolean {
  let found = false;
  for (const m of messages) {
    if (m.seq === seq) found = true;
    else if (found && m.seq > seq && m.param.role === 'assistant') return true;
  }
  return false;
}
