import './testing/setup';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { sampleCombat } from '@/test/fixtures';
import { CombatTracker } from './CombatTracker';
import { seedGame } from './testing/seed';

/** Top-level initiative rows (condition chips are a nested list). */
function initiativeRows(): HTMLElement[] {
  const list = screen.getByRole('list', { name: 'Initiative order' });
  return within(list)
    .getAllByRole('listitem')
    .filter((item) => item.parentElement === list);
}

vi.mock('@/engine', () => import('./testing/engineMock'));

describe('CombatTracker', () => {
  it('lists the initiative order with the current turn marked', () => {
    seedGame();
    render(<CombatTracker />);
    expect(screen.getByRole('heading', { name: 'Ambush on the docks' })).toBeInTheDocument();
    expect(screen.getByText('Round 2')).toBeInTheDocument();

    const rows = initiativeRows();
    expect(rows.map((r) => within(r).getByText(/^(Mira Voss|Bandit 1|Bandit 2|Old Tam)$/).textContent)).toEqual([
      'Mira Voss',
      'Bandit 1',
      'Bandit 2',
      'Old Tam',
    ]);
    expect(rows[1]).toHaveAttribute('aria-current', 'true');
    expect(screen.queryByText('Your turn')).not.toBeInTheDocument();
  });

  it('emphasises the player turn', () => {
    seedGame({ combat: { ...sampleCombat(), turnIndex: 0 } });
    render(<CombatTracker />);
    expect(screen.getByRole('status')).toHaveTextContent('Your turn');
  });

  it('shows a health descriptor instead of hidden HP, real HP otherwise', () => {
    seedGame();
    render(<CombatTracker />);
    const rows = initiativeRows();
    expect(rows[1]).toHaveTextContent('Bloodied');
    expect(rows[1]).not.toHaveTextContent('4/11');
    expect(rows[2]).toHaveTextContent('Unhurt');
    expect(rows[3]).toHaveTextContent('9/9');
    // The player's HP comes from the character sheet.
    expect(rows[0]).toHaveTextContent('12/17');
  });

  it('shows AC, condition chips and defeated combatants', () => {
    const combat = sampleCombat();
    combat.combatants[3] = { ...combat.combatants[3], defeated: true };
    seedGame({ combat });
    render(<CombatTracker />);
    const rows = initiativeRows();
    expect(within(rows[2]).getByRole('list', { name: 'Conditions' })).toHaveTextContent('Prone');
    expect(within(rows[2]).getByText('Prone')).toHaveAttribute('title', 'You are on the ground.');
    expect(rows[0]).toHaveTextContent('Armor Class 12');
    expect(rows[3]).toHaveTextContent('Defeated');
  });

  it("hides the AC of creatures whose numbers the DM keeps hidden (a disguised foe's stat block)", () => {
    seedGame();
    render(<CombatTracker />);
    const rows = initiativeRows();
    // Bandits 1 and 2 hide their HP, so their AC stays hidden too; the hero's and Old Tam's show.
    expect(rows[1]).not.toHaveTextContent('Armor Class');
    expect(rows[2]).not.toHaveTextContent('Armor Class');
    expect(rows[0]).toHaveTextContent('Armor Class 12');
    expect(rows[3]).toHaveTextContent('Armor Class 11');
  });

  it('renders nothing outside combat', () => {
    seedGame({ combat: null });
    const { container } = render(<CombatTracker />);
    expect(container).toBeEmptyDOMElement();
  });
});
