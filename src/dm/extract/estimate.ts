/**
 * The cost and time estimate (spec §3.11, pure), priced with dm/cost.ts (estimateCostUsd / pricingFor),
 * so it lives in src/dm. countTokens is not used (browser CORS unverified): token counts are estimated
 * from characters, deliberately pessimistic, and the consent says the estimate is rough.
 *
 * Owner: E2.
 */
import { MODELS, type CostEstimate, type ModelId, type StructuredKind } from '@/types';
import { estimateCostUsd } from '../cost';
import { EXTRACT_SYSTEM } from './prompts';

/** One request the job would send, as the planner builds it (§3.6: abbreviated, capped). */
export interface PlannedRequest {
  kind: StructuredKind;
  /** Characters of the request's block text as built (the input estimate uses these, not the full text). */
  chars: number;
  blocks: number;
  /** Paragraph markers ([pN]) in the request. */
  paragraphs: number;
  /** item: table rows (output grows per row); 0 otherwise. */
  rows: number;
}

/** Rules text with many digits: deliberately pessimistic. */
export const CHARS_PER_TOKEN = 3.2;
/** The format prompt the API injects from the schema, per request, uncached (assume the worst). */
export const FORMAT_OVERHEAD_TOKENS = 500;
const BLOCK_WRAPPER_TOKENS = 40;
const PARAGRAPH_MARKER_TOKENS = 2;
/** Output per request (JSON + low-effort thinking), re-measured on the fixtures and in the live pre-release run. */
export const OUTPUT_TOKENS: Readonly<Record<StructuredKind, number>> = {
  monster: 650, spell: 450, 'magic-item': 400, feat: 300, background: 450, species: 900, subclass: 800, class: 3500, item: 300,
};
const OUTPUT_PER_ROW = 120;
const RANGE = { low: 0.6, high: 1.6 } as const;
const TIME_RANGE = { low: 0.7, high: 2 } as const;
const PER_KIND_WARMUP_SECONDS = 15;

/** Time to first token and output speed per model; unknown models use Opus 5.5's. */
const SPEED: Readonly<Record<string, { ttft: number; tps: number }>> = {
  'claude-opus-5-5': { ttft: 2, tps: 60 },
  'claude-sonnet-5-5': { ttft: 1.5, tps: 90 },
  'claude-haiku-5-5': { ttft: 1, tps: 200 },
};

/** The kind's system prompt in tokens: one cache write (1.25×) per kind, then reads. */
export const systemTokens = (kind: StructuredKind): number => Math.ceil(EXTRACT_SYSTEM[kind].length / CHARS_PER_TOKEN);

/** Uncached input of one request: its text, the block wrappers and paragraph markers, and the format prompt. */
export const inputTokensOf = (r: PlannedRequest): number =>
  Math.ceil(r.chars / CHARS_PER_TOKEN) + BLOCK_WRAPPER_TOKENS * r.blocks + PARAGRAPH_MARKER_TOKENS * r.paragraphs + FORMAT_OVERHEAD_TOKENS;

export const outputTokensOf = (r: PlannedRequest): number => OUTPUT_TOKENS[r.kind] + (r.kind === 'item' ? OUTPUT_PER_ROW * r.rows : 0);

/** Prices a known model by its own card; a custom model id at Opus 5.5's (as the consent says). */
const priceModel = (model: ModelId): string => (MODELS.some((m) => m.id === model) ? model : MODELS[0].id);

export function estimateExtraction(requests: readonly PlannedRequest[], model: ModelId, concurrency: number): CostEstimate {
  const priced = priceModel(model);
  const speed = SPEED[priced] ?? SPEED['claude-opus-5-5'];
  const warmKinds = new Set<StructuredKind>();
  const byKind: CostEstimate['byKind'] = {};
  let inputTokens = 0;
  let cacheWriteTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let usd = 0;
  let seconds = 0;
  for (const r of requests) {
    const system = systemTokens(r.kind);
    const write = warmKinds.has(r.kind) ? 0 : system;
    const read = warmKinds.has(r.kind) ? system : 0;
    warmKinds.add(r.kind);
    const usage = { inputTokens: inputTokensOf(r), outputTokens: outputTokensOf(r), cacheReadTokens: read, cacheWriteTokens: write };
    const cost = estimateCostUsd(usage, priced, { cacheWriteTtl: '5m', promptTokens: usage.inputTokens + read + write });
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheReadTokens += read;
    cacheWriteTokens += write;
    usd += cost;
    seconds += speed.ttft + usage.outputTokens / speed.tps;
    const row = byKind[r.kind] ?? { requests: 0, usd: 0 };
    row.requests += 1;
    row.usd += cost;
    byKind[r.kind] = row;
  }
  const lanes = Math.min(4, Math.max(1, Math.floor(concurrency) || 1));
  const total = requests.length ? seconds / lanes + PER_KIND_WARMUP_SECONDS * warmKinds.size : 0;
  return {
    model,
    requests: requests.length,
    inputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    outputTokens,
    usd,
    usdLow: usd * RANGE.low,
    usdHigh: usd * RANGE.high,
    minutesLow: (total * TIME_RANGE.low) / 60,
    minutesHigh: (total * TIME_RANGE.high) / 60,
    byKind,
  };
}

/** Finished requests of a kind in a job: how many and what they cost. */
export type MeasuredByKind = Partial<Record<StructuredKind, { requests: number; usd: number }>>;

/** After this many finished requests of a kind, projections use the kind's measured mean. */
export const MEASURED_AFTER = 5;

/** The estimate's mean cost of one request of a kind (0 when the estimate has none). */
const estimatedMean = (estimate: CostEstimate, kind: StructuredKind) => {
  const k = estimate.byKind[kind];
  return k && k.requests > 0 ? k.usd / k.requests : 0;
};

/**
 * §3.10's expected(kind) for the spending limit: the mean actual cost of the kind's finished requests in
 * this job, else the estimate's per-request cost × 1.6 (the top of its range).
 */
export function expectedRequestUsd(kind: StructuredKind, estimate: CostEstimate, measured: MeasuredByKind): number {
  const m = measured[kind];
  if (m && m.requests > 0) return m.usd / m.requests;
  return estimatedMean(estimate, kind) * RANGE.high;
}

/** spent + the remaining requests at the estimate's per-kind cost, or the measured mean once a kind has five. */
export function projectUsd(spentUsd: number, estimate: CostEstimate, measured: MeasuredByKind, remaining: Partial<Record<StructuredKind, number>>): number {
  let total = spentUsd;
  for (const [kind, count] of Object.entries(remaining) as [StructuredKind, number][]) {
    const m = measured[kind];
    const mean = m && m.requests >= MEASURED_AFTER ? m.usd / m.requests : estimatedMean(estimate, kind);
    total += mean * count;
  }
  return total;
}

/** The spending limit offered by default: the high estimate rounded up, at least $1. */
export const defaultBudgetUsd = (estimate: CostEstimate): number => Math.max(1, Math.ceil(estimate.usdHigh));
