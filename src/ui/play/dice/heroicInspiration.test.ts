/**
 * Heroic Inspiration rerolls against the real engine (SRD 5.2.1 Rules Glossary "Heroic
 * Inspiration"; D20 Tests › Advantage/Disadvantage › "Interactions with Rerolls").
 */
import { describe, expect, it } from 'vitest';
import { rollD20Test, rollDice, type Rng } from '@/engine';
import type { PlayerRollRequest } from '@/types';
import { dieToReroll, physicalRerollInstructions, rerollOneDie } from './heroicInspiration';

/** An Rng whose dice show these faces, in order: [face, sides]. */
function faces(...dice: [number, number][]): Rng {
  let i = 0;
  return {
    next() {
      const [face, sides] = dice[i++] ?? [1, 2];
      return (face - 0.5) / sides;
    },
  };
}

const values = (r: { dice: { value: number; dropped?: boolean }[] }) => r.dice.map((d) => (d.dropped ? `~${d.value}` : d.value));

describe('rerollOneDie', () => {
  it('rerolls a plain d20 test and judges the new total against the DC', () => {
    const first = rollD20Test(3, { dc: 15, rng: faces([6, 20]) });
    expect(first).toMatchObject({ natural: 6, total: 9, success: false });

    const again = rerollOneDie(first, { kind: 'd20', modifier: 3, advantage: 'normal', dc: 15 }, faces([17, 20]));
    expect(again).toMatchObject({ natural: 17, total: 20, dc: 15, success: true, isCritical: false });
    expect(values(again)).toEqual([17]);
  });

  it('with Advantage rerolls only the lower d20 and keeps the higher of the two', () => {
    const spec = { kind: 'd20', modifier: 2, advantage: 'advantage' } as const;
    const first = rollD20Test(2, { advantage: 'advantage', rng: faces([16, 20], [4, 20]) });
    expect(values(first)).toEqual([16, '~4']);

    const better = rerollOneDie(first, spec, faces([19, 20]));
    expect(values(better)).toEqual(['~16', 19]);
    expect(better).toMatchObject({ natural: 19, total: 21, advantage: 'advantage' });

    // A worse new die can't make it worse: the 16 still counts.
    const same = rerollOneDie(first, spec, faces([2, 20]));
    expect(values(same)).toEqual([16, '~2']);
    expect(same.natural).toBe(16);
  });

  it('with Disadvantage rerolls the lower, kept d20 and keeps the lower of the two', () => {
    const spec = { kind: 'd20', modifier: 0, advantage: 'disadvantage', dc: 10 } as const;
    const first = rollD20Test(0, { advantage: 'disadvantage', dc: 10, rng: faces([16, 20], [4, 20]) });
    expect(first).toMatchObject({ natural: 4, success: false });

    const again = rerollOneDie(first, spec, faces([12, 20]));
    expect(values(again)).toEqual(['~16', 12]);
    expect(again).toMatchObject({ natural: 12, total: 12, success: true });

    const capped = rerollOneDie(first, spec, faces([20, 20]));
    expect(capped).toMatchObject({ natural: 16, isCritical: false });
  });

  it('marks a rerolled natural 20 as critical', () => {
    const first = rollD20Test(1, { rng: faces([1, 20]) });
    expect(first.isFumble).toBe(true);
    const again = rerollOneDie(first, { kind: 'd20', modifier: 1, advantage: 'normal' }, faces([20, 20]));
    expect(again).toMatchObject({ natural: 20, isCritical: true, isFumble: false });
  });

  it('rerolls one die of a damage roll, the one with the most to gain', () => {
    const first = rollDice('2d6+3', { rng: faces([2, 6], [5, 6]) });
    expect(first.total).toBe(10);
    const again = rerollOneDie(first, { kind: 'dice', expression: '2d6+3' }, faces([6, 6]));
    expect(values(again)).toEqual([6, 5]);
    expect(again.total).toBe(14);
  });

  it('keeps critical-hit dice doubled', () => {
    const first = rollDice('1d8+2', { critical: true, rng: faces([7, 8], [1, 8]) });
    expect(values(first)).toEqual([7, 1]);
    const again = rerollOneDie(first, { kind: 'dice', expression: '1d8+2', critical: true }, faces([5, 8]));
    expect(values(again)).toEqual([7, 5]);
    expect(again.total).toBe(14);
  });

  it('treats a subtracted die as better when it shows less', () => {
    const spec = { kind: 'dice', expression: '1d20+5-1d4' } as const;
    // The d4 shows its maximum: rerolling it is the best bet.
    const first = rollDice('1d20+5-1d4', { rng: faces([15, 20], [4, 4]) });
    expect(first.total).toBe(16);
    const again = rerollOneDie(first, spec, faces([1, 4]));
    expect(values(again)).toEqual([15, 1]);
    expect(again.total).toBe(19);
  });
});

describe('dieToReroll', () => {
  it('picks the die with the most to gain, and nothing when there are no dice', () => {
    expect(dieToReroll([{ sides: 20, value: 16 }, { sides: 20, value: 4, dropped: true }])).toBe(1);
    expect(dieToReroll([{ sides: 8, value: 2 }, { sides: 6, value: 1 }])).toBe(0);
    expect(dieToReroll([])).toBe(-1);
  });
});

describe('physicalRerollInstructions', () => {
  const req = (patch: Partial<PlayerRollRequest>): PlayerRollRequest => ({
    rollType: 'skill',
    revealDc: false,
    advantage: 'normal',
    reason: 'Climb',
    ...patch,
  });

  it('explains which die to reroll and what to enter', () => {
    expect(physicalRerollInstructions(req({}), null)).toBe('Roll your d20 again and enter the new number.');
    expect(physicalRerollInstructions(req({ advantage: 'advantage' }), null)).toMatch(/enter the higher of the two/);
    expect(physicalRerollInstructions(req({ advantage: 'disadvantage' }), null)).toMatch(/enter the lower of the two/);
    expect(physicalRerollInstructions(req({ rollType: 'damage', expression: '2d6+3' }), '2d6+3')).toBe(
      'Reroll one of the dice (the lowest one), then enter the new total, including the +3.',
    );
  });
});
