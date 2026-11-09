/**
 * The gear normalizer (spec §3.9): one item → ItemData (the builder's EquipmentOption fields). Cost and
 * weight in gold and pounds (SRD 5.2.1 "Equipment": coin values 1 GP = 10 SP = 100 CP, 1 PP = 10 GP,
 * 1 EP = 5 SP), weapon damage and properties (with a property's Range), armor AC with its Dexterity cap
 * ("Armor": light = full Dex, medium = max 2, heavy = none; a Shield +2), Strength and Stealth. The
 * description is app-written in the SRD build's patterns (weaponCategory() reads it): no book text is
 * copied. A gear table's rows are normalized one by one (normalizeItemRows).
 *
 * Owner: E2. Pure.
 */
import type { ItemData, RecordWarning } from '@/types';
import { splitTopLevel } from '../parse/srdRulesEntity';
import type { Wire } from '../wire';
import type { NormalizeContext, Normalized } from './index';
import { beginNormalize, finishNormalize, gradeConfidence, missing, warning } from './text';

type WireItem = Wire<'item'>['items'][number];

export const ITEM_FIELDS: Readonly<Record<string, string>> = {
  costText: 'costGp', weightText: 'weight', damageText: 'damage', propertiesText: 'properties', masteryText: 'mastery',
  acText: 'armorClass', strengthText: 'strengthRequirement',
};
const KEY_FIELDS = ['items', 'items.damageText', 'items.acText'];

const RATE: Readonly<Record<string, number>> = { cp: 0.01, sp: 0.1, ep: 0.5, gp: 1, pp: 10 };
const round = (n: number) => Math.round(n * 10000) / 10000;

/** "1,500 GP" → 1500, "5 sp" → 0.5; undefined when no price is printed. */
export function costGpOf(text: string): number | undefined {
  const m = /(\d[\d,]*(?:\.\d+)?)\s*(cp|sp|ep|gp|pp)\b/i.exec(text);
  return m ? round(Number(m[1].replace(/,/g, '')) * RATE[m[2].toLowerCase()]) : undefined;
}

/** "6 lb." → 6, "1/2 lb." → 0.5, "58 1/2 lb." → 58.5. */
export function weightOf(text: string): number | undefined {
  const m = /(?:(\d[\d,]*(?:\.\d+)?)(?:\s+(\d+)\/(\d+))?|(\d+)\/(\d+))\s*lb/i.exec(text);
  if (!m) return undefined;
  if (m[4]) return round(Number(m[4]) / Number(m[5]));
  const whole = Number(m[1].replace(/,/g, ''));
  return round(m[2] ? whole + Number(m[2]) / Number(m[3]) : whole);
}

/** "11 + Dex modifier" → 11, no cap; "14 + Dex modifier (max 2)" → 14, cap 2; "16" → 16, no Dex; "+2" (a shield) → 2. */
export function armorClassOf(text: string): { armorClass: number; dexCap: number | null; shield: boolean } | null {
  const t = text.replace(/[*_]/g, '').trim();
  const shield = /^\+\s*(\d+)/.exec(t);
  if (shield) return { armorClass: Number(shield[1]), dexCap: null, shield: true };
  const m = /^(\d+)/.exec(t);
  if (!m) return null;
  const dex = /\+\s*Dex(?:terity)?\b/i.test(t);
  const cap = /\(\s*max(?:imum)?\s*\+?(\d+)\s*\)/i.exec(t);
  return { armorClass: Number(m[1]), dexCap: dex ? (cap ? Number(cap[1]) : null) : 0, shield: false };
}

const titleWord = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The SRD build's app-written description ("Martial Melee Weapon", "Heavy Armor: AC 16", "Shield: +2 AC"). */
function describeItem(data: ItemData, acText: string): string | undefined {
  if (data.category === 'weapon' && data.weaponCategory && data.weaponType) return `${titleWord(data.weaponCategory)} ${titleWord(data.weaponType)} Weapon`;
  if (data.category === 'armor' && data.armorType && acText) return `${titleWord(data.armorType)} Armor: AC ${acText.replace(/[*_]/g, '').trim()}`;
  if (data.category === 'shield' && data.armorClass !== undefined) return `Shield: +${data.armorClass} AC`;
  return undefined;
}

