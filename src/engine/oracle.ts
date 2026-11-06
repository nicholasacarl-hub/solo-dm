/**
 * A yes/no oracle for solo play (an original design, not a copy of any published oracle).
 * The DM uses it when it genuinely doesn't know how the world would answer ("Is anyone home?"),
 * so outcomes aren't always the DM's choice.
 *
 * Roll d100 against a target set by likelihood. Results at or under the target are "yes";
 * the lowest fifth of the yes band is "yes, and"; the top fifth of the yes band is "yes, but".
 * Mirror logic for "no": the bottom fifth of the no band is "no, but"; the top fifth is "no, and".
 * Doubles (11, 22, … 99, and 100) also add a random twist.
 */
import type { Rng } from './dice';

export type Likelihood =
  | 'nearly-impossible'
  | 'very-unlikely'
  | 'unlikely'
  | 'even'
  | 'likely'
  | 'very-likely'
  | 'nearly-certain';

export const LIKELIHOOD_TARGETS: Record<Likelihood, number> = {
  'nearly-impossible': 5,
  'very-unlikely': 15,
  unlikely: 30,
  even: 50,
  likely: 70,
  'very-likely': 85,
  'nearly-certain': 95,
};

export type OracleAnswer = 'yes-and' | 'yes' | 'yes-but' | 'no-but' | 'no' | 'no-and';

export interface OracleResult {
  question: string;
  likelihood: Likelihood;
  roll: number;
  target: number;
  answer: OracleAnswer;
  /** "Yes, and…" style label. */
  label: string;
  /** Present when the roll was a double: a short prompt for a complication or opportunity. */
  twist?: string;
}

export function consultOracle(_question: string, _likelihood: Likelihood, _rng?: Rng): OracleResult {
  throw new Error('not implemented');
}

/** A random twist prompt from an original table (e.g. "An unexpected ally appears", "Something precious is at risk"). */
export function randomTwist(_rng?: Rng): string {
  throw new Error('not implemented');
}
