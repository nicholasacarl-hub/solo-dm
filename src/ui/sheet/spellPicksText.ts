/**
 * Words for the sheet's spell choices: the Spells tab's banner, the header note, the level-up dialog's lines and the
 * choices form's status. Pure; the numbers come from src/data/options/spellPicks.ts, worked out live.
 */
import { bookCapsText, classSpellRules, owedSpellsSummary, type OpenSpellPicks } from '@/data/options/spellPicks';
import { classSpellLevelCap } from '@/engine';
import { nameKey } from '@/lib/id';
import type { Character, ClassLevel, ClassOption, SpellPicksOwed } from '@/types';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a');

/** "a spell and a cantrip" ("" with no swap open). */
export function replaceableText(entry: Pick<SpellPicksOwed, 'replaceSpell' | 'replaceCantrip'>): string {
  return [...(entry.replaceSpell ? ['a spell'] : []), ...(entry.replaceCantrip ? ['a cantrip'] : [])].join(' and ');
}

/** "choose 1 cantrip and 2 prepared spells; you may also replace a spell", "you may replace a spell and a cantrip" ("" for neither). */
export function picksText(owed: OpenSpellPicks['owed'], entry: Pick<SpellPicksOwed, 'replaceSpell' | 'replaceCantrip'>): string {
  const summary = owedSpellsSummary(owed);
  const swaps = replaceableText(entry);
  if (!summary) return swaps ? `you may replace ${swaps}` : '';
  return `choose ${summary}${swaps ? `; you may also replace ${swaps}` : ''}`;
}

/**
 * A class's open choices in one line, as the Spells tab's banner and the level-up summary say them: "Wizard 4: choose
 * 1 cantrip, 6 spellbook spells and 2 prepared spells", "Bard 12: you may replace a spell and a cantrip".
 */
export function openPicksText(open: Pick<OpenSpellPicks, 'cl' | 'owed' | 'entry'>): string {
  return `${open.cl.name} ${open.cl.level}: ${picksText(open.owed, open.entry) || 'nothing to choose'}`;
}

/** The sheet header's note: "Spells to choose: Wizard 4"; "Spells you may replace: Bard 12" when no class owes any. */
export function picksNoteText(open: readonly Pick<OpenSpellPicks, 'cl' | 'owed'>[]): string {
  const classes = open.map((p) => `${p.cl.name} ${p.cl.level}`).join(', ');
  return open.some((p) => owedSpellsSummary(p.owed)) ? `Spells to choose: ${classes}` : `Spells you may replace: ${classes}`;
}

/**
 * For a hero with more than one class with spell slots, why this class's picks stop at its own level (SRD 5.2.1
 * Multiclassing, Spellcasting: "You determine what spells you can prepare for each class individually, as if you were a
 * single-classed member of that class"): "Cleric spells of level 1 — as a Cleric 1; your other classes' slots don't
 * raise this". Null for one such class.
 */
export function multiclassCapText(c: Character, cl: ClassLevel, maxLevel: number): string | null {
  if (maxLevel < 1 || c.classes.filter((x) => classSpellLevelCap(x) > 0).length < 2) return null;
  const levels = maxLevel === 1 ? 'level 1' : `level 1–${maxLevel}`;
  return `${cl.name} spells of ${levels} — as ${article(cl.name)} ${cl.name} ${cl.level}; your other classes' slots don't raise this`;
}

/**
 * A Bard from level 10 (SRD 5.2.1 Magical Secrets: "you can choose any of your new prepared spells from the Bard,
 * Cleric, Druid, and Wizard spell lists"): the form lists the class's own list only, so it says so. Read from the
 * class's features, so a class without the feature gets no note.
 */
export function magicalSecretsText(cl: ClassLevel, cls: ClassOption): string | null {
  const key = nameKey('Magical Secrets');
  return cls.features.some((f) => f.level <= cl.level && nameKey(f.name) === key)
    ? "Magical Secrets: spells from the Cleric, Druid and Wizard lists aren't listed here; choose those with your DM"
    : null;
}

