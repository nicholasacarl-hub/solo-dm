/**
 * Species Resistances (SRD 5.2.1 "Character Origins": Dwarven Resilience, Dragonborn Damage Resistance,
 * Tiefling Fiendish Legacy). Imported species are read more loosely (older books state it mid-sentence),
 * but only resistances the hero always has are recorded. Invented traits only.
 */
import { describe, expect, it } from 'vitest';
import { sampleCharacter } from '@/test/fixtures';
import { EXPECTED_MERGED, SRD_BUILDER_DATA } from '@/test/structuredFixtures';
import type { BuilderData, Character, SpeciesOption } from '@/types';
import { refreshFeatureUses } from './leveling';
import { speciesChoices, speciesResistances } from './species';

const srd = (name: string) => SRD_BUILDER_DATA.species.find((s) => s.name === name) as SpeciesOption;
const mothkin = EXPECTED_MERGED.species.find((s) => s.name === 'Mothkin') as SpeciesOption;

/** An invented book species (source set) with the given traits and no lineages. */
const bookSpecies = (traits: SpeciesOption['traits']): SpeciesOption => ({
  ...mothkin,
  id: 'lib:gloam:species:emberfolk',
  name: 'Emberfolk',
  traits,
  lineages: undefined,
  lineageTrait: undefined,
});

describe('speciesResistances', () => {
  it('reads the SRD sentences, and the damage type of the chosen ancestry or legacy', () => {
    expect(speciesResistances(srd('Dwarf'), undefined)).toEqual(['poison']);
    const dragonborn = srd('Dragonborn');
    const red = speciesChoices(dragonborn).lineages.find((l) => l.name === 'Red');
    expect(speciesResistances(dragonborn, red)).toEqual(['fire']);
    const tiefling = srd('Tiefling');
    const infernal = speciesChoices(tiefling).lineages.find((l) => l.name === 'Infernal');
    expect(speciesResistances(tiefling, infernal)).toEqual(['fire']);
    expect(speciesResistances(srd('Human'), undefined)).toEqual([]);
  });

  it('reads an older book’s mid-sentence, lower-case resistance', () => {
    const bramblefolk = EXPECTED_MERGED.species.find((s) => s.name === 'Bramblefolk') as SpeciesOption;
    expect(speciesResistances(bramblefolk, undefined)).toEqual(['poison']);
    const plain = bookSpecies([{ name: 'Ash Blood', description: 'Your blood runs hot. You have resistance to fire damage.' }]);
    expect(speciesResistances(plain, undefined)).toEqual(['fire']);
  });

  it('B7: a book species’ conditional resistances are not recorded as lasting ones, and a level-up does not re-add them', () => {
    const traits = [
      {
        name: 'Kindle',
        description:
          'As a Bonus Action, you can wreathe yourself in embers. For 1 minute, you have resistance to fire damage. Once you use this trait, you can’t do so again until you finish a Long Rest.',
      },
      { name: 'Grim Frost', description: 'While you are Bloodied, you have Resistance to Cold damage.' },
      { name: 'Storm Hide', description: 'Your skin crackles, and you have resistance to lightning damage while you stand in rain.' },
      { name: 'Bitter Sap', description: 'Bitter sap runs under your skin, and you have resistance to poison damage.' },
    ];
    const species = bookSpecies(traits);
    expect(speciesResistances(species, undefined)).toEqual(['poison']);
    // The same sentences on an SRD-shaped option were never read (the SRD pattern wants a sentence start).
    expect(speciesResistances({ ...species, source: undefined, id: 'x' }, undefined)).toEqual([]);
    const data: BuilderData = { ...EXPECTED_MERGED, species: [...EXPECTED_MERGED.species, species] };
    const hero: Character = { ...sampleCharacter(), species: species.name, speciesId: species.id, damageResistances: [] };
    expect(refreshFeatureUses(hero, data).damageResistances).toEqual(['poison']);
  });
});
