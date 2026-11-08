/**
 * The streaming agent loop (the "Streaming Manual Loop" pattern): send the transcript, stream
 * narration into the log, append the complete assistant message, run its tool calls, append all
 * of their results in one user message, and repeat until the DM hands the turn back.
 *
 * Append-only: nothing earlier in the transcript is ever changed here. A request that is refused
 * or cut off mid-tool-call appends nothing. A request the player stops mid-stream appends only the
 * narration they saw (text blocks, no unfinished thinking or tool calls), so the DM's context
 * matches the log. While a tool batch runs, each finished tool's result is saved on the session, so
 * a reload mid-batch can answer the finished tools with their real results.
 */
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaToolResultBlockParam,
  BetaToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { characterStatusLine } from '@/engine';
import { hasImported, redactImported } from '@/lib/importedContent';
import type { DmPhase } from '@/state/gameStore';
import { MODELS, type PendingToolResult } from '@/types';
import { contextTokensOf, longContextThreshold, usageDelta } from './cost';
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
/** The cap while the active fight is on a battle map: a mapped round moves every creature first (D52). */
export const MAX_MAPPED_ITERATIONS = 40;
export const MAX_JSON_RETRIES = 2;

export const SOFT_LIMIT_PREFIX = 'This session is getting long';

