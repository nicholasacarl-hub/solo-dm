/**
 * Reading class data: level-table columns and level-1 feature choices. The SRD phrases these
 * consistently ("Choose one of the following", "Expertise in two of your skill proficiencies"),
 * so light text matching keeps the builder working for imported classes too.
 */
import { nameKey } from '@/lib/id';
import { textFingerprint } from '@/lib/importedContent';
import { ABILITIES, ABILITY_NAMES, type ClassFeatureDef, type ClassOption, type ImportedRef, type Skill, type SkillBonus, type SubclassOption } from '@/types';
import { runIn } from '../structured/parse/srdRulesOptions';
import { skillFromName } from './species';

/** Lowercase letters and digits only: "Prepared Spells" / "preparedSpells" -> "preparedspells". */
export function columnKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function levelRow(cls: ClassOption, level: number): Record<string, string | number> | undefined {
  return cls.levelTable.find((row) => Number(row.level) === level);
}

/** Parse a level-table cell: 3 / "3" / "+2" -> number; "—" or missing -> null. */
export function cellNumber(value: string | number | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = /^[+]?(-?\d+)$/.exec(value.trim());
  return match ? Number(match[1]) : null;
}

/** The cell of the first column whose key satisfies `test`. */
export function tableCell(
  cls: ClassOption,
  level: number,
  test: (key: string) => boolean,
): string | number | undefined {
  const row = levelRow(cls, level);
  if (!row) return undefined;
  const entry = Object.entries(row).find(([key]) => test(columnKey(key)));
  return entry?.[1];
}

export function cantripsKnown(cls: ClassOption, level = 1): number {
  return cellNumber(tableCell(cls, level, (k) => k.startsWith('cantrip'))) ?? 0;
}

export function preparedSpellCount(cls: ClassOption, level = 1): number {
  return cellNumber(tableCell(cls, level, (k) => k.startsWith('prepared') || k === 'spellsknown')) ?? 0;
}

export function featuresAtLevel(cls: ClassOption, level: number): ClassFeatureDef[] {
  return cls.features.filter((f) => f.level === level);
}

export function subclassFeaturesAtLevel(sub: SubclassOption | undefined, level: number): ClassFeatureDef[] {
  return sub ? sub.features.filter((f) => f.level === level) : [];
}

export function findFeatureDef(cls: ClassOption, name: string, maxLevel = 1): ClassFeatureDef | undefined {
  const key = columnKey(name);
  return cls.features.find((f) => f.level <= maxLevel && columnKey(f.name) === key);
}

/** A feature's name without a trailing "(…)": "Divine Order (Thaumaturge)" -> "Divine Order". */
export function baseFeatureName(name: string): string {
  return name.replace(/\s*\([^()]*\)\s*$/, '').trim() || name.trim();
}

/** Does the class get a Fighting Style feat at level 1 (2024 Fighter)? */
export function needsFightingStyle(cls: ClassOption | undefined): boolean {
  return Boolean(cls && findFeatureDef(cls, 'Fighting Style'));
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  once: 1,
  twice: 2,
};

export function wordNumber(word: string): number | null {
  const n = Number(word);
  if (Number.isFinite(n) && word.trim() !== '') return n;
  return NUMBER_WORDS[word.toLowerCase()] ?? null;
}

/** Number of Expertise picks a class grants at level 1 ("Expertise in two of your skill proficiencies"). */
export function expertiseCount(cls: ClassOption | undefined): number {
  const def = cls && findFeatureDef(cls, 'Expertise');
  if (!def) return 0;
  const match = /Expertise in (\w+) of your skill proficiencies/i.exec(def.description);
  return (match && wordNumber(match[1])) ?? 2;
}

export interface FeatureOption {
  name: string;
  description: string;
}

/** A line that starts with a bold run-in heading: `_**Protector.**_ Trained for battle…`. */
const RUN_IN_HEADING = /^_?\*\*([^*\n]+?)\.\*\*_?\s*(.*)$/;

/** Every bold run-in heading in a description ("Damage Resistance", "Duration"…). */
export function runInHeadings(description: string): string[] {
  return description.split('\n').flatMap((line) => {
    const match = RUN_IN_HEADING.exec(line.trim());
    return match ? [match[1].trim()] : [];
  });
}

