import { describe, expect, it } from 'vitest';
import { SCRIPTED_WIRE, gloamwoodEntries } from '@/test/structuredFixtures';
import type { CompendiumEntry } from '@/types';
import { segment, type Candidate } from '../segment';
import { parseSpell } from './spell';

const CTX = { knownSpellNames: new Set<string>(), knownClassNames: new Set<string>() };
const fixture = (name: string, dialect: 'md' | 'mixed' = 'md') =>
  segment(gloamwoodEntries('gloam', dialect), CTX).candidates.find((c) => c.name === name) as Candidate & { kind: 'spell' };
const parseText = (text: string, name = 'Ember Lash') =>
  parseSpell(segment([{ id: 'lib:t:1', sourceId: 't', sourceName: 'T', kind: 'spell', name, text, path: ['Spells', name] } as CompendiumEntry], CTX).candidates[0] as Candidate & { kind: 'spell' });

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

  it('lists the key fields it could not read', () => {
    expect(parseText('A spell with no stat lines.').missing).toEqual(['levelText', 'castingTimeText', 'rangeText', 'durationText']);
  });
});
