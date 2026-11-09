/**
 * One extraction request (spec §3.8): build it, stream it with maxRetries 0 under a no-event watchdog,
 * then read the answer: stop_reason first, then the joined text, then the text after the last
 * `fallback` block, then case-fold enums, then WIRE[kind].safeParse. Thrown SDK errors (and
 * IdleTimeoutError) propagate to the runner, which classifies them by class.
 *
 * Owner: E2. The only extraction call site of the Messages API (src/dm/requestAudit.test.ts).
 */
import { AnthropicError, APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaMessage,
  BetaRawMessageStreamEvent,
  BetaUsage,
  MessageCreateParamsBase,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { WIRE, type Wire } from '@/data/structured/wire';
import type { StructuredKind, UsageTotals } from '@/types';
import { usageDelta } from '../cost';
import { buildExtractionRequest, type ExtractionRequestInput } from '../libraryRequests';
import { extractionFormat, foldEnumCase } from './format';

/** The parts of a message stream extraction uses. The SDK's BetaMessageStream satisfies it. */
export interface ExtractionStream extends AsyncIterable<BetaRawMessageStreamEvent> {
  finalMessage(): Promise<BetaMessage>;
  abort(): void;
}
/** The parts of the Anthropic client extraction uses; the SDK client and src/dm/testing/fakeExtractionClient.ts satisfy it. */
export interface ExtractionClient {
  beta: {
    messages: {
      stream(params: MessageCreateParamsBase, options?: { signal?: AbortSignal; maxRetries?: number }): ExtractionStream;
    };
  };
}

export type ExtractionOutcome<K extends StructuredKind = StructuredKind> =
  | { type: 'ok'; wire: Wire<K>; model: string; usage: UsageTotals; cacheRead: number }
  | { type: 'refused'; category: string | null; model: string; usage: UsageTotals }
  | { type: 'truncated'; model: string; usage: UsageTotals }
  | { type: 'invalid'; issue: string; model: string; usage: UsageTotals };

/** A stream with no event for this long is aborted (the runner retries it like a timeout). */
export const IDLE_TIMEOUT_MS = 120_000;

/** Thrown by runExtraction when the watchdog aborts a silent stream. */
export class IdleTimeoutError extends Error {
  constructor() {
    super(`Claude sent nothing for ${IDLE_TIMEOUT_MS / 1000} seconds.`);
    this.name = 'IdleTimeoutError';
  }
}

/** An API error `type` → the HTTP status the same error has when it comes back before the stream starts. */
const STATUS_OF_TYPE: Readonly<Record<string, number>> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
};

/**
 * A stream failure as the SDK class it stands for, so the runner classifies it by class like any other:
 * - An `event: error` after a 200 (the API sends overloaded_error that way under load) reaches us as a
 *   plain APIError with no status and the error's `type` (SDK core/streaming.ts). It becomes the class the
 *   same error has over HTTP: overloaded_error → OverloadedError, api_error → InternalServerError,
 *   rate_limit_error → RateLimitError, and so on.
 * - A connection that drops mid-stream reaches us as a plain AnthropicError wrapping the fetch TypeError
 *   (SDK lib/BetaMessageStream.ts). It becomes an APIConnectionError.
 * Anything else (typed classes, aborts, an unknown type) is returned as it is.
 */
export function typedStreamError(err: unknown): unknown {
  if (err instanceof APIError) {
    if (err.status !== undefined || err instanceof APIConnectionError || err instanceof APIUserAbortError) return err;
    const status = err.type ? STATUS_OF_TYPE[err.type] : undefined;
    return status ? APIError.generate(status, err.error, err.message, err.headers ?? new Headers()) : err;
  }
  if (err instanceof AnthropicError && err.cause instanceof TypeError) return new APIConnectionError({ message: 'Connection error.', cause: err.cause });
  return err;
}

/** The usage a stream has reported so far: message_start's, then each message_delta's running totals (as the SDK accumulates them). */
interface StreamedUsage { model: string; usage: BetaUsage | null }
function noteStreamedUsage(seen: StreamedUsage, event: BetaRawMessageStreamEvent): void {
  if (event.type === 'message_start') {
    seen.model = event.message.model;
    seen.usage = { ...event.message.usage };
  } else if (event.type === 'message_delta' && seen.usage) {
    const u = event.usage;
    seen.usage = {
      ...seen.usage,
      output_tokens: u.output_tokens,
      ...(u.input_tokens != null ? { input_tokens: u.input_tokens } : {}),
      ...(u.cache_creation_input_tokens != null ? { cache_creation_input_tokens: u.cache_creation_input_tokens } : {}),
      ...(u.cache_read_input_tokens != null ? { cache_read_input_tokens: u.cache_read_input_tokens } : {}),
      ...(u.iterations != null ? { iterations: u.iterations } : {}),
    };
  }
}

