import { describe, expect, it } from 'vitest';
import { battleMapsMode, battleMapsNotice, battleMapsSection, illustrationsSection, modeNotices, modesTold, transformationsSection, type TableModes } from './modes';

const prompt = (battleMaps: 'off' | 'auto' | 'always' | null) =>
  ['# You are the Dungeon Master', transformationsSection('offered'), illustrationsSection('unavailable'), battleMaps ? battleMapsSection(battleMaps) : ''].join('\n\n');

const now = (battleMaps: TableModes['battleMaps']): TableModes => ({ transformations: 'offered', illustrations: 'unavailable', battleMaps });

describe('the battle-maps table rule (spec §5.2)', () => {
  it('defaults to When it helps', () => {
    expect(battleMapsMode({})).toBe('auto');
    expect(battleMapsMode({ battleMaps: 'off' })).toBe('off');
  });

  it('renders each mode, the principles only when maps are on', () => {
    const off = battleMapsSection('off');
    expect(off.startsWith("## Battle maps: Off\nThe player prefers the theater of the mind: don't put fights on a battle map")).toBe(true);
    expect(off).toContain('you may take it away with update_map remove');
    expect(off).not.toContain('\n- ');
    const auto = battleMapsSection('auto');
    expect(auto.startsWith('## Battle maps: When it helps\nPut a fight on the battle map when positions will matter')).toBe(true);
    for (const phrase of [
      'Setting up is one call: start_combat with `map`',
      'Map only what the hero can perceive',
      'The app owns positions and geometry',
      'Never estimate them.',
      'one creature at a time, then update_combat next_turn',
      'give roll_dice `attacker` and `target`',
      'move_tokens asks the player itself and tells you the answer',
      'The player moves the hero on the map during their turn',
      'Resolve every area of effect with resolve_area',
      "A player's [Area: …] note gives the parameters to use.",
      'roll for them with secret: true, and reveal them with update_combat reveal',
      'Narrate places and features',
    ]) {
      expect(auto, phrase).toContain(phrase);
    }
    const always = battleMapsSection('always');
    expect(always.startsWith('## Battle maps: Every fight\nThe player loves tactical play: put every fight on a battle map')).toBe(true);
    expect(always).toContain('- Setting up is one call');
    // About 2,350 characters with the principles (≈ 650 cached tokens), about 330 for Off.
    expect(auto.length).toBeLessThan(2800);
    expect(off.length).toBeLessThan(450);
  });

  it('reads back what the frozen prompt and later notes told the DM', () => {
    expect(modesTold(prompt('auto'), []).battleMaps).toBe('auto');
    expect(modesTold(prompt('off'), []).battleMaps).toBe('off');
    expect(modesTold(prompt('always'), []).battleMaps).toBe('always');
    expect(modesTold(prompt(null), []).battleMaps).toBeUndefined();
    expect(modesTold(prompt('auto'), [battleMapsNotice('off', { withPrinciples: false })]).battleMaps).toBe('off');
  });

  it('sends one note when the rule changes mid-session, with the guidance only when maps come back on', () => {
    const toOff = modeNotices(modesTold(prompt('auto'), []), now('off'));
    expect(toOff).toEqual([battleMapsNotice('off', { withPrinciples: false })]);
    expect(toOff[0]).toMatch(/^Setting update — Battle maps: Off\. The player prefers the theater of the mind/);
    expect(toOff[0]).not.toContain('\n');

    const backOn = modeNotices(modesTold(prompt('off'), []), now('auto'));
    expect(backOn).toHaveLength(1);
    expect(backOn[0]).toMatch(/^Setting update — Battle maps: When it helps\. Put a fight on the battle map/);
    expect(backOn[0]).toContain('Setting up is one call');

    const always = modeNotices(modesTold(prompt('auto'), []), now('always'));
    expect(always[0]).toMatch(/^Setting update — Battle maps: Every fight\./);
    expect(always[0]).not.toContain('Setting up is one call');

    expect(modeNotices(modesTold(prompt('auto'), []), now('auto'))).toEqual([]);
    // A session whose prompt predates the section gets no note.
    expect(modeNotices(modesTold(prompt(null), []), now('off'))).toEqual([]);
  });
});
