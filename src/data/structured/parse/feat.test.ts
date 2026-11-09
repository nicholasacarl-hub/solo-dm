/**
 * Offline feat parser (spec §3.9): the Gloamwood feats in both dialects give the scripted wire, and an
 * older-format feat (no category) reads as "unknown". Invented content only.
 */
import { describe, expect, it } from 'vitest';
import { GLOAMWOOD_SOURCE_ID, SCRIPTED_WIRE, gloamwoodEntries } from '@/test/structuredFixtures';
import { segment, type Candidate } from '../segment';
import type { Wire } from '../wire';
import { parseFeat } from './feat';

const ctx = { knownSpellNames: new Set<string>(), knownClassNames: new Set(['fighter', 'cleric']) };
const candidates = (dialect: 'md' | 'mixed') => segment(gloamwoodEntries(GLOAMWOOD_SOURCE_ID, dialect), ctx).candidates;
const candidate = (name: string, dialect: 'md' | 'mixed' = 'md') => candidates(dialect).find((c) => c.name === name) as Candidate & { kind: 'feat' };

describe('parseFeat', () => {
  for (const dialect of ['md', 'mixed'] as const) {
    for (const name of ["Moth's Grace", 'Lantern Bearer', 'Watchlight Vigil', 'Hooked Reach']) {
      it(`reads ${name} (${dialect})`, () => {
        const { wire, missing } = parseFeat(candidate(name, dialect));
        expect(wire).toEqual(SCRIPTED_WIRE[name].wire as Wire<'feat'>);
        expect(missing).toEqual([]);
      });
    }
  }

  it('reads an older feat with a bare Prerequisite line and no category', () => {
    const base = candidate('Watchlight Vigil');
    const older: Candidate = {
      ...base,
      blocks: [{ ...base.blocks[0], path: ['Feats', 'Watchlight Vigil'], paragraphs: ['*Prerequisite: Wisdom 13 or higher*', 'You can keep watch. You can take this feat more than once.', '***Repeatable.*** Yes.'] }],
    };
    const { wire } = parseFeat(older);
    expect(wire).toMatchObject({ format: '2014', categoryText: '', category: 'unknown', prerequisiteText: 'Wisdom 13 or higher', repeatable: true });
  });

  it('takes the category from a "Fighting Style Feats" heading when the line has none', () => {
    const base = candidate('Hooked Reach');
    const older: Candidate = { ...base, blocks: [{ ...base.blocks[0], paragraphs: ['You hold your ground.'] }] };
    expect(parseFeat(older).wire).toMatchObject({ format: '2014', category: 'fighting-style', categoryText: '' });
  });
});
