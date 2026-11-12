import { describe, expect, it } from 'vitest';
import { sampleCharacter } from '@/test/fixtures';
import { itemAttuneChange, itemEquipChange, personalityChange } from './sheetChanges';

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

describe('personality edits tell the DM', () => {
  it('quotes a short edit whole', () => {
    expect(personalityChange(sampleCharacter(), 'ideals', 'Freedom.').notice).toBe('Player updated their ideals: “Freedom.”');
  });

  it('quotes the opening of a long edit and says get_character_sheet has the whole text, on one line', () => {
    const backstory = [
      'Kestrel Vane grew up on the salt flats east of Harrowmere, where the caravans stop only to water their oxen.',
      'He fights with twin hooked blades joined by a length of black chain.',
    ].join('\n\n');
    const r = personalityChange(sampleCharacter(), 'backstory', backstory);
    expect(r.character.personality.backstory).toBe(backstory);
    // Notices reach the DM as one "- " line each and are parsed back line by line.
    expect(r.notice).not.toContain('\n');
    expect(r.notice).toBe(
      'Player updated their backstory: “Kestrel Vane grew up on the salt flats east of Harrowmere, …” (its opening; get_character_sheet has the whole text)',
    );
  });
});
