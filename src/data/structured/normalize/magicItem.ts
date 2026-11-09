/**
 * The magic-item normalizer (spec §3.9): category (with the type line as the fallback), rarity,
 * attunement (SRD convention: true, false, or the requirement "by a Wizard"), the base item, flat
 * bonuses only when the excerpt states "+N" (SRD 5.2.1 "Magic Items" › item descriptions: bonuses to
 * AC, saving throws, attack and damage rolls), and charges.
 *
 * Owner: E2. Pure.
 */
import type { ItemBonuses, MagicItemData, RecordWarning } from '@/types';
import { parseMagicItemSubtitle } from '../parse/srdRulesEntity';
import type { Wire } from '../wire';
import type { NormalizeContext, Normalized } from './index';
import { beginNormalize, finishNormalize, gradeConfidence, missing, warning } from './text';

export const MAGIC_ITEM_FIELDS: Readonly<Record<string, string>> = {
  typeLineText: 'category', attunementText: 'attunement', baseItemText: 'baseItem', bonusText: 'bonuses', chargesText: 'charges',
};
const KEY_FIELDS = ['typeLineText', 'category', 'rarity'];

const CATEGORIES: readonly MagicItemData['category'][] = ['armor', 'shield', 'weapon', 'ammunition', 'potion', 'ring', 'rod', 'scroll', 'staff', 'wand', 'wondrous-item'];

export function normalizeMagicItem(wire: Wire<'magic-item'>, ctx: NormalizeContext): Normalized<'magic-item'> {
  const base = beginNormalize('a magic item', wire, ctx, MAGIC_ITEM_FIELDS);
  const w: RecordWarning[] = [];
  const line = wire.typeLineText ? parseMagicItemSubtitle(wire.typeLineText) : null;

  let category: MagicItemData['category'] = wire.category;
  if (category === 'other') {
    const fromLine = line?.category as MagicItemData['category'] | undefined;
    if (fromLine && CATEGORIES.includes(fromLine)) category = fromLine;
    else {
      category = 'wondrous-item';
      w.push(warning('default-used', 'warn', "No item category was found: the app used Wondrous Item. Check it.", 'category'));
    }
  }

  let rarity = wire.rarity === 'unknown' ? undefined : wire.rarity;
  if (!rarity && line) {
    const fromLine = line.rarity as MagicItemData['rarity'];
    if (fromLine !== 'varies' || /\b(?:varies|rarity varies|uncommon|common|rare|legendary|artifact)\b/i.test(line.rarityText)) rarity = fromLine;
  }
  if (!rarity) {
    w.push(missing('rarity', 'The rarity'));
    return finishNormalize('magic-item', base, null, [], { matchesKind: wire.matchesKind, keyFields: KEY_FIELDS, ctx, extra: w });
  }

  const attunement: MagicItemData['attunement'] =
    wire.attunement === 'none' ? false : wire.attunement === 'required-by' && wire.attunementText.trim() ? wire.attunementText.replace(/[*_]/g, '').trim() : true;
  const baseItem = (wire.baseItemText.trim() || line?.baseItem?.trim() || '').replace(/[*_]/g, '');

  const bonuses: ItemBonuses = {};
  const stated = (n: number) => n > 0 && wire.bonusText.includes(`+${n}`);
  if (stated(wire.acBonus)) bonuses.ac = wire.acBonus;
  if (stated(wire.saveBonus)) bonuses.savingThrows = wire.saveBonus;
  if (stated(wire.attackBonus)) bonuses.attack = wire.attackBonus;
  if (stated(wire.damageBonus)) bonuses.damage = wire.damageBonus;
  if (bonuses.ac !== undefined && wire.acCondition !== 'always') bonuses.acOnlyWhen = wire.acCondition;
  for (const n of [wire.acBonus, wire.saveBonus, wire.attackBonus, wire.damageBonus]) {
    if (n > 0 && !stated(n)) w.push(warning('ungrounded', 'warn', `A +${n} bonus was read, but the text quoted doesn't state it: it was left out.`, 'bonuses'));
  }
  const charges = /(\d+)\s+charges/i.exec(wire.chargesText)?.[1];

  const data: MagicItemData = {
    format: wire.format,
    category,
    rarity,
    ...(rarity === 'varies' && line?.rarityText.trim() ? { rarityText: line.rarityText.trim() } : {}),
    attunement,
    ...(baseItem ? { baseItem } : {}),
    ...(Object.keys(bonuses).length ? { bonuses } : {}),
    ...(charges ? { charges: Number(charges) } : {}),
  };
  return finishNormalize('magic-item', base, data, [], { matchesKind: wire.matchesKind, keyFields: KEY_FIELDS, ctx, extra: [...w, ...magicItemChecks(data)] });
}

/** Ranges the engine accepts (bonuses 1–5, charges 1–100). */
export function magicItemChecks(data: MagicItemData): RecordWarning[] {
  const out: RecordWarning[] = [];
  for (const [key, n] of Object.entries(data.bonuses ?? {})) {
    if (typeof n === 'number' && (n < 1 || n > 5)) out.push(warning('out-of-range', 'block', `A +${n} bonus is outside what the app applies (+1 to +5).`, `bonuses.${key}`));
  }
  if (data.charges !== undefined && (data.charges < 1 || data.charges > 100)) {
    out.push(warning('out-of-range', 'block', `${data.charges} charges is outside what the app tracks (1–100).`, 'charges'));
  }
  return out;
}

export function validateMagicItem(data: MagicItemData, ctx: NormalizeContext): Pick<Normalized<'magic-item'>, 'warnings' | 'adaptations' | 'confidence'> {
  void ctx;
  const warnings = magicItemChecks(data);
  return { warnings, adaptations: [], confidence: gradeConfidence('magic-item', warnings, { matchesKind: true, missingKey: false }) };
}
