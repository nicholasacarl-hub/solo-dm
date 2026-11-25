/**
 * The spell picker the builder and the sheet's choices form share: the builder's look as it was, and what the sheet
 * adds (a fieldset legend with the count, level groups for a pool of several levels, why a box is disabled).
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import compendiumRaw from '../../../public/srd/compendium.json?raw';
import type { CompendiumEntry } from '@/types';
import { autoCleanup } from '@/ui/shell/testUtils';
import { SpellChoiceList, type SpellChoiceListProps } from './SpellChoiceList';
import { spellInfo, spellsForClass } from './spells';

autoCleanup();

const SPELLS = (JSON.parse(compendiumRaw) as CompendiumEntry[]).filter((e) => e.kind === 'spell').map(spellInfo);
/** The SRD Wizard list (srd:rule:wizard-spellcasting) at the levels a Wizard 4 has slots for. */
const wizardSpells = spellsForClass(SPELLS, 'Wizard').filter((s) => s.level >= 1 && s.level <= 2);
const wizardCantrips = spellsForClass(SPELLS, 'Wizard', 0);
const idOf = (name: string) => SPELLS.find((s) => s.name === name)!.id;

function Picker(props: Partial<SpellChoiceListProps> & Pick<SpellChoiceListProps, 'options' | 'max'>) {
  const [selected, setSelected] = useState<string[]>(props.selected ?? []);
  return <SpellChoiceList label="Spellbook" onInfo={() => undefined} {...props} selected={selected} onChange={setSelected} />;
}

