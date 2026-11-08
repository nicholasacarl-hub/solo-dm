import { describe, expect, it } from 'vitest';
import type { TranscriptMessage } from '@/types';
import { isSeqAnswered } from './answered';

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
});
