/**
 * The public job API (spec §3.10, §3.13), re-exported from '@/dm'. Every entry point that could spend
 * money checks extractionAvailability() first and throws ExtractionUnavailableError in demo mode or
 * without a key, before creating anything; the client factory is never called then. A paid job is never
 * resumed without the player (the one exception: a job paused offline resumes on the `online` event in
 * the same tab). Pause and cancel work from any tab: the tab running the job is asked (runner.ts).
 *
 * Owner: E2.
 */
import { candidatesForRecords, detectionContext } from '@/data';
import { newId } from '@/lib/id';
import { getJob, getSourceEntries, listRecords, putJob, putRecords } from '@/storage';
import { MODELS, type CostEstimate, type ExtractionJob, type ModelId, type RunState, type StructuredKind, type StructuredRecord } from '@/types';
import { extractionAvailability } from './availability';
import { jobRecords, planRequest } from './blocks';
import { extractionDeps } from './deps';
import { ExtractionUnavailableError } from './errors';
import { defaultBudgetUsd, estimateExtraction } from './estimate';
import {
  acquireRunnerLock,
  cancelAnywhere,
  claimJob,
  emptyCounts,
  kickRunner,
  pauseAnywhere,
  recoverOrphans,
  requeueJob,
  runnerBusy,
  zeroUsage,
} from './runner';

export { extractionAvailability, type ExtractionAvailability } from './availability';

export interface JobChoices {
  model: ModelId;
  claudeFor: 'misses' | 'all' | 'selection';
  kinds?: StructuredKind[];          // default: every kind with a record needing Claude
  recordIds?: string[];              // claudeFor 'selection'
  concurrency?: 1 | 2 | 3 | 4;       // default 3
  budgetUsd?: number | null;         // default max(1, ceil(estimate.usdHigh))
}

/** Throws ExtractionUnavailableError in demo mode or without a key. */
function assertAvailable(): void {
  const available = extractionAvailability();
  if (!available.ok) throw new ExtractionUnavailableError(available.reason);
}

const DEFAULT_CONCURRENCY = 3;
const clampConcurrency = (n: number | undefined): 1 | 2 | 3 | 4 => Math.min(4, Math.max(1, Math.round(n ?? DEFAULT_CONCURRENCY))) as 1 | 2 | 3 | 4;

/** The records a job would read, and the requests it would send. */
async function plan(sourceId: string, choices: Omit<JobChoices, 'model'>): Promise<{ records: StructuredRecord[]; estimateFor: (model: ModelId) => CostEstimate }> {
  const [all, entries, context] = await Promise.all([listRecords(sourceId), getSourceEntries(sourceId), detectionContext()]);
  const records = jobRecords(all, choices);
  const { candidates } = candidatesForRecords(records, entries, context.segment);
  const requests = records.flatMap((r) => {
    const c = candidates.get(r.id);
    return c ? [planRequest({ ...c, key: r.candidateKey })] : [];
  });
  return { records, estimateFor: (model) => estimateExtraction(requests, model, clampConcurrency(choices.concurrency)) };
}

export async function estimateJob(sourceId: string, choices: JobChoices): Promise<CostEstimate> {
  return (await plan(sourceId, choices)).estimateFor(choices.model);
}

/** The Settings model first, then every cheaper MODELS entry. */
export async function estimateModels(sourceId: string, choices: Omit<JobChoices, 'model'>): Promise<CostEstimate[]> {
  const settingsModel = extractionDeps().settings().model;
  const known = MODELS.find((m) => m.id === settingsModel);
  // A custom model id is priced at Opus 5.5's rates; every listed model is cheaper than or equal to that.
  const price = known?.pricing.output ?? MODELS[0].pricing.output;
  const cheaper = MODELS.filter((m) => m.id !== settingsModel && m.pricing.output < price).sort((a, b) => b.pricing.output - a.pricing.output);
  const { estimateFor } = await plan(sourceId, choices);
  return [settingsModel, ...cheaper.map((m) => m.id)].map(estimateFor);
}

/** Creates the job and marks its records queued; it runs at once when no other job is running, else waits as 'queued'. */
export async function startJob(sourceId: string, choices: JobChoices): Promise<ExtractionJob> {
  assertAvailable();
  const deps = extractionDeps();
  const { records, estimateFor } = await plan(sourceId, choices);
  const estimate = estimateFor(choices.model);
  const now = deps.now();
  const id = `job:${newId()}`;
  const job: ExtractionJob = {
    id,
    sourceId,
    status: 'queued',
    model: choices.model,
    useFallbacks: deps.settings().useFallbacks,
    concurrency: clampConcurrency(choices.concurrency),
    budgetUsd: choices.budgetUsd === undefined ? defaultBudgetUsd(estimate) : choices.budgetUsd,
    scope: {
      kinds: choices.kinds?.length ? [...choices.kinds] : [...new Set(records.map((r) => r.kind))],
      claudeFor: choices.claudeFor,
      ...(choices.claudeFor === 'selection' ? { recordIds: [...(choices.recordIds ?? [])] } : {}),
    },
    estimate,
    usage: zeroUsage(),
    counts: { ...emptyCounts(), queued: records.length },
    interrupted: 0,
    createdAt: now,
    updatedAt: now,
  };
  // Claimed before it is written: recovery in this page never mistakes it for one a closed page left.
  claimJob(id);
  await putRecords(
    records.map((r) => {
      const next: StructuredRecord = { ...r, jobId: id, runState: 'queued', runAttempts: 0, updatedAt: now };
      delete next.runError;
      delete next.runMaxTokens;
      return next;
    }),
  );
  await putJob(job);
  deps.keepSaves();
  await kickRunner({ jobId: id });
  return (await getJob(id)) ?? job;
}

