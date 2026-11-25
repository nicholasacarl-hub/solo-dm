/**
 * Character tools: batched sheet changes, rests, leveling, and reading the full sheet.
 * Every change runs through the pure engine and lands in the store in one atomic update.
 *
 * Content from the player's books (structured imports, spec §5.5, §6.4, §6.6): level_up takes an
 * imported class's or subclass's features (with their text and refs) from the merged builder data;
 * inventory_add, spells_add and features_add link an exact name to the rules index or the builder data,
 * so the sheet gets numbers and provenance (refs), never invented text. SRD classes keep today's
 * DM-supplied features, and a failure to read the data leaves every tool exactly as it was.
 *
 * Spell picks (src/data/options/spellPicks.ts): level_up adds the always-prepared spells a class or subclass grants and
 * marks the class's spell choices open, and its result and log say what the player may still choose, counted live from
 * the class table and the sheet; take_rest long names the prepared spells the classes may change. The player chooses on
 * the sheet; what they name in chat the DM records with spells_add, source the class's name. No DM_TOOLS change.
 */
import {
  abilityModifier,
  changeAbilityScore,
  computeArmorClass,
  addCondition,
  addFeature,
  addItem,
  addSpell,
  adjustHpMax,
  applyDamage,
  applyDrainingDamage,
  applyHealing,
  applyLongRest,
  applyShortRest,
  changeCurrency,
  changeExhaustion,
  changeInitiativeBonus,
  characterLevel,
  characterSheetText,
  characterStatusLine,
  conditionKey,
  drainProblem,
  endHpMaxAdjustments,
  featOrTrait,
  featureLabel,
  featureToRewrite,
  findHpMaxAdjustments,
  formatModifier,
  hpMaxAdjustments,
  hpMaxEndsText,
  isAlertFeat,
  isToughFeat,
  saveSourcesChangeText,
  gainXp,
  levelUp,
  matchStandardCondition,
  removeCondition,
  removeItem,
  removeSpell,
  restoreFeature,
  restoreSlot,
  setConcentration,
  setTempHp,
  spendHitDie,
  spendSlot,
  stabilize,
  unknownWornArmor,
  updateItem,
  useFeature,
  xpToNextLevel,
  type EngineResult,
  type LevelUpOptions,
} from '@/engine';
import type { RulesIndex } from '@/data';
import { withAdaptationNotes } from '@/data/options/adaptationNotes';
import { entryRef, inventoryFromEntry } from '@/data/options/inventory';
import { inlineFightingStyles, inlineOptionRef } from '@/data/options/classFeatures';
import { gainedFeatures, keptRulings } from '@/data/options/leveling';
import { classRefOf, subclassCastingOf, subclassRefOf, spellEntryRef, spellHomebrewId } from '@/data/options/levelUpChoices';
import { subclassesOf } from '@/data/options/replaced';
import { classByName, classOptionFor, multiclassPrimariesFor, optionSourceLabel, subclassByName, subclassOptionFor } from '@/data/options/resolve';
import {
  classSpellRules,
  keepsBookExtra,
  levelSpellsEdit,
  owedSpellsLine,
  recordingHint,
  settleSpellPicks,
  withoutSpellReview,
  type ClassPicks,
  type OwedSpells,
  type SettledPicks,
} from '@/data/options/spellPicks';
import { matchByName } from '@/engine/util';
import { nameKey } from '@/lib/id';
import { textFingerprint } from '@/lib/importedContent';
import {
  ABILITY_NAMES,
  SKILL_NAMES,
  SRD_SOURCE_ID,
  type BuilderData,
  type Campaign,
  type Character,
  type ClassLevel,
  type ClassFeatureDef,
  type ClassOption,
  type CompendiumEntry,
  type ContentKind,
  type Currency,
  type EquipmentOption,
  type FeatOption,
  type Feature,
  type GameEvent,
  type HitDie,
  type HpMaxAdjustment,
  type ImportedRef,
  type InventoryItem,
  type KnownSpell,
  type ProficiencyLevel,
  type RollResult,
  type Skill,
  type SpellPicksOwed,
  type SpellSlotLevel,
  type SubclassOption,
  type ToolActivityIcon,
} from '@/types';
import type { ToolInput } from './definitions';
import {
  changesOf,
  defined,
  eventLines,
  fail,
  keptHomebrewLines,
  logTool,
  mutateCharacter,
  ok,
  plural,
  requireCampaign,
  requireCharacter,
  ToolInputError,
  warningsOf,
  type ToolContext,
  type ToolOutcome,
} from './context';
import { DmCancelledError } from '../errors';
import { truncate } from '../narration';
import { refitHeroAfterSheetChange } from './map';
import { findAllowedEntry } from './rules';

// ---------------------------------------------------------------------------
// update_character
// ---------------------------------------------------------------------------

interface Section {
  icon: ToolActivityIcon;
  /** Log line for the change; derived from events when omitted. */
  summary?: (before: Character, after: Character) => string;
  apply: (c: Character) => EngineResult;
}

interface SectionResult {
  section: Section;
  before: Character;
  after: Character;
  events: GameEvent[];
}

function chain(c: Character, steps: ((c: Character) => EngineResult)[]): EngineResult {
  let character = c;
  const events: GameEvent[] = [];
  for (const step of steps) {
    const r = step(character);
    character = r.character;
    events.push(...r.events);
  }
  return { character, events };
}

/** A name the DM gave for Exhaustion ("Exhaustion", "Exhausted (forced march)"): it changes the level instead. */
function isExhaustion(name: string): boolean {
  return matchStandardCondition(name)?.id === 'exhaustion';
}

function hpSection(hp: NonNullable<ToolInput<'update_character'>['hp']>, reason?: string): Section {
  const detail = (amount: string) => (reason ? `(${amount} · ${reason})` : `(${amount})`);
  return {
    icon: hp.kind === 'damage' ? 'hp' : 'heal',
    summary: (before, after) => {
      if (hp.kind === 'temp') return `Temp HP ${before.hp.temp} → ${after.hp.temp}`;
      // A drain under a name it can't take refuses the hit whole (applyDrainingDamage): nothing to log. A hit that
      // changes nothing otherwise (Immunity, the dead) logs as a plain hit does.
      if (hp.drain && drainProblem(before, hp.drain)) return '';
      const label = hp.kind === 'damage' ? `${hp.amount}${hp.damage_type ? ` ${hp.damage_type}` : ''}` : `+${hp.amount}`;
      const max = after.hp.max !== before.hp.max ? ` · HP max ${before.hp.max} → ${after.hp.max}` : '';
      return `HP ${before.hp.current} → ${after.hp.current} ${detail(label)}${max}`;
    },
    apply: (c) => {
      if (hp.kind === 'damage') {
        const opts = { critical: hp.critical, damageType: hp.damage_type };
        return hp.drain ? applyDrainingDamage(c, hp.amount, { ...opts, drain: hp.drain }) : applyDamage(c, hp.amount, opts);
      }
      if (hp.kind === 'healing') return applyHealing(c, hp.amount);
      return setTempHp(c, hp.amount);
    },
  };
}

const adjustmentKey = (a: HpMaxAdjustment) => `${nameKey(a.name)}|${a.ends}`;

/** The log's tail: what else happened, then the DM's reason. */
function tail(before: Character, after: Character, reason?: string): string {
  return `${after.deathSaves.dead && !before.deathSaves.dead ? ' · the hero died' : ''}${reason ? ` · ${reason}` : ''}`;
}

/** hp_max_end: every name at once (endHpMaxAdjustments), so their order never matters; the log names what ended. */
function hpMaxEndSection(names: readonly string[], reason?: string): Section {
  return {
    icon: 'info',
    summary: (before, after) => {
      if (after === before) return '';
      const list = hpMaxAdjustments(before);
      const left = new Set(hpMaxAdjustments(after).map(adjustmentKey));
      const ended = [...findHpMaxAdjustments(before, names).indices].map((i) => list[i]).filter((a) => !left.has(adjustmentKey(a)));
      return `HP max ${before.hp.max} → ${after.hp.max} (ended: ${ended.map((a) => a.name).join(', ')}${tail(before, after, reason)})`;
    },
    apply: (c) => endHpMaxAdjustments(c, names),
  };
}

/** hp_max: the log gives the arrows (the amount applied, after a floor, is in them) and the effect's name and end. */
function hpMaxSection(spec: NonNullable<ToolInput<'update_character'>['hp_max']>, reason?: string): Section {
  return {
    icon: spec.change > 0 ? 'heal' : 'hp',
    summary: (before, after) => {
      if (after === before) return '';
      const hp = after.hp.current !== before.hp.current ? `, HP ${before.hp.current} → ${after.hp.current}` : '';
      return `HP max ${before.hp.max} → ${after.hp.max}${hp} (${spec.name.replace(/\s+/g, ' ').trim()} · ${hpMaxEndsText(spec.ends)}${tail(before, after, reason)})`;
    },
    apply: (c) => adjustHpMax(c, spec),
  };
}

/**
 * For the DM: an adjustment this call made or changed that only the DM ends (no game clock ends Heroes' Feast), with its
 * amount now, so the switch call it gives stays right as a curse grows (SRD 5.2.1 Mummy: "decreases by 10 (3d6) every 24
 * hours"). A reduction a curse or poison only keeps from returning at a Long Rest (Mummy, Death Dog: "doesn't return to
 * normal when finishing a Long Rest") returns at the next one once the cause ends, so it switches to ending there. Nothing
 * for a hero the call killed: the dead don't rest.
 */
function untilEndedLines(before: Character, after: Character): string[] {
  if (after.deathSaves.dead) return [];
  const had = new Set(hpMaxAdjustments(before).map((a) => `${adjustmentKey(a)}|${a.amount}`));
  return hpMaxAdjustments(after)
    .filter((a) => a.ends === 'when-ended' && !had.has(`${adjustmentKey(a)}|${a.amount}`))
    .map((a) => {
      const end = `update_character hp_max_end ["${a.name}"]`;
      if (a.amount > 0) return `${a.name} ${formatModifier(a.amount)} stays until you end it: ${end} when its time runs out or its cause ends (the status line keeps it in view).`;
      const toRest = `${end} with hp_max {"name": "${a.name}", "change": ${a.amount}, "ends": "long-rest"} in one call`;
      return `${a.name} ${formatModifier(a.amount)} stays until you end it (the status line keeps it in view): ${end} when its cause ends. If the cause only kept a Long Rest from restoring it (a Mummy's curse, a Death Dog's poison), it returns at the next Long Rest once the cause ends: then switch it with ${toRest}.`;
    });
}

