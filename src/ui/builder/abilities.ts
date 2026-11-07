/**
 * Ability score generation (SRD 5.2.1 "Step 3: Ability Scores"): standard array, point cost,
 * 4d6-drop-lowest, and the background's +2/+1 or +1/+1/+1 increases. Pure functions.
 */
import { ABILITIES, ABILITY_NAMES, type Ability, type AbilityScores, type BackgroundOption, type ClassOption, type RollResult } from '@/types';
import { STANDARD_ARRAY, type BonusMode, type BuilderDraft, type RolledScore } from './types';

export const POINT_BUY_BUDGET = 27;
export const POINT_BUY_MIN = 8;
export const POINT_BUY_MAX = 15;
/** SRD 5.2.1 Ability Score Point Costs. */
export const POINT_BUY_COSTS: Readonly<Record<number, number>> = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
/** Background increases can't raise a score above 20. */
export const MAX_ABILITY_SCORE = 20;

/** Point cost of one score, or null when the score can't be bought (outside 8–15). */
export function pointBuyCost(score: number): number | null {
  return POINT_BUY_COSTS[score] ?? null;
}

/** Total points spent; null when any score is outside the buyable range. */
export function pointBuySpent(scores: AbilityScores): number | null {
  let total = 0;
  for (const ability of ABILITIES) {
    const cost = pointBuyCost(scores[ability]);
    if (cost === null) return null;
    total += cost;
  }
  return total;
}

export function pointBuyRemaining(scores: AbilityScores): number {
  const spent = pointBuySpent(scores);
  return spent === null ? 0 : POINT_BUY_BUDGET - spent;
}

/** Whether raising/lowering one score by `delta` keeps the build legal. */
export function canAdjustPointBuy(scores: AbilityScores, ability: Ability, delta: 1 | -1): boolean {
  const next = scores[ability] + delta;
  if (next < POINT_BUY_MIN || next > POINT_BUY_MAX) return false;
  const spent = pointBuySpent({ ...scores, [ability]: next });
  return spent !== null && spent <= POINT_BUY_BUDGET;
}

export function adjustPointBuy(scores: AbilityScores, ability: Ability, delta: 1 | -1): AbilityScores {
  return canAdjustPointBuy(scores, ability, delta) ? { ...scores, [ability]: scores[ability] + delta } : scores;
}

/** The six numbers being assigned (standard array or rolled totals); empty for point buy. */
export function scorePool(draft: Pick<BuilderDraft, 'abilityMethod' | 'rolls'>): number[] {
  if (draft.abilityMethod === 'standard') return [...STANDARD_ARRAY];
  if (draft.abilityMethod === 'roll') return (draft.rolls ?? []).map((r) => r.total);
  return [];
}

/**
 * Assign pool entry `poolIndex` to `ability`. If another ability already holds that entry, the two
 * abilities swap, so every entry stays used at most once.
 */
export function assignScore(
  assignment: Partial<Record<Ability, number>>,
  ability: Ability,
  poolIndex: number | null,
): Partial<Record<Ability, number>> {
  const next: Partial<Record<Ability, number>> = { ...assignment };
  const previous = next[ability];
  if (poolIndex === null) {
    delete next[ability];
    return next;
  }
  const holder = ABILITIES.find((a) => a !== ability && next[a] === poolIndex);
  if (holder) {
    if (previous === undefined) delete next[holder];
    else next[holder] = previous;
  }
  next[ability] = poolIndex;
  return next;
}

/** Scores before background increases. Unassigned abilities read as 10 and `complete` is false. */
export function baseScores(draft: BuilderDraft): { scores: AbilityScores; complete: boolean } {
  if (draft.abilityMethod === 'point-buy') {
    return { scores: { ...draft.pointBuy }, complete: pointBuySpent(draft.pointBuy) !== null };
  }
  const pool = scorePool(draft);
  const scores = {} as AbilityScores;
  let complete = pool.length === ABILITIES.length;
  for (const ability of ABILITIES) {
    const index = draft.assignment[ability];
    const value = index === undefined ? undefined : pool[index];
    if (value === undefined) complete = false;
    scores[ability] = value ?? 10;
  }
  return { scores, complete };
}

/** The background's increases as chosen in the draft (only abilities the background lists count). */
export function backgroundBonuses(
  draft: Pick<BuilderDraft, 'bonusMode' | 'bonusPlus2' | 'bonusPlus1'>,
  background: BackgroundOption | undefined,
): Partial<Record<Ability, number>> {
  if (!background) return {};
  const allowed = new Set(background.abilityScores);
  if (draft.bonusMode === 'one-one-one') {
    return Object.fromEntries(background.abilityScores.map((a) => [a, 1]));
  }
  const bonuses: Partial<Record<Ability, number>> = {};
  if (draft.bonusPlus2 && allowed.has(draft.bonusPlus2)) bonuses[draft.bonusPlus2] = 2;
  if (draft.bonusPlus1 && allowed.has(draft.bonusPlus1) && draft.bonusPlus1 !== draft.bonusPlus2) {
    bonuses[draft.bonusPlus1] = 1;
  }
  return bonuses;
}

/** Add increases, capping each score at 20. */
export function applyBonuses(base: AbilityScores, bonuses: Partial<Record<Ability, number>>): AbilityScores {
  const out = { ...base };
  for (const ability of ABILITIES) {
    out[ability] = Math.min(MAX_ABILITY_SCORE, base[ability] + (bonuses[ability] ?? 0));
  }
  return out;
}

