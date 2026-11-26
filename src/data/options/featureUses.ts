/**
 * Limited-use features: work out how many uses a class feature or species trait has, when it
 * recharges and how the number grows as the hero levels (FeatureUses.scale). Sources, in order: a
 * use count in the name ("Action Surge (one use)"), the class table's features column naming the
 * feature with a use count ("Indomitable (two uses)" at 13, for a book's "Indomitable"), the class's
 * level table (the column named like the feature, "Rages", or the one its text points to, "the Focus
 * Points column"), and the SRD's standard phrasing ("You can use this feature twice", "a number of
 * times equal to your Proficiency Bonus", "five times your Paladin level").
 */
import { nameKey } from '@/lib/id';
import type { Ability, AbilityScores, Character, ClassLevel, ClassOption, FeatureScale, FeatureUses, RechargeOn } from '@/types';
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

/** A level-table row's features cell ("Action Surge (one use), Tactical Mind"), or "". */
function featuresCell(row: Record<string, string | number>): string {
  const key = Object.keys(row).find((k) => columnKey(k) === 'features' || columnKey(k) === 'classfeatures');
  const cell = key === undefined ? undefined : row[key];
  return typeof cell === 'string' ? cell : '';
}

/** One entry of a features cell named with a use count: "Indomitable (two uses)", "_Action Surge (2 uses)_". */
const COUNTED_ENTRY = /^(.+?)\s*\((\w+) uses?\)$/i;

/** The use count a features cell gives the feature whose name's key is `want` ("indomitable"), or null. */
function cellCount(cell: string, want: string): number | null {
  for (const part of cell.split(/[,;]/)) {
    const match = COUNTED_ENTRY.exec(part.replace(/[*_`]/g, '').trim());
    const n = match && columnKey(match[1]) === want ? wordNumber(match[2]) : null;
    if (n !== null && n > 0) return n;
  }
  return null;
}

/**
 * A feature named without a count that the class table's features column names with one, as a 2024 book's Fighter
 * reads when the offline parser names its features by their headings ("Action Surge" at 2; the SRD 5.2.1 Fighter
 * Features table's "Action Surge (one use)" at 2 and "Action Surge (two uses)" at 17): the count of the latest such
 * cell at or below the class level, with the table's counts as its scale (0 before it's gained). Null when the table
 * counts it at no level up to the class level: a book whose table counts nothing, a name it doesn't count, Warlock's
 * "(level 6 spell)" or a "(2/rest)" cell.
 */
function usesFromCountedCells(name: string, cls: ClassOption | undefined, classLevel: number): UsesFound | null {
  const want = columnKey(baseFeatureName(name));
  if (!cls || !want) return null;
  const top = Math.max(0, ...cls.levelTable.map((row) => Number(row.level) || 0));
  const values: number[] = [];
  for (let level = 1; level <= top; level++) {
    const row = levelRow(cls, level);
    values.push((row ? cellCount(featuresCell(row), want) : null) ?? values[level - 2] ?? 0);
  }
  const max = values[Math.min(classLevel, values.length) - 1] ?? 0;
  return max > 0 ? { max, scale: { by: 'table', className: cls.name, values } } : null;
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

/** A paragraph that gives the hero a higher-level spell, in the SRD's words (once its line breaks are spaces). */
const LATER_SPELL = /\blearn a higher-level spell/i;

/**
 * The text less a lineage trait's paragraph about the spells it gives at later character levels (SRD 5.2.1
 * srd:species:elf, Elven Lineage: "When you reach character levels 3 and 5, you learn a higher-level spell, as shown on
 * the table. You always have that spell prepared. You can cast it once without a spell slot, and you regain the ability
 * to cast it in that way when you finish a Long Rest."; srd:species:tiefling's Fiendish Legacy alike): each such spell's
 * free casting is its own, counted beside it (spellPicks.ts withLineageCastings), never a use of the trait. Known by
 * "learn a higher-level spell" however a book words the paragraph's opening or wraps its lines; a paragraph runs to a
 * blank line, and the rest of the text stays as it was (Magic Initiate's "Level 1 Spell" is no such paragraph).
 */
function withoutLaterSpells(text: string): string {
  // Split keeping the blank lines (odd places), so the text joins back exactly.
  return text
    .split(/(\n[ \t]*\n)/)
    .map((part, i) => (i % 2 === 0 && LATER_SPELL.test(part.replace(/\s+/g, ' ')) ? '' : part))
    .join('');
}

function usesFromText(raw: string, ctx: UsesContext): UsesFound | null {
  // Ignore the paragraph about spells learned at later levels (Elven Lineage, Fiendish Legacy): however it is worded or
  // wrapped, and, as before, the line that opens "When you reach character levels 3 and 5".
  const text = withoutLaterSpells(raw).replace(/When you reach character levels \d+ and \d+[^\n]*(?:\n|$)/i, '');
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
  const found = usesFromName(name) ?? usesFromCountedCells(name, ctx.cls, ctx.level) ?? usesFromTable(name, description, ctx) ?? usesFromText(description, ctx);
  if (!found) return undefined;
  return { max: found.max, used: 0, recharge: rechargeFromText(description), ...(found.scale ? { scale: found.scale } : {}) };
}

/**
 * For the DM's level_up, which re-reads no uses (the level-up dialog runs refreshFeatureUses): the levelled class's own
 * class features (source name "Fighter 9") named without a count whose base name its table counts by name
 * (usesFromCountedCells: a 2024 book's Fighter as the offline parser names it, made before the app read the counts:
 * "Action Surge" with 2 uses from level 2, "Indomitable" with none), re-read at the class's level with that reader. A
 * ruling (FeatureUses.ruled) stays; spent uses stay, capped at the new maximum; the recharge stays. The same character
 * when nothing changed.
 */
export function refreshTableCountedUses(c: Character, cls: ClassOption, cl: Pick<ClassLevel, 'name' | 'level'>): Character {
  const owners = new Set([nameKey(cl.name), nameKey(cls.name)]);
  let changed = false;
  const features = c.features.map((f) => {
    if (f.source !== 'class' || f.uses?.ruled || usesFromName(f.name)) return f;
    if (!owners.has(nameKey((f.sourceName ?? '').replace(/\s+\d+$/, '')))) return f;
    const found = usesFromCountedCells(f.name, cls, cl.level);
    if (!found?.scale) return f;
    const old = f.uses;
    if (old && old.max === found.max && JSON.stringify(old.scale ?? null) === JSON.stringify(found.scale)) return f;
    changed = true;
    const uses: FeatureUses = old
      ? { ...old, max: found.max, used: Math.min(old.used, found.max), scale: found.scale }
      : { max: found.max, used: 0, recharge: rechargeFromText(f.description), scale: found.scale };
    return { ...f, uses };
  });
  return changed ? { ...c, features } : c;
}
