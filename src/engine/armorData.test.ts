/**
 * Armor stats for worn items (SRD 5.2.1 "Armor Class", "Armor" table): numbers stored on an item (an
 * imported magic armor copied from the catalog) win over the catalog and the SRD table, and any equipped
 * item with armor numbers counts as worn armor whatever its category.
 */
import { describe, expect, it } from 'vitest';
import type { EquipmentOption, InventoryItem } from '@/types';
import { armorStatsOf, magicBonus, resolveArmor, wornArmor } from './armorData';

const chainMail: EquipmentOption = { id: 'srd:item:chain-mail', name: 'Chain Mail', category: 'armor', armorClass: 16, dexCap: 0, strengthRequirement: 13, stealthDisadvantage: true, armorType: 'heavy' };
const shield: EquipmentOption = { id: 'srd:item:shield', name: 'Shield', category: 'shield', armorClass: 2 };
const item = (patch: Partial<InventoryItem>): InventoryItem => ({ id: 'i1', name: 'Thing', quantity: 1, ...patch });

describe('armorStatsOf (SRD 5.2.1 Armor table)', () => {
  it('copies the numbers an inventory item needs', () => {
    expect(armorStatsOf(chainMail)).toEqual({ kind: 'armor', armorType: 'heavy', baseAc: 16, dexCap: 0, strength: 13, stealthDisadvantage: true });
    expect(armorStatsOf(shield)).toEqual({ kind: 'shield', baseAc: 2, dexCap: 0 });
    expect(armorStatsOf({ id: 'x', name: 'Rope', category: 'gear' })).toBeNull();
    expect(armorStatsOf({ id: 'x', name: 'Odd Armor', category: 'armor' })).toBeNull();
  });
});

describe('resolveArmor and wornArmor', () => {
  const stored = armorStatsOf(chainMail)!;

  it("reads the item's own armor numbers first (no catalog needed: DM tools, other devices)", () => {
    expect(resolveArmor(item({ name: "Warden's Mail", armor: stored }))).toEqual({ ...stored, name: "Warden's Mail" });
    expect(resolveArmor(item({ name: 'Chain Mail' }), [chainMail])?.baseAc).toBe(16);
    expect(resolveArmor(item({ name: 'Chain Mail' }))?.baseAc).toBe(16);
  });

  it('counts an equipped magic armor whatever its category, and leaves its bonus to the engine', () => {
    const mail = item({ name: "Warden's Mail +1", category: 'magic-item', equipped: true, armor: stored, bonuses: { ac: 1 } });
    const { known } = wornArmor([mail, item({ id: 'g', name: 'Lantern', category: 'gear', equipped: true })]);
    expect(known).toHaveLength(1);
    expect(known[0]).toMatchObject({ stats: { baseAc: 16 }, bonus: 0 });
    // Without structured bonuses the name's "+N" still counts, as before.
    expect(wornArmor([item({ name: 'Chain Mail +1', category: 'armor', equipped: true })]).known[0].bonus).toBe(1);
    expect(magicBonus('Chain Mail +2')).toBe(2);
  });

  it('ignores malformed stored numbers', () => {
    const odd = item({ name: 'Chain Mail', category: 'armor', armor: { kind: 'armor', baseAc: Number.NaN, dexCap: 0 } });
    expect(resolveArmor(odd)?.baseAc).toBe(16);
  });
});
