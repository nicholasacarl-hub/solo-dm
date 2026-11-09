/**
 * The job runner (spec §3.10): one running job app-wide, per-kind cache lanes with a warm-up request,
 * modest concurrency with 429 back-off, a spending limit that counts in-flight requests, holds while
 * the DM replies or a phone's page is hidden, graceful pause and immediate cancel. Progress is
 * published as a RunnerSnapshot for useRunner().
 *
 * Per request: re-read the record, build its blocks (§3.6), persist runState 'running', runExtraction,
 * handle the outcome, then write the record (with its extraction usage) and the job (usage, counts) —
 * about three small writes; no large row is rewritten. Typed SDK errors only, never message matching.
 * Demo mode and the key are checked again before every request (extractionAvailability), so the client
 * is never called once either says no. Nothing here touches a DM session, transcript, system prompt
 * or Campaign.usage: extraction keeps its own ledger (job.usage, record.extraction.usage).
 *
 * Tabs (D11): only the tab holding the Web Lock `solo-dm:extract-runner` runs structuring. It keeps the
 * lock from one job to the next and lets it go when nothing is left. A job started or resumed in a tab
 * that can't take the lock pauses 'other-tab' and runs once the lock comes free, in whichever tab takes
 * it next. Pause and cancel from a tab that doesn't run the job reach the one that does over a
 * BroadcastChannel. A tab that newly takes the lock pauses ('reload') what a closed page left behind.
 * Nothing paid is resumed without the player, except a job paused offline, on the `online` event in
 * the same tab (D12); that tab holds the job's offline lock meanwhile, so another page's startup
 * recovery leaves the job to it.
 *
 * Owner: E2.
 */
import { useSyncExternalStore } from 'react';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  BadRequestError,
  ContentTooLargeError,
  InternalServerError,
  NotFoundError,
  OverloadedError,
  PermissionDeniedError,
  RateLimitError,
  type APIError,
} from '@anthropic-ai/sdk';
import { candidatesForRecords, detectionContext, mergeReadings, readCandidate, type Candidate, type ReadingContext } from '@/data';
import { getJob, getRecords, getSourceEntries, listJobs, listRecords, putJob, putRecords } from '@/storage';
import {
  EXTRACT_PROMPT_VERSION,
  STRUCTURED_KINDS,
  type ExtractionJob,
  type PauseReason,
  type RecordWarning,
  type RunErrorCode,
  type RunState,
  type StructuredKind,
  type StructuredRecord,
  type UsageTotals,
} from '@/types';
import { MissingApiKeyError } from '../client';
import { isAbortError } from '../errors';
import { EXTRACT_MAX_TOKENS, EXTRACT_MAX_TOKENS_CAP } from '../libraryRequests';
import { extractionAvailability } from './availability';
import { requestBlocks, withCutWarning, withDroppedBlocks, type RequestBlocks } from './blocks';
import { IdleTimeoutError, runExtraction, type ExtractionClient, type ExtractionOutcome } from './call';
import { extractionDeps } from './deps';
import { describeExtractionError, isQuotaError } from './errors';
import { expectedRequestUsd, projectUsd, type MeasuredByKind } from './estimate';

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

/** The Web Lock the running tab holds (navigator.locks; as campaignLock.ts). */
export const RUNNER_LOCK = 'solo-dm:extract-runner';
/** Pause and cancel requests for the tab that holds the runner lock. */
export const CONTROL_CHANNEL = 'solo-dm:extract-control';
/** Held (per job) by the tab waiting for `online` to resume a job paused offline: another page's startup recovery leaves that job to it. */
export const OFFLINE_LOCK_PREFIX = 'solo-dm:extract-offline:';
/** A kind's cache lane goes cold this long after its last request started (the 5-minute cache, with margin). */
export const LANE_COLD_MS = 270_000;
/** How often a held dispatch (DM busy, page hidden) looks again. */
export const HOLD_POLL_MS = 1000;
const RATE_LIMIT_WAITS_S = [15, 30, 60, 120];
const RATE_LIMIT_PAUSE_AFTER = 5;
const RAISE_AFTER_SUCCESSES = 20;
const TRANSIENT_WAITS_MS = [2000, 8000, 30_000];
const TRANSIENT_TRIES = 3;
const ZERO_READS_WARN = 3;

/** Plural nouns for messages ("Claude couldn't use the reading format for spells"); the book page reads the kind back from them. */
const KIND_MANY: Readonly<Record<StructuredKind, string>> = {
  class: 'classes', subclass: 'subclasses', species: 'species', background: 'backgrounds', feat: 'feats', spell: 'spells',
  'magic-item': 'magic items', item: 'pieces of gear', monster: 'monsters',
};
const PAUSE_TEXT: Partial<Record<PauseReason, string>> = {
  'other-tab': 'Structuring is running in another tab.',
  offline: "You're offline. Structuring continues when you're back online.",
  'rate-limit': 'Claude kept asking us to slow down.',
  reload: 'Paused when the page closed.',
  storage: 'This browser is out of storage space for Solo DM. Free some space, then resume.',
};

export const zeroUsage = (): UsageTotals => ({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 });
const addUsage = (a: UsageTotals, b: UsageTotals): UsageTotals => ({
  requests: a.requests + b.requests,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  estimatedCostUsd: a.estimatedCostUsd + b.estimatedCostUsd,
});
export const emptyCounts = (): Record<RunState, number> => ({ queued: 0, running: 0, done: 0, failed: 0, refused: 0, skipped: 0 });

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface Lane { state: 'cold' | 'warming' | 'warm'; lastStartAt: number }

interface Flight {
  recordId: string;
  kind: StructuredKind;
  controller: AbortController;
  warmup: boolean;
  expectedUsd: number;
  startedAt: number;
}

/** A held runner lock. `exclusive`: a real Web Lock (false where the browser has none: then nothing is exclusive). */
export interface RunnerLock { release(): void; exclusive: boolean }

