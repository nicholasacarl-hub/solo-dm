import { describe, expect, it } from 'vitest';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { LogEntry, TranscriptMessage } from '@/types';
import { dmContextGaps, isStoppedNote } from './dmContext';

const SESSION = 'sess-1';
let seq = 0;

function entry(kind: LogEntry['kind'], createdAt: number, patch: Record<string, unknown> = {}): LogEntry {
  seq += 1;
  const base = { id: `${kind}-${seq}`, campaignId: 'camp-1', sessionId: SESSION, seq, createdAt };
  const defaults: Record<string, Record<string, unknown>> = {
    dm: { text: 'The fog parts.' },
    player: { text: 'I open the door.' },
    system: { level: 'info', text: 'A note.' },
    error: { text: 'The DM could not be reached.', retryable: true },
  };
  return { ...base, kind, ...defaults[kind], ...patch } as LogEntry;
}

function message(role: 'user' | 'assistant' | 'system', createdAt: number): TranscriptMessage {
  seq += 1;
  const param = { role, content: [{ type: 'text', text: role }] } as unknown as BetaMessageParam;
  return { id: `m-${seq}`, sessionId: SESSION, seq, param, createdAt };
}

describe('dmContextGaps', () => {
  it('finds nothing missing when every reply was saved', () => {
    const opening = entry('dm', 110);
    const player = entry('player', 200);
    const reply = entry('dm', 310);
    const transcript = [message('user', 100), message('assistant', 150), message('user', 200), message('assistant', 400)];
    const gaps = dmContextGaps([opening, player, reply], transcript, SESSION, false);
    expect([...gaps.cutOffIds]).toEqual([]);
    expect(gaps.pendingPlayerId).toBeNull();
  });

  it("marks narration whose reply never reached the transcript and the player's unanswered words", () => {
    const opening = entry('dm', 110);
    const player = entry('player', 200);
    // The request failed mid-stream (or the page reloaded): the narration stayed, nothing was saved.
    const partial = entry('dm', 310, { streaming: true });
    const error = entry('error', 320);
    const transcript = [message('user', 100), message('assistant', 150), message('user', 200)];
    const gaps = dmContextGaps([opening, player, partial, error], transcript, SESSION, false);
    expect([...gaps.cutOffIds]).toEqual([partial.id]);
    expect(gaps.pendingPlayerId).toBe(player.id);
  });

  it('keeps marking cut-off narration after the next turn was sent', () => {
    const player = entry('player', 200);
    const partial = entry('dm', 310);
    const next = entry('player', 500);
    const reply = entry('dm', 610);
    const transcript = [message('user', 100), message('assistant', 150), message('user', 500), message('assistant', 700)];
    const gaps = dmContextGaps([player, partial, next, reply], transcript, SESSION, false);
    expect([...gaps.cutOffIds]).toEqual([partial.id]);
    expect(gaps.pendingPlayerId).toBeNull();
  });

  it('waits while the DM is busy: a reply may still be on its way', () => {
    const player = entry('player', 200);
    const streaming = entry('dm', 310, { streaming: true });
    const firstBlock = entry('dm', 305);
    const transcript = [message('user', 100), message('assistant', 150), message('user', 200)];
    const gaps = dmContextGaps([player, firstBlock, streaming], transcript, SESSION, true);
    expect([...gaps.cutOffIds]).toEqual([]);
    expect(gaps.pendingPlayerId).toBeNull();
  });

  it('counts a reply the player stopped as seen (its visible text was saved)', () => {
    const player = entry('player', 200);
    const stopped = entry('dm', 310);
    const note = entry('system', 330, { text: 'Stopped. The DM will know its reply was cut off here.' });
    const transcript = [message('user', 100), message('assistant', 150), message('user', 200), message('assistant', 330)];
    const gaps = dmContextGaps([player, stopped, note], transcript, SESSION, false);
    expect([...gaps.cutOffIds]).toEqual([]);
    expect(gaps.pendingPlayerId).toBeNull();
    expect(isStoppedNote(note)).toBe(true);
  });

  it('treats a message saved in the same millisecond as the narration as the request it answered', () => {
    const player = entry('player', 200);
    const reply = entry('dm', 200);
    const transcript = [message('user', 100), message('assistant', 150), message('user', 200), message('assistant', 201)];
    expect([...dmContextGaps([player, reply], transcript, SESSION, false).cutOffIds]).toEqual([]);
  });

  it('does not promise to resend words Claude refused (they were set aside)', () => {
    const player = entry('player', 200);
    const refused = entry('system', 300, { level: 'warning', text: 'Claude declined to continue the story here.' });
    const transcript = [message('user', 100), message('assistant', 150), message('user', 200)];
    expect(dmContextGaps([player, refused], transcript, SESSION, false).pendingPlayerId).toBeNull();
  });

  it('shows the pending note after a stop before any narration', () => {
    const player = entry('player', 200);
    const transcript = [message('user', 100), message('assistant', 150), message('user', 200)];
    expect(dmContextGaps([player], transcript, SESSION, false).pendingPlayerId).toBe(player.id);
    expect(dmContextGaps([player], transcript, SESSION, true).pendingPlayerId).toBeNull();
  });

  it('only looks at the active session, and needs its transcript', () => {
    const old = { ...entry('dm', 50), sessionId: 'sess-0' } as LogEntry;
    const player = entry('player', 200);
    const transcript = [message('user', 100), message('assistant', 150), message('user', 200)];
    expect([...dmContextGaps([old, player], transcript, SESSION, false).cutOffIds]).toEqual([]);
    expect(dmContextGaps([player], [], SESSION, false).pendingPlayerId).toBeNull();
    expect(dmContextGaps([player], transcript, null, false).pendingPlayerId).toBeNull();
  });
});

describe('isStoppedNote', () => {
  it("recognises the DM's note under a stopped reply, and nothing else", () => {
    expect(isStoppedNote(entry('system', 1, { text: 'Stopped. The DM will know its reply was cut off here.' }))).toBe(true);
    expect(isStoppedNote(entry('system', 1, { text: 'You edited your character sheet.' }))).toBe(false);
    expect(isStoppedNote(entry('dm', 1, { text: 'Stopped by the guards, you wait.' }))).toBe(false);
  });
});
