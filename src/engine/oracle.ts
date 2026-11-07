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
import { cryptoRng, randomInt, type Rng } from './dice';

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

export const ORACLE_LABELS: Record<OracleAnswer, string> = {
  'yes-and': 'Yes, and…',
  yes: 'Yes',
  'yes-but': 'Yes, but…',
  'no-but': 'No, but…',
  no: 'No',
  'no-and': 'No, and…',
};

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

/** Original, setting-neutral prompts for complications and opportunities. */
export const TWISTS: readonly string[] = [
  'A rival arrives first',
  'The ground gives way',
  'An old debt comes due',
  "Someone here isn't who they seem",
  'The weather turns violent',
  'An unlikely ally steps forward',
  'Something precious is at risk',
  'A secret comes to light',
  'The way back is cut off',
  'Unseen eyes are watching',
  'An omen appears',
  'Gear fails at the worst moment',
  'An innocent is caught in the middle',
  'A hidden path opens up',
  'Time is running out',
  'A familiar face returns',
  'The locals turn wary',
  'A tempting offer is made',
  'Magic behaves strangely here',
  'Noise draws a hungry beast',
  'The prize is not what it seemed',
  'Two problems become one',
  'A message arrives, meant for you',
  'Fire, flood, or collapse threatens',
  'Someone cries out for help',
  'The trail goes cold',
  'The authorities take an interest',
  'A promise is broken',
  'A lucky find',
  'The past catches up',
  'A strange creature offers a bargain',
  'The plan works too well',
];

/** A random twist prompt from an original table (e.g. "An unexpected ally appears", "Something precious is at risk"). */
export function randomTwist(rng: Rng = cryptoRng): string {
  return TWISTS[randomInt(TWISTS.length, rng)];
}

/** One fifth of a band, at least 1 (bands are 5–95 wide for the standard likelihoods). */
function fifth(width: number): number {
  return Math.max(1, Math.floor(width / 5));
}

/** Answer for a d100 roll against a target (exported for tests and previews). */
export function oracleAnswer(roll: number, target: number): OracleAnswer {
  if (roll <= target) {
    if (roll <= fifth(target)) return 'yes-and';
    if (roll > target - fifth(target)) return 'yes-but';
    return 'yes';
  }
  const noWidth = 100 - target;
  if (roll <= target + fifth(noWidth)) return 'no-but';
  if (roll > 100 - fifth(noWidth)) return 'no-and';
  return 'no';
}

function isDouble(roll: number): boolean {
  return roll === 100 || (roll % 11 === 0 && roll <= 99);
}

export function consultOracle(question: string, likelihood: Likelihood, rng: Rng = cryptoRng): OracleResult {
  const target = LIKELIHOOD_TARGETS[likelihood] ?? LIKELIHOOD_TARGETS.even;
  const roll = randomInt(100, rng) + 1;
  const answer = oracleAnswer(roll, target);
  const result: OracleResult = {
    question: question.trim(),
    likelihood: likelihood in LIKELIHOOD_TARGETS ? likelihood : 'even',
    roll,
    target,
    answer,
    label: ORACLE_LABELS[answer],
  };
  return isDouble(roll) ? { ...result, twist: randomTwist(rng) } : result;
}

export type SceneCheckOutcome = 'expected' | 'altered' | 'interrupted';

export interface SceneCheckResult {
  roll: number;
  tension: number;
  outcome: SceneCheckOutcome;
  /** For altered / interrupted scenes: a twist prompt to build the change around. */
  twist?: string;
}

/** Roll a d10 against the tension dial (1–9): <= tension and odd = altered, <= tension and even = interrupted. */
export function sceneCheck(tension: number, rng: Rng = cryptoRng): SceneCheckResult {
  const dial = Math.min(9, Math.max(1, Number.isFinite(tension) ? Math.round(tension) : 5));
  const roll = randomInt(10, rng) + 1;
  if (roll > dial) return { roll, tension: dial, outcome: 'expected' };
  return { roll, tension: dial, outcome: roll % 2 === 1 ? 'altered' : 'interrupted', twist: randomTwist(rng) };
}
