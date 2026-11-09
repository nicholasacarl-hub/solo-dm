/**
 * Extraction errors (spec §3.10, §3.13): the demo / no-key refusal every paid entry point throws before
 * creating anything, and player-facing wording for everything else (describeError's class order with
 * extraction wording; describeError itself is not changed).
 *
 * CONTRACT (Day 0). Owner: E2. describeExtractionError is a stub with a generic safe default.
 */
import type { FriendlyError } from '../errors';

const UNAVAILABLE: Record<'demo' | 'no-key', string> = {
  demo: 'Demo mode makes no API calls. Turn it off in Settings to have Claude read entries.',
  'no-key': 'Add an Anthropic API key in Settings to have Claude read the rest.',
};

/** Thrown by startJob, resumeJob and retryRecords in demo mode or without a key, before anything is created or sent. */
export class ExtractionUnavailableError extends Error {
  constructor(readonly reason: 'demo' | 'no-key') {
    super(UNAVAILABLE[reason]);
    this.name = 'ExtractionUnavailableError';
  }
}

/** The player-facing text for an extraction failure ("Claude rejected your API key. Fix it in Settings, then resume."). */
export function describeExtractionError(err: unknown): FriendlyError {
  // not implemented (Day-0 stub): safe default — the error's own message
  if (err instanceof ExtractionUnavailableError) return { text: err.message, retryable: false };
  return { text: err instanceof Error && err.message ? err.message : 'Something went wrong while reading with Claude.', retryable: true };
}
