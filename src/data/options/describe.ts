/**
 * App-written item descriptions (spec §6.6): "Rare armor (Chain Mail), requires attunement · +1 AC".
 * Copies of imported items carry these numbers-only descriptions, never the book's text.
 *
 * Owner: E4.
 */
import type { EquipmentOption, ItemBonuses } from '@/types';

const KIND_WORD: Record<EquipmentOption['category'], string> = {
  weapon: 'weapon',
  armor: 'armor',
  shield: 'shield',
  gear: 'magic item',
  tool: 'magic tool',
  pack: 'magic item',
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "+1 AC and saving throws", "+1 to attack and damage rolls" — the bonuses an item states. */
export function describeBonuses(bonuses: ItemBonuses | undefined): string[] {
  if (!bonuses) return [];
  const parts: string[] = [];
  const { ac, savingThrows, attack, damage } = bonuses;
  const condition =
    bonuses.acOnlyWhen === 'no-armor' ? ' while you wear no armor' : bonuses.acOnlyWhen === 'no-armor-no-shield' ? ' while you wear no armor and no shield' : '';
  if (ac && savingThrows && ac === savingThrows && !condition) parts.push(`+${ac} AC and saving throws`);
  else {
    if (ac) parts.push(`+${ac} AC${condition}`);
    if (savingThrows) parts.push(`+${savingThrows} saving throws`);
  }
  if (attack && damage && attack === damage) parts.push(`+${attack} to attack and damage rolls`);
  else {
    if (attack) parts.push(`+${attack} to attack rolls`);
    if (damage) parts.push(`+${damage} to damage rolls`);
  }
  return parts;
}

/** "Martial melee weapon · 1d8 bludgeoning · Reach, Two-Handed · mastery Topple", from the option's numbers. */
function describeMundane(option: EquipmentOption): string {
  const parts: string[] = [];
  switch (option.category) {
    case 'weapon': {
      const kind = [option.weaponCategory, option.weaponType].filter(Boolean).join(' ');
      parts.push(capitalize(`${kind ? `${kind} ` : ''}weapon`));
      if (option.damage) parts.push([option.damage, option.damageType].filter(Boolean).join(' '));
      if (option.properties?.length) parts.push(option.properties.join(', '));
      if (option.mastery) parts.push(`mastery ${option.mastery}`);
      break;
    }
    case 'armor': {
      parts.push(capitalize(`${option.armorType ? `${option.armorType} ` : ''}armor`));
      if (option.armorClass !== undefined) {
        const dex = option.dexCap === 0 ? '' : option.dexCap ? ` + Dex modifier (max ${option.dexCap})` : ' + Dex modifier';
        parts.push(`AC ${option.armorClass}${option.armorType === 'heavy' ? '' : dex}`);
      }
      if (option.strengthRequirement) parts.push(`Strength ${option.strengthRequirement}`);
      if (option.stealthDisadvantage) parts.push('Stealth disadvantage');
      break;
    }
    case 'shield':
      parts.push('Shield', `+${option.armorClass ?? 2} AC`);
      break;
    case 'tool':
      parts.push('Tool');
      break;
    case 'pack':
      parts.push('Equipment pack');
      break;
    case 'gear':
      parts.push('Adventuring gear');
      break;
  }
  return parts.join(' · ');
}

/** "Rare armor (Chain Mail), requires attunement by a Wizard · +1 AC". */
function describeMagic(option: EquipmentOption, catalog: readonly EquipmentOption[]): string {
  const magic = option.magic;
  if (!magic) return '';
  const base = magic.baseItemId ? catalog.find((o) => o.id === magic.baseItemId)?.name : undefined;
  const rarity = magic.rarity === 'varies' ? 'Magic' : capitalize(magic.rarity);
  let head = `${rarity} ${KIND_WORD[option.category]}${base ? ` (${base})` : ''}`;
  if (magic.attunement !== false) {
    const who = typeof magic.attunement === 'string' ? magic.attunement.trim() : '';
    head += `, requires attunement${who ? ` ${/^by\b/i.test(who) ? who : `by ${who}`}` : ''}`;
  }
  return [head, ...describeBonuses(magic.bonuses)].join(' · ');
}

/**
 * The description an inventory copy of a catalog option gets. SRD options keep their own (SRD text,
 * CC-BY); imported options get an app-written line from their numbers (a book's words are never copied,
 * whatever a pack or an edit put in `description`). `catalog` names a magic item's base.
 */
export function describeOption(option: EquipmentOption, catalog: readonly EquipmentOption[] = []): string {
  if (!option.source) return option.description ?? '';
  if (option.magic) return describeMagic(option, catalog);
  return describeMundane(option);
}
