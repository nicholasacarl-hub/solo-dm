import { describe, expect, it } from 'vitest';
import { sampleCharacter } from '@/test/fixtures';
import { characterLine, formatRelativeTime, formatTokens, formatUsd, plural, shortSpecies } from './format';
import { findTonePreset, suggestCampaignName, toneText, TONE_PRESETS } from './campaignOptions';
import { parseRepoInput } from './settings/GithubSettings';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe('formatRelativeTime', () => {
  it.each([
    [NOW - 10_000, 'just now'],
    [NOW - 5 * MIN, '5 minutes ago'],
    [NOW - 3 * 60 * MIN, '3 hours ago'],
    [NOW - DAY, 'yesterday'],
    [NOW - 3 * DAY, '3 days ago'],
    [NOW - 14 * DAY, '2 weeks ago'],
    [NOW - 90 * DAY, '3 months ago'],
    [NOW - 800 * DAY, '2 years ago'],
    [NOW + 2 * 60 * MIN, 'in 2 hours'],
  ])('%d → %s', (timestamp, expected) => {
    expect(formatRelativeTime(timestamp, NOW)).toBe(expected);
  });
});

describe('character line', () => {
  it('shows name, species and class levels', () => {
    expect(characterLine(sampleCharacter())).toBe('Mira Voss · Elf · Wizard 3');
  });

  it('lists every class of a multiclass character', () => {
    const c = sampleCharacter({
      classes: [
        { classId: 'a', name: 'Fighter', level: 5, hitDie: 10, casterType: 'none' },
        { classId: 'b', name: 'Rogue', level: 2, hitDie: 8, casterType: 'none' },
      ],
    });
    expect(characterLine(c)).toBe('Mira Voss · Elf · Fighter 5 / Rogue 2');
  });

  it('skips missing parts', () => {
    expect(characterLine({ name: '', species: '', classes: [] })).toBe('');
    expect(shortSpecies('Dragonborn (Red Dragon ancestry)')).toBe('Dragonborn');
  });
});

describe('number formats', () => {
  it('formats prices, tokens and counts', () => {
    expect(formatUsd(4)).toBe('$4');
    expect(formatUsd(0.5)).toBe('$0.50');
    expect(formatUsd(0.125)).toBe('$0.125');
    expect(formatTokens(150_000)).toBe('150k');
    expect(formatTokens(1_500)).toBe('1.5k');
    expect(plural(1, 'session')).toBe('1 session');
    expect(plural(2, 'entry', 'entries')).toBe('2 entries');
  });
});

describe('campaign options', () => {
  it('round-trips tone presets', () => {
    for (const preset of TONE_PRESETS) expect(findTonePreset(toneText(preset))).toBe(preset);
    expect(findTonePreset('heroic fantasy')?.id).toBe('heroic');
    expect(findTonePreset('Folk horror')).toBeUndefined();
  });

  it('suggests a different name when asked again', () => {
    const values = [0, 0, 0, 0, 0.5, 0.5];
    const random = () => values.shift() ?? 0.9;
    const first = suggestCampaignName(undefined, random);
    expect(suggestCampaignName(first, random)).not.toBe(first);
  });
});

describe('parseRepoInput', () => {
  it.each([
    ['saves', { repo: 'saves' }],
    ['me/saves', { owner: 'me', repo: 'saves' }],
    ['https://github.com/me/saves.git', { owner: 'me', repo: 'saves' }],
    ['github.com/me/saves/', { owner: 'me', repo: 'saves' }],
  ])('%s', (input, expected) => {
    expect(parseRepoInput(input)).toEqual(expected);
  });
});