/** Wakes the dispatch loop when something changes (a request settles, a lane warms, a pause or cancel). */
class Notifier {
  private resolve: () => void = () => undefined;
  private signal: Promise<void> = this.next();
  private next(): Promise<void> {
    return new Promise((r) => (this.resolve = r));
  }
  wake(): void {
    const resolve = this.resolve;
    this.signal = this.next();
    resolve();
  }
  /** Until the next wake, or `ms` on the runner's clock. */
  async wait(ms?: number): Promise<void> {
    const ac = new AbortController();
    const timer = ms !== undefined ? [extractionDeps().sleep(Math.max(0, ms), ac.signal).catch(() => undefined)] : [];
    await Promise.race([this.signal, ...timer]);
    ac.abort();
  }
}

interface Run {
  job: ExtractionJob;
  client: ExtractionClient;
  lock: RunnerLock;
  /** Queued record ids in queue order. */
  queue: string[];
  records: Map<string, StructuredRecord>;
  candidates: Map<string, Candidate>;
  reading: ReadingContext;
  flights: Map<string, Flight>;
  settled: Set<Promise<void>>;
  lanes: Map<StructuredKind, Lane>;
  effective: number;
  waitingUntil: number | null;
  backoffs: number;
  successes: number;
  transient: Map<string, number>;
  notBefore: Map<string, number>;
  measured: MeasuredByKind;
  durations: { total: number; count: number };
  zeroReads: Map<StructuredKind, number>;
  cacheWarnings: Set<StructuredKind>;
  succeededKinds: Set<StructuredKind>;
  hold: RunnerSnapshot['hold'];
  stop: null | { reason: PauseReason; message?: string };
  cancelled: boolean;
  /** endRun has begun (a pause and a cancel can race to it: the first one wins). */
  ending: boolean;
  /** Forgotten by resetRunner (tests): it writes nothing more and hands its lock to no one. */
  disposed: boolean;
  notifier: Notifier;
  ended: Promise<void>;
  end: () => void;
}

let current: Run | null = null;
let kicking: Promise<void> | null = null;
/** Bumped by resetRunner: a kick begun before it starts nothing. */
let generation = 0;
let snapshot: RunnerSnapshot = IDLE_RUNNER;
const listeners = new Set<() => void>();
/** Jobs paused offline here, waiting for the `online` event: the listener, and the release of the job's offline lock. */
const offlineWaiters = new Map<string, { listener: () => void; release: () => void }>();
/** Jobs this page started or resumed: never mistaken for ones a closed page left behind. */
const ownJobs = new Set<string>();

