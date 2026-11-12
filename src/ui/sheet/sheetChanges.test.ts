import { describe, expect, it } from 'vitest';
import { sampleCharacter } from '@/test/fixtures';
import { SHEET_TEXT_MAX } from '@/engine';
import type { InventoryItem } from '@/types';
import { dmSheetLengthHint, itemAttuneChange, itemEquipChange, notesChange, personalityChange, removeItemChange } from './sheetChanges';

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
    // The save bonus too: the DM's sheet from the start of the session doesn't have it.
    expect(r.notice).toBe('Player attuned to Ring of Protection (AC 12 → 13; saving throws now include Ring of Protection +1)');
  });

  it('ending attunement lowers it again, and says the save bonus is gone', () => {
    const attuned = itemAttuneChange(withRing(), 'ring', true).character;
    const r = itemAttuneChange(attuned, 'ring', false);
    expect(r.character.armorClass).toBe(12);
    expect(r.notice).toBe('Player ended attunement to Ring of Protection (AC 13 → 12; saving throws no longer include Ring of Protection +1)');
  });

  it('equipping non-armor gear leaves an unchanged AC alone', () => {
    const c = sampleCharacter();
    const r = itemEquipChange(c, 'item-spellbook', true, null);
    expect(r.character.armorClass).toBe(c.armorClass);
    expect(r.notice).not.toMatch(/AC/);
  });
});

// The AC an equip, attune or removal can't settle on its own: the DM, whose ruling it is, reads why at the end of the
// notice's one line (notices are parsed back line by line); the player, who can't set the AC, gets a plain toast.
describe('sheet gear changes pass on what syncArmorClass warns', () => {
  const shield: InventoryItem = { id: 'shield', name: 'Shield', quantity: 1, category: 'shield' };

  // SRD 5.2.1 Spells: Mage Armor (base AC 13 + Dexterity modifier) isn't counted by the app, so the DM set the AC by hand;
  // Equipment: a Shield adds 2.
  it('keeps an AC set by hand (Mage Armor) when a Shield goes on, and says what gear now gives', () => {
    const c = sampleCharacter({ armorClass: 15, armorTraining: ['Shields'], inventory: [shield] });
    const r = itemEquipChange(c, 'shield', true, null);
    expect(r.character.armorClass).toBe(15);
    const kept =
      'AC kept at 15: it differs from the 12 that gear and features gave, so it may include a spell such as Mage Armor or a manual change. Gear and features now give AC 14 (10 + DEX 2 + Shield 2); update the AC if that is right.';
    expect(r.notice).toBe(`Player equipped Shield — ${kept}`);
    expect(r.warning).toBe("Your AC stays 15: your gear alone can't settle it, so your DM will be told with your next message.");
  });

  // SRD 5.2.1 Magic Items: Cloak of Protection — +1 to AC and saving throws while attuned.
  it('keeps the saving-throw note in its parentheses and the warning after it when an attunement meets a hand-set AC', () => {
    const cloak: InventoryItem = { id: 'cloak', name: 'Cloak of Protection', quantity: 1, magic: true, category: 'magic-item' };
    const r = itemAttuneChange(sampleCharacter({ armorClass: 15, inventory: [cloak] }), 'cloak', true);
    expect(r.character.armorClass).toBe(15);
    expect(r.notice).toMatch(/^Player attuned to Cloak of Protection \(saving throws now include Cloak of Protection \+1\) — AC kept at 15: .*Gear and features now give AC 13 \(10 \+ DEX 2 \+ Cloak of Protection 1\); update the AC if that is right\.$/);
    expect(r.warning).toMatch(/^Your AC stays 15: /);
  });

  it('says so when the player puts on armor whose stats the app does not know', () => {
    const hauberk: InventoryItem = { id: 'hauberk', name: 'Saltglass Hauberk', quantity: 1, category: 'armor' };
    const c = sampleCharacter({ armorTraining: ['Light armor', 'Medium armor', 'Heavy armor', 'Shields'], inventory: [hauberk] });
    const r = itemEquipChange(c, 'hauberk', true, null);
    expect(r.character.armorClass).toBe(12);
    const unknown = "AC kept at 12: Saltglass Hauberk's armor stats are unknown, so set the AC by hand.";
    expect(r.notice).toBe(`Player equipped Saltglass Hauberk — ${unknown}`);
    expect(r.warning).toMatch(/^Your AC stays 12: /);
  });

  it('lowers the AC when the player removes the Shield they wear, and says so; other gear goes as before', () => {
    const c = sampleCharacter({ armorClass: 14, armorTraining: ['Shields'], inventory: [{ ...shield, equipped: true }, ...sampleCharacter().inventory] });
    const r = removeItemChange(c, 'shield');
    expect(r.character.armorClass).toBe(12);
    expect(r.character.acFormula).toBe('10 + DEX 2');
    expect(r.notice).toBe('Player removed Shield from their inventory (AC 14 → 12)');
    expect(r.warning).toBeUndefined();
    expect(removeItemChange(c, 'item-robe')).toMatchObject({ notice: 'Player removed Robe from their inventory', character: { armorClass: 14 } });
  });

  it('keeps a hand-set AC when the worn Shield is removed, and passes on the warning', () => {
    const c = sampleCharacter({ armorClass: 17, armorTraining: ['Shields'], inventory: [{ ...shield, equipped: true }] });
    const r = removeItemChange(c, 'shield');
    expect(r.character.armorClass).toBe(17);
    expect(r.notice).toMatch(/^Player removed Shield from their inventory — AC kept at 17: it differs from the 14 that gear and features gave, .* Gear and features now give AC 12 \(10 \+ DEX 2\); update the AC if that is right\.$/);
    expect(r.warning).toMatch(/^Your AC stays 17: /);
    expect(r.notice).not.toContain('\n');
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
      'Player updated their backstory: “Kestrel Vane grew up on the salt flats east of Harrowmere,…” (its opening; get_character_sheet has the whole text)',
    );
  });
});

describe('notices quote whole characters, and notes edits read like personality edits', () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it('never ends a quote on half an emoji', () => {
    const backstory = `${'x'.repeat(58)}🐉 and then the rest of a very long first paragraph.`;
    const notice = personalityChange(sampleCharacter(), 'backstory', backstory).notice ?? '';
    expect(notice).not.toMatch(lone);
    expect(notice).toContain(`“${'x'.repeat(58)}…”`);
  });

  it('quotes a notes edit, says where the whole text is, and says when the notes were cleared', () => {
    const c = sampleCharacter({ notes: 'Old notes.' });
    expect(notesChange(c, 'Ask Old Tam about the ferry.').notice).toBe('Player updated their notes on the sheet: “Ask Old Tam about the ferry.”');
    const long = notesChange(c, 'Session 4: the ferryman owes us a crossing; the lamplighter keeps a second ledger.').notice;
    expect(long).toMatch(/^Player updated their notes on the sheet: “.+…” \(its opening; get_character_sheet has the whole text\)$/);
    expect(notesChange(c, '  ').notice).toBe('Player cleared their notes on the sheet');
  });

  it('tells the player when a field is past what the DM sheet carries', () => {
    expect(dmSheetLengthHint(undefined)).toBeUndefined();
    expect(dmSheetLengthHint('A long backstory, but a real one.')).toBeUndefined();
    expect(dmSheetLengthHint('x'.repeat(SHEET_TEXT_MAX))).toBeUndefined();
    expect(dmSheetLengthHint('x'.repeat(SHEET_TEXT_MAX + 1))).toBe(
      "The DM's sheet carries the first 20,000 characters of this; past that it tells the DM the rest is left out.",
    );
  });
});
