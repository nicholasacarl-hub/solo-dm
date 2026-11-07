/**
 * Everything the DM needs from the outside world, behind one object that tests can replace.
 * Production code reads the live Zustand stores, the rules index and the Anthropic client;
 * tests swap in an in-memory store, a fake client and instant timers via setDmDeps().
 */
import type {
  BetaMessage,
  BetaRawMessageStreamEvent,
  MessageCreateParamsBase,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { getRulesIndex, invalidateRulesIndex, type RulesIndex } from '@/data';
import type { Rng } from '@/engine';
import { newId } from '@/lib/id';
import { useGame, type GameStore } from '@/state/gameStore';
import { getSettings } from '@/state/settingsStore';
import type { AppSettings } from '@/types';
import { getAnthropicClient } from './client';

/** The parts of a message stream the agent loop uses. The SDK's BetaMessageStream satisfies it. */
export interface DmMessageStream extends AsyncIterable<BetaRawMessageStreamEvent> {
  finalMessage(): Promise<BetaMessage>;
  abort(): void;
}

/** The parts of the Anthropic client the agent loop uses. */
export interface DmClient {
  beta: {
    messages: {
      stream(params: MessageCreateParamsBase, options?: { signal?: AbortSignal }): DmMessageStream;
    };
  };
}

/** The parts of the Anthropic client testApiKey uses. */
export interface KeyCheckClient {
  models: { list(params: { limit: number }): PromiseLike<unknown> };
}

export interface DmDeps {
  /** A fresh snapshot of the game store (state + actions). */
  store: () => GameStore;
  settings: () => AppSettings;
  /** The real Anthropic client (the controller substitutes the mock DM in demo mode). */
  client: () => DmClient;
  keyClient: (apiKey: string) => KeyCheckClient;
  rulesIndex: () => Promise<RulesIndex>;
  invalidateRulesIndex: () => void;
  /** Randomness for engine calls; undefined = the engine's crypto RNG. */
  rng?: Rng;
  now: () => number;
  newId: () => string;
  /** Abortable delay (used by the mock DM to make streaming visible). */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Minimum interval between in-memory log updates while narration streams. */
  streamThrottleMs: number;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const defaultDeps: DmDeps = {
  store: () => useGame.getState(),
  settings: () => getSettings(),
  client: () => getAnthropicClient(),
  keyClient: (apiKey) => getAnthropicClient(apiKey),
  rulesIndex: () => getRulesIndex(),
  invalidateRulesIndex: () => invalidateRulesIndex(),
  rng: undefined,
  now: () => Date.now(),
  newId: () => newId(),
  sleep: abortableSleep,
  streamThrottleMs: 60,
};

let current: DmDeps = defaultDeps;

export function deps(): DmDeps {
  return current;
}

/** Override some dependencies (tests). Returns the previous set so callers can restore it. */
export function setDmDeps(overrides: Partial<DmDeps>): DmDeps {
  const previous = current;
  current = { ...current, ...overrides };
  return previous;
}

export function resetDmDeps(): void {
  current = defaultDeps;
}
