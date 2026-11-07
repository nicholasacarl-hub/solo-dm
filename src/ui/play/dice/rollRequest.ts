/**
 * Presentation logic for a player roll request: which dice, the modifier breakdown, and the
 * instructions for physical dice. The modifier itself always comes from the request (computed by
 * the engine when the DM asked for the roll); the breakdown only explains it.
 */
import {
  abilityModifier,
  attackAbilityModifier,
  attackDamageExpression,
  characterLevel,
  exhaustionPenalty,
  parseDice,
  proficiencyBonus,
  type DiceTerm,
} from '@/engine';
import { SKILL_ABILITY, type Ability, type Character, type D20TestResult, type PlayerRollRequest } from '@/types';
import { signed } from '../format';

export const ABILITY_ABBR: Record<Ability, string> = {
  str: 'STR',
  dex: 'DEX',
  con: 'CON',
  int: 'INT',
  wis: 'WIS',
  cha: 'CHA',
};

/** d20 tests (checks, saves, attacks, initiative, death saves) vs. dice pools (damage, hit dice). */
export function rollKind(req: PlayerRollRequest): 'd20' | 'dice' {
  if (req.rollType === 'damage' || req.rollType === 'hit-die') return 'dice';
  if (req.rollType === 'custom') return req.expression?.trim() ? 'dice' : 'd20';
  return 'd20';
}

/** The DC a d20 test is judged against (death saves are always DC 10). */
export function effectiveDc(req: PlayerRollRequest): number | undefined {
  return req.dc ?? (req.rollType === 'death-save' ? 10 : undefined);
}

function findAttack(c: Character, name: string | undefined) {
  if (!name) return undefined;
  const key = name.trim().toLowerCase();
  return c.attacks.find((a) => a.name.toLowerCase() === key) ?? c.attacks.find((a) => a.name.toLowerCase().includes(key));
}

/** The dice to roll for a non-d20 request (the request's expression, else derived from the sheet). */
export function diceExpression(req: PlayerRollRequest, c: Character | null): string {
  const given = req.expression?.trim();
  if (given) return given;
  if (c) {
    const attack = findAttack(c, req.attackName);
    if (attack) {
      try {
        return attackDamageExpression(c, attack, false);
      } catch {
        return attack.damage;
      }
    }
    if (req.rollType === 'hit-die') {
      const die = c.hitDice.filter((h) => h.spent < h.total).sort((a, b) => b.die - a.die)[0] ?? c.hitDice[0];
      if (die) return `1d${die.die}`;
    }
  }
  return '1d20';
}

/**
 * Critical hits roll the damage dice twice: "1d8+3" -> "2d8+3" (a keep-highest group is repeated
 * as a second group, matching engine.rollDice({ critical: true })). Unparseable input is returned as-is.
 */
export function criticalExpression(expression: string): string {
  let terms: DiceTerm[];
  try {
    terms = parseDice(expression);
  } catch {
    return expression;
  }
  return terms
    .flatMap((t): DiceTerm[] => (t.kind === 'flat' ? [t] : t.keep ? [t, t] : [{ ...t, count: t.count * 2 }]))
    .map((t, i) => {
      const sign = t.sign < 0 ? '-' : i === 0 ? '' : '+';
      if (t.kind === 'flat') return `${sign}${t.value}`;
      return `${sign}${t.count}d${t.sides}${t.keep ? `${t.keep.mode}${t.keep.n}` : ''}`;
    })
    .join('');
}

/**
 * SRD 5.2.1 "Rolling 1s and 20s": an attack roll with a natural 20 hits (a Critical Hit) and a
 * natural 1 misses, whatever the total. Idempotent, so the DM may apply it again.
 */
export function withAttackRollRules(result: D20TestResult): D20TestResult {
  if (result.dc === undefined || result.natural === undefined) return result;
  if (result.natural === 20) return { ...result, success: true };
  if (result.natural === 1) return { ...result, success: false };
  return result;
}

