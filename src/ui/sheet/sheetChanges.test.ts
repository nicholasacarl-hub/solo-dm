import { describe, expect, it } from 'vitest';
import { sampleCharacter } from '@/test/fixtures';
import { itemAttuneChange, itemEquipChange } from './sheetChanges';

// SRD 5.2.1 Magic Items: Ring of Protection — "+1 bonus to AC and saving throws" while attuned.
describe('sheet gear changes keep AC in step', () => {
  const withRing = () =>
    sampleCharacter({
      armorClass: 12,
      inventory: [{ id: 'ring', name: 'Ring of Protection', quantity: 1, magic: true, category: 'magic-item' }],
    });

  it('attuning a Ring of Protection raises AC and says so', () => {
    const r = itemAttuneChange(withRing(), 'ring', true);
    expect(r.character.armorClass).toBe(13);
    expect(r.notice).toMatch(/attuned to Ring of Protection \(AC 12 → 13\)/);
  });

  it('ending attunement lowers it again', () => {
    const attuned = itemAttuneChange(withRing(), 'ring', true).character;
    const r = itemAttuneChange(attuned, 'ring', false);
    expect(r.character.armorClass).toBe(12);
  });

  it('equipping non-armor gear leaves an unchanged AC alone', () => {
    const c = sampleCharacter();
    const r = itemEquipChange(c, 'item-spellbook', true, null);
    expect(r.character.armorClass).toBe(c.armorClass);
    expect(r.notice).not.toMatch(/AC/);
  });
});
