/**
 * Turns stream events into the live display log: each text block becomes a DM narration entry
 * (created on its first visible delta, updated in memory at most every ~60 ms, persisted when the
 * block ends), and thinking / progress text becomes the entry's `reasoning` when the player has
 * chosen to see it.
 */
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { DmPhase } from '@/state/gameStore';
import type { ThinkingDisplay } from '@/types';
import type { DmDeps } from './deps';
import { parseChoices, truncate, visibleWhileStreaming } from './narration';
import { toolActivity } from './tools/definitions';

/** State shared by every request of one agent-loop run (one player turn). */
export class TurnLog {
  /** Thinking / progress text not yet attached to a narration entry. */
  pendingReasoning = '';
  /** The most recent narration entry created during this turn. */
  lastEntryId: string | null = null;
  lastEntryReasoning = '';

  takeReasoning(): string {
    const text = this.pendingReasoning.trim();
    this.pendingReasoning = '';
    return text;
  }
}

/** One narration entry fed by one streamed text block. */
class NarrationWriter {
  private text = '';
  private entryId: string | null = null;
  private creating: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly deps: DmDeps,
    private readonly turn: TurnLog,
    private readonly onCreated: (id: string) => void,
  ) {}

  push(delta: string): void {
    this.text += delta;
    if (this.closed) return;
    if (!this.entryId && !this.creating) {
      if (this.text.trim()) this.creating = this.create();
      return;
    }
    this.schedule();
  }

  private async create(): Promise<void> {
    const reasoning = this.turn.takeReasoning();
    const entry = await this.deps.store().appendLog({
      kind: 'dm',
      text: visibleWhileStreaming(this.text),
      streaming: true,
      ...(reasoning ? { reasoning } : {}),
    });
    this.entryId = entry.id;
    this.turn.lastEntryId = entry.id;
    this.turn.lastEntryReasoning = reasoning;
    this.onCreated(entry.id);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || !this.entryId || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.deps.streamThrottleMs);
  }

  private async flush(): Promise<void> {
    if (!this.entryId || this.closed) return;
    await this.deps.store().updateLog(this.entryId, { text: visibleWhileStreaming(this.text) }, { persist: false });
  }

  /** The raw text of the block so far. */
  get raw(): string {
    return this.text;
  }

  /**
   * Persist the final text (choices parsed out) and stop streaming. A block cut off by Stop keeps
   * exactly what the player saw: the visible text, without a half-written choices block.
   */
  async close(opts: { stopped?: boolean } = {}): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.creating) await this.creating;
    if (!this.entryId) return;
    if (opts.stopped) {
      await this.deps.store().updateLog(this.entryId, { text: visibleWhileStreaming(this.text), streaming: false });
      return;
    }
    const parsed = parseChoices(this.text);
    await this.deps.store().updateLog(this.entryId, { text: parsed.text, choices: parsed.choices, streaming: false });
  }
}

export interface ConsumerOptions {
  deps: DmDeps;
  turn: TurnLog;
  /** Stream narration into the log (off while the private recap is written). */
  narrate: boolean;
  display: ThinkingDisplay;
  /** Phase to show while text streams. */
  streamingPhase: DmPhase;
}

/** Consumes the events of one request. */
export class StreamConsumer {
  /** Narration entries created by this request (to discard if the request is retried). */
  readonly createdIds: string[] = [];
  private readonly writers = new Map<number, NarrationWriter>();
  /** Text of each narration block of this request, and whether the block finished. */
  private readonly narrated = new Map<number, { writer: NarrationWriter; complete: boolean }>();
  private readonly thinking = new Map<number, string>();
  /** Block closes still persisting (awaited by finish()). */
  private readonly closing: Promise<void>[] = [];
  private announcedStreaming = false;

  constructor(private readonly opts: ConsumerOptions) {}

  handle(event: BetaRawMessageStreamEvent): void {
    switch (event.type) {
      case 'content_block_start':
        this.onBlockStart(event.index, event.content_block.type, 'name' in event.content_block ? event.content_block.name : undefined);
        break;
      case 'content_block_delta':
        if (event.delta.type === 'text_delta') this.onText(event.index, event.delta.text);
        else if (event.delta.type === 'thinking_delta') this.onThinking(event.index, event.delta.thinking);
        break;
      case 'content_block_stop':
        this.closing.push(this.closeBlock(event.index));
        break;
      default:
        break;
    }
  }

