import { describe, expect, it } from 'vitest';
import { SCRIPTED_WIRE, gloamwoodEntries } from '@/test/structuredFixtures';
import type { CompendiumEntry } from '@/types';
import { normalize } from '../normalize';
import { segment, type Candidate } from '../segment';
import { parseSpell } from './spell';

const CTX = { knownSpellNames: new Set<string>(), knownClassNames: new Set<string>() };
const fixture = (name: string, dialect: 'md' | 'mixed' = 'md') =>
  segment(gloamwoodEntries('gloam', dialect), CTX).candidates.find((c) => c.name === name) as Candidate & { kind: 'spell' };
const entryOf = (text: string, name: string) => ({ id: 'lib:t:1', sourceId: 't', sourceName: 'T', kind: 'spell', name, text, path: ['Spells', name] }) as CompendiumEntry;
const candidateOf = (text: string, name: string) => segment([entryOf(text, name)], CTX).candidates[0] as Candidate & { kind: 'spell' };
const parseText = (text: string, name = 'Ember Lash') => parseSpell(candidateOf(text, name));
const stats = (levelLine: string, more: string[]) =>
  [levelLine, '**Casting Time:** Action', '**Range:** 60 feet', '**Components:** V, S', '**Duration:** Concentration, up to 1 hour', ...more].join('\n\n');

describe('parseSpell', () => {
  it.each(['Ashen Choir', 'Cinder Mote'])('reads %s as Claude would, in Markdown', (name) => {
    expect(parseSpell(fixture(name))).toEqual({ wire: SCRIPTED_WIRE[name].wire, missing: [] });
  });

  it('reads the same from a flattened PDF text layer', () => {
    const flat = segment(gloamwoodEntries('gloam', 'md').map((e) => (e.name === 'Ashen Choir' ? { ...e, text: e.text.replace(/[*_]/g, '').replace(/^- /gm, '') } : e)), CTX)
      .candidates.find((c) => c.name === 'Ashen Choir') as Candidate & { kind: 'spell' };
    expect(parseSpell(flat).wire).toEqual(SCRIPTED_WIRE['Ashen Choir'].wire);
  });

  it('reads the older layout: "3rd-level evocation (ritual)", classes absent, damage scaling by character level', () => {
    const ritual = parseText('*3rd-level divination (ritual)*\n\n**Casting Time:** 10 minutes\n\n**Range:** Self\n\n**Components:** V, S\n\n**Duration:** Concentration, up to 1 hour\n\nYou listen to the wind.');
    expect(ritual.wire).toMatchObject({ format: '2014', level: 3, school: 'divination', classesText: '', ritual: true, concentration: true, durationText: 'Concentration, up to 1 hour' });
    const cantrip = parseText(
      '*Evocation cantrip*\n\n**Casting Time:** 1 action\n\n**Range:** 120 feet\n\n**Components:** V, S\n\n**Duration:** Instantaneous\n\nMake a ranged spell attack. On a hit, it takes 1d10 fire damage. This damage increases by 1d10 when you reach 5th level (2d10), 11th level (3d10), and 17th level (4d10).',
    );
    expect(cantrip.wire).toMatchObject({ format: '2014', level: 0, attack: 'ranged', damageText: '1d10 fire damage', cantripScalingText: '5th level (2d10), 11th level (3d10), and 17th level (4d10)' });
  });

  it('reads "or Ritual", a save, an area and another damage phrasing', () => {
    const { wire } = parseText(
      '_Level 1 Conjuration (Wizard)_\n\n- **Casting Time:** Action or Ritual\n- **Range:** 60 feet\n- **Components:** V\n- **Duration:** 1 minute\n\nEach creature in a 20-foot-radius Sphere makes a Wisdom saving throw. A target takes Force damage equal to 2d6.',
    );
    expect(wire).toMatchObject({ ritual: true, areaText: '20-foot-radius Sphere', saveAbility: 'wis', damageText: 'Force damage equal to 2d6' });
  });

  // SRD 5.2.1 "Spells": a summoning spell (Summon Dragon, Giant Insect, Find Steed) prints its creature's stat block.
  it("reads nothing from a summoned creature's stat block printed inside the spell", () => {
    const text = stats('_Level 3 Conjuration (Wizard)_', [
      'You call forth a lantern spirit. It uses the Lantern Spirit stat block.',
      '### Lantern Spirit',
      'Small Fey, Neutral',
      '**AC** 12 + the spell’s level',
      '**HP** 20 + 5 for each spell level above 3',
      '**Speed** 30 ft.',
      'Actions',
      '**_Flare._** _Dexterity Saving Throw:_ DC equals your spell save DC, each creature in a 15-foot Cone. _Failure:_ 2d6 Fire damage.',
    ]);
    const candidate = candidateOf(text, 'Lantern Call');
    const { wire } = parseSpell(candidate);
    expect(wire).toMatchObject({ saveAbility: 'none', attack: 'none', damageText: '', areaText: '' });
    const { data } = normalize('spell', wire, { blocks: candidate.blocks, entriesById: new Map([['lib:t:1', entryOf(text, 'Lantern Call')]]), origin: 'parser', spellLists: [] });
    expect(data).not.toHaveProperty('area');
    expect(data).not.toHaveProperty('saveAbility');
  });

  it('reads the older stat block too (Armor Class and Hit Points lines), and the spell’s own save before it', () => {
    const { wire } = parseText(
      stats('*3rd-level conjuration*', [
        'You call forth a thistle spirit. A creature within 10 feet of it makes a Wisdom saving throw or is Frightened.',
        'Thistle Spirit\nSmall fey\nArmor Class 11 + the level of the spell (natural armor)\nHit Points 30 + 10 for each spell level above 3rd\nSpeed 30 ft.',
        "Barb. Melee Spell Attack: your spell attack modifier to hit, reach 5 ft. Hit: 1d6 + 3 + the spell's level piercing damage.",
      ]),
      'Thistle Call',
    );
    expect(wire).toMatchObject({ saveAbility: 'wis', attack: 'none', damageText: '' });
  });

  it('reads on past an AC line no HP line follows (a wall section a PDF line break starts a line with)', () => {
    const { wire } = parseText(
      stats('_Level 6 Evocation (Wizard)_', [
        'You raise a wall of frost. Each section has\nAC 12 and 30 Hit Points.\nA creature moving through a broken section makes a Constitution saving throw, taking 5d6 Cold damage on a failed save.',
      ]),
      'Frost Rampart',
    );
    expect(wire).toMatchObject({ saveAbility: 'con', damageText: '5d6 Cold damage' });
  });

  it('lists the key fields it could not read', () => {
    expect(parseText('A spell with no stat lines.').missing).toEqual(['levelText', 'castingTimeText', 'rangeText', 'durationText']);
  });
});
