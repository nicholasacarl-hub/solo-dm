/**
 * A fake Anthropic client for structuring tests (spec §8.4): it satisfies ExtractionClient, answers each
 * stream() from SCRIPTED_WIRE by the title of the request's first block (src/test/structuredFixtures.ts),
 * and records every request (deep-copied, as it would be serialized) with timestamps. Built on
 * src/dm/scripted.ts.
 *
 *   const fake = new FakeExtractionClient({ now: () => clock.now, sleep: clock.sleep });
 *   fake.script('Glimmerwing Drake', { type: 'max_tokens' });   // first drake request truncates, the retry answers
 *   fake.script('Mothkin', { type: 'refusal', category: 'general_harms' });
 *   fake.failNext({ type: 'error', status: 429, retryAfter: 40 });  // the next request of any title
 *   setExtractionDeps({ client: () => fake });
 *
 * Steps for a title are used in order; once they run out the title gets its SCRIPTED_WIRE answer.
 * Usage is deterministic: input ≈ user-message chars / 3.2; the kind's system prompt is a cache write
 * on its first request through this client and a cache read afterwards.
 */
import { AnthropicError, APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaMessage,
  BetaRawMessageStreamEvent,
  BetaRefusalStopDetails,
  BetaUsage,
  MessageCreateParamsBase,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { SCRIPTED_WIRE } from '@/test/structuredFixtures';
import { STRUCTURED_KINDS, type StructuredKind } from '@/types';
import type { ExtractionClient, ExtractionStream } from '../extract/call';
import { EXTRACT_SYSTEM } from '../extract/prompts';
import { makeMessage, messageEvents, scriptedStream, textBlock, thinkingBlock } from '../scripted';

export type ExtractionStep =
  /** A normal answer: `wire` (default: SCRIPTED_WIRE for the title) serialized as the text, or raw `text` (e.g. invalid JSON). */
  | { type: 'answer'; wire?: unknown; text?: string; model?: string; usage?: Partial<BetaUsage>; delayMs?: number }
  /** stop_reason "refusal" with stop_details.category; `partialText` is any text before it. */
  | { type: 'refusal'; category?: BetaRefusalStopDetails['category']; partialText?: string; model?: string; delayMs?: number }
  /** stop_reason "max_tokens" with cut-off JSON. */
  | { type: 'max_tokens'; partialText?: string; delayMs?: number }
  /**
   * A server-side fallback inside the answer: `continue` — the declined model's partial text, a fallback
   * block, then the rest (the joined text parses); `restart` — a partial, the block, then the whole answer
   * again (only the text after the block parses). message.model is `to`.
   */
  | { type: 'fallback'; mode: 'continue' | 'restart'; from?: string; to?: string; wire?: unknown; delayMs?: number }
  /**
   * An error, thrown when the stream is read (as the SDK does). Before the first event (atEvent 0, the
   * default) it is the HTTP error, as its typed class (429 and 529 carry retry-after when given). Later
   * (atEvent ≥ 1: after a 200 and message_start, which carries the input tokens) it is the SDK's real shape
   * of an SSE `event: error`: a plain APIError with no status and the error's `type` (core/streaming.ts).
   */
  | { type: 'error'; status: 400 | 401 | 403 | 404 | 413 | 429 | 500 | 529; retryAfter?: number; message?: string; atEvent?: number }
  /**
   * A connection failure: APIConnectionError before the first event; later, the SDK's real shape of a
   * connection dropped mid-stream, a plain AnthropicError wrapping the fetch TypeError (lib/BetaMessageStream.ts).
   */
  | { type: 'network'; atEvent?: number }
  /** No event ever arrives (until the request is aborted): for the idle watchdog. */
  | { type: 'stall' };

export interface RecordedExtractionRequest {
  /** 1-based, in call order. */
  n: number;
  at: number;
  title: string | null;
  kind: StructuredKind | null;
  params: MessageCreateParamsBase;
  options: { maxRetries?: number; hasSignal: boolean };
  step: ExtractionStep['type'];
  /** When the first stream event was emitted (null: never, e.g. an error before the first event). */
  firstEventAt: number | null;
  /** When the stream ended (finished, failed or aborted). */
  endedAt: number | null;
}

export interface FakeExtractionOptions {
  now?: () => number;
  /** Delay steps and per-event pacing use it (default: real timers). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Model echoed in message.model when the step doesn't name one (default: the request's model). */
  model?: string;
}

const TITLE = /<block id="[^"]*" title="([^"]*)"/;
const CHARS_PER_TOKEN = 3.2;

function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new APIUserAbortError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new APIUserAbortError());
    }, { once: true });
  });
}

