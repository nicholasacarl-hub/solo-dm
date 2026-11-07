/**
 * Error types raised by the DM harness and the mapping from SDK errors to friendly log text.
 * Typed SDK classes only — never match on error message strings.
 */
import {
  AnthropicError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  ContentTooLargeError,
  InternalServerError,
  NotFoundError,
  OverloadedError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { MissingApiKeyError } from './client';

/** A failure the harness detected itself (not an SDK error), with a ready-to-show message. */
export class DmError extends Error {
  readonly retryable: boolean;
  constructor(message: string, opts: { retryable: boolean }) {
    super(message);
    this.name = 'DmError';
    this.retryable = opts.retryable;
  }
}

/** The player (or the app) cancelled the in-flight work. */
export class DmCancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'DmCancelledError';
  }
}

export interface FriendlyError {
  text: string;
  retryable: boolean;
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof APIUserAbortError || err instanceof DmCancelledError) return true;
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * The SDK raises a plain AnthropicError (not an APIError) when eager input streaming produced
 * tool-input JSON it cannot parse. That is the only stream failure worth re-issuing as-is.
 */
export function isUnparseableStreamError(err: unknown): boolean {
  return err instanceof AnthropicError && !(err instanceof APIError);
}

function retryAfterHint(err: APIError): string {
  const seconds = Number(err.headers?.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? ` (about ${Math.ceil(seconds)}s)` : '';
}

function apiDetail(err: APIError): string {
  return (err.apiMessage ?? err.message ?? '').trim();
}

/** Map anything thrown by a DM operation to text for an error log entry. Most specific first. */
export function describeError(err: unknown): FriendlyError {
  if (err instanceof DmError) return { text: err.message, retryable: err.retryable };
  if (err instanceof MissingApiKeyError) {
    return {
      text: 'Add your Anthropic API key in Settings to play with Claude as your DM (or turn on the demo DM), then Retry.',
      retryable: true,
    };
  }
  if (err instanceof AuthenticationError) {
    return { text: 'Your Anthropic API key was rejected — check Settings, then Retry.', retryable: true };
  }
  if (err instanceof PermissionDeniedError) {
    return {
      text: `Your API key isn't allowed to use this model or feature — pick another model in Settings or check your Anthropic account. ${apiDetail(err)}`.trim(),
      retryable: true,
    };
  }
  if (err instanceof NotFoundError) {
    return {
      text: `Claude couldn't find that model for your API key — pick another model in Settings. ${apiDetail(err)}`.trim(),
      retryable: true,
    };
  }
  if (err instanceof RateLimitError) {
    return { text: `Claude's rate limit was reached. Wait a moment${retryAfterHint(err)}, then Retry.`, retryable: true };
  }
  if (err instanceof OverloadedError) {
    return { text: 'Claude is overloaded right now. Wait a moment, then Retry.', retryable: true };
  }
  if (err instanceof InternalServerError) {
    return { text: `Claude had a server problem (${err.status}). Wait a moment, then Retry.`, retryable: true };
  }
  if (err instanceof APIConnectionTimeoutError) {
    return { text: 'The request to Claude timed out. Check your connection, then Retry.', retryable: true };
  }
  if (err instanceof APIConnectionError) {
    return { text: "Couldn't reach Claude (network error). Check your connection, then Retry.", retryable: true };
  }
  if (err instanceof ContentTooLargeError) {
    return {
      text: 'This session has grown too large for one request. End the session to start a fresh one (the story carries over).',
      retryable: false,
    };
  }
  if (err instanceof BadRequestError) {
    return { text: `Claude rejected the request: ${apiDetail(err)}`, retryable: false };
  }
  if (err instanceof APIError) {
    return { text: `Claude returned an error${err.status ? ` (${err.status})` : ''}: ${apiDetail(err)}`, retryable: true };
  }
  if (err instanceof AnthropicError) {
    return { text: `The DM's response couldn't be read (${err.message}). Retry to try again.`, retryable: true };
  }
  if (err instanceof Error) return { text: `Something went wrong: ${err.message}`, retryable: true };
  return { text: 'Something went wrong.', retryable: true };
}

/** Friendly text for the Settings "Test key" button. */
export function describeKeyCheckError(err: unknown): string {
  if (err instanceof AuthenticationError) {
    return 'Anthropic rejected this API key. Check that you copied the whole key (it starts with "sk-ant-").';
  }
  if (err instanceof PermissionDeniedError) {
    return "This key isn't allowed to use the API. Check the key's workspace and permissions in the Anthropic Console.";
  }
  if (err instanceof APIConnectionError) return "Couldn't reach Anthropic. Check your connection and try again.";
  return describeError(err).text.replace(/,? then Retry\.?$/, '.').replace(/ Retry to try again\.$/, '');
}
