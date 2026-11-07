/**
 * Heroic Inspiration rerolls in the roll dialog.
 *
 * SRD 5.2.1 Rules Glossary, "Heroic Inspiration": you can expend it to reroll any die immediately
 * after rolling it, and you must use the new roll. Playing the Game › D20 Tests › Advantage/
 * Disadvantage › "Interactions with Rerolls": with Advantage or Disadvantage only one of the two
 * d20s is rerolled, and you choose which.
 *
 * The app rerolls the die that helps most — the lower d20, or in a dice pool the die with the most
 * to gain — which is never worse for the hero than another choice. The engine then rolls the
 * request again with every other die held at its face, so totals, natural 20s and 1s and the DC
 * verdict come out exactly as for a normal roll; the one new face comes from the engine's dice.
 */
import { criticalDiceTerms, cryptoRng, parseDice, rollD20Test, rollDice, rollDie, type Rng } from '@/engine';
import type { AdvantageState, D20TestResult, DieRoll, PlayerRollRequest } from '@/types';
import { signed } from '../format';
import { flatBonus, rollKind } from './rollRequest';

/** How the roll being rerolled was made (the same parameters are used again). */
export type RerollSpec =
  | { kind: 'd20'; modifier: number; advantage: AdvantageState; dc?: number }
  | { kind: 'dice'; expression: string; critical?: boolean };

/** +1 or −1 for each die the expression rolls, in roll order ("1d20-1d4" → [1, −1]). */
function diceSigns(expression: string, critical: boolean): number[] {
  try {
    const terms = parseDice(expression);
    return (critical ? criticalDiceTerms(terms) : terms).flatMap((t) =>
      t.kind === 'dice' ? Array.from({ length: t.count }, () => t.sign) : [],
    );
  } catch {
    return [];
  }
}

/**
 * Index of the die worth rerolling: the largest expected gain, (sides + 1) / 2 − face, for a die
 * that adds (a subtracted die gains by showing less). With Advantage that is the lower, dropped
 * d20; with Disadvantage the lower, kept one. −1 when there are no dice.
 */
export function dieToReroll(dice: readonly DieRoll[], signs: readonly number[] = []): number {
  let best = -1;
  let bestGain = -Infinity;
  dice.forEach((die, i) => {
    const gain = (signs[i] ?? 1) * ((die.sides + 1) / 2 - die.value);
    if (gain > bestGain) {
      best = i;
      bestGain = gain;
    }
  });
  return best;
}

/** An Rng that makes the engine roll exactly these faces, in order (and `rest` after them). */
function facesRng(faces: readonly DieRoll[], rest: Rng): Rng {
  let i = 0;
  return {
    next() {
      const die = faces[i++];
      return die ? (die.value - 0.5) / die.sides : rest.next();
    },
  };
}

function sameFaces(a: readonly DieRoll[], b: readonly DieRoll[]): boolean {
  return a.length === b.length && a.every((d, i) => d.sides === b[i].sides && d.value === b[i].value);
}

/**
 * Reroll one die of `previous` (rolled per `spec`) for Heroic Inspiration. `rng` supplies the new
 * face (the engine's crypto dice by default). Attack-roll rules (natural 20 / 1) are the caller's
 * to apply, as for any roll.
 */
export function rerollOneDie(previous: D20TestResult, spec: RerollSpec, rng: Rng = cryptoRng): D20TestResult {
  const roll = (source: Rng): D20TestResult =>
    spec.kind === 'd20'
      ? rollD20Test(spec.modifier, { advantage: spec.advantage, dc: spec.dc, rng: source })
      : rollDice(spec.expression, { critical: spec.critical, rng: source });

  const signs = spec.kind === 'dice' ? diceSigns(spec.expression, spec.critical ?? false) : [];
  const index = dieToReroll(previous.dice, signs);
  if (index < 0) return roll(rng);
  const faces = previous.dice.map((d, i) => ({ sides: d.sides, value: i === index ? rollDie(d.sides, rng) : d.value }));
  const result = roll(facesRng(faces, rng));
  // The engine rolls dice in expression order, so this holds; if a roll ever came out different,
  // a fresh roll of the whole request is still a fair reroll.
  return sameFaces(result.dice, faces) ? result : roll(rng);
}

/** What to do with physical dice when Heroic Inspiration is spent. */
export function physicalRerollInstructions(req: PlayerRollRequest, expression: string | null): string {
  if (rollKind(req) === 'd20') {
    if (req.advantage === 'advantage') return 'Reroll one of your two d20s (the lower one), then enter the higher of the two.';
    if (req.advantage === 'disadvantage') return 'Reroll one of your two d20s (the lower one), then enter the lower of the two.';
    return 'Roll your d20 again and enter the new number.';
  }
  const bonus = flatBonus(expression ?? '');
  const including = bonus !== 0 ? `, including the ${signed(bonus)}` : '';
  return `Reroll one of the dice (the lowest one), then enter the new total${including}.`;
}
