import { describe, expect, it } from 'vitest';
import {
  DiceError,
  applyAttackRollRules,
  averageRoll,
  criticalDice,
  cryptoRng,
  d20Expression,
  diceRange,
  isValidDice,
  manualD20Result,
  manualRollResult,
  normalizeDice,
  parseDice,
  randomInt,
  rollD20Test,
  rollDamage,
  rollDice,
  rollDie,
  seededRng,
  type Rng,
} from './dice';

/** An Rng that makes the given die faces come up, in order. */
function faces(...rolls: Array<[value: number, sides: number]>): Rng {
  let i = 0;
  return { next: () => (rolls[i] ? (rolls[i][0] - 0.5) / rolls[i++][1] : 0.5) };
}

describe('parseDice', () => {
  it('parses dice, flat terms and defaults', () => {
    expect(parseDice('2d6+3')).toEqual([
      { kind: 'dice', sign: 1, count: 2, sides: 6 },
      { kind: 'flat', sign: 1, value: 3 },
    ]);
    expect(parseDice('d20')).toEqual([{ kind: 'dice', sign: 1, count: 1, sides: 20 }]);
    expect(parseDice('D%')).toEqual([{ kind: 'dice', sign: 1, count: 1, sides: 100 }]);
    expect(parseDice('5')).toEqual([{ kind: 'flat', sign: 1, value: 5 }]);
    expect(parseDice('-1')).toEqual([{ kind: 'flat', sign: -1, value: 1 }]);
  });

  it('parses keep / drop suffixes', () => {
    expect(parseDice('4d6kh3')[0]).toEqual({ kind: 'dice', sign: 1, count: 4, sides: 6, keep: { mode: 'kh', n: 3 } });
    expect(parseDice('2d20kl1')[0]).toMatchObject({ keep: { mode: 'kl', n: 1 } });
    expect(parseDice('4d6dl1')[0]).toMatchObject({ keep: { mode: 'kh', n: 3 } });
    expect(parseDice('4d6dh1')[0]).toMatchObject({ keep: { mode: 'kl', n: 3 } });
    expect(parseDice('2d20k')[0]).toMatchObject({ keep: { mode: 'kh', n: 1 } });
    // Keeping every die is the same as no keep at all.
    expect(parseDice('4d6kh4')[0]).not.toHaveProperty('keep');
  });

  it('accepts spaces around operators and a typographic minus', () => {
    expect(parseDice(' 1d20 + 5 ')).toHaveLength(2);
    expect(parseDice('1d20 − 2')[1]).toEqual({ kind: 'flat', sign: -1, value: 2 });
    expect(parseDice('1d8+2d6+3')).toHaveLength(3);
  });

  it('throws helpful DiceErrors', () => {
    expect(() => parseDice('2dd6')).toThrow(DiceError);
    expect(() => parseDice('2dd6')).toThrow("Couldn't read '2dd6' — try something like 2d6+3");
    expect(() => parseDice('')).toThrow(/Nothing to roll/);
    expect(() => parseDice('101d6')).toThrow(/Too many dice/);
    expect(() => parseDice('1d0')).toThrow(/impossible die/);
    expect(() => parseDice('1d1001')).toThrow(/impossible die/);
    expect(() => parseDice('0d6')).toThrow(/rolls no dice/);
    expect(() => parseDice('4d6kh5')).toThrow(/Can't keep 5 of 4/);
    expect(() => parseDice('4d6dl4')).toThrow(/keep at least 1/);
    expect(() => parseDice('2d6 3')).toThrow(/Couldn't read/);
    expect(() => parseDice('1d20+')).toThrow(/Couldn't read/);
    expect(() => parseDice('fireball')).toThrow(/Couldn't read 'fireball'/);
  });

  it('validates and normalizes', () => {
    expect(isValidDice('1d20+5')).toBe(true);
    expect(isValidDice('2dd6')).toBe(false);
    expect(normalizeDice('1d20 + 5')).toBe('1d20+5');
    expect(normalizeDice('D20')).toBe('1d20');
    expect(normalizeDice('d%')).toBe('1d100');
    expect(normalizeDice('4d6dl1')).toBe('4d6kh3');
    expect(normalizeDice('-1 + d4')).toBe('-1+1d4');
  });
});

describe('rngs', () => {
  it('seededRng is deterministic and in [0, 1)', () => {
    const a = seededRng(42);
    const b = seededRng(42);
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    expect(seqA).toEqual(seqB);
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(seededRng(43).next()).not.toBe(seededRng(42).next());
  });

  it('cryptoRng and randomInt stay in range and cover every face', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 600; i++) {
      const x = cryptoRng.next();
      expect(x >= 0 && x < 1).toBe(true);
      seen.add(rollDie(6));
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    const ints = Array.from({ length: 200 }, () => randomInt(3, seededRng(7)));
    expect(ints.every((n) => n >= 0 && n < 3)).toBe(true);
  });

  it('seeded rolls are reproducible', () => {
    expect(rollDice('4d6kh3', { rng: seededRng(9) })).toEqual(rollDice('4d6kh3', { rng: seededRng(9) }));
  });
});

describe('rollDice', () => {
  it('rolls and explains an expression', () => {
    const r = rollDice('2d6+3', { rng: faces([3, 6], [5, 6]) });
    expect(r.total).toBe(11);
    expect(r.modifier).toBe(3);
    expect(r.dice).toEqual([
      { sides: 6, value: 3 },
      { sides: 6, value: 5 },
    ]);
    expect(r.expression).toBe('2d6+3');
    expect(r.breakdown).toBe('2d6 (3, 5) + 3 = 11');
    expect(r.natural).toBeUndefined();
  });

  it('keeps the highest dice and flags dropped ones', () => {
    const r = rollDice('4d6kh3', { rng: faces([6, 6], [1, 6], [4, 6], [5, 6]) });
    expect(r.total).toBe(15);
    expect(r.dice.filter((d) => d.dropped)).toEqual([{ sides: 6, value: 1, dropped: true }]);
    expect(r.breakdown).toBe('4d6 (6, ~~1~~, 4, 5) = 15');
  });

  it('doubles dice on a critical hit', () => {
    const r = rollDice('1d8+3', { critical: true, rng: faces([8, 8], [2, 8]) });
    expect(r.expression).toBe('2d8+3');
    expect(r.dice).toHaveLength(2);
    expect(r.total).toBe(13);
    expect(criticalDice('1d8+2d6+3')).toBe('2d8+4d6+3');
    expect(rollDice('4d6kh3', { critical: true, rng: seededRng(1) }).dice).toHaveLength(8);
  });

  it('marks a single-d20 expression as a d20 test', () => {
    const r = rollDice('1d20+5', { rng: faces([20, 20]) });
    expect(r).toMatchObject({ natural: 20, isCritical: true, isFumble: false, advantage: 'normal', total: 25 });
    const bless = rollDice('1d20+1d4+2', { rng: faces([1, 20], [3, 4]) });
    expect(bless).toMatchObject({ natural: 1, isFumble: true, total: 6 });
  });

  it('handles constants and negative terms', () => {
    expect(rollDice('5')).toMatchObject({ total: 5, breakdown: '5', dice: [] });
    const r = rollDice('1d20-3', { rng: faces([2, 20]) });
    expect(r.total).toBe(-1);
    expect(r.breakdown).toBe('d20 (2) − 3 = −1');
  });

  it('rollDamage never goes below 0', () => {
    const r = rollDamage('1d4-3', { rng: faces([1, 4]) });
    expect(r.total).toBe(0);
    expect(r.breakdown).toMatch(/→ 0/);
  });
});

describe('d20 tests', () => {
  it('advantage keeps the higher die and records both', () => {
    const r = rollD20Test(5, { advantage: 'advantage', rng: faces([17, 20], [4, 20]) });
    expect(r.expression).toBe('2d20kh1+5');
    expect(r.natural).toBe(17);
    expect(r.total).toBe(22);
    expect(r.dice).toEqual([
      { sides: 20, value: 17 },
      { sides: 20, value: 4, dropped: true },
    ]);
    expect(r.breakdown).toBe('d20 (17, ~~4~~) + 5 = 22');
    expect(r.advantage).toBe('advantage');
  });

  it('disadvantage keeps the lower die', () => {
    const r = rollD20Test(5, { advantage: 'disadvantage', rng: faces([17, 20], [4, 20]) });
    expect(r.expression).toBe('2d20kl1+5');
    expect(r.natural).toBe(4);
    expect(r.total).toBe(9);
    expect(r.dice[0].dropped).toBe(true);
  });

  it('compares against a DC and flags crits and fumbles', () => {
    expect(rollD20Test(2, { dc: 15, rng: faces([13, 20]) })).toMatchObject({ total: 15, dc: 15, success: true });
    expect(rollD20Test(2, { dc: 15, rng: faces([12, 20]) })).toMatchObject({ success: false });
    expect(rollD20Test(0, { rng: faces([20, 20]) })).toMatchObject({ isCritical: true, expression: '1d20', breakdown: 'd20 (20) = 20' });
    expect(rollD20Test(-2, { rng: faces([1, 20]) })).toMatchObject({ isFumble: true, expression: '1d20-2', total: -1 });
    expect(rollD20Test(3)).not.toHaveProperty('success');
  });

  it('applies attack-roll rules for natural 1s and 20s', () => {
    const nat20 = rollD20Test(0, { dc: 30, rng: faces([20, 20]) });
    expect(nat20.success).toBe(false);
    expect(applyAttackRollRules(nat20).success).toBe(true);
    const nat1 = rollD20Test(20, { dc: 5, rng: faces([1, 20]) });
    expect(applyAttackRollRules(nat1).success).toBe(false);
    const nat19 = rollD20Test(5, { dc: 12, rng: faces([19, 20]) });
    expect(applyAttackRollRules(nat19).isCritical).toBe(false);
    expect(applyAttackRollRules(nat19, { critRange: 19 }).isCritical).toBe(true);
  });

  it('builds d20 expressions', () => {
    expect(d20Expression(5, 'advantage')).toBe('2d20kh1+5');
    expect(d20Expression(-1)).toBe('1d20-1');
    expect(d20Expression(0, 'disadvantage')).toBe('2d20kl1');
  });
});

describe('manual (physical dice) results', () => {
  it('builds a d20 test result from a natural roll', () => {
    const r = manualD20Result(17, 5, { dc: 20 });
    expect(r).toMatchObject({ natural: 17, total: 22, success: true, modifier: 5, breakdown: 'd20 (17) + 5 = 22' });
    expect(manualD20Result(20, -1)).toMatchObject({ isCritical: true, total: 19 });
    expect(manualD20Result(12, 3, { advantage: 'advantage' })).toMatchObject({ expression: '2d20kh1+3', advantage: 'advantage' });
    expect(() => manualD20Result(21, 0)).toThrow(DiceError);
    expect(() => manualD20Result(2.5, 0)).toThrow(DiceError);
  });

  it('builds a result from a hand-rolled total', () => {
    const r = manualRollResult('2d6 + 3', 11);
    expect(r).toMatchObject({ expression: '2d6+3', total: 11, modifier: 3, dice: [] });
    expect(r.breakdown).toContain('physical dice');
    expect(manualRollResult('1d20+2', 22).natural).toBe(20);
    expect(() => manualRollResult('2d6', Number.NaN)).toThrow(DiceError);
    expect(() => manualRollResult('2dd6', 4)).toThrow(DiceError);
  });
});

describe('averages and ranges', () => {
  it('computes exact averages, including keep-highest/lowest', () => {
    expect(averageRoll('2d6+3')).toBe(10);
    expect(averageRoll('1d8')).toBe(4.5);
    expect(averageRoll('d20-1')).toBe(9.5);
    expect(averageRoll('5')).toBe(5);
    expect(averageRoll('4d6kh3')).toBeCloseTo(15869 / 1296, 5);
    expect(averageRoll('2d20kh1')).toBeCloseTo(13.825, 5);
    expect(averageRoll('2d20kl1')).toBeCloseTo(7.175, 5);
  });

  it('computes min and max totals', () => {
    expect(diceRange('2d6+3')).toEqual({ min: 5, max: 15 });
    expect(diceRange('1d4-1d6')).toEqual({ min: -5, max: 3 });
    expect(diceRange('4d6kh3')).toEqual({ min: 3, max: 18 });
  });
});