describe('SpellChoiceList', () => {
  it("keeps the builder's heading with its n/max count, one list named by its label", () => {
    render(<Picker label="Wizard cantrips" options={wizardCantrips} max={3} />);
    expect(screen.getByRole('heading', { name: 'Wizard cantrips' })).toBeInTheDocument();
    expect(screen.getByText('0/3')).toBeInTheDocument();
    expect(screen.queryByRole('group')).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Wizard cantrips' })).getAllByRole('checkbox')).toHaveLength(wizardCantrips.length);
  });

  it('names its count in a fieldset legend for the sheet, and says why a box is disabled once the list is full', async () => {
    const user = userEvent.setup();
    render(<Picker label="Cantrips" options={wizardCantrips} max={1} countInLegend />);
    const group = screen.getByRole('group', { name: 'Cantrips Choose up to 1' });
    await user.click(within(group).getByRole('checkbox', { name: /^Ray of Frost/ }));
    expect(screen.getByRole('group', { name: 'Cantrips Choose up to 1 (1 chosen)' })).toBeInTheDocument();
    const other = within(group).getByRole('checkbox', { name: /^Fire Bolt/ });
    expect(other).toBeDisabled();
    expect(other).toHaveAccessibleDescription('Limit reached: uncheck one to change.');
    // The checked one can still be unchecked, and isn't "limited".
    expect(within(group).getByRole('checkbox', { name: /^Ray of Frost/ })).not.toHaveAccessibleDescription();
    await user.click(within(group).getByRole('checkbox', { name: /^Ray of Frost/ }));
    expect(other).toBeEnabled();
    expect(other).not.toHaveAccessibleDescription();
  });

  it('shows a held name disabled as "already known", without the limit reason', () => {
    render(<Picker label="Cantrips" options={wizardCantrips} max={1} taken={new Set([idOf('Fire Bolt')])} countInLegend />);
    const known = screen.getByRole('checkbox', { name: /^Fire Bolt/ });
    expect(known).toBeDisabled();
    expect(known).toHaveAccessibleName(/already known/);
    expect(known).not.toHaveAccessibleDescription();
  });

  it('groups a long pool of several levels by level, the highest open, and lists matches of every level while filtering', async () => {
    const user = userEvent.setup();
    render(<Picker options={wizardSpells} max={2} byLevel countInLegend />);
    const count = (level: number) => wizardSpells.filter((s) => s.level === level).length;
    const details = document.querySelectorAll('details');
    expect([...details].map((d) => [d.querySelector('summary')?.textContent, d.open])).toEqual([
      [`Level 2 (${count(2)} spells)`, true],
      [`Level 1 (${count(1)} spells)`, false],
    ]);
    // A pick in a closed level shows on its summary.
    await user.click(within(screen.getByRole('list', { name: 'Spellbook: level 1' })).getByRole('checkbox', { name: /^Sleep/ }));
    expect(details[1].querySelector('summary')?.textContent).toBe(`Level 1 (${count(1)} spells, 1 chosen)`);
    // Opening a level by its summary.
    await user.click(details[1].querySelector('summary')!);
    expect(details[1].open).toBe(true);
    // Filtering shows every level's matches, without the groups.
    await user.type(screen.getByLabelText('Filter Spellbook'), 'web');
    expect(screen.getAllByRole('checkbox').map((c) => c.closest('label')?.querySelector('span')?.textContent)).toEqual(['Web']);
    expect(document.querySelectorAll('details')).toHaveLength(0);
  });

  it('shows each spell’s level in a short pool of several levels', () => {
    const short = wizardSpells.filter((s) => ['Sleep', 'Web', 'Shield'].includes(s.name));
    render(<Picker options={short} max={2} byLevel countInLegend />);
    expect(document.querySelectorAll('details')).toHaveLength(0);
    expect(screen.getByRole('checkbox', { name: /^Web/ })).toHaveAccessibleName(/Level 2/);
    expect(screen.getByRole('checkbox', { name: /^Sleep/ })).toHaveAccessibleName(/Level 1/);
  });

  it('disables a spell the caller blocks for now and says why; a checked one stays free, and the full list says its own reason', async () => {
    const user = userEvent.setup();
    const short = wizardSpells.filter((s) => ['Sleep', 'Shield', 'Web', 'Hold Person'].includes(s.name));
    const ONLY_ONE = 'Only 1 may be of level 2 here; the others are for earlier levels.';
    // At most one level 2 spell among the picks (a spellbook place's limit, worked out from the picks).
    function Capped() {
      const [selected, setSelected] = useState<string[]>([]);
      const level2 = selected.filter((id) => short.find((s) => s.id === id)?.level === 2).length;
      return (
        <SpellChoiceList
          label="Spellbook"
          options={short}
          selected={selected}
          max={3}
          onChange={setSelected}
          onInfo={() => undefined}
          blocked={(spell) => (spell.level === 2 && level2 >= 1 ? ONLY_ONE : null)}
          countInLegend
          byLevel
        />
      );
    }
    render(<Capped />);
    const box = (name: string) => screen.getByRole('checkbox', { name: new RegExp(`^${name}`) });
    expect(box('Hold Person')).toBeEnabled();
    await user.click(box('Web'));
    expect(box('Hold Person')).toBeDisabled();
    expect(box('Hold Person')).toHaveAccessibleDescription(ONLY_ONE);
    expect(box('Web')).toBeEnabled();
    expect(box('Web')).not.toHaveAccessibleDescription();
    expect(box('Sleep')).toBeEnabled();
    // Unchecking Web frees the level again: worked out from the picks on every render.
    await user.click(box('Web'));
    expect(box('Hold Person')).toBeEnabled();
    expect(box('Hold Person')).not.toHaveAccessibleDescription();
    // Full: the limit's reason, not the caller's.
    await user.click(box('Web'));
    await user.click(box('Sleep'));
    await user.click(box('Shield'));
    expect(box('Hold Person')).toHaveAccessibleDescription('Limit reached: uncheck one to change.');
  });

  it('gives onInfo the About button that was pressed, so focus can go back to it', async () => {
    const user = userEvent.setup();
    const onInfo = vi.fn();
    render(<SpellChoiceList label="Cantrips" options={wizardCantrips.slice(0, 2)} selected={[]} max={1} onChange={() => undefined} onInfo={onInfo} />);
    const about = screen.getByRole('button', { name: `About ${wizardCantrips[1].name}` });
    await user.click(about);
    expect(onInfo).toHaveBeenCalledWith(wizardCantrips[1], about);
  });

  it('makes rows and the About button 44px tall on touch screens (pointer: coarse)', () => {
    const onInfo = vi.fn();
    render(<SpellChoiceList label="Cantrips" options={wizardCantrips.slice(0, 2)} selected={[]} max={1} onChange={() => undefined} onInfo={onInfo} />);
    const about = screen.getByRole('button', { name: `About ${wizardCantrips[0].name}` });
    expect(about).toHaveClass('pointer-coarse:size-11');
    expect(about.closest('li')).toHaveClass('pointer-coarse:min-h-11');
  });
});
