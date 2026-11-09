/**
 * The species normalizer (spec §3.9, §5.6): Mothkin (lineage trait by name, table-row lineages) and
 * Bramblefolk (older: increases kept for reference, languages suggested, Humanoid by default).
 */
import { describe, expect, it } from 'vitest';
import { EXPECTED_ADAPTATIONS, EXPECTED_DATA, GLOAMWOOD_SOURCE_ID, SCRIPTED_WIRE, gloamwoodEntries } from '@/test/structuredFixtures';
import { parseSpecies } from '../parse/species';
import { DATA_SCHEMAS } from '../schemas';
import { segment, type Candidate } from '../segment';
import type { Wire } from '../wire';
import type { NormalizeContext } from './index';
import { legacyIncreasesOf, normalizeSpecies, validateSpecies } from './species';

const entries = gloamwoodEntries(GLOAMWOOD_SOURCE_ID);
const { candidates, spellLists } = segment(entries, { knownSpellNames: new Set(), knownClassNames: new Set(['fighter', 'cleric']) });
const candidate = (name: string) => candidates.find((c) => c.name === name) as Candidate & { kind: 'species' };
const context = (name: string): NormalizeContext => ({ blocks: candidate(name).blocks, entriesById: new Map(entries.map((e) => [e.id, e])), origin: 'claude', spellLists });

describe('normalizeSpecies', () => {
  for (const name of ['Mothkin', 'Bramblefolk'] as const) {
    it(`turns ${name}'s scripted wire into its data and notes`, () => {
      const out = normalizeSpecies(SCRIPTED_WIRE[name].wire as Wire<'species'>, context(name));
      expect(out.data).toEqual(EXPECTED_DATA[name]);
      expect(out.adaptations).toEqual(EXPECTED_ADAPTATIONS[name] ?? []);
      expect(out.warnings.filter((w) => w.severity !== 'info')).toEqual([]);
      expect(out.confidence).toBe('high');
      expect(DATA_SCHEMAS.species.safeParse(out.data).success).toBe(true);
    });
    it(`gives the same data from the offline parse of ${name}`, () => {
      const parsed = parseSpecies(candidate(name));
      expect(normalizeSpecies(parsed.wire, { ...context(name), origin: 'parser', missing: parsed.missing }).data).toEqual(EXPECTED_DATA[name]);
    });
  }

  it('fills Humanoid when no creature type is printed, as an info', () => {
    const out = normalizeSpecies(SCRIPTED_WIRE.Bramblefolk.wire as Wire<'species'>, context('Bramblefolk'));
    expect(out.warnings).toEqual([{ code: 'default-used', severity: 'info', field: 'creatureType', message: 'No creature type is printed: the app used Humanoid.' }]);
  });

  it('blocks a span outside its block and warns on a lineage trait that is not a trait', () => {
    const wire = SCRIPTED_WIRE.Mothkin.wire as Wire<'species'>;
    const broken = { ...wire, traits: [{ ...wire.traits[0], text: { block: 'B1', from: 9, to: 40 } }, ...wire.traits.slice(1)], lineageTraitName: 'Moth Wings' };
    const out = normalizeSpecies(broken, context('Mothkin'));
    expect(out.warnings.map((w) => [w.code, w.severity])).toEqual([
      ['unresolved-text', 'block'],
      ['cross-check', 'warn'],
    ]);
    expect(out.data?.traits.map((t) => t.name)).toEqual(['Powdered Wings', 'Lamp-Drawn']);
    expect(out.confidence).toBe('low');
  });

  it('reads older ability score increases', () => {
    expect(legacyIncreasesOf('Your Strength score increases by 2.')).toEqual([{ ability: 'str', amount: 2 }]);
    expect(legacyIncreasesOf('Two different ability scores of your choice increase by 1.')).toEqual([
      { ability: 'any', amount: 1 },
      { ability: 'any', amount: 1 },
    ]);
  });

  it('validates stored data', () => {
    expect(validateSpecies(EXPECTED_DATA.Mothkin, context('Mothkin'), 'Mothkin')).toEqual({ warnings: [], adaptations: [], confidence: 'high' });
  });
});
