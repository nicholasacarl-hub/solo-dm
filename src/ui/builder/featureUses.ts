/**
 * Limited-use features: work out how many uses a class feature or species trait has, when it
 * recharges and how the number grows as the hero levels (FeatureUses.scale). Sources, in order: a
 * use count in the name ("Action Surge (one use)"), the class's level table (the column named like
 * the feature, "Rages", or the one its text points to, "the Focus Points column"), and the SRD's
 * standard phrasing ("You can use this feature twice", "a number of times equal to your
 * Proficiency Bonus", "five times your Paladin level").
 */
import type { Ability, AbilityScores, ClassOption, FeatureScale, FeatureUses, RechargeOn } from '@/types';
import { baseFeatureName, cellNumber, columnKey, levelRow, wordNumber } from './classFeatures';

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
  /** Class level for class and subclass features; character level for species traits and feats. */
  level: number;
  proficiencyBonus: number;
  scores: AbilityScores;
  /** The owning class (for level-table columns), if any. */
  cls?: ClassOption;
}

interface UsesFound {
  max: number;
  scale?: FeatureScale;
}

function modifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

const singular = (key: string) => key.replace(/s$/, '');

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

/** "Action Surge (one use)", "Indomitable (three uses)": the SRD names some features by their uses. */
function usesFromName(name: string): UsesFound | null {
  const match = /\((\w+) uses?\)\s*$/i.exec(name);
  const n = match ? wordNumber(match[1]) : null;
  return n !== null && n > 0 ? { max: n } : null;
}

/** Columns a feature's text points to: "…as shown in the Focus Points column of the Monk Features table". */
function namedColumns(text: string): string[] {
  return [...text.matchAll(/\bthe ([A-Z][A-Za-z' ]*?) column\b/g)].map((m) => columnKey(m[1]));
}

/** A level-table column as numbers, index 0 = class level 1 ("—" before the feature is gained = 0). */
function columnValues(cls: ClassOption, key: string): number[] {
  const top = Math.max(0, ...cls.levelTable.map((row) => Number(row.level) || 0));
  const values: number[] = [];
  for (let level = 1; level <= top; level++) values.push(cellNumber(levelRow(cls, level)?.[key]) ?? values[level - 2] ?? 0);
  return values;
}

function usesFromTable(name: string, description: string, ctx: UsesContext): UsesFound | null {
  const cls = ctx.cls;
  const row = cls && levelRow(cls, ctx.level);
  if (!cls || !row) return null;
  // "Rage (Duration)" (named by an older builder) still reads the Rages column.
  const wanted = [columnKey(baseFeatureName(name)), ...namedColumns(description)].map(singular);
  for (const want of wanted) {
    const key = Object.keys(row).find((k) => !NON_USE_COLUMN.test(columnKey(k)) && singular(columnKey(k)) === want);
    const max = key === undefined ? null : cellNumber(row[key]);
    if (key === undefined || max === null || max <= 0) continue;
    return { max, scale: { by: 'table', className: cls.name, values: columnValues(cls, key) } };
  }
  return null;
}

function usesFromText(raw: string, ctx: UsesContext): UsesFound | null {
  // Ignore the paragraph about spells learned at later levels (Elven Lineage, Fiendish Legacy).
  const text = raw.replace(/When you reach character levels \d+ and \d+[^\n]*(?:\n|$)/i, '');
  const pool = /total number of Hit Points equal to (\w+) times your (\w+) level/i.exec(text);
  if (pool) {
    const multiplier = wordNumber(pool[1]) ?? 1;
    return { max: multiplier * ctx.level, scale: { by: 'class-level', className: ctx.cls?.name ?? pool[2], multiplier } };
  }
  const abilityMatch = /a number of times equal to your (\w+) modifier/i.exec(text);
  if (abilityMatch) {
    const ability = ABILITY_WORDS[abilityMatch[1].toLowerCase()];
    // Grows with the ability score rather than the level, so there is no scale.
    if (ability) return { max: Math.max(1, modifier(ctx.scores[ability])) };
  }
  if (/a number of times equal to your Proficiency Bonus/i.test(text)) return { max: ctx.proficiencyBonus, scale: { by: 'proficiency-bonus' } };
  const times = /(?:use|cast) (?:this feature|this trait|it|the spell) (\w+)(?: times)?(?=[ ,.])/i.exec(text);
  if (times) {
    const n = wordNumber(times[1]);
    if (n !== null && n > 0) return { max: n };
  }
  if (/Once you use this (?:feature|trait)/i.test(text)) return { max: 1 };
  if (/cast it once without (?:expending )?a spell slot/i.test(text)) return { max: 1 };
  return null;
}

/** Uses for a feature or trait (with how they scale, when they do), or undefined when it isn't limited. */
export function inferFeatureUses(name: string, description: string, ctx: UsesContext): FeatureUses | undefined {
  if (levelGate(description) > ctx.level) return undefined;
  const found = usesFromName(name) ?? usesFromTable(name, description, ctx) ?? usesFromText(description, ctx);
  if (!found) return undefined;
  return { max: found.max, used: 0, recharge: rechargeFromText(description), ...(found.scale ? { scale: found.scale } : {}) };
}
