/**
 * One extraction request (spec §3.8): build it, stream it with maxRetries 0 under a no-event watchdog,
 * then read the answer: stop_reason first, then the joined text, then the text after the last
 * `fallback` block, then case-fold enums, then WIRE[kind].safeParse. Thrown SDK errors (and
 * IdleTimeoutError) propagate to the runner, which classifies them by class.
 *
 * Owner: E2. The only extraction call site of the Messages API (src/dm/requestAudit.test.ts).
 */
import type {
  BetaContentBlock,
  BetaMessage,
  BetaRawMessageStreamEvent,
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

/**
 * 1. params = buildExtractionRequest(input); a linked AbortController aborts on opts.signal or IDLE_TIMEOUT_MS without an event.
 * 2. stream = client.beta.messages.stream(params, { signal, maxRetries: 0 }); the first event calls onFirstEvent()
 *    (message_start: the kind's cache entry is now readable); every event re-arms the watchdog.
 * 3. message = await stream.finalMessage(); usage = usageDelta(message.usage, message.model, '5m', input.model).
 * 4. stop_reason 'refusal' → refused (stop_details?.category); 'max_tokens' → truncated. Content is not read in either case.
 * 5. readWire(kind, message.content) → ok | invalid.
 */
export async function runExtraction<K extends StructuredKind>(
  client: ExtractionClient,
  input: ExtractionRequestInput & { kind: K },
  opts: { signal?: AbortSignal; onFirstEvent?: () => void },
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
  try {
    stream = client.beta.messages.stream(params, { signal: controller.signal, maxRetries: 0 });
    let first = true;
    for await (const event of stream) {
      void event;
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
    if (idle) {
      stream?.abort();
      throw new IdleTimeoutError();
    }
    throw err;
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