/** One list of the level's choices, for the form's status line. */
export interface PickSection {
  /** cantrip: "1 cantrip"; book: "2 for your book"; prepare: "2 to prepare" (from a spellbook); prepared: "1 prepared spell". */
  kind: 'cantrip' | 'book' | 'prepare' | 'prepared';
  /** What the class's table still has room for. */
  owed: number;
  picked: number;
  /** A spell given up whose replacement (the list's last pick) is still to choose. */
  giveUp?: string | null;
}

function countText(kind: PickSection['kind'], n: number): string {
  if (kind === 'cantrip') return plural(n, 'cantrip', 'cantrips');
  if (kind === 'book') return `${n} for your book`;
  if (kind === 'prepare') return `${n} to prepare`;
  return plural(n, 'prepared spell', 'prepared spells');
}

/** The level's status: "Still to choose: 1 cantrip, 2 for your book" or "Nothing left to choose". */
export function picksStatus(sections: readonly PickSection[]): string {
  const parts: string[] = [];
  for (const s of sections) {
    const waiting = Boolean(s.giveUp) && s.picked === 0;
    if (waiting) parts.push(`a replacement for ${s.giveUp}`);
    const left = waiting ? s.owed : Math.max(0, s.owed + (s.giveUp ? 1 : 0) - s.picked);
    if (left > 0) parts.push(countText(s.kind, left));
  }
  return parts.length ? `Still to choose: ${parts.join(', ')}` : 'Nothing left to choose';
}

/**
 * A Long Rest change's status: each spell given up waits for its replacement ("Still to choose: 1 replacement"), and
 * nothing given up yet says what comes first.
 */
export function restStatus(parts: readonly { givenUp: number; picked: number }[]): string {
  const given = parts.reduce((n, p) => n + p.givenUp, 0);
  if (!given) return 'Choose what to give up, then its replacement';
  const left = parts.reduce((n, p) => n + Math.max(0, p.givenUp - p.picked), 0);
  return left ? `Still to choose: ${plural(left, 'replacement', 'replacements')}` : 'Nothing left to choose';
}

/** "Clerics", "Paladins": the class's members, for the Long Rest change's copy. */
export function membersOf(className: string): string {
  return /s$/i.test(className) ? className : `${className}s`;
}

/**
 * What the choices form changes for a class after a Long Rest (its own Spellcasting text, classSpellRules): prepared
 * spells (a Cleric's or Druid's, any; a Paladin's or Ranger's, one), only a cantrip (the Wizard's: its prepared spells
 * change with the Spells tab's checkboxes, from its spellbook), or nothing.
 */
export function restChangeKind(cls: ClassOption): 'spells' | 'cantrip' | null {
  const rules = classSpellRules(cls).longRest;
  if (rules.spells !== null && !rules.fromSpellbook) return 'spells';
  return rules.cantrip ? 'cantrip' : null;
}

/** The Spells tab's button for that change: "Change prepared spells" or "Replace a cantrip", the class named beside another's. */
export function restButtonText(kind: 'spells' | 'cantrip', className: string, named: boolean): string {
  if (kind === 'cantrip') return named ? `Replace ${article(className)} ${className} cantrip` : 'Replace a cantrip';
  return named ? `Change ${className} prepared spells` : 'Change prepared spells';
}

/** The choices form's title for that change (prepared spells when the class's data isn't known). */
export function restTitle(kind: 'spells' | 'cantrip' | null): string {
  return kind === 'cantrip' ? 'Replace a cantrip' : 'Change prepared spells';
}

/**
 * The spellbook list's line on the limit of each place still owed (SRD 5.2.1 srd:rule:wizard-spellcasting: "Each of
 * these spells must be of a level for which you have spell slots", as they were at that level): "Each Wizard level adds
 * spells of a level its slots allowed then: 2 up to level 3 and 2 up to level 2." Also when every place shares one limit
 * below the class's highest spell level ("…: 2 of level 1."); "" when the places take any level the list shows.
 */
export function bookCapsNote(className: string, caps: readonly number[], maxLevel: number): string {
  const text = bookCapsText(caps, maxLevel);
  return text ? `Each ${className} level adds spells of a level its slots allowed then: ${text}.` : '';
}