/**
 * Options of a "choose one of the following" feature: the bold run-in headings right after that
 * sentence, such as `_**Protector.**_ Trained for battle…`. The sentence has to offer the choice
 * ("…sacred roles of your choice", "Choose one of the following"): Rage's "extend the Rage … by
 * doing one of the following" is a rule, and Rage's bold headings are rules, not options.
 * Returns null for features without a choice.
 */
export function featureChoiceOptions(description: string): FeatureOption[] | null {
  for (const sentence of description.matchAll(/[^.!?\n]*\bone of the following\b[^.!?\n]*[.!?:]?/gi)) {
    if (!/\bchoose\b|\bof your choice\b/i.test(sentence[0])) continue;
    // The options are the block of headed lines after the sentence (skipping the rest of its line).
    const lines = description.slice(sentence.index + sentence[0].length).split('\n').slice(1);
    const options: FeatureOption[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const match = RUN_IN_HEADING.exec(line.trim());
      if (!match) break;
      options.push({ name: match[1].trim(), description: match[2].trim() });
    }
    return options.length >= 2 ? options : null;
  }
  return null;
}

/** Fighting Style features choose from the Fighting Style feats (plus any options they print), not here. */
const isFightingStyle = (def: Pick<ClassFeatureDef, 'name'>) => /^fighting style$/i.test(baseFeatureName(def.name));

/** Level-1 features (other than spellcasting and Fighting Style) that ask the player to pick an option. */
export function classChoiceFeatures(cls: ClassOption | undefined): { feature: ClassFeatureDef; options: FeatureOption[] }[] {
  if (!cls) return [];
  return featuresAtLevel(cls, 1).flatMap((feature) => {
    if (isFightingStyle(feature)) return [];
    const options = featureChoiceOptions(feature.description);
    return options ? [{ feature, options }] : [];
  });
}

/**
 * The fighting styles a Fighting Style feature prints itself (older books list them inside the feature):
 * its bold run-in options, with their text. SRD 5.2.1's Fighter feature points at the Fighting Style
 * feats instead; its Paladin and Ranger features add one option "below" (Blessed Warrior, Druidic
 * Warrior), which counts too.
 */
export function inlineFightingStyles(def: ClassFeatureDef | undefined): FeatureOption[] {
  if (!def || !isFightingStyle(def)) return [];
  const options = def.description.split('\n').flatMap((line) => {
    const found = runIn(line);
    return found ? [{ name: found.label, description: found.rest }] : [];
  });
  const offered = options.length >= 2 || (options.length === 1 && /\boptions? below\b/i.test(def.description));
  return offered ? options : [];
}

/** The id a style the class feature prints goes by (the builder draft and the level-up panel): "inline:<name key>". */
export const inlineStyleId = (name: string): string => `inline:${nameKey(name)}`;

/**
 * The ref of one option a book's class feature prints (an inline fighting style), copied onto a character
 * on its own: the feature's ref narrowed to the option — the option's name as its part, its own paragraph
 * as `at`, the hash of its text — so an export leaves out just that text and restore fills in just that
 * text, never the whole feature with every option (B5). Undefined for an SRD feature (no ref).
 */
export function inlineOptionRef(def: ClassFeatureDef, option: FeatureOption): ImportedRef | undefined {
  if (!def.ref) return undefined;
  const { at: _wholeFeature, ...ref } = def.ref;
  const at = optionParagraph(def, option.name);
  return { ...ref, part: option.name, ...(at ? { at } : {}), textHash: textFingerprint(option.description), textCopied: true };
}

/**
 * Where an option's run-in paragraph sits in the book. The feature's description is its span's paragraphs
 * (a leading heading dropped, so they line up from the end) joined by blank lines.
 */
function optionParagraph(def: ClassFeatureDef, name: string): ImportedRef['at'] {
  const at = def.ref?.at;
  if (!at) return undefined;
  const paragraphs = def.description.split(/\n{2,}/);
  const index = paragraphs.findIndex((p) => nameKey(runIn(p.split('\n')[0])?.label ?? '') === nameKey(name));
  const paragraph = at.to - (paragraphs.length - 1 - index);
  return index >= 0 && paragraph >= at.from ? { ordinals: [...at.ordinals], from: paragraph, to: paragraph } : undefined;
}

export interface OptionGrants {
  weapons: string[];
  armor: string[];
  extraCantrips: number;
  /** A bonus to some skill checks (Thaumaturge, Magician); the caller names its source. */
  skillBonus: Omit<SkillBonus, 'source'> | null;
}