function publish(): void {
  const run = current;
  if (!run) snapshot = IDLE_RUNNER;
  else {
    const remaining: Partial<Record<StructuredKind, number>> = {};
    for (const id of [...run.queue, ...run.flights.keys()]) {
      const kind = run.records.get(id)?.kind;
      if (kind) remaining[kind] = (remaining[kind] ?? 0) + 1;
    }
    const left = run.queue.length + run.flights.size;
    const est = run.job.estimate;
    const perRequest =
      run.durations.count > 0
        ? run.durations.total / run.durations.count
        : est.requests > 0
          ? (((est.minutesLow + est.minutesHigh) / 2) * 60_000 * run.job.concurrency) / est.requests
          : 0;
    snapshot = {
      activeJobId: run.job.id,
      inFlight: [...run.flights.keys()],
      effectiveConcurrency: run.effective,
      waitingUntil: run.waitingUntil,
      hold: run.hold,
      cacheWarnings: [...run.cacheWarnings],
      spentUsd: run.job.usage.estimatedCostUsd,
      projectedUsd: projectUsd(run.job.usage.estimatedCostUsd, est, run.measured, remaining),
      etaMinutes: perRequest > 0 ? (left * perRequest) / Math.max(1, run.effective) / 60_000 : null,
    };
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const getSnapshot = () => snapshot;

/** React hook (useSyncExternalStore): the runner's live state. */
export function useRunner(): RunnerSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The runner's state now (tests, non-React callers). */
export const runnerSnapshot = (): RunnerSnapshot => snapshot;

/** The job running in this tab, if any. */
export const activeJobId = (): string | null => current?.job.id ?? null;

/** A job is running in this tab, or one is starting (startup recovery waits for neither). */
export const runnerBusy = (): boolean => current !== null || kicking !== null;

/** jobs.ts: a job this page started or resumed (startup and lock recovery leave it alone). */
export function claimJob(id: string): void {
  ownJobs.add(id);
}

// ---------------------------------------------------------------------------
// The Web Lock, the wait for another tab, and the beforeunload guard
// ---------------------------------------------------------------------------

const NO_LOCKS: RunnerLock = { release: () => undefined, exclusive: false };

/** Request the runner lock: now or not at all (ifAvailable), or waiting until it comes free (abortable). */
function requestLock(mode: { ifAvailable: true } | { signal: AbortSignal }): Promise<RunnerLock | null> {
  const locks = extractionDeps().locks;
  if (!locks) return Promise.resolve(NO_LOCKS);
  return new Promise((resolve) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    locks
      .request(RUNNER_LOCK, mode, async (lock) => {
        if (!lock) {
          resolve(null);
          return;
        }
        resolve({ release, exclusive: true });
        await held;
      })
      .catch(() => resolve(null));
  });
}

/** Take the runner lock if no other tab holds it; null when one does. Without Web Locks it is always granted (as campaignLock.ts). */
export const acquireRunnerLock = (): Promise<RunnerLock | null> => requestLock({ ifAvailable: true });

let lockWait: AbortController | null = null;

/** Another tab holds the lock: wait for it, then run what is waiting here (after pausing what a closed page left behind). */
function awaitRunnerLock(): void {
  if (lockWait || !extractionDeps().locks) return;
  const wait = new AbortController();
  lockWait = wait;
  void requestLock({ signal: wait.signal })
    .then((lock) => {
      if (lockWait === wait) lockWait = null;
      if (lock) return kickRunner({ lock, recover: lock.exclusive });
    })
    .catch((err: unknown) => console.warn('Structuring could not take over from another tab.', err));
}

const beforeUnload = (event: Event) => {
  event.preventDefault();
  (event as BeforeUnloadEvent).returnValue = '';
};
let guarded = false;
function guardUnload(on: boolean): void {
  if (on === guarded || typeof globalThis.addEventListener !== 'function') return;
  guarded = on;
  if (on) globalThis.addEventListener('beforeunload', beforeUnload);
  else globalThis.removeEventListener('beforeunload', beforeUnload);
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

const KIND_ORDER = new Map(STRUCTURED_KINDS.map((k, i) => [k, i]));

async function saveJob(job: ExtractionJob): Promise<void> {
  await putJob({ ...job, updatedAt: extractionDeps().now() });
}

/** The job's records by run state, counted from storage. */
async function countsOf(job: ExtractionJob): Promise<Record<RunState, number>> {
  return recount((await listRecords(job.sourceId)).filter((r) => r.jobId === job.id), (s) => s);
}

/** A job's records counted by run state, with `change` applied to each state first. */
function recount(records: readonly StructuredRecord[], change: (state: RunState) => RunState): Record<RunState, number> {
  const counts = emptyCounts();
  for (const r of records) if (r.runState) counts[change(r.runState)] += 1;
  return counts;
}

function move(run: Run, from: RunState | undefined, to: RunState): void {
  if (from) run.job.counts[from] = Math.max(0, run.job.counts[from] - 1);
  run.job.counts[to] += 1;
}

const warningOf = (code: RecordWarning['code'], severity: RecordWarning['severity'], message: string): RecordWarning => ({ code, severity, message });

function withoutPause(job: ExtractionJob): ExtractionJob {
  const next = { ...job };
  delete next.pauseReason;
  delete next.pauseMessage;
  return next;
}

const pausedJob = (job: ExtractionJob, reason: PauseReason, message?: string): ExtractionJob => ({
  ...withoutPause(job),
  status: 'paused',
  pauseReason: reason,
  ...(message ? { pauseMessage: message } : {}),
});

/** Waiting to run: queued, or held up by another tab (it runs once the lock comes free). */
const isRunnable = (job: ExtractionJob): boolean => job.status === 'queued' || (job.status === 'paused' && job.pauseReason === 'other-tab');

/** Runnable jobs, oldest first. */
async function runnableJobs(): Promise<ExtractionJob[]> {
  return (await listJobs({ status: ['queued', 'paused'] })).filter(isRunnable);
}

/** Pause a job no tab runs: its records left 'running' are queued again and counted as interrupted (their cost is unknown). */
async function pauseStored(job: ExtractionJob, reason: PauseReason, message?: string): Promise<void> {
  const now = extractionDeps().now();
  const records = (await listRecords(job.sourceId)).filter((r) => r.jobId === job.id);
  const running = records.filter((r) => r.runState === 'running');
  if (running.length) await putRecords(running.map((r) => ({ ...r, runState: 'queued' as const, updatedAt: now })));
  await saveJob({
    ...pausedJob(job, reason, message),
    counts: recount(records, (s) => (s === 'running' ? 'queued' : s)),
    interrupted: job.interrupted + running.length,
  });
}

/** Cancel a job no tab runs: its open records are skipped; those left 'running' count as interrupted. */
async function cancelStored(job: ExtractionJob): Promise<void> {
  if (job.status === 'cancelled' || job.status === 'done') return;
  const now = extractionDeps().now();
  const records = (await listRecords(job.sourceId)).filter((r) => r.jobId === job.id);
  const open = records.filter((r) => r.runState === 'queued' || r.runState === 'running');
  if (open.length) await putRecords(open.map((r) => ({ ...r, runState: 'skipped' as const, updatedAt: now })));
  await saveJob({
    ...withoutPause(job),
    status: 'cancelled',
    counts: recount(records, (s) => (s === 'queued' || s === 'running' ? 'skipped' : s)),
    interrupted: job.interrupted + open.filter((r) => r.runState === 'running').length,
    finishedAt: now,
  });
}

/** Whether a page still waits for `online` to resume this job: this one, or another holding its offline lock (none can tell without Web Locks). */
async function waitsForOnline(jobId: string): Promise<boolean> {
  if (offlineWaiters.has(jobId)) return true;
  const locks = extractionDeps().locks;
  if (!locks) return false;
  try {
    return await locks.request(OFFLINE_LOCK_PREFIX + jobId, { ifAvailable: true }, (lock) => lock === null);
  } catch {
    return false;
  }
}

/**
 * With the runner lock newly taken and nothing running here, pause ('reload', never resumed by itself)
 * what a closed page left behind: a job left running or pausing (its in-flight records are queued again
 * and counted as interrupted), or queued behind one. This tab holds the lock and isn't reading it, so no
 * tab is: that holds for a job this page started too, which another tab took over and then closed.
 * At startup also jobs held up by another tab (that tab is gone too) and jobs paused offline whose page
 * no longer waits for the connection (no page holds the job's offline lock). Jobs this page started or
 * resumed that are only waiting (queued, held up, or paused here) are left alone.
 */
export async function recoverOrphans(opts: { atStartup: boolean }): Promise<void> {
  for (const job of await listJobs({ status: ['running', 'pausing', 'queued', 'paused'] })) {
    if (job.id === current?.job.id) continue;
    const reading = job.status === 'running' || job.status === 'pausing';
    if (!reading && ownJobs.has(job.id)) continue;
    const stale =
      opts.atStartup &&
      job.status === 'paused' &&
      (job.pauseReason === 'other-tab' || (job.pauseReason === 'offline' && !(await waitsForOnline(job.id))));
    if (reading || job.status === 'queued' || stale) await pauseStored(job, 'reload', PAUSE_TEXT.reload);
  }
}

// ---------------------------------------------------------------------------
// Starting and ending a run
// ---------------------------------------------------------------------------

interface Kick {
  /** The job this call is for: when another tab holds the lock, it is the one held up ('other-tab'). */
  jobId?: string;
  /** The lock, when this tab holds it already (handed over by a run that ended, or granted after waiting). */
  lock?: RunnerLock;
  /** The lock was just granted after waiting: first pause what a closed page left behind. */
  recover?: boolean;
}

/** Start the next runnable job (oldest first) when nothing runs in this tab. */
export function kickRunner(opts: Kick = {}): Promise<void> {
  if (current || kicking) {
    opts.lock?.release();
    return kicking ?? Promise.resolve();
  }
  const kick: Promise<void> = startNext(opts, generation).finally(() => {
    if (kicking === kick) kicking = null;
  });
  kicking = kick;
  return kick;
}

async function startNext({ jobId, lock, recover }: Kick, gen: number): Promise<void> {
  let held = lock ?? null;
  let fresh = Boolean(recover && held);
  try {
    for (;;) {
      if (gen !== generation || current) return;
      if (held && fresh) {
        // Newly ours: no other tab runs anything, so whatever is still marked as running was left behind.
        fresh = false;
        await recoverOrphans({ atStartup: false });
        continue;
      }
      const next = (await runnableJobs())[0];
      if (!next || gen !== generation) return;
      if (!held) {
        held = await acquireRunnerLock();
        if (!held) {
          await holdUp(jobId);
          return;
        }
        fresh = held.exclusive;
        continue;
      }
      if (await startRun(next, held, gen)) {
        held = null; // the run holds it now
        return;
      }
    }
  } finally {
    held?.release();
  }
}

/** Another tab holds the lock: the job this call was for is held up ('other-tab') and runs once the lock comes free. */
async function holdUp(jobId: string | undefined): Promise<void> {
  const job = jobId ? await getJob(jobId) : undefined;
  if (job?.status === 'queued') await saveJob(pausedJob(job, 'other-tab', PAUSE_TEXT['other-tab']));
  awaitRunnerLock();
}

/**
 * Start a job with the runner lock held. False when it can't run here: it is no longer waiting, or demo
 * mode or a missing key stops it (then it is paused 'auth' with the reason; the client is never called).
 */
async function startRun(waiting: ExtractionJob, lock: RunnerLock, gen: number): Promise<boolean> {
  const deps = extractionDeps();
  const job = await getJob(waiting.id);
  if (!job || !isRunnable(job)) return false;
  // Settings may have changed while the job waited: never call the client in demo mode or without a key.
  const available = extractionAvailability(deps.settings());
  let client: ExtractionClient | null = null;
  if (available.ok) {
    try {
      client = deps.client();
    } catch {
      client = null;
    }
  }
  if (!client) {
    await saveJob(pausedJob(job, 'auth', available.ok ? describeExtractionError(new MissingApiKeyError()).text : available.message));
    return false;
  }
  const records = (await listRecords(job.sourceId)).filter((r) => r.jobId === job.id);
  const queued = records
    .filter((r) => r.runState === 'queued' || r.runState === 'running')
    .sort((a, b) => (KIND_ORDER.get(a.kind) ?? 99) - (KIND_ORDER.get(b.kind) ?? 99));
  const [entries, context] = await Promise.all([getSourceEntries(job.sourceId), detectionContext()]);
  const { candidates, spellLists } = candidatesForRecords(queued, entries, context.segment);
  // Records left 'running' by an interrupted page are queued again.
  const stuck = queued.filter((r) => r.runState === 'running').map((r) => ({ ...r, runState: 'queued' as const }));
  if (stuck.length) await putRecords(stuck);
  if (gen !== generation) return false;
  let end: () => void = () => undefined;
  const ended = new Promise<void>((r) => (end = r));
  const run: Run = {
    job: { ...withoutPause(job), status: 'running', startedAt: job.startedAt ?? deps.now(), counts: recount(records, (s) => (s === 'running' ? 'queued' : s)) },
    client,
    lock,
    queue: queued.map((r) => r.id),
    records: new Map([...queued, ...stuck].map((r) => [r.id, r])),
    candidates,
    reading: { sourceId: job.sourceId, entriesById: new Map(entries.map((e) => [e.id, e])), spellLists, notices: context.notices },
    flights: new Map(),
    settled: new Set(),
    lanes: new Map(),
    effective: job.concurrency,
    waitingUntil: null,
    backoffs: 0,
    successes: 0,
    transient: new Map(),
    notBefore: new Map(),
    measured: {},
    durations: { total: 0, count: 0 },
    zeroReads: new Map(),
    cacheWarnings: new Set(),
    succeededKinds: new Set(),
    hold: null,
    stop: null,
    cancelled: false,
    ending: false,
    disposed: false,
    notifier: new Notifier(),
    ended,
    end,
  };
  await saveJob(run.job);
  if (gen !== generation) return false;
  current = run;
  controlChannel();
  publish();
  void drive(run);
  return true;
}

/** End this tab's run (once: the first caller wins) and hand the lock to the next runnable job, or let it go. */
async function endRun(run: Run, patch: Partial<ExtractionJob>): Promise<void> {
  if (run.ending) return run.ended;
  run.ending = true;
  run.job = { ...run.job, ...patch, updatedAt: extractionDeps().now() };
  if (run.job.status !== 'paused') run.job = withoutPause(run.job);
  try {
    if (!run.disposed) await saveJob(run.job);
  } finally {
    if (current === run) current = null;
    guardUnload(false);
    publish();
    run.end();
    if (run.disposed) run.lock.release();
    else {
      if (run.job.status === 'paused' && run.job.pauseReason === 'offline') waitForOnline(run.job.id);
      void kickRunner({ lock: run.lock }).catch((err: unknown) => console.error('Structuring could not start the next job.', err));
    }
  }
}

/** Hold a Web Lock until the returned release is called (nothing to hold without Web Locks). */
function holdLock(name: string): () => void {
  const locks = extractionDeps().locks;
  let release: () => void = () => undefined;
  if (!locks) return release;
  const held = new Promise<void>((r) => (release = r));
  void locks.request(name, { mode: 'exclusive' }, () => held).catch(() => undefined);
  return () => release();
}

/**
 * A job paused offline resumes on the `online` event in this tab (the one exception to "never
 * auto-resumed"). While it waits, this tab holds the job's offline lock, so a page opened meanwhile
 * doesn't take the job for one a closed page left (recoverOrphans); the lock goes once it resumed.
 */
function waitForOnline(jobId: string): void {
  if (typeof globalThis.addEventListener !== 'function' || offlineWaiters.has(jobId)) return;
  const release = holdLock(OFFLINE_LOCK_PREFIX + jobId);
  const listener = () => {
    globalThis.removeEventListener('online', listener);
    offlineWaiters.delete(jobId);
    void (async () => {
      const job = await getJob(jobId);
      if (job?.status === 'paused' && job.pauseReason === 'offline') await requeueJob(job);
    })()
      .catch((err: unknown) => console.warn('Structuring could not resume after going online.', err))
      .finally(release);
  };
  offlineWaiters.set(jobId, { listener, release });
  globalThis.addEventListener('online', listener);
}

/** A paused (or finished) job becomes queued again and starts when nothing else runs (the player asked, or it went offline here). */
export async function requeueJob(job: ExtractionJob, patch: Partial<ExtractionJob> = {}): Promise<void> {
  const next: ExtractionJob = { ...withoutPause(job), ...patch, status: 'queued', counts: await countsOf(job) };
  delete next.finishedAt;
  claimJob(job.id);
  await saveJob(next);
  await kickRunner({ jobId: job.id });
}

// ---------------------------------------------------------------------------
// The dispatch loop
// ---------------------------------------------------------------------------

function laneOf(run: Run, kind: StructuredKind, now: number): Lane {
  let lane = run.lanes.get(kind);
  if (!lane) run.lanes.set(kind, (lane = { state: 'cold', lastStartAt: 0 }));
  if (lane.state === 'warm' && now - lane.lastStartAt > LANE_COLD_MS) lane.state = 'cold';
  return lane;
}

/** The first queued record that may go now: its lane warm, or cold with no warm-up in flight. */
function pickNext(run: Run, now: number): { id: string; warmup: boolean } | { waitMs: number } | null {
  let soonest: number | null = null;
  for (const id of run.queue) {
    const record = run.records.get(id);
    if (!record) continue;
    const after = run.notBefore.get(id);
    if (after !== undefined && after > now) {
      soonest = Math.min(soonest ?? after, after);
      continue;
    }
    const lane = laneOf(run, record.kind, now);
    if (lane.state === 'warm') return { id, warmup: false };
    if (lane.state === 'cold') return { id, warmup: true };
  }
  return soonest !== null ? { waitMs: soonest - now } : null;
}

/** "$5", or "$4.21" for a limit a retry set on top of what its job had spent. */
const dollars = (usd: number): string => (Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`);

function overBudget(run: Run, kind: StructuredKind): boolean {
  if (run.job.budgetUsd === null) return false;
  const inFlight = [...run.flights.values()].reduce((s, f) => s + f.expectedUsd, 0);
  return run.job.usage.estimatedCostUsd + inFlight + expectedRequestUsd(kind, run.job.estimate, run.measured) > run.job.budgetUsd;
}

async function drive(run: Run): Promise<void> {
  const deps = extractionDeps();
  const waitChange = (ms?: number) => run.notifier.wait(ms);
  try {
    for (;;) {
      if (run.cancelled || run.disposed) return;
      if (run.stop) {
        if (run.flights.size === 0) {
          await endRun(run, { status: 'paused', pauseReason: run.stop.reason, ...(run.stop.message ? { pauseMessage: run.stop.message } : {}) });
          return;
        }
        await waitChange();
        continue;
      }
      const hold = deps.dmBusy() ? 'dm-turn' : deps.pageHidden() ? 'hidden' : null;
      if (hold !== run.hold) {
        run.hold = hold;
        publish();
      }
      if (hold) {
        await waitChange(HOLD_POLL_MS);
        continue;
      }
      const now = deps.now();
      if (run.waitingUntil !== null) {
        if (now < run.waitingUntil) {
          await waitChange(run.waitingUntil - now);
          continue;
        }
        run.waitingUntil = null;
        publish();
      }
      if (run.flights.size >= run.effective) {
        await waitChange();
        continue;
      }
      const next = pickNext(run, now);
      if (next === null) {
        if (run.flights.size === 0 && run.queue.length === 0) {
          await endRun(run, { status: 'done', finishedAt: deps.now() });
          return;
        }
        await waitChange();
        continue;
      }
      if ('waitMs' in next) {
        await waitChange(next.waitMs);
        continue;
      }
      // Demo mode switched on, or the key removed, since the job started: no new request.
      const available = extractionAvailability(deps.settings());
      if (!available.ok) {
        run.stop = { reason: 'auth', message: available.message };
        continue;
      }
      const record = run.records.get(next.id) as StructuredRecord;
      if (overBudget(run, record.kind)) {
        run.stop = { reason: 'budget', message: `Paused at your ${dollars(run.job.budgetUsd ?? 0)} limit.` };
        continue;
      }
      dispatch(run, next.id, next.warmup);
    }
  } catch (err) {
    console.error('Structuring stopped unexpectedly.', err);
    if (current === run) {
      const quota = isQuotaError(err);
      await endRun(run, { status: 'paused', pauseReason: quota ? 'storage' : 'player', pauseMessage: describeExtractionError(err).text }).catch(() => undefined);
    }
  }
}

function dispatch(run: Run, id: string, warmup: boolean): void {
  const deps = extractionDeps();
  const record = run.records.get(id) as StructuredRecord;
  const now = deps.now();
  run.queue = run.queue.filter((x) => x !== id);
  run.notBefore.delete(id);
  const lane = laneOf(run, record.kind, now);
  lane.lastStartAt = now;
  if (warmup) lane.state = 'warming';
  const flight: Flight = {
    recordId: id,
    kind: record.kind,
    controller: new AbortController(),
    warmup,
    expectedUsd: expectedRequestUsd(record.kind, run.job.estimate, run.measured),
    startedAt: now,
  };
  run.flights.set(id, flight);
  move(run, 'queued', 'running');
  guardUnload(true);
  publish();
  const task = request(run, record, flight).finally(() => {
    run.flights.delete(id);
    run.settled.delete(task);
    if (flight.warmup && lane.state === 'warming') lane.state = 'cold';
    guardUnload(current !== null && current.flights.size > 0);
    publish();
    run.notifier.wake();
  });
  run.settled.add(task);
}

async function request(run: Run, queued: StructuredRecord, flight: Flight): Promise<void> {
  const deps = extractionDeps();
  // What a stream that fails mid-way had reported (message_start onwards): the ledger and the limit count it.
  const streamed: { usage: UsageTotals | null } = { usage: null };
  try {
    const [stored] = await getRecords([queued.id]);
    if (!stored) {
      // Deleted while it waited (its book was removed): nothing to read or write.
      move(run, 'running', 'skipped');
      return;
    }
    const record = stored;
    run.records.set(record.id, record);
    if (run.disposed) return;
    await putRecords([{ ...record, jobId: run.job.id, runState: 'running', updatedAt: deps.now() }]);
    const candidate = run.candidates.get(record.id);
    if (!candidate) {
      await finish(run, record, flight, { runState: 'failed', attempt: true, error: { code: 'other', message: "This entry's text is no longer in the library.", retryable: false } });
      return;
    }
    const plan = requestBlocks({ ...candidate, key: record.candidateKey });
    const outcome = await runExtraction(
      run.client,
      { kind: record.kind, model: run.job.model, useFallbacks: run.job.useFallbacks, blocks: plan.blocks, ...(record.runMaxTokens ? { maxTokens: record.runMaxTokens } : {}) },
      {
        signal: flight.controller.signal,
        onFirstEvent: () => {
          if (flight.warmup) {
            laneOf(run, flight.kind, deps.now()).state = 'warm';
            run.notifier.wake();
          }
        },
        onPartialUsage: (usage) => {
          streamed.usage = usage;
        },
      },
    );
    await handleOutcome(run, record, candidate, flight, outcome, plan);
  } catch (err) {
    if (streamed.usage) run.job.usage = addUsage(run.job.usage, streamed.usage);
    await handleError(run, queued, flight, err);
  }
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

interface Finish {
  runState: RunState;
  attempt: boolean;
  error?: { code: RunErrorCode; message: string; retryable: boolean };
  /** Requeue: at the front, or not before this time. */
  front?: boolean;
  notBefore?: number;
  maxTokens?: number;
  extraWarnings?: RecordWarning[];
  extraction?: StructuredRecord['extraction'];
  /** Records written instead of the stored one (a reading merged over it, a table's rows). */
  writes?: StructuredRecord[];
}

/** Write a request's result: the record's run state (on its latest stored version) and the job. */
async function finish(run: Run, record: StructuredRecord, flight: Flight, f: Finish): Promise<void> {
  if (run.disposed) return;
  const deps = extractionDeps();
  const now = deps.now();
  const [latest] = await getRecords([record.id]);
  const base = f.writes?.find((r) => r.id === record.id) ?? latest ?? record;
  const next: StructuredRecord = {
    ...base,
    jobId: run.job.id,
    runState: f.runState,
    runAttempts: (record.runAttempts ?? 0) + (f.attempt ? 1 : 0),
    ...(f.maxTokens ? { runMaxTokens: f.maxTokens } : {}),
    ...(f.extraction ? { extraction: f.extraction } : {}),
    updatedAt: now,
  };
  if (f.error) next.runError = f.error;
  else delete next.runError;
  if (f.extraWarnings?.length) {
    next.warnings = [...next.warnings.filter((w) => !f.extraWarnings!.some((x) => x.code === w.code)), ...f.extraWarnings];
  }
  const others = (f.writes ?? []).filter((r) => r.id !== record.id);
  try {
    await putRecords([next, ...others]);
  } catch (err) {
    if (isQuotaError(err)) {
      run.stop ??= { reason: 'storage', message: PAUSE_TEXT.storage };
      return;
    }
    throw err;
  }
  run.records.set(next.id, next);
  move(run, 'running', f.runState);
  if (f.runState === 'queued') {
    if (f.front) run.queue.unshift(next.id);
    else run.queue.push(next.id);
    if (f.notBefore !== undefined) run.notBefore.set(next.id, f.notBefore);
  }
  run.durations.total += now - flight.startedAt;
  run.durations.count += 1;
  await saveJob(run.job);
}

function noteUsage(run: Run, flight: Flight, usage: UsageTotals): void {
  run.job.usage = addUsage(run.job.usage, usage);
  const m = run.measured[flight.kind] ?? { requests: 0, usd: 0 };
  run.measured[flight.kind] = { requests: m.requests + 1, usd: m.usd + usage.estimatedCostUsd };
  if (!flight.warmup) {
    const zeros = usage.cacheReadTokens === 0 ? (run.zeroReads.get(flight.kind) ?? 0) + 1 : 0;
    run.zeroReads.set(flight.kind, zeros);
    if (zeros >= ZERO_READS_WARN) run.cacheWarnings.add(flight.kind);
  }
  run.succeededKinds.add(flight.kind);
  run.backoffs = 0;
  run.successes += 1;
  if (run.successes >= RAISE_AFTER_SUCCESSES && run.effective < run.job.concurrency) {
    run.effective += 1;
    run.successes = 0;
  }
}

async function handleOutcome(run: Run, record: StructuredRecord, candidate: Candidate, flight: Flight, outcome: ExtractionOutcome, plan: RequestBlocks): Promise<void> {
  const deps = extractionDeps();
  const now = deps.now();
  noteUsage(run, flight, outcome.usage);
  const extraction: StructuredRecord['extraction'] = {
    model: outcome.model,
    requestedModel: run.job.model,
    promptVersion: EXTRACT_PROMPT_VERSION,
    at: now,
    usage: outcome.usage,
    ...(outcome.type === 'refused' ? { refusal: outcome.category ?? 'unspecified' } : {}),
  };
  switch (outcome.type) {
    case 'ok': {
      const read = { ...candidate, key: record.candidateKey };
      // A request cut to fit (§2.7): a section's blocks left out keep their features from the offline scan, and the reading says so.
      const wire = withDroppedBlocks(read, outcome.wire, plan.dropped);
      const fresh = readCandidate(read, wire, { origin: 'claude', ctx: run.reading });
      const readings = plan.cut ? withCutWarning(fresh, record.kind) : fresh;
      const isTable = record.span === 'table';
      const existing = isTable ? await listRecords(record.sourceId, { kind: 'item' }) : (await getRecords([record.id])).filter((r): r is StructuredRecord => Boolean(r));
      const merged = mergeReadings(record.sourceId, existing, readings, {
        explicit: true,
        now,
        decorate: (r) => ({ ...r, extraction }),
      });
      await finish(run, record, flight, { runState: 'done', attempt: true, extraction, writes: merged.writes });
      return;
    }
    case 'refused': {
      const message = `Claude declined to read this one${outcome.category ? ` (reason: ${outcome.category})` : ''}.`;
      const severity = record.data === null ? 'block' : 'info';
      await finish(run, record, flight, {
        runState: 'refused', attempt: true, extraction, error: { code: 'refused', message, retryable: true },
        extraWarnings: [warningOf('refused', severity, message)],
      });
      return;
    }
    case 'truncated': {
      if (record.runMaxTokens) {
        const message = 'Too long to read in one go — fill it in by hand or try another model';
        await finish(run, record, flight, {
          runState: 'failed', attempt: true, extraction, error: { code: 'truncated', message, retryable: false },
          extraWarnings: [warningOf('failed', record.data === null ? 'block' : 'info', `${message}.`)],
        });
      } else {
        const maxTokens = Math.min(2 * EXTRACT_MAX_TOKENS[record.kind], EXTRACT_MAX_TOKENS_CAP);
        await finish(run, record, flight, { runState: 'queued', attempt: true, extraction, maxTokens, front: true });
      }
      return;
    }
    case 'invalid': {
      if (record.runError?.code === 'invalid-output') {
        const message = "Claude's answer didn't fit the format.";
        await finish(run, record, flight, {
          runState: 'failed', attempt: true, extraction, error: { code: 'invalid-output', message, retryable: true },
          extraWarnings: [warningOf('failed', record.data === null ? 'block' : 'info', message)],
        });
      } else {
        await finish(run, record, flight, { runState: 'queued', attempt: true, extraction, front: true, error: { code: 'invalid-output', message: outcome.issue, retryable: true } });
      }
    }
  }
}

const apiDetail = (err: APIError) => (err.apiMessage ?? err.message ?? '').trim();

async function handleError(run: Run, record: StructuredRecord, flight: Flight, err: unknown): Promise<void> {
  const deps = extractionDeps();
  const now = deps.now();
  const requeue = (patch: Partial<Finish> = {}) => finish(run, record, flight, { runState: 'queued', attempt: false, front: true, ...patch });
  const pause = (reason: PauseReason, message?: string) => {
    run.stop ??= { reason, ...(message ? { message } : {}) };
  };
  if (run.cancelled && isAbortError(err)) {
    run.job.interrupted += 1;
    await finish(run, record, flight, { runState: 'skipped', attempt: false, error: { code: 'interrupted', message: 'Stopped before Claude finished reading it.', retryable: true } });
    return;
  }
  if (err instanceof RateLimitError) {
    const header = Number(err.headers?.get('retry-after'));
    const seconds = Number.isFinite(header) && header > 0 ? header : RATE_LIMIT_WAITS_S[Math.min(run.backoffs, RATE_LIMIT_WAITS_S.length - 1)];
    run.waitingUntil = Math.max(run.waitingUntil ?? 0, now + seconds * 1000);
    run.effective = Math.max(1, run.effective - 1);
    run.successes = 0;
    run.backoffs += 1;
    if (run.backoffs >= RATE_LIMIT_PAUSE_AFTER) pause('rate-limit', PAUSE_TEXT['rate-limit']);
    await requeue();
    return;
  }
  if (err instanceof AuthenticationError || err instanceof MissingApiKeyError) {
    pause('auth', describeExtractionError(err).text);
    await requeue();
    return;
  }
  if (err instanceof PermissionDeniedError || err instanceof NotFoundError) {
    pause('model', apiDetail(err));
    await requeue();
    return;
  }
  if (err instanceof ContentTooLargeError) {
    await finish(run, record, flight, { runState: 'failed', attempt: true, error: { code: 'too-long', message: describeExtractionError(err).text, retryable: false } });
    return;
  }
  if (err instanceof BadRequestError) {
    if (!run.succeededKinds.has(record.kind)) {
      pause('format', `Claude couldn't use the reading format for ${KIND_MANY[record.kind]}: ${apiDetail(err)}`);
      await requeue();
      return;
    }
    await finish(run, record, flight, { runState: 'failed', attempt: true, error: { code: 'bad-request', message: describeExtractionError(err).text, retryable: false } });
    return;
  }
  const network = err instanceof APIConnectionError && !(err instanceof APIConnectionTimeoutError);
  if (network && !deps.online()) {
    pause('offline', PAUSE_TEXT.offline);
    await requeue();
    return;
  }
  if (err instanceof OverloadedError || err instanceof InternalServerError || err instanceof APIConnectionError || err instanceof IdleTimeoutError) {
    const tries = (run.transient.get(record.id) ?? 0) + 1;
    run.transient.set(record.id, tries);
    const code: RunErrorCode = err instanceof OverloadedError || err instanceof InternalServerError ? 'overloaded' : 'network';
    const message = describeExtractionError(err).text;
    if (tries >= TRANSIENT_TRIES) {
      await finish(run, record, flight, { runState: 'failed', attempt: true, error: { code, message, retryable: true } });
    } else {
      await finish(run, record, flight, { runState: 'queued', attempt: true, notBefore: now + TRANSIENT_WAITS_MS[tries - 1], error: { code, message, retryable: true } });
    }
    return;
  }
  if (isQuotaError(err)) {
    pause('storage', PAUSE_TEXT.storage);
    await requeue();
    return;
  }
  await finish(run, record, flight, { runState: 'failed', attempt: true, error: { code: 'other', message: describeExtractionError(err).text, retryable: true } });
}

