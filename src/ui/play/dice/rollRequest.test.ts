import { describe, expect, it, vi } from 'vitest';
import { sampleCharacter } from '@/test/fixtures';
import type { PlayerRollRequest } from '@/types';
import {
  criticalExpression,
  diceExpression,
  effectiveDc,
  formatParts,
  modifierParts,
  physicalInstructions,
  rollKind,
  withAttackRollRules,
} from './rollRequest';

vi.mock('@/engine', () => import('../testing/engineMock'));

const req = (r: Partial<PlayerRollRequest>): PlayerRollRequest => ({
  rollType: 'skill',
  revealDc: true,
  advantage: 'normal',
  reason: 'Test',
  ...r,
});

describe('roll request helpers', () => {
  it('tells d20 tests from dice pools', () => {
    expect(rollKind(req({ rollType: 'save' }))).toBe('d20');
    expect(rollKind(req({ rollType: 'damage', expression: '1d8' }))).toBe('dice');
    expect(rollKind(req({ rollType: 'custom' }))).toBe('d20');
    expect(rollKind(req({ rollType: 'custom', expression: '1d100' }))).toBe('dice');
    expect(effectiveDc(req({ rollType: 'death-save' }))).toBe(10);
  });

  it('doubles damage dice on a critical hit', () => {
    expect(criticalExpression('1d8+3')).toBe('2d8+3');
    expect(criticalExpression('2d6+1d4-1')).toBe('4d6+2d4-1');
    expect(criticalExpression('not dice')).toBe('not dice');
  });

  it('finds damage dice from the sheet when the request has none', () => {
    const mira = sampleCharacter();
    expect(diceExpression(req({ rollType: 'damage', expression: '2d6' }), mira)).toBe('2d6');
    expect(diceExpression(req({ rollType: 'damage', attackName: 'dagger' }), mira)).toBe('1d4+2');
    expect(diceExpression(req({ rollType: 'hit-die' }), mira)).toBe('1d6');
  });

  it('explains a skill modifier from the sheet', () => {
    const mira = sampleCharacter();
    expect(modifierParts(mira, req({ skill: 'arcana' }), 5)).toEqual([
      { label: 'INT', value: 3 },
      { label: 'Proficiency', value: 2 },
    ]);
    expect(formatParts(modifierParts(mira, req({ skill: 'arcana' }), 5))).toBe('INT +3 · Proficiency +2');
  });

  it('puts what the sheet cannot explain under "Other"', () => {
    const mira = sampleCharacter({ exhaustion: 1 });
    expect(modifierParts(mira, req({ rollType: 'save', ability: 'wis' }), 2)).toEqual([
      { label: 'WIS', value: 1 },
      { label: 'Proficiency', value: 2 },
      { label: 'Exhaustion', value: -2 },
      { label: 'Other', value: 1 },
    ]);
    expect(modifierParts(null, req({ skill: 'stealth' }), 4)).toEqual([{ label: 'Modifier', value: 4 }]);
  });

  it('writes physical-dice instructions', () => {
    expect(physicalInstructions(req({ advantage: 'advantage' }), null)).toBe(
      'Advantage: roll two d20s and enter the higher.',
    );
    expect(physicalInstructions(req({ rollType: 'damage' }), '2d6+3')).toBe(
      'Roll 2d6+3 and enter the total, including the +3.',
    );
    expect(physicalInstructions(req({ rollType: 'hit-die' }), '1d8')).toBe('Roll 1d8 and enter the total.');
  });

  it('applies natural 20 / natural 1 to attack rolls', () => {
    const base = { expression: '1d20+4', total: 24, dice: [], modifier: 4, breakdown: '', dc: 25, success: false };
    expect(withAttackRollRules({ ...base, natural: 20 }).success).toBe(true);
    expect(withAttackRollRules({ ...base, natural: 1, total: 30, success: true }).success).toBe(false);
    expect(withAttackRollRules({ ...base, natural: 12 }).success).toBe(false);
  });
});
