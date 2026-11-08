import './testing/setup';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { sampleCombat, sampleMappedCombat } from '@/test/fixtures';
import type { CombatState } from '@/types';
import { CombatTracker } from './CombatTracker';
import { usePlayView } from './playView';
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

describe('CombatTracker on a battle map', () => {
  /** The warehouse fight without the hidden Cutthroat. */
  const visibleOnly = (state: CombatState = sampleMappedCombat()): CombatState => ({
    ...state,
    turnIndex: state.turnIndex > 2 ? state.turnIndex - 1 : state.turnIndex,
    combatants: state.combatants.filter((c) => !c.hidden),
  });
  const rowOf = (name: string) => initiativeRows().find((r) => within(r).queryByText(name)) as HTMLElement;

  it("shows each creature's square and distance from the hero (SRD 5.2.1 Playing on a Grid, Ranges)", () => {
    seedGame({ combat: visibleOnly() });
    render(<CombatTracker />);
    expect(within(rowOf('Mira Voss')).getByTitle('Square and distance from you')).toHaveTextContent('B6');
    expect(rowOf('Mira Voss')).not.toHaveTextContent('ft');
    expect(rowOf('Bandit 1')).toHaveTextContent('F4 · 20 ft');
    expect(rowOf('Bandit 2')).toHaveTextContent('F3 · 20 ft');
    expect(rowOf('Old Tam')).toHaveTextContent('B5 · 5 ft');
    expect(rowOf('Dock Ogre')).toHaveTextContent('H10:I11 · 30 ft');
  });

  it('has no squares, distances or map buttons without a map', () => {
    seedGame();
    render(<CombatTracker />);
    expect(screen.queryByTitle('Square and distance from you')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /on the map/ })).not.toBeInTheDocument();
  });

  it('marks allies with a blue dot, not green (colour-blind safe, like the map tokens)', () => {
    seedGame({ combat: visibleOnly() });
    const { container } = render(<CombatTracker />);
    expect(rowOf('Old Tam').querySelector('.bg-info')).not.toBeNull();
    expect(container.querySelector('.bg-success.rounded-full.size-2')).toBeNull();
  });

  it('"Show on map" highlights the token, puts the map cursor on it and brings the map up', async () => {
    const user = userEvent.setup();
    seedGame({ combat: visibleOnly() });
    usePlayView.setState({ mapDock: 'collapsed', mobileTab: 'story' });
    render(<CombatTracker />);
    await user.click(screen.getByRole('button', { name: 'Show Dock Ogre on the map' }));
    expect(usePlayView.getState()).toMatchObject({
      highlightedId: 'c-6',
      cursor: { x: 7, y: 9 },
      mapDock: 'normal',
      mobileTab: 'combat',
    });
  });

  it('hovering a row highlights its token, and a token highlighted on the map highlights its row', async () => {
    const user = userEvent.setup();
    seedGame({ combat: visibleOnly() });
    render(<CombatTracker />);
    await user.hover(rowOf('Bandit 2'));
    expect(usePlayView.getState().highlightedId).toBe('c-3');
    await user.unhover(rowOf('Bandit 2'));
    expect(usePlayView.getState().highlightedId).toBeNull();

    act(() => usePlayView.getState().setHighlighted('c-4'));
    expect(rowOf('Old Tam')).toHaveClass('outline-2');
    expect(rowOf('Bandit 2')).not.toHaveClass('outline-2');
  });

  it("focusing a row's button highlights it too", async () => {
    const user = userEvent.setup();
    seedGame({ combat: visibleOnly() });
    render(<CombatTracker />);
    await user.tab();
    expect(usePlayView.getState().highlightedId).toBe('c-1');
    await user.tab();
    expect(usePlayView.getState().highlightedId).toBe('c-2');
  });
});

describe('CombatTracker with a hidden creature (D41, D42; no leaks unless "Show DM secrets")', () => {
  /** The warehouse fight on the Cutthroat's (hidden) turn, or another turn. */
  const fight = (turnIndex = 2): CombatState => ({ ...sampleMappedCombat(), turnIndex });

  /** Every place a name could leak: text, accessible names, titles and the status text. */
  function expectNoCutthroat(container: HTMLElement) {
    expect(container.textContent).not.toMatch(/Cutthroat/);
    for (const el of container.querySelectorAll('*')) {
      for (const attr of ['aria-label', 'title', 'aria-description']) expect(el.getAttribute(attr) ?? '').not.toMatch(/Cutthroat/);
    }
    for (const status of screen.queryAllByRole('status')) expect(status.textContent).not.toMatch(/Cutthroat/);
  }

  it('leaves the hidden creature out entirely', () => {
    seedGame({ combat: fight(1) });
    const { container } = render(<CombatTracker />);
    expect(initiativeRows()).toHaveLength(5);
    expectNoCutthroat(container);
    expect(screen.queryByText('Unseen')).not.toBeInTheDocument();
  });

  it("keeps the current-turn marker on the last creature the player saw act during the hidden creature's turn", () => {
    seedGame({ combat: fight(2) });
    const { container } = render(<CombatTracker />);
    const current = initiativeRows().filter((r) => r.getAttribute('aria-current') === 'true');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('Bandit 1');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expectNoCutthroat(container);
  });

  it('keeps saying "Your turn" when the hidden creature acts right after the hero (the status never changes)', () => {
    const state = sampleMappedCombat({ heroTurn: true });
    const [mira, bandit1, cutthroat, ...rest] = state.combatants;
    seedGame({ combat: { ...state, combatants: [mira, cutthroat, bandit1, ...rest], turnIndex: 1 } });
    const { container } = render(<CombatTracker />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Your turn');
    expect(initiativeRows()[0]).toHaveAttribute('aria-current', 'true');
    expectNoCutthroat(container);
  });

  it('shows the hidden creature dimmed and marked "Unseen" with "Show DM secrets", without moving the marker', () => {
    seedGame({ combat: fight(2) });
    usePlayView.setState({ showSpoilers: true });
    render(<CombatTracker />);
    const rows = initiativeRows();
    expect(rows).toHaveLength(6);
    const cutthroat = rows[2];
    expect(cutthroat).toHaveTextContent('Cutthroat');
    expect(cutthroat).toHaveTextContent('Unseen');
    expect(cutthroat).toHaveTextContent('M8 · 55 ft');
    expect(cutthroat).toHaveClass('opacity-55');
    expect(cutthroat).not.toHaveAttribute('aria-current');
    expect(rows[1]).toHaveAttribute('aria-current', 'true');
  });
});
