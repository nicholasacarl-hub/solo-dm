/**
 * Everything the runner needs from the outside world, behind one object tests replace (spec §3.10).
 * `client()` is never called in demo mode or without a key (jobs.ts checks extractionAvailability first).
 *
 * CONTRACT (Day 0). Owner: E2. The defaults are the production wiring.
 */
import { isBusyDmPhase } from '@/state/heroMove';
import { useGame } from '@/state/gameStore';
import { getSettings } from '@/state/settingsStore';
import { requestPersistentStorage } from '@/storage';
import type { AppSettings } from '@/types';
import { getAnthropicClient } from '../client';
import { abortableSleep } from '../deps';
import type { ExtractionClient } from './call';

export interface ExtractionDeps {
  client(): ExtractionClient;                   // default getAnthropicClient(); never called in demo mode or without a key
  settings(): AppSettings;
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  online(): boolean;                            // navigator.onLine
  dmBusy(): boolean;                            // isBusyDmPhase(useGame.getState().dm.phase)
  pageHidden(): boolean;                        // document.visibilityState === 'hidden' && matchMedia('(pointer: coarse)').matches
  locks: LockManager | null;                    // navigator.locks, as campaignLock.ts
  keepSaves(): void;                            // the existing requestPersistentStorage(), best effort
}

function lockManager(): LockManager | null {
  const locks = globalThis.navigator?.locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}

const defaults: ExtractionDeps = {
  client: () => getAnthropicClient(),
  settings: () => getSettings(),
  now: () => Date.now(),
  sleep: abortableSleep,
  online: () => globalThis.navigator?.onLine ?? true,
  dmBusy: () => isBusyDmPhase(useGame.getState().dm.phase),
  pageHidden: () =>
    typeof document !== 'undefined' &&
    document.visibilityState === 'hidden' &&
    typeof matchMedia === 'function' &&
    matchMedia('(pointer: coarse)').matches,
  locks: lockManager(),
  keepSaves: () => {
    void requestPersistentStorage().catch(() => false);
  },
};

let current: ExtractionDeps = defaults;

export function extractionDeps(): ExtractionDeps {
  return current;
}

/** Override some dependencies (tests). Returns the previous set so callers can restore it with setExtractionDeps(previous). */
export function setExtractionDeps(patch: Partial<ExtractionDeps>): ExtractionDeps {
  const previous = current;
  current = { ...current, ...patch };
  return previous;
}

export function resetExtractionDeps(): void {
  current = defaults;
}