/** What a chosen feature option grants mechanically (Protector, Warden, Thaumaturge, Magician...). */
export function optionGrants(text: string): OptionGrants {
  const weapons: string[] = [];
  const armor: string[] = [];
  if (/proficiency with Martial weapons/i.test(text)) weapons.push('Martial weapons');
  const armorMatch = /training with (Light|Medium|Heavy) armor/i.exec(text);
  if (armorMatch) armor.push(`${capitalize(armorMatch[1])} armor`);
  const cantrip = /know (\w+) extra cantrips?/i.exec(text);
  const extraCantrips = cantrip ? (wordNumber(cantrip[1]) ?? 1) : 0;
  return { weapons, armor, extraCantrips, skillBonus: skillCheckBonus(text) };
}

/**
 * "…a bonus to your Intelligence (Arcana or Religion) checks. The bonus equals your Wisdom modifier
 * (minimum of +1)" -> Arcana and Religion get WIS (min +1). Null when the text grants no such bonus.
 */
export function skillCheckBonus(text: string): Omit<SkillBonus, 'source'> | null {
  const match = /bonus to your \w+ \(([^)]+)\) checks\.?\s*The bonus equals your (\w+) modifier(?: \(minimum(?: bonus)? of \+?(\d+)\))?/i.exec(text);
  if (!match) return null;
  const skills = match[1]
    .split(/\s*(?:,|\bor\b|\band\b)\s*/)
    .map(skillFromName)
    .filter((s): s is Skill => Boolean(s));
  const ability = ABILITIES.find((a) => ABILITY_NAMES[a].toLowerCase() === match[2].toLowerCase());
  if (!skills.length || !ability) return null;
  return { skills, ability, ...(match[3] ? { minimum: Number(match[3]) } : {}) };
}

/** Languages a class grants at level 1 (Thieves' Cant, Druidic) and extra language picks. */
export function classLanguages(cls: ClassOption | undefined): { fixed: string[]; extraChoices: number } {
  const fixed: string[] = [];
  let extraChoices = 0;
  if (!cls) return { fixed, extraChoices };
  for (const def of featuresAtLevel(cls, 1)) {
    const key = columnKey(def.name);
    if (key === 'thievescant') fixed.push("Thieves' Cant");
    if (key === 'druidic') fixed.push('Druidic');
    if (/one other language of your choice/i.test(def.description)) extraChoices += 1;
  }
  return { fixed, extraChoices };
}

/** Spells a feature says you "always have prepared" (e.g. Favored Enemy -> Hunter's Mark). */
export function alwaysPreparedSpellNames(description: string): string[] {
  const names: string[] = [];
  for (const match of description.matchAll(/always have (?:the )?_?([A-Z][\w' /-]+?)_? spell prepared/g)) {
    names.push(match[1].trim());
  }
  return names;
}

/** Weapon Mastery limited to melee weapons (2024 Barbarian)? */
export function masteryMeleeOnly(cls: ClassOption | undefined): boolean {
  const def = cls && findFeatureDef(cls, 'Weapon Mastery');
  return Boolean(def && /Melee weapons/i.test(def.description));
}

/** Spell names a feature recommends ("_Light_, _Mage Hand_, and _Ray of Frost_ are recommended"). */
export function recommendedNames(description: string): string[][] {
  const groups: string[][] = [];
  for (const sentence of description.split(/(?<=\.)\s+/)) {
    if (!/recommended/i.test(sentence)) continue;
    const names = [...sentence.matchAll(/_([^_]+)_/g)].map((m) => m[1].trim());
    if (names.length) groups.push(names);
  }
  return groups;
}

/** Wizard-style spellbook size at level 1 ("It starts with six level 1 Wizard spells"). */
export function spellbookSize(cls: ClassOption | undefined): number {
  if (!cls) return 0;
  for (const def of featuresAtLevel(cls, 1)) {
    const match = /starts with (\w+) level 1 \w+ spells/i.exec(def.description);
    if (match) return wordNumber(match[1]) ?? 0;
  }
  return 0;
}

/** Martial Arts die for unarmed strikes at level 1 (Monk), e.g. "1d6". */
export function martialArtsDie(cls: ClassOption | undefined): string | null {
  if (!cls || !findFeatureDef(cls, 'Martial Arts')) return null;
  const cell = tableCell(cls, 1, (k) => k.startsWith('martialarts'));
  if (typeof cell === 'string' && /^\d*d\d+$/i.test(cell.trim())) return cell.trim().replace(/^d/i, '1d');
  return '1d6';
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}
