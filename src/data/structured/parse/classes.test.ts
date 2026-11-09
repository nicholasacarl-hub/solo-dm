/**
 * Offline class parser (spec §3.9): the intact Markdown Wickwright (Core Traits table, the 20-row class
 * table, Level N: features) gives the scripted wire; the flattened one loses its tables and goes to
 * Claude. Invented content only.
 */
import { describe, expect, it } from 'vitest';
import { GLOAMWOOD_SOURCE_ID, SCRIPTED_WIRE, gloamwoodEntries } from '@/test/structuredFixtures';
import { segment, type Candidate } from '../segment';
import type { Wire } from '../wire';
import { parseClass } from './classes';

const ctx = { knownSpellNames: new Set<string>(), knownClassNames: new Set(['fighter', 'cleric']) };
function setup(dialect: 'md' | 'mixed') {
  const entries = gloamwoodEntries(GLOAMWOOD_SOURCE_ID, dialect);
  const candidate = segment(entries, ctx).candidates.find((c) => c.name === 'Wickwright') as Candidate & { kind: 'class' };
  return { candidate, entriesById: new Map(entries.map((e) => [e.id, e])) };
}

describe('parseClass', () => {
  it('reads the Markdown Wickwright from its tables and features', () => {
    const { candidate, entriesById } = setup('md');
    const { wire, missing } = parseClass(candidate, entriesById);
    expect(wire).toEqual(SCRIPTED_WIRE.Wickwright.wire as Wire<'class'>);
    expect(missing).toEqual([]);
  });

  it('reads the tables from the blocks\' own texts (without them the level table and primary ability are missing)', () => {
    const { candidate, entriesById } = setup('md');
    expect(parseClass(candidate).wire).toEqual(parseClass(candidate, entriesById).wire);
    const bare = { ...candidate, blocks: candidate.blocks.map(({ text: _text, ...b }) => b) };
    const { wire, missing } = parseClass(bare);
    expect(missing).toEqual(['primaryAbilityText', 'levelTable']);
    expect(wire.hitDieText).toBe('D8 per Wickwright level');
  });

  it('leaves the flattened Wickwright to Claude', () => {
    const { candidate, entriesById } = setup('mixed');
    const { missing } = parseClass(candidate, entriesById);
    expect(missing).toContain('levelTable');
  });
});
