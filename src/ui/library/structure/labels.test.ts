import { describe, expect, it } from 'vitest';
import { gloamwoodRecords } from '@/test/structuredFixtures';
import type { StructuredRecord } from '@/types';
import { PRIVACY_PROMISES, kindCount, modelName, originLabel, recordState, recordStateLabel, reviewHint } from './labels';

const drake = gloamwoodRecords().find((r) => r.name === 'Glimmerwing Drake') as StructuredRecord;
const on = { bookEnabled: true };

describe('record states', () => {
  it('name what review needs, in the §4.3 vocabulary', () => {
    expect(recordStateLabel(drake, on)).toBe('To review · Clean read');
    const check = { ...drake, confidence: 'medium' as const, warnings: [
      { code: 'ungrounded' as const, severity: 'warn' as const, field: 'hpText', message: 'x' },
      { code: 'cross-check' as const, severity: 'warn' as const, field: 'hpText', message: 'y' },
      { code: 'ungrounded' as const, severity: 'warn' as const, field: 'acText', message: 'z' },
    ] };
    expect(recordStateLabel(check, on)).toBe('To review · Check 2 fields');
    expect(recordStateLabel({ ...check, warnings: [...check.warnings, { code: 'out-of-range', severity: 'block', message: 'AC' }] }, on)).toBe('Needs a fix');
    expect(recordStateLabel({ ...drake, data: null }, on)).toBe('Not read yet');
    expect(recordStateLabel({ ...drake, runState: 'running' }, on)).toBe('Reading…');
    expect(recordStateLabel({ ...drake, runState: 'refused' }, on)).toBe('Claude declined');
    expect(recordStateLabel({ ...drake, runState: 'failed', data: null }, on)).toBe("Couldn't read");
  });

  it('put the player\'s decisions first', () => {
    expect(recordState({ ...drake, status: 'accepted' }, on)).toBe('in-use');
    expect(recordStateLabel({ ...drake, status: 'accepted' }, { bookEnabled: false })).toBe('Accepted · book switched off');
    expect(recordStateLabel({ ...drake, status: 'rejected', data: null }, on)).toBe('Text only');
  });
});

describe('origin', () => {
  it('says who read it, the fallback model when it differs, and edits', () => {
    expect(originLabel(drake)).toBe('Read on this device');
    const usage = { requests: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 };
    const extraction = { model: 'claude-opus-5', requestedModel: 'claude-sonnet-5-5', promptVersion: 1, at: 1, usage };
    expect(originLabel({ origin: 'claude', extraction, edited: true })).toBe('Read by Claude Sonnet 5.5 (answered by Claude Opus 5 as a fallback) · edited');
    expect(originLabel({ origin: 'pack', edited: false })).toBe('From a pack');
    expect(originLabel({ origin: 'manual', edited: false })).toBe('Entered by you');
    expect(modelName('claude-haiku-5-5')).toBe('Claude Haiku 5.5');
  });
});

describe('counts and hints', () => {
  it('count kinds in the done page\'s words', () => {
    expect(kindCount('class', 1)).toBe('1 class');
    expect(kindCount('item', 40)).toBe('40 pieces of gear');
    expect(reviewHint(3, 'class', 'The Gloamwood Almanac')).toBe('3 more classes from “The Gloamwood Almanac” are waiting for your review in the Library.');
  });

  it('keep the three promises', () => {
    expect(PRIVACY_PROMISES.map((p) => p.title)).toEqual([
      'Your book stays on this device.',
      "Nothing changes your game until you've checked it.",
      "Your campaign saves never carry your book's text.",
    ]);
  });
});
