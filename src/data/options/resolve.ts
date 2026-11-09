/**
 * Every name lookup for builder options (spec §5.2, pure), with one precedence: id → ref → same book →
 * SRD → other books. An imported id never binds to an SRD option by name, nor the reverse.
 *
 * Owner: E4. SRD options carry no `source`; imported ones carry `source.sourceId` (their book).
 */
import { armorStatsOf } from '@/engine/armorData';
import { nameKey } from '@/lib/id';
import {
  SRD_SOURCE_ID,
  type BackgroundOption,
  type Character,
  type ClassLevel,
  type ClassOption,
  type EquipmentOption,
  type FeatOption,
  type ImportedRef,
  type InventoryItem,
  type ItemCategory,
  type OptionSource,
  type SpeciesOption,
  type SubclassOption,
} from '@/types';
import { describeOption } from './describe';
import { optionKind, refFor } from './refs';

/** A package item matched in the equipment catalog. */
export interface CatalogMatch {
  option: EquipmentOption;
  /** How the package named the item ("Arcane Focus" for "Arcane Focus (Quarterstaff)"). */
  via: 'name' | 'parenthetical' | 'base';
  /** The words outside the parentheses, when matched via the parenthetical. */
  base?: string;
}

export const isImportedId = (id: string | undefined): boolean => Boolean(id?.startsWith('lib:'));

type Sourced = { source?: OptionSource };

/** 0 = the preferred book, 1 = the SRD, 2 = any other book. */
function rank(o: Sourced, preferSourceId: string | undefined): number {
  if (!o.source) return 1;
  return preferSourceId && o.source.sourceId === preferSourceId ? 0 : 2;
}

/** The first item by precedence (same book → SRD → other books), keeping list order within a rank. */
function best<T extends Sourced>(items: readonly T[], preferSourceId?: string): T | undefined {
  let found: T | undefined;
  let foundRank = Infinity;
  for (const item of items) {
    const r = rank(item, preferSourceId);
    if (r < foundRank) {
      found = item;
      foundRank = r;
    }
  }
  return found;
}

/** "Elf (Wood Elf lineage)" → "Elf"; "Magic Initiate (Cleric)" → "Magic Initiate". */
function baseName(name: string): string {
  return name.replace(/\s*\([^()]*\)\s*$/, '').trim() || name.trim();
}

/** Imported options named like the ref's entry, the ref's own book (by id, then by title) first. */
function byRef<T extends { name: string } & Sourced>(ref: ImportedRef | undefined, all: readonly T[]): T | undefined {
  if (!ref) return undefined;
  const key = nameKey(ref.entryName);
  const named = all.filter((o) => o.source && nameKey(o.name) === key);
  return (
    named.find((o) => o.source?.sourceId === ref.sourceId) ??
    named.find((o) => o.source && nameKey(o.source.title) === nameKey(ref.sourceTitle)) ??
    named[0]
  );
}

/** By id; else, for an imported id, by ref (kind + nameKey(entryName), preferring ref.sourceTitle's book); else by name among SRD options only. */
export function classOptionFor(cl: Pick<ClassLevel, 'classId' | 'name' | 'ref'>, classes: readonly ClassOption[]): ClassOption | undefined {
  const byId = classes.find((o) => o.id === cl.classId);
  if (byId) return byId;
  if (isImportedId(cl.classId)) return byRef(cl.ref, classes);
  const key = nameKey(cl.name);
  return classes.find((o) => !o.source && nameKey(o.name) === key);
}

/**
 * By subclassId; else by name only when that name is unique under the class. An imported subclassId
 * only falls back to imported subclasses, an SRD one to SRD subclasses; an entry without an id (made
 * before ids were stored) prefers the SRD subclass of that name when an import shares it.
 */
export function subclassOptionFor(cl: Pick<ClassLevel, 'subclass' | 'subclassId'>, cls: ClassOption | undefined): SubclassOption | undefined {
  if (!cls) return undefined;
  if (cl.subclassId) {
    const byId = cls.subclasses.find((s) => s.id === cl.subclassId);
    if (byId) return byId;
  }
  if (!cl.subclass) return undefined;
  const key = nameKey(cl.subclass);
  let named = cls.subclasses.filter((s) => nameKey(s.name) === key);
  if (cl.subclassId) named = named.filter((s) => Boolean(s.source) === isImportedId(cl.subclassId));
  else if (named.length > 1) named = named.filter((s) => !s.source);
  return named.length === 1 ? named[0] : undefined;
}

