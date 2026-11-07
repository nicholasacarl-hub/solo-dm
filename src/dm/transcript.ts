/**
 * Read-only helpers over the append-only API transcript. Nothing here edits a message: the
 * harness only ever appends, or trims from the end (regenerate / an unanswered turn).
 */
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { TranscriptMessage } from '@/types';

export const GAME_STATE_OPEN = '<game_state>';
export const APP_REQUEST_OPEN = '<app_request';

function blocksOf(param: BetaMessageParam): BetaContentBlockParam[] | null {
  if (param.role === 'system') return null;
  return typeof param.content === 'string' ? null : param.content;
}

function firstText(param: BetaMessageParam): string | null {
  if (param.role === 'system') return null;
  if (typeof param.content === 'string') return param.content;
  const first = param.content[0];
  return first?.type === 'text' ? first.text : null;
}

/** A user message that opens a turn: the player's words, a session opening or a wrap-up. */
export function isTurnStart(param: BetaMessageParam): boolean {
  return param.role === 'user' && (firstText(param)?.startsWith(GAME_STATE_OPEN) ?? false);
}

/** The text of a turn start after its <game_state> block: the player's words (or an app request). */
export function turnWords(param: BetaMessageParam): string[] {
  if (!isTurnStart(param)) return [];
  return (blocksOf(param) ?? [])
    .slice(1)
    .filter((b): b is Extract<BetaContentBlockParam, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text);
}

/** The app-authored kind of a turn start, if any ("session_start" / "session_end"). */
export function appRequestKind(param: BetaMessageParam): string | null {
  if (!isTurnStart(param)) return null;
  const blocks = blocksOf(param) ?? [];
  for (const block of blocks) {
    if (block.type !== 'text') continue;
    const match = /^<app_request type="([a-z_]+)"/.exec(block.text);
    if (match) return match[1];
  }
  return null;
}

export function lastTurnStartIndex(messages: readonly TranscriptMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isTurnStart(messages[i].param)) return i;
  }
  return -1;
}

/** True when the latest turn has no assistant reply yet (cancelled, refused or failed before any). */
export function isTurnUnanswered(messages: readonly TranscriptMessage[]): boolean {
  const start = lastTurnStartIndex(messages);
  if (start < 0) return false;
  return !messages.slice(start + 1).some((m) => m.param.role === 'assistant');
}

/** The last message can't be answered by appending a user turn after it (e.g. a trailing system note). */
export function endsWithSystem(messages: readonly TranscriptMessage[]): boolean {
  return messages.at(-1)?.param.role === 'system';
}

/** Index of the last `fallback` block: blocks before it belong to a model that declined. */
function fallbackBoundary(content: readonly BetaContentBlock[] | readonly BetaContentBlockParam[]): number {
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i].type === 'fallback') return i;
  }
  return -1;
}

const DROPPED_BEFORE_FALLBACK = new Set(['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use']);

/**
 * The assistant content to store, as plain JSON. It is the complete final message content,
 * unchanged — except that after a mid-output server-side fallback the declined model's
 * thinking and tool-use blocks before the last `fallback` block are omitted, as the API requires.
 */
export function assistantContentForTranscript(content: readonly BetaContentBlock[]): BetaContentBlockParam[] {
  const boundary = fallbackBoundary(content);
  const kept = boundary < 0 ? content : content.filter((b, i) => i >= boundary || !DROPPED_BEFORE_FALLBACK.has(b.type));
  return JSON.parse(JSON.stringify(kept)) as BetaContentBlockParam[];
}

/** Client tool calls the app must answer (only those after a fallback boundary, if any). */
export function toolUsesOf(content: readonly BetaContentBlockParam[]): BetaToolUseBlockParam[] {
  const boundary = fallbackBoundary(content);
  return content.filter(
    (b, i): b is BetaToolUseBlockParam => b.type === 'tool_use' && i > boundary,
  );
}

/** Text of an assistant message's text blocks. */
export function textOf(param: BetaMessageParam): string {
  if (param.role !== 'assistant') return '';
  if (typeof param.content === 'string') return param.content;
  return param.content
    .filter((b): b is Extract<BetaContentBlockParam, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n');
}

/** Narration of the most recent DM response (all assistant text since the last turn start). */
export function lastDmNarration(messages: readonly TranscriptMessage[]): string {
  let i = messages.length - 1;
  const parts: string[] = [];
  while (i >= 0 && !isTurnStart(messages[i].param)) {
    if (messages[i].param.role === 'assistant') parts.unshift(textOf(messages[i].param));
    i--;
  }
  return parts.filter(Boolean).join('\n\n');
}

/** Names of the tools called in the most recent DM response. */
export function toolsInLastResponse(messages: readonly TranscriptMessage[]): string[] {
  const start = lastTurnStartIndex(messages);
  const names: string[] = [];
  for (const m of messages.slice(start + 1)) {
    if (m.param.role !== 'assistant' || typeof m.param.content === 'string') continue;
    for (const block of toolUsesOf(m.param.content)) names.push(block.name);
  }
  return names;
}

/**
 * Tool calls in the final assistant message that never got a result (the app was closed
 * mid-tool). Answering them with error results keeps the transcript valid.
 */
export function unansweredToolUses(messages: readonly TranscriptMessage[]): BetaToolUseBlockParam[] {
  const last = messages.at(-1)?.param;
  if (!last || last.role !== 'assistant' || typeof last.content === 'string') return [];
  return toolUsesOf(last.content);
}

/**
 * True when the transcript ends in a way the DM must answer: a user or system message, or an
 * assistant message with tool calls still waiting for results. A request ending in a finished
 * assistant message would be a prefill, which the harness never sends.
 */
export function owesReply(messages: readonly TranscriptMessage[]): boolean {
  const last = messages.at(-1)?.param;
  if (!last) return false;
  if (last.role !== 'assistant') return true;
  return typeof last.content !== 'string' && toolUsesOf(last.content).length > 0;
}

export function toolResultMessage(results: BetaToolResultBlockParam[]): BetaMessageParam {
  return { role: 'user', content: results };
}

/** Text of the system notes in `messages`, in order. */
export function systemNotes(messages: readonly TranscriptMessage[]): string[] {
  const notes: string[] = [];
  for (const m of messages) {
    if (m.param.role !== 'system') continue;
    const content = m.param.content;
    if (typeof content === 'string') notes.push(content);
    else if (content) {
      for (const block of content) if (block.type === 'text') notes.push(block.text);
    }
  }
  return notes;
}

/** Text of the system notes that follow the latest turn start (to re-queue if that turn is dropped). */
export function noticesAfterLastTurn(messages: readonly TranscriptMessage[]): string[] {
  const start = lastTurnStartIndex(messages);
  if (start < 0) return [];
  return systemNotes(messages.slice(start + 1));
}
