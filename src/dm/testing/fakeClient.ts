/**
 * A fake Anthropic client for DM tests: answers each stream() call with the next scripted step
 * and records every request (deep-copied, as it would be serialized).
 */
import type { BetaMessage, MessageCreateParamsBase } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { DmClient, DmMessageStream } from '../deps';
import { makeMessage, scriptedStream, type ScriptedStreamOptions } from '../scripted';

export type ScriptStep =
  | BetaMessage
  | { message: BetaMessage; stream?: Omit<ScriptedStreamOptions, 'signal'> }
  /** The stream fails with `error` before event `atEvent` (default: the first event). */
  | { error: unknown; atEvent?: number }
  | ((params: MessageCreateParamsBase) => ScriptStep);

export class FakeClient implements DmClient {
  readonly requests: MessageCreateParamsBase[] = [];
  private readonly steps: ScriptStep[];

  constructor(steps: ScriptStep[] = []) {
    this.steps = [...steps];
  }

  push(...steps: ScriptStep[]): void {
    this.steps.push(...steps);
  }

  get remaining(): number {
    return this.steps.length;
  }

  readonly beta: DmClient['beta'] = {
    messages: {
      stream: (params, options): DmMessageStream => {
        this.requests.push(JSON.parse(JSON.stringify(params)) as MessageCreateParamsBase);
        let step = this.steps.shift();
        if (!step) throw new Error(`FakeClient: no scripted response for request #${this.requests.length}`);
        while (typeof step === 'function') step = step(params);
        const signal = options?.signal;
        if ('error' in step) {
          return scriptedStream(makeMessage([], 'end_turn'), { signal, failAt: { atEvent: step.atEvent ?? 0, error: step.error } });
        }
        if ('message' in step) return scriptedStream(step.message, { ...step.stream, signal });
        return scriptedStream(step, { signal });
      },
    },
  };
}
