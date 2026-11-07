import { describe, expect, it, vi } from 'vitest';

vi.mock('@/engine', () => import('./testing/fakeEngine'));
vi.mock('@/data', () => import('./testing/fakeData'));
vi.mock('@/state/gameStore', () => import('./testing/fakeGameStoreModule'));

import { contextTokensOf, estimateCostUsd, usageDelta } from './cost';
import { estimateCostUsd as contractEstimate } from './index';
import { makeUsage } from './scripted';

const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 };

describe('estimateCostUsd', () => {
  it('prices each token class at the model rates (cache writes at 5m by default)', () => {
    // Opus 5.5: $4 in, $20 out, $0.20 cache read, $5 5-minute write.
    expect(estimateCostUsd(usage, 'claude-opus-5-5')).toBeCloseTo(29.2, 10);
    expect(estimateCostUsd(usage, 'claude-sonnet-5-5')).toBeCloseTo(2 + 10 + 0.2 + 2.5, 10);
    expect(estimateCostUsd(usage, 'claude-haiku-5-5')).toBeCloseTo(0.1 + 0.5 + 0.01 + 0.125, 10);
    expect(contractEstimate(usage, 'claude-opus-5-5')).toBeCloseTo(29.2, 10);
  });

  it('splits cache writes by TTL', () => {
    const writes = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 };
    expect(estimateCostUsd(writes, 'claude-opus-5-5', { cacheWriteTtl: '1h' })).toBeCloseTo(8, 10);
    expect(estimateCostUsd(writes, 'claude-opus-5-5', { cacheWrite1hTokens: 250_000 })).toBeCloseTo(0.25 * 8 + 0.75 * 5, 10);
  });

  it('falls back to the default model prices for unknown models', () => {
    expect(estimateCostUsd(usage, 'some-future-model')).toBeCloseTo(29.2, 10);
  });
});

describe('usageDelta', () => {
  it('uses the reported TTL split when present, else the requested TTL', () => {
    const reported = makeUsage({
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
      cache_creation: { ephemeral_1h_input_tokens: 40, ephemeral_5m_input_tokens: 0 },
    });
    const delta = usageDelta(reported, 'claude-opus-5-5', '5m');
    expect(delta).toMatchObject({ requests: 1, inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 });
    expect(delta.estimatedCostUsd).toBeCloseTo((10 * 4 + 20 * 20 + 30 * 0.2 + 40 * 8) / 1e6, 12);

    const unsplit = makeUsage({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 100 });
    expect(usageDelta(unsplit, 'claude-opus-5-5', '1h').estimatedCostUsd).toBeCloseTo((100 * 8) / 1e6, 12);
    expect(usageDelta(unsplit, 'claude-opus-5-5', '5m').estimatedCostUsd).toBeCloseTo((100 * 5) / 1e6, 12);
  });

  it('measures context as uncached + cache read + cache write input tokens', () => {
    expect(contextTokensOf(makeUsage({ input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }))).toBe(125);
  });

  it("prices a Haiku 5.5 request over 100K prompt tokens at the long-context card", () => {
    // 2,000 uncached + 110,000 cache read + 1,000 5-minute writes = 113,000 prompt tokens > 100K.
    const long = makeUsage({ input_tokens: 2_000, output_tokens: 1_000, cache_read_input_tokens: 110_000, cache_creation_input_tokens: 1_000 });
    expect(usageDelta(long, 'claude-haiku-5-5', '5m').estimatedCostUsd).toBeCloseTo((2_000 * 0.5 + 1_000 * 2.5 + 110_000 * 0.05 + 1_000 * 0.625) / 1e6, 12);
    // At or under 100K the base card applies.
    const short = makeUsage({ input_tokens: 2_000, output_tokens: 1_000, cache_read_input_tokens: 98_000 });
    expect(usageDelta(short, 'claude-haiku-5-5', '5m').estimatedCostUsd).toBeCloseTo((2_000 * 0.1 + 1_000 * 0.5 + 98_000 * 0.01) / 1e6, 12);
  });

  it("prices a turn a server-side fallback served at the fallback model's rates", () => {
    const u = makeUsage({ input_tokens: 1_000, output_tokens: 1_000 });
    // Claude Opus 5 ($5 / $25), not the Opus 5.5 picked in Settings ($4 / $20).
    expect(usageDelta(u, 'claude-opus-5', '5m', 'claude-opus-5-5').estimatedCostUsd).toBeCloseTo((1_000 * 5 + 1_000 * 25) / 1e6, 12);
    // An unknown model is priced at the requested model.
    expect(usageDelta(u, 'claude-future-9', '5m', 'claude-sonnet-5-5').estimatedCostUsd).toBeCloseTo((1_000 * 2 + 1_000 * 10) / 1e6, 12);
  });

  it('sums usage.iterations, each attempt at its own model, when the API reports them', () => {
    const u = makeUsage({
      input_tokens: 500,
      output_tokens: 300,
      iterations: [
        // The requested model declined mid-stream (billed at normal rates)…
        { type: 'message', model: null, input_tokens: 1_000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
        // …and the fallback model served the turn.
        { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 500, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
      ],
    });
    const delta = usageDelta(u, 'claude-opus-4-8', '5m', 'claude-opus-5-5');
    expect(delta).toMatchObject({ requests: 1, inputTokens: 1_500, outputTokens: 500 });
    expect(delta.estimatedCostUsd).toBeCloseTo((1_000 * 4 + 200 * 20 + 500 * 5 + 300 * 25) / 1e6, 12);
  });
});
