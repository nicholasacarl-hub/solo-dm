import { describe, expect, it } from 'vitest';
import type { Rng } from './dice';
import { seededRng } from './dice';
import { LIKELIHOOD_TARGETS, TWISTS, consultOracle, oracleAnswer, randomTwist, sceneCheck } from './oracle';

/** An Rng whose first value makes randomInt(sides) return `face - 1`, then returns `rest` values. */
const rolling = (face: number, sides: number, ...rest: number[]): Rng => {
  const values = [(face - 0.5) / sides, ...rest];
  let i = 0;
  return { next: () => values[Math.min(i++, values.length - 1)] };
};

describe('oracle answer bands', () => {
  it('even odds (target 50)', () => {
    const answers = [1, 10, 11, 40, 41, 50, 51, 60, 61, 90, 91, 100].map((r) => oracleAnswer(r, 50));
    expect(answers).toEqual(['yes-and', 'yes-and', 'yes', 'yes', 'yes-but', 'yes-but', 'no-but', 'no-but', 'no', 'no', 'no-and', 'no-and']);
  });

  it('likely (target 70) and nearly impossible (target 5)', () => {
    expect([14, 15, 56, 57, 70, 71, 76, 77, 94, 95].map((r) => oracleAnswer(r, LIKELIHOOD_TARGETS.likely))).toEqual([
      'yes-and', 'yes', 'yes', 'yes-but', 'yes-but', 'no-but', 'no-but', 'no', 'no', 'no-and',
    ]);
    expect([1, 2, 4, 5, 6, 24, 25, 81, 82].map((r) => oracleAnswer(r, 5))).toEqual([
      'yes-and', 'yes', 'yes', 'yes-but', 'no-but', 'no-but', 'no', 'no', 'no-and',
    ]);
  });
});

describe('consultOracle', () => {
  it('rolls d100 and labels the answer', () => {
    const r = consultOracle('  Is anyone home? ', 'even', rolling(37, 100));
    expect(r).toEqual({ question: 'Is anyone home?', likelihood: 'even', roll: 37, target: 50, answer: 'yes', label: 'Yes' });
    expect(consultOracle('?', 'even', rolling(5, 100)).label).toBe('Yes, and…');
    expect(consultOracle('?', 'even', rolling(45, 100)).label).toBe('Yes, but…');
    expect(consultOracle('?', 'even', rolling(55, 100)).label).toBe('No, but…');
    expect(consultOracle('?', 'even', rolling(75, 100)).label).toBe('No');
    expect(consultOracle('?', 'even', rolling(95, 100)).label).toBe('No, and…');
  });

  it('adds a twist on doubles (11 … 99 and 100)', () => {
    const double = consultOracle('?', 'likely', rolling(22, 100, 0));
    expect(double.twist).toBe(TWISTS[0]);
    expect(consultOracle('?', 'likely', rolling(100, 100, 0)).twist).toBe(TWISTS[0]);
    expect(consultOracle('?', 'likely', rolling(23, 100)).twist).toBeUndefined();
  });

  it('only produces valid rolls and answers', () => {
    const rng = seededRng(2024);
    for (let i = 0; i < 200; i++) {
      const r = consultOracle('?', 'very-unlikely', rng);
      expect(r.roll >= 1 && r.roll <= 100).toBe(true);
      expect(r.answer).toBe(oracleAnswer(r.roll, 15));
      expect(r.twist !== undefined).toBe(r.roll === 100 || r.roll % 11 === 0);
    }
  });
});

describe('twists', () => {
  it('has about thirty distinct, short prompts', () => {
    expect(TWISTS.length).toBeGreaterThanOrEqual(30);
    expect(new Set(TWISTS).size).toBe(TWISTS.length);
    expect(TWISTS.every((t) => t.length > 0 && t.length <= 50)).toBe(true);
    expect(TWISTS).toContain(randomTwist(seededRng(3)));
  });
});

describe('sceneCheck', () => {
  it('odd at or under the tension alters the scene; even interrupts it', () => {
    expect(sceneCheck(5, rolling(3, 10, 0))).toEqual({ roll: 3, tension: 5, outcome: 'altered', twist: TWISTS[0] });
    expect(sceneCheck(5, rolling(4, 10, 0))).toMatchObject({ outcome: 'interrupted', twist: TWISTS[0] });
    expect(sceneCheck(5, rolling(5, 10, 0)).outcome).toBe('altered');
    expect(sceneCheck(5, rolling(6, 10))).toEqual({ roll: 6, tension: 5, outcome: 'expected' });
  });

  it('clamps the tension dial to 1–9', () => {
    expect(sceneCheck(12, rolling(10, 10)).tension).toBe(9);
    expect(sceneCheck(12, rolling(10, 10)).outcome).toBe('expected');
    expect(sceneCheck(0, rolling(1, 10, 0))).toMatchObject({ tension: 1, outcome: 'altered' });
  });
});
