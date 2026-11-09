/**
 * The job runner (spec §3.10): one running job app-wide, per-kind cache lanes with a warm-up request,
 * modest concurrency with 429 back-off, a spending limit that counts in-flight requests, holds while
 * the DM replies or a phone's page is hidden, the Web Lock against a second tab, graceful pause and
 * immediate cancel. Progress is published as a RunnerSnapshot for useRunner().
 *
 * CONTRACT (Day 0 stub). Owner: E2. useRunner returns the idle snapshot until implemented.
 */
import type { StructuredKind } from '@/types';

export interface RunnerSnapshot {
  activeJobId: string | null; inFlight: string[]; effectiveConcurrency: number;
  waitingUntil: number | null;                  // a 429 back-off
  hold: null | 'dm-turn' | 'hidden';
  cacheWarnings: StructuredKind[]; spentUsd: number; projectedUsd: number; etaMinutes: number | null;
}

/** Nothing running. */
export const IDLE_RUNNER: RunnerSnapshot = Object.freeze({
  activeJobId: null,
  inFlight: [],
  effectiveConcurrency: 0,
  waitingUntil: null,
  hold: null,
  cacheWarnings: [],
  spentUsd: 0,
  projectedUsd: 0,
  etaMinutes: null,
}) as RunnerSnapshot;

/** React hook (useSyncExternalStore): the runner's live state. */
export function useRunner(): RunnerSnapshot {
  return IDLE_RUNNER; // not implemented (Day-0 stub): safe default = idle
}
