/**
 * Token usage bookkeeping and cost estimates from the published per-model prices (MODELS).
 * Estimates only — the Anthropic console is the bill.
 */
import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { UsageTotals } from '@/types';
import { modelInfo } from './client';

export type CostUsage = Omit<UsageTotals, 'estimatedCostUsd' | 'requests'>;

export interface CostOptions {
  /** How many of `cacheWriteTokens` went to the 1-hour cache (the rest are 5-minute writes). */
  cacheWrite1hTokens?: number;
  /** TTL to assume for cache writes when the split is unknown. Default '5m' (the API default). */
  cacheWriteTtl?: '5m' | '1h';
}

const PER_MILLION = 1_000_000;

/** Estimated USD cost of some usage at a model's published prices. */
export function estimateCostUsd(usage: CostUsage, model: string, opts: CostOptions = {}): number {
  const price = modelInfo(model).pricing;
  const writes = Math.max(0, usage.cacheWriteTokens);
  const writes1h =
    opts.cacheWrite1hTokens !== undefined
      ? Math.min(writes, Math.max(0, opts.cacheWrite1hTokens))
      : opts.cacheWriteTtl === '1h'
        ? writes
        : 0;
  const writes5m = writes - writes1h;
  const dollars =
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadTokens * price.cacheRead +
    writes5m * price.cacheWrite5m +
    writes1h * price.cacheWrite1h;
  return dollars / PER_MILLION;
}

/** Prompt size of a request: uncached + cache-read + cache-write input tokens. */
export function contextTokensOf(usage: BetaUsage): number {
  return usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}

/**
 * The UsageTotals delta for one API response. Cache writes are split by TTL using
 * `usage.cache_creation` when the API reports it, otherwise priced at the requested TTL.
 */
export function usageDelta(usage: BetaUsage, model: string, requestedTtl: '5m' | '1h'): UsageTotals {
  const totals: CostUsage = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
  const split = usage.cache_creation;
  const opts: CostOptions = split
    ? { cacheWrite1hTokens: split.ephemeral_1h_input_tokens }
    : { cacheWriteTtl: requestedTtl };
  return { requests: 1, ...totals, estimatedCostUsd: estimateCostUsd(totals, model, opts) };
}