/** The text of the request's single user message. */
function userText(params: MessageCreateParamsBase): string {
  const content = params.messages[0]?.content;
  if (typeof content === 'string') return content;
  return (content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
}

function systemText(params: MessageCreateParamsBase): string {
  const system = params.system;
  if (typeof system === 'string') return system;
  return (system ?? []).map((b) => b.text).join('');
}

export function kindOfRequest(params: MessageCreateParamsBase): StructuredKind | null {
  const system = systemText(params);
  return STRUCTURED_KINDS.find((k) => EXTRACT_SYSTEM[k] === system) ?? null;
}

export function titleOfRequest(params: MessageCreateParamsBase): string | null {
  return TITLE.exec(userText(params))?.[1] ?? null;
}

/** A stream that emits nothing until it is aborted. */
function stalledStream(signal: AbortSignal | undefined, onEnd: () => void): ExtractionStream {
  const controller = new AbortController();
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(new APIUserAbortError());
    controller.signal.addEventListener('abort', fail, { once: true });
    signal?.addEventListener('abort', fail, { once: true });
    if (signal?.aborted) fail();
  });
  aborted.catch(() => undefined);
  const final = aborted.finally(onEnd);
  final.catch(() => undefined);
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<BetaRawMessageStreamEvent> => ({
      // Never yields: rejects with APIUserAbortError once the request is aborted.
      next: () => final.then((): IteratorResult<BetaRawMessageStreamEvent> => ({ done: true, value: undefined })),
    }),
    finalMessage: () => final,
    abort: () => controller.abort(),
  };
}

