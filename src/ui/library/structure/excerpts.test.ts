import { describe, expect, it } from 'vitest';
import type { Excerpt } from '@/types';
import { findExcerpt, highlightsIn, plainParagraph, slicesOf, unplacedExcerpts } from './excerpts';

const excerpt = (field: string, text: string, grounded = true): Excerpt => ({ field, text, grounded });

describe('plainParagraph', () => {
  it('drops list bullets, heading marks and emphasis', () => {
    expect(plainParagraph('- **AC** 17 (natural armor)')).toBe('AC 17 (natural armor)');
    expect(plainParagraph('### Level 3: Ember Ward')).toBe('Level 3: Ember Ward');
    expect(plainParagraph('_Large Dragon, Unaligned_')).toBe('Large Dragon, Unaligned');
    expect(plainParagraph('_**Bite.**_ _Melee Attack Roll:_ +5, reach 10 ft.')).toBe('Bite. Melee Attack Roll: +5, reach 10 ft.');
    expect(plainParagraph('***Thorn Coat.*** A creature that touches the hound')).toBe('Thorn Coat. A creature that touches the hound');
  });

  it('shows a table row as its cells', () => {
    expect(plainParagraph('| Hookstaff | 1d8 Bludgeoning | Reach, Two-Handed | Topple |')).toBe('Hookstaff · 1d8 Bludgeoning · Reach, Two-Handed · Topple');
  });
});

describe('findExcerpt', () => {
  it('finds an excerpt the way grounding matches it (case, spacing, dashes, quotes)', () => {
    const text = 'HP 52 (8d10 + 8)';
    expect(findExcerpt(text, '52 (8d10 + 8)')).toEqual({ start: 3, end: 16 });
    expect(findExcerpt('Speed 30 ft., Fly 60 ft. (hover)', 'speed 30 ft., fly 60 ft. (hover)')).toEqual({ start: 0, end: 32 });
    expect(findExcerpt('Glimmer Breath (Recharge 5–6)', 'Recharge 5-6')).not.toBeNull();
    expect(findExcerpt('The lamp’s light', "lamp's")).not.toBeNull();
    expect(findExcerpt('Darkvision 60   ft.', 'Darkvision 60 ft.')).toEqual({ start: 0, end: 19 });
  });

  it('marks the original characters, soft hyphens and all', () => {
    const text = 'You have Dark­vision.';
    const at = findExcerpt(text, 'Darkvision');
    expect(at).not.toBeNull();
    expect(text.slice(at!.start, at!.end)).toBe('Dark­vision');
  });

  it('returns null for a misread number', () => {
    expect(findExcerpt('HP 52 (8d10 + 8)', '58 (8d10 + 8)')).toBeNull();
    expect(findExcerpt('anything', '   ')).toBeNull();
  });
});

describe('highlights and slices', () => {
  const text = 'AC 17 (natural armor) Initiative +2 (12)';

  it('cuts the text into plain and marked slices that rebuild it exactly', () => {
    const marks = highlightsIn(text, [excerpt('acText', '17 (natural armor)'), excerpt('initiativeText', '+2 (12)')]);
    expect(marks.map((m) => m.fields)).toEqual([['acText'], ['initiativeText']]);
    const slices = slicesOf(text, marks);
    expect(slices.map((s) => s.text).join('')).toBe(text);
    expect(slices.filter((s) => s.highlight).map((s) => s.text)).toEqual(['17 (natural armor)', '+2 (12)']);
  });

  it('merges overlapping excerpts and keeps both fields', () => {
    const marks = highlightsIn(text, [excerpt('acText', '17 (natural armor)'), excerpt('notes', 'natural armor) Initiative')]);
    expect(marks).toHaveLength(1);
    expect(marks[0].fields).toEqual(['acText', 'notes']);
  });

  it('lists excerpts no paragraph contains', () => {
    const misread = excerpt('hpText', '58 (8d10 + 8)', false);
    expect(unplacedExcerpts(['HP 52 (8d10 + 8)'], [excerpt('hpText', '52 (8d10 + 8)'), misread])).toEqual([misread]);
  });
});
