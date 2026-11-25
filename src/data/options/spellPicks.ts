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
 * spells on that list").
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
  /** The level 1+ spells in a spellbook (prepared or not); null without one. */
  spellbook: SpellCount | null;
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
 * What the class holds at its level, what the sheet holds for it and what the player may still choose; null when its
 * table has neither a Cantrips nor a Prepared Spells column (a Fighter, a third caster from a book, a book class
 * without the columns): the caller can't tell, so it keeps the engine's generic reminder.
 */
export function owedSpells(c: Character, cl: ClassLevel, cls: ClassOption): OwedSpells | null {
  if (!hasColumn(cls, isCantripColumn) && !hasColumn(cls, isPreparedColumn)) return null;
  const rules = classSpellRules(cls);
  const own = classSpellsOf(c, cl.name);
  const leveled = own.filter((s) => s.level >= 1);
  const level = cl.level;
  return {
    className: cl.name,
    level,
    maxLevel: classSpellLevelCap(cl),
    cantrips: hasColumn(cls, isCantripColumn) ? count(cantripsKnown(cls, level) + optionCantrips(c, cl, cls), own.length - leveled.length) : null,
    prepared: count(preparedSpellCount(cls, level), leveled.filter((s) => s.prepared).length),
    spellbook: rules.spellbook.start > 0 ? count(rules.spellbook.start + rules.spellbook.perLevel * (level - 1), leveled.length) : null,
    rules,
  };
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
  const replaceSpell = cl.level > 1 && owed.rules.levelGain.spell && own.some((s) => s.level >= 1);
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

export interface AlwaysPreparedGain {
  /** New sheet spells, always prepared, with the feature or subclass as their source. */
  add: KnownSpell[];
  /** Spells the sheet already holds as ordinary level 1+ spells, now always prepared with that source. */
  flip: { id: string; name: string; source: string }[];
  /** Names the rules index doesn't have (a book's spell not accepted yet): the DM adds them. */
  missing: string[];
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
 * srd:rule:gaining-spells); one already always prepared stays as it is.
 */
export function alwaysPreparedGained(
  c: Character,
  cls: ClassOption | undefined,
  sub: SubclassOption | undefined,
  classLevel: number,
  findSpell: (name: string) => CompendiumEntry | undefined,
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
  const out: AlwaysPreparedGain = { add: [], flip: [], missing: [] };
  const seen = new Set<string>();
  for (const grant of grants) {
    const key = nameKey(grant.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const have = held.get(key);
    if (have) {
      if (!have.alwaysPrepared && have.level >= 1) out.flip.push({ id: have.id, name: have.name, source: grant.source });
      continue;
    }
    const entry = findSpell(grant.name);
    const spell = entry?.kind === 'spell' ? knownSpellFromEntry(entry, { alwaysPrepared: true, prepared: true, source: grant.source }) : null;
    if (spell) out.add.push(spell);
    else out.missing.push(grant.name.trim());
  }
  return out;
}

/** Put the gain on the sheet: the new spells (engine addSpell keeps the index ids) and the turned ones. */
export function applyAlwaysPrepared(c: Character, gain: AlwaysPreparedGain): Character {
  let next = c;
  for (const spell of gain.add) next = addSpell(next, spell).character;
  const sc = next.spellcasting;
  if (!gain.flip.length || !sc) return next;
  const sources = new Map(gain.flip.map((f) => [f.id, f.source]));
  const spells = sc.spells.map((s) => {
    const source = sources.get(s.id);
    return source === undefined ? s : { ...s, alwaysPrepared: true, prepared: true, source };
  });
  return { ...next, spellcasting: { ...sc, spells } };
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

/** "1 cantrip, 6 spellbook spells and 2 prepared spells" ("" when nothing is owed). */
export function owedSpellsSummary(o: OwedSpells): string {
  const parts: string[] = [];
  if (o.cantrips?.owed) parts.push(plural(o.cantrips.owed, 'cantrip', 'cantrips'));
  if (o.spellbook?.owed) parts.push(plural(o.spellbook.owed, 'spellbook spell', 'spellbook spells'));
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
 * may also replace one cantrip."
 */
export function owedSpellsLine(o: OwedSpells, entry: Pick<SpellPicksOwed, 'replaceSpell' | 'replaceCantrip'> = {}): string {
  const parts: string[] = [];
  if (o.cantrips?.owed) parts.push(`${plural(o.cantrips.owed, 'cantrip', 'cantrips')} (the sheet has ${o.cantrips.held} of ${o.cantrips.target})`);
  if (o.spellbook?.owed) parts.push(`${plural(o.spellbook.owed, 'spellbook spell', 'spellbook spells')} (${o.spellbook.held} of at least ${o.spellbook.target})`);
  if (o.prepared.owed) parts.push(`${plural(o.prepared.owed, 'prepared spell', 'prepared spells')} (${o.prepared.held} of ${o.prepared.target})`);
  const levels = spellLevelsText(o.maxLevel);
  const head = `${o.className} ${o.level}${levels ? ` (${levels})` : ''}`;
  const swaps = swapsText(entry);
  if (!parts.length) return swaps ? `${head}: may ${swaps}; nothing new to choose.` : `${head}: nothing new to choose.`;
  return `${head}: up to ${andList(parts)}${swaps ? `; may also ${swaps}` : ''}.`;
}

/**
 * How the DM records choices the player names instead of picking them on the sheet, so the sheet counts them: a
 * replacement takes spells_remove for the spell given up as well.
 */
export function recordingHint(o: Pick<OwedSpells, 'className' | 'spellbook'>, entry: Pick<SpellPicksOwed, 'replaceSpell' | 'replaceCantrip'> = {}): string {
  const book = o.spellbook ? ' (prepared: false for a spell only added to the spellbook)' : '';
  const swap = entry.replaceSpell || entry.replaceCantrip ? ', and spells_remove for one they give up' : '';
  return `The player chooses these on their sheet's Spells tab, and you'll get a note. If they tell you their choices instead, record each with update_character spells_add, source "${o.className}"${book}${swap}.`;
}

/** The engine's generic spell line for this class level, dropped wherever the class's choices could be counted. */
export function withoutSpellReview(reminders: readonly string[], className: string, level: number): string[] {
  const line = spellReviewReminder(className, level);
  return reminders.filter((r) => r !== line);
}
