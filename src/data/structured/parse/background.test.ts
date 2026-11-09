/**
 * Offline background parser (spec §3.9): Lamplighter (2024 labels) and Ferry Hand (older layout with a
 * "Feature:" heading) give the scripted wire in both dialects. Invented content only.
 */
import { describe, expect, it } from 'vitest';
import { GLOAMWOOD_SOURCE_ID, SCRIPTED_WIRE, gloamwoodEntries } from '@/test/structuredFixtures';
import { segment, type Candidate } from '../segment';
import type { Wire } from '../wire';
import { parseBackground } from './background';

const ctx = { knownSpellNames: new Set<string>(), knownClassNames: new Set(['fighter', 'cleric']) };
const candidate = (name: string, dialect: 'md' | 'mixed' = 'md') =>
  segment(gloamwoodEntries(GLOAMWOOD_SOURCE_ID, dialect), ctx).candidates.find((c) => c.name === name) as Candidate & { kind: 'background' };

describe('parseBackground', () => {
  for (const dialect of ['md', 'mixed'] as const) {
    for (const name of ['Lamplighter', 'Ferry Hand']) {
      it(`reads ${name} (${dialect})`, () => {
        const { wire, missing } = parseBackground(candidate(name, dialect));
        expect(wire).toEqual(SCRIPTED_WIRE[name].wire as Wire<'background'>);
        expect(missing).toEqual([]);
      });
    }
  }

  it('reads plain "Label: value" lines (a PDF text layer) and a Feature run-in', () => {
    const base = candidate('Lamplighter');
    const flat: Candidate = {
      ...base,
      blocks: [
        {
          ...base.blocks[0],
          paragraphs: [
            'Lamplighters walk the forest roads at dusk.',
            'Skill Proficiencies: Perception, Stealth',
            'Equipment: Rope, 10 GP',
            '**Feature: Lamp Road.** Travelers share their fires with you.',
            'The second paragraph of the feature.',
          ],
        },
      ],
    };
    const { wire, missing } = parseBackground(flat);
    expect(wire).toMatchObject({ format: '2014', skillsText: 'Perception, Stealth', equipmentText: 'Rope, 10 GP' });
    expect(wire.legacyFeature).toEqual({ name: 'Lamp Road', text: { block: 'B1', from: 4, to: 5 } });
    expect(missing).toEqual([]);
  });

  it('lists the key fields it could not read', () => {
    const base = candidate('Lamplighter');
    const bare: Candidate = { ...base, blocks: [{ ...base.blocks[0], paragraphs: ['**Ability Scores:** Strength, Dexterity, Wisdom'] }] };
    expect(parseBackground(bare).missing).toEqual(['skillsText', 'equipmentText']);
  });
});
