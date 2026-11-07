/**
 * Friendly text for whatever goes wrong while painting a picture or checking an OpenAI key. The SDK
 * is loaded lazily, so its error classes are passed in (null when the SDK itself failed to load).
 */
import { IMAGE_MODELS } from '@/types';

/** The SDK's error classes this mapping tells apart (typed structurally, so tests can stand in). */
export interface OpenAiErrorClasses {
  APIError: abstract new (...args: never[]) => Error & { status?: number; error?: unknown; code?: string | null; type?: string };
  APIConnectionError: abstract new (...args: never[]) => Error;
  APIConnectionTimeoutError: abstract new (...args: never[]) => Error;
  APIUserAbortError: abstract new (...args: never[]) => Error;
}

/** A problem the painter detected itself; its message is already fit to show. */
export class ImageServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageServiceError';
  }
}

export const IMAGE_DECLINED = 'The image service declined this picture.';
export const DEVICE_FULL =
  'This device is out of room for pictures. Delete some in the Gallery (or free up space), then try again.';
export const OPENAI_UNREACHABLE = "Your browser couldn't reach OpenAI.";
export const PICTURE_CANCELLED = 'The picture was cancelled.';

const OUT_OF_CREDIT = 'Your OpenAI account is out of credit. Add credit on platform.openai.com, then try again.';

/** Error codes OpenAI uses when its safety system refuses a prompt. */
const DECLINED_CODES = new Set(['moderation_blocked', 'content_policy_violation', 'content_filter']);
const BILLING_CODES = new Set(['insufficient_quota', 'billing_hard_limit_reached', 'billing_not_active']);
/** Fallback for refusals that arrive without a known code. */
const DECLINED_WORDS = /safety system|moderation|content polic|safety polic/i;

const MAX_DETAIL = 240;

type ApiError = InstanceType<OpenAiErrorClasses['APIError']>;

export function modelLabel(model: string): string {
  return IMAGE_MODELS.find((m) => m.id === model)?.label ?? model;
}

export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/** The API's own message (without the SDK's "400 " status prefix), shortened. */
function apiDetail(error: ApiError): string {
  const body = error.error as { message?: unknown } | undefined;
  const raw = typeof body?.message === 'string' ? body.message : error.message.replace(/^\d{3}\s+/, '');
  const text = raw.replace(/\s+/g, ' ').trim();
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text;
}

function codeOf(error: ApiError): string {
  const body = error.error as { code?: unknown; type?: unknown } | undefined;
  const code = error.code ?? (typeof body?.code === 'string' ? body.code : undefined);
  return String(code ?? error.type ?? body?.type ?? '');
}

function declined(error: ApiError): boolean {
  return DECLINED_CODES.has(codeOf(error)) || DECLINED_WORDS.test(apiDetail(error));
}

function outOfCredit(error: ApiError): boolean {
  return BILLING_CODES.has(codeOf(error));
}

function describeApiError(error: ApiError, model: string): string {
  const label = modelLabel(model);
  switch (error.status) {
    case 400:
      if (declined(error)) return IMAGE_DECLINED;
      if (outOfCredit(error)) return OUT_OF_CREDIT;
      return `OpenAI couldn't paint this picture: ${apiDetail(error) || 'the request was refused.'}`;
    case 401:
      return "OpenAI didn't accept your API key. Check it in Settings → Illustrations.";
    case 403:
      if (declined(error)) return IMAGE_DECLINED;
      return `Your OpenAI account can't use ${label} yet. New accounts may need to verify their organization on platform.openai.com, or pick another model in Settings → Illustrations.`;
    case 404:
      return `Your OpenAI key doesn't have access to ${label}. Pick another model in Settings → Illustrations.`;
    case 429:
      if (outOfCredit(error)) return OUT_OF_CREDIT;
      return 'OpenAI is limiting how fast pictures can be made. Wait a minute, then try again.';
    default:
      if (error.status !== undefined && error.status >= 500) {
        return "OpenAI's image service had a problem. Try again in a moment.";
      }
      return `OpenAI returned an error${error.status ? ` (${error.status})` : ''}: ${apiDetail(error) || 'no details.'}`;
  }
}

/** Friendly text for a failed picture (shown on its card in the story log). */
export function describeImageError(error: unknown, sdk: OpenAiErrorClasses | null, model: string): string {
  if (error instanceof ImageServiceError) return error.message;
  if (isAbortError(error) || (sdk && error instanceof sdk.APIUserAbortError)) return PICTURE_CANCELLED;
  // Saving the picture hit the browser's storage limit.
  if (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'QuotaExceededError') return DEVICE_FULL;
  if (sdk) {
    if (error instanceof sdk.APIConnectionTimeoutError) return 'OpenAI took too long to paint this picture. Try again in a moment.';
    if (error instanceof sdk.APIConnectionError) return `${OPENAI_UNREACHABLE} Check your connection, then try again.`;
    if (error instanceof sdk.APIError) return describeApiError(error, model);
  } else if (error instanceof TypeError) {
    // The SDK's own code couldn't be loaded (offline, or the app was updated meanwhile).
    return `${OPENAI_UNREACHABLE} Check your connection, then reload the page.`;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `The picture couldn't be made: ${detail}`;
}

/** Friendly text for the Settings "Test" button. */
export function describeKeyTestError(error: unknown, sdk: OpenAiErrorClasses | null): string {
  if (sdk && error instanceof sdk.APIConnectionTimeoutError) return 'OpenAI took too long to answer. Try again in a moment.';
  if ((sdk && error instanceof sdk.APIConnectionError) || (!sdk && error instanceof TypeError)) {
    return `${OPENAI_UNREACHABLE} Check your connection, then try again.`;
  }
  if (sdk && error instanceof sdk.APIError) {
    if (error.status === 401) return 'OpenAI rejected this key. Check that you copied all of it (OpenAI keys start with “sk-”).';
    if (error.status === 403) {
      return 'This key isn’t allowed to read OpenAI’s model list. Use a key with “All” permissions, or one that may read models and create images.';
    }
    if (error.status === 429 && outOfCredit(error)) return OUT_OF_CREDIT;
  }
  return describeImageError(error, sdk, '').replace(/^The picture couldn't be made: /, 'The key check failed: ');
}
