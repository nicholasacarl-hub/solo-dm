import { describe, expect, it } from 'vitest';
import { SCRIPTED_WIRE, gloamwoodEntries } from '@/test/structuredFixtures';
import type { CompendiumEntry } from '@/types';
import { segment, type Candidate } from '../segment';
import { parseItem } from './item';

const CTX = { knownSpellNames: new Set<string>(), knownClassNames: new Set<string>() };
const fixture = (name: string) => segment(gloamwoodEntries(), CTX).candidates.find((c) => c.name === name) as Candidate & { kind: 'item' };
const candidates = (text: string, name = 'Arms') =>
  segment([{ id: 'lib:t:1', sourceId: 't', sourceName: 'T', kind: 'rule', name, text, path: ['Equipment', name] } as CompendiumEntry], CTX).candidates as (Candidate & { kind: 'item' })[];

describe('parseItem', () => {
  it.each(['Gloamwood Arms', 'Wick Lantern'])('reads %s as Claude would', (name) => {
    expect(parseItem(fixture(name))).toEqual({ wire: SCRIPTED_WIRE[name].wire, missing: [] });
  });

  it('reads an armor table with group rows, a shield and Stealth disadvantage', () => {
    const text = [
      '| Armor | Armor Class (AC) | Strength | Stealth | Weight | Cost |',
      '|---|---|---|---|---|---|',
      '| *Light Armor* | | | | | |',
      '| Ashweave | 11 + Dex modifier | — | — | 8 lb. | 10 GP |',
      '| *Medium Armor* | | | | | |',
      '| Bark Mail | 14 + Dex modifier (max 2) | — | Disadvantage | 40 lb. | 45 GP |',
      '| *Heavy Armor* | | | | | |',
      '| Root Plate | 17 | Str 15 | Disadvantage | 60 lb. | 400 GP |',
      '| *Shield* | | | | | |',
      '| Bramble Shield | +2 | — | — | 6 lb. | 10 GP |',
    ].join('\n');
    const [table] = candidates(text);
    const { wire, missing } = parseItem(table);
    expect(missing).toEqual([]);
    expect(wire.items.map((i) => [i.name, i.category, i.armorType, i.acText, i.strengthText, i.stealthDisadvantage])).toEqual([
      ['Ashweave', 'armor', 'light', '11 + Dex modifier', '', false],
      ['Bark Mail', 'armor', 'medium', '14 + Dex modifier (max 2)', '', true],
      ['Root Plate', 'armor', 'heavy', '17', 'Str 15', true],
      ['Bramble Shield', 'shield', 'none', '+2', '', false],
    ]);
  });

  it('reads only the rows of its part of a long table', () => {
    const rows = Array.from({ length: 70 }, (_, i) => `| Blade ${i + 1} | 1d6 Slashing | Light | Nick | 2 lb. | 5 GP |`);
    const text = ['| Simple Melee Weapons | Damage | Properties | Mastery | Weight | Cost |', '|---|---|---|---|---|---|', ...rows].join('\n');
    const [first, second] = candidates(text);
    expect(parseItem(first).wire.items).toHaveLength(60);
    expect(parseItem(second).wire.items.map((i) => i.name)).toEqual(Array.from({ length: 10 }, (_, i) => `Blade ${61 + i}`));
    expect(parseItem(second).wire.items[0]).toMatchObject({ weaponCategory: 'simple', weaponType: 'melee', damageText: '1d6 Slashing' });
  });

  it('reads a weapon described on its own, a tool and a pack', () => {
    const weapon = candidates('_Martial Melee Weapon_\n\n- **Damage:** 1d10 Piercing\n- **Properties:** Heavy, Reach\n- **Mastery:** Push\n- **Weight:** 7 lb.\n- **Cost:** 15 GP', 'Briar Pike');
    expect(parseItem(weapon[0]).wire.items[0]).toMatchObject({ name: 'Briar Pike', category: 'weapon', weaponCategory: 'martial', damageText: '1d10 Piercing', masteryText: 'Push' });
    const tool = candidates('- **Ability:** Dexterity\n- **Cost:** 25 GP\n- **Weight:** 1 lb.', "Wickmaker's Tools");
    expect(parseItem(tool[0]).wire.items[0]).toMatchObject({ category: 'tool', costText: '25 GP' });
    const pack = candidates('- **Cost:** 12 GP\n- **Weight:** 30 lb.', "Lamplighter's Pack");
    expect(parseItem(pack[0]).wire.items[0].category).toBe('pack');
  });

  it('marks a weapon without damage as missing', () => {
    const text = '| Martial Melee Weapons | Damage | Properties | Mastery | Weight | Cost |\n|---|---|---|---|---|---|\n| Hook | — | Reach | Topple | 6 lb. | 12 GP |';
    expect(parseItem(candidates(text)[0]).missing).toEqual(['items[0].damageText']);
  });
});
