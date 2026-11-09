/**
 * The cost and time estimate (spec §3.11): a synthetic 10-request plan against a hand computation per
 * model (prices from MODELS), one cache write per kind, the 0.6×/1.6× range, the time model, and
 * projections that switch to measured means after five requests of a kind.
 */
import { describe, expect, it } from 'vitest';
import { MODELS, type CostEstimate } from '@/types';
import { EXTRACT_SYSTEM } from './prompts';
import { defaultBudgetUsd, estimateExtraction, expectedRequestUsd, projectUsd, type PlannedRequest } from './estimate';

const spell: PlannedRequest = { kind: 'spell', chars: 3200, blocks: 1, paragraphs: 10, rows: 0 };
const monster: PlannedRequest = { kind: 'monster', chars: 6400, blocks: 1, paragraphs: 20, rows: 0 };
const PLAN = [spell, spell, monster, spell, spell, monster, spell, monster, spell, monster];

describe('estimateExtraction', () => {
  it.each(MODELS.map((m) => [m.id]))('prices a 10-request plan as a hand computation (%s)', (model) => {
    const price = MODELS.find((m) => m.id === model)!.pricing;
    const S = Math.ceil(EXTRACT_SYSTEM.spell.length / 3.2);
    const M = Math.ceil(EXTRACT_SYSTEM.monster.length / 3.2);
    // Input: text tokens + 40 per block + 2 per paragraph marker + 500 format tokens.
    const spellIn = 1000 + 40 + 20 + 500;
    const monsterIn = 2000 + 40 + 40 + 500;
    const input = 6 * spellIn + 4 * monsterIn;
    const output = 6 * 450 + 4 * 650;
    const writes = S + M; // one cache write per kind
    const reads = 5 * S + 3 * M;
    const usd = (input * price.input + output * price.output + reads * price.cacheRead + writes * price.cacheWrite5m) / 1e6;
    const e = estimateExtraction(PLAN, model, 3);
    expect(e).toMatchObject({ model, requests: 10, inputTokens: input, outputTokens: output, cacheWriteTokens: writes, cacheReadTokens: reads });
    expect(e.usd).toBeCloseTo(usd, 10);
    expect(e.usdLow).toBeCloseTo(0.6 * usd, 10);
    expect(e.usdHigh).toBeCloseTo(1.6 * usd, 10);
    expect(e.byKind.spell!.requests).toBe(6);
    expect(e.byKind.spell!.usd + e.byKind.monster!.usd).toBeCloseTo(usd, 10);
  });

  it('estimates time from first-token latency and output speed, over the concurrency, plus a warm-up per kind', () => {
    // Opus 5.5: 2 s + output / 60 tok/s per request.
    const seconds = 6 * (2 + 450 / 60) + 4 * (2 + 650 / 60);
    const total = seconds / 3 + 15 * 2;
    const e = estimateExtraction(PLAN, 'claude-opus-5-5', 3);
    expect(e.minutesLow).toBeCloseTo((total * 0.7) / 60, 10);
    expect(e.minutesHigh).toBeCloseTo((total * 2) / 60, 10);
    expect(estimateExtraction(PLAN, 'claude-haiku-5-5', 3).minutesHigh).toBeLessThan(e.minutesHigh);
  });

  it('grows gear output per row, prices a custom model at Opus rates and is empty for no requests', () => {
    const one = estimateExtraction([{ kind: 'item', chars: 320, blocks: 1, paragraphs: 3, rows: 1 }], 'claude-opus-5-5', 1);
    const ten = estimateExtraction([{ kind: 'item', chars: 320, blocks: 1, paragraphs: 3, rows: 10 }], 'claude-opus-5-5', 1);
    expect(ten.outputTokens - one.outputTokens).toBe(9 * 120);
    expect(estimateExtraction(PLAN, 'my-model', 3).usd).toBeCloseTo(estimateExtraction(PLAN, 'claude-opus-5-5', 3).usd, 10);
    expect(estimateExtraction([], 'claude-opus-5-5', 3)).toMatchObject({ requests: 0, usd: 0, minutesHigh: 0 });
  });
});

describe('projections and the spending limit', () => {
  const estimate: CostEstimate = estimateExtraction(PLAN, 'claude-opus-5-5', 3);
  const spellMean = estimate.byKind.spell!.usd / 6;

  it('expects the estimate’s high end for a kind with nothing finished, then its measured mean', () => {
    expect(expectedRequestUsd('spell', estimate, {})).toBeCloseTo(spellMean * 1.6, 12);
    expect(expectedRequestUsd('spell', estimate, { spell: { requests: 2, usd: 0.01 } })).toBeCloseTo(0.005, 12);
  });

  it('projects with the estimate until a kind has five finished requests, then with their mean', () => {
    expect(projectUsd(0.1, estimate, { spell: { requests: 4, usd: 1 } }, { spell: 2 })).toBeCloseTo(0.1 + 2 * spellMean, 12);
    expect(projectUsd(0.1, estimate, { spell: { requests: 5, usd: 1 } }, { spell: 2 })).toBeCloseTo(0.1 + 2 * 0.2, 12);
  });

  it('offers the high estimate rounded up as the default limit, at least $1', () => {
    expect(defaultBudgetUsd({ ...estimate, usdHigh: 0.2 })).toBe(1);
    expect(defaultBudgetUsd({ ...estimate, usdHigh: 5.07 })).toBe(6);
  });
});
