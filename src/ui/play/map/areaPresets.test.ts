import { describe, expect, it } from 'vitest';
import type { RulesIndex } from '@/data';
import { sampleCharacter } from '@/test/fixtures';
import type { Character, CompendiumEntry } from '@/types';
import { customPreset, presetFromEntry, rangeFeet, spellPresets } from './areaPresets';

/** SRD 5.2.1 spell entries as the compendium stores them (text abridged to the lines that matter). */
function spell(id: string, name: string, range: string, text: string, area?: { shape: string; size: number }): CompendiumEntry {
  return {
    id,
    sourceId: 'srd',
    sourceName: 'SRD 5.2.1',
    kind: 'spell',
    name,
    text: `_Level 1 Evocation (Wizard)_\n\n- **Range:** ${range}\n\n${text}`,
    data: { range, ...(area ? { area } : {}) },
  };
}

const BURNING_HANDS = spell(
  'srd:spell:burning-hands',
  'Burning Hands',
  'Self',
  'A thin sheet of flames shoots forth from you. Each creature in a 15-foot Cone makes a Dexterity saving throw.',
  { shape: 'cone', size: 15 },
);
const FIREBALL = spell(
  'srd:spell:fireball',
  'Fireball',
  '150 feet',
  'Each creature in a 20-foot-radius Sphere centered on that point makes a Dexterity saving throw.',
  { shape: 'sphere', size: 20 },
);
// The stored area is the Line's width (5): the text is the source of truth (srd-rules §6.5).
const LIGHTNING_BOLT = spell(
  'srd:spell:lightning-bolt',
  'Lightning Bolt',
  'Self',
  'A stroke of lightning forming a 100-foot-long, 5-foot-wide Line blasts out from you in a direction you choose.',
  { shape: 'line', size: 5 },
);
const THUNDERWAVE = spell(
  'srd:spell:thunderwave',
  'Thunderwave',
  'Self',
  'Each creature in a 15-foot Cube originating from you makes a Constitution saving throw.',
  { shape: 'cube', size: 15 },
);
const MAGIC_MISSILE = spell('srd:spell:magic-missile', 'Magic Missile', '120 feet', 'You create three glowing darts of magical force.');
const ODD_AREA = spell('srd:spell:odd', 'Odd', '60 feet', 'Something happens.', { shape: 'sphere', size: 10 });

function mockIndex(entries: CompendiumEntry[]): RulesIndex {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return {
    search: () => [],
    get: (id) => byId.get(id),
    findByName: () => undefined,
    list: () => entries,
    sources: () => [],
  };
}

function caster(spells: { id: string; name: string; level: number; prepared: boolean }[]): Character {
  const base = sampleCharacter();
  return { ...base, spellcasting: { ...(base.spellcasting as NonNullable<Character['spellcasting']>), spells: spells.map((s) => ({ ...s, source: 'Wizard' })) } };
}

describe('area presets from spell text (D64)', () => {
  it('reads Burning Hands, Fireball and Lightning Bolt from their text', () => {
    expect(presetFromEntry(BURNING_HANDS)).toEqual({ id: 'srd:spell:burning-hands', label: 'Burning Hands', shape: 'cone', sizeFt: 15, fromSelf: true });
    expect(presetFromEntry(FIREBALL)).toEqual({ id: 'srd:spell:fireball', label: 'Fireball', shape: 'sphere', sizeFt: 20, rangeFt: 150, fromSelf: false });
    expect(presetFromEntry(LIGHTNING_BOLT)).toEqual({
      id: 'srd:spell:lightning-bolt',
      label: 'Lightning Bolt',
      shape: 'line',
      sizeFt: 100,
      widthFt: 5,
      fromSelf: true,
    });
  });

  it('places a cube "originating from you" against the hero, and falls back to data.area only when the text has none', () => {
    expect(presetFromEntry(THUNDERWAVE)).toMatchObject({ shape: 'cube', sizeFt: 15, fromSelf: true });
    expect(presetFromEntry(ODD_AREA)).toMatchObject({ shape: 'sphere', sizeFt: 10, rangeFt: 60, fromSelf: false });
    expect(presetFromEntry(MAGIC_MISSILE)).toBeNull();
  });

  it('lists the hero’s prepared spells (and cantrips) with an area, in sheet order; nothing until the index loads', () => {
    const hero = caster([
      { id: 'srd:spell:fireball', name: 'Fireball', level: 3, prepared: true },
      { id: 'srd:spell:magic-missile', name: 'Magic Missile', level: 1, prepared: true },
      { id: 'srd:spell:burning-hands', name: 'Burning Hands', level: 1, prepared: true },
      { id: 'srd:spell:lightning-bolt', name: 'Lightning Bolt', level: 3, prepared: false },
      { id: 'srd:spell:burning-hands', name: 'Burning Hands', level: 1, prepared: true },
    ]);
    const index = mockIndex([BURNING_HANDS, FIREBALL, LIGHTNING_BOLT, MAGIC_MISSILE]);
    expect(spellPresets(hero, index).map((p) => p.label)).toEqual(['Fireball', 'Burning Hands']);
    expect(spellPresets(hero, null)).toEqual([]);
  });

  it('reads ranges in feet; Self and Touch have none', () => {
    expect(rangeFeet('150 feet')).toBe(150);
    expect(rangeFeet('60 ft.')).toBe(60);
    expect(rangeFeet('1,000 feet')).toBe(1000);
    expect(rangeFeet('Self (15-foot cone)')).toBeUndefined();
    expect(rangeFeet('Touch')).toBeUndefined();
    expect(rangeFeet('1 mile')).toBe(5280);
    expect(rangeFeet(undefined)).toBeUndefined();
  });

  it('makes Custom presets with a safe one-line name', () => {
    expect(customPreset('sphere', 20)).toEqual({ id: 'custom', label: 'Sphere', shape: 'sphere', sizeFt: 20, fromSelf: false });
    expect(customPreset('line', 33, 12, 'Wall [of] fire\n')).toEqual({ id: 'custom', label: 'Wall of fire', shape: 'line', sizeFt: 35, widthFt: 10, fromSelf: true });
    expect(customPreset('emanation', 2).sizeFt).toBe(5);
  });
});
