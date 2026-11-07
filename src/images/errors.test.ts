import { describe, expect, it } from 'vitest';
import {
  IMAGE_DECLINED,
  ImageServiceError,
  OPENAI_UNREACHABLE,
  PICTURE_CANCELLED,
  describeImageError,
  describeKeyTestError,
  type OpenAiErrorClasses,
} from './errors';

// Stand-ins shaped like the SDK's classes (status, the API's error body, code).
class APIError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly error: { message?: string; code?: string; type?: string } | undefined,
    readonly code: string | null | undefined = error?.code,
  ) {
    super(status ? `${status} ${error?.message ?? 'status code (no body)'}` : (error?.message ?? 'Connection error.'));
  }
}
class APIConnectionError extends APIError {
  constructor() {
    super(undefined, undefined);
  }
}
class APIConnectionTimeoutError extends APIConnectionError {}
class APIUserAbortError extends APIError {
  constructor() {
    super(undefined, { message: 'Request was aborted.' });
  }
}
const sdk: OpenAiErrorClasses = { APIError, APIConnectionError, APIConnectionTimeoutError, APIUserAbortError };

const api = (status: number, message: string, code?: string) => new APIError(status, { message, code });
const describe_ = (error: unknown, model = 'gpt-image-2.5-flare') => describeImageError(error, sdk, model);

describe('describeImageError', () => {
  it('maps a bad key, missing model access and rate limits to friendly text', () => {
    expect(describe_(api(401, 'Incorrect API key provided'))).toMatch(/didn't accept your API key/);
    expect(describe_(api(403, 'Your organization must be verified to use the model'))).toMatch(
      /can't use GPT Image 2\.5 Flare yet.*verify their organization/,
    );
    expect(describe_(api(404, 'The model does not exist'), 'gpt-image-9')).toMatch(/doesn't have access to gpt-image-9/);
    expect(describe_(api(429, 'Rate limit reached'))).toMatch(/limiting how fast.*Wait a minute/);
  });

  it('says the service declined the picture when the safety system refuses it', () => {
    expect(describe_(api(400, 'Your request was rejected by the safety system.', 'moderation_blocked'))).toBe(IMAGE_DECLINED);
    expect(describe_(api(400, 'Rejected', 'content_policy_violation'))).toBe(IMAGE_DECLINED);
    expect(describe_(api(400, 'Your request was flagged by our moderation system'))).toBe(IMAGE_DECLINED);
    expect(describe_(api(400, "Invalid value: '512x512'. Supported values are..."))).toBe(
      "OpenAI couldn't paint this picture: Invalid value: '512x512'. Supported values are...",
    );
  });

  it('tells an empty account apart from a busy one', () => {
    expect(describe_(api(429, 'You exceeded your current quota', 'insufficient_quota'))).toMatch(/out of credit/);
    expect(describe_(api(400, 'Billing hard limit has been reached', 'billing_hard_limit_reached'))).toMatch(/out of credit/);
  });

  it('covers network failures, timeouts, cancellations and server trouble', () => {
    expect(describe_(new APIConnectionError())).toBe(`${OPENAI_UNREACHABLE} Check your connection, then try again.`);
    expect(describe_(new APIConnectionTimeoutError())).toMatch(/took too long/);
    expect(describe_(new APIUserAbortError())).toBe(PICTURE_CANCELLED);
    expect(describe_(new DOMException('Aborted', 'AbortError'))).toBe(PICTURE_CANCELLED);
    expect(describe_(api(503, 'Service unavailable'))).toMatch(/image service had a problem/);
    expect(describe_(api(418, 'Teapot'))).toBe('OpenAI returned an error (418): Teapot');
  });

  it('says when the device is out of room for pictures', () => {
    expect(describe_(new DOMException('The quota has been exceeded.', 'QuotaExceededError'))).toMatch(/out of room for pictures/);
  });

  it('passes its own messages through and explains anything else', () => {
    expect(describe_(new ImageServiceError('OpenAI sent back no picture. Try again.'))).toBe('OpenAI sent back no picture. Try again.');
    expect(describe_(new Error('boom'))).toBe("The picture couldn't be made: boom");
    // The SDK itself failed to load (offline): a TypeError from the dynamic import.
    expect(describeImageError(new TypeError('Failed to fetch dynamically imported module'), null, 'x')).toMatch(
      /couldn't reach OpenAI.*reload the page/,
    );
  });
});

describe('describeKeyTestError', () => {
  it('explains a rejected or restricted key and an unreachable OpenAI', () => {
    expect(describeKeyTestError(api(401, 'Incorrect API key'), sdk)).toMatch(/rejected this key.*sk-/);
    expect(describeKeyTestError(api(403, 'Missing scopes: api.model.read'), sdk)).toMatch(/model list/);
    expect(describeKeyTestError(new APIConnectionError(), sdk)).toMatch(/^Your browser couldn't reach OpenAI\./);
    expect(describeKeyTestError(new APIConnectionTimeoutError(), sdk)).toMatch(/took too long/);
    expect(describeKeyTestError(new Error('odd'), sdk)).toBe('The key check failed: odd');
  });
});
