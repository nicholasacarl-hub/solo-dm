/**
 * Offline subclass parser (spec §3.9): "X Subclass: Name" with "Level N:" features (Ember Warden, the
 * Order of the Long Wick) and an older domain whose features say "At 1st level" (Dusk Domain, with its
 * always-prepared spell table). Invented content only.
 */
import { describe, expect, it } from 'vitest';
import { chunkDocument } from '@/data/chunk';
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

  it('reads a subclass with a Spellcasting feature of its own as a third caster, with the ability it names', () => {
    const read = (casting: string, more = '') => {
      const md = [
        '## Fighter Subclass: Lantern Knight',
        '_Kindle Wards on Your Blade_',
        'Lantern Knights learn a little of a wizard’s craft to guard the lamp roads.',
        casting,
        more,
        '### Level 7: Smoke Ward',
        'When a creature you can see hits you, you can wreathe yourself in lantern smoke.',
      ].filter(Boolean).join('\n\n');
      const entries = chunkDocument(md, { sourceId: 't', sourceName: 'T' });
      const found = segment(entries, ctx).candidates.find((c) => c.name === 'Lantern Knight') as Candidate & { kind: 'subclass' };
      const { wire, missing } = parseSubclass(found);
      return { casterType: wire.casterType, ability: wire.spellcastingAbility, parent: wire.parentClassText, missing };
    };
    const ability = '**_Spellcasting Ability._** Intelligence is your spellcasting ability for these spells.';
    expect(read(`### Level 3: Spellcasting\n\nYou learn to cast spells from lantern-lit runes.\n\n${ability}`)).toEqual({ casterType: 'third', ability: 'int', parent: 'Fighter', missing: [] });
    // Older books: "When you reach 3rd level"; the ability under a sub-heading of its own.
    expect(read('### Spellcasting\n\nWhen you reach 3rd level, you learn to cast spells from lantern-lit runes.', '#### Spellcasting Ability\n\nWisdom is your spellcasting ability for these spells.')).toEqual({
      casterType: 'third',
      ability: 'wis',
      parent: 'Fighter',
      missing: [],
    });
    // No ability named: Claude reads it.
    expect(read('### Level 3: Spellcasting\n\nYou learn to cast spells from lantern-lit runes.')).toEqual({ casterType: 'third', ability: 'none', parent: 'Fighter', missing: ['spellcastingAbility'] });
    // A subclass whose features only name spells isn't a caster of its own.
    expect(read('### Level 3: Lantern Spells\n\nYou always have the Light cantrip prepared.')).toEqual({ casterType: 'none', ability: 'none', parent: 'Fighter', missing: [] });
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
