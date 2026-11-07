/**
 * Limited-use features: work out how many uses a class feature or species trait has and when it
 * recharges, from the class's level table ("Rages", "Second Wind") or the SRD's standard phrasing
 * ("You can use this feature twice", "a number of times equal to your Proficiency Bonus").
 */
import type { Ability, AbilityScores, ClassOption, FeatureUses, RechargeOn } from '@/types';
import { cellNumber, columnKey, levelRow, wordNumber } from './classFeatures';

const ABILITY_WORDS: Record<string, Ability> = {
  strength: 'str',
  dexterity: 'dex',
  constitution: 'con',
  intelligence: 'int',
  wisdom: 'wis',
  charisma: 'cha',
};

/** Level-table columns that count something other than feature uses. */
const NON_USE_COLUMN = /mastery|cantrip|prepared|slot|invocation|proficiency|damage|level|known|die|dice|movement/;

export interface UsesContext {
  level: number;
  proficiencyBonus: number;
  scores: AbilityScores;
  /** The owning class (for level-table columns), if any. */
  cls?: ClassOption;
}

function modifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

/** Recharge from the text. Features that regain only ONE use on a Short Rest are tracked as 'long'. */
export function rechargeFromText(text: string): RechargeOn {
  if (/finish a Short or Long Rest/i.test(text)) return 'short';
  if (/regain all expended uses when you finish a Short Rest/i.test(text)) return 'short';
  if (/Long Rest/i.test(text)) return 'long';
  if (/\bdawn\b/i.test(text)) return 'dawn';
  return 'long';
}

/** A trait that only starts working at a later character level ("Starting at character level 5, …"). */
export function levelGate(text: string): number {
  const match = /^\s*(?:when you reach|starting at) character level (\d+)/i.exec(text);
  return match ? Number(match[1]) : 1;
}

function usesFromTable(name: string, ctx: UsesContext): number | null {
  if (!ctx.cls) return null;
  const row = levelRow(ctx.cls, ctx.level);
  if (!row) return null;
  const featureKey = columnKey(name).replace(/s$/, '');
  for (const [key, value] of Object.entries(row)) {
    const colKey = columnKey(key);
    if (NON_USE_COLUMN.test(colKey) || colKey === 'level') continue;
    const singular = colKey.replace(/s$/, '');
    if (singular !== featureKey) continue;
    const n = cellNumber(value);
    if (n !== null && n > 0) return n;
  }
  return null;
}

function usesFromText(raw: string, ctx: UsesContext): number | null {
  // Ignore the paragraph about spells learned at later levels (Elven Lineage, Fiendish Legacy).
  const text = raw.replace(/When you reach character levels \d+ and \d+[^\n]*(?:\n|$)/i, '');
  const pool = /total number of Hit Points equal to (\w+) times your \w+ level/i.exec(text);
  if (pool) return (wordNumber(pool[1]) ?? 1) * ctx.level;
  const abilityMatch = /a number of times equal to your (\w+) modifier/i.exec(text);
  if (abilityMatch) {
    const ability = ABILITY_WORDS[abilityMatch[1].toLowerCase()];
    if (ability) return Math.max(1, modifier(ctx.scores[ability]));
  }
  if (/a number of times equal to your Proficiency Bonus/i.test(text)) return ctx.proficiencyBonus;
  const times = /(?:use|cast) (?:this feature|this trait|it|the spell) (\w+)(?: times)?(?=[ ,.])/i.exec(text);
  if (times) {
    const n = wordNumber(times[1]);
    if (n !== null && n > 0) return n;
  }
  if (/Once you use this (?:feature|trait)/i.test(text)) return 1;
  if (/cast it once without (?:expending )?a spell slot/i.test(text)) return 1;
  return null;
}

/** Uses for a feature or trait, or undefined when it isn't limited. */
export function inferFeatureUses(name: string, description: string, ctx: UsesContext): FeatureUses | undefined {
  if (levelGate(description) > ctx.level) return undefined;
  const max = usesFromTable(name, ctx) ?? usesFromText(description, ctx);
  if (!max) return undefined;
  return { max, used: 0, recharge: rechargeFromText(description) };
}
