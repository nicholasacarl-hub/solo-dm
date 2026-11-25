/**
 * Spell picks at a level-up, and the swaps a class's rules allow (SRD 5.2.1, each class's Spellcasting or Pact Magic,
 * srd:rule:gaining-spells, srd:rule:multiclassing-class-features-spellcasting).
 *
 * What a class is owed is never stored: it is worked out whenever it is read, from the class table and the sheet, the
 * SRD's own way ("Whenever that number increases, choose additional spells … until the number of spells on your list
 * matches the number on the table"). The sheet keeps only a mark that a level was gained (Spellcasting.spellPicks),
 * with that level's swaps, so deferring, a second level, a spell the DM adds or a prepared checkbox never makes the
 * count wrong. "The class's spells" are the sheet spells whose source is the class's name and that aren't always
 * prepared, as the builder writes them ("a spell that you always have prepared doesn't count against the number of
 * spells on that list"), of a level the class has slots for (a Warlock's Mystic Arcanum recorded under "Warlock" isn't
 * one of its prepared spells). A spellbook also holds the spells its levels added that another feature now keeps always
 * prepared (the book still contains them), and extras written "Wizard (copied)": spells copied into it or added free,
 * on top of the two each level adds, so they count only as prepared spells.
 */
import { addSpell, classSpellLevelCap, spellReviewReminder } from '@/engine';
import { nameKey } from '@/lib/id';
import type { Character, ClassLevel, ClassOption, CompendiumEntry, KnownSpell, SpellPicksOwed, SubclassOption } from '@/types';
import {
  alwaysPreparedSpellNames,
  baseFeatureName,
  cantripsKnown,
  columnKey,
  featureChoiceOptions,
  featuresAtLevel,
  optionGrants,
  preparedSpellCount,
  spellbookSize,
  wordNumber,
} from './classFeatures';
import { knownSpellFromEntry } from './levelUpChoices';
import { classOptionFor } from './resolve';

// ---------------------------------------------------------------------------
// The class's rules, from its own level-1 Spellcasting / Pact Magic text
// ---------------------------------------------------------------------------

export interface ClassSpellRules {
  /** On gaining a level of the class: replace one spell on its list / one of its cantrips. */
  levelGain: { spell: boolean; cantrip: boolean };
  /** After a Long Rest: change any prepared spells, or replace one; the Wizard's come from its spellbook. */
  longRest: { spells: 'any' | 'one' | null; fromSpellbook: boolean; cantrip: boolean };
  /** A spellbook: its size at the class's level 1 and the spells added each level after 1 (start 0: none). */
  spellbook: { start: number; perLevel: number };
}