// ---------------------------------------------------------------------------
// Control: here, in another tab, or of a job no tab runs (the job API in jobs.ts calls these)
// ---------------------------------------------------------------------------

/** Graceful pause of this tab's running job: no new dispatch; in-flight requests finish and are paid for. */
export async function pauseRunning(jobId: string): Promise<boolean> {
  const run = current;
  if (!run || run.job.id !== jobId) return false;
  if (run.ending) return true; // it is stopping already
  run.stop ??= { reason: 'player' };
  if (run.job.status === 'running') {
    run.job = { ...run.job, status: 'pausing' };
    await saveJob(run.job);
  }
  publish();
  run.notifier.wake();
  return true;
}

/** Immediate cancel of this tab's running job: in-flight requests are aborted (interrupted), queued ones skipped. */
export async function cancelRunning(jobId: string): Promise<boolean> {
  const run = current;
  if (!run || run.job.id !== jobId) return false;
  if (run.ending) {
    // It is ending on its own (done, or paused): the stored job is cancelled instead.
    await run.ended;
    return false;
  }
  run.cancelled = true;
  for (const flight of run.flights.values()) flight.controller.abort();
  run.notifier.wake();
  await Promise.allSettled([...run.settled]);
  const queued = run.queue.map((id) => run.records.get(id)).filter((r): r is StructuredRecord => Boolean(r));
  const latest = (await getRecords(queued.map((r) => r.id))).map((r, i) => r ?? queued[i]);
  const now = extractionDeps().now();
  await putRecords(latest.map((r) => ({ ...r, runState: 'skipped' as const, updatedAt: now })));
  for (const _ of latest) move(run, 'queued', 'skipped');
  run.queue = [];
  await endRun(run, { status: 'cancelled', finishedAt: now });
  return true;
}

