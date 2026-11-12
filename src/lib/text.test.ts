import { describe, expect, it } from 'vitest';
import { codePoints, safeEnd } from './text';

describe('safeEnd', () => {
  it('moves a cut off the middle of a surrogate pair, and leaves every other cut alone', () => {
    const text = 'ab🐉c'; // a b \uD83D \uDC09 c
    expect(safeEnd(text, 3)).toBe(2); // between the halves
    expect(safeEnd(text, 2)).toBe(2);
    expect(safeEnd(text, 4)).toBe(4);
    expect(safeEnd(text, 0)).toBe(0);
    expect(safeEnd(text, 5)).toBe(5);
    expect(safeEnd(text, 9)).toBe(9);
    expect(text.slice(0, safeEnd(text, 3))).toBe('ab');
  });
});

describe('codePoints', () => {
  it('counts an emoji once and a lone half as one', () => {
    expect(codePoints('')).toBe(0);
    expect(codePoints('abc')).toBe(3);
    expect(codePoints('🐉🐉')).toBe(2);
    expect(codePoints('a🐉b')).toBe(3);
    expect(codePoints('\uD83D')).toBe(1);
    expect(codePoints('\uDC09\uD83D')).toBe(2);
  });
});
