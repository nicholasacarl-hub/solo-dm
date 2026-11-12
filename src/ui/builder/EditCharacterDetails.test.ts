import { describe, expect, it } from 'vitest';
import { sampleCharacter } from '@/test/fixtures';
import type { Character } from '@/types';
import { detailsChange } from './EditCharacterDetails';

const value = (c: Character, personality: Character['personality']) => ({
  name: c.name,
  pronouns: c.pronouns ?? '',
  alignment: c.alignment ?? '',
  portrait: c.portrait ?? '',
  personality,
});

describe('detailsChange', () => {
  it('points the DM to get_character_sheet for new personality text, on one line', () => {
    const c = sampleCharacter();
    const backstory = 'He grew up on the salt flats.\n\nOne day he will become a dragon.';
    const notice = detailsChange(c, value(c, { ...c.personality, backstory })).notice ?? '';
    expect(notice).toBe('Player edited their character details: backstory (get_character_sheet has the new text)');
  });

  it('adds no pointer when only the name or alignment changed', () => {
    const c = sampleCharacter();
    const notice = detailsChange(c, { ...value(c, c.personality), alignment: 'Chaotic Good' }).notice ?? '';
    expect(notice).toBe('Player edited their character details: alignment Chaotic Good');
  });
});