export function finalAbilityScores(draft: BuilderDraft, background: BackgroundOption | undefined): AbilityScores {
  return applyBonuses(baseScores(draft).scores, backgroundBonuses(draft, background));
}

/** SRD 5.2.1 "Standard Array by Class" suggestions. */
const SRD_STANDARD_ARRAYS: Record<string, AbilityScores> = {
  barbarian: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
  bard: { str: 8, dex: 14, con: 12, int: 13, wis: 10, cha: 15 },
  cleric: { str: 14, dex: 8, con: 13, int: 10, wis: 15, cha: 12 },
  druid: { str: 8, dex: 12, con: 14, int: 13, wis: 15, cha: 10 },
  fighter: { str: 15, dex: 14, con: 13, int: 8, wis: 10, cha: 12 },
  monk: { str: 12, dex: 15, con: 13, int: 10, wis: 14, cha: 8 },
  paladin: { str: 15, dex: 10, con: 13, int: 8, wis: 12, cha: 14 },
  ranger: { str: 12, dex: 15, con: 13, int: 8, wis: 14, cha: 10 },
  rogue: { str: 12, dex: 15, con: 13, int: 14, wis: 10, cha: 8 },
  sorcerer: { str: 10, dex: 13, con: 14, int: 8, wis: 12, cha: 15 },
  warlock: { str: 8, dex: 14, con: 13, int: 12, wis: 10, cha: 15 },
  wizard: { str: 8, dex: 12, con: 13, int: 15, wis: 14, cha: 10 },
};

/** Abilities from most to least important for a class (SRD suggestion, else primaries → CON → DEX → rest). */
export function abilityPriority(cls: ClassOption | undefined): Ability[] {
  const suggested = cls ? SRD_STANDARD_ARRAYS[cls.name.trim().toLowerCase()] : undefined;
  if (suggested) {
    return [...ABILITIES].sort((a, b) => suggested[b] - suggested[a]);
  }
  const order: Ability[] = [...(cls?.primaryAbilities ?? []), 'con', 'dex', ...(cls?.savingThrows ?? []), 'wis', 'str', 'cha', 'int'];
  return [...new Set(order)].filter((a): a is Ability => ABILITIES.includes(a));
}

/** Assign the pool's numbers (highest first) to abilities in priority order. */
export function recommendedAssignment(cls: ClassOption | undefined, pool: number[]): Partial<Record<Ability, number>> {
  const byValue = pool.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value);
  const assignment: Partial<Record<Ability, number>> = {};
  abilityPriority(cls).forEach((ability, i) => {
    const slot = byValue[i];
    if (slot) assignment[ability] = slot.index;
  });
  return assignment;
}

/** +2 to the background ability the class values most, +1 to the next. */
export function recommendedBonuses(
  cls: ClassOption | undefined,
  background: BackgroundOption | undefined,
): { bonusMode: BonusMode; bonusPlus2: Ability | null; bonusPlus1: Ability | null } {
  if (!background) return { bonusMode: 'two-one', bonusPlus2: null, bonusPlus1: null };
  const priority = abilityPriority(cls);
  const ranked = [...background.abilityScores].sort((a, b) => priority.indexOf(a) - priority.indexOf(b));
  return { bonusMode: 'two-one', bonusPlus2: ranked[0] ?? null, bonusPlus1: ranked[1] ?? null };
}

/** Roll 4d6, drop the lowest, six times. `roll` is the engine's dice roller (rollDice). */
export function rollAbilityScores(roll: (expression: string) => RollResult): RolledScore[] {
  return Array.from({ length: 6 }, () => {
    const result = roll('4d6kh3');
    const dice = result.dice.map((d) => d.value);
    const droppedIndex = result.dice.findIndex((d) => d.dropped);
    return { total: result.total, dice, droppedIndex };
  });
}

/** Problems that block the ability-score step. */
export function validateAbilities(draft: BuilderDraft, background: BackgroundOption | undefined): string[] {
  const errors: string[] = [];
  if (draft.abilityMethod === 'point-buy') {
    const spent = pointBuySpent(draft.pointBuy);
    if (spent === null) errors.push('Point-buy scores must be between 8 and 15.');
    else if (spent > POINT_BUY_BUDGET) errors.push(`You spent ${spent} points; the budget is ${POINT_BUY_BUDGET}.`);
  } else {
    if (draft.abilityMethod === 'roll' && (draft.rolls?.length ?? 0) !== ABILITIES.length) {
      errors.push('Roll your six ability scores.');
    } else if (!baseScores(draft).complete) {
      errors.push('Assign a score to every ability.');
    }
  }
  if (background && draft.bonusMode === 'two-one') {
    const allowed = background.abilityScores;
    if (!draft.bonusPlus2 || !allowed.includes(draft.bonusPlus2)) {
      errors.push(`Choose which of ${listAbilities(allowed)} gets +2.`);
    } else if (!draft.bonusPlus1 || !allowed.includes(draft.bonusPlus1) || draft.bonusPlus1 === draft.bonusPlus2) {
      errors.push('Choose a different ability for the +1 increase.');
    }
  }
  return errors;
}

/** Abilities whose background increase was partly lost to the 20 cap. */
export function cappedAbilities(draft: BuilderDraft, background: BackgroundOption | undefined): Ability[] {
  const base = baseScores(draft).scores;
  const bonuses = backgroundBonuses(draft, background);
  return ABILITIES.filter((a) => base[a] + (bonuses[a] ?? 0) > MAX_ABILITY_SCORE);
}

function listAbilities(abilities: Ability[]): string {
  return abilities.map((a) => ABILITY_NAMES[a]).join(', ');
}
