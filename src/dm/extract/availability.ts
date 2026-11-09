/**
 * Whether structuring may call Claude (spec §3.13): never in demo mode, never without an API key. Every
 * paid entry point (jobs.ts) checks it before creating anything, and the runner checks it again before
 * each request, so switching demo mode on (or removing the key) mid-job stops new requests at once. When
 * it says no, the client factory is never called.
 *
 * Owner: E2. Re-exported from jobs.ts (the public API).
 */
import type { AppSettings } from '@/types';
import { extractionDeps } from './deps';
import { ExtractionUnavailableError } from './errors';

export type ExtractionAvailability = { ok: true } | { ok: false; reason: 'demo' | 'no-key'; message: string };

export function extractionAvailability(settings: AppSettings = extractionDeps().settings()): ExtractionAvailability {
  if (settings.mockMode) return { ok: false, reason: 'demo', message: new ExtractionUnavailableError('demo').message };
  if (!settings.apiKey.trim()) return { ok: false, reason: 'no-key', message: new ExtractionUnavailableError('no-key').message };
  return { ok: true };
}