  private status(phase: DmPhase, activity: string | null): void {
    this.opts.deps.store().setDmStatus({ phase, activity });
  }

  private onBlockStart(index: number, type: string, name: string | undefined): void {
    if (type === 'text' && this.opts.narrate) {
      const writer = new NarrationWriter(this.opts.deps, this.opts.turn, (id) => this.createdIds.push(id));
      this.writers.set(index, writer);
      this.narrated.set(index, { writer, complete: false });
    } else if (type === 'thinking') {
      this.thinking.set(index, '');
    } else if (type === 'tool_use' && name) {
      this.status(this.opts.streamingPhase === 'ending-session' ? 'ending-session' : 'tool', toolActivity(name));
    }
  }

  private onText(index: number, text: string): void {
    const writer = this.writers.get(index);
    if (!writer) return;
    writer.push(text);
    if (!this.announcedStreaming && text.trim()) {
      this.announcedStreaming = true;
      this.status(this.opts.streamingPhase, this.opts.streamingPhase === 'streaming' ? 'The DM is narrating…' : null);
    }
  }

  private onThinking(index: number, text: string): void {
    if (this.opts.display === 'omitted' || !text || !this.opts.narrate) return;
    this.thinking.set(index, (this.thinking.get(index) ?? '') + text);
    if (this.opts.display === 'updates') {
      const latest = this.thinking.get(index)?.trim();
      if (latest) this.status(this.opts.streamingPhase === 'streaming' ? 'thinking' : this.opts.streamingPhase, truncate(latest, 90));
    }
  }

  private async closeBlock(index: number, stopped = false): Promise<void> {
    const writer = this.writers.get(index);
    if (writer) {
      this.writers.delete(index);
      const block = this.narrated.get(index);
      if (block && !stopped) block.complete = true;
      await writer.close({ stopped });
      return;
    }
    const thought = this.thinking.get(index)?.trim();
    this.thinking.delete(index);
    if (thought) {
      const turn = this.opts.turn;
      turn.pendingReasoning = turn.pendingReasoning ? `${turn.pendingReasoning}\n\n${thought}` : thought;
    }
  }

  /**
   * Close any open narration (end of stream, error or cancel): the text so far is kept. With
   * `stopped` (the player pressed Stop) an unfinished block keeps only what the player saw.
   */
  async finish(opts: { stopped?: boolean } = {}): Promise<void> {
    for (const index of [...this.writers.keys(), ...this.thinking.keys()]) this.closing.push(this.closeBlock(index, opts.stopped));
    await Promise.all(this.closing.splice(0));
  }

  /**
   * The narration this request showed the player, block by block in order: finished blocks as
   * written (a complete choices block included), an unfinished one as it was displayed.
   */
  visibleText(): string {
    return [...this.narrated.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, block]) => (block.complete ? block.writer.raw : visibleWhileStreaming(block.writer.raw)).trim())
      .filter(Boolean)
      .join('\n\n');
  }

  /** Remove the narration this request created (it is about to be re-issued, or was declined). */
  async discard(): Promise<void> {
    await this.finish();
    if (this.createdIds.length) await this.opts.deps.store().removeLog([...this.createdIds]);
    if (this.opts.turn.lastEntryId && this.createdIds.includes(this.opts.turn.lastEntryId)) this.opts.turn.lastEntryId = null;
    this.createdIds.length = 0;
  }
}

/** Attach reasoning that arrived after the turn's last narration to that entry. */
export async function flushLeftoverReasoning(deps: DmDeps, turn: TurnLog): Promise<void> {
  const leftover = turn.takeReasoning();
  if (!leftover || !turn.lastEntryId) return;
  const reasoning = turn.lastEntryReasoning ? `${turn.lastEntryReasoning}\n\n${leftover}` : leftover;
  turn.lastEntryReasoning = reasoning;
  await deps.store().updateLog(turn.lastEntryId, { reasoning });
}