export const NOTES = {
  interrupted:
    'Interrupted: the app was closed or reloaded while this call was running, before its result was recorded. It may already have taken effect (or, for a roll, the player may not have rolled yet), so check the current state before you repeat it: the <game_state> status line, get_character_sheet, the journal or the combat tracker.',
  notRun: 'Not run: the app was closed or reloaded before this call started, so nothing happened. Call it again if it still matters.',
  cancelled: 'Cancelled by the player before it resolved. Nothing happened.',
  /** Shown in the log under narration the player stopped (the DM keeps what they saw). */
  stopped: 'Stopped. The DM will know its reply was cut off here.',
  /** Told to the DM with the next turn after the player stopped a reply mid-stream. */
  stoppedNotice:
    'The player stopped your last reply partway through. It ends exactly where they stopped it, and nothing after that point happened (no tool calls ran for it). Respond to what the player says now; don\'t resume the cut-off sentence unless they ask you to go on.',
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
  /** Requests per turn (default MAX_ITERATIONS); a function is read before each request, so the cap can follow the game. */
  maxIterations?: number | (() => number);
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

// ---------------------------------------------------------------------------
// Tool results of an unfinished batch (saved as each tool finishes)
// ---------------------------------------------------------------------------

function resultText(result: BetaToolResultBlockParam): string {
  const content = result.content;
  if (typeof content === 'string') return content;
  return (content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

/** What is saved for a finished tool: its result, with imported book text left out of storage. */
function pendingFrom(result: BetaToolResultBlockParam): PendingToolResult {
  const text = resultText(result);
  return {
    toolUseId: result.tool_use_id,
    content: hasImported(text) ? redactImported(text) : text,
    ...(result.is_error ? { isError: true } : {}),
  };
}

async function savePendingResults(d: DmDeps, results: readonly BetaToolResultBlockParam[]): Promise<void> {
  try {
    await d.store().updateSession({ pendingToolResults: results.map(pendingFrom) });
  } catch (err) {
    // Best effort: without it a reload mid-batch reports the finished tools as interrupted.
    console.warn("[dm] Couldn't save the finished tool results:", err);
  }
}

async function clearPendingResults(d: DmDeps): Promise<void> {
  if (!d.store().activeSession?.pendingToolResults?.length) return;
  try {
    await d.store().updateSession({ pendingToolResults: null });
  } catch (err) {
    console.warn("[dm] Couldn't clear the saved tool results:", err);
  }
}

/**
 * If the transcript ends with tool calls that never got results (the tab closed or reloaded
 * mid-batch), answer them so the transcript stays valid. Append-only. Tools that finished before
 * the reload get their saved results (their effects are already in the game state); the call that
 * was running gets an "interrupted, check the state" note with the hero's current status; calls
 * after it never started.
 */
export async function answerUnfinishedToolCalls(d: DmDeps): Promise<void> {
  const store = d.store();
  const pending = unansweredToolUses(store.transcript);
  if (pending.length === 0) {
    await clearPendingResults(d);
    return;
  }
  const saved = new Map((store.activeSession?.pendingToolResults ?? []).map((r) => [r.toolUseId, r]));
  const status = store.character ? characterStatusLine(store.character) : null;
  let runningSeen = false;
  const results = pending.map((block): BetaToolResultBlockParam => {
    const done = saved.get(block.id);
    if (done) return toolResult(block.id, { content: done.content, isError: done.isError });
    if (runningSeen) return errorResult(block.id, NOTES.notRun);
    runningSeen = true;
    return errorResult(block.id, status ? `${NOTES.interrupted} The hero now: ${status}` : NOTES.interrupted);
  });
  await store.appendTranscript([toolResultMessage(results)]);
  await clearPendingResults(d);
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * Suggest wrapping up once the context passes the soft limit, or sooner when the model bills long
 * prompts at a higher rate (Claude Haiku 5.5 above 100K tokens) — once per session.
 */
async function warnIfSessionLong(d: DmDeps, contextTokens: number, softLimit: number, model: string): Promise<void> {
  const store = d.store();
  const session = store.activeSession;
  const pricier = longContextThreshold(model);
  const limit = pricier !== null ? Math.min(softLimit, pricier) : softLimit;
  if (!session || contextTokens <= limit) return;
  const already = store.log.some((e) => e.kind === 'system' && e.sessionId === session.id && e.text.startsWith(SOFT_LIMIT_PREFIX));
  if (already) return;
  const k = Math.round(contextTokens / 1000);
  const label = MODELS.find((m) => m.id === model)?.label ?? model;
  const rate =
    pricier !== null && contextTokens > pricier
      ? ` ${label} bills prompts over ${Math.round(pricier / 1000)}k tokens at a higher rate (about five times as much per token).`
      : '';
  await systemNote(
    d,
    `${SOFT_LIMIT_PREFIX} (about ${k}k tokens of context), so each turn costs more.${rate} Consider ending the session soon: the DM writes a recap and the next session starts fresh, with the story carried over.`,
    'info',
  );
}

async function recordUsage(d: DmDeps, message: BetaMessage): Promise<void> {
  const u = message.usage;
  const total = u.input_tokens + u.output_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  if (total === 0 && !u.iterations?.length) return; // the offline demo DM reports no usage
  const settings = d.settings();
  const store = d.store();
  // Priced per attempt at the model that ran it (a server-side fallback bills at its own rates).
  await store.addUsage(usageDelta(u, message.model, settings.cacheTtl, settings.model));
  const contextTokens = contextTokensOf(u);
  await store.updateSession({ contextTokens });
  await warnIfSessionLong(d, contextTokens, settings.sessionSoftLimitTokens, settings.model);
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
      const stopped = opts.signal.aborted || isAbortError(err);
      await consumer.finish({ stopped });
      if (stopped) {
        await keepStoppedNarration(d, opts, consumer);
        return null;
      }
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

/**
 * The player stopped a reply mid-stream: keep what they saw as a text-only assistant message (the
 * unfinished thinking and tool calls are dropped), so the DM knows what is on screen — for the
 * X-card, exactly what to steer away from. Append-only; the DM is told about the stop with the next
 * turn (see NOTES.stoppedNotice).
 */
async function keepStoppedNarration(d: DmDeps, opts: LoopOptions, consumer: StreamConsumer): Promise<void> {
  if (opts.mode !== 'play') return;
  const text = consumer.visibleText();
  if (!text) return;
  const store = d.store();
  // A paused turn's continuation can't be followed by a second assistant message.
  if (!store.activeSession || store.transcript.at(-1)?.param.role === 'assistant') return;
  await store.appendTranscript([{ role: 'assistant', content: [{ type: 'text', text }] }]);
  await systemNote(d, NOTES.stopped, 'info');
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
      // Its effects are already saved: keep its result too, in case the app closes mid-batch.
      await savePendingResults(d, results);
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
  await clearPendingResults(d);
  return cancelled ? { outcome: 'cancelled', finalText: '' } : null;
}

/** Run the DM until it hands the turn back (or is cancelled, refused, cut off or capped). */
export async function runAgentLoop(d: DmDeps, opts: LoopOptions): Promise<LoopResult> {
  if (!owesReply(d.store().transcript)) return { outcome: 'done', finalText: '' };
  await answerUnfinishedToolCalls(d);
  const turn = new TurnLog();
  const cap = opts.maxIterations ?? MAX_ITERATIONS;
  const max = typeof cap === 'function' ? cap : () => cap;
  try {
    for (let i = 0; i < max(); i++) {
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
