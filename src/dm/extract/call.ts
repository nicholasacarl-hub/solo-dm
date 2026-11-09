/**
 * One extraction request (spec §3.8): build it, stream it with maxRetries 0 under a no-event watchdog,
 * then read the answer: stop_reason first, then the joined text, then the text after the last
 * `fallback` block, then case-fold enums, then WIRE[kind].safeParse. Thrown SDK errors (and
 * IdleTimeoutError) propagate to the runner, which classifies them by class.
 *
 * CONTRACT (Day 0 stubs). Owner: E2.
 */
import type {
  BetaContentBlock,
  BetaMessage,
  BetaRawMessageStreamEvent,
  MessageCreateParamsBase,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { Wire } from '@/data/structured/wire';
import type { StructuredKind, UsageTotals } from '@/types';
import type { ExtractionRequestInput } from '../libraryRequests';

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
  void [client, input, opts];
  throw new Error('dm/extract/call: runExtraction not implemented');
}

/** Candidate JSON texts: all text blocks joined (a streamed mid-output fallback continues the declined model's partial
 *  text), then the text after the last `fallback` block (a fallback that restarted). Same boundary rule as transcript.ts:75-80. */
export function answerCandidates(content: readonly BetaContentBlock[]): string[] {
  void content;
  throw new Error('dm/extract/call: answerCandidates not implemented');
}

/** JSON.parse each candidate in order → foldEnumCase(value, extractionFormat(kind).schema) → WIRE[kind].safeParse. */
export function readWire<K extends StructuredKind>(
  kind: K,
  content: readonly BetaContentBlock[],
): { ok: true; wire: Wire<K> } | { ok: false; issue: string } {
  void [kind, content];
  throw new Error('dm/extract/call: readWire not implemented');
}
