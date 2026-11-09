/**
 * Offline subclass parser (spec §3.9): "X Subclass: Name" with "Level N:" features (Ember Warden, the
 * Order of the Long Wick) and an older domain whose features say "At 1st level" (Dusk Domain, with its
 * always-prepared spell table). Invented content only.
 */
import { describe, expect, it } from 'vitest';
import { GLOAMWOOD_SOURCE_ID, SCRIPTED_WIRE, gloamwoodEntries } from '@/test/structuredFixtures';
import { segment, type Candidate } from '../segment';
import type { Wire } from '../wire';
import { levelCell, parseSubclass } from './subclass';

const ctx = { knownSpellNames: new Set<string>(), knownClassNames: new Set(['fighter', 'cleric']) };
const candidate = (name: string, dialect: 'md' | 'mixed' = 'md') =>
  segment(gloamwoodEntries(GLOAMWOOD_SOURCE_ID, dialect), ctx).candidates.find((c) => c.name === name) as Candidate & { kind: 'subclass' };
const scripted = (title: string) => SCRIPTED_WIRE[title].wire as Wire<'subclass'>;

describe('parseSubclass', () => {
  for (const dialect of ['md', 'mixed'] as const) {
    it(`reads Ember Warden (${dialect})`, () => {
      const { wire, missing } = parseSubclass(candidate('Ember Warden', dialect));
      expect(wire).toEqual(scripted('Fighter Subclass: Ember Warden'));
      expect(missing).toEqual([]);
    });
    it(`reads Dusk Domain, its older feature levels and its spells (${dialect})`, () => {
      const { wire } = parseSubclass(candidate('Dusk Domain', dialect));
      expect(wire).toEqual(scripted('Dusk Domain'));
    });
  }

  it('reads the Order of the Long Wick nested under its class', () => {
    expect(parseSubclass(candidate('Order of the Long Wick')).wire).toEqual(scripted('Wickwright Subclass: Order of the Long Wick'));
  });

  it('reports a subclass without features or parent', () => {
    const base = candidate('Ember Warden');
    const bare: Candidate = { ...base, parentClassName: undefined, blocks: [{ ...base.blocks[0], title: 'Ember Warden', path: ['Ember Warden'] }] };
    expect(parseSubclass(bare).missing).toEqual(['parentClassText', 'features']);
  });

  it('reads class levels from table cells', () => {
    expect(['1st', '3', 'Level 5', '20th', '0', '21', 'x'].map(levelCell)).toEqual([1, 3, 5, 20, null, null, null]);
  });
});
