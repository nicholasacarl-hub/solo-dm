/**
 * The streaming agent loop (the "Streaming Manual Loop" pattern): send the transcript, stream
 * narration into the log, append the complete assistant message, run its tool calls, append all
 * of their results in one user message, and repeat until the DM hands the turn back.
 *
 * Append-only: nothing earlier in the transcript is ever changed here. A request that is
 * cancelled, refused or cut off mid-tool-call appends nothing.
 */
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaToolResultBlockParam,
  BetaToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { DmPhase } from '@/state/gameStore';
import { MODELS } from '@/types';
import { contextTokensOf, usageDelta } from './cost';
import type { DmClient, DmDeps, DmMessageStream } from './deps';
import { DmError, isAbortError, isUnparseableStreamError } from './errors';
import { buildMessageRequest } from './request';
import { flushLeftoverReasoning, StreamConsumer, TurnLog } from './stream';
import type { ToolContext, ToolOutcome } from './tools/context';
import { toolActivity } from './tools/definitions';
import { runTool } from './tools/handlers';
import {
  assistantContentForTranscript,
  isTurnUnanswered,
  owesReply,
  toolResultMessage,
  toolUsesOf,
  unansweredToolUses,
} from './transcript';

export const MAX_ITERATIONS = 24;
export const MAX_JSON_RETRIES = 2;

export const SOFT_LIMIT_PREFIX = 'This session is getting long';

export const NOTES = {
  interrupted: 'Interrupted: the app was closed or reloaded before this finished. Nothing happened; call it again if it still matters.',
  cancelled: 'Cancelled by the player before it resolved. Nothing happened.',
  truncatedTool:
    "The DM's reply was cut off before it finished an action (it hit the response length limit). Retry, or raise Max tokens in Settings.",
  truncatedText: "The DM's reply hit the length limit and was cut off. Ask it to go on, or raise Max tokens in Settings.",
  contextFull: "The session's context is full, so the DM's reply was cut off. End the session to continue in a fresh one — the story carries over.",
  empty: 'The DM ended its turn without saying anything. Send a message to continue, or Regenerate.',
  iterationLimit: 'The DM took many steps this turn and paused to hand it back to you. Send a message to continue.',
  refusedTurn:
    'Claude declined to continue the story here (its safety systems stopped the reply). Your last message was set aside — rephrase it, or take the scene in another direction.',
  refusedMidTurn: 'Claude stopped partway through this turn (its safety systems stopped the reply). Try steering the scene another way.',
} as const;

export type LoopOutcome = 'done' | 'refused' | 'cancelled' | 'truncated' | 'iteration-limit';

export interface LoopOptions {
  client: DmClient;
  signal: AbortSignal;
  /** 'ending' writes the private recap: no narration is streamed into the log. */
  mode: 'play' | 'ending';
  /** Status text while waiting for the first response. */
  waitingText?: string;
  maxIterations?: number;
}

export interface LoopResult {
  outcome: LoopOutcome;
  /** Text of the final assistant message (for parsing the recap). */
  finalText: string;
}

/** A request failed with an error; carries the narration it left in the log (removed on retry). */
export class AgentFailure extends Error {
  constructor(
    readonly error: unknown,
    readonly partialLogIds: string[],
  ) {
    super(error instanceof Error ? error.message : String(error));
    this.name = 'AgentFailure';
  }
}

function phaseFor(opts: LoopOptions, phase: DmPhase): DmPhase {
  return opts.mode === 'ending' && (phase === 'tool' || phase === 'thinking' || phase === 'streaming') ? 'ending-session' : phase;
}

function textOfBlocks(content: readonly BetaContentBlockParam[]): string {
  return content
    .filter((b): b is Extract<BetaContentBlockParam, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')
    .trim();
}

function toolResult(id: string, outcome: ToolOutcome): BetaToolResultBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: id,
    content: outcome.content.trim() || 'Done.',
    ...(outcome.isError ? { is_error: true } : {}),
  };
}

