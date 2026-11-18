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

  it('reads a class table printed with two header rows (a pasted page’s "Spell Slots per Spell Level" over 1 to 5)', () => {
    const header = '| Level | Proficiency Bonus | Class Features | Wicks | Prepared Spells | 1st | 2nd | 3rd | 4th | 5th |\n|---|---|---|---|---|---|---|---|---|---|';
    for (const slots of ['1 | 2 | 3 | 4 | 5', '1st | 2nd | 3rd | 4th | 5th']) {
      const entries = gloamwoodEntries(GLOAMWOOD_SOURCE_ID, 'md').map((e) =>
        e.text.includes(header)
          ? {
              ...e,
              text: e.text.replace(
                header,
                `| Level | Proficiency Bonus | Class Features | Wicks | Prepared Spells | —Spell Slots per Spell Level— |  |  |  |  |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n|  |  |  |  |  | ${slots} |`,
              ),
            }
          : e,
      );
      expect(entries.some((e) => e.text.includes('—Spell Slots per Spell Level—'))).toBe(true);
      const candidate = segment(entries, ctx).candidates.find((c) => c.name === 'Wickwright') as Candidate & { kind: 'class' };
      const { wire, missing } = parseClass(candidate, new Map(entries.map((e) => [e.id, e])));
      expect(wire).toEqual(SCRIPTED_WIRE.Wickwright.wire as Wire<'class'>);
      expect(missing).toEqual([]);
    }
    // A note row after level 20 leaves a one-row header alone.
    const noted = gloamwoodEntries(GLOAMWOOD_SOURCE_ID, 'md').map((e) =>
      e.text.includes(header) ? { ...e, text: e.text.replace(/(\| 20 \| \+6 \|[^\n]*)/, '$1\n| Wicks reset at dawn. |  |  |  |  |  |  |  |  |  |') } : e,
    );
    expect(noted.some((e) => e.text.includes('Wicks reset at dawn.'))).toBe(true);
    const candidate = segment(noted, ctx).candidates.find((c) => c.name === 'Wickwright') as Candidate & { kind: 'class' };
    expect(parseClass(candidate, new Map(noted.map((e) => [e.id, e]))).wire).toEqual(SCRIPTED_WIRE.Wickwright.wire as Wire<'class'>);
  });

  it('leaves the flattened Wickwright to Claude', () => {
    const { candidate, entriesById } = setup('mixed');
    const { missing } = parseClass(candidate, entriesById);
    expect(missing).toContain('levelTable');
  });
});
