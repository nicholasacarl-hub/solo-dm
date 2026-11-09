/**
 * The public job API (spec §3.10, §3.13). Every entry point that could spend money checks
 * extractionAvailability() first and throws ExtractionUnavailableError in demo mode or without a key,
 * before creating anything; the client factory is never called then.
 *
 * CONTRACT (Day 0). Owner: E2. extractionAvailability and the availability gate are implemented; the
 * rest are stubs that throw "not implemented".
 */
import type { AppSettings, CostEstimate, ExtractionJob, ModelId, StructuredKind } from '@/types';
import { extractionDeps } from './deps';
import { ExtractionUnavailableError } from './errors';

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

export async function estimateJob(sourceId: string, choices: JobChoices): Promise<CostEstimate> {
  void [sourceId, choices];
  throw new Error('dm/extract/jobs: estimateJob not implemented');
}

/** The Settings model first, then every cheaper MODELS entry. */
export async function estimateModels(sourceId: string, choices: Omit<JobChoices, 'model'>): Promise<CostEstimate[]> {
  void [sourceId, choices];
  throw new Error('dm/extract/jobs: estimateModels not implemented');
}

/** Creates the job and marks its records queued; it runs at once when no other job is running, else waits as 'queued'. */
export async function startJob(sourceId: string, choices: JobChoices): Promise<ExtractionJob> {
  assertAvailable();
  void [sourceId, choices];
  throw new Error('dm/extract/jobs: startJob not implemented');
}

/** Graceful: no new dispatch; in-flight requests finish and are paid for. */
export async function pauseJob(jobId: string): Promise<void> {
  void jobId;
  throw new Error('dm/extract/jobs: pauseJob not implemented');
}

export async function resumeJob(jobId: string, patch?: { budgetUsd?: number | null; model?: ModelId; skipKinds?: StructuredKind[] }): Promise<void> {
  assertAvailable();
  void [jobId, patch];
  throw new Error('dm/extract/jobs: resumeJob not implemented');
}

/** Immediate: aborts in-flight requests (counted as interrupted); queued records become skipped. */
export async function cancelJob(jobId: string): Promise<void> {
  void jobId;
  throw new Error('dm/extract/jobs: cancelJob not implemented');
}

/** Same model: requeued in this job. Another model: a new job scoped to those records (caches are per model). Returns the job id. */
export async function retryRecords(jobId: string, which: 'failed' | 'refused' | 'both', model?: ModelId): Promise<string> {
  assertAvailable();
  void [jobId, which, model];
  throw new Error('dm/extract/jobs: retryRecords not implemented');
}

/** main.tsx, once, via a dynamic import('@/dm/extract') after the first render; needs the runner's Web Lock (ifAvailable). */
export async function recoverJobsOnStartup(): Promise<void> {
  throw new Error('dm/extract/jobs: recoverJobsOnStartup not implemented');
}
