/**
 * The public job API (spec §3.10, §3.13), re-exported from '@/dm'. Every entry point that could spend
 * money checks extractionAvailability() first and throws ExtractionUnavailableError in demo mode or
 * without a key, before creating anything; the client factory is never called then. A paid job is never
 * resumed without the player (the one exception: a job paused offline resumes on the `online` event in
 * the same tab).
 *
 * Owner: E2.
 */
import { candidatesForRecords, detectionContext } from '@/data';
import { newId } from '@/lib/id';
import { getJob, getSourceEntries, listJobs, listRecords, putJob, putRecords } from '@/storage';
import { MODELS, type AppSettings, type CostEstimate, type ExtractionJob, type ModelId, type StructuredKind, type StructuredRecord } from '@/types';
import { jobRecords, planRequest } from './blocks';
import { extractionDeps } from './deps';
import { ExtractionUnavailableError } from './errors';
import { defaultBudgetUsd, estimateExtraction } from './estimate';
import { acquireRunnerLock, activeJobId, cancelRunning, emptyCounts, kickRunner, pauseRunning, requeueJob, zeroUsage } from './runner';

export interface JobChoices {
  model: ModelId;
  claudeFor: 'misses' | 'all' | 'selection';
  kinds?: StructuredKind[];          // default: every kind with a record needing Claude
  recordIds?: string[];              // claudeFor 'selection'
  concurrency?: 1 | 2 | 3 | 4;       // default 3
  budgetUsd?: number | null;         // default max(1, ceil(estimate.usdHigh))
}

export function extractionAvailability(
  settings: AppSettings = extractionDeps().settings(),
): { ok: true } | { ok: false; reason: 'demo' | 'no-key'; message: string } {
  if (settings.mockMode) return { ok: false, reason: 'demo', message: new ExtractionUnavailableError('demo').message };
  if (!settings.apiKey.trim()) return { ok: false, reason: 'no-key', message: new ExtractionUnavailableError('no-key').message };
  return { ok: true };
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
  await kickRunner();
  return (await getJob(id)) ?? job;
}

/** Graceful: no new dispatch; in-flight requests finish and are paid for. */
export async function pauseJob(jobId: string): Promise<void> {
  if (await pauseRunning(jobId)) return;
  const job = await getJob(jobId);
  if (!job || (job.status !== 'queued' && job.status !== 'running' && job.status !== 'pausing')) return;
  // Not running in this tab: a queued job, or one another tab left behind.
  await putJob({ ...job, status: 'paused', pauseReason: 'player', updatedAt: extractionDeps().now() });
}

export async function resumeJob(jobId: string, patch?: { budgetUsd?: number | null; model?: ModelId; skipKinds?: StructuredKind[] }): Promise<void> {
  assertAvailable();
  const job = await getJob(jobId);
  if (!job) throw new Error('This structuring job no longer exists.');
  if (job.status === 'running' || job.status === 'pausing' || job.status === 'cancelled') return;
  const now = extractionDeps().now();
  const skip = new Set(patch?.skipKinds ?? []);
  if (skip.size) {
    const skipped = (await listRecords(job.sourceId)).filter((r) => r.jobId === job.id && r.runState === 'queued' && skip.has(r.kind));
    await putRecords(skipped.map((r) => ({ ...r, runState: 'skipped' as const, updatedAt: now })));
  }
  const next: Partial<ExtractionJob> = {
    ...(patch?.budgetUsd !== undefined ? { budgetUsd: patch.budgetUsd } : {}),
    ...(patch?.model ? { model: patch.model, useFallbacks: extractionDeps().settings().useFallbacks } : {}),
    ...(skip.size ? { scope: { ...job.scope, kinds: job.scope.kinds.filter((k) => !skip.has(k)) } } : {}),
  };
  await requeueJob(job, next);
}

/** Immediate: aborts in-flight requests (counted as interrupted); queued records become skipped. */
export async function cancelJob(jobId: string): Promise<void> {
  if (await cancelRunning(jobId)) return;
  const job = await getJob(jobId);
  if (!job || job.status === 'cancelled' || job.status === 'done') return;
  const now = extractionDeps().now();
  const open = (await listRecords(job.sourceId)).filter((r) => r.jobId === job.id && (r.runState === 'queued' || r.runState === 'running'));
  const interrupted = open.filter((r) => r.runState === 'running').length;
  await putRecords(open.map((r) => ({ ...r, runState: 'skipped' as const, updatedAt: now })));
  const counts = emptyCounts();
  for (const r of (await listRecords(job.sourceId)).filter((x) => x.jobId === job.id && x.runState)) counts[r.runState!] += 1;
  const cancelled: ExtractionJob = { ...job, status: 'cancelled', counts, interrupted: job.interrupted + interrupted, finishedAt: now, updatedAt: now };
  delete cancelled.pauseReason;
  delete cancelled.pauseMessage;
  await putJob(cancelled);
  await kickRunner();
}

/** Same model: requeued in this job. Another model: a new job scoped to those records (caches are per model). Returns the job id. */
export async function retryRecords(jobId: string, which: 'failed' | 'refused' | 'both', model?: ModelId): Promise<string> {
  assertAvailable();
  const job = await getJob(jobId);
  if (!job) throw new Error('This structuring job no longer exists.');
  const states = which === 'both' ? ['failed', 'refused'] : [which];
  const records = (await listRecords(job.sourceId)).filter((r) => r.jobId === job.id && r.runState && states.includes(r.runState));
  if (!records.length) return job.id;
  if (model && model !== job.model) {
    const next = await startJob(job.sourceId, { model, claudeFor: 'selection', recordIds: records.map((r) => r.id), concurrency: job.concurrency });
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
  if (job.status === 'running' || job.status === 'pausing') {
    // Running in another tab or about to stop here: the records wait for its next resume.
    return job.id;
  }
  await requeueJob(job);
  return job.id;
}

/**
 * main.tsx, once, via a dynamic import('@/dm/extract') after the first render; needs the runner's Web Lock
 * (ifAvailable): while another tab holds it, this does nothing. Otherwise a job left running or pausing by
 * a closed page is paused 'reload' (never resumed by itself) and its in-flight records are queued again,
 * counted as interrupted (their cost is unknown).
 */
export async function recoverJobsOnStartup(): Promise<void> {
  if (activeJobId()) return;
  const lock = await acquireRunnerLock();
  if (!lock) return;
  try {
    const now = extractionDeps().now();
    for (const job of await listJobs({ status: ['running', 'pausing'] })) {
      const running = (await listRecords(job.sourceId)).filter((r) => r.jobId === job.id && r.runState === 'running');
      await putRecords(running.map((r) => ({ ...r, runState: 'queued' as const, updatedAt: now })));
      const counts = { ...job.counts, queued: job.counts.queued + running.length, running: 0 };
      await putJob({ ...job, status: 'paused', pauseReason: 'reload', pauseMessage: 'Paused when the page closed.', interrupted: job.interrupted + running.length, counts, updatedAt: now });
    }
  } finally {
    lock.release();
  }
}