/** With the lock held here (or by no tab): pause the job, gracefully if it runs here. */
async function pauseHere(jobId: string): Promise<void> {
  if (await pauseRunning(jobId)) return;
  const job = await getJob(jobId);
  if (job && (job.status === 'running' || job.status === 'pausing' || isRunnable(job))) await pauseStored(job, 'player');
}

/** With the lock held here (or by no tab): cancel the job, at once if it runs here. */
async function cancelHere(jobId: string): Promise<void> {
  if (await cancelRunning(jobId)) return;
  const job = await getJob(jobId);
  if (job) await cancelStored(job);
}

interface Control { type: 'pause' | 'cancel'; jobId: string }
let channel: BroadcastChannel | null = null;

/** The control channel; the tab that runs structuring answers what arrives on it. */
function controlChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel !== 'function') return channel;
  try {
    channel = new BroadcastChannel(CONTROL_CHANNEL);
  } catch {
    return null;
  }
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const msg = event.data as Partial<Control> | null;
    if (!msg || typeof msg.jobId !== 'string' || (msg.type !== 'pause' && msg.type !== 'cancel')) return;
    const { type, jobId } = msg;
    void (async () => {
      await settledStart();
      // Only the tab running structuring answers: it holds the lock, so no other tab runs the job.
      if (!current) return;
      await (type === 'pause' ? pauseHere(jobId) : cancelHere(jobId));
    })().catch((err: unknown) => console.warn('Structuring could not act on a request from another tab.', err));
  };
  return channel;
}

