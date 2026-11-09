/**
 * The subclass normalizer (spec §3.9): Ember Warden, Dusk Domain (older, with always-prepared spells) and
 * the Order of the Long Wick; subclasses are never "high" (the review confirms their class).
 */
import { describe, expect, it } from 'vitest';
import { EXPECTED_DATA, GLOAMWOOD_SOURCE_ID, SCRIPTED_WIRE, gloamwoodEntries } from '@/test/structuredFixtures';
import { parseSubclass } from '../parse/subclass';
import { DATA_SCHEMAS } from '../schemas';
import { segment, type Candidate } from '../segment';
import type { Wire } from '../wire';
import type { NormalizeContext } from './index';
import { normalizeSubclass, validateSubclass } from './subclass';

const entries = gloamwoodEntries(GLOAMWOOD_SOURCE_ID);
const { candidates, spellLists } = segment(entries, { knownSpellNames: new Set(), knownClassNames: new Set(['fighter', 'cleric']) });
const candidate = (name: string) => candidates.find((c) => c.name === name) as Candidate & { kind: 'subclass' };
const context = (name: string): NormalizeContext => ({ blocks: candidate(name).blocks, entriesById: new Map(entries.map((e) => [e.id, e])), origin: 'claude', spellLists });
const CASES = [
  ['Ember Warden', 'Fighter Subclass: Ember Warden'],
  ['Dusk Domain', 'Dusk Domain'],
  ['Order of the Long Wick', 'Wickwright Subclass: Order of the Long Wick'],
] as const;

describe('normalizeSubclass', () => {
  for (const [name, title] of CASES) {
    it(`turns ${name}'s scripted wire into its data (medium at best)`, () => {
      const out = normalizeSubclass(SCRIPTED_WIRE[title].wire as Wire<'subclass'>, context(name));
      expect(out.data).toEqual(EXPECTED_DATA[name]);
      expect(out.warnings).toEqual([]);
      expect(out.confidence).toBe('medium');
      expect(DATA_SCHEMAS.subclass.safeParse(out.data).success).toBe(true);
    });
    it(`gives the same data from the offline parse of ${name}`, () => {
      const parsed = parseSubclass(candidate(name));
      expect(normalizeSubclass(parsed.wire, { ...context(name), origin: 'parser', missing: parsed.missing }).data).toEqual(EXPECTED_DATA[name]);
    });
  }

  it('takes the parent from the title when Claude leaves it empty, and blocks when there is none', () => {
    const wire = SCRIPTED_WIRE['Fighter Subclass: Ember Warden'].wire as Wire<'subclass'>;
    expect(normalizeSubclass({ ...wire, parentClassText: '' }, context('Ember Warden')).data?.parentClass).toBe('Fighter');
    const lone = { ...context('Ember Warden'), blocks: context('Ember Warden').blocks.map((b, i) => (i ? b : { ...b, title: 'Ember Warden', path: ['Ember Warden'] })) };
    const out = normalizeSubclass({ ...wire, parentClassText: '' }, lone);
    expect(out.warnings.map((w) => [w.code, w.severity])).toEqual([['unresolved-ref', 'block']]);
    expect(out.confidence).toBe('low');
  });

  it('blocks a feature level outside 1–20 and keeps third-caster spellcasting', () => {
    const wire = SCRIPTED_WIRE['Fighter Subclass: Ember Warden'].wire as Wire<'subclass'>;
    const out = normalizeSubclass({ ...wire, casterType: 'third', spellcastingAbility: 'int', features: [...wire.features, { ...wire.features[0], level: 25 }] }, context('Ember Warden'));
    expect(out.data).toMatchObject({ casterType: 'third', spellcastingAbility: 'int' });
    expect(out.data?.features).toHaveLength(3);
    expect(out.warnings.map((w) => [w.code, w.severity])).toEqual([['out-of-range', 'block']]);
  });

  it('validates stored data', () => {
    expect(validateSubclass(EXPECTED_DATA['Ember Warden'], context('Ember Warden'))).toEqual({ warnings: [], adaptations: [], confidence: 'medium' });
  });
});