const LEVEL_GAIN_SPELL = /Whenever you gain an? [\w' -]+? level, you can replace one spell on your list/i;
const LEVEL_GAIN_CANTRIP = /Whenever you gain an? [\w' -]+? level, you can replace one of your cantrips/i;
const REST_ANY = /Whenever you finish a Long Rest, you can change your list of prepared spells, replacing any/i;
const REST_FROM_BOOK = /Whenever you finish a Long Rest, you can change your list of prepared spells, replacing any of the spells there with spells from your spellbook/i;
const REST_ONE = /Whenever you finish a Long Rest, you can replace one spell on your list/i;
const REST_CANTRIP = /Whenever you finish a Long Rest, you can replace one of your cantrips/i;
const BOOK_PER_LEVEL = /Whenever you gain an? [\w' -]+? level after 1, add (\w+) [\w' -]+? spells? of your choice to your spellbook/i;

/**
 * The swaps and spellbook the class's own level-1 text grants. The SRD and the 2024 books phrase them alike ("Whenever
 * you gain a Bard level, you can replace one spell on your list…", "Whenever you finish a Long Rest, you can change your
 * list of prepared spells, replacing any…"); a class without these sentences gets none, and the DM decides.
 */
export function classSpellRules(cls: ClassOption): ClassSpellRules {
  const text = featuresAtLevel(cls, 1)
    .map((d) => d.description)
    .join('\n');
  const start = spellbookSize(cls);
  const perLevel = start > 0 ? (wordNumber(BOOK_PER_LEVEL.exec(text)?.[1] ?? '') ?? 0) : 0;
  return {
    levelGain: { spell: LEVEL_GAIN_SPELL.test(text), cantrip: LEVEL_GAIN_CANTRIP.test(text) },
    longRest: { spells: REST_ANY.test(text) ? 'any' : REST_ONE.test(text) ? 'one' : null, fromSpellbook: REST_FROM_BOOK.test(text), cantrip: REST_CANTRIP.test(text) },
    spellbook: { start, perLevel },
  };
}

// ---------------------------------------------------------------------------
// What a class holds and is owed, live
// ---------------------------------------------------------------------------

/** The class's own spells on the sheet: its name as their source, and not always prepared (they don't count). */
export function classSpellsOf(c: Character, className: string): KnownSpell[] {
  const key = nameKey(className);
  return (c.spellcasting?.spells ?? []).filter((s) => !s.alwaysPrepared && nameKey(s.source ?? '') === key);
}

/** "Wizard (copied)" → the key of "Wizard": the class a spellbook extra's source names; null for any other source. */
function extraClassKey(source: string | undefined): string | null {
  const m = /^\s*(.+?)\s*\(([^()]+)\)\s*$/.exec(source ?? '');
  return m ? nameKey(m[1]) : null;
}

/**
 * A spellbook's level 1+ spells that count against its prepared list when prepared: the spells its levels added (its
 * name as their source) and its extras ("Wizard (copied)", "Wizard (Evocation Savant)": copied in or added free, SRD
 * 5.2.1 srd:rule:wizard-spellcasting "Copying a Spell into the Book"), never one always prepared.
 */
export function bookSpellsOf(c: Character, className: string): KnownSpell[] {
  const key = nameKey(className);
  return (c.spellcasting?.spells ?? []).filter((s) => !s.alwaysPrepared && s.level >= 1 && (nameKey(s.source ?? '') === key || extraClassKey(s.source) === key));
}

/** Whether a sheet spell's source puts it in this class's spellbook (its name, or an extra's "Wizard (copied)"). */
function inBookOf(spell: Pick<KnownSpell, 'source'>, className: string): boolean {
  const key = nameKey(className);
  return nameKey(spell.source ?? '') === key || extraClassKey(spell.source) === key;
}

/**
 * Whether a spell re-added with its class's own name as the source keeps the spellbook extra's source it has ("Wizard
 * (copied)" re-added as "Wizard" to prepare it): a spell copied into the book or added free stays outside the two each
 * level adds (srd:rule:wizard-spellcasting), so only removing it and adding it again makes it one of those. Only for a
 * class of the hero's whose data (`classes`) gives it a spellbook.
 */
export function keepsBookExtra(c: Character, held: string | undefined, given: string, classes: readonly ClassOption[]): boolean {
  const key = extraClassKey(held);
  if (key === null || nameKey(given) !== key) return false;
  const cl = c.classes.find((x) => nameKey(x.name) === key);
  const option = cl ? classOptionFor(cl, classes) : undefined;
  return option ? classSpellRules(option).spellbook.start > 0 : false;
}

/**
 * For the DM, after spells_add: the spells it gave its class's own name that kept a spellbook extra's source instead
 * (keepsBookExtra), so the call's source wasn't applied. Each line says so, and how to make one of them one of a level's
 * two: remove it and add it again.
 */
export function keptBookExtraLines(given: readonly { name: string; source?: string }[], after: Character): string[] {
  const groups: { source: string; className: string; names: string[] }[] = [];
  for (const spell of given) {
    if (spell.source === undefined) continue;
    const now = after.spellcasting?.spells.find((s) => nameKey(s.name) === nameKey(spell.name));
    const source = now?.source;
    const key = extraClassKey(source);
    if (!now || !source || key === null || key !== nameKey(spell.source)) continue;
    const group = groups.find((g) => nameKey(g.source) === nameKey(source));
    if (group) {
      if (!group.names.includes(now.name)) group.names.push(now.name);
    } else {
      groups.push({ source, className: after.classes.find((cl) => nameKey(cl.name) === key)?.name ?? spell.source.trim(), names: [now.name] });
    }
  }
  return groups.map(({ source, className, names }) => {
    const one = names.length === 1;
    return `${andList(names)} ${one ? 'keeps its' : 'keep their'} source "${source}": a spell copied into the spellbook, or added to it free, stays outside the two each ${className} level adds. If ${one ? 'it is' : 'one of them is'} one of those two, spells_remove it and spells_add it again with source "${className}".`;
  });
}

export interface SpellCount {
  /** What the class's table (and its chosen options) say the class holds at its level. */
  target: number;
  /** What the sheet holds for the class. */
  held: number;
  /** max(0, target − held): the most the player may still choose. */
  owed: number;
}

export interface OwedSpells {
  className: string;
  level: number;
  /** The highest spell level the class's picks may be: its own slots, or a Warlock's Slot Level (0: cantrips only). */
  maxLevel: number;
  /** Cantrips; null for a class whose table has no Cantrips column (Paladin, Ranger). */
  cantrips: SpellCount | null;
  /** Prepared level 1+ spells (a Wizard prepares them from its spellbook). */
  prepared: SpellCount;
  /**
   * The level 1+ spells a spellbook's levels added (prepared or not, always prepared too: the book still holds them;
   * not its extras, "Wizard (copied)", which come on top); null without one.
   */
  spellbook: SpellCount | null;
  /**
   * The highest spell level of each spellbook spell still owed, highest first: each level's additions are of a level its
   * slots reached then (bookPickCaps). Empty without a book or nothing owed.
   */
  bookCaps: number[];
  rules: ClassSpellRules;
}

function hasColumn(cls: ClassOption, test: (key: string) => boolean): boolean {
  return cls.levelTable.some((row) => Object.keys(row).some((k) => test(columnKey(k))));
}

const isCantripColumn = (k: string) => k.startsWith('cantrip');
const isPreparedColumn = (k: string) => k.startsWith('prepared') || k === 'spellsknown';

/** "Divine Order (Thaumaturge)" -> "Thaumaturge". */
function chosenOptionName(featureName: string): string | null {
  return /\(([^()]+)\)\s*$/.exec(featureName)?.[1].trim() ?? null;
}

/**
 * Extra cantrips from the class options chosen on the sheet, outside the table: SRD 5.2.1 Divine Order (Thaumaturge)
 * and Primal Order (Magician), "You know one extra cantrip from the Cleric spell list." The option is read from the
 * sheet feature's name, as the builder and level-up write it ("Divine Order (Thaumaturge)").
 */
function optionCantrips(c: Character, cl: ClassLevel, cls: ClassOption): number {
  let extra = 0;
  for (const def of cls.features) {
    if (def.level > cl.level) continue;
    const options = featureChoiceOptions(def.description);
    if (!options) continue;
    const feature = c.features.find((f) => f.source === 'class' && nameKey(baseFeatureName(f.name)) === nameKey(def.name) && chosenOptionName(f.name));
    const chosen = feature ? chosenOptionName(feature.name) : null;
    const option = chosen ? options.find((o) => nameKey(o.name) === nameKey(chosen)) : undefined;
    if (option) extra += optionGrants(option.description).extraCantrips;
  }
  return extra;
}

const count = (target: number, held: number): SpellCount => ({ target, held, owed: Math.max(0, target - held) });

/**
 * The highest spell level of each spellbook spell still owed, highest first (SRD 5.2.1 srd:rule:wizard-spellcasting:
 * "Whenever you gain a Wizard level after 1, add two Wizard spells of your choice to your spellbook. Each of these spells
 * must be of a level for which you have spell slots"): the starting book's places are of the class's level 1, each later
 * level's of a level its own slots reached at that level. The book's spells (`held`, their levels) take the lowest places
 * they fit, highest level first, so a choice put off across a level, part made, or an older hero's catch-up keeps each
 * level's own limit; a spell that fits no place (the DM's) still takes one, the lowest.
 */
function bookPickCaps(cl: ClassLevel, rules: ClassSpellRules, held: readonly number[], owed: number): number[] {
  if (owed <= 0 || rules.spellbook.start <= 0) return [];
  const at = (level: number) => classSpellLevelCap({ ...cl, level });
  const places: number[] = Array.from({ length: rules.spellbook.start }, () => at(1));
  for (let level = 2; level <= cl.level; level++) for (let i = 0; i < rules.spellbook.perLevel; i++) places.push(at(level));
  places.sort((a, b) => a - b);
  for (const level of [...held].sort((a, b) => b - a)) {
    const i = places.findIndex((cap) => cap >= level);
    if (i >= 0) places.splice(i, 1);
  }
  return places.sort((a, b) => b - a).slice(0, owed);
}

/**
 * What the class holds at its level, what the sheet holds for it and what the player may still choose; null when its
 * table has neither a Cantrips nor a Prepared Spells column (a Fighter, a third caster from a book, a book class
 * without the columns): the caller can't tell, so it keeps the engine's generic reminder. A level 1+ spell above the
 * class's own spell level isn't on its list ("The chosen spells must be of a level for which you have spell slots"), so
 * it counts nowhere.
 */
export function owedSpells(c: Character, cl: ClassLevel, cls: ClassOption): OwedSpells | null {
  if (!hasColumn(cls, isCantripColumn) && !hasColumn(cls, isPreparedColumn)) return null;
  const rules = classSpellRules(cls);
  const maxLevel = classSpellLevelCap(cl);
  const inList = (s: KnownSpell) => s.level >= 1 && s.level <= maxLevel;
  const own = classSpellsOf(c, cl.name);
  const hasBook = rules.spellbook.start > 0;
  // A spellbook's prepared spells may be its extras too; the spells its levels added include those now always prepared.
  const listed = (hasBook ? bookSpellsOf(c, cl.name) : own).filter(inList);
  const key = nameKey(cl.name);
  const added = hasBook ? (c.spellcasting?.spells ?? []).filter((s) => inList(s) && nameKey(s.source ?? '') === key) : [];
  const level = cl.level;
  const spellbook = hasBook ? count(rules.spellbook.start + rules.spellbook.perLevel * (level - 1), added.length) : null;
  return {
    className: cl.name,
    level,
    maxLevel,
    cantrips: hasColumn(cls, isCantripColumn) ? count(cantripsKnown(cls, level) + optionCantrips(c, cl, cls), own.filter((s) => s.level === 0).length) : null,
    prepared: count(preparedSpellCount(cls, level), listed.filter((s) => s.prepared).length),
    spellbook,
    bookCaps: bookPickCaps(
      cl,
      rules,
      added.map((s) => s.level),
      spellbook?.owed ?? 0,
    ),
    rules,
  };
}

/**
 * Whether these new spellbook spells (their levels) fit the places still owed, each no higher than its place's limit:
 * the highest pick takes the highest place (`caps` run highest first).
 */
export function fitsBookCaps(levels: readonly number[], caps: readonly number[]): boolean {
  if (levels.length > caps.length) return false;
  return [...levels].sort((a, b) => b - a).every((level, i) => level <= caps[i]);
}

/**
 * Why a spellbook spell of this level can't join these picks (null when it can, or the list is simply full): "Only 2 may
 * be of level 3 here; the others are for earlier levels."
 */
export function bookCapBlock(level: number, picked: readonly number[], caps: readonly number[]): string | null {
  if (picked.length >= caps.length || fitsBookCaps([...picked, level], caps)) return null;
  const room = caps.filter((cap) => cap >= level).length;
  if (room === 0) return `Your book's places still open are of level ${Math.max(0, ...caps) || 1} or lower.`;
  return `Only ${room} may be of level ${level}${level < (caps[0] ?? level) ? ' or higher' : ''} here; the others are for earlier levels.`;
}

/**
 * "2 up to level 3 and 2 up to level 2" for the owed book places. Places that share one limit say it ("1 up to level 2",
 * "2 of level 1") only when it is below the class's highest spell level (`maxLevel`); "" when they take any level it has.
 */
export function bookCapsText(caps: readonly number[], maxLevel: number): string {
  if (!caps.length || (new Set(caps).size < 2 && caps[0] >= maxLevel)) return '';
  const groups: [number, number][] = [];
  for (const cap of caps) {
    const last = groups[groups.length - 1];
    if (last && last[0] === cap) last[1] += 1;
    else groups.push([cap, 1]);
  }
  return andList(groups.map(([cap, n]) => (cap <= 1 ? `${n} of level 1` : `${n} up to level ${cap}`)));
}

/** The spells still to choose, summed. */
export function owedTotal(o: OwedSpells): number {
  return (o.cantrips?.owed ?? 0) + o.prepared.owed + (o.spellbook?.owed ?? 0);
}

// ---------------------------------------------------------------------------
// The mark on the sheet
// ---------------------------------------------------------------------------

function withSpellPicks(c: Character, list: readonly SpellPicksOwed[]): Character {
  const sc = c.spellcasting;
  if (!sc) return c;
  const { spellPicks: _old, ...rest } = sc;
  return { ...c, spellcasting: list.length ? { ...rest, spellPicks: [...list] } : rest };
}

/**
 * The spells a level's swap may give up (SRD 5.2.1, e.g. srd:rule:sorcerer-spellcasting: "replace one spell on your list
 * with another Sorcerer spell"): the class's own prepared spells of a level it has slots for. An unprepared one isn't on
 * the list, so giving it up would free no place.
 */
export function swappableSpells(c: Character, className: string, maxLevel: number): KnownSpell[] {
  return classSpellsOf(c, className).filter((s) => s.level >= 1 && s.level <= maxLevel && s.prepared);
}

/**
 * Mark the class's choices open after it gained a level (call it on the levelled character, after the always-prepared
 * spells, so the places they free are counted): one entry per class, the newest level's, carrying that level's swaps
 * (not at the class's level 1, which has nothing to replace, nor without a spell of that kind to give up). The entry is
 * dropped when nothing is owed and no swap is open. The same character comes back when the class can't be counted.
 */
export function spellPicksAfterLevel(c: Character, cl: ClassLevel, cls: ClassOption): Character {
  if (!c.spellcasting) return c;
  const owed = owedSpells(c, cl, cls);
  if (!owed) return c;
  const own = classSpellsOf(c, cl.name);
  const replaceSpell = cl.level > 1 && owed.rules.levelGain.spell && swappableSpells(c, cl.name, owed.maxLevel).length > 0;
  const replaceCantrip = cl.level > 1 && owed.rules.levelGain.cantrip && own.some((s) => s.level === 0);
  const entry: SpellPicksOwed = { classId: cl.classId, ...(replaceSpell ? { replaceSpell: true } : {}), ...(replaceCantrip ? { replaceCantrip: true } : {}) };
  const others = (c.spellcasting.spellPicks ?? []).filter((p) => p.classId !== cl.classId);
  const open = owedTotal(owed) > 0 || replaceSpell || replaceCantrip;
  const list = open ? [...others, entry] : others;
  const before = c.spellcasting.spellPicks ?? [];
  if (list.length === before.length && list.every((p, i) => JSON.stringify(p) === JSON.stringify(before[i]))) return c;
  return withSpellPicks(c, list);
}

/** Close the class's choices (made, skipped, or settled elsewhere). */
export function closeSpellPicks(c: Character, classId: string): Character {
  const list = c.spellcasting?.spellPicks ?? [];
  return list.some((p) => p.classId === classId) ? withSpellPicks(c, list.filter((p) => p.classId !== classId)) : c;
}

/** The class's entry in the open choices, kept but without the level's swaps (they lapse with the level's choices). */
export function withoutSwaps(c: Character, classId: string): Character {
  const list = c.spellcasting?.spellPicks ?? [];
  const had = list.find((p) => p.classId === classId);
  if (!had || (!had.replaceSpell && !had.replaceCantrip)) return c;
  return withSpellPicks(c, list.map((p) => (p.classId === classId ? { classId } : p)));
}

/** A class's spells as a comparable list: its own, its spellbook's extras, always prepared or not. */
function classSpellsKey(c: Character, className: string): string {
  const mine = (c.spellcasting?.spells ?? []).filter((s) => inBookOf(s, className));
  return JSON.stringify(mine.map((s) => [s.id, nameKey(s.name), s.level, Boolean(s.prepared), Boolean(s.alwaysPrepared), s.source ?? '']).sort());
}

export interface SettledPicks {
  className: string;
  level: number;
  /** What the class may still choose after the change (its choices stay open), or null when they closed. */
  owed: OwedSpells | null;
}

/**
 * The DM recorded spells for classes whose choices are open (update_character spells_add / spells_remove, as the
 * level_up result tells it): those are the level's choices, as on the sheet's form. A class whose own spells the change
 * touched closes once nothing is owed; otherwise it stays open without the level's swaps, which lapse with the choices
 * (SRD 5.2.1, e.g. srd:rule:sorcerer-spellcasting: one spell replaced per level gained). Classes whose spells it didn't
 * touch keep their entries as they are.
 */
export function settleSpellPicks(before: Character, after: Character, classes: readonly ClassOption[]): { character: Character; settled: SettledPicks[] } {
  let next = after;
  const settled: SettledPicks[] = [];
  for (const entry of after.spellcasting?.spellPicks ?? []) {
    const cl = after.classes.find((x) => x.classId === entry.classId);
    const cls = cl && classOptionFor(cl, classes);
    if (!cl || !cls || classSpellsKey(before, cl.name) === classSpellsKey(after, cl.name)) continue;
    const owed = owedSpells(next, cl, cls);
    if (!owed) continue;
    const open = owedTotal(owed) > 0;
    next = open ? withoutSwaps(next, cl.classId) : closeSpellPicks(next, cl.classId);
    settled.push({ className: cl.name, level: cl.level, owed: open ? owed : null });
  }
  return { character: next, settled };
}

export interface OpenSpellPicks {
  entry: SpellPicksOwed;
  cl: ClassLevel;
  cls: ClassOption;
  owed: OwedSpells;
}

/**
 * The classes whose choices are open and still hold something to choose or a swap to make, with what is owed now; an
 * entry whose class is gone, whose data isn't on this device or that the sheet has since settled is left out.
 */
export function openSpellPicks(c: Character, classes: readonly ClassOption[]): OpenSpellPicks[] {
  const out: OpenSpellPicks[] = [];
  for (const entry of c.spellcasting?.spellPicks ?? []) {
    if (typeof entry?.classId !== 'string') continue;
    const cl = c.classes.find((x) => x.classId === entry.classId);
    const cls = cl && classOptionFor(cl, classes);
    const owed = cl && cls ? owedSpells(c, cl, cls) : null;
    if (!cl || !cls || !owed) continue;
    if (owedTotal(owed) > 0 || entry.replaceSpell === true || entry.replaceCantrip === true) out.push({ entry, cl, cls, owed });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Always-prepared spells: added, or an ordinary pick turned always prepared
// ---------------------------------------------------------------------------

/** A spell the sheet holds as an ordinary level 1+ spell, now always prepared. */
export interface TurnedSpell {
  id: string;
  name: string;
  /** The feature or subclass that keeps it prepared now. */
  source: string;
  /** The hero's class whose list it leaves (its source named it), if any: a DM's grant has none. */
  owner?: string;
  /** It stays in that class's spellbook, whose count still holds it (its source is kept): a Wizard's book spell. */
  inBook?: boolean;
  /** It was prepared, at a level that class has slots for, so it counted against that class's prepared spells: its place there is free now. */
  counted?: boolean;
}

export interface AlwaysPreparedGain {
  /** New sheet spells, always prepared, with the feature or subclass as their source. */
  add: KnownSpell[];
  /** Spells the sheet already holds as ordinary level 1+ spells, now always prepared with that source. */
  flip: TurnedSpell[];
  /** Spells the rules index doesn't have (a book's spell not accepted yet), with the feature or subclass granting them: the DM adds them. */
  missing: { name: string; source: string }[];
}

/** An SRD subclass's spell table: "When you reach a Cleric level specified in the … table, you thereafter always have the listed spells prepared." */
const SPELL_TABLE = /thereafter always have the listed spells prepared/i;

/** "| 3 | _Aid_, _Bless_ |" rows of a subclass's spell table: the class level and the spell names. */
function spellTableRows(text: string): { level: number; spells: string[] }[] {
  const rows: { level: number; spells: string[] }[] = [];
  for (const line of text.split('\n')) {
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
    const level = /^(\d{1,2})(?:st|nd|rd|th)?$/i.exec(cells[0] ?? '');
    if (!level || cells.length < 2) continue;
    const spells = [...cells.slice(1).join(' ').matchAll(/_([^_]+)_/g)].map((m) => m[1].trim());
    if (spells.length) rows.push({ level: Number(level[1]), spells });
  }
  return rows;
}

/**
 * The always-prepared spells the class and its subclass grant up to `classLevel`: a class feature's "always have the _X_
 * spell prepared" (Divine Smite at Paladin 2, Find Steed at 5, Contact Other Plane at Warlock 9, Power Word Heal and
 * Power Word Kill at Bard 20); an SRD subclass's spell table (Life Domain, Oath of Devotion, Draconic Sorcery, Fiend
 * Patron; never Circle of the Land, whose spells change with each rest); a book subclass's rows. Rows below the level
 * are read too, so a subclass chosen late and an older hero catch up. A name the sheet lacks is added; one it holds as an
 * ordinary level 1+ spell is turned always prepared (it stops counting against the class's list, SRD 5.2.1
 * srd:rule:gaining-spells); one already always prepared stays as it is. A turned spell names the hero's class whose list
 * it leaves, and whether it was prepared there, at a level that class has slots for (only then was it counted, so only
 * then is a place free); one in a
 * spellbook (a class of `classes` with one) keeps its source, so the book still holds it (srd:rule:wizard-spellcasting:
 * "The book contains the level 1+ spells you know"). A name the rules lack comes with the feature or subclass granting it.
 */
export function alwaysPreparedGained(
  c: Character,
  cls: ClassOption | undefined,
  sub: SubclassOption | undefined,
  classLevel: number,
  findSpell: (name: string) => CompendiumEntry | undefined,
  classes: readonly ClassOption[] = [],
): AlwaysPreparedGain {
  const grants: { name: string; source: string }[] = [];
  for (const def of cls?.features ?? []) {
    if (def.level > classLevel) continue;
    for (const name of alwaysPreparedSpellNames(def.description)) grants.push({ name, source: def.name });
  }
  if (sub) {
    const rows = sub.alwaysPreparedSpells?.length
      ? sub.alwaysPreparedSpells
      : sub.features.filter((d) => d.level <= classLevel && SPELL_TABLE.test(d.description)).flatMap((d) => spellTableRows(d.description));
    for (const row of rows) if (row.level <= classLevel) for (const name of row.spells) grants.push({ name, source: sub.name });
    for (const def of sub.features) {
      if (def.level > classLevel) continue;
      for (const name of alwaysPreparedSpellNames(def.description)) grants.push({ name, source: sub.name });
    }
  }
  const held = new Map((c.spellcasting?.spells ?? []).map((s) => [nameKey(s.name), s]));
  // Whether a class of the hero's keeps a spellbook, from its data on this device.
  const hasBook = (cl: ClassLevel) => {
    const option = classOptionFor(cl, classes) ?? (cls?.id === cl.classId ? cls : undefined);
    return option ? classSpellRules(option).spellbook.start > 0 : false;
  };
  // The hero's class whose list a held spell is on: its name as the source, or a spellbook's extra ("Wizard (copied)").
  const ownerOf = (spell: KnownSpell): { cl: ClassLevel; inBook: boolean } | null => {
    for (const cl of c.classes) {
      if (nameKey(spell.source ?? '') === nameKey(cl.name)) return { cl, inBook: hasBook(cl) };
      if (extraClassKey(spell.source) === nameKey(cl.name) && hasBook(cl)) return { cl, inBook: true };
    }
    return null;
  };
  // A class's spell level once this level is gained: the levelled class's is that of `classLevel` (the dialog plans on
  // the hero before the level-up, the DM's level_up on the hero after it).
  const capOf = (cl: ClassLevel) => {
    const levelled = cls !== undefined && (cl.classId === cls.id || classOptionFor(cl, classes)?.id === cls.id);
    return classSpellLevelCap(levelled ? { ...cl, level: Math.max(cl.level, classLevel) } : cl);
  };
  const out: AlwaysPreparedGain = { add: [], flip: [], missing: [] };
  const seen = new Set<string>();
  for (const grant of grants) {
    const key = nameKey(grant.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const have = held.get(key);
    if (have) {
      if (have.alwaysPrepared || have.level < 1) continue;
      const owner = ownerOf(have);
      out.flip.push({
        id: have.id,
        name: have.name,
        source: grant.source,
        ...(owner ? { owner: owner.cl.name } : {}),
        ...(owner?.inBook ? { inBook: true } : {}),
        // Only a prepared spell of a level the class has slots for is on its list (owedSpells), so only it frees a place:
        // one above it counted nowhere (srd:rule:multiclassing-class-features-spellcasting, "as if you were a
        // single-classed member of that class").
        ...(owner && have.prepared && have.level <= capOf(owner.cl) ? { counted: true } : {}),
      });
      continue;
    }
    const entry = findSpell(grant.name);
    const spell = entry?.kind === 'spell' ? knownSpellFromEntry(entry, { alwaysPrepared: true, prepared: true, source: grant.source }) : null;
    if (spell) out.add.push(spell);
    else out.missing.push({ name: grant.name.trim(), source: grant.source });
  }
  return out;
}

/**
 * Put the gain on the sheet: the new spells (engine addSpell keeps the index ids) and the turned ones, with the feature
 * or subclass as their source; a spellbook's spell keeps its own, so the book still holds it.
 */
export function applyAlwaysPrepared(c: Character, gain: AlwaysPreparedGain): Character {
  let next = c;
  for (const spell of gain.add) next = addSpell(next, spell).character;
  const sc = next.spellcasting;
  if (!gain.flip.length || !sc) return next;
  const turned = new Map(gain.flip.map((f) => [f.id, f]));
  const spells = sc.spells.map((s) => {
    const f = turned.get(s.id);
    if (!f) return s;
    return f.inBook ? { ...s, alwaysPrepared: true, prepared: true } : { ...s, alwaysPrepared: true, prepared: true, source: f.source };
  });
  return { ...next, spellcasting: { ...sc, spells } };
}

/** A class's open choices with what it owes now. */
export interface ClassPicks {
  owed: OwedSpells;
  entry: SpellPicksOwed;
}

/** What a level-up's own edit did with the hero's spells (levelSpellsEdit). */
export interface LevelSpellsEdit {
  character: Character;
  gain: AlwaysPreparedGain;
  /** What the levelled class may still choose, counted after the gain (null: its table can't be counted). */
  owed: OwedSpells | null;
  /** The levelled class's open choices (null: none open). */
  entry: SpellPicksOwed | null;
  /** Other classes whose picks the gain turned always prepared, open now for the places those left. */
  others: (ClassPicks & { cl: ClassLevel })[];
}

/**
 * The levelled class's spells, in the level-up's own edit (SRD 5.2.1 srd:rule:gaining-spells): the always-prepared spells
 * its features and its subclass grant up to its level, added or turned always prepared ("a spell that you always have
 * prepared doesn't count against the number of spells on that list", so its place is free again), then the mark that its
 * choices are open, counted after them. Another of the hero's classes whose pick was turned owes that place now too: its
 * choices are marked open (without swaps: it gained no level), so the sheet offers it and the DM hears of it. `cl` is the
 * levelled entry as the level-up left it; `classes` are the merged builder data's.
 */
export function levelSpellsEdit(
  c: Character,
  cl: ClassLevel,
  cls: ClassOption,
  sub: SubclassOption | undefined,
  findSpell: (name: string) => CompendiumEntry | undefined,
  classes: readonly ClassOption[],
): LevelSpellsEdit {
  const gain = alwaysPreparedGained(c, cls, sub, cl.level, findSpell, classes);
  let next = spellPicksAfterLevel(applyAlwaysPrepared(c, gain), cl, cls);
  const others: LevelSpellsEdit['others'] = [];
  const owners = new Set(gain.flip.flatMap((f) => (f.owner ? [nameKey(f.owner)] : [])));
  for (const other of next.classes) {
    if (other.classId === cl.classId || !owners.has(nameKey(other.name))) continue;
    const option = classOptionFor(other, classes);
    const owed = option ? owedSpells(next, other, option) : null;
    if (!owed || owedTotal(owed) === 0) continue;
    const list = next.spellcasting?.spellPicks ?? [];
    const had = list.find((p) => p.classId === other.classId);
    const entry = had ?? { classId: other.classId };
    if (!had) next = withSpellPicks(next, [...list, entry]);
    others.push({ cl: other, owed, entry });
  }
  const owed = next.spellcasting ? owedSpells(next, cl, cls) : null;
  const entry = next.spellcasting?.spellPicks?.find((p) => p.classId === cl.classId) ?? null;
  return { character: next, gain, owed, entry, others };
}

// ---------------------------------------------------------------------------
// Words for the DM, the notices and the sheet
// ---------------------------------------------------------------------------

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function andList(parts: readonly string[]): string {
  if (parts.length < 2) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "level 1 spells", "spells of level 1–3", "" for a class with no slots yet. */
export function spellLevelsText(maxLevel: number): string {
  if (maxLevel < 1) return '';
  return maxLevel === 1 ? 'level 1 spells' : `spells of level 1–${maxLevel}`;
}

/**
 * "1 cantrip, 6 spellbook spells and 2 prepared spells" ("" when nothing is owed); with `limits`, the spellbook spells'
 * limits by level where they have any (bookCapsText): "6 spellbook spells (2 up to level 2 and 4 of level 1)".
 */
export function owedSpellsSummary(o: OwedSpells, limits = false): string {
  const parts: string[] = [];
  if (o.cantrips?.owed) parts.push(plural(o.cantrips.owed, 'cantrip', 'cantrips'));
  if (o.spellbook?.owed) {
    const caps = limits ? bookCapsText(o.bookCaps, o.maxLevel) : '';
    parts.push(`${plural(o.spellbook.owed, 'spellbook spell', 'spellbook spells')}${caps ? ` (${caps})` : ''}`);
  }
  if (o.prepared.owed) parts.push(plural(o.prepared.owed, 'prepared spell', 'prepared spells'));
  return andList(parts);
}

/** "replace one spell and one cantrip" ("" with no swap open). */
export function swapsText(entry: Pick<SpellPicksOwed, 'replaceSpell' | 'replaceCantrip'>): string {
  const parts = [...(entry.replaceSpell ? ['one spell'] : []), ...(entry.replaceCantrip ? ['one cantrip'] : [])];
  return parts.length ? `replace ${andList(parts)}` : '';
}

/**
 * The DM's line for a class's open choices, with the sheet's numbers so a catch-up is plain: "Wizard 4 (spells of level
 * 1–2): up to 1 cantrip (the sheet has 3 of 4), 6 spellbook spells (6 of at least 12) and 2 prepared spells (5 of 7);
 * may also replace one cantrip." Spellbook spells owed for earlier levels say those levels' limits: "4 spellbook spells
 * (10 of at least 14: 2 up to level 3 and 2 up to level 2)", "1 spellbook spell (13 of at least 14: 1 up to level 2)".
 */
export function owedSpellsLine(o: OwedSpells, entry: Pick<SpellPicksOwed, 'replaceSpell' | 'replaceCantrip'> = {}): string {
  const parts: string[] = [];
  if (o.cantrips?.owed) parts.push(`${plural(o.cantrips.owed, 'cantrip', 'cantrips')} (the sheet has ${o.cantrips.held} of ${o.cantrips.target})`);
  if (o.spellbook?.owed) {
    const caps = bookCapsText(o.bookCaps, o.maxLevel);
    parts.push(`${plural(o.spellbook.owed, 'spellbook spell', 'spellbook spells')} (${o.spellbook.held} of at least ${o.spellbook.target}${caps ? `: ${caps}` : ''})`);
  }
  if (o.prepared.owed) parts.push(`${plural(o.prepared.owed, 'prepared spell', 'prepared spells')} (${o.prepared.held} of ${o.prepared.target})`);
  const levels = spellLevelsText(o.maxLevel);
  const head = `${o.className} ${o.level}${levels ? ` (${levels})` : ''}`;
  const swaps = swapsText(entry);
  if (!parts.length) return swaps ? `${head}: may ${swaps}; nothing new to choose.` : `${head}: nothing new to choose.`;
  return `${head}: up to ${andList(parts)}${swaps ? `; may also ${swaps}` : ''}.`;
}

/**
 * How the DM records choices the player names, so the sheet counts them: "update_character spells_add, source
 * "Wizard" (prepared: false for a spell only added to the spellbook; …), and spells_remove for one they give up". A
 * spellbook's copied spells, and those a feature adds free (Evocation Savant), come on top of each level's two
 * (srd:rule:wizard-spellcasting), so they take their own source, unprepared unless the player prepares them (copying
 * prepares nothing: "Afterward you can prepare the spell"); a spell already in the book is prepared by name alone, so it
 * keeps its own.
 */
export function recordingClause(o: Pick<OwedSpells, 'className' | 'spellbook'>, entry: Pick<SpellPicksOwed, 'replaceSpell' | 'replaceCantrip'> = {}): string {
  const book = o.spellbook
    ? ` (prepared: false for a spell only added to the spellbook; a spell copied into it, or one a feature adds to it free: source "${o.className} (copied)", prepared false unless the player prepares it; to prepare a spell already in it: re-add it by name with prepared true and no source)`
    : '';
  const swap = entry.replaceSpell || entry.replaceCantrip ? ', and spells_remove for one they give up' : '';
  return `update_character spells_add, source "${o.className}"${book}${swap}`;
}

/**
 * How the DM records choices the player names instead of picking them on the sheet, so the sheet counts them: a
 * replacement takes spells_remove for the spell given up as well.
 */
export function recordingHint(o: Pick<OwedSpells, 'className' | 'spellbook'>, entry: Pick<SpellPicksOwed, 'replaceSpell' | 'replaceCantrip'> = {}): string {
  return `The player chooses these on their sheet's Spells tab, and you'll get a note. If they tell you their choices instead, record each with ${recordingClause(o, entry)}.`;
}

/** The engine's generic spell line for this class level, dropped wherever the class's choices could be counted. */
export function withoutSpellReview(reminders: readonly string[], className: string, level: number): string[] {
  const line = spellReviewReminder(className, level);
  return reminders.filter((r) => r !== line);
}
