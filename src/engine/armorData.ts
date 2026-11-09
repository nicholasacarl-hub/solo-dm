/**
 * Armor reference data (SRD 5.2.1 "Armor" table) and helpers to resolve worn items to armor stats.
 * The catalog passed in by callers (BuilderData.equipment) wins; this table is the fallback.
 */
import type { EquipmentOption, InventoryItem, ItemArmorStats } from '@/types';

export type ArmorType = 'light' | 'medium' | 'heavy';

/** Armor numbers (base AC and DEX cap; a shield's bonus) with the armor's name. */
export type ArmorStats = ItemArmorStats & { name: string };

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
];

const SHIELD: ArmorStats = { name: 'Shield', kind: 'shield', baseAc: 2, dexCap: 0 };

/** SRD 5.2.1 armor plus the Shield. */
export const SRD_ARMOR_AND_SHIELD: readonly ArmorStats[] = [...SRD_ARMOR, SHIELD];

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

/**
 * The armor numbers of a catalog option (armor or shield), as copied onto an inventory item so AC works
 * without the catalog (DM tools, other devices). Null for anything else, or armor without an AC.
 */
export function armorStatsOf(option: EquipmentOption): ItemArmorStats | null {
  if (option.category !== 'armor' && option.category !== 'shield') return null;
  if (option.category === 'shield') return { kind: 'shield', baseAc: option.armorClass ?? 2, dexCap: 0 };
  if (option.armorClass === undefined) return null;
  const dexCap =
    option.dexCap !== undefined ? option.dexCap : option.armorType === 'heavy' ? 0 : option.armorType === 'medium' ? 2 : null;
  const stats: ItemArmorStats = {
    kind: 'armor',
    armorType: option.armorType ?? (dexCap === 0 ? 'heavy' : dexCap === null ? 'light' : 'medium'),
    baseAc: option.armorClass,
    dexCap,
  };
  if (option.strengthRequirement !== undefined) stats.strength = option.strengthRequirement;
  if (option.stealthDisadvantage !== undefined) stats.stealthDisadvantage = option.stealthDisadvantage;
  return stats;
}

function fromCatalog(option: EquipmentOption): ArmorStats | null {
  const stats = armorStatsOf(option);
  return stats ? { name: option.name, ...stats } : null;
}

/** Numbers stored on the item (structured imports) win; anything malformed is ignored. */
function fromItem(item: InventoryItem): ArmorStats | null {
  const armor = item.armor;
  if (!armor || (armor.kind !== 'armor' && armor.kind !== 'shield') || !Number.isFinite(armor.baseAc)) return null;
  return { ...armor, name: item.name };
}

/**
 * Armor stats for an inventory item: the numbers stored on the item, then the catalog by compendium id,
 * the catalog by name, then the SRD table (SRD 5.2.1 "Armor").
 */
export function resolveArmor(item: InventoryItem, catalog: readonly EquipmentOption[] = []): ArmorStats | null {
  const own = fromItem(item);
  if (own) return own;
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
  return SRD_ARMOR_AND_SHIELD.find((a) => armorKey(a.name) === key) ?? null;
}

export interface WornArmor {
  item: InventoryItem;
  stats: ArmorStats;
  /** Magic +N bonus parsed from the item name (0 for items with structured `bonuses`, which the engine adds itself). */
  bonus: number;
}

const MAYBE_ARMOR = new Set(['armor', 'shield', 'magic-item', 'other']);

/**
 * Equipped items that are armor or a shield (weapons, gear and tools never count, unless the item
 * carries armor numbers of its own: magic armor whatever its category). `unknown` lists equipped items
 * categorized as armor whose stats couldn't be found.
 */
export function wornArmor(
  items: readonly InventoryItem[],
  catalog: readonly EquipmentOption[] = [],
): { known: WornArmor[]; unknown: InventoryItem[] } {
  const known: WornArmor[] = [];
  const unknown: InventoryItem[] = [];
  for (const item of items) {
    if (!item.equipped) continue;
    const own = fromItem(item);
    if (!own && item.category !== undefined && !MAYBE_ARMOR.has(item.category)) continue;
    // Any equipped shield works like a Shield even when its name isn't in the tables ("Spiked Shield").
    const stats = own ?? resolveArmor(item, catalog) ?? (item.category === 'shield' ? { ...SHIELD, name: item.name } : null);
    if (stats) known.push({ item, stats, bonus: item.bonuses ? 0 : magicBonus(item.name) });
    else if (item.category === 'armor') unknown.push(item);
  }
  return { known, unknown };
}
