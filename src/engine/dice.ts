/**
 * Dice: expression parsing and rolling. Pure and deterministic given an Rng.
 *
 * Supported syntax (case-insensitive, whitespace ignored):
 *   NdM            2d6, d20 (N defaults to 1), d100 / d%
 *   NdMkhK / klK   4d6kh3 (keep highest 3), 2d20kl1
 *   +/- terms      1d8+2d6+3, 1d20-1
 * Constants alone ("5") are valid. Max 100 dice per term, sides 1–1000.
 */
import type { AdvantageState, D20TestResult, RollResult } from '@/types';

/** Uniform random source in [0, 1). */
export interface Rng {
  next(): number;
}

/** Cryptographically strong RNG (crypto.getRandomValues). The default everywhere in the app. */
export const cryptoRng: Rng = {
  next() {
    throw new Error('not implemented');
  },
};

/** Deterministic RNG for tests (e.g. mulberry32). */
export function seededRng(_seed: number): Rng {
  throw new Error('not implemented');
}

export class DiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiceError';
  }
}

export type DiceTerm =
  | { kind: 'dice'; sign: 1 | -1; count: number; sides: number; keep?: { mode: 'kh' | 'kl'; n: number } }
  | { kind: 'flat'; sign: 1 | -1; value: number };

/** Parse an expression into terms. Throws DiceError with a helpful message on bad input. */
export function parseDice(_expression: string): DiceTerm[] {
  throw new Error('not implemented');
}

export function isValidDice(_expression: string): boolean {
  throw new Error('not implemented');
}

/** Normalized string form of an expression ("1d20 + 5" -> "1d20+5"). */
export function normalizeDice(_expression: string): string {
  throw new Error('not implemented');
}

/**
 * Roll an expression.
 * @param opts.critical double the number of dice in every dice term (critical-hit damage).
 */
export function rollDice(_expression: string, _opts?: { rng?: Rng; critical?: boolean }): RollResult {
  throw new Error('not implemented');
}

/**
 * Roll a d20 test (ability check, saving throw, attack roll) with a flat modifier.
 * Advantage rolls 2d20 and keeps the higher; disadvantage keeps the lower.
 * Sets natural, isCritical (natural 20), isFumble (natural 1), and success when dc is given
 * (success = total >= dc; callers handle attack-roll auto-hit/miss rules).
 */
export function rollD20Test(
  _modifier: number,
  _opts?: { advantage?: AdvantageState; dc?: number; rng?: Rng },
): D20TestResult {
  throw new Error('not implemented');
}

/** Build a D20TestResult from a natural d20 the player rolled on physical dice. */
export function manualD20Result(
  _natural: number,
  _modifier: number,
  _opts?: { advantage?: AdvantageState; dc?: number },
): D20TestResult {
  throw new Error('not implemented');
}

/** Build a RollResult from a total the player rolled on physical dice for a non-d20 expression. */
export function manualRollResult(_expression: string, _total: number): RollResult {
  throw new Error('not implemented');
}

/** Average result of an expression (e.g. "2d6+3" -> 10). Keep-highest/lowest terms may be approximated. */
export function averageRoll(_expression: string): number {
  throw new Error('not implemented');
}
