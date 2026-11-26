/**
 * Species Resistances (SRD 5.2.1 "Character Origins": Dwarven Resilience, Dragonborn Damage Resistance,
 * Tiefling Fiendish Legacy). Imported species are read more loosely (older books state it mid-sentence),
 * but only resistances the hero always has are recorded. Invented traits only.
 */
import { describe, expect, it } from 'vitest';
import { sampleCharacter } from '@/test/fixtures';
import { EXPECTED_MERGED, SRD_BUILDER_DATA } from '@/test/structuredFixtures';
import type { BuilderData, Character, SpeciesOption } from '@/types';
import { lineageRowText, splitRow } from '../structured/parse/srdRulesOptions';
import { refreshFeatureUses } from './leveling';
import { lineageSpellLabel, lineageSpellTags, speciesChoices, speciesResistances, withoutEmphasis } from './species';

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

describe("lineageSpellTags: the spells a lineage's table gives at character levels 3 and 5", () => {
  const tags = (species: SpeciesOption) => Object.fromEntries(speciesChoices(species).lineages.map((l) => [l.name, lineageSpellTags(l.description)]));

  it('reads every SRD lineage table: a Level 3 and a Level 5 spell each (srd:species:elf, srd:species:tiefling)', () => {
    // srd:species:elf, Elven Lineage: "When you reach character levels 3 and 5, you learn a higher-level spell, as shown on
    // the table." The table's Level 3 and Level 5 columns: "| Drow | … | Faerie Fire | Darkness |" and so on.
    expect(tags(srd('Elf'))).toEqual({
      Drow: [
        { level: 3, cell: 'Faerie Fire' },
        { level: 5, cell: 'Darkness' },
      ],
      'High Elf': [
        { level: 3, cell: 'Detect Magic' },
        { level: 5, cell: 'Misty Step' },
      ],
      'Wood Elf': [
        { level: 3, cell: 'Longstrider' },
        { level: 5, cell: 'Pass without Trace' },
      ],
    });
    // srd:species:tiefling, Fiendish Legacy: the same paragraph, "| Infernal | … | Hellish Rebuke | Darkness |".
    expect(tags(srd('Tiefling'))).toEqual({
      Abyssal: [
        { level: 3, cell: 'Ray of Sickness' },
        { level: 5, cell: 'Hold Person' },
      ],
      Chthonic: [
        { level: 3, cell: 'False Life' },
        { level: 5, cell: 'Ray of Enfeeblement' },
      ],
      Infernal: [
        { level: 3, cell: 'Hellish Rebuke' },
        { level: 5, cell: 'Darkness' },
      ],
    });
    // The other SRD species' options are no such table (Draconic Ancestry, Gnomish Lineage, Giant Ancestry).
    for (const name of ['Dragonborn', 'Gnome', 'Goliath']) {
      for (const [lineage, found] of Object.entries(tags(srd(name)))) expect(found, `${name} ${lineage}`).toEqual([]);
    }
  });

  it("reads a book's table-row lineage, never its paragraph ones (the invented Gloamwood fixture)", () => {
    // Mothkin's Lamp-Drawn table: "| Ashwing | … | Burning Hands | Continual Flame |", "| Silverwing | … | Faerie Fire | Moonbeam |".
    expect(tags(mothkin)).toEqual({
      Ashwing: [
        { level: 3, cell: 'Burning Hands' },
        { level: 5, cell: 'Continual Flame' },
      ],
      Silverwing: [
        { level: 3, cell: 'Faerie Fire' },
        { level: 5, cell: 'Moonbeam' },
      ],
    });
    // Bramblefolk's subraces are paragraphs (an older book's): none.
    const bramblefolk = EXPECTED_MERGED.species.find((s) => s.name === 'Bramblefolk') as SpeciesOption;
    expect(Object.values(tags(bramblefolk)).flat()).toEqual([]);
  });

  it('reads only the run of tags at the end of the text, with the cells as the table writes them', () => {
    // A book row laid out otherwise still yields its cells (the grant checks them against the rules index).
    expect(lineageSpellTags(lineageRowText(splitRow('| Duskborn | Resistance to Necrotic damage. | Chill Touch | False Life | Ray of Enfeeblement |')))).toEqual([
      { level: 3, cell: 'Chill Touch' },
      { level: 5, cell: 'False Life' },
    ]);
    expect(lineageSpellTags(lineageRowText(splitRow('| Duskborn | You know the _Light_ cantrip. | _Faerie Fire_ | — |')))).toEqual([{ level: 3, cell: '_Faerie Fire_' }]);
    // A sentence of the Level 1 text shaped like a tag, with more text after it, isn't one.
    expect(lineageSpellTags('Your lantern burns at Level 3: Faerie Fire. It never goes out.')).toEqual([]);
    expect(lineageSpellTags('You know the Light cantrip.')).toEqual([]);
  });
});

describe('lineageSpellLabel: a lineage spell the rules here lack, as DM text may name it (spec §2.1)', () => {
  it("quotes a cell that reads as a name, emphasis stripped, and otherwise says the app couldn't read it", () => {
    expect(withoutEmphasis('_Faerie Fire_')).toBe('Faerie Fire');
    expect(lineageSpellLabel('_Cinder Mote_', 'Ashwing')).toBe('Cinder Mote');
    expect(lineageSpellLabel("Moth's Lantern", 'Ashwing')).toBe("Moth's Lantern");
    expect(lineageSpellLabel('Choir of the Long Dusk', 'Ashwing')).toBe('Choir of the Long Dusk');
    // More than five words, sentence punctuation or nothing left: the book's words never reach the transcript.
    const unread = "a spell the app couldn't read from Ashwing's table";
    expect(lineageSpellLabel('You learn the faerie fire spell', 'Ashwing')).toBe(unread);
    expect(lineageSpellLabel('Faerie Fire (level 3), Darkness (level 5)', 'Ashwing')).toBe(unread);
    expect(lineageSpellLabel('Faerie Fire; see below', 'Ashwing')).toBe(unread);
    expect(lineageSpellLabel('__', 'Ashwing')).toBe(unread);
  });
});
