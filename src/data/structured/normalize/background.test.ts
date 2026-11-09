/**
 * The background normalizer (spec §3.9, §5.6): Lamplighter (2024) and Ferry Hand (older layout: any three
 * abilities, an Origin feat of the player's choice, its feature kept, languages suggested). Invented content only.
 */
import { describe, expect, it } from 'vitest';
import { EXPECTED_ADAPTATIONS, EXPECTED_DATA, GLOAMWOOD_SOURCE_ID, SCRIPTED_WIRE, gloamwoodEntries } from '@/test/structuredFixtures';
import { parseBackground } from '../parse/background';
import { DATA_SCHEMAS } from '../schemas';
import { segment, type Candidate } from '../segment';
import type { Wire } from '../wire';
import type { NormalizeContext } from './index';
import { languagesOf, normalizeBackground, skillsOf, validateBackground } from './background';

const entries = gloamwoodEntries(GLOAMWOOD_SOURCE_ID);
const { candidates, spellLists } = segment(entries, { knownSpellNames: new Set(), knownClassNames: new Set(['fighter', 'cleric']) });
const candidate = (name: string) => candidates.find((c) => c.name === name) as Candidate & { kind: 'background' };
const context = (name: string): NormalizeContext => ({ blocks: candidate(name).blocks, entriesById: new Map(entries.map((e) => [e.id, e])), origin: 'claude', spellLists });

describe('normalizeBackground', () => {
  for (const name of ['Lamplighter', 'Ferry Hand'] as const) {
    it(`turns ${name}'s scripted wire into its data and notes`, () => {
      const out = normalizeBackground(SCRIPTED_WIRE[name].wire as Wire<'background'>, context(name));
      expect(out.data).toEqual(EXPECTED_DATA[name]);
      expect(out.adaptations).toEqual(EXPECTED_ADAPTATIONS[name] ?? []);
      expect(out.warnings).toEqual([]);
      expect(out.confidence).toBe('high');
      expect(DATA_SCHEMAS.background.safeParse(out.data).success).toBe(true);
    });
    it(`gives the same data from the offline parse of ${name}`, () => {
      const parsed = parseBackground(candidate(name));
      expect(normalizeBackground(parsed.wire, { ...context(name), origin: 'parser', missing: parsed.missing }).data).toEqual(EXPECTED_DATA[name]);
    });
  }

  it('warns when a 2024 background lists other than three abilities, and keeps none', () => {
    const wire = { ...(SCRIPTED_WIRE.Lamplighter.wire as Wire<'background'>), abilityScoresText: 'Dexterity, Wisdom' };
    const out = normalizeBackground(wire, context('Lamplighter'));
    expect(out.data?.abilityScores).toEqual([]);
    expect(out.warnings.map((w) => w.code)).toEqual(['cross-check']);
    expect(out.adaptations.map((a) => a.code)).toEqual(['background-any-three']);
  });

  it('reads skills and languages', () => {
    expect(skillsOf('Insight and Religion')).toEqual({ skills: ['insight', 'religion'], unknown: [] });
    expect(skillsOf('Perception, Knitting')).toEqual({ skills: ['perception'], unknown: ['Knitting'] });
    expect(languagesOf('Two of your choice')).toEqual([]);
    expect(languagesOf('Elvish and one other language of your choice')).toEqual(['Elvish']);
    expect(languagesOf('You know Common and Sylvan.')).toEqual(['Common', 'Sylvan']);
  });

  it('validates stored data', () => {
    expect(validateBackground(EXPECTED_DATA['Ferry Hand'], context('Ferry Hand'), 'Ferry Hand')).toEqual({
      warnings: [],
      adaptations: EXPECTED_ADAPTATIONS['Ferry Hand'],
      confidence: 'high',
    });
  });
});
