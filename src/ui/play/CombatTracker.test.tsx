import './testing/setup';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useGame } from '@/state/gameStore';
import { sampleCharacter, sampleCombat, sampleMappedCombat } from '@/test/fixtures';
import type { CombatState } from '@/types';
import { CombatTracker } from './CombatTracker';
import { BattleBar } from './map';
import { usePlayView } from './playView';
import { seedGame } from './testing/seed';
import { useIsTouch } from './useMediaQuery';

/** Top-level initiative rows (condition chips are a nested list). */
function initiativeRows(): HTMLElement[] {
  const list = screen.getByRole('list', { name: 'Initiative order' });
  return within(list)
    .getAllByRole('listitem')
    .filter((item) => item.parentElement === list);
}

vi.mock('@/engine', () => import('./testing/engineMock'));
vi.mock('@/dm', () => import('./testing/dmMock'));
vi.mock('@/data', () => ({ useRulesIndex: () => null }));
// Every tracker row asks useIsTouch once per render: counting its calls counts row renders (K3).
vi.mock('./useMediaQuery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useMediaQuery')>();
  return { ...actual, useIsTouch: vi.fn(actual.useIsTouch) };
});

// jsdom has no scrollIntoView: the U5 tests stub it.
const realScrollIntoView = Element.prototype.scrollIntoView;
afterEach(() => {
  vi.restoreAllMocks();
  Element.prototype.scrollIntoView = realScrollIntoView;
});

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

  it("keeps a creature's condition duration and source (the DM's words) off the player's tracker", () => {
    const combat = sampleCombat();
    const fear = { id: 'prone', duration: '1 minute', source: 'the wraith hiding in the rafters' };
    combat.combatants = combat.combatants.map((c) => (c.name === 'Bandit 1' ? { ...c, conditions: [fear] } : c));
    seedGame({ combat });
    render(<CombatTracker />);
    const bandit = initiativeRows().find((r) => r.textContent?.includes('Bandit 1'))!;
    // The rules summary stays; the DM's words don't, in the chip's title or anywhere on the row.
    expect(within(bandit).getByText('Prone')).toHaveAttribute('title', 'You are on the ground.');
    expect(bandit).not.toHaveTextContent(/wraith|1 minute/);
    const titles = [bandit, ...bandit.querySelectorAll('[title]')].map((el) => el.getAttribute('title') ?? '');
    expect(titles.join(' ')).not.toMatch(/wraith|1 minute/);
  });

  it("shows the hero's AC from the sheet, which can change mid-fight (srd:spell:shield-of-faith), not the copy from the fight's start", () => {
    // The fixture fight's copy of the hero says AC 12; Shield of Faith has made the sheet's 14.
    seedGame({ character: sampleCharacter({ armorClass: 14 }) });
    render(<CombatTracker />);
    expect(initiativeRows()[0]).toHaveTextContent('Armor Class 14');
    // A shield donned mid-fight shows at once, as the row's HP already does.
    act(() => useGame.setState((s) => ({ character: s.character && { ...s.character, armorClass: 16 } })));
    expect(initiativeRows()[0]).toHaveTextContent('Armor Class 16');
    expect(initiativeRows()[0]).not.toHaveTextContent('Armor Class 12');
  });

  it("shows no AC for the hero without a sheet rather than the fight's old copy", () => {
    seedGame({ character: null });
    render(<CombatTracker />);
    expect(initiativeRows()[0]).not.toHaveTextContent('Armor Class');
    expect(initiativeRows()[3]).toHaveTextContent('Armor Class 11');
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

  it('K3: a highlight change re-renders only the rows it touches, not every row', () => {
    seedGame({ combat: visibleOnly() });
    render(<CombatTracker />);
    const rowRenders = vi.mocked(useIsTouch);
    rowRenders.mockClear();
    act(() => usePlayView.getState().setHighlighted('c-3'));
    expect(rowOf('Bandit 2')).toHaveClass('outline-2');
    expect(rowRenders).toHaveBeenCalledTimes(1);
    rowRenders.mockClear();
    act(() => usePlayView.getState().setHighlighted('c-4'));
    expect(rowOf('Old Tam')).toHaveClass('outline-2');
    expect(rowOf('Bandit 2')).not.toHaveClass('outline-2');
    expect(rowRenders).toHaveBeenCalledTimes(2);
  });

  it('U5: on a phone, "Show on map" scrolls the map back into view and keeps the creature marked after the row is left', async () => {
    const user = userEvent.setup();
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = vi.fn(function scrollIntoView(this: Element) {
      scrolled.push(this);
    });
    seedGame({ combat: visibleOnly() });
    // The Combat tab's layout: the map panel above the tracker in one scrolling panel.
    render(
      <section id="play-panel-combat">
        <div data-map-part="panel">the map</div>
        <CombatTracker />
      </section>,
    );
    await user.click(screen.getByRole('button', { name: 'Show Bandit 2 on the map' }));
    expect(scrolled).toEqual([document.querySelector('[data-map-part="panel"]')]);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    // Leaving the row (pointer or focus) doesn't unmark the creature the player asked to see…
    await user.unhover(rowOf('Bandit 2'));
    fireEvent.blur(screen.getByRole('button', { name: 'Show Bandit 2 on the map' }));
    expect(usePlayView.getState().highlightedId).toBe('c-3');
    // …another row's hover takes over as usual.
    await user.hover(rowOf('Old Tam'));
    expect(usePlayView.getState().highlightedId).toBe('c-4');
    await user.unhover(rowOf('Old Tam'));
    expect(usePlayView.getState().highlightedId).toBeNull();
  });

  it('U5: on the desktop (no Combat tab panel) nothing scrolls', async () => {
    const user = userEvent.setup();
    Element.prototype.scrollIntoView = vi.fn();
    seedGame({ combat: visibleOnly() });
    render(<CombatTracker />);
    await user.click(screen.getByRole('button', { name: 'Show Bandit 2 on the map' }));
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
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

  it('K1: a hidden creature first in a new round leaves "Round N" on the round the player saw (tracker and collapsed map bar)', () => {
    const state = sampleMappedCombat();
    const cutthroat = state.combatants.find((c) => c.hidden) as CombatState['combatants'][number];
    const others = state.combatants.filter((c) => !c.hidden);
    // Round 2 has just begun with the hidden Cutthroat: the player still sees round 1's last turn (the Dock Ogre's).
    seedGame({ combat: { ...state, round: 2, turnIndex: 0, combatants: [{ ...cutthroat, initiative: 30 }, ...others] } });
    render(<CombatTracker />);
    expect(screen.getByText('Round 1')).toBeInTheDocument();
    expect(screen.queryByText('Round 2')).not.toBeInTheDocument();
    expect(initiativeRows().find((r) => r.getAttribute('aria-current') === 'true')).toHaveTextContent('Dock Ogre');
    render(<BattleBar onExpand={() => {}} />);
    expect(screen.getByText(/· Round 1/)).toBeInTheDocument();
    expect(screen.queryByText(/Round 2/)).not.toBeInTheDocument();
  });

  it('E1: with "Show DM secrets" the hidden creature keeps its name: the side, badge and square wrap instead of squeezing it', () => {
    seedGame({ combat: fight(2) });
    usePlayView.setState({ showSpoilers: true });
    render(<CombatTracker />);
    const name = within(initiativeRows()[2]).getByText('Cutthroat');
    const line = name.parentElement as HTMLElement;
    expect(line).toHaveClass('flex-wrap');
    expect(within(line).getByText('Unseen')).toBeInTheDocument();
    expect(within(line).getByTitle('Square and distance from you')).toHaveTextContent('M8 · 55 ft');
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
