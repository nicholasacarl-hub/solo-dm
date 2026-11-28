/**
 * The Speed tile and the sheet's other speeds on the real engine (SPEC-v2 §1.3): the class features' bonuses are worked
 * out when the Speed is read (speedDetails), never stored; "base" and the danger border only for what lowers the Speed
 * below that, and the explanation on the tile's title and for a screen reader. A hero without such a feature reads
 * exactly as before.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { sampleCharacter } from '@/test/fixtures';
import type { Character, ClassLevel } from '@/types';
import { autoCleanup } from '@/ui/shell/testUtils';
import { ProficienciesList } from './AbilitiesPanel';
import { VitalsPanel } from './VitalsPanel';

autoCleanup();

const noop = () => undefined;
/** The Speed tile as the sheet renders it. */
function speedTile(c: Character): HTMLElement {
  render(<VitalsPanel character={c} editable={false} onEdit={noop} onRoll={noop} />);
  return screen.getByText('Speed').parentElement!;
}
const unarmored = (cl: ClassLevel, extra: Partial<Character> = {}) => sampleCharacter({ classes: [cl], spellcasting: undefined, inventory: [], ...extra });
const MONK_6: ClassLevel = { classId: 'srd:class:monk', name: 'Monk', level: 6, hitDie: 8, casterType: 'none' };
/** Today's tile for a Speed of 30 (Mira Voss): no title, no explanation. */
const tileHtml = (value: number, sub: string, border = 'border-border') =>
  `<div class="flex min-w-0 flex-col items-center rounded-xl border bg-surface-2 px-1.5 py-1.5 text-center ${border}"><span class="flex items-center gap-1 text-[10px] font-semibold tracking-wider text-muted uppercase"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-footprints size-3" aria-hidden="true"><path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"></path><path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"></path><path d="M16 17h4"></path><path d="M4 13h4"></path></svg>Speed</span><span class="text-lg leading-tight font-semibold tabular-nums">${value}</span><span class="truncate text-[11px] text-faint">${sub}</span></div>`;

describe('the Speed tile (srd:rule:monk-unarmored-movement; the Monk Features table\'s "+15 ft." at Monk 6)', () => {
  it('shows a Monk 6\'s 45 ft, explained on its title and for a screen reader, with no "base" and no danger border', () => {
    // "Your speed increases by 10 feet while you aren't wearing armor or wielding a Shield."
    const tile = speedTile(unarmored(MONK_6));
    expect(tile.textContent).toBe('Speed45ft.Unarmored Movement: +15 ft');
    expect(tile).toHaveAttribute('title', 'Unarmored Movement: +15 ft');
    expect(tile.querySelector('.sr-only')?.textContent).toBe('Unarmored Movement: +15 ft');
    expect(tile.className).toContain('border-border');
  });

  it('shows "35 / base 45" with the danger border at Exhaustion 2: the penalty comes off the raised Speed (srd:condition:exhaustion)', () => {
    // "Your Speed is reduced by a number of feet equal to 5 times your Exhaustion level."
    const tile = speedTile(unarmored(MONK_6, { exhaustion: 2 }));
    expect(tile.textContent).toBe('Speed35base 45Unarmored Movement: +15 ft; Exhaustion 2: −10 ft');
    expect(tile).toHaveAttribute('title', 'Unarmored Movement: +15 ft; Exhaustion 2: −10 ft');
    expect(tile.className).toContain('border-danger/50');
  });

  it('names the bonus a Shield suspends, the Speed and tile otherwise plain', () => {
    const tile = speedTile(unarmored(MONK_6, { inventory: [{ id: 'shield', name: 'Shield', quantity: 1, category: 'shield', equipped: true }] }));
    expect(tile.textContent).toBe('Speed30ft.Unarmored Movement: no +15 ft in armor or with a Shield');
    expect(tile.className).toContain('border-border');
  });

  it('is exactly as before for a hero without such a feature, a penalty included', () => {
    expect(speedTile(sampleCharacter()).outerHTML).toBe(tileHtml(30, 'ft.'));
    cleanup();
    expect(speedTile(sampleCharacter({ exhaustion: 1 })).outerHTML).toBe(tileHtml(25, 'base 30', 'border-danger/50'));
  });
});

describe('the other speeds under "Senses & size"', () => {
  const senses = () => screen.getByText('Senses & size').parentElement!.querySelector('dd')!.textContent;

  it("adds Roving's Climb and Swim Speeds at Ranger 6, equal to the Speed, after the stored ones (srd:rule:ranger-roving)", () => {
    // "You also have a Climb Speed and a Swim Speed equal to your Speed."
    const ranger: ClassLevel = { classId: 'srd:class:ranger', name: 'Ranger', level: 6, hitDie: 10, casterType: 'half', spellcastingAbility: 'wis' };
    render(<ProficienciesList character={unarmored(ranger, { otherSpeeds: { fly: 60 } })} />);
    expect(senses()).toBe('Darkvision 60 ft., Size Medium, fly 60 ft., climb 40 ft., swim 40 ft.');
  });

  it('lists a hero\'s own speeds as stored, in their order', () => {
    render(<ProficienciesList character={sampleCharacter({ otherSpeeds: { swim: 30, fly: 60 } })} />);
    expect(senses()).toBe('Darkvision 60 ft., Size Medium, swim 30 ft., fly 60 ft.');
  });
});
