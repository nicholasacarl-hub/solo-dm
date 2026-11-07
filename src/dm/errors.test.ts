import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/engine', () => import('./testing/fakeEngine'));
vi.mock('@/data', () => import('./testing/fakeData'));
vi.mock('@/state/gameStore', () => import('./testing/fakeGameStoreModule'));

import {
  AnthropicError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  OverloadedError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { MissingApiKeyError } from './client';
import { resetDmDeps, setDmDeps } from './deps';
import { describeError, describeKeyCheckError, DmError, isAbortError, isUnparseableStreamError } from './errors';
import { testApiKey } from './index';

afterEach(() => resetDmDeps());

const headers = (h: Record<string, string> = {}) => new Headers(h);

describe('describeError', () => {
  it.each([
    [new MissingApiKeyError(), /Add your Anthropic API key in Settings/, true],
    [new AuthenticationError(401, undefined, 'bad', headers()), /Your Anthropic API key was rejected — check Settings/, true],
    [new PermissionDeniedError(403, undefined, 'no', headers()), /isn't allowed to use this model/, true],
    [new NotFoundError(404, undefined, 'model: x', headers()), /couldn't find that model/, true],
    [new RateLimitError(429, undefined, 'slow', headers({ 'retry-after': '12' })), /rate limit.*about 12s/, true],
    [new OverloadedError(529, undefined, 'busy', headers()), /overloaded/, true],
    [new InternalServerError(500, undefined, 'oops', headers()), /server problem \(500\)/, true],
    [new APIConnectionTimeoutError(), /timed out/, true],
    [new APIConnectionError({ message: 'down' }), /network error/, true],
    [new BadRequestError(400, undefined, 'messages.0: bad', headers()), /Claude rejected the request/, false],
    [new DmError('Custom.', { retryable: false }), /^Custom\.$/, false],
  ])('maps %o', (error, text, retryable) => {
    const friendly = describeError(error);
    expect(friendly.text).toMatch(text);
    expect(friendly.retryable).toBe(retryable);
  });

  it('recognizes aborts and unparseable tool JSON', () => {
    expect(isAbortError(new APIUserAbortError())).toBe(true);
    expect(isAbortError(new DOMException('Aborted', 'AbortError'))).toBe(true);
    expect(isAbortError(new Error('x'))).toBe(false);
    expect(isUnparseableStreamError(new AnthropicError('Unable to parse tool parameter JSON'))).toBe(true);
    expect(isUnparseableStreamError(new RateLimitError(429, undefined, 'x', headers()))).toBe(false);
  });

  it('words key-check failures for the Settings screen', () => {
    expect(describeKeyCheckError(new AuthenticationError(401, undefined, 'bad', headers()))).toMatch(/rejected this API key/);
    expect(describeKeyCheckError(new RateLimitError(429, undefined, 'x', headers()))).not.toMatch(/Retry/);
  });
});

describe('testApiKey', () => {
  it('lists one model with the given key', async () => {
    const list = vi.fn(async () => ({ data: [] }));
    const keyClient = vi.fn(() => ({ models: { list } }));
    setDmDeps({ keyClient });
    await expect(testApiKey('  sk-ant-123  ')).resolves.toEqual({ ok: true });
    expect(keyClient).toHaveBeenCalledWith('sk-ant-123');
    expect(list).toHaveBeenCalledWith({ limit: 1 });
  });

  it('reports a mapped error, or a missing key', async () => {
    setDmDeps({ keyClient: () => ({ models: { list: async () => Promise.reject(new AuthenticationError(401, undefined, 'bad', headers())) } }) });
    const result = await testApiKey('sk-ant-bad');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/rejected this API key/);
    await expect(testApiKey('   ')).resolves.toEqual({ ok: false, error: 'Enter an API key first.' });
  });
});
