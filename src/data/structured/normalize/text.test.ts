import { describe, expect, it } from 'vitest';
import { gloamwoodEntries, gloamwoodEntryId } from '@/test/structuredFixtures';
import type { RecordWarning } from '@/types';
import { segment } from '../segment';
import { checkSpan, excerptsOf, gradeConfidence, grounded, groundingForm, numberInText, spanFromWire, titleCase } from './text';

const CTX = { knownSpellNames: new Set<string>(), knownClassNames: new Set<string>() };
const md = gloamwoodEntries();
const byId = new Map(md.map((e) => [e.id, e]));
const candidate = (name: string) => segment(md, CTX).candidates.find((c) => c.name === name)!;
const w = (severity: RecordWarning['severity'], code: RecordWarning['code'] = 'cross-check'): RecordWarning => ({ code, severity, message: 'x' });

describe('groundingForm and grounded', () => {
  it('folds ligatures, soft hyphens, NBSP, emphasis, heading marks, curly quotes and dashes, then lowercases', () => {
    expect(groundingForm('### The ﬁre-­bolt’s “arc” —− **Bold** _it_')).toBe('the fire-bolt\'s "arc" -- bold it');
  });

  it('finds an excerpt in noisy source text, and not a misread number', () => {
    const text = '- **HP** 52 (8d10 + 8)\n- **Speed** 30 ft., Fly 60 ft. (hover)';
    expect(grounded('52 (8d10 + 8)', text)).toBe(true);
    expect(grounded('30 ft., fly 60 ft. (hover)', text)).toBe(true);
    expect(grounded('58 (8d10 + 8)', text)).toBe(false);
    expect(grounded('', text)).toBe(true);
  });

  it('finds a number as a number of its own', () => {
    expect(numberInText(16, '| **Score** | 16 | 14 |')).toBe(true);
    expect(numberInText(6, 'Score 16 14 13')).toBe(false);
    expect(numberInText(13, '13 (+1)')).toBe(true);
  });
});

describe('excerptsOf', () => {
  it('collects every non-empty "…Text" field, nested ones by path, with grounding', () => {
    const text = 'Cost 12 GP. Weight 6 lb.';
    expect(excerptsOf({ name: 'x', costText: '12 GP', items: [{ weightText: '6 lb.', name: 'Hook' }, { weightText: '9 lb.' }], notes: '' }, text)).toEqual([
      { field: 'costText', text: '12 GP', grounded: true },
      { field: 'items[0].weightText', text: '6 lb.', grounded: true },
      { field: 'items[1].weightText', text: '9 lb.', grounded: false },
    ]);
  });
});

describe('spanFromWire', () => {
  const ember = candidate('Ember Warden');

  it('maps a block id and paragraphs onto the block’s entries', () => {
    expect(spanFromWire({ block: 'B2', from: 1, to: 2 }, 'Ember Ward', ember.blocks, 'features')).toEqual({
      span: { entryIds: [gloamwoodEntryId('Level 3: Ember Ward')], from: 1, to: 2 },
    });
  });

  it('gives no span and no warning for the "no text" sentinel', () => {
    expect(spanFromWire({ block: '', from: 0, to: 0 }, 'Ember Ward', ember.blocks, 'features')).toEqual({ span: null });
  });

  it('blocks an unknown block or a range outside the block', () => {
    for (const wire of [{ block: 'B9', from: 1, to: 1 }, { block: 'B2', from: 2, to: 3 }, { block: 'B2', from: 0, to: 1 }, { block: 'B2', from: 2, to: 1 }]) {
      const result = spanFromWire(wire, 'Ember Ward', ember.blocks, 'features');
      expect(result.span, JSON.stringify(wire)).toBeNull();
      expect(result.warning).toMatchObject({ code: 'unresolved-text', severity: 'block', field: 'features' });
    }
  });

  it('warns when the span does not start at the named feature (and accepts a run-in or a block title)', () => {
    const mothkin = candidate('Mothkin');
    expect(spanFromWire({ block: 'B1', from: 6, to: 6 }, 'Dusk Sight', mothkin.blocks, 'traits').warning).toBeUndefined();
    expect(spanFromWire({ block: 'B1', from: 7, to: 7 }, 'Dusk Sight', mothkin.blocks, 'traits').warning).toMatchObject({ code: 'unresolved-text', severity: 'warn' });
    expect(spanFromWire({ block: 'b3', from: 1, to: 1 }, 'Kindled Strikes', ember.blocks, 'features').warning).toBeUndefined();
  });
});

describe('checkSpan', () => {
  it('checks a stored span against the entries', () => {
    const span = { entryIds: [gloamwoodEntryId('Mothkin')], from: 6, to: 6 };
    expect(checkSpan(span, 'Dusk Sight', byId, 'traits')).toBeUndefined();
    expect(checkSpan({ ...span, to: 99 }, 'Dusk Sight', byId, 'traits')).toMatchObject({ severity: 'block' });
    expect(checkSpan({ ...span, entryIds: ['lib:gloam:999'] }, 'Dusk Sight', byId, 'traits')).toMatchObject({ severity: 'block' });
    expect(checkSpan({ ...span, from: 7, to: 7 }, 'Dusk Sight', byId, 'traits')).toMatchObject({ severity: 'warn' });
    expect(checkSpan({ entryIds: [gloamwoodEntryId('Level 7: Smoke Step')], from: 1, to: 1 }, 'Smoke Step', byId, 'features')).toBeUndefined();
  });
});

describe('gradeConfidence (§3.9.2)', () => {
  it('is high only without warn or block, matching its kind, with no missing key field, and never for classes and subclasses', () => {
    expect(gradeConfidence('spell', [w('info', 'default-used')], { matchesKind: true, missingKey: false })).toBe('high');
    expect(gradeConfidence('class', [], { matchesKind: true, missingKey: false })).toBe('medium');
    expect(gradeConfidence('subclass', [], { matchesKind: true, missingKey: false })).toBe('medium');
  });

  it('is medium with warns and at most two ungrounded, low with a block, three ungrounded, a missing key field or a mismatch', () => {
    expect(gradeConfidence('monster', [w('warn'), w('warn', 'ungrounded'), w('warn', 'ungrounded')], { matchesKind: true, missingKey: false })).toBe('medium');
    expect(gradeConfidence('monster', [w('warn', 'ungrounded'), w('warn', 'ungrounded'), w('warn', 'ungrounded')], { matchesKind: true, missingKey: false })).toBe('low');
    expect(gradeConfidence('monster', [w('block')], { matchesKind: true, missingKey: false })).toBe('low');
    expect(gradeConfidence('monster', [], { matchesKind: true, missingKey: true })).toBe('low');
    expect(gradeConfidence('monster', [], { matchesKind: false, missingKey: false })).toBe('low');
  });
});

describe('titleCase', () => {
  it('capitalizes words, leaving small words lowercase after the first', () => {
    expect(titleCase('chaotic neutral')).toBe('Chaotic Neutral');
    expect(titleCase('swarm of tiny beasts')).toBe('Swarm of Tiny Beasts');
    expect(titleCase('monstrosity')).toBe('Monstrosity');
  });
});
