import { describe, expect, it } from 'vitest';
import { exportMessage } from './CampaignCard';

describe('the export toast (spec §7.3)', () => {
  it('says which books\' text was left out', () => {
    expect(exportMessage('The Drowned Lantern', { books: ['The Gloamwood Almanac'], passages: 7 })).toBe(
      'Saved “The Drowned Lantern”. Text from “The Gloamwood Almanac” was left out (7 passages).',
    );
    expect(exportMessage('Salt Roads', { books: ['Book A', 'Book B', 'Book C'], passages: 1 })).toBe(
      'Saved “Salt Roads”. Text from “Book A”, “Book B” and “Book C” was left out (1 passage).',
    );
  });

  it('stays as before when nothing was left out', () => {
    expect(exportMessage('Salt Roads', { books: [], passages: 0 })).toBe('Exported “Salt Roads”.');
    expect(exportMessage('Salt Roads', undefined)).toBe('Exported “Salt Roads”.');
  });
});
