import { describe, expect, it } from 'vitest';
import type { Character } from '@/types';
import { sampleCharacter } from '@/test/fixtures';
import { applyDamage } from './character';
import { characterSheetText, characterStatusLine } from './summary';

const mira = (overrides: Partial<Character> = {}) => sampleCharacter(overrides);

describe('characterStatusLine', () => {
  it('summarizes the sample character on one line', () => {
    expect(characterStatusLine(mira())).toBe(
      'Mira Voss (Wizard 3) · HP 12/17 · AC 12 · Slots 1st 3/4, 2nd 2/2 · Hit Dice 2/3 d6 · Heroic Inspiration',
    );
  });

  it('shows temp HP, conditions, exhaustion, speed changes and concentration', () => {
    const c = mira({
      hp: { max: 17, current: 12, temp: 5 },
      conditions: [{ id: 'poisoned' }, { id: 'Hexed' }],
      exhaustion: 1,
      heroicInspiration: false,
      spellcasting: { ...mira().spellcasting!, concentratingOn: 'Detect Magic' },
    });
    expect(characterStatusLine(c)).toBe(
      'Mira Voss (Wizard 3) · HP 12/17 (+5 temp) · AC 12 · Speed 25 ft · Slots 1st 3/4, 2nd 2/2 · Hit Dice 2/3 d6 · Conditions: Poisoned, Hexed · Exhaustion 1 · Concentrating: Detect Magic',
    );
  });

  it('flags dying, stable and dead characters', () => {
    const down = applyDamage(mira(), 12).character;
    expect(characterStatusLine(down)).toContain('HP 0/17 · Dying (death saves: 0 successes, 0 failures)');
    expect(characterStatusLine({ ...down, deathSaves: { successes: 0, failures: 0, stable: true, dead: false } })).toContain('Stable at 0 HP');
    expect(characterStatusLine({ ...down, deathSaves: { successes: 0, failures: 3, stable: false, dead: true } })).toContain('DEAD');
  });

  it('shows Pact Magic and multiclass levels', () => {
    const c = mira({
      classes: [...mira().classes, { classId: 'srd:class:warlock', name: 'Warlock', level: 2, hitDie: 8, casterType: 'pact', spellcastingAbility: 'cha' }],
      spellcasting: { ...mira().spellcasting!, pact: { slotLevel: 1, slots: { max: 2, used: 1 } } },
    });
    expect(characterStatusLine(c)).toContain('(Wizard 3 / Warlock 2)');
    expect(characterStatusLine(c)).toContain('Pact 1/2 (1st)');
  });
});

describe('characterSheetText', () => {
  const sheet = characterSheetText(mira());

  it('is a markdown sheet with the numbers a DM needs', () => {
    expect(sheet.startsWith('## Mira Voss — Wizard 3 (Evoker)\n')).toBe(true);
    expect(sheet).toContain('900 XP (1,800 to level 4)');
    expect(sheet).toContain('**AC** 12 (10 + DEX)');
    expect(sheet).toContain('**Passive Perception** 13');
    expect(sheet).toContain('INT +5 (prof)');
    expect(sheet).toContain('Arcana +5 (prof)');
    expect(sheet).toContain('Stealth +2');
    expect(sheet).toContain('- **Dagger** +4 to hit, 1d4+2 piercing');
    expect(sheet).toContain('- **Fire Bolt** +5 to hit, 1d10 fire');
    expect(sheet).toContain('INT: save DC 13, spell attack +5');
    expect(sheet).toContain('- Cantrips: Fire Bolt, Light, Mage Hand, Prestidigitation (High Elf)');
    expect(sheet).toContain('Sleep (C, not prepared)');
    expect(sheet).toContain('**Magic Initiate (Wizard)** (Sage (Origin feat); 0/1 per long rest)');
    expect(sheet).toContain('Potion of Healing ×2 (magic)');
    expect(sheet).toContain('**Coins:** 23 gp, 30 sp, 14 cp (26.14 gp total)');
    expect(sheet).toContain('- Bonds: My missing mentor kept the lighthouse.');
  });

  it('is deterministic and compact', () => {
    expect(characterSheetText(mira())).toBe(sheet);
    expect(sheet).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    const approxTokens = sheet.length / 4;
    expect(approxTokens).toBeGreaterThan(300);
    expect(approxTokens).toBeLessThan(900);
  });

  it('shows scaled cantrip dice, Eldritch Blast beams and a Champion’s critical range', () => {
    const blast = { id: 'eb', name: 'Eldritch Blast', ability: 'spell' as const, proficient: true, damage: '1d10', damageType: 'force', addAbilityToDamage: false, notes: 'Cantrip' };
    const wizard5 = mira({ classes: [{ ...mira().classes[0], level: 5 }], attacks: [...mira().attacks, blast] });
    const text = characterSheetText(wizard5);
    expect(text).toContain('- **Fire Bolt** +6 to hit, 2d10 fire · 120 ft.');
    expect(text).toContain('- **Eldritch Blast** +6 to hit, 1d10 force · Cantrip · 2 beams at this level (one attack roll each)');
    expect(text).not.toContain('Critical Hit on');
    const champion = mira({ classes: [{ classId: 'srd:class:fighter', name: 'Fighter', level: 3, hitDie: 10, casterType: 'none', subclass: 'Champion' }] });
    const fighterSheet = characterSheetText(champion);
    expect(fighterSheet).toMatch(/- \*\*Dagger\*\* .* · Critical Hit on 19–20/);
    expect(fighterSheet).not.toMatch(/Fire Bolt.*Critical Hit/);
  });

  it('truncates long text and handles a bare character', () => {
    const verbose = characterSheetText(mira({ personality: { backstory: 'word '.repeat(400) } }));
    expect(verbose).toMatch(/Backstory: (word ){50,}.*…/);
    const bare = characterSheetText(mira({ spellcasting: undefined, attacks: [], features: [], inventory: [], personality: {} }));
    expect(bare).not.toContain('### Spellcasting');
    expect(bare).not.toContain('### Attacks');
    expect(bare).toContain('### Equipment\nnothing');
  });
});
