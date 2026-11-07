/**
 * Token usage bookkeeping and cost estimates from the published per-model prices (MODELS, plus the
 * rate cards below that MODELS doesn't list). Estimates only — the Anthropic console is the bill.
 */
import type { BetaCacheCreation, BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { MODELS, type ModelInfo, type UsageTotals } from '@/types';

export type CostUsage = Omit<UsageTotals, 'estimatedCostUsd' | 'requests'>;

/** USD per million tokens. */
export type Pricing = ModelInfo['pricing'];

export interface CostOptions {
  /** How many of `cacheWriteTokens` went to the 1-hour cache (the rest are 5-minute writes). */
  cacheWrite1hTokens?: number;
  /** TTL to assume for cache writes when the split is unknown. Default '5m' (the API default). */
  cacheWriteTtl?: '5m' | '1h';
  /**
   * Prompt size of the request (input + cache read + cache write tokens), when `usage` is one
   * request: models with a long-context rate card bill the whole request at it above the threshold.
   */
  promptTokens?: number;
}

const PER_MILLION = 1_000_000;

/** A rate card derived from base input/output prices: cache reads 0.1×, 5-minute writes 1.25×, 1-hour writes 2×. */
function card(input: number, output: number, cacheRead = input * 0.1): Pricing {
  return { input, output, cacheRead, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2 };
}

/**
 * Long-context rate cards: Claude Haiku 5.5 bills $0.50 / $2.50 per MTok (instead of $0.10 / $0.50)
 * when a request's prompt is over 100K tokens, with cache reads and writes priced off that rate.
 */
export const LONG_CONTEXT_PRICING: Readonly<Record<string, { threshold: number; pricing: Pricing }>> = {
  'claude-haiku-5-5': { threshold: 100_000, pricing: card(0.5, 2.5) },
};

/**
 * Models that can serve a turn without being picked in Settings: server-side refusal fallbacks
 * (`fallbacks: "default"`) answer Opus 5.5 turns with Claude Opus 5 or Opus 4.8 and Sonnet 5.5
 * turns with Claude Sonnet 5, each billed at its own rates.
 */
export const FALLBACK_MODEL_PRICING: Readonly<Record<string, Pricing>> = {
  'claude-opus-5': card(5, 25),
  'claude-opus-4-8': card(5, 25),
  'claude-sonnet-5': card(2, 10),
};

function knownPricing(model: string | null | undefined): Pricing | null {
  if (!model) return null;
  return MODELS.find((m) => m.id === model)?.pricing ?? FALLBACK_MODEL_PRICING[model] ?? null;
}

/** The rate card for a model (unknown models: the default model's prices) at a prompt size. */
export function pricingFor(model: string, promptTokens?: number): Pricing {
  const long = LONG_CONTEXT_PRICING[model];
  if (long && promptTokens !== undefined && promptTokens > long.threshold) return long.pricing;
  return knownPricing(model) ?? MODELS[0].pricing;
}

/** The prompt size above which a model bills at a higher rate, if it has one. */
export function longContextThreshold(model: string): number | null {
  return LONG_CONTEXT_PRICING[model]?.threshold ?? null;
}

/** Estimated USD cost of some usage at a model's published prices. */
export function estimateCostUsd(usage: CostUsage, model: string, opts: CostOptions = {}): number {
  const price = pricingFor(model, opts.promptTokens);
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

/** One billed sampling attempt: the top-level usage, or one entry of `usage.iterations`. */
interface Attempt {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_creation: BetaCacheCreation | null;
}

function attemptDelta(a: Attempt, model: string, requestedTtl: '5m' | '1h'): UsageTotals {
  const totals: CostUsage = {
    inputTokens: a.input_tokens,
    outputTokens: a.output_tokens,
    cacheReadTokens: a.cache_read_input_tokens ?? 0,
    cacheWriteTokens: a.cache_creation_input_tokens ?? 0,
  };
  const split = a.cache_creation;
  const opts: CostOptions = {
    ...(split ? { cacheWrite1hTokens: split.ephemeral_1h_input_tokens } : { cacheWriteTtl: requestedTtl }),
    promptTokens: totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
  };
  return { requests: 1, ...totals, estimatedCostUsd: estimateCostUsd(totals, model, opts) };
}

/**
 * The UsageTotals delta for one API response. Cache writes are split by TTL using
 * `usage.cache_creation` when the API reports it, otherwise priced at the requested TTL; a request
 * whose prompt passes a model's long-context threshold is priced at that rate card.
 *
 * `model` is the model that produced the message (`message.model`); `requestedModel` (Settings) prices
 * attempts that name no model and models with no known prices. When `usage.iterations` is present it
 * is the per-attempt record of what was billed — declined attempts and the fallback model's attempt,
 * each at its own model's rates — so the attempts are summed instead of reading the top level alone.
 */
export function usageDelta(usage: BetaUsage, model: string, requestedTtl: '5m' | '1h', requestedModel: string = model): UsageTotals {
  const resolve = (m: string | null | undefined): string => (knownPricing(m) ? (m as string) : knownPricing(requestedModel) ? requestedModel : model);
  const iterations = usage.iterations ?? [];
  if (iterations.length === 0) return attemptDelta(usage, resolve(model), requestedTtl);
  const total: UsageTotals = { requests: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 };
  for (const it of iterations) {
    const attemptModel = 'model' in it && it.model ? it.model : requestedModel;
    const d = attemptDelta(it, resolve(attemptModel), requestedTtl);
    total.inputTokens += d.inputTokens;
    total.outputTokens += d.outputTokens;
    total.cacheReadTokens += d.cacheReadTokens;
    total.cacheWriteTokens += d.cacheWriteTokens;
    total.estimatedCostUsd += d.estimatedCostUsd;
  }
  return total;
}