/** Sum of flat terms in an expression ("2d6+3" -> 3), 0 if unparseable. */
export function flatBonus(expression: string): number {
  try {
    return parseDice(expression).reduce((sum, t) => (t.kind === 'flat' ? sum + t.sign * t.value : sum), 0);
  } catch {
    return 0;
  }
}

export interface ModifierPart {
  label: string;
  value: number;
}

/** The parts of a d20 modifier the sheet explains. The ability part is kept even when it is +0. */
function sheetParts(c: Character, req: PlayerRollRequest): ModifierPart[] {
  const pb = proficiencyBonus(characterLevel(c));
  const parts: (ModifierPart & { always?: boolean })[] = [];
  const addAbility = (ability: Ability) =>
    parts.push({ label: ABILITY_ABBR[ability], value: abilityModifier(c.abilityScores[ability]), always: true });

  switch (req.rollType) {
    case 'skill': {
      if (!req.skill) break;
      addAbility(req.ability ?? SKILL_ABILITY[req.skill]);
      const level = c.skills[req.skill] ?? 0;
      const label = level === 2 ? 'Expertise' : level === 0.5 ? 'Half proficiency' : 'Proficiency';
      parts.push({ label, value: Math.floor(pb * level) });
      break;
    }
    case 'ability':
      if (req.ability) addAbility(req.ability);
      break;
    case 'save':
      if (!req.ability) break;
      addAbility(req.ability);
      parts.push({ label: 'Proficiency', value: c.savingThrows.includes(req.ability) ? pb : 0 });
      break;
    case 'initiative':
      addAbility('dex');
      parts.push({ label: 'Initiative bonus', value: c.initiativeBonusExtra ?? 0 });
      break;
    case 'attack': {
      const attack = findAttack(c, req.attackName);
      if (!attack) break;
      parts.push({ label: attack.name, value: attackAbilityModifier(c, attack), always: true });
      parts.push({ label: 'Proficiency', value: attack.proficient ? pb : 0 });
      parts.push({ label: 'Bonus', value: attack.attackBonusExtra ?? 0 });
      break;
    }
    default:
      break;
  }
  parts.push({ label: 'Exhaustion', value: exhaustionPenalty(c) });
  return parts.filter((p) => p.always || p.value !== 0).map(({ label, value }) => ({ label, value }));
}

/**
 * Explain a d20 modifier from the sheet ("INT +3 · Proficiency +2"). Anything the sheet can't
 * account for (magic items, homebrew boons…) shows up as "Other", so the parts always add up.
 */
export function modifierParts(c: Character | null, req: PlayerRollRequest, modifier: number): ModifierPart[] {
  let parts: ModifierPart[] = [];
  if (c) {
    try {
      parts = sheetParts(c, req);
    } catch {
      parts = [];
    }
  }
  const remainder = modifier - parts.reduce((sum, p) => sum + p.value, 0);
  if (remainder !== 0) parts.push({ label: parts.length ? 'Other' : 'Modifier', value: remainder });
  return parts;
}

export function formatParts(parts: ModifierPart[]): string {
  return parts.map((p) => `${p.label} ${signed(p.value)}`).join(' · ');
}

/** What to do with physical dice. */
export function physicalInstructions(req: PlayerRollRequest, expression: string | null): string {
  if (rollKind(req) === 'd20') {
    if (req.advantage === 'advantage') return 'Advantage: roll two d20s and enter the higher.';
    if (req.advantage === 'disadvantage') return 'Disadvantage: roll two d20s and enter the lower.';
    return 'Roll a d20 and enter the number it shows.';
  }
  const dice = expression ?? '';
  const bonus = flatBonus(dice);
  const including = bonus !== 0 ? `, including the ${signed(bonus)}` : '';
  if (req.critical) return `Critical hit: roll ${dice} (the dice are doubled) and enter the total${including}.`;
  return `Roll ${dice} and enter the total${including}.`;
}
