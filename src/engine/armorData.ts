/**
 * Armor reference data (SRD 5.2.1 "Armor" table) and helpers to resolve worn items to armor stats.
 * The catalog passed in by callers (BuilderData.equipment) wins; this table is the fallback.
 */
import type { EquipmentOption, InventoryItem } from '@/types';

export type ArmorType = 'light' | 'medium' | 'heavy';

export interface ArmorStats {
  name: string;
  kind: 'armor' | 'shield';
  armorType?: ArmorType;
  /** Base AC for armor; the AC bonus for a shield. */
  baseAc: number;
  /** null = no cap, 0 = DEX not added. */
  dexCap: number | null;
  strength?: number;
  stealthDisadvantage?: boolean;
}

const light = (name: string, baseAc: number, stealth = false): ArmorStats => ({
  name,
  kind: 'armor',
  armorType: 'light',
  baseAc,
  dexCap: null,
  stealthDisadvantage: stealth,
});
const medium = (name: string, baseAc: number, stealth = false): ArmorStats => ({
  name,
  kind: 'armor',
  armorType: 'medium',
  baseAc,
  dexCap: 2,
  stealthDisadvantage: stealth,
});
const heavy = (name: string, baseAc: number, strength?: number): ArmorStats => ({
  name,
  kind: 'armor',
  armorType: 'heavy',
  baseAc,
  dexCap: 0,
  strength,
  stealthDisadvantage: true,
});

export const SRD_ARMOR: readonly ArmorStats[] = [
  light('Padded Armor', 11, true),
  light('Leather Armor', 11),
  light('Studded Leather Armor', 12),
  medium('Hide Armor', 12),
  medium('Chain Shirt', 13),
  medium('Scale Mail', 14, true),
  medium('Breastplate', 14),
  medium('Half Plate Armor', 15, true),
  heavy('Ring Mail', 14),
  heavy('Chain Mail', 16, 13),
  heavy('Splint Armor', 17, 15),
  heavy('Plate Armor', 18, 15),
  { name: 'Shield', kind: 'shield', baseAc: 2, dexCap: 0 },
];

/** "+1 Chain Mail" / "Chain mail +2" -> 1 / 2. */
export function magicBonus(name: string): number {
  const match = /(?:^|[\s(])\+([1-3])(?=$|[\s)])/.exec(name);
  return match ? Number(match[1]) : 0;
}

/** Comparison key that ignores case, punctuation, a "+N" bonus and the word "armor". */
function armorKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/(?:^|\s)\+[1-3](?=$|\s)/g, ' ')
    .replace(/\barmou?r\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function fromCatalog(option: EquipmentOption): ArmorStats | null {
  if (option.category !== 'armor' && option.category !== 'shield') return null;
  if (option.category === 'shield') return { name: option.name, kind: 'shield', baseAc: option.armorClass ?? 2, dexCap: 0 };
  if (option.armorClass === undefined) return null;
  const dexCap =
    option.dexCap !== undefined ? option.dexCap : option.armorType === 'heavy' ? 0 : option.armorType === 'medium' ? 2 : null;
  return {
    name: option.name,
    kind: 'armor',
    armorType: option.armorType ?? (dexCap === 0 ? 'heavy' : dexCap === null ? 'light' : 'medium'),
    baseAc: option.armorClass,
    dexCap,
    strength: option.strengthRequirement,
    stealthDisadvantage: option.stealthDisadvantage,
  };
}

/** Armor stats for an inventory item: catalog by compendium id, catalog by name, then the SRD table. */
export function resolveArmor(item: InventoryItem, catalog: readonly EquipmentOption[] = []): ArmorStats | null {
  const byId = item.compendiumId ? catalog.find((o) => o.id === item.compendiumId) : undefined;
  const fromId = byId ? fromCatalog(byId) : null;
  if (fromId) return fromId;
  const key = armorKey(item.name);
  if (!key) return null;
  for (const option of catalog) {
    if (armorKey(option.name) === key) {
      const stats = fromCatalog(option);
      if (stats) return stats;
    }
  }
  return SRD_ARMOR.find((a) => armorKey(a.name) === key) ?? null;
}

export interface WornArmor {
  item: InventoryItem;
  stats: ArmorStats;
  /** Magic +N bonus parsed from the item name. */
  bonus: number;
}

const MAYBE_ARMOR = new Set(['armor', 'shield', 'magic-item', 'other']);

/**
 * Equipped items that are armor or a shield (weapons, gear and tools never count). `unknown` lists
 * equipped items categorized as armor/shield whose stats couldn't be found.
 */
export function wornArmor(
  items: readonly InventoryItem[],
  catalog: readonly EquipmentOption[] = [],
): { known: WornArmor[]; unknown: InventoryItem[] } {
  const known: WornArmor[] = [];
  const unknown: InventoryItem[] = [];
  for (const item of items) {
    if (!item.equipped || (item.category !== undefined && !MAYBE_ARMOR.has(item.category))) continue;
    const stats = resolveArmor(item, catalog);
    if (stats) known.push({ item, stats, bonus: magicBonus(item.name) });
    else if (item.category === 'armor' || item.category === 'shield') unknown.push(item);
  }
  return { known, unknown };
}
