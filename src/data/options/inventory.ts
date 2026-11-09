/**
 * Linking an item the player or the DM names to the equipment catalog or the rules index (spec §6.6):
 * an exact name gets the catalog option's numbers (inventoryFromOption: armor, bonuses, attunement, a
 * ref), or, for a magic item that only the index knows, its compendium id, attunement and bonuses.
 * Numbers are copied, never a book's text: an imported entry's text is read live from the index.
 *
 * Owner: E4. Pure. Used by the sheet's Add item form and the DM's inventory_add.
 */
import { nameKey } from '@/lib/id';
import type { CompendiumEntry, EquipmentOption, ImportedRef, InventoryItem, ItemBonuses } from '@/types';
import { describeOption } from './describe';
import { findCatalogOption, inventoryFromOption } from './resolve';

/** A book's index entry (spell, item, magic item) as a copy's ref: no text copied. */
export function entryRef(entry: CompendiumEntry, kind: 'item' | 'magic-item'): ImportedRef | undefined {
  if (!entry.id.startsWith('lib:')) return undefined;
  return { sourceId: entry.sourceId, sourceTitle: entry.sourceName, entryId: entry.id, kind, entryName: entry.name, textHash: '', textCopied: false };
}

const BONUS = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5 ? value : undefined);

/** The bonuses a reviewed magic item states (the DATA_SCHEMAS ranges: 1–5), or undefined. */
function bonusesOf(value: unknown): ItemBonuses | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const out: ItemBonuses = {};
  const ac = BONUS(raw.ac);
  const savingThrows = BONUS(raw.savingThrows);
  const attack = BONUS(raw.attack);
  const damage = BONUS(raw.damage);
  if (ac) out.ac = ac;
  if (savingThrows) out.savingThrows = savingThrows;
  if (attack) out.attack = attack;
  if (damage) out.damage = damage;
  if (out.ac && (raw.acOnlyWhen === 'no-armor' || raw.acOnlyWhen === 'no-armor-no-shield')) out.acOnlyWhen = raw.acOnlyWhen;
  return Object.keys(out).length ? out : undefined;
}

/** "by a Wizard" → "a Wizard". */
function attunementWho(attunement: unknown): string | undefined {
  if (typeof attunement !== 'string') return undefined;
  return attunement.trim().replace(/^by\s+/i, '').trim() || undefined;
}

const RARITIES = new Set(['common', 'uncommon', 'rare', 'very rare', 'legendary', 'artifact', 'varies']);

/**
 * An inventory copy of a rules-index item: the catalog option with the same id when there is one,
 * else (a magic item only the index knows) its compendium id, attunement and bonuses, an app-written
 * description for an imported one, and a ref.
 */
export function inventoryFromEntry(entry: CompendiumEntry, quantity: number, catalog: readonly EquipmentOption[] = []): Omit<InventoryItem, 'id'> {
  const option = catalog.find((o) => o.id === entry.id);
  if (option) return inventoryFromOption(option, quantity, catalog);
  const item: Omit<InventoryItem, 'id'> = { name: entry.name, quantity, compendiumId: entry.id };
  const kind = entry.kind === 'magic-item' ? 'magic-item' : 'item';
  if (kind === 'magic-item') {
    const data = entry.data ?? {};
    item.magic = true;
    item.category = 'magic-item';
    const attunement = data.attunement;
    item.requiresAttunement = attunement === true || (typeof attunement === 'string' && attunement.trim() !== '');
    const who = attunementWho(attunement);
    if (who) item.attunementBy = who;
    const bonuses = bonusesOf(data.bonuses);
    if (bonuses) item.bonuses = bonuses;
    const rarity = typeof data.rarity === 'string' && RARITIES.has(data.rarity) ? (data.rarity as NonNullable<EquipmentOption['magic']>['rarity']) : 'varies';
    const ref = entryRef(entry, kind);
    if (ref) {
      // Imported: an app-written line from the numbers (describeOption never copies a book's words).
      const described = describeOption({
        id: entry.id,
        name: entry.name,
        category: 'gear',
        source: { sourceId: ref.sourceId, title: ref.sourceTitle, recordId: '', format: '2024', adaptations: [] },
        magic: { rarity, attunement: typeof attunement === 'string' || typeof attunement === 'boolean' ? attunement : false, ...(bonuses ? { bonuses } : {}) },
      });
      if (described) item.description = described;
      item.ref = ref;
    }
    return item;
  }
  const ref = entryRef(entry, kind);
  if (ref) item.ref = ref;
  return item;
}

/**
 * The inventory item an exact name links to: a catalog option (same book first, then the SRD), else a
 * magic item or item entry the index finds by that name. Null when nothing matches exactly (the item
 * is then added as plain text, as before).
 */
export function linkInventoryItem(
  name: string,
  quantity: number,
  catalog: readonly EquipmentOption[],
  findEntry?: (name: string) => CompendiumEntry | undefined,
  preferSourceId?: string,
): Omit<InventoryItem, 'id'> | null {
  const option = findCatalogOption(name, catalog, preferSourceId);
  if (option) return inventoryFromOption(option, quantity, catalog);
  const entry = findEntry?.(name);
  if (!entry || (entry.kind !== 'magic-item' && entry.kind !== 'item') || nameKey(entry.name) !== nameKey(name)) return null;
  return inventoryFromEntry(entry, quantity, catalog);
}