// -- links to the rules index and builder data (structured imports) ----------

/** What update_character found for the names it was given (resolved before the atomic update). */
interface Links {
  /** Per inventory_add entry: the linked item, or null (added as given). */
  items: (Omit<InventoryItem, 'id'> | null)[];
  /** Per spells_add entry: the spell entry its exact name resolves to, or null. */
  spells: (CompendiumEntry | null)[];
  /** Per spells_add entry: the book's spell whose words its notes repeat (bookCopy), or null. */
  spellCopies: (CompendiumEntry | null)[];
  /** Per inventory_update entry: the ref of the book's item whose words its description repeats, or null. */
  updateCopies: (ImportedRef | null)[];
  /** Per features_add entry: the book part or feat it names whose text holds the most of its words (featureRef), or null. */
  feats: (BookMatch | null)[];
  /** The merged equipment catalog, for Armor Class ([] when it couldn't load: the SRD armor table). */
  catalog: readonly EquipmentOption[];
  /** The merged classes, for a spellbook's extras a re-added spell keeps ([] when they couldn't load). */
  classes: readonly ClassOption[];
}

const NO_LINKS: Links = { items: [], spells: [], spellCopies: [], updateCopies: [], feats: [], catalog: [], classes: [] };

async function loadIndexOrNull(ctx: ToolContext): Promise<RulesIndex | null> {
  try {
    return await ctx.deps.rulesIndex();
  } catch {
    return null;
  }
}

async function loadBuilderOrNull(ctx: ToolContext): Promise<BuilderData | null> {
  try {
    return await ctx.deps.builderData();
  } catch {
    return null;
  }
}

/** The entry an exact name resolves to among the sources the DM may consult, or null. */
function exactEntry(index: RulesIndex | null, campaign: Campaign | null, name: string, kind: 'spell' | 'item' | 'magic-item'): CompendiumEntry | null {
  if (!index || !campaign) return null;
  const entry = findAllowedEntry(index, name, { kind, campaign });
  return entry && entry.kind === kind && nameKey(entry.name) === nameKey(name) ? entry : null;
}

/**
 * An inventory_add item linked to the index (spec §6.6): the catalog option's or the entry's numbers
 * (armor, bonuses, attunement) and ref. What the DM gave explicitly wins (category, magic, weight), and
 * the DM's description is kept — for a book's item it is the DM's words about it, so the ref marks it
 * copied and exports leave it out.
 */
function linkedItem(item: NonNullable<ToolInput<'update_character'>['inventory_add']>[number], entry: CompendiumEntry, catalog: readonly EquipmentOption[]): Omit<InventoryItem, 'id'> {
  const linked: Omit<InventoryItem, 'id'> = { ...inventoryFromEntry(entry, item.quantity, catalog), ...defined({ category: item.category, magic: item.magic, weight: item.weight }) };
  if (item.description) {
    linked.description = item.description;
    if (linked.ref) linked.ref = { ...linked.ref, textCopied: true, textHash: textFingerprint(item.description) };
  }
  return linked;
}

/** The one imported feat of a name (two books' feats of one name: none), which an entry off the trait side links by name. */
function featNamed(name: string, data: BuilderData | null): FeatOption | null {
  const feats = (data?.feats ?? []).filter((o) => o.source && o.ref && nameKey(o.name) === nameKey(name));
  return feats.length === 1 ? feats[0] : null;
}

/**
 * Lower case, emphasis marks gone, typographic quotes and dashes made plain (an imported book keeps "’" where the DM's
 * tool input types "'"), whitespace collapsed: text compared for shared words.
 */
