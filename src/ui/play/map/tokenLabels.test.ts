import { describe, expect, it } from 'vitest';
import { conditionAbbr, conditionPills, healthGlyph, healthTone, tokenShape } from './tokenStyle';
import { tokenLabels } from './tokenLabels';

const labels = (...names: string[]) => [...tokenLabels(names.map((name, i) => ({ id: `c${i}`, name }))).values()];

describe('tokenLabels (spec §7.7)', () => {
  it('uses word initials (at most two) and a trailing number', () => {
    expect(labels('Goblin 2', 'Bandit Captain', 'Mira Voss', 'Old Tam')).toEqual(['G2', 'BC', 'MV', 'OT']);
    expect(labels('Dock Ogre')).toEqual(['DO']);
    expect(labels('Giant Wolf Spider')).toEqual(['GW']);
  });

  it('grows the first word when two labels would clash', () => {
    expect(labels('Bandit 1', 'Brute 1')).toEqual(['Ba1', 'Br1']);
    expect(labels('Goblin', 'Ghoul')).toEqual(['Go', 'Gh']);
  });

  it('stays within 4 characters and is deterministic', () => {
    const many = labels('Bandit Captain 12', 'Bandit Cutpurse 12', 'Wolf 100', '***');
    for (const l of many) expect(l.length).toBeLessThanOrEqual(4);
    expect(labels('Bandit Captain 12', 'Bandit Cutpurse 12', 'Wolf 100', '***')).toEqual(many);
    expect(many.at(-1)).toBe('?');
  });

  it('stops growing labels that can’t differ (identical names: the card and the list tell them apart)', () => {
    expect(labels('Rat', 'Rat')).toEqual(['Rat', 'Rat']);
  });
});

describe('token style (spec §7.7, D62)', () => {
  it('draws each side with its own shape', () => {
    expect([tokenShape('player'), tokenShape('ally'), tokenShape('enemy'), tokenShape('neutral')]).toEqual(['hero', 'ally', 'enemy', 'neutral']);
  });

  it('shows up to three two-letter condition pills and how many more', () => {
    expect(conditionAbbr({ id: 'prone' })).toBe('Pr');
    expect(conditionAbbr({ id: 'exhaustion', level: 2 })).toBe('Ex2');
    expect(conditionAbbr({ id: 'dazzled' })).toBe('Da');
    expect(conditionPills([{ id: 'prone' }, { id: 'poisoned' }, { id: 'grappled' }, { id: 'frightened' }])).toEqual({ pills: ['Pr', 'Po', 'Gr'], more: 1 });
  });

  it('shows health by glyph (never colour alone), the arc by the tracker thresholds', () => {
    expect([healthGlyph('unhurt'), healthGlyph('scratched'), healthGlyph('bloodied'), healthGlyph('critical'), healthGlyph('down'), healthGlyph(null)]).toEqual([
      null,
      null,
      'bloodied',
      'critical',
      'down',
      null,
    ]);
    expect(healthTone({ max: 10, current: 8, temp: 0 })).toBe('var(--success)');
    expect(healthTone({ max: 10, current: 4, temp: 0 })).toBe('var(--gold)');
    expect(healthTone({ max: 10, current: 2, temp: 0 })).toBe('var(--danger)');
  });
});