function originOptionFor<T extends { id: string; name: string } & Sourced>(
  id: string | undefined,
  name: string,
  ref: ImportedRef | undefined,
  all: readonly T[],
): T | undefined {
  const byId = id ? all.find((o) => o.id === id) : undefined;
  if (byId) return byId;
  if (isImportedId(id)) return byRef(ref, all);
  // "Elf (Wood Elf lineage)" → "Elf": the species string names the lineage after the species.
  const key = nameKey(name.replace(/\s*\(.*$/, ''));
  return key ? all.find((o) => !o.source && nameKey(o.name) === key) : undefined;
}

export function speciesOptionFor(c: Pick<Character, 'species' | 'speciesId' | 'speciesRef'>, all: readonly SpeciesOption[]): SpeciesOption | undefined {
  return originOptionFor(c.speciesId, c.species ?? '', c.speciesRef, all);
}

export function backgroundOptionFor(
  c: Pick<Character, 'background' | 'backgroundId' | 'backgroundRef'>,
  all: readonly BackgroundOption[],
): BackgroundOption | undefined {
  return originOptionFor(c.backgroundId, c.background ?? '', c.backgroundRef, all);
}

/** Exact name, then the base name before "(…)" (origin.ts:53-58); same book → SRD → other books. */
export function findFeat(feats: readonly FeatOption[], name: string, preferSourceId?: string): FeatOption | undefined {
  const key = nameKey(name);
  const exact = best(
    feats.filter((f) => nameKey(f.name) === key),
    preferSourceId,
  );
  if (exact) return exact;
  const base = nameKey(baseName(name));
  return best(
    feats.filter((f) => nameKey(f.name) === base),
    preferSourceId,
  );
}

/** "Daggers" → "dagger", "Pouches" → "pouch", "Rations" → "ration" (package items are often plural). */
function singular(key: string): string {
  if (key.endsWith('ches') || key.endsWith('shes') || key.endsWith('sses')) return key.slice(0, -2);
  if (key.endsWith('ies')) return `${key.slice(0, -3)}y`;
  if (key.endsWith('s') && !key.endsWith('ss')) return key.slice(0, -1);
  return key;
}

/**
 * Find a package item in the catalog: exact or singular name, then "(…)" contents, then the base name
 * (equipment.ts's matching), each step choosing by precedence. Magic options never match a package
 * item (a package's "Chain Mail" is never an imported magic chain mail).
 */
export function findEquipment(name: string, catalog: readonly EquipmentOption[], preferSourceId?: string): CatalogMatch | null {
  const mundane = catalog.filter((o) => !o.magic);
  const lookup = (text: string): EquipmentOption | undefined => {
    const key = nameKey(text);
    if (!key) return undefined;
    const exact = best(
      mundane.filter((o) => nameKey(o.name) === key),
      preferSourceId,
    );
    if (exact) return exact;
    const one = singular(key);
    return (
      best(
        mundane.filter((o) => singular(nameKey(o.name)) === key),
        preferSourceId,
      ) ??
      best(
        mundane.filter((o) => nameKey(o.name) === one),
        preferSourceId,
      ) ??
      best(
        mundane.filter((o) => singular(nameKey(o.name)) === one),
        preferSourceId,
      )
    );
  };
  const direct = lookup(name);
  if (direct) return { option: direct, via: 'name' };
  const paren = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(name);
  if (paren) {
    const inner = lookup(paren[2]);
    if (inner) return { option: inner, via: 'parenthetical', base: paren[1].trim() };
    const outer = lookup(paren[1]);
    if (outer) return { option: outer, via: 'base' };
  }
  return null;
}

/** A catalog option (magic ones included) whose name is exactly `name`; same book → SRD → other books. */
export function findCatalogOption(name: string, catalog: readonly EquipmentOption[], preferSourceId?: string): EquipmentOption | undefined {
  const key = nameKey(name);
  return key ? best(catalog.filter((o) => nameKey(o.name) === key), preferSourceId) : undefined;
}

/** DM-typed class names: the hero's own class first, then SRD, then imports; ties are reported. */
export function classByName(classes: readonly ClassOption[], name: string, c?: Character): { option?: ClassOption; others: ClassOption[] } {
  const key = nameKey(name);
  const named = classes.filter((o) => nameKey(o.name) === key);
  if (!named.length) return { others: [] };
  const own = c?.classes
    .filter((cl) => nameKey(cl.name) === key)
    .map((cl) => classOptionFor(cl, classes))
    .find((o): o is ClassOption => Boolean(o));
  const option = own ?? named.find((o) => !o.source) ?? named[0];
  return { option, others: named.filter((o) => o !== option) };
}

/** Explicit primaryAbilityRule; else 'any' for srd:class:fighter; else 'all'. Replaces ClassStep.tsx:77, LevelUpDialog.tsx:45 and :97. */
export function primaryRuleOf(cls: Pick<ClassOption, 'id' | 'primaryAbilityRule'>): 'all' | 'any' {
  return cls.primaryAbilityRule ?? (cls.id === 'srd:class:fighter' ? 'any' : 'all');
}

/** Review's "Attaches to" default: same book → SRD → a single other book; else ambiguous or missing (blocks Accept). */
export function suggestParentClass(
  parentClass: string,
  sourceId: string,
  classes: readonly { id: string; name: string; sourceId?: string }[],
): { id?: string; reason: 'same-book' | 'srd' | 'other-book' | 'ambiguous' | 'missing'; candidates: { id: string; name: string }[] } {
  const key = nameKey(parentClass);
  const named = key ? classes.filter((c) => nameKey(c.name) === key) : [];
  const candidates = named.map((c) => ({ id: c.id, name: c.name }));
  const isSrd = (c: { sourceId?: string }) => !c.sourceId || c.sourceId === SRD_SOURCE_ID;
  const pick = (list: typeof named, reason: 'same-book' | 'srd' | 'other-book') =>
    list.length === 1 ? { id: list[0].id, reason, candidates } : { reason: 'ambiguous' as const, candidates };
  const sameBook = named.filter((c) => c.sourceId === sourceId);
  if (sameBook.length) return pick(sameBook, 'same-book');
  const srd = named.filter(isSrd);
  if (srd.length) return pick(srd, 'srd');
  if (named.length) return pick(named, 'other-book');
  return { reason: 'missing', candidates };
}

/** "SRD 5.2.1" or the book title. */
export function optionSourceLabel(o: { source?: OptionSource }): string {
  return o.source?.title ?? 'SRD 5.2.1';
}

function itemCategoryOf(option: EquipmentOption): ItemCategory {
  if (option.category === 'pack') return 'gear';
  return option.category;
}

/** "by a Wizard" → "a Wizard" (shown on the item, never enforced). */
function attunementWho(attunement: boolean | string): string | undefined {
  if (typeof attunement !== 'string') return undefined;
  const who = attunement.trim().replace(/^by\s+/i, '').trim();
  return who || undefined;
}

/**
 * Item fields copied onto inventory (numbers, never text): armor, bonuses, requiresAttunement,
 * attunementBy, compendiumId, ref. `catalog` (optional) names a magic item's base in its description.
 */
export function inventoryFromOption(option: EquipmentOption, quantity: number, catalog: readonly EquipmentOption[] = []): Omit<InventoryItem, 'id'> {
  const item: Omit<InventoryItem, 'id'> = { name: option.name, quantity, category: itemCategoryOf(option), compendiumId: option.id };
  if (option.weight !== undefined) item.weight = option.weight;
  const description = describeOption(option, catalog);
  if (description) item.description = description;
  const armor = armorStatsOf(option);
  if (armor) item.armor = armor;
  const magic = option.magic;
  if (magic) {
    item.magic = true;
    if (magic.bonuses && Object.keys(magic.bonuses).length) item.bonuses = { ...magic.bonuses };
    item.requiresAttunement = magic.attunement !== false;
    const who = attunementWho(magic.attunement);
    if (who) item.attunementBy = who;
  }
  const ref = refFor(option, optionKind(option, magic ? 'magic-item' : 'item'));
  if (ref) item.ref = ref;
  return item;
}