/** Wait out a job this tab is starting right now, so `current` says what runs here. */
async function settledStart(): Promise<void> {
  while (kicking) await kicking.catch(() => undefined);
}

/**
 * A job marked as running that this tab doesn't run: the tab holding the runner lock is asked to act
 * on it; when no tab holds the lock, no one runs the job (a closed page left it) and it changes here.
 */
async function elsewhere(msg: Control, here: () => Promise<void>): Promise<void> {
  if (current) return here(); // this tab holds the lock: no other tab runs anything
  const lock = await acquireRunnerLock();
  if (!lock) {
    controlChannel()?.postMessage(msg);
    return;
  }
  try {
    await here();
  } finally {
    lock.release();
  }
}

/** pauseJob: graceful here; a job waiting (queued, or held up by another tab) pauses at once; one another tab runs is paused by that tab. */
export async function pauseAnywhere(jobId: string): Promise<void> {
  await settledStart();
  if (await pauseRunning(jobId)) return;
  const job = await getJob(jobId);
  if (!job) return;
  if (isRunnable(job)) await pauseStored(job, 'player');
  else if (job.status === 'running' || job.status === 'pausing') await elsewhere({ type: 'pause', jobId }, () => pauseHere(jobId));
}

/** cancelJob: immediate here; a job another tab runs is cancelled by that tab; any other unfinished job is cancelled at once. */
export async function cancelAnywhere(jobId: string): Promise<void> {
  await settledStart();
  if (await cancelRunning(jobId)) return;
  const job = await getJob(jobId);
  if (!job || job.status === 'cancelled' || job.status === 'done') return;
  if (job.status === 'running' || job.status === 'pausing') await elsewhere({ type: 'cancel', jobId }, () => cancelHere(jobId));
  else await cancelStored(job);
}

/** Tests: wait until this tab's runner is idle (the current run ended and no next job is starting). */
export async function runnerIdle(): Promise<void> {
  while (current || kicking) {
    if (kicking) await kicking;
    if (current) await current.ended;
  }
}

/** Tests: forget all runner state (aborting anything in flight; nothing more is written for it). */
export function resetRunner(): void {
  generation += 1;
  if (current) {
    current.disposed = true;
    current.cancelled = true;
    for (const f of current.flights.values()) f.controller.abort();
    current.lock.release();
    current.notifier.wake();
  }
  current = null;
  kicking = null;
  lockWait?.abort();
  lockWait = null;
  channel?.close();
  channel = null;
  ownJobs.clear();
  for (const [, waiter] of offlineWaiters) {
    globalThis.removeEventListener?.('online', waiter.listener);
    waiter.release();
  }
  offlineWaiters.clear();
  guardUnload(false);
  publish();
}
