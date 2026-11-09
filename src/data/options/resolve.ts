/**
 * Every name lookup for builder options (spec §5.2, pure), with one precedence: id → ref → same book →
 * SRD → other books. An imported id never binds to an SRD option by name, nor the reverse.
 *
 * CONTRACT (Day 0 stubs). Owner: E4. isImportedId, primaryRuleOf and optionSourceLabel are the spec's
 * one-line definitions; the lookups return "not found" until implemented (safe defaults for the UI).
 */
import type {
  BackgroundOption,
  Character,
  ClassLevel,
  ClassOption,
  EquipmentOption,
  FeatOption,
  InventoryItem,
  OptionSource,
  SpeciesOption,
  SubclassOption,
} from '@/types';

/** A package item matched in the equipment catalog (the same shape as src/ui/builder/equipment.ts's, which E4 points here). */
export interface CatalogMatch {
  option: EquipmentOption;
  /** How the package named the item ("Arcane Focus" for "Arcane Focus (Quarterstaff)"). */
  via: 'name' | 'parenthetical' | 'base';
  /** The words outside the parentheses, when matched via the parenthetical. */
  base?: string;
}

export const isImportedId = (id: string | undefined): boolean => Boolean(id?.startsWith('lib:'));

/** By id; else, for an imported id, by ref (kind + nameKey(entryName), preferring ref.sourceTitle's book); else by name among SRD options only. */
export function classOptionFor(cl: Pick<ClassLevel, 'classId' | 'name' | 'ref'>, classes: readonly ClassOption[]): ClassOption | undefined {
  void [cl, classes];
  return undefined; // not implemented (Day-0 stub): safe default
}

/** By subclassId; else by name only when that name is unique under the class. */
export function subclassOptionFor(cl: Pick<ClassLevel, 'subclass' | 'subclassId'>, cls: ClassOption | undefined): SubclassOption | undefined {
  void [cl, cls];
  return undefined; // not implemented (Day-0 stub): safe default
}

export function speciesOptionFor(c: Pick<Character, 'species' | 'speciesId' | 'speciesRef'>, all: readonly SpeciesOption[]): SpeciesOption | undefined {
  void [c, all];
  return undefined; // not implemented (Day-0 stub): safe default
}

export function backgroundOptionFor(
  c: Pick<Character, 'background' | 'backgroundId' | 'backgroundRef'>,
  all: readonly BackgroundOption[],
): BackgroundOption | undefined {
  void [c, all];
  return undefined; // not implemented (Day-0 stub): safe default
}

/** Exact name, then the base name before "(…)" (origin.ts:53-58); same book → SRD → other books. */
export function findFeat(feats: readonly FeatOption[], name: string, preferSourceId?: string): FeatOption | undefined {
  void [feats, name, preferSourceId];
  return undefined; // not implemented (Day-0 stub): safe default
}

/** equipment.ts:50-68's matching with the same precedence (today an exact match is last-wins); magic options never match a package item. */
export function findEquipment(name: string, catalog: readonly EquipmentOption[], preferSourceId?: string): CatalogMatch | null {
  void [name, catalog, preferSourceId];
  return null; // not implemented (Day-0 stub): safe default
}

/** DM-typed class names: the hero's own class first, then SRD, then imports; ties are reported. */
export function classByName(classes: readonly ClassOption[], name: string, c?: Character): { option?: ClassOption; others: ClassOption[] } {
  void [classes, name, c];
  return { others: [] }; // not implemented (Day-0 stub): safe default
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
  void [parentClass, sourceId, classes];
  return { reason: 'missing', candidates: [] }; // not implemented (Day-0 stub): safe default
}

/** "SRD 5.2.1" or the book title. */
export function optionSourceLabel(o: { source?: OptionSource }): string {
  return o.source?.title ?? 'SRD 5.2.1';
}

/** Item fields copied onto inventory (numbers, never text): armor, bonuses, requiresAttunement, attunementBy, compendiumId, ref. */
export function inventoryFromOption(option: EquipmentOption, quantity: number): Omit<InventoryItem, 'id'> {
  return { name: option.name, quantity }; // not implemented (Day-0 stub): safe default (name and quantity only)
}
