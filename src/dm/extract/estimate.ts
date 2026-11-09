/**
 * The cost and time estimate (spec §3.11, pure), priced with dm/cost.ts (estimateCostUsd / pricingFor),
 * so it lives in src/dm. countTokens is not used (browser CORS unverified).
 *
 * CONTRACT (Day 0 stub). Owner: E2. PlannedRequest is defined from §3.11's inputs.
 */
import type { CostEstimate, ModelId, StructuredKind } from '@/types';

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

export function estimateExtraction(requests: readonly PlannedRequest[], model: ModelId, concurrency: number): CostEstimate {
  void [requests, model, concurrency];
  throw new Error('dm/extract/estimate: estimateExtraction not implemented');
}
