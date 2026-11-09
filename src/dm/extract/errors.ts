/**
 * Extraction errors (spec §3.10, §3.13): the demo / no-key refusal every paid entry point throws before
 * creating anything, and player-facing wording for everything else (describeError's class order with
 * extraction wording; describeError itself is not changed). Typed SDK classes only — never message
 * matching.
 *
 * Owner: E2.
 */
import {
  AnthropicError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  BadRequestError,
  ContentTooLargeError,
  InternalServerError,
  NotFoundError,
  OverloadedError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { MissingApiKeyError } from '../client';
import type { FriendlyError } from '../errors';
import { IdleTimeoutError } from './call';

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

/** IndexedDB ran out of room (a DOMException named QuotaExceededError, possibly wrapped by Dexie). */
export function isQuotaError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 4; depth++) {
    if ((e as { name?: unknown }).name === 'QuotaExceededError') return true;
    e = (e as { inner?: unknown; cause?: unknown }).inner ?? (e as { cause?: unknown }).cause;
  }
  return false;
}

const detail = (err: APIError) => (err.apiMessage ?? err.message ?? '').trim();
function retryAfterHint(err: APIError): string {
  const seconds = Number(err.headers?.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? ` Continuing in about ${Math.ceil(seconds)} s.` : '';
}

/** The player-facing text for an extraction failure ("Claude rejected your API key. Fix it in Settings, then resume."). */
export function describeExtractionError(err: unknown): FriendlyError {
  if (err instanceof ExtractionUnavailableError) return { text: err.message, retryable: false };
  if (err instanceof MissingApiKeyError) return { text: UNAVAILABLE['no-key'], retryable: false };
  if (err instanceof AuthenticationError) return { text: 'Claude rejected your API key. Fix it in Settings, then resume.', retryable: true };
  if (err instanceof PermissionDeniedError) {
    return { text: `Your API key can't use this model. Resume with another model. ${detail(err)}`.trim(), retryable: true };
  }
  if (err instanceof NotFoundError) {
    return { text: `Claude couldn't find this model for your API key. Resume with another model. ${detail(err)}`.trim(), retryable: true };
  }
  if (err instanceof RateLimitError) return { text: `Claude asked us to slow down.${retryAfterHint(err)}`, retryable: true };
  if (err instanceof OverloadedError) return { text: 'Claude is overloaded right now.', retryable: true };
  if (err instanceof InternalServerError) return { text: `Claude had a server problem (${err.status}).`, retryable: true };
  if (err instanceof IdleTimeoutError) return { text: 'Claude stopped sending for two minutes.', retryable: true };
  if (err instanceof APIConnectionTimeoutError) return { text: 'The request to Claude timed out.', retryable: true };
  if (err instanceof APIConnectionError) return { text: "Couldn't reach Claude.", retryable: true };
  if (err instanceof ContentTooLargeError) return { text: 'Too long to send in one request — fill it in by hand.', retryable: false };
  if (err instanceof BadRequestError) return { text: `Claude couldn't use the request: ${detail(err)}`, retryable: false };
  if (err instanceof APIError) return { text: `Claude returned an error${err.status ? ` (${err.status})` : ''}: ${detail(err)}`, retryable: true };
  if (isQuotaError(err)) return { text: 'This browser is out of storage space for Solo DM. Free some space, then resume.', retryable: true };
  if (err instanceof AnthropicError) return { text: `Claude's answer couldn't be read (${err.message}).`, retryable: true };
  if (err instanceof Error && err.message) return { text: `Something went wrong while reading with Claude: ${err.message}`, retryable: true };
  return { text: 'Something went wrong while reading with Claude.', retryable: true };
}
