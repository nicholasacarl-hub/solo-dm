/**
 * Offline species parser (spec §3.9): Mothkin (2024 labels, a lineage trait named by its text and a
 * lineage table) and Bramblefolk (older run-ins, subrace headings) give the scripted wire; the flattened
 * Mothkin has no run-ins, so its traits are reported missing (it goes to Claude). Invented content only.
 */
import { describe, expect, it } from 'vitest';
import { GLOAMWOOD_SOURCE_ID, SCRIPTED_WIRE, gloamwoodEntries } from '@/test/structuredFixtures';
import { segment, type Candidate } from '../segment';
import type { Wire } from '../wire';
import { parseSpecies } from './species';

const ctx = { knownSpellNames: new Set<string>(), knownClassNames: new Set(['fighter', 'cleric']) };
const candidate = (name: string, dialect: 'md' | 'mixed' = 'md') =>
  segment(gloamwoodEntries(GLOAMWOOD_SOURCE_ID, dialect), ctx).candidates.find((c) => c.name === name) as Candidate & { kind: 'species' };

describe('parseSpecies', () => {
  it('reads Mothkin (Markdown)', () => {
    const { wire, missing } = parseSpecies(candidate('Mothkin'));
    expect(wire).toEqual(SCRIPTED_WIRE.Mothkin.wire as Wire<'species'>);
    expect(missing).toEqual([]);
  });

  for (const dialect of ['md', 'mixed'] as const) {
    it(`reads the older-format Bramblefolk (${dialect})`, () => {
      const { wire, missing } = parseSpecies(candidate('Bramblefolk', dialect));
      expect(wire).toEqual(SCRIPTED_WIRE.Bramblefolk.wire as Wire<'species'>);
      expect(missing).toEqual([]);
    });
  }

  it('leaves the flattened Mothkin to Claude: no traits without run-ins', () => {
    const { wire, missing } = parseSpecies(candidate('Mothkin', 'mixed'));
    expect(wire.traits).toEqual([]);
    expect(missing).toEqual(['traits']);
    expect(wire.sizeText).toBe((SCRIPTED_WIRE.Mothkin.wire as Wire<'species'>).sizeText);
  });

  it('reads lineages given as run-ins inside the lineage trait', () => {
    const base = candidate('Mothkin');
    const block = {
      ...base.blocks[0],
      paragraphs: [
        '- **Size:** Small',
        '- **Speed:** 25 feet',
        '_**Glow Lineage.**_ Choose one of the following lineages.',
        '**Amber.** You know the Light cantrip.',
        '**Violet.** You know the Message cantrip.',
      ],
    };
    const { wire } = parseSpecies({ ...base, blocks: [block] });
    expect(wire.lineageTraitName).toBe('Glow Lineage');
    expect(wire.lineages).toEqual([
      { name: 'Amber', text: { block: 'B1', from: 4, to: 4 } },
      { name: 'Violet', text: { block: 'B1', from: 5, to: 5 } },
    ]);
  });
});