/**
 * 1. params = buildExtractionRequest(input); a linked AbortController aborts on opts.signal or IDLE_TIMEOUT_MS without an event.
 * 2. stream = client.beta.messages.stream(params, { signal, maxRetries: 0 }); the first event calls onFirstEvent()
 *    (message_start: the kind's cache entry is now readable); every event re-arms the watchdog.
 * 3. message = await stream.finalMessage(); usage = usageDelta(message.usage, message.model, '5m', input.model).
 * 4. stop_reason 'refusal' → refused (stop_details?.category); 'max_tokens' → truncated. Content is not read in either case.
 * 5. readWire(kind, message.content) → ok | invalid.
 * A stream that fails after message_start reports the usage it had streamed through onPartialUsage (the
 * job's ledger and spending limit count it), then throws: a mid-stream error as its SDK class
 * (typedStreamError), the watchdog as IdleTimeoutError.
 */
export async function runExtraction<K extends StructuredKind>(
  client: ExtractionClient,
  input: ExtractionRequestInput & { kind: K },
  opts: { signal?: AbortSignal; onFirstEvent?: () => void; onPartialUsage?: (usage: UsageTotals) => void },
): Promise<ExtractionOutcome<K>> {
  const params = buildExtractionRequest(input);
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  else opts.signal?.addEventListener('abort', forward, { once: true });
  let idle = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      idle = true;
      controller.abort();
    }, IDLE_TIMEOUT_MS);
  };
  arm();
  let stream: ExtractionStream | undefined;
  const seen: StreamedUsage = { model: '', usage: null };
  try {
    stream = client.beta.messages.stream(params, { signal: controller.signal, maxRetries: 0 });
    let first = true;
    for await (const event of stream) {
      noteStreamedUsage(seen, event);
      if (first) {
        first = false;
        opts.onFirstEvent?.();
      }
      arm();
    }
    const message = await stream.finalMessage();
    const model = message.model || input.model;
    const usage = usageDelta(message.usage, model, '5m', input.model);
    if (message.stop_reason === 'refusal') return { type: 'refused', category: message.stop_details?.category ?? null, model, usage };
    if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') return { type: 'truncated', model, usage };
    const read = readWire(input.kind, message.content);
    if (!read.ok) return { type: 'invalid', issue: read.issue, model, usage };
    return { type: 'ok', wire: read.wire, model, usage, cacheRead: message.usage.cache_read_input_tokens ?? 0 };
  } catch (err) {
    if (seen.usage) opts.onPartialUsage?.(usageDelta(seen.usage, seen.model || input.model, '5m', input.model));
    if (idle) {
      stream?.abort();
      throw new IdleTimeoutError();
    }
    throw typedStreamError(err);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', forward);
  }
}

/** Index of the last `fallback` block (blocks before it belong to a model that declined), or -1. */
function fallbackBoundary(content: readonly BetaContentBlock[]): number {
  for (let i = content.length - 1; i >= 0; i--) if (content[i].type === 'fallback') return i;
  return -1;
}

const textOf = (blocks: readonly BetaContentBlock[]) => blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');

/** Candidate JSON texts: all text blocks joined (a streamed mid-output fallback continues the declined model's partial
 *  text), then the text after the last `fallback` block (a fallback that restarted). Same boundary rule as transcript.ts:75-80. */
export function answerCandidates(content: readonly BetaContentBlock[]): string[] {
  const joined = textOf(content).trim();
  const boundary = fallbackBoundary(content);
  const after = boundary < 0 ? '' : textOf(content.slice(boundary + 1)).trim();
  return [...new Set([joined, after].filter(Boolean))];
}

/** A ```json fence around the answer, removed. */
const unfence = (text: string) => /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(text.trim())?.[1] ?? text;

/** JSON.parse each candidate in order → foldEnumCase(value, extractionFormat(kind).schema) → WIRE[kind].safeParse. */
export function readWire<K extends StructuredKind>(
  kind: K,
  content: readonly BetaContentBlock[],
): { ok: true; wire: Wire<K> } | { ok: false; issue: string } {
  const candidates = answerCandidates(content);
  if (!candidates.length) return { ok: false, issue: 'The answer had no text.' };
  let issue = '';
  for (const text of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(unfence(text));
    } catch {
      issue ||= "The answer wasn't valid JSON.";
      continue;
    }
    const folded = foldEnumCase(value, extractionFormat(kind).schema);
    const parsed = WIRE[kind].safeParse(folded);
    if (parsed.success) return { ok: true, wire: parsed.data as Wire<K> };
    const first = parsed.error.issues[0];
    issue = `The answer didn't fit the format${first ? ` (${first.path.join('.') || 'top level'}: ${first.code})` : ''}.`;
  }
  return { ok: false, issue };
}