/** One wire item → ItemData and its warnings (no book text). */
function itemData(item: WireItem, format: ItemData['format']): { data: ItemData | null; warnings: RecordWarning[] } {
  const w: RecordWarning[] = [];
  const costGp = costGpOf(item.costText);
  const weight = weightOf(item.weightText);
  let data: ItemData = { format, category: item.category, ...(costGp !== undefined ? { costGp } : {}), ...(weight !== undefined ? { weight } : {}) };
  if (item.category === 'weapon') {
    const damage = /(\d+(?:d\d+)?)\s+(\w+)/.exec(item.damageText.replace(/[*_]/g, ''));
    if (!damage) w.push(missing('damage', `The damage of ${item.name}`));
    const properties = /^(?:—|–|-)?$/.test(item.propertiesText.trim()) ? [] : splitTopLevel(item.propertiesText.replace(/[*_]/g, ''), ',');
    const range = properties.map((p) => /Range\s+(\d+\/\d+)/i.exec(p)?.[1]).find(Boolean);
    data = {
      ...data,
      ...(item.weaponCategory !== 'none' ? { weaponCategory: item.weaponCategory } : {}),
      ...(item.weaponType !== 'none' ? { weaponType: item.weaponType } : {}),
      ...(range ? { range } : {}),
      ...(damage ? { damage: damage[1], damageType: damage[2].toLowerCase() } : {}),
      properties, // [] when it has none ("—"), as the SRD's weapons have
      ...(item.masteryText.trim() && !/^(?:—|–|-)$/.test(item.masteryText.trim()) ? { mastery: item.masteryText.replace(/[*_]/g, '').trim() } : {}),
    };
    if (!damage) return { data: null, warnings: w };
  } else if (item.category === 'armor' || item.category === 'shield') {
    const ac = armorClassOf(item.acText);
    if (!ac) {
      w.push(missing('armorClass', `The Armor Class of ${item.name}`));
      return { data: null, warnings: w };
    }
    const strength = /(\d+)/.exec(item.strengthText)?.[1];
    data =
      item.category === 'shield' || ac.shield
        ? { ...data, category: 'shield', armorClass: ac.armorClass, stealthDisadvantage: item.stealthDisadvantage }
        : {
            ...data,
            armorClass: ac.armorClass,
            dexCap: ac.dexCap,
            ...(strength ? { strengthRequirement: Number(strength) } : {}),
            stealthDisadvantage: item.stealthDisadvantage,
            ...(item.armorType !== 'none' ? { armorType: item.armorType } : {}),
          };
  }
  const description = describeItem(data, item.acText);
  return { data: description ? { ...data, description } : data, warnings: w };
}

/** Ranges and the weapon / armor shape (shared by normalize and validate). */
export function itemChecks(data: ItemData): RecordWarning[] {
  const out: RecordWarning[] = [];
  if (data.category === 'weapon' && !data.damage) out.push(warning('missing', 'block', 'A weapon needs its damage.', 'damage'));
  if ((data.category === 'armor' || data.category === 'shield') && data.armorClass === undefined) {
    out.push(warning('missing', 'block', 'Armor needs its Armor Class.', 'armorClass'));
  }
  if (data.armorClass !== undefined && (data.armorClass < 0 || data.armorClass > 30)) {
    out.push(warning('out-of-range', 'block', `AC ${data.armorClass} is outside what the app accepts (0–30).`, 'armorClass'));
  }
  return out;
}

/** One row (or a single gear entry): the wire's item at `index`. */
export function normalizeItemAt(wire: Wire<'item'>, index: number, ctx: NormalizeContext): Normalized<'item'> {
  const item = wire.items[index];
  // Only this row's excerpts (named by its position in the table's wire).
  const base = beginNormalize('equipment', { ...wire, name: item?.name || wire.name, items: item ? [item] : [] }, ctx, ITEM_FIELDS);
  base.excerpts = base.excerpts.map((e) => ({ ...e, field: e.field.replace(/^items\[0\]\./, `items[${index}].`) }));
  if (!item) {
    return finishNormalize('item', base, null, [], { matchesKind: wire.matchesKind, keyFields: KEY_FIELDS, ctx, extra: [missing('items', 'No equipment')] });
  }
  const { data, warnings } = itemData(item, wire.format);
  return finishNormalize('item', base, data, [], { matchesKind: wire.matchesKind, keyFields: KEY_FIELDS, ctx, extra: [...warnings, ...(data ? itemChecks(data) : [])] });
}

/** Every row of a gear table's wire, one Normalized each (index = the wire item's position). */
export function normalizeItemRows(wire: Wire<'item'>, ctx: NormalizeContext): Normalized<'item'>[] {
  return wire.items.map((_, i) => normalizeItemAt(wire, i, ctx));
}

/** A single item (a gear entry): its first item. */
export function normalizeItem(wire: Wire<'item'>, ctx: NormalizeContext): Normalized<'item'> {
  return normalizeItemAt(wire, 0, ctx);
}

export function validateItem(data: ItemData, ctx: NormalizeContext): Pick<Normalized<'item'>, 'warnings' | 'adaptations' | 'confidence'> {
  void ctx;
  const warnings = itemChecks(data);
  return { warnings, adaptations: [], confidence: gradeConfidence('item', warnings, { matchesKind: true, missingKey: false }) };
}