/** Graceful: no new dispatch; in-flight requests finish and are paid for. Works from any tab. */
export async function pauseJob(jobId: string): Promise<void> {
  await pauseAnywhere(jobId);
}

export async function resumeJob(jobId: string, patch?: { budgetUsd?: number | null; model?: ModelId; skipKinds?: StructuredKind[] }): Promise<void> {
  assertAvailable();
  const job = await getJob(jobId);
  if (!job) throw new Error('This structuring job no longer exists.');
  if (job.status === 'running' || job.status === 'pausing' || job.status === 'cancelled') return;
  const now = extractionDeps().now();
  const skip = new Set(patch?.skipKinds ?? []);
  const queued = (await listRecords(job.sourceId)).filter((r) => r.jobId === job.id && r.runState === 'queued');
  if (skip.size) {
    const skipped = queued.filter((r) => skip.has(r.kind));
    await putRecords(skipped.map((r) => ({ ...r, runState: 'skipped' as const, updatedAt: now })));
  }
  // Another model has other prices: the spending limit and projections price the rest at the new model's.
  const model = patch?.model && patch.model !== job.model ? patch.model : null;
  const estimate = model
    ? (await plan(job.sourceId, { claudeFor: 'selection', recordIds: queued.filter((r) => !skip.has(r.kind)).map((r) => r.id), concurrency: job.concurrency })).estimateFor(model)
    : null;
  const next: Partial<ExtractionJob> = {
    ...(patch?.budgetUsd !== undefined ? { budgetUsd: patch.budgetUsd } : {}),
    ...(model && estimate ? { model, useFallbacks: extractionDeps().settings().useFallbacks, estimate } : {}),
    ...(skip.size ? { scope: { ...job.scope, kinds: job.scope.kinds.filter((k) => !skip.has(k)) } } : {}),
  };
  await requeueJob(job, next);
}

/** Immediate: aborts in-flight requests (counted as interrupted); queued records become skipped. Works from any tab. */
export async function cancelJob(jobId: string): Promise<void> {
  await cancelAnywhere(jobId);
}

/** What a retry may spend: the consent's limit on top of what the finished job had spent (null: no limit). */
function retryLimit(job: ExtractionJob, budgetUsd: number | null): number | null {
  return budgetUsd === null ? null : Math.ceil((job.usage.estimatedCostUsd + budgetUsd) * 100) / 100;
}

/**
 * Read a job's failed or refused records again, with the model the player chose in the consent. With
 * `ids` (the records the consent priced), exactly those and never more; without, every such record not
 * kept as text. Returns the id of the job that reads them.
 *
 * - The job finished (done or cancelled), the model is the same and every such record not kept as text
 *   is retried: they are queued again in it. Nothing else of a finished job is queued, so only they are
 *   read; with `budgetUsd` the consent's limit caps what the retry spends, on top of what the job had spent.
 * - Otherwise (a job paused, queued, or being read here or in another tab; a subset of its failures; or
 *   another model, whose cache is separate): a new job scoped to exactly those records (claudeFor
 *   'selection'), with `budgetUsd` as its limit (the default limit when it is undefined). It waits for any
 *   job running. The old job keeps its other records as they are: a paid job is never resumed without
 *   the player.
 */
export async function retryRecords(
  jobId: string,
  which: 'failed' | 'refused' | 'both',
  model: ModelId,
  opts: { ids?: readonly string[]; budgetUsd?: number | null } = {},
): Promise<string> {
  assertAvailable();
  const job = await getJob(jobId);
  if (!job) throw new Error('This structuring job no longer exists.');
  const states: readonly RunState[] = which === 'both' ? ['failed', 'refused'] : [which];
  const only = opts.ids ? new Set(opts.ids) : null;
  const failures = (await listRecords(job.sourceId)).filter((r) => r.jobId === job.id && r.runState !== undefined && states.includes(r.runState));
  const records = failures.filter((r) => (only ? only.has(r.id) : r.status !== 'rejected'));
  if (!records.length) return job.id;
  const finished = job.status === 'done' || job.status === 'cancelled';
  const whole = failures.every((r) => r.status === 'rejected' || records.includes(r));
  if (model !== job.model || !finished || !whole) {
    const next = await startJob(job.sourceId, {
      model,
      claudeFor: 'selection',
      recordIds: records.map((r) => r.id),
      concurrency: job.concurrency,
      ...(opts.budgetUsd !== undefined ? { budgetUsd: opts.budgetUsd } : {}),
    });
    return next.id;
  }
  const now = extractionDeps().now();
  await putRecords(
    records.map((r) => {
      const next: StructuredRecord = { ...r, runState: 'queued', runAttempts: 0, updatedAt: now };
      delete next.runError;
      delete next.runMaxTokens;
      return next;
    }),
  );
  await requeueJob(job, opts.budgetUsd !== undefined ? { budgetUsd: retryLimit(job, opts.budgetUsd) } : {});
  return job.id;
}

/**
 * main.tsx, once, via a dynamic import('@/dm/extract') after the first render; needs the runner's Web Lock
 * (ifAvailable): while another tab holds it, or a job is running or starting here, this does nothing.
 * Otherwise every job a closed page left unfinished — running, pausing, queued, or waiting for a tab or
 * a connection that is gone (no page holds its offline lock) — is paused 'reload' and never resumed by
 * itself; records that were being read are queued again and counted as interrupted (their cost is unknown).
 */
export async function recoverJobsOnStartup(): Promise<void> {
  if (runnerBusy()) return;
  const lock = await acquireRunnerLock();
  if (!lock) return;
  try {
    await recoverOrphans({ atStartup: true });
  } finally {
    lock.release();
  }
}
