/**
 * Scripted message streams: replay a complete BetaMessage as the stream events the API would
 * send. The offline demo DM uses this (with small delays so streaming is visible), and tests use
 * it as a fake API.
 */
import { APIUserAbortError } from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaMessage,
  BetaRawContentBlockStartEvent,
  BetaRawMessageStreamEvent,
  BetaRefusalStopDetails,
  BetaStopReason,
  BetaTextBlock,
  BetaThinkingBlock,
  BetaToolUseBlock,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { DmMessageStream } from './deps';

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

export function textBlock(text: string): BetaTextBlock {
  return { type: 'text', text, citations: null };
}

export function thinkingBlock(thinking: string, signature: string): BetaThinkingBlock {
  return { type: 'thinking', thinking, signature };
}

export function toolUseBlock(id: string, name: string, input: unknown): BetaToolUseBlock {
  return { type: 'tool_use', id, name, input };
}

export function makeUsage(partial: Partial<BetaUsage> = {}): BetaUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: null,
    fallback_credit: null,
    inference_geo: null,
    iterations: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    speed: null,
    ...partial,
  };
}

let messageCounter = 0;

export function makeMessage(
  content: BetaContentBlock[],
  stopReason: BetaStopReason,
  opts: { model?: string; usage?: Partial<BetaUsage>; stopDetails?: BetaRefusalStopDetails | null } = {},
): BetaMessage {
  messageCounter += 1;
  return {
    id: `msg_scripted_${messageCounter}`,
    type: 'message',
    role: 'assistant',
    model: opts.model ?? 'claude-opus-5-5',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: opts.stopDetails ?? null,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: makeUsage(opts.usage),
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function chunks(text: string, size: number): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function startBlock(index: number, block: BetaContentBlock): BetaRawContentBlockStartEvent {
  switch (block.type) {
    case 'text':
      return { type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } };
    case 'thinking':
      return { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } };
    case 'tool_use':
      return { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } };
    default:
      return { type: 'content_block_start', index, content_block: block };
  }
}

function blockEvents(index: number, block: BetaContentBlock, size: number): BetaRawMessageStreamEvent[] {
  const events: BetaRawMessageStreamEvent[] = [startBlock(index, block)];
  if (block.type === 'text') {
    for (const text of chunks(block.text, size)) events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
  } else if (block.type === 'thinking') {
    for (const thinking of chunks(block.thinking, size)) {
      events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking, estimated_tokens: null } });
    }
    events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
  } else if (block.type === 'tool_use') {
    for (const partial_json of chunks(JSON.stringify(block.input ?? {}), size * 2)) {
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } });
    }
  }
  events.push({ type: 'content_block_stop', index });
  return events;
}

/** The SSE event sequence for a complete message. */
export function messageEvents(message: BetaMessage, chunkSize = 24): BetaRawMessageStreamEvent[] {
  const events: BetaRawMessageStreamEvent[] = [
    { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: makeUsage({ input_tokens: message.usage.input_tokens }) } },
  ];
  message.content.forEach((block, index) => events.push(...blockEvents(index, block, chunkSize)));
  events.push({
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason, stop_sequence: null, stop_details: message.stop_details, container: null },
    usage: {
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
      cache_creation_input_tokens: message.usage.cache_creation_input_tokens,
      cache_read_input_tokens: message.usage.cache_read_input_tokens,
      fallback_credit: null,
      iterations: null,
      output_tokens_details: null,
      server_tool_use: null,
    },
    context_management: null,
  });
  events.push({ type: 'message_stop' });
  return events;
}

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

export interface ScriptedStreamOptions {
  signal?: AbortSignal;
  chunkSize?: number;
  /** Delay before each event (needs `sleep`). */
  delayMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Called before event `index` is emitted (tests use it to cancel or fail mid-stream). */
  beforeEvent?: (index: number, event: BetaRawMessageStreamEvent) => void | Promise<void>;
  /** Throw this instead of emitting event number `atEvent` (e.g. an unparseable-JSON error). */
  failAt?: { atEvent: number; error: unknown };
}

class ScriptedStream implements DmMessageStream {
  private readonly controller = new AbortController();
  private readonly events: BetaRawMessageStreamEvent[];
  private readonly final: Promise<BetaMessage>;
  private settle!: { resolve: (m: BetaMessage) => void; reject: (e: unknown) => void };
  private started = false;

  constructor(
    private readonly message: BetaMessage,
    private readonly opts: ScriptedStreamOptions,
  ) {
    this.events = messageEvents(message, opts.chunkSize);
    this.final = new Promise<BetaMessage>((resolve, reject) => {
      this.settle = { resolve, reject };
    });
    // A failed stream whose final message nobody reads must not surface as an unhandled rejection.
    this.final.catch(() => undefined);
  }

  private aborted(): boolean {
    return this.controller.signal.aborted || Boolean(this.opts.signal?.aborted);
  }

  private async *run(): AsyncGenerator<BetaRawMessageStreamEvent> {
    try {
      for (const [index, event] of this.events.entries()) {
        if (this.opts.delayMs && this.opts.sleep) {
          try {
            await this.opts.sleep(this.opts.delayMs, this.opts.signal ?? this.controller.signal);
          } catch {
            throw new APIUserAbortError();
          }
        }
        await this.opts.beforeEvent?.(index, event);
        if (this.aborted()) throw new APIUserAbortError();
        if (this.opts.failAt && this.opts.failAt.atEvent === index) throw this.opts.failAt.error;
        yield event;
      }
      this.settle.resolve(this.message);
    } catch (err) {
      this.settle.reject(err);
      throw err;
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<BetaRawMessageStreamEvent> {
    this.started = true;
    return this.run();
  }

  abort(): void {
    this.controller.abort();
  }

  async finalMessage(): Promise<BetaMessage> {
    if (!this.started) {
      for await (const _event of this) {
        // drain
      }
    }
    return this.final;
  }
}

export function scriptedStream(message: BetaMessage, opts: ScriptedStreamOptions = {}): DmMessageStream {
  return new ScriptedStream(message, opts);
}