const plainWords = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[_*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** The DM's text in the runs of 40 characters it is compared by, every 20 (all of it when 40 characters or fewer). */
function runsOf(text: string): string[] {
  const dm = plainWords(text);
  if (dm.length <= 40) return dm ? [dm] : [];
  const runs: string[] = [];
  for (let i = 0; i + 40 <= dm.length; i += 20) runs.push(dm.slice(i, i + 40));
  return runs;
}

/** How many of the DM's runs a book's text holds, leaving out those `srd` (the SRD's text) prints too. */
function runsIn(runs: readonly string[], text: string, srd = ''): number {
  const book = plainWords(text);
  return book ? runs.filter((run) => book.includes(run) && !srd.includes(run)).length : 0;
}

/** The plain text of the imported entries of some kinds, joined, with where each starts. */
interface BookText {
  text: string;
  starts: number[];
  entries: CompendiumEntry[];
}

/** Per index (a library change builds a new one): the SRD's plain text, and each kind list's book text. */
const indexTexts = new WeakMap<RulesIndex, { srd: string; books: Map<string, BookText> }>();

function textsOf(index: RulesIndex): { srd: string; books: Map<string, BookText> } {
  let texts = indexTexts.get(index);
  if (!texts) {
    // Every SRD entry, whatever its kind: SRD wording a book reprints (a rule inside a spell) is anyone's to keep.
    const srd = index.list({ sourceId: SRD_SOURCE_ID }).map((e) => plainWords(e.text)).join('\n');
    indexTexts.set(index, (texts = { srd, books: new Map() }));
  }
  return texts;
}

function bookText(index: RulesIndex, kinds: readonly ContentKind[]): BookText {
  const { books } = textsOf(index);
  const key = kinds.join(' ');
  const cached = books.get(key);
  if (cached) return cached;
  const entries = kinds.flatMap((kind) => index.list({ kind })).filter((e) => e.id.startsWith('lib:'));
  const starts: number[] = [];
  let at = 0;
  const texts = entries.map((e) => {
    const plain = plainWords(e.text);
    starts.push(at);
    at += plain.length + 1;
    return plain;
  });
  // plainWords leaves no line break, so no run spans two entries.
  const built = { text: texts.join('\n'), starts, entries };
  books.set(key, built);
  return built;
}

/** The entry a position in a book text falls in: the last one that starts at or before it. */
function entryAt(book: BookText, pos: number): CompendiumEntry {
  let lo = 0;
  let hi = book.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (book.starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return book.entries[lo];
}

/**
 * Where a run of the DM's text sits in one book entry's own words, or -1: absent from the books, printed in the SRD
 * (anyone's to keep), or boilerplate the books print under several names ("a +1 bonus to attack and damage rolls made
 * with this magic weapon"), which says nothing about which entry the DM copied.
 */
function ownRunAt(run: string, book: BookText, srd: string): number {
  const at = book.text.indexOf(run);
  if (at < 0 || srd.includes(run)) return -1;
  const name = nameKey(entryAt(book, at).name);
  for (let next = book.text.indexOf(run, at + 1), n = 0; next >= 0 && n < 8; next = book.text.indexOf(run, next + 1), n++) {
    if (nameKey(entryAt(book, next).name) !== name) return -1;
  }
  return at;
}

/**
 * The imported entry of these kinds whose own words the DM's free text repeats (spec §7.1): two of the runs of 40
 * characters runsOf reads (the only one, under 60 characters), each in that entry's words alone (ownRunAt). Null
 * for the DM's own words, stock wording and SRD wording, and without an index.
 */
function bookCopy(text: string | undefined, index: RulesIndex | null, kinds: readonly ContentKind[]): CompendiumEntry | null {
  const dm = plainWords(text ?? '');
  if (!index || dm.length < 40) return null;
  const book = bookText(index, kinds);
  if (!book.entries.length) return null;
  const { srd } = textsOf(index);
  const needed = dm.length < 60 ? 1 : 2;
  let first = -1;
  let found = 0;
  for (let i = 0; i + 40 <= dm.length && found < needed; i += 20) {
    const at = ownRunAt(dm.slice(i, i + 40), book, srd);
    if (at < 0) continue;
    if (first < 0) first = at;
    found += 1;
  }
  return found < needed ? null : entryAt(book, first);
}

/** The DM's notes repeat a linked book spell's own words: one 40-character run of them (runsOf) the SRD doesn't print. */
function sharesBookWords(text: string, entryText: string, index: RulesIndex | null): boolean {
  return runsIn(runsOf(text), entryText, index ? textsOf(index).srd : '') > 0;
}

/** What a scroll, a wand or a granted spell may quote: the books' spells and items, either way round. */
const ITEM_KINDS: readonly ContentKind[] = ['item', 'magic-item', 'spell'];
const SPELL_KINDS: readonly ContentKind[] = ['spell', 'item', 'magic-item'];

/** A copy's ref: the book entry its words came from (a spell's ref shape for a spell), marked copied. */
function copyRefOf(copy: CompendiumEntry, text: string): ImportedRef | null {
  const ref = copy.kind === 'spell' ? spellEntryRef(copy) : entryRef(copy, copy.kind === 'item' ? 'item' : 'magic-item');
  return ref ? { ...ref, textCopied: true, textHash: textFingerprint(text) } : null;
}

/** The ref marking an item's description as the words of the book's entry it repeats (bookCopy), or null. */
function itemCopyRef(description: string | undefined, index: RulesIndex | null): ImportedRef | null {
  const copy = bookCopy(description, index, ITEM_KINDS);
  return copy && description ? copyRefOf(copy, description) : null;
}

/** An inventory_add item as the DM gave it (no entry of that exact name to link). */
function givenItem(item: NonNullable<ToolInput<'update_character'>['inventory_add']>[number]): Omit<InventoryItem, 'id'> {
  return { name: item.name, quantity: item.quantity, ...defined({ description: item.description, category: item.category, magic: item.magic, weight: item.weight }) };
}

/** Name keys the SRD prints for a class or subclass feature (or a style one prints), a species trait or lineage, a background feature or a feat. */
function srdNameKeys(data: BuilderData | null): Set<string> {
  const keys = new Set<string>();
  const add = (f: ClassFeatureDef) => [f, ...inlineFightingStyles(f)].forEach((part) => keys.add(nameKey(part.name)));
  for (const cls of data?.classes ?? []) {
    if (!cls.source) cls.features.forEach(add);
    for (const sub of cls.subclasses) if (!sub.source) sub.features.forEach(add);
  }
  for (const sp of data?.species ?? []) if (!sp.source) for (const t of [...sp.traits, ...(sp.lineages ?? [])]) keys.add(nameKey(t.name));
  for (const bg of data?.backgrounds ?? []) if (!bg.source && bg.legacyFeature) keys.add(nameKey(bg.legacyFeature.name));
  for (const f of data?.feats ?? []) if (!f.source) keys.add(nameKey(f.name));
  return keys;
}

/** A book part or feat a DM's feature entry may repeat: its ref and text, and how many of the entry's runs that holds. */
interface BookMatch {
  ref: ImportedRef;
  runs: number;
}

/**
 * The book's texts named like a DM's feature entry, parts first: an imported class's or subclass's feature and the
 * styles a Fighting Style feature prints (inlineOptionRef), a species' trait or lineage, a background's feature (none
 * under a name the SRD prints too), then the books' feats.
 */
function bookTextsNamed(name: string, data: BuilderData | null): { ref: ImportedRef; text: string; feat: boolean }[] {
  const key = nameKey(name);
  const found: { ref: ImportedRef; text: string; feat: boolean }[] = [];
  const take = (n: string, ref: ImportedRef | undefined, text: string, feat = false) => {
    if (nameKey(n) === key && ref?.textCopied) found.push({ ref, text, feat });
  };
  const classPart = (f: ClassFeatureDef) => {
    take(f.name, f.ref, f.description);
    for (const style of inlineFightingStyles(f)) take(style.name, inlineOptionRef(f, style), style.description);
  };
  if (!srdNameKeys(data).has(key)) {
    for (const cls of data?.classes ?? []) {
      if (cls.source) cls.features.forEach(classPart);
      for (const sub of cls.subclasses) if (sub.source) sub.features.forEach(classPart);
    }
    for (const sp of data?.species ?? []) if (sp.source) for (const t of [...sp.traits, ...(sp.lineages ?? [])]) take(t.name, t.ref, t.description);
    for (const bg of data?.backgrounds ?? []) if (bg.source && bg.legacyFeature) take(bg.legacyFeature.name, bg.legacyFeature.ref, bg.legacyFeature.description);
  }
  for (const f of data?.feats ?? []) if (f.source) take(f.name, f.ref, f.description, true);
  return found;
}

/**
 * The book text a DM's feature entry repeats (features_add; a level_up extra, a class feature), or null: its ref lets
 * exports leave the DM's words out and restore refill the book's text. An entry off the trait side (a feat, a boon, a
 * background's, homebrew) is the one book feat of its name, whatever its words. Otherwise it is the book part or feat of
 * its name whose text holds the most of its 40-character runs, a part before a feat (and the first book) on a tie, so a
 * trait's own text that shares a sentence with a feat stays the trait's and two books printing the part still leave
 * exports. A species trait or class feature is a feat only by the feat's own words (runs the SRD doesn't print; without
 * the rules index, any run). A name the SRD prints too is no book part's, and words of the DM's own are no book's.
 */
function featureRef(f: { name: string; description: string; source: Feature['source'] }, data: BuilderData | null, index: RulesIndex | null): BookMatch | null {
  const runs = runsOf(f.description);
  const trait = featOrTrait(f.source) === 'trait';
  const named = trait ? null : featNamed(f.name, data);
  if (named?.ref) return { ref: named.ref, runs: runsIn(runs, named.description) };
  const srd = trait && index ? textsOf(index).srd : '';
  let best: BookMatch | null = null;
  for (const text of bookTextsNamed(f.name, data)) {
    const held = runsIn(runs, text.text, text.feat ? srd : '');
    if (held > (best?.runs ?? 0)) best = { ref: text.ref, runs: held };
  }
  return best;
}

async function resolveLinks(input: ToolInput<'update_character'>, ctx: ToolContext): Promise<Links> {
  const items = input.inventory_add ?? [];
  const spells = input.spells_add ?? [];
  const feats = input.features_add ?? [];
  const updates = input.inventory_update ?? [];
  const described = updates.some((u) => u.description);
  if (!items.length && !spells.length && !feats.length && !described && !mayChangeArmorClass(input)) return NO_LINKS;
  const campaign = ctx.deps.store().campaign;
  // A trait's or class feature's entry reads the SRD's words too (featureRef).
  const traits = feats.some((f) => featOrTrait(f.source) === 'trait');
  const [data, index] = await Promise.all([loadBuilderOrNull(ctx), items.length || spells.length || described || traits ? loadIndexOrNull(ctx) : Promise.resolve(null)]);
  const catalog = data?.equipment ?? [];
  const linkedSpells = spells.map((spell) => exactEntry(index, campaign, spell.name, 'spell'));
  return {
    items: items.map((item) => {
      const entry = exactEntry(index, campaign, item.name, 'magic-item') ?? exactEntry(index, campaign, item.name, 'item');
      const linked = entry ? linkedItem(item, entry, catalog) : null;
      if (linked?.ref) return linked;
      // No book's item by that name: a description that repeats one's words still leaves exports (spec §7.1).
      const ref = itemCopyRef(item.description, index);
      return ref ? { ...(linked ?? givenItem(item)), ref } : linked;
    }),
    spells: linkedSpells,
    spellCopies: spells.map((spell, i) => {
      if (!spell.notes?.trim()) return null;
      const linked = linkedSpells[i];
      if (linked?.id.startsWith('lib:') && sharesBookWords(spell.notes, linked.text, index)) return linked;
      return bookCopy(spell.notes, index, SPELL_KINDS);
    }),
    updateCopies: updates.map((u) => itemCopyRef(u.description, index)),
    feats: feats.map((f) => featureRef(f, data, index)),
    catalog,
    classes: data?.classes ?? [],
  };
}

function inventorySteps(input: ToolInput<'update_character'>, links: Links): ((c: Character) => EngineResult)[] {
  const steps: ((c: Character) => EngineResult)[] = [];
  for (const item of input.inventory_remove ?? []) steps.push((c) => removeItem(c, item.name, item.quantity));
  (input.inventory_add ?? []).forEach((item, i) => {
    const add: Omit<InventoryItem, 'id'> = links.items[i] ?? givenItem(item);
    steps.push((c) => addItem(c, add));
  });
  (input.inventory_update ?? []).forEach((item, i) => {
    const patch = defined({
      equipped: item.equipped,
      attuned: item.attuned,
      quantity: item.quantity,
      description: item.description,
    });
    steps.push((c) => updateItem(c, item.name, itemUpdatePatch(c, item.name, patch, links.updateCopies[i] ?? null)));
  });
  return steps;
}

type ItemPatch = Partial<Omit<InventoryItem, 'id'>>;

/**
 * An inventory_update patch. A description the DM gives an item from a book is its words about that entry
 * (spec §7.1), as with inventory_add (linkedItem): the ref marks them copied, so exports leave them out on the
 * sheet's word alone, even once the transcript no longer holds the call that wrote them. So is one that repeats a
 * book's item's words on any other item (`copy`, from bookCopy), which then takes that item's ref. A `redacted`
 * left by a pulled save goes: the words are new. The item is found by name as updateItem finds it.
 */
function itemUpdatePatch(c: Character, name: string, patch: ItemPatch, copy: ImportedRef | null): ItemPatch {
  if (!patch.description) return patch;
  const ref = matchByName(c.inventory, name, (i) => i.name).match?.ref ?? copy;
  if (!ref) return patch;
  const { redacted: _left, ...kept } = ref;
  return { ...patch, ref: { ...kept, textCopied: true, textHash: textFingerprint(patch.description) } };
}

/**
 * A spells_add spell. When its exact name resolves to a spell the DM may consult, it takes that entry's
 * id (so the sheet's text and the map's area presets find it), its ritual and concentration flags, for
 * a book's spell a ref (nothing copied), and for a homebrew spell (this campaign's or shared homebrew:
 * findAllowedEntry links no other campaign's) its id as homebrewId, so the sheet tags it "homebrew" as it
 * does the builder's. Otherwise it is added as given, as before. Notes that repeat a
 * book entry's words (`copy`: its own spell's, or another spell's or an item's, from bookCopy) mark the ref copied —
 * that entry's ref when the spell has none — so exports leave them out; the DM's own notes stay its own. The defaults
 * (prepared, "Granted in play") are a new spell's: spellSteps keeps a re-added spell's own.
 */
function addedSpell(
  spell: NonNullable<ToolInput<'update_character'>['spells_add']>[number],
  entry: CompendiumEntry | null,
  copy: CompendiumEntry | null,
): Omit<KnownSpell, 'id'> & { id?: string } {
  const base = { name: spell.name, level: spell.level, prepared: spell.prepared ?? true, source: spell.source ?? 'Granted in play' };
  const linkRef = entry ? spellEntryRef(entry) : undefined;
  const marked = copy && spell.notes ? (linkRef ? { ...linkRef, textCopied: true, textHash: textFingerprint(spell.notes) } : copyRefOf(copy, spell.notes)) : null;
  const ref = marked ?? linkRef;
  if (!entry) return { ...base, ...defined({ ritual: spell.ritual, concentration: spell.concentration, notes: spell.notes }), ...(ref ? { ref } : {}) };
  const flag = (value: unknown, given: boolean | undefined) => (typeof value === 'boolean' ? value : given);
  const ritual = flag(entry.data?.ritual, spell.ritual);
  const concentration = flag(entry.data?.concentration, spell.concentration);
  const homebrewId = spellHomebrewId(entry);
  return {
    id: entry.id,
    ...base,
    ...(ritual ? { ritual } : {}),
    ...(concentration ? { concentration } : {}),
    ...defined({ notes: spell.notes }),
    ...(ref ? { ref } : {}),
    ...(homebrewId ? { homebrewId } : {}),
  };
}

function spellSteps(input: ToolInput<'update_character'>, links: Links): ((c: Character) => EngineResult)[] {
  const steps: ((c: Character) => EngineResult)[] = [];
  for (const slot of input.spell_slots_spend ?? []) {
    steps.push((c) => spendSlot(c, slot.level as SpellSlotLevel, { pact: slot.pact }));
  }
  for (const slot of input.spell_slots_restore ?? []) {
    steps.push((c) => restoreSlot(c, slot.level as SpellSlotLevel, 1, { pact: slot.pact }));
  }
  if (input.concentration !== undefined) {
    const spell = input.concentration;
    steps.push((c) => setConcentration(c, spell));
  }
  for (const name of input.spells_remove ?? []) steps.push((c) => removeSpell(c, name));
  (input.spells_add ?? []).forEach((spell, i) => {
    const add = addedSpell(spell, links.spells[i] ?? null, links.spellCopies[i] ?? null);
    steps.push((c) => {
      // addSpell merges into a spell already on the sheet: re-added without notes (to change prepared or level), it keeps
      // its notes, so it keeps their copy mark too. It keeps its id as well, so it stays the entry that id names: a
      // homebrew id joins it only when it is that id (a book's spell re-added once homebrew holds its name stays the book's).
      // And it keeps its source and prepared flag unless the call gives them: the defaults would make a class's own pick
      // one "Granted in play", prepared, which that class's count no longer sees (spellPicks.ts classSpellsOf). A
      // spellbook's extra keeps its source ("Wizard (copied)") when the call gives the class's own name, as a DM preparing
      // it does: it stays outside the two each level adds (keepsBookExtra).
      const had = c.spellcasting?.spells.find((s) => nameKey(s.name) === nameKey(spell.name));
      const { homebrewId, source, ...rest } = !spell.notes && had?.ref?.textCopied ? { ...add, ref: had.ref } : add;
      const resourced = spell.source !== undefined && !(had && keepsBookExtra(c, had.source, spell.source, links.classes));
      const own = had ? { ...rest, prepared: spell.prepared ?? had.prepared, ...(resourced ? { source } : {}) } : { ...rest, source };
      return addSpell(c, homebrewId && (!had || had.id === homebrewId) ? { ...own, homebrewId } : own);
    });
  });
  return steps;
}

function featureSteps(input: ToolInput<'update_character'>, links: Links): ((c: Character) => EngineResult)[] {
  const steps: ((c: Character) => EngineResult)[] = [];
  for (const f of input.features_use ?? []) steps.push((c) => useFeature(c, f.name, f.amount));
  for (const f of input.features_restore ?? []) steps.push((c) => restoreFeature(c, f.name, f.amount));
  (input.features_add ?? []).forEach((f, i) => {
    steps.push((c) => {
      // The DM's words about a book's feat or part: the ref lets exports leave them out and restore refill the book's
      // text. A rewrite keeps the rewritten feature's own ref when its text holds at least as many of the DM's words as
      // the book's best match (a trait or a printed style resent as the sheet holds it, or a ruling quoting it), so
      // restore refills its text, not another's.
      const rewritten = featureToRewrite(c, f);
      const match = links.feats[i];
      const own = rewritten?.ref?.textCopied ? runsIn(runsOf(f.description), rewritten.description) : 0;
      const ref = rewritten?.ref && own > 0 && own >= (match?.runs ?? 0) ? rewritten.ref : match?.ref;
      return addFeature(c, {
        name: f.name,
        description: f.description,
        source: f.source,
        sourceName: 'Granted in play',
        ...(f.uses_max ? { uses: { max: f.uses_max, used: 0, recharge: f.recharge ?? 'long' } } : {}),
        ...(ref ? { ref } : {}),
      });
    });
  });
  return steps;
}

/**
 * A line for each feature the call added beside one featureToRewrite keeps apart (an entry that rewrote another feature
 * added nothing): a transformation's own power, which stays the transformation's and is changed with transform_character;
 * or, for a species trait or class feature, the Alert or Tough feat recorded on neither side of the feat line, which
 * stays the feat with its numbers (the trait's entry didn't replace it).
 */
function besideLines(before: Character, after: Character): string[] {
  const had = new Set(before.features.map((f) => f.id));
  return after.features.flatMap((f) => {
    if (had.has(f.id)) return [];
    const named = (o: Feature) => nameKey(o.name) === nameKey(f.name);
    const power = before.features.find((p) => p.source === 'transformation' && named(p));
    if (power) {
      const owner = power.sourceName ?? 'the transformation';
      return [`${f.name} joined the sheet beside ${owner}'s own ${power.name}, and stays when ${owner} ends; to change ${owner}'s, use transform_character advance.`];
    }
    // Only a species trait's or class feature's entry joins beside one: any other entry of its name rewrites it.
    const feat = before.features.find((o) => named(o) && !featOrTrait(o.source) && (isAlertFeat(o) || isToughFeat(o)));
    if (!feat) return [];
    const numbers = isAlertFeat(feat) ? 'Initiative bonus' : 'Hit Points';
    return [
      `${f.name} joined the sheet beside ${featureLabel(feat, after.features)}, which stays the ${feat.name} feat with its ${numbers}: a species trait or class feature doesn't replace it. To change that entry, record it with source "feat".`,
    ];
  });
}

/** "Stable" or "Stabilized", alone or with a detail after it ("Stable (Healer's Kit)", "Stabilized by Brother Aldo"). */
const STABLE_NAME = /^(?:stable|stabili[sz]ed?)(?=$|[\s(:,.\-–—])/i;

/** The detail after a Stable name's word, without its separators ("Stable — Healer's Kit": "Healer's Kit"). */
const stableDetail = (name: string, matched: string): string => name.slice(matched.length).replace(/^[\s(:,.\-–—]+|[\s).]+$/g, '');

/**
 * "Stable" isn't a condition: added, it records that another creature stabilized the dying hero (SRD 5.2.1 Stabilizing
 * a Character), the detail saying how. With a detail it means that only at 0 HP: a hero with HP keeps a homebrew effect
 * so named ("Stable Footing").
 */
function addStable(c: Character, name: string, matched: string, cond: { source?: string; duration?: string }): EngineResult {
  const detail = stableDetail(name, matched);
  if (detail && c.hp.current > 0) return addCondition(c, { id: name, ...defined({ source: cond.source, duration: cond.duration }) });
  return stabilize(c, cond.source ?? (detail || undefined));
}

/** Removing "Stable" changes nothing and says why; a homebrew condition by that name (an older save's) is removed. */
function removeStable(c: Character, name: string): EngineResult {
  if (!c.deathSaves.stable || c.conditions.some((x) => conditionKey(x.id) === conditionKey(name))) return removeCondition(c, name);
  const message =
    "Stable isn't a condition to remove: the hero stays Stable until damage starts the death saves again or healing brings them back (a mark made by mistake: the player can clear it with the death-save marks on their sheet).";
  return { character: c, events: [{ type: 'warning', message }] };
}

/**
 * A line for each Stable name with a detail that a hero with HP kept as a homebrew condition ("Stable (Healer's Kit)"
 * in the call that heals them): it marks no stabilization, and nothing else tells the DM so.
 */
function keptStableLines(added: readonly { condition: string }[] | undefined, c: Character): string[] {
  if (c.hp.current <= 0) return [];
  const lines = (added ?? []).flatMap(({ condition }) => {
    const name = condition.trim();
    const matched = STABLE_NAME.exec(name)?.[0];
    if (!matched || !stableDetail(name, matched) || !c.conditions.some((x) => conditionKey(x.id) === conditionKey(name))) return [];
    return [
      `Kept "${name}" as a homebrew condition: the hero has ${c.hp.current} HP, so it marks no stabilization (only a creature at 0 HP can be stabilized). If it meant one, remove it with conditions_remove "${name}".`,
    ];
  });
  return [...new Set(lines)];
}

/**
 * The engine gets the DM's own name and matches it strictly: "Poisoned" or "Frightened of the dragon" is that
 * condition (the detail its source), while "Protection from Poison" stays a homebrew condition by that name.
 */
function conditionSteps(input: ToolInput<'update_character'>): ((c: Character) => EngineResult)[] {
  const steps: ((c: Character) => EngineResult)[] = [];
  let exhaustion = input.exhaustion_change ?? 0;
  for (const raw of input.conditions_remove ?? []) {
    const name = raw.trim();
    if (isExhaustion(name)) exhaustion -= 1;
    else steps.push((c) => (STABLE_NAME.test(name) ? removeStable(c, name) : removeCondition(c, name)));
  }
  for (const cond of input.conditions_add ?? []) {
    if (isExhaustion(cond.condition)) {
      exhaustion += 1;
      continue;
    }
    const name = cond.condition.trim();
    const stable = STABLE_NAME.exec(name);
    if (stable) {
      steps.push((c) => addStable(c, name, stable[0], cond));
      continue;
    }
    steps.push((c) => addCondition(c, { id: name, ...defined({ source: cond.source, duration: cond.duration }) }));
  }
  if (exhaustion !== 0) steps.push((c) => changeExhaustion(c, exhaustion));
  return steps;
}

/** Events for direct stat edits that have no engine function (AC, speed). */
function statEvent(message: string): GameEvent {
  return { type: 'combat', message };
}

/** The formula of an AC the DM set by hand ("set by the DM: Mage Armor"), from the call's reason. */
function handSetFormula(reason: string | undefined): string {
  const why = reason?.replace(/\s+/g, ' ').trim();
  return why ? `set by the DM: ${truncate(why, 60)}` : 'set by the DM';
}

/**
 * armor_class: an AC the gear and features don't give (Mage Armor, Shield of Faith) gets a formula saying the DM set
 * it, so the sheet never shows the old formula's items and armor under a number they don't add up to (the DM's
 * "Bonuses" rule reads the formula); an AC they do give gets their formula back.
 */
function statSteps(input: ToolInput<'update_character'>, catalog: readonly EquipmentOption[] = []): ((c: Character) => EngineResult)[] {
  const steps: ((c: Character) => EngineResult)[] = [];
  if (input.armor_class !== undefined) {
    const ac = input.armor_class;
    steps.push((c) => {
      const gear = computeArmorClass(c, catalog);
      const acFormula = gear.ac === ac ? gear.formula : handSetFormula(input.reason);
      return { character: { ...c, armorClass: ac, acFormula }, events: [statEvent(`AC ${c.armorClass} → ${ac}`)] };
    });
  }
  if (input.speed !== undefined) {
    const speed = input.speed;
    steps.push((c) => ({ character: { ...c, speed }, events: [statEvent(`Speed ${c.speed} ft. → ${speed} ft.`)] }));
  }
  if (input.initiative_change !== undefined) {
    const delta = input.initiative_change;
    steps.push((c) => changeInitiativeBonus(c, delta));
  }
  return steps;
}

// -- abilities and proficiencies ---------------------------------------------

const PROFICIENCY: Record<'none' | 'half' | 'proficient' | 'expertise', ProficiencyLevel> = { none: 0, half: 0.5, proficient: 1, expertise: 2 };
const PROFICIENCY_NAME: Record<number, string> = { 0: 'not proficient', 0.5: 'half proficiency', 1: 'proficient', 2: 'expertise' };

export function setSkillProficiency(c: Character, skill: Skill, level: keyof typeof PROFICIENCY): EngineResult {
  const before = c.skills[skill] ?? 0;
  const next = PROFICIENCY[level];
  if (before === next) return { character: c, events: [] };
  const skills = { ...c.skills };
  if (next === 0) delete skills[skill];
  else skills[skill] = next;
  return { character: { ...c, skills }, events: [statEvent(`${SKILL_NAMES[skill]}: ${PROFICIENCY_NAME[before]} → ${PROFICIENCY_NAME[next]}`)] };
}

/** Add strings to a list (case-insensitively new ones only). */
function addTo(list: readonly string[], items: readonly string[]): string[] {
  const out = [...list];
  for (const item of items) {
    const clean = item.trim();
    if (clean && !out.some((x) => x.toLowerCase() === clean.toLowerCase())) out.push(clean);
  }
  return out;
}

function proficiencySteps(input: ToolInput<'update_character'>): ((c: Character) => EngineResult)[] {
  const steps: ((c: Character) => EngineResult)[] = [];
  for (const a of input.ability_scores ?? []) steps.push((c) => changeAbilityScore(c, a.ability, a.change, a.max ?? 20));
  for (const p of input.skill_proficiencies ?? []) steps.push((c) => setSkillProficiency(c, p.skill, p.level));
  if (input.saving_throws_add?.length) {
    const saves = input.saving_throws_add;
    steps.push((c) => {
      const added = saves.filter((a) => !c.savingThrows.includes(a));
      if (!added.length) return { character: c, events: [] };
      return {
        character: { ...c, savingThrows: [...c.savingThrows, ...added] },
        events: [statEvent(`Saving throw proficiency: ${added.map((a) => ABILITY_NAMES[a]).join(', ')}`)],
      };
    });
  }
  if (input.tools_add?.length) {
    const tools = input.tools_add;
    steps.push((c) => {
      const next = addTo(c.tools, tools);
      return next.length === c.tools.length ? { character: c, events: [] } : { character: { ...c, tools: next }, events: [statEvent(`Tool proficiency: ${next.slice(c.tools.length).join(', ')}`)] };
    });
  }
  if (input.languages_add?.length) {
    const languages = input.languages_add;
    steps.push((c) => {
      const next = addTo(c.languages, languages);
      return next.length === c.languages.length
        ? { character: c, events: [] }
        : { character: { ...c, languages: next }, events: [statEvent(`Languages: ${next.slice(c.languages.length).join(', ')}`)] };
    });
  }
  return steps;
}

/** The change may affect Armor Class: an ability score, what is equipped or attuned, or a feature it reads (Defense). */
function mayChangeArmorClass(input: ToolInput<'update_character'>): boolean {
  return (
    Boolean(input.ability_scores?.length || input.features_add?.length) ||
    (input.inventory_update ?? []).some((i) => i.equipped !== undefined || i.attuned !== undefined)
  );
}

/**
 * Recompute AC after a change that may affect it (engine computeArmorClass). The sheet's AC is
 * replaced only when it matched the computed value before (no hand-set AC like Mage Armor's);
 * otherwise it stays, with a note of what the armor and scores now give.
 */
export function refreshArmorClass(before: Character, after: Character, catalog: readonly EquipmentOption[] = [], acGiven = false): EngineResult {
  // An AC the call set (armor_class, the same value restated too) is the DM's final word.
  if (acGiven || after.armorClass !== before.armorClass) return { character: after, events: [] };
  const was = computeArmorClass(before, catalog);
  const now = computeArmorClass(after, catalog);
  if (now.ac === was.ac) return { character: after, events: [] };
  if (before.armorClass !== was.ac) {
    // Armor whose stats aren't known gives nothing to compare: the engine keeps the sheet's AC for it.
    const unknown = unknownWornArmor(after, catalog);
    // Set by hand to what the gear and features now give: the DM's own +1 before it recorded Defense, or a spell's AC the
    // new gear only matches (Shield of Faith, then a shield donned). Which, only the DM knows: say so either way.
    const message = unknown
      ? `AC stays ${after.armorClass} (set by hand): ${unknown.name}'s armor stats are unknown, so set armor_class by hand.`
      : now.ac === after.armorClass
        ? `AC ${after.armorClass} stays as set by hand; armor and features now give ${now.ac} too (${now.formula}). If the hand-set AC counted a bonus that still applies (a spell such as Shield of Faith), set armor_class to include it.`
        : `AC stays ${after.armorClass} (set by hand); by armor and ability scores it would now be ${now.ac} (${now.formula}). Set armor_class if that is right.`;
    return { character: after, events: [{ type: 'warning', message }] };
  }
  return { character: { ...after, armorClass: now.ac, acFormula: now.formula }, events: [statEvent(`AC ${before.armorClass} → ${now.ac} (${now.formula})`)] };
}

function buildSections(input: ToolInput<'update_character'>, links: Links = NO_LINKS): Section[] {
  const sections: Section[] = [];
  const add = (icon: ToolActivityIcon, steps: ((c: Character) => EngineResult)[]) => {
    if (steps.length > 0) sections.push({ icon, apply: (c) => chain(c, steps) });
  };
  if (input.hp) sections.push(hpSection(input.hp, input.reason));
  if (input.hp_max_end?.length) sections.push(hpMaxEndSection(input.hp_max_end, input.reason));
  if (input.hp_max) sections.push(hpMaxSection(input.hp_max, input.reason));
  add('condition', conditionSteps(input));
  add('spell', spellSteps(input, links));
  add('info', featureSteps(input, links));
  add('item', inventorySteps(input, links));
  if (input.currency_change) {
    const delta = defined(input.currency_change) as Partial<Currency>;
    add('coin', [(c) => changeCurrency(c, delta)]);
  }
  if (input.xp_gain !== undefined) {
    const xp = input.xp_gain;
    add('xp', [(c) => gainXp(c, xp)]);
  }
  if (input.heroic_inspiration !== undefined) {
    const value = input.heroic_inspiration;
    add('xp', [
      (c) => ({
        character: { ...c, heroicInspiration: value },
        events: [
          { type: 'inspiration', message: value ? 'Heroic Inspiration gained' : 'Heroic Inspiration spent' },
        ],
      }),
    ]);
  }
  add('level', proficiencySteps(input));
  add('info', statSteps(input, links.catalog));
  return sections;
}

/** One log line from several engine messages: "Spent a slot · Concentrating on Fly". */
function joinMessages(events: readonly GameEvent[]): string {
  return truncate(events.map((e) => e.message.trim().replace(/\.$/, '')).filter(Boolean).join(' · '), 160);
}

async function logSections(ctx: ToolContext, results: SectionResult[], reason?: string): Promise<void> {
  for (const r of results) {
    const changes = changesOf(r.events);
    const warnings = warningsOf(r.events).map((w) => w.message);
    const summary = r.section.summary ? r.section.summary(r.before, r.after) : joinMessages(changes);
    if (!summary) continue;
    const detailParts = [
      r.section.summary || summary.endsWith('…') ? changes.map((e) => e.message).join('\n') : '',
      warnings.length ? `Warnings: ${warnings.join('; ')}` : '',
      reason && !r.section.summary ? `Reason: ${reason}` : '',
    ].filter(Boolean);
    await logTool(ctx, 'update_character', r.section.icon, summary, { detail: detailParts.join('\n') || undefined });
  }
}

export async function updateCharacterTool(input: ToolInput<'update_character'>, ctx: ToolContext): Promise<ToolOutcome> {
  if (input.hp?.drain && input.hp.kind !== 'damage') throw new ToolInputError('hp.drain lowers the HP maximum by the damage taken, so it needs kind "damage".');
  if (buildSections(input).length === 0) throw new ToolInputError('Nothing to change: include at least one section (hp, hp_max, conditions_add, inventory_add, …).');
  const links = await resolveLinks(input, ctx);
  const sections = buildSections(input, links);
  let results: SectionResult[] = [];
  const checkAc = mayChangeArmorClass(input);
  const before = requireCharacter(ctx.deps.store());
  // Spells recorded for a class whose spell choices are open settle them, as the level_up result says (the class data
  // counts what is still owed; without it the choices stay as they are).
  const recordsSpells = Boolean(input.spells_add?.length || input.spells_remove?.length);
  const classData = recordsSpells && before.spellcasting?.spellPicks?.length ? await loadBuilderOrNull(ctx) : null;
  let settled: SettledPicks[] = [];
  const change = await mutateCharacter(ctx, (start) => {
    results = [];
    settled = [];
    let current = start;
    for (const section of sections) {
      const r = section.apply(current);
      results.push({ section, before: current, after: r.character, events: r.events });
      current = r.character;
    }
    if (checkAc) {
      const r = refreshArmorClass(start, current, links.catalog, input.armor_class !== undefined);
      if (r.events.length) results.push({ section: { icon: 'info', apply: () => r }, before: current, after: r.character, events: r.events });
      current = r.character;
    }
    if (classData) {
      const r = settleSpellPicks(start, current, classData.classes);
      current = r.character;
      settled = r.settled;
    }
    return { character: current };
  });
  await logSections(ctx, results, input.reason);

  const lines = results.flatMap((r) => eventLines(r.events)).filter(Boolean);
  // For the DM only (the player's log keeps the change itself).
  lines.push(...besideLines(before, change.character));
  lines.push(...untilEndedLines(before, change.character));
  if (input.initiative_change && ctx.deps.store().combat?.active) {
    lines.push('The initiative already rolled for this fight stays; the new bonus counts from the next Initiative roll.');
  }
  // For the DM only: whether the class's spell choices are done (the sheet's reminder clears) or what is left.
  for (const p of settled) lines.push(p.owed ? `Spell choices still open: ${owedSpellsLine(p.owed)}` : `Spell choices for ${p.className} ${p.level} recorded: nothing left to choose.`);
  lines.push(...keptHomebrewLines(input.conditions_add, change.character.conditions));
  lines.push(...keptStableLines(input.conditions_add, change.character));
  const saves = saveSourcesChangeText(before, change.character);
  if (saves) lines.push(`${saves}.`);
  const campaign = ctx.deps.store().campaign;
  if (input.xp_gain !== undefined && campaign && !campaign.settings.milestoneLeveling && xpToNextLevel(change.character) === 0) {
    lines.push('The hero has enough XP to level up: call level_up at a fitting moment.');
  }
  // A size change during a mapped fight re-fits the hero's space (D39).
  const mapLine = await refitHeroAfterSheetChange(ctx, before, change.character);
  if (mapLine) lines.push(mapLine);
  lines.push(`Status: ${characterStatusLine(change.character)}`);
  return ok(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// take_rest
// ---------------------------------------------------------------------------

function remainingDice(c: Character): HitDie[] {
  return c.hitDice
    .filter((h) => h.total - h.spent > 0)
    .map((h) => h.die)
    .sort((a, b) => b - a);
}

/** Auto roll mode: spend the largest remaining Hit Dice until HP is full or none remain. */
function autoSpendHitDice(ctx: ToolContext, start: Character): { character: Character; spent: number; healed: number; events: GameEvent[] } {
  let character = start;
  let spent = 0;
  let healed = 0;
  const events: GameEvent[] = [];
  while (character.hp.current < character.hp.max) {
    const [die] = remainingDice(character);
    if (!die) break;
    const r = spendHitDie(character, die, { rng: ctx.deps.rng });
    if (!r.roll) break;
    character = r.character;
    spent += 1;
    healed += r.healed;
    events.push(...r.events);
  }
  return { character, spent, healed, events };
}

async function askShortRest(ctx: ToolContext, c: Character, reason?: string): Promise<{ die: HitDie; roll: RollResult }[]> {
  const store = ctx.deps.store();
  ctx.status('Waiting for you to spend Hit Dice…', 'waiting-player');
  try {
    const response = await store.requestInteraction({
      kind: 'short-rest',
      id: ctx.deps.newId(),
      hitDice: c.hitDice,
      conMod: abilityModifier(c.abilityScores.con),
      ...(reason ? { reason } : {}),
    });
    if (response.kind !== 'short-rest') return [];
    return response.response.spent.map((s) => ({ die: s.die as HitDie, roll: s.roll }));
  } catch (err) {
    if (ctx.signal.aborted) throw new DmCancelledError();
    throw err;
  } finally {
    ctx.status('Resting…', 'tool');
  }
}

async function shortRest(ctx: ToolContext, reason?: string): Promise<ToolOutcome> {
  const store = ctx.deps.store();
  const campaign = requireCampaign(store);
  const before = requireCharacter(store);
  const auto = campaign.settings.playerRollMode === 'auto';
  const chosen = auto ? [] : await askShortRest(ctx, before, reason);

  const change = await mutateCharacter(ctx, (c) => {
    let spent = 0;
    let healed = 0;
    const events: GameEvent[] = [];
    let character = c;
    if (auto) {
      const r = autoSpendHitDice(ctx, character);
      ({ character, spent, healed } = r);
      events.push(...r.events);
    } else {
      for (const s of chosen) {
        const r = spendHitDie(character, s.die, { roll: s.roll });
        character = r.character;
        if (r.roll) spent += 1;
        healed += r.healed;
        events.push(...r.events);
      }
    }
    const rest = applyShortRest(character);
    return { character: rest.character, events: [...events, ...rest.events], spent, healed };
  });

  const summary = `Short rest: ${plural(change.spent, 'Hit Die', 'Hit Dice')} spent, +${change.healed} HP (HP ${before.hp.current} → ${change.character.hp.current})`;
  await logTool(ctx, 'take_rest', 'rest', summary, { detail: [reason, ...eventLines(change.events)].filter(Boolean).join('\n') });
  return ok([summary, ...eventLines(change.events), `Status: ${characterStatusLine(change.character)}`].join('\n'));
}

/**
 * For the DM after a Long Rest: the hero's classes whose own Spellcasting text lets their prepared spells change now
 * (SRD 5.2.1 srd:rule:gaining-spells, "Preparing Spells": a Cleric or Druid any, a Paladin or Ranger one, a Wizard any
 * from its spellbook and one cantrip; classSpellRules reads it), and how to record what the player names. Null when no
 * class has one. A spellbook's spells stay in the book: a Wizard prepares them by name, keeping each one's source (a
 * copied spell's "Wizard (copied)" keeps it outside the two each level adds), so spells_remove isn't for them.
 */
function restSpellLine(c: Character, data: BuilderData): string | null {
  const books: string[] = [];
  const parts = c.classes.flatMap((cl) => {
    const cls = classOptionFor(cl, data.classes);
    if (!cls) return [];
    const { spells, fromSpellbook, cantrip } = classSpellRules(cls).longRest;
    if (spells && fromSpellbook) books.push(cl.name);
    const what = [...(spells ? [`${spells}${fromSpellbook ? ' from the spellbook' : ''}`] : []), ...(cantrip ? ['one cantrip'] : [])];
    return what.length ? [`${cl.name} (${what.join('; ')})`] : [];
  });
  if (!parts.length) return null;
  const copied = books.map((b) => `"${b} (copied)"`).join(' or ');
  const book = books.length
    ? ` (the ${books.join(' and ')}'s spellbook spells stay in the book: re-add one by name with prepared true or false and no source, so it keeps its own; a spell newly copied into the book takes source ${copied})`
    : '';
  return `The player may now change prepared spells on their sheet: ${parts.join(', ')}. Record any they tell you with update_character spells_remove and spells_add, source the class's name${book}.`;
}

async function longRest(ctx: ToolContext, reason?: string): Promise<ToolOutcome> {
  const change = await mutateCharacter(ctx, (c) => applyLongRest(c));
  const died = change.character.deathSaves.dead;
  const summary = died ? 'Long rest: the hero died (an HP maximum reached 0)' : 'Long rest: HP, Hit Dice and spell slots restored';
  await logTool(ctx, 'take_rest', 'rest', summary, { detail: [reason, ...eventLines(change.events)].filter(Boolean).join('\n') });
  // For the DM only: what the rest didn't end, and nothing else will.
  const kept = died ? [] : hpMaxAdjustments(change.character).filter((a) => a.ends === 'when-ended');
  const curse = kept.some((a) => a.amount < 0)
    ? ' A reduction whose cause only kept a Long Rest from restoring it (a Mummy\'s curse, a Death Dog\'s poison) returns at the next Long Rest once the cause ends: then switch it to end there (hp_max_end with an hp_max of the same name, change and ends "long-rest", in one call).'
    : '';
  const keptLine = kept.length
    ? [`Still in effect after the rest: ${kept.map((a) => `${a.name} ${formatModifier(a.amount)} (until ended)`).join(', ')}. End each with update_character hp_max_end when its time runs out or its cause ends.${curse}`]
    : [];
  // And the prepared spells the hero's classes may change now (their own text, from the builder data; none without it).
  const data = died ? null : await loadBuilderOrNull(ctx);
  const spellLine = data ? restSpellLine(change.character, data) : null;
  return ok([summary, ...eventLines(change.events), ...keptLine, ...(spellLine ? [spellLine] : []), `Status: ${characterStatusLine(change.character)}`].join('\n'));
}

/**
 * Why the hero can't start this rest, or null. A rest needs at least 1 HP (SRD 5.2.1 Short Rest, Long Rest), so the
 * refusal comes before any log line or Hit Dice dialog, with the way back for a Stable hero: one who isn't healed
 * regains 1 HP after 1d4 hours (SRD 5.2.1 Stabilizing a Character).
 */
function restRefusal(c: Character, kind: ToolInput<'take_rest'>['kind']): string | null {
  if (c.deathSaves.dead) return "The hero is dead; the dead don't rest.";
  if (c.hp.current >= 1) return null;
  const rest = kind === 'short' ? 'A Short Rest' : 'A Long Rest';
  // SRD 5.2.1 Stabilizing a Character: only a Stable hero comes back on their own; a dying one keeps rolling, unless
  // another creature stabilized them (the Help action's Medicine check, a Healer's Kit, Spare the Dying), which the DM
  // marks with conditions_add "Stable".
  if (!c.deathSaves.stable) {
    return `${rest} needs at least 1 HP (SRD 5.2.1). The sheet has the hero dying, not Stable: death saving throws go on (request_player_roll "death-save") until three successes make them Stable, a natural 20 or any healing (update_character hp healing) brings them back, or three failures kill them. If another creature stabilized them (the Help action's DC 10 Wisdom (Medicine) check, a Healer's Kit, Spare the Dying), mark it with update_character conditions_add "Stable", then roll_dice 1d4 for the hours, update_character hp healing 1, and take_rest.`;
  }
  return `${rest} needs at least 1 HP (SRD 5.2.1). A Stable hero who isn't healed regains 1 HP after 1d4 hours: roll_dice 1d4 for the hours, update_character hp healing 1, then take_rest.`;
}

export async function takeRestTool(input: ToolInput<'take_rest'>, ctx: ToolContext): Promise<ToolOutcome> {
  if (ctx.deps.store().combat?.active) return fail('The hero cannot rest during combat. End the combat first.');
  const refusal = restRefusal(requireCharacter(ctx.deps.store()), input.kind);
  if (refusal) return fail(refusal);
  return input.kind === 'short' ? shortRest(ctx, input.reason) : longRest(ctx, input.reason);
}

// ---------------------------------------------------------------------------
// level_up
// ---------------------------------------------------------------------------

/** Features whose maximum uses changed in a level-up ("Rage: 2 → 3 uses"). */
function updatedUses(before: Character, after: Character): string[] {
  const lines: string[] = [];
  for (const feature of after.features) {
    const old = before.features.find((f) => f.id === feature.id);
    if (!old?.uses || !feature.uses || old.uses.max === feature.uses.max) continue;
    lines.push(`${feature.name}: ${old.uses.max} → ${feature.uses.max} uses`);
  }
  return lines;
}

/** What the merged builder data says about a level_up (spec §5.5); null without data or for a class it lacks. */
interface DataLevel {
  option: ClassOption;
  existing?: ClassLevel;
  classLevel: number;
  /** The subclass the call names (resolved by name among the class's subclasses), or the hero's. */
  sub?: SubclassOption;
  /** The call chooses the subclass now (catch-up applies). */
  subclassChosenNow: boolean;
  /** Features taken from the data: an imported class's, and an imported subclass's (with catch-up). */
  features: Omit<Feature, 'id'>[];
  /** "Two classes are named Fighter (SRD 5.2.1, The Gloamwood Almanac); used the hero's own." */
  tie: string | null;
}

const COUNT_WORDS = ['', 'One', 'Two', 'Three', 'Four', 'Five'];

function tieNote(option: ClassOption, classes: readonly ClassOption[], own: boolean): string | null {
  const named = classes.filter((o) => nameKey(o.name) === nameKey(option.name));
  if (named.length < 2) return null;
  const count = COUNT_WORDS[named.length] ?? String(named.length);
  return `${count} classes are named ${option.name} (${named.map(optionSourceLabel).join(', ')}); used ${own ? "the hero's own" : `the one from ${optionSourceLabel(option)}`}.`;
}

/** "Two subclasses of Fighter are named Champion (SRD 5.2.1, The Gloamwood Almanac); used the one from SRD 5.2.1." */
function subclassTieNote(option: ClassOption, sub: SubclassOption | undefined, name: string): string | null {
  const named = subclassesOf(option).filter((s) => nameKey(s.name) === nameKey(name));
  if (named.length < 2) return null;
  const count = COUNT_WORDS[named.length] ?? String(named.length);
  const used = sub ? `used the one from ${optionSourceLabel(sub)}` : 'used the name only';
  return `${count} subclasses of ${option.name} are named ${named[0].name} (${named.map(optionSourceLabel).join(', ')}); ${used}.`;
}

function planFromData(c: Character, data: BuilderData, input: ToolInput<'level_up'>): DataLevel | null {
  const key = nameKey(input.class_name);
  const existing = c.classes.find((cl) => nameKey(cl.name) === key);
  const option = existing ? classOptionFor(existing, data.classes) : classByName(data.classes, input.class_name, c).option;
  if (!option) return null;
  const classLevel = (existing?.level ?? 0) + 1;
  // Naming the hero's own subclass again chooses nothing: it stays the one its id names (B2), so a book's
  // "Champion" never turns into the SRD's. Only a new name is looked up among the class's subclasses.
  const subclassChosenNow = Boolean(input.subclass) && nameKey(existing?.subclass ?? '') !== nameKey(input.subclass ?? '');
  const sub = subclassChosenNow ? subclassByName(input.subclass ?? '', option) : existing ? subclassOptionFor(existing, option, data.classes) : undefined;
  // A multiclass hero's other classes' subclasses: a feature of one of theirs isn't this subclass's.
  const otherSubclasses = c.classes.filter((cl) => cl !== existing).flatMap((cl) => (cl.subclass ? [cl.subclass] : []));
  const all = gainedFeatures(option, classLevel, sub, { scores: c.abilityScores, characterLevel: characterLevel(c) + 1 }, { have: c.features, subclassChosenNow, otherSubclasses });
  // SRD classes and subclasses keep today's DM-supplied features: only a book's come from the data, and an SRD
  // subclass's under a book's class (a 2024 book's class also offers the SRD's subclasses, as the dialog adds them).
  const features = all.filter((f) => (f.source === 'subclass' ? Boolean(sub?.source) || Boolean(option.source) : Boolean(option.source)));
  const ties = [tieNote(option, data.classes, Boolean(existing)), subclassChosenNow ? subclassTieNote(option, sub, input.subclass ?? '') : null];
  return { option, existing, classLevel, sub, subclassChosenNow, features, tie: ties.filter(Boolean).join(' ') || null };
}

/**
 * The DM's new_features as sheet features (as today), minus those the data adds with the book's text (`replaced`)
 * and those already on the sheet with a book's text (`kept`: a second, ref-less copy would carry the book's words
 * out in exports). A book part or feat whose words the DM repeats gets its ref (featureRef, as a class feature), so they
 * leave exports too.
 */
function dmFeatures(
  input: ToolInput<'level_up'>,
  level: number,
  plan: DataLevel | null,
  have: readonly Feature[],
  data: BuilderData | null,
  index: RulesIndex | null,
): { features: Omit<Feature, 'id'>[]; replaced: string[]; replacedBySrd: string[]; kept: string[] } {
  // A copied feature on the sheet blocks a second copy only under a name the SRD doesn't print (an SRD class's own
  // "Spellcasting" is not the book's), and only with the data (a failure → today's behavior exactly).
  const srd = srdNameKeys(data);
  const onSheet = new Set(data ? have.filter((f) => f.ref?.textCopied && !srd.has(nameKey(f.name))).map((f) => nameKey(f.name)) : []);
  const fromData = new Set((plan?.features ?? []).map((f) => nameKey(f.name)));
  const all = (input.new_features ?? []).map((f) => {
    const ref = featureRef({ name: f.name, description: f.description, source: 'class' }, data, index)?.ref;
    return {
      name: f.name,
      description: f.description,
      source: 'class' as const,
      sourceName: `${input.class_name} ${level + 1}`,
      ...(f.uses_max ? { uses: { max: f.uses_max, used: 0 as const, recharge: f.recharge ?? ('long' as const) } } : {}),
      ...(ref ? { ref } : {}),
    };
  });
  const replacedAll = all.filter((f) => fromData.has(nameKey(f.name)));
  // A part the data adds without a book's ref is the SRD's (an SRD subclass under a book's class).
  const fromBook = new Set((plan?.features ?? []).filter((f) => f.ref).map((f) => nameKey(f.name)));
  const replaced = replacedAll.filter((f) => fromBook.has(nameKey(f.name)));
  const replacedBySrd = replacedAll.filter((f) => !fromBook.has(nameKey(f.name)));
  const kept = all.filter((f) => !fromData.has(nameKey(f.name)) && onSheet.has(nameKey(f.name)));
  return {
    features: all.filter((f) => !fromData.has(nameKey(f.name)) && !onSheet.has(nameKey(f.name))),
    replaced: replaced.map((f) => f.name),
    replacedBySrd: replacedBySrd.map((f) => f.name),
    kept: kept.map((f) => f.name),
  };
}

/** levelUp's options from the data: the class by id, a new class's numbers and ref, the subclass by id with its ref and casting. */
function dataLevelOptions(plan: DataLevel, data: BuilderData, input: ToolInput<'level_up'>): Partial<LevelUpOptions> {
  const { option, existing, sub } = plan;
  // A subclass chosen now; the hero's own, named again, keeps its id and ref as they are.
  const chosen = plan.subclassChosenNow && sub ? sub : undefined;
  const subclassRef = subclassRefOf(chosen);
  const subclassCasting = subclassCastingOf(chosen);
  const classRef = existing ? undefined : classRefOf(option);
  return {
    className: existing ? input.class_name : option.name,
    classId: existing?.classId ?? option.id,
    ...(existing
      ? {}
      : {
          hitDie: (input.hit_die as HitDie | undefined) ?? option.hitDie,
          casterType: input.caster_type ?? option.casterType,
          ...defined({ spellcastingAbility: input.spellcasting_ability ?? option.spellcastingAbility }),
        }),
    ...(classRef ? { classRef } : {}),
    ...(chosen ? { subclass: chosen.name, subclassId: chosen.id } : {}),
    ...(subclassRef ? { subclassRef } : {}),
    ...(subclassCasting ? { subclassCasting } : {}),
    equipment: data.equipment,
  };
}

/** The result's lines about the books: features added with their text (names only), copies not added, ties. */
function bookLines(plan: DataLevel | null, replaced: string[], replacedBySrd: string[], kept: string[]): string[] {
  const already = kept.length ? [`Already on the sheet with the book's text, kept as they are (uses included): ${kept.join(', ')}.`] : [];
  if (!plan) return already;
  const lines: string[] = [...already];
  const fromBooks = plan.features.filter((f) => f.ref).map((f) => `- ${f.name} (${f.ref?.sourceTitle}) — get_character_sheet has its text`);
  if (fromBooks.length) lines.push("Features from the player's books (added with their text):", ...fromBooks);
  if (replaced.length) lines.push(`Used the book's text instead of your description for: ${replaced.join(', ')}.`);
  if (replacedBySrd.length) lines.push(`Used the SRD's text instead of your description for: ${replacedBySrd.join(', ')}.`);
  if (plan.tie) lines.push(plan.tie);
  return lines;
}

/** What level_up's edit did with the hero's spells (filled inside it, read for the result). */
interface LevelSpells {
  /** Spells now always prepared, with their source: new to the sheet, or held from no class of the hero's (a DM's grant). */
  added: { name: string; source: string }[];
  /**
   * A class's own spells now always prepared: those it counted (prepared) no longer do, so their places are free again;
   * a spellbook's stay in the book (inBook).
   */
  turned: { name: string; className: string; inBook: boolean; counted: boolean }[];
  /** Spells the rules index doesn't have (a book's spell not accepted yet), with what grants them: the DM adds them. */
  missing: { name: string; source: string }[];
  /** What the levelled class may still choose, counted live (null: its table can't be counted). */
  owed: OwedSpells | null;
  /** The levelled class's open choices (null: none open). */
  entry: SpellPicksOwed | null;
  /** Other classes open now for the places their turned spells left. */
  others: ClassPicks[];
}

const noLevelSpells = (): LevelSpells => ({ added: [], turned: [], missing: [], owed: null, entry: null, others: [] });

/**
 * The levelled class's spells, in the level-up's own edit (levelSpellsEdit, SRD 5.2.1 srd:rule:gaining-spells): the
 * always-prepared spells its features and its subclass grant up to its level, added, or turned always prepared where the
 * sheet holds one as an ordinary spell ("a spell that you always have prepared doesn't count against the number of
 * spells on that list", so its place is free again: the class it leaves is marked open too); then the mark that its
 * choices are open, counted after them. The class is the levelled entry: the hero's by its id, or a new one by the
 * option's id levelUp was given. Fills `out`.
 */
function withLevelSpells(c: Character, plan: DataLevel, findSpell: (name: string) => CompendiumEntry | undefined, classes: readonly ClassOption[], out: LevelSpells): Character {
  const classId = plan.existing?.classId ?? plan.option.id;
  const cl = c.classes.find((x) => x.classId === classId);
  if (!cl) return c;
  const r = levelSpellsEdit(c, cl, plan.option, plan.sub, findSpell, classes);
  out.added = r.gain.add.map((s) => ({ name: s.name, source: s.source ?? '' }));
  for (const f of r.gain.flip) {
    // A class's spell it didn't count (unprepared) frees nothing: outside a spellbook it reads as a spell added.
    if (f.owner && (f.counted || f.inBook)) out.turned.push({ name: f.name, className: f.owner, inBook: f.inBook === true, counted: f.counted === true });
    else out.added.push({ name: f.name, source: f.source });
  }
  out.missing = r.gain.missing;
  out.owed = r.owed;
  out.entry = r.entry;
  out.others = r.others;
  return r.character;
}

/** Names grouped by a key, in the order they came: [key, names]. */
function groupNames<T extends { name: string }>(items: readonly T[], key: (item: T) => string): [string, string[]][] {
  const groups = new Map<string, string[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item.name]);
  return [...groups];
}

/** "Divine Smite (Paladin's Smite); Aid, Lesser Restoration (Life Domain)": names by what grants them, in order. */
function namesBySource(spells: readonly { name: string; source: string }[]): string {
  return groupNames(spells, (s) => s.source)
    .map(([source, names]) => `${names.join(', ')}${source ? ` (${source})` : ''}`)
    .join('; ');
}

/**
 * The result's lines about always-prepared spells: "Always prepared now: Divine Smite (Paladin's Smite); Aid, Lesser
 * Restoration (Life Domain).", the class's own picks turned always prepared, and the spells the rules here lack. For the
 * DM (`forDm`) those last say how to add them: with what grants them as the source, so no class counts them (SRD 5.2.1
 * srd:rule:gaining-spells: "a spell that you always have prepared doesn't count against the number of spells on that
 * list"); the player's log names them only.
 */
function alwaysPreparedLines(spells: LevelSpells, forDm: boolean): string[] {
  const lines: string[] = [];
  if (spells.added.length) lines.push(`Always prepared now: ${namesBySource(spells.added)}.`);
  for (const [className, names] of groupNames(spells.turned.filter((s) => !s.inBook), (s) => s.className)) {
    lines.push(`Now always prepared, no longer counted among the ${className}'s spells: ${names.join(', ')}.`);
  }
  // A spellbook still holds its spell (srd:rule:wizard-spellcasting: "The book contains the level 1+ spells you know");
  // only a prepared one was counted.
  for (const [className, names] of groupNames(spells.turned.filter((s) => s.inBook && s.counted), (s) => s.className)) {
    lines.push(`Now always prepared, no longer counted among the ${className}'s prepared spells (still in the spellbook): ${names.join(', ')}.`);
  }
  for (const [className, names] of groupNames(spells.turned.filter((s) => s.inBook && !s.counted), (s) => s.className)) {
    lines.push(`Now always prepared (still in the ${className}'s spellbook): ${names.join(', ')}.`);
  }
  if (spells.missing.length && !forDm) lines.push(`Not in the rules here: ${namesBySource(spells.missing)}.`);
  if (spells.missing.length && forDm) {
    const sources = [...new Set(spells.missing.map((s) => s.source))];
    const how = sources.length === 1 ? `source "${sources[0]}"` : 'each with the source named here';
    const add = spells.missing.length === 1 ? 'If it applies, add it' : 'If they apply, add them';
    lines.push(
      `Not in the rules you can consult: ${namesBySource(spells.missing)}. ${add} with update_character spells_add, ${how} (not a class's name: an always-prepared spell isn't one of its choices).`,
    );
  }
  return lines;
}

export async function levelUpTool(input: ToolInput<'level_up'>, ctx: ToolContext): Promise<ToolOutcome> {
  const store = ctx.deps.store();
  const campaign = requireCampaign(store);
  const before = requireCharacter(store);
  const level = characterLevel(before);
  if (level >= 20) return fail('The hero is already level 20.');
  if (!campaign.settings.milestoneLeveling) {
    const needed = xpToNextLevel(before);
    if (needed !== null && needed > 0) {
      return fail(`This is an XP campaign and the hero needs ${needed} more XP to reach level ${level + 1}. Award XP first, or keep playing.`);
    }
  }
  // Merged builder data (a failure → today's behavior exactly), and the index whenever the data has the class: the
  // always-prepared spells of its features and its subclass (SRD and books alike) are looked up there, and so are the
  // SRD's words in a new feature named like a book's feat (featureRef).
  const data = await loadBuilderOrNull(ctx);
  const plan = data ? planFromData(before, data, input) : null;
  const bookFeat = (input.new_features ?? []).some((f) => data?.feats.some((o) => o.source && nameKey(o.name) === nameKey(f.name)));
  const index = plan || bookFeat ? await loadIndexOrNull(ctx) : null;
  const findSpell = (name: string) => exactEntry(index, campaign, name, 'spell') ?? undefined;
  const { features: extra, replaced, replacedBySrd, kept } = dmFeatures(input, level, plan, before.features, data, index);
  const spells = noLevelSpells();
  const change = await mutateCharacter(ctx, (c) => {
    Object.assign(spells, noLevelSpells());
    const r = levelUp(c, {
      className: input.class_name,
      hpMethod: input.hp_method ?? 'average',
      rng: ctx.deps.rng,
      ...defined({
        subclass: input.subclass,
        hitDie: input.hit_die as HitDie | undefined,
        casterType: input.caster_type,
        spellcastingAbility: input.spellcasting_ability,
      }),
      ...(plan && data ? dataLevelOptions(plan, data, input) : {}),
      // A book's classes (the new one, or one the hero has) have no SRD data: the engine checks their prerequisites from these.
      ...(data ? { multiclassPrimaries: multiclassPrimariesFor(plan?.option, c, data.classes) } : {}),
      newFeatures: [...(plan?.features ?? []), ...extra],
    });
    if (r.character === c || !plan) return r;
    // The older-edition notes of the class and its subclass (a 2014 subclass chosen now) join the sheet's (B6); then the
    // class's always-prepared spells and the mark that its spell choices are open.
    const next = withLevelSpells(withAdaptationNotes(r.character, [plan.option, plan.sub]), plan, findSpell, data?.classes ?? [], spells);
    return next === r.character ? r : { ...r, character: next };
  });
  const className = plan && !plan.existing ? plan.option.name : input.class_name;
  const summary = `Level up! Level ${change.newLevel} (${className}) · HP +${change.hpGained} (max ${change.character.hp.max})`;
  const uses = updatedUses(before, change.character);
  const notes = (change.character.adaptationNotes ?? []).filter((n) => !(before.adaptationNotes ?? []).includes(n));
  const books = (forDm: boolean) => [
    ...bookLines(plan, replaced, replacedBySrd, kept),
    ...alwaysPreparedLines(spells, forDm),
    ...(notes.length ? ['Older-edition notes now on the sheet (app notes):', ...notes.map((n) => `- ${n}`)] : []),
  ];
  // What the class may still choose, from its table and the sheet: it replaces the engine's generic spell line wherever
  // the class could be counted (nothing owed included); a class that can't be counted keeps that line as it is. The
  // player's log gets the choices too, without the DM's note on recording them.
  const { owed, entry } = spells;
  const reminders = owed ? withoutSpellReview(change.reminders, owed.className, owed.level) : change.reminders;
  // The levelled class's choices, then each other class open for a place its turned spell left.
  const picks: ClassPicks[] = [...(owed && entry ? [{ owed, entry }] : []), ...spells.others];
  const choices = picks.map((p) => `Spell choices: ${owedSpellsLine(p.owed, p.entry)}`);
  await logTool(ctx, 'level_up', 'level', summary, { detail: [...eventLines(change.events), ...uses, ...books(false), ...reminders, ...choices].join('\n') || undefined });
  const lines = [summary, ...eventLines(change.events), ...books(true)];
  if (uses.length) lines.push('Limited-use features that grew with the level (already on the sheet):', ...uses.map((u) => `- ${u}`));
  // The numbers of uses the DM ruled, which the level-up left as they are.
  const rulings = keptRulings(change.character);
  if (rulings) lines.push(`${rulings.charAt(0).toUpperCase()}${rulings.slice(1)}.`);
  if (reminders.length) lines.push('Choices the player still needs to make:', ...reminders.map((r) => `- ${r}`));
  picks.forEach((p, i) => lines.push(`${choices[i]} ${recordingHint(p.owed, p.entry)}`));
  const saves = saveSourcesChangeText(before, change.character);
  if (saves) lines.push(`${saves}.`);
  lines.push(`Status: ${characterStatusLine(change.character)}`);
  return ok(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// get_character_sheet
// ---------------------------------------------------------------------------

export async function getCharacterSheetTool(_input: ToolInput<'get_character_sheet'>, ctx: ToolContext): Promise<ToolOutcome> {
  return ok(characterSheetText(requireCharacter(ctx.deps.store())));
}
