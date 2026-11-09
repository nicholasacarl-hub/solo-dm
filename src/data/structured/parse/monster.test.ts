import { describe, expect, it } from 'vitest';
import { SCRIPTED_WIRE, gloamwoodEntries } from '@/test/structuredFixtures';
import type { CompendiumEntry } from '@/types';
import { segment, type Candidate } from '../segment';
import { parseMonster } from './monster';

const CTX = { knownSpellNames: new Set<string>(), knownClassNames: new Set<string>() };
const fixture = (name: string, dialect: 'md' | 'mixed' = 'md') =>
  segment(gloamwoodEntries('gloam', dialect), CTX).candidates.find((c) => c.name === name) as Candidate & { kind: 'monster' };
const scripted = (name: string) => SCRIPTED_WIRE[name].wire;

const entry = (text: string, name = 'Ash Wolf'): CompendiumEntry => ({ id: 'lib:t:1', sourceId: 't', sourceName: 'T', kind: 'monster', name, text, path: ['Bestiary', name] });
const parseText = (text: string, name?: string) => parseMonster(segment([entry(text, name)], CTX).candidates[0] as Candidate & { kind: 'monster' });

describe('parseMonster', () => {
  it('reads the 2024 Markdown stat block as Claude would (the book prints HP 52)', () => {
    const { wire, missing } = parseMonster(fixture('Glimmerwing Drake'));
    expect(wire).toEqual({ ...scripted('Glimmerwing Drake'), hpText: '52 (8d10 + 8)' });
    expect(missing).toEqual([]);
  });

  it('reads the 2014 stat block: Armor Class, Challenge with XP, the STR | DEX table, Weapon Attack reach', () => {
    const { wire, missing } = parseMonster(fixture('Bramble Hound'));
    expect(wire).toEqual(scripted('Bramble Hound'));
    expect(missing).toEqual([]);
  });

  it('lists exactly the key fields it could not read (the Goblin Warrior prints no ability scores)', () => {
    const { wire, missing } = parseMonster(fixture('Goblin Warrior'));
    expect(wire).toEqual({ ...scripted('Goblin Warrior'), notes: '' });
    expect(missing).toEqual(['abilityScores']);
  });

  it("doesn't guess the columns of a flattened table whose header row is gone (the drake goes to Claude)", () => {
    const { wire, missing } = parseMonster(fixture('Glimmerwing Drake', 'mixed'));
    expect(missing).toEqual(['abilityScores']);
    expect(wire).toMatchObject({ sizeText: 'Large', typeText: 'Dragon', acText: '17 (natural armor)', initiativeText: '+2 (12)', crText: '3 (XP 700; PB +2)', reachText: 'reach 10 ft.' });
  });

  it('reads a PDF text layer: labels mid-line and the "Str 16 +3 +3" grid', () => {
    const text = [
      'Medium or Small Humanoid (Wizard), Neutral',
      'AC 12 Initiative +2 (12)',
      'HP 9 (2d8)',
      'Speed 30 ft., Climb 20 ft.',
      'Str 9 −1 −1 Dex 14 +2 +2 Con 11 +0 +0',
      'Int 17 +3 +5 Wis 12 +1 +3 Cha 11 +0 +0',
      'Senses Passive Perception 11',
      'Languages Common',
      'CR 1/4 (XP 50; PB +2)',
      'Actions',
      'Staff. Melee Attack Roll: +4, reach 5 ft. Hit: 4 (1d6 + 1) Bludgeoning damage.',
    ].join('\n\n');
    const { wire, missing } = parseText(text);
    expect(missing).toEqual([]);
    expect(wire).toMatchObject({
      format: '2024', sizeText: 'Medium or Small', typeText: 'Humanoid (Wizard)', alignmentText: 'Neutral', acText: '12', initiativeText: '+2 (12)',
      hpText: '9 (2d8)', speedText: '30 ft., Climb 20 ft.', crText: '1/4 (XP 50; PB +2)', reachText: 'reach 5 ft.',
      abilityScores: { str: 9, dex: 14, con: 11, int: 17, wis: 12, cha: 11 },
    });
  });

  it('reads older damage and condition immunities together, the longest reach and legendary actions', () => {
    const text = [
      '*Huge dragon, chaotic evil*',
      '**Armor Class** 19 (natural armor)',
      '**Hit Points** 200 (16d12 + 96)',
      '**Speed** 40 ft., fly 80 ft.',
      '| STR | DEX | CON | INT | WIS | CHA |\n|---|---|---|---|---|---|\n| 25 (+7) | 10 (+0) | 23 (+6) | 16 (+3) | 13 (+1) | 21 (+5) |',
      '**Damage Immunities** fire',
      '**Condition Immunities** frightened',
      '**Challenge** 17 (18,000 XP)',
      '***Bite.*** *Melee Weapon Attack:* +14 to hit, reach 10 ft., one target.',
      '***Tail.*** *Melee Weapon Attack:* +14 to hit, reach 15 ft., one target.',
      '### Legendary Actions',
      'The dragon can take 3 legendary actions.',
    ].join('\n\n');
    const { wire } = parseText(text, 'Cinder Wyrm');
    expect(wire).toMatchObject({ format: '2014', immunitiesText: 'fire; frightened', reachText: 'reach 15 ft.', legendary: true, crText: '17 (18,000 XP)' });
    expect(wire.abilityScores).toEqual({ str: 25, dex: 10, con: 23, int: 16, wis: 13, cha: 21 });
  });

  it('returns sentinels for text that is no stat block', () => {
    const { wire, missing } = parseText('Just a story about wolves.');
    expect(missing).toEqual(['sizeText', 'typeText', 'acText', 'hpText', 'speedText', 'crText', 'abilityScores']);
    expect(wire.abilityScores).toEqual({ str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 });
  });
});
