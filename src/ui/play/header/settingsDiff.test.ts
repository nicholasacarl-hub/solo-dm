import { describe, expect, it } from 'vitest';
import { sampleSettings } from '@/test/fixtures';
import { describeSettingsChanges, quietSettingsChanges, settingsChangeNotice } from './settingsDiff';

describe('describeSettingsChanges', () => {
  it('is empty when nothing changed', () => {
    expect(describeSettingsChanges(sampleSettings(), sampleSettings())).toEqual([]);
  });

  it('describes rule dials, roll mode, DM rolls and leveling', () => {
    const before = sampleSettings();
    const after = {
      ...before,
      difficulty: 'hard' as const,
      homebrewFreedom: 'wild' as const,
      playerRollMode: 'physical' as const,
      showDmRolls: true,
      milestoneLeveling: false,
    };
    expect(describeSettingsChanges(before, after)).toEqual([
      'homebrew freedom: moderate → wild',
      'difficulty: standard → hard',
      'player rolls: tap to roll → physical dice',
      'DM rolls are now shown to the player',
      'leveling: milestone → XP',
    ]);
  });

  it('lists added and removed lines and veils (case-insensitively)', () => {
    const before = sampleSettings();
    const after = { ...before, lines: ['harm to children', 'Spiders'], veils: [] };
    expect(describeSettingsChanges(before, after)).toEqual([
      'new lines (never include): "Spiders"',
      'veils removed: "Torture"',
    ]);
  });

  it('quotes new tone, setting and notes for the DM', () => {
    const before = sampleSettings();
    const after = { ...before, tone: 'Grim and gritty', setting: 'A plague city.', playerNotes: '' };
    expect(describeSettingsChanges(before, after)).toEqual([
      'tone is now "Grim and gritty"',
      'setting notes are now "A plague city."',
      'player notes cleared',
    ]);
  });

  it('builds one notice for the DM', () => {
    expect(settingsChangeNotice(['difficulty: standard → hard'])).toBe(
      'The player changed the table rules: difficulty: standard → hard. Follow the new rules from now on.',
    );
  });
});

describe('quietSettingsChanges', () => {
  it('counts the transformations rule (missing = offered) and the art style, which need no notice here', () => {
    const before = sampleSettings();
    expect(quietSettingsChanges(before, { ...before, transformations: 'offered' })).toEqual([]);
    expect(quietSettingsChanges(before, { ...before, transformations: 'consequences', artStyle: 'Ink and watercolor' })).toEqual([
      'transformations',
      'art style',
    ]);
    expect(describeSettingsChanges(before, { ...before, transformations: 'off', artStyle: 'Woodcut' })).toEqual([]);
  });
});