function errorResult(id: string, text: string): BetaToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: id, content: text, is_error: true };
}

async function systemNote(d: DmDeps, text: string, level: 'info' | 'warning' = 'warning'): Promise<void> {
  await d.store().appendLog({ kind: 'system', level, text });
}

/**
 * If the transcript ends with tool calls that never got results (the tab closed mid-tool),
 * answer them with error results so the transcript stays valid. Append-only.
 */
export async function answerUnfinishedToolCalls(d: DmDeps): Promise<void> {
  const pending = unansweredToolUses(d.store().transcript);
  if (pending.length === 0) return;
  await d.store().appendTranscript([toolResultMessage(pending.map((b) => errorResult(b.id, NOTES.interrupted)))]);
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

const softLimitWarned = new Set<string>();

async function warnIfSessionLong(d: DmDeps, contextTokens: number, limit: number): Promise<void> {
  const store = d.store();
  const session = store.activeSession;
  if (!session || contextTokens <= limit || softLimitWarned.has(session.id)) return;
  softLimitWarned.add(session.id);
  const already = store.log.some((e) => e.kind === 'system' && e.sessionId === session.id && e.text.startsWith(SOFT_LIMIT_PREFIX));
  if (already) return;
  const k = Math.round(contextTokens / 1000);
  await systemNote(
    d,
    `${SOFT_LIMIT_PREFIX} (about ${k}k tokens of context), so each turn costs more. Consider ending the session soon: the DM writes a recap and the next session starts fresh, with the story carried over.`,
    'info',
  );
}

async function recordUsage(d: DmDeps, message: BetaMessage): Promise<void> {
  const u = message.usage;
  const total = u.input_tokens + u.output_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  if (total === 0) return; // the offline demo DM reports no usage
  const settings = d.settings();
  const model = MODELS.some((m) => m.id === message.model) ? message.model : settings.model;
  const store = d.store();
  await store.addUsage(usageDelta(u, model, settings.cacheTtl));
  const contextTokens = contextTokensOf(u);
  await store.updateSession({ contextTokens });
  await warnIfSessionLong(d, contextTokens, settings.sessionSoftLimitTokens);
}

// ---------------------------------------------------------------------------
// One request (with re-issue on unparseable tool-input JSON)
// ---------------------------------------------------------------------------

interface Response {
  message: BetaMessage;
  consumer: StreamConsumer;
}

async function requestOnce(d: DmDeps, opts: LoopOptions, turn: TurnLog): Promise<Response | null> {
  for (let attempt = 0; ; attempt++) {
    const store = d.store();
    const session = store.activeSession;
    if (!session) throw new AgentFailure(new DmError('No session is active.', { retryable: false }), []);
    const settings = d.settings();
    const params = buildMessageRequest(settings, session, store.transcript);
    const consumer = new StreamConsumer({
      deps: d,
      turn,
      narrate: opts.mode === 'play',
      display: settings.thinkingDisplay,
      streamingPhase: opts.mode === 'ending' ? 'ending-session' : 'streaming',
    });
    let stream: DmMessageStream | null = null;
    const onAbort = () => stream?.abort();
    opts.signal.addEventListener('abort', onAbort);
    try {
      stream = opts.client.beta.messages.stream(params, { signal: opts.signal });
      for await (const event of stream) consumer.handle(event);
      const message = await stream.finalMessage();
      await consumer.finish();
      return { message, consumer };
    } catch (err) {
      await consumer.finish();
      if (opts.signal.aborted || isAbortError(err)) return null;
      if (isUnparseableStreamError(err) && attempt < MAX_JSON_RETRIES) {
        await consumer.discard();
        continue;
      }
      throw new AgentFailure(err, [...consumer.createdIds]);
    } finally {
      opts.signal.removeEventListener('abort', onAbort);
    }
  }
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

async function runToolCalls(
  d: DmDeps,
  opts: LoopOptions,
  toolUses: readonly BetaToolUseBlockParam[],
): Promise<{ results: BetaToolResultBlockParam[]; cancelled: boolean }> {
  const ctx: ToolContext = {
    deps: d,
    signal: opts.signal,
    status: (activity, phase = 'tool') => d.store().setDmStatus({ phase: phaseFor(opts, phase), activity }),
  };
  const results: BetaToolResultBlockParam[] = [];
  let cancelled = false;
  for (const block of toolUses) {
    if (cancelled || opts.signal.aborted) {
      cancelled = true;
      results.push(errorResult(block.id, NOTES.cancelled));
      continue;
    }
    ctx.status(toolActivity(block.name, block.input));
    try {
      results.push(toolResult(block.id, await runTool(block.name, block.input, ctx)));
    } catch (err) {
      if (!isAbortError(err) && !opts.signal.aborted) throw err;
      cancelled = true;
      results.push(errorResult(block.id, NOTES.cancelled));
    }
  }
  return { results, cancelled };
}

// ---------------------------------------------------------------------------
// Stop reasons
// ---------------------------------------------------------------------------

async function handleResponse(d: DmDeps, opts: LoopOptions, { message, consumer }: Response): Promise<LoopResult | null> {
  const store = d.store();
  // A refusal can cut a tool call off mid-input: check it before reading content, run nothing.
  if (message.stop_reason === 'refusal') {
    await consumer.discard();
    await systemNote(d, isTurnUnanswered(store.transcript) ? NOTES.refusedTurn : NOTES.refusedMidTurn);
    return { outcome: 'refused', finalText: '' };
  }

  const content = assistantContentForTranscript(message.content);
  const toolUses = toolUsesOf(content);
  const finalText = textOfBlocks(content);
  const cutOff = message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded';

  if (cutOff && toolUses.length > 0) {
    // A truncated tool input can still look valid: never run it, and append nothing.
    throw new AgentFailure(new DmError(NOTES.truncatedTool, { retryable: true }), [...consumer.createdIds]);
  }
  if (content.length === 0) {
    if (opts.mode === 'play') await systemNote(d, NOTES.empty, 'info');
    return { outcome: 'done', finalText: '' };
  }

  await store.appendTranscript([{ role: 'assistant', content }]);

  if (cutOff) {
    await systemNote(d, message.stop_reason === 'max_tokens' ? NOTES.truncatedText : NOTES.contextFull);
    return { outcome: 'truncated', finalText };
  }
  if (toolUses.length === 0) {
    if (message.stop_reason === 'pause_turn') return null;
    if (!finalText && opts.mode === 'play') await systemNote(d, NOTES.empty, 'info');
    return { outcome: 'done', finalText };
  }

  const { results, cancelled } = await runToolCalls(d, opts, toolUses);
  await store.appendTranscript([toolResultMessage(results)]);
  return cancelled ? { outcome: 'cancelled', finalText: '' } : null;
}

/** Run the DM until it hands the turn back (or is cancelled, refused, cut off or capped). */
export async function runAgentLoop(d: DmDeps, opts: LoopOptions): Promise<LoopResult> {
  if (!owesReply(d.store().transcript)) return { outcome: 'done', finalText: '' };
  await answerUnfinishedToolCalls(d);
  const turn = new TurnLog();
  const max = opts.maxIterations ?? MAX_ITERATIONS;
  try {
    for (let i = 0; i < max; i++) {
      if (opts.signal.aborted) return { outcome: 'cancelled', finalText: '' };
      d.store().setDmStatus({
        phase: phaseFor(opts, 'thinking'),
        activity: i === 0 && opts.waitingText ? opts.waitingText : 'The DM is thinking…',
        error: null,
        retryable: false,
      });
      const response = await requestOnce(d, opts, turn);
      if (!response) return { outcome: 'cancelled', finalText: '' };
      await recordUsage(d, response.message);
      const result = await handleResponse(d, opts, response);
      if (result) return result;
    }
    await systemNote(d, NOTES.iterationLimit, 'info');
    return { outcome: 'iteration-limit', finalText: '' };
  } finally {
    await flushLeftoverReasoning(d, turn);
  }
}
