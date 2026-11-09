/**
 * The feat normalizer (spec §3.9): scripted wire and offline parse → EXPECTED_DATA; category "unknown"
 * → General with the feat-general note (§5.6); an ungrounded excerpt lowers confidence to medium; the
 * outputs pass DATA_SCHEMAS. Invented content only.
 */
import { describe, expect, it } from 'vitest';
import { EXPECTED_DATA, GLOAMWOOD_SOURCE_ID, SCRIPTED_WIRE, gloamwoodEntries } from '@/test/structuredFixtures';
import type { FeatData } from '@/types';
import { parseFeat } from '../parse/feat';
import { DATA_SCHEMAS } from '../schemas';
import { segment, type Candidate } from '../segment';
import type { Wire } from '../wire';
import type { NormalizeContext } from './index';
import { abilityIncreaseOf, cleanPrerequisite, minLevelOf, normalizeFeat, validateFeat } from './feat';

const entries = gloamwoodEntries(GLOAMWOOD_SOURCE_ID);
const { candidates, spellLists } = segment(entries, { knownSpellNames: new Set(), knownClassNames: new Set(['fighter', 'cleric']) });
const candidate = (name: string) => candidates.find((c) => c.name === name) as Candidate & { kind: 'feat' };
const context = (name: string, origin: NormalizeContext['origin'] = 'claude'): NormalizeContext => ({
  blocks: candidate(name).blocks,
  entriesById: new Map(entries.map((e) => [e.id, e])),
  origin,
  spellLists,
});
const FEATS = ["Moth's Grace", 'Lantern Bearer', 'Watchlight Vigil', 'Hooked Reach'] as const;

describe('normalizeFeat', () => {
  for (const name of FEATS) {
    it(`turns ${name}'s scripted wire into its data, cleanly`, () => {
      const out = normalizeFeat(SCRIPTED_WIRE[name].wire as Wire<'feat'>, context(name));
      expect(out.data).toEqual(EXPECTED_DATA[name]);
      expect(out).toMatchObject({ name, warnings: [], adaptations: [], confidence: 'high' });
      expect(DATA_SCHEMAS.feat.safeParse(out.data).success).toBe(true);
      expect(out.excerpts.every((e) => e.grounded)).toBe(true);
    });
    it(`gives the same data from the offline parse of ${name}`, () => {
      const parsed = parseFeat(candidate(name));
      const out = normalizeFeat(parsed.wire, { ...context(name, 'parser'), missing: parsed.missing });
      expect(out.data).toEqual(EXPECTED_DATA[name]);
      expect(out.confidence).toBe('high');
    });
  }

  it('treats a feat without a category as General (older books)', () => {
    const wire = { ...(SCRIPTED_WIRE['Watchlight Vigil'].wire as Wire<'feat'>), format: '2014' as const, category: 'unknown' as const, categoryText: '' };
    const out = normalizeFeat(wire, context('Watchlight Vigil'));
    expect(out.data?.category).toBe('general');
    expect(out.adaptations).toEqual([{ code: 'feat-general', note: 'No feat category is printed, so Watchlight Vigil is treated as a General feat.' }]);
    expect(out.confidence).toBe('high');
  });

  it('flags an excerpt that is not in the text, and "not this kind"', () => {
    const wire = { ...(SCRIPTED_WIRE['Lantern Bearer'].wire as Wire<'feat'>), prerequisiteText: 'Level 6+' };
    const out = normalizeFeat(wire, context('Lantern Bearer'));
    expect(out.warnings.map((w) => [w.code, w.field])).toEqual([['ungrounded', 'prerequisite']]);
    expect(out.confidence).toBe('medium');
    expect(out.data?.minLevel).toBe(6);
    const other = normalizeFeat({ ...wire, matchesKind: false }, context('Lantern Bearer'));
    expect(other.warnings.some((w) => w.code === 'not-this-kind' && w.severity === 'block')).toBe(true);
    expect(other.confidence).toBe('low');
  });

  it("keeps Claude's note as the record's model note (info)", () => {
    const out = normalizeFeat({ ...(SCRIPTED_WIRE["Moth's Grace"].wire as Wire<'feat'>), notes: 'Two feats share this heading.' }, context("Moth's Grace"));
    expect(out.modelNote).toBe('Two feats share this heading.');
    expect(out.warnings).toEqual([{ code: 'model-note', severity: 'info', message: 'Claude left a note about this entry.' }]);
    expect(out.confidence).toBe('high');
  });
});

describe('feat fields', () => {
  it('reads prerequisites, minimum levels and ability increases', () => {
    expect(cleanPrerequisite('Prerequisite: Level 4+')).toBe('Level 4+');
    expect(minLevelOf('Level 4+, Strength or Dexterity 13+')).toBe(4);
    expect(minLevelOf('Spellcasting Feature')).toBeUndefined();
    expect(abilityIncreaseOf('Increase your Strength or Dexterity score by 1, to a maximum of 20.')).toEqual({ abilities: ['str', 'dex'], amount: 1 });
    expect(abilityIncreaseOf('Increase one ability score of your choice by 2.')?.abilities).toHaveLength(6);
    expect(abilityIncreaseOf('')).toBeUndefined();
  });

  it('validates stored data: the span and the implied adaptation', () => {
    const data = { ...EXPECTED_DATA['Lantern Bearer'], format: '2014' } as FeatData;
    expect(validateFeat(data, context('Lantern Bearer'), 'Lantern Bearer')).toMatchObject({ warnings: [], confidence: 'high', adaptations: [{ code: 'feat-general' }] });
    const broken = { ...data, text: { ...data.text, to: 99 } };
    expect(validateFeat(broken, context('Lantern Bearer')).warnings[0]).toMatchObject({ code: 'unresolved-text', severity: 'block' });
  });
});
