/**
 * Where the log and the DM's memory of the session (its transcript) disagree. The transcript only
 * grows by complete replies, so it shows what the DM never saw: narration cut off by a failed
 * request or a reload (a reply the player stopped keeps what was shown — the DM logs "Stopped."
 * under it), and the player's latest words while the DM hasn't answered them (they go to the DM
 * again with the next message, unless Claude refused them).
 */
import type { LogEntry, TranscriptMessage } from '@/types';

export interface DmContextGaps {
  /** DM narration whose reply never reached the transcript. */
  cutOffIds: ReadonlySet<string>;
  /** The player's latest message when the DM hasn't answered it. */
  pendingPlayerId: string | null;
}

const NONE: DmContextGaps = { cutOffIds: new Set(), pendingPlayerId: null };

/** Index of the first message created at or after `time` (the transcript is in append order). */
function firstFrom(transcript: readonly TranscriptMessage[], time: number): number {
  let lo = 0;
  let hi = transcript.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (transcript[mid].createdAt < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Whether the reply that streamed narration created at `time` was saved: true when the next
 * assistant message comes before any later user or system message (a user message in the same
 * millisecond was the request it answered), false when one came first, null while nothing follows.
 */
function replySaved(transcript: readonly TranscriptMessage[], time: number): boolean | null {
  for (let i = firstFrom(transcript, time); i < transcript.length; i++) {
    const message = transcript[i];
    if (message.param.role === 'assistant') return true;
    if (message.createdAt > time) return false;
  }
  return null;
}

/**
 * Compare the active session's log with its transcript. `busy`: the DM is mid-turn, so a reply may
 * still be on its way and nothing at the end counts as missed yet.
 */
export function dmContextGaps(
  log: readonly LogEntry[],
  transcript: readonly TranscriptMessage[],
  sessionId: string | null,
  busy: boolean,
): DmContextGaps {
  // A session's transcript starts with its opening request; without one there is nothing to compare.
  if (!sessionId || transcript.length === 0) return NONE;
  const cutOffIds = new Set<string>();
  let lastPlayer: Extract<LogEntry, { kind: 'player' }> | null = null;
  let refused = false;
  for (const entry of log) {
    if (entry.sessionId !== sessionId) continue;
    if (entry.kind === 'player') {
      lastPlayer = entry;
      refused = false;
    } else if (entry.kind === 'system' && entry.level === 'warning') {
      // After an unanswered turn the only warning is Claude declining it: the words were set aside.
      refused = true;
    } else if (entry.kind === 'dm' && entry.text.trim() && !(busy && entry.streaming)) {
      const saved = replySaved(transcript, entry.createdAt);
      if (saved === false || (saved === null && !busy)) cutOffIds.add(entry.id);
    }
  }
  let pendingPlayerId: string | null = null;
  if (lastPlayer && !busy && !refused) {
    const since = lastPlayer.createdAt;
    const answered = transcript.slice(firstFrom(transcript, since)).some((m) => m.param.role === 'assistant');
    if (!answered) pendingPlayerId = lastPlayer.id;
  }
  return cutOffIds.size === 0 && pendingPlayerId === null ? NONE : { cutOffIds, pendingPlayerId };
}

/** The DM's note under a reply the player stopped mid-stream (logged by src/dm). */
export function isStoppedNote(entry: LogEntry): boolean {
  return entry.kind === 'system' && entry.level === 'info' && /^Stopped\b/.test(entry.text);
}
