import { describe, expect, it } from 'vitest';
import { sampleCharacter } from '@/test/fixtures';
import { SHEET_TEXT_MAX } from '@/engine';
import { dmSheetLengthHint, itemAttuneChange, itemEquipChange, notesChange, personalityChange } from './sheetChanges';

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
