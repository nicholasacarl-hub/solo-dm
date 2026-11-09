import { describe, expect, it } from 'vitest';
import { SCRIPTED_WIRE, gloamwoodEntries } from '@/test/structuredFixtures';
import type { CompendiumEntry } from '@/types';
import { segment, type Candidate } from '../segment';
import { parseMagicItem } from './magicItem';

const CTX = { knownSpellNames: new Set<string>(), knownClassNames: new Set<string>() };
const fixture = (name: string) => segment(gloamwoodEntries(), CTX).candidates.find((c) => c.name === name) as Candidate & { kind: 'magic-item' };
const parseText = (text: string, name = 'Bell of Ash') =>
  parseMagicItem(segment([{ id: 'lib:t:1', sourceId: 't', sourceName: 'T', kind: 'magic-item', name, text, path: ['Magic Items', name] } as CompendiumEntry], CTX).candidates[0] as Candidate & { kind: 'magic-item' });

describe('parseMagicItem', () => {
  it.each(['Lantern of Hollow Light', 'Mothsilk Cloak', "Warden's Mail"])('reads %s as Claude would', (name) => {
    expect(parseMagicItem(fixture(name))).toEqual({ wire: SCRIPTED_WIRE[name].wire, missing: [] });
  });

  it('reads the older type line "requires attunement by a wizard" and its lowercase rarity', () => {
    const { wire } = parseText('*Armor (plate), rare (requires attunement by a wizard)*\n\nYou have a +2 bonus to AC while wearing it.');
    expect(wire).toMatchObject({
      format: '2014', category: 'armor', rarity: 'rare', attunement: 'required-by', attunementText: 'by a wizard', baseItemText: 'plate',
      acBonus: 2, bonusText: '+2 bonus to AC',
    });
  });

  it('reads weapon bonuses, an AC bonus that needs no armor, charges and a varying rarity', () => {
    expect(parseText('_Weapon (Any Sword), Rare_\n\nYou have a +2 bonus to attack rolls and damage rolls made with this magic weapon.').wire).toMatchObject({
      category: 'weapon', baseItemText: 'Any Sword', attackBonus: 2, damageBonus: 2, bonusText: '+2 bonus to attack rolls and damage rolls',
    });
    expect(parseText('_Wondrous Item, Rare (Requires Attunement)_\n\nYou gain a +2 bonus to AC if you are wearing no armor and using no Shield.').wire).toMatchObject({
      acBonus: 2, acCondition: 'no-armor-no-shield',
    });
    expect(parseText('_Wand, Uncommon_\n\nThis wand has 7 charges.').wire).toMatchObject({ category: 'wand', chargesText: 'has 7 charges' });
    expect(parseText('_Wondrous Item, Rarity Varies_\n\nIt hums.').wire).toMatchObject({ rarity: 'varies' });
    expect(parseText('_Armor (Shield), Uncommon_\n\nIt gleams.').wire).toMatchObject({ category: 'shield', baseItemText: 'Shield' });
  });

  it('lists what it could not read', () => {
    expect(parseText('A legend about a bell.').missing).toEqual(['typeLineText', 'category', 'rarity']);
  });
});