export class FakeExtractionClient implements ExtractionClient {
  readonly requests: RecordedExtractionRequest[] = [];
  private readonly byTitle = new Map<string, ExtractionStep[]>();
  private readonly next: ExtractionStep[] = [];
  private readonly warmKinds = new Set<StructuredKind>();
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly opts: FakeExtractionOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? realSleep;
  }

  /** Queue steps for requests whose first block has this title (used in order, then SCRIPTED_WIRE). */
  script(title: string, ...steps: ExtractionStep[]): this {
    this.byTitle.set(title, [...(this.byTitle.get(title) ?? []), ...steps]);
    return this;
  }

  /** Queue steps for the next requests of any title (they run before per-title steps). */
  failNext(...steps: ExtractionStep[]): this {
    this.next.push(...steps);
    return this;
  }

  /** Requests whose first block had this title. */
  requestsFor(title: string): RecordedExtractionRequest[] {
    return this.requests.filter((r) => r.title === title);
  }

  readonly beta: ExtractionClient['beta'] = {
    messages: {
      stream: (params, options) => this.stream(params, options),
    },
  };

  private stepFor(title: string | null): ExtractionStep {
    const queued = this.next.shift();
    if (queued) return queued;
    const steps = title ? this.byTitle.get(title) : undefined;
    return steps?.shift() ?? { type: 'answer' };
  }

  private usage(params: MessageCreateParamsBase, kind: StructuredKind | null, partial: Partial<BetaUsage> = {}): Partial<BetaUsage> {
    const systemTokens = Math.ceil(systemText(params).length / CHARS_PER_TOKEN);
    const warm = kind !== null && this.warmKinds.has(kind);
    if (kind) this.warmKinds.add(kind);
    return {
      input_tokens: Math.ceil(userText(params).length / CHARS_PER_TOKEN) + 500,
      output_tokens: 400,
      cache_creation_input_tokens: warm ? 0 : systemTokens,
      cache_read_input_tokens: warm ? systemTokens : 0,
      ...partial,
    };
  }

  private message(step: ExtractionStep, params: MessageCreateParamsBase, title: string | null, kind: StructuredKind | null): BetaMessage {
    const model = this.opts.model ?? params.model;
    const scripted = title ? SCRIPTED_WIRE[title]?.wire : undefined;
    const thinking = thinkingBlock('', 'sig-fake');
    switch (step.type) {
      case 'answer': {
        const text = step.text ?? JSON.stringify(step.wire ?? scripted ?? {});
        return makeMessage([thinking, textBlock(text)], 'end_turn', { model: step.model ?? model, usage: this.usage(params, kind, step.usage) });
      }
      case 'refusal':
        return makeMessage(step.partialText ? [textBlock(step.partialText)] : [], 'refusal', {
          model: step.model ?? model,
          usage: this.usage(params, kind, { output_tokens: 20 }),
          stopDetails: { type: 'refusal', category: step.category ?? null, explanation: null, fallback_credit_token: null } as BetaRefusalStopDetails,
        });
      case 'max_tokens':
        return makeMessage([thinking, textBlock(step.partialText ?? '{"matchesKind": true, "name": "')], 'max_tokens', {
          model,
          usage: this.usage(params, kind, { output_tokens: params.max_tokens }),
        });
      case 'fallback': {
        const from = step.from ?? params.model;
        const to = step.to ?? 'claude-sonnet-5-5';
        const full = JSON.stringify(step.wire ?? scripted ?? {});
        const cut = Math.floor(full.length / 2);
        const boundary = {
          type: 'fallback',
          from: { model: from },
          to: { model: to },
          trigger: { type: 'refusal', category: null, explanation: null },
        } as unknown as BetaContentBlock;
        const rest = step.mode === 'continue' ? full.slice(cut) : full;
        return makeMessage([textBlock(full.slice(0, cut)), boundary, textBlock(rest)], 'end_turn', { model: to, usage: this.usage(params, kind) });
      }
      default:
        return makeMessage([], 'end_turn', { model });
    }
  }

  private error(step: Extract<ExtractionStep, { type: 'error' | 'network' }>): unknown {
    const midStream = (step.atEvent ?? 0) > 0;
    if (step.type === 'network') {
      if (!midStream) return new APIConnectionError({ message: 'Connection error.' });
      return new AnthropicError('network error', { cause: new TypeError('network error') });
    }
    const headers = new Headers(step.retryAfter !== undefined ? { 'retry-after': String(step.retryAfter) } : {});
    const message = step.message ?? `fake ${step.status}`;
    const type = ({ 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error', 500: 'api_error', 529: 'overloaded_error' } as const)[step.status];
    const body = { type: 'error', error: { type, message } };
    // After a 200 the SDK throws `new APIError(undefined, body, undefined, headers, type)` for an error event (type read from the body).
    return midStream ? new APIError(undefined, body, undefined, new Headers()) : APIError.generate(step.status, body, message, headers);
  }

  private stream(params: MessageCreateParamsBase, options?: { signal?: AbortSignal; maxRetries?: number }): ExtractionStream {
    const title = titleOfRequest(params);
    const kind = kindOfRequest(params);
    const step = this.stepFor(title);
    const record: RecordedExtractionRequest = {
      n: this.requests.length + 1,
      at: this.now(),
      title,
      kind,
      params: JSON.parse(JSON.stringify(params)) as MessageCreateParamsBase,
      options: { maxRetries: options?.maxRetries, hasSignal: Boolean(options?.signal) },
      step: step.type,
      firstEventAt: null,
      endedAt: null,
    };
    this.requests.push(record);
    const signal = options?.signal;
    const ended = () => {
      record.endedAt ??= this.now();
    };
    if (step.type === 'stall') return stalledStream(signal, ended);

    const delayMs = 'delayMs' in step ? step.delayMs : undefined;
    const failing = step.type === 'error' || step.type === 'network';
    // A request that fails mid-stream was accepted: its message_start carries the input tokens, as the API's does.
    const accepted = { model: this.opts.model ?? params.model, usage: { input_tokens: Math.ceil(userText(params).length / CHARS_PER_TOKEN) + 500 } };
    const message = failing ? makeMessage([], 'end_turn', (step.atEvent ?? 0) > 0 ? accepted : {}) : this.message(step, params, title, kind);
    const inner = scriptedStream(message, {
      signal,
      // Time to first token: the delay comes before the first event.
      beforeEvent: async (index) => {
        if (index === 0 && delayMs) await this.sleep(delayMs, signal);
      },
      // A failing step always fails: at its event, or at the last one (message_stop) when it names one past the end.
      ...(failing ? { failAt: { atEvent: Math.min(step.atEvent ?? 0, messageEvents(message).length - 1), error: this.error(step) } } : {}),
    });
    return {
      [Symbol.asyncIterator]: () => {
        const it = inner[Symbol.asyncIterator]();
        return {
          next: async () => {
            try {
              const r = await it.next();
              if (r.done) ended();
              else record.firstEventAt ??= this.now();
              return r;
            } catch (err) {
              ended();
              throw err;
            }
          },
        };
      },
      // Lazy: finalMessage() on a stream nobody iterated drains it (as the SDK's does).
      finalMessage: () => inner.finalMessage().finally(ended),
      abort: () => {
        inner.abort();
        ended();
      },
    };
  }
}
