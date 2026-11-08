import '../testing/setup';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dm } from '@/dm';
import { useGame, type GameStoreState } from '@/state/gameStore';
import { sampleCharacter, sampleMappedCombat, sampleStopCombat } from '@/test/fixtures';
import type { CombatState, TranscriptMessage } from '@/types';
import { toast } from '@/ui/components/toast';
import { usePlayView } from '../playView';
import { resetDmMock } from '../testing/dmMock';
import { seedGame } from '../testing/seed';
import { DESKTOP, setMatchMedia, stubBoundingRect, TOUCH } from '../testing/setup';
import { resetTipForTests, TIP_STORAGE_KEY } from './banners';
import { BattleMapPanel } from './BattleMapPanel';
import { resetShownBudgetForTests } from './model';
import { useMapPlanExpiry } from './placements';

vi.mock('@/dm', () => import('../testing/dmMock'));
vi.mock('@/engine', () => import('../testing/engineMock'));
vi.mock('@/data', () => ({ useRulesIndex: () => null }));

/** Bandit 1 moved next to the hero (C5): leaving B6 provokes it (spec M24). */
function heroTurnWithBanditAdjacent(): CombatState {
  const base = sampleMappedCombat({ heroTurn: true });
  return { ...base, combatants: base.combatants.map((c) => (c.id === 'c-2' ? { ...c, position: { x: 2, y: 4 } } : c)) };
}

/** The Cutthroat (hidden) acting right after the hero: the player's view still shows the hero's turn (D42). */
function hiddenRightAfterHero(): CombatState {
  const base = sampleMappedCombat({ heroTurn: true });
  const [mira, bandit1, cutthroat, ...rest] = base.combatants;
  return { ...base, combatants: [mira, { ...cutthroat, initiative: 16 }, bandit1, ...rest], turnIndex: 1 };
}

function renderPanel(overrides: Partial<GameStoreState> = {}, variant: 'dock' | 'tab' = 'dock') {
  const spies = seedGame({ combat: sampleMappedCombat({ heroTurn: true }), ...overrides });
  const utils = render(<BattleMapPanel variant={variant} />);
  return { spies, user: userEvent.setup(), ...utils };
}

const map = () => screen.getByRole('application', { name: /Battle map: Dockside warehouse, 16 by 12 squares/ });
const bar = () => document.querySelector('[data-map-part="bar"]') as HTMLElement;
/** The map's polite live region (BattleMapPanel's, so the list view has it too). */
const liveRegion = () => document.querySelector('[data-map-part="live"]') as HTMLElement;

async function key(name: string, opts: { shiftKey?: boolean } = {}) {
  await act(async () => {
    fireEvent.keyDown(map(), { key: name, ...opts });
  });
}

/** Put the keyboard cursor on a square (the arrow keys' end result) and press Enter. */
async function enterOn(x: number, y: number) {
  act(() => usePlayView.getState().setCursor({ x, y }));
  await key('Enter');
}

/** Every text, accessible name, title and data attribute in the document. */
function everythingSaid(): string {
  const parts = [document.body.textContent ?? ''];
  for (const el of document.body.querySelectorAll('*')) for (const a of el.attributes) parts.push(a.value);
  return parts.join('\n');
}

beforeEach(() => {
  resetDmMock();
  resetTipForTests();
  resetShownBudgetForTests();
  try {
    window.localStorage.removeItem(TIP_STORAGE_KEY);
  } catch {
    /* jsdom storage */
  }
  setMatchMedia(DESKTOP);
  stubBoundingRect(640, 480);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BattleMapPanel: the map', () => {
  it('is one application with the map name, and its drawing is hidden from assistive tech', () => {
    renderPanel();
    const app = map();
    expect(app).toHaveAttribute('aria-roledescription', 'battle map');
    expect(app).toHaveAttribute('tabindex', '0');
    expect(app.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('Your turn · 30 ft')).toBeInTheDocument();
    // Tokens are drawn on their squares, in initiative order.
    expect([...app.querySelectorAll('[data-token-id]')].map((g) => g.getAttribute('data-square'))).toEqual(expect.arrayContaining(['B6', 'F4', 'F3', 'B5', 'H10']));
  });

  it('leaks nothing about a hidden creature — not during its turn, not in the list, the live region or a card — unless "Show DM secrets" is on', async () => {
    // The Cutthroat's own turn (after Bandit 1): the player still sees Bandit 1's.
    const { user } = renderPanel({ combat: { ...sampleMappedCombat(), turnIndex: 2 } });
    expect(screen.getByText("Bandit 1's turn")).toBeInTheDocument();
    expect(map().querySelector('[data-token-id="c-5"]')).toBeNull();
    // Its square reads as open ground, aloud and in a card.
    act(() => usePlayView.getState().setCursor({ x: 12, y: 7 }));
    await waitFor(() => expect(liveRegion()).toHaveTextContent('M8: open ground.'));
    fireEvent.contextMenu(map().querySelector('svg') as SVGSVGElement, { clientX: 1, clientY: 1 });
    // Every creature the player can cycle to, and the list view.
    for (let i = 0; i < 6; i++) await key('n');
    await user.click(screen.getByRole('button', { name: 'List positions' }));
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(everythingSaid()).not.toMatch(/Cutthroat/);
    expect(everythingSaid()).not.toMatch(/\bc-5\b/);

    // "Show DM secrets": drawn (dimmed, dashed), never used in a computation.
    await user.click(screen.getByRole('button', { name: 'Show the map' }));
    act(() => usePlayView.getState().setShowSpoilers(true));
    const secret = map().querySelector('[data-token-id="c-5"]');
    expect(secret).toHaveAttribute('data-square', 'M8');
    expect(secret).toHaveAttribute('opacity', '0.55');
    expect(screen.getByText("Bandit 1's turn")).toBeInTheDocument();
  });

  it('keeps showing the hero’s turn while a hidden creature acts right after the hero (D42), and never says "It isn’t your turn"', async () => {
    const { user } = renderPanel({ combat: hiddenRightAfterHero(), dm: { phase: 'tool', activity: null, error: null } as GameStoreState['dm'] });
    expect(screen.getByText('Your turn · 30 ft')).toBeInTheDocument();
    // While the DM works it looks exactly like the hero's turn with the DM busy: nothing in the bar.
    expect(bar()).toBeEmptyDOMElement();
    act(() => useGame.setState({ dm: { ...useGame.getState().dm, phase: 'idle' } }));
    expect(screen.getByText('Your turn · 30 ft')).toBeInTheDocument();
    expect(within(bar()).getByText('Waiting for the DM.')).toBeInTheDocument();
    await enterOn(3, 7);
    expect(everythingSaid()).not.toMatch(/isn't your turn|Cutthroat/);
    await user.click(map());
  });
});

describe('BattleMapPanel: why the hero can’t move (spec §7.8)', () => {
  it("on another creature's turn: whose turn it is, and a tap shows the square instead of planning", async () => {
    const { spies } = renderPanel({ combat: sampleMappedCombat() });
    expect(screen.getByText("Bandit 1's turn")).toBeInTheDocument();
    await enterOn(3, 7);
    expect(within(bar()).getByText('D8')).toBeInTheDocument();
    expect(spies.commitHeroMove).not.toHaveBeenCalled();
  });

  it.each([
    ['interaction', { interaction: { kind: 'confirm', id: 'q1', title: 'Open it?', body: 'It hums.' } }, 'Answer the DM first.'],
    ['no-session', { activeSession: null }, 'Start the session first.'],
  ] as const)('%s: says so, and a tap says it again instead of moving', async (_block, over, text) => {
    const { spies } = renderPanel(over as Partial<GameStoreState>);
    expect(within(bar()).getByText(text)).toBeInTheDocument();
    await enterOn(3, 7);
    expect(within(bar()).getAllByText(text)).toHaveLength(1);
    expect(spies.commitHeroMove).not.toHaveBeenCalled();
  });

  it("unplaced: you're not on the map yet", () => {
    const base = sampleMappedCombat({ heroTurn: true });
    renderPanel({ combat: { ...base, combatants: base.combatants.map((c) => (c.isPlayer ? { ...c, position: undefined } : c)) } });
    expect(within(bar()).getByText("You're not on the map yet.")).toBeInTheDocument();
  });

  it('dm-busy: nothing in the bar until a tap asks to move', async () => {
    renderPanel({ dm: { phase: 'streaming', activity: null, error: null } as GameStoreState['dm'] });
    expect(bar()).toBeEmptyDOMElement();
    await enterOn(3, 7);
    expect(within(bar()).getByText('The DM is still working.')).toBeInTheDocument();
  });

  it('stop-pending: the stop, Tell the DM, and a second move is refused until the DM has answered (D34)', async () => {
    const { spies, user } = renderPanel({ combat: sampleStopCombat() });
    expect(within(bar()).getByText("You stop at B6: leaving the Dock Ogre's reach gives it an Opportunity Attack.")).toBeInTheDocument();
    await enterOn(3, 5);
    expect(within(bar()).getByText('Tell the DM what you do first — the Dock Ogre gets an Opportunity Attack.')).toBeInTheDocument();
    expect(spies.commitHeroMove).not.toHaveBeenCalled();

    act(() => usePlayView.getState().setDraft('I swing at the ogre.'));
    await user.click(within(bar()).getByRole('button', { name: 'Tell the DM' }));
    expect(usePlayView.getState().draft).toBe('I swing at the ogre.\nI keep moving to A7.');
    // Again: the words are already there; only the focus moves.
    const focus = usePlayView.getState().composerFocus;
    await user.click(within(bar()).getByRole('button', { name: 'Tell the DM' }));
    expect(usePlayView.getState().draft).toBe('I swing at the ogre.\nI keep moving to A7.');
    expect(usePlayView.getState().composerFocus).toBe(focus + 1);

    // The DM saw the stop (stamped on user message 4) and answered: the hero may move on.
    const combat = sampleStopCombat();
    const map4 = combat.map as NonNullable<CombatState['map']>;
    const stamped = { ...combat, map: { ...map4, stop: { ...(map4.stop as NonNullable<typeof map4.stop>), toldSeq: 4 } } };
    act(() =>
      useGame.setState({
        combat: stamped,
        transcript: [
          { seq: 4, param: { role: 'user', content: 'I keep moving to A7.' } },
          { seq: 5, param: { role: 'assistant', content: [] } },
        ] as unknown as TranscriptMessage[],
      }),
    );
    expect(screen.getByText('Your turn · 30 ft')).toBeInTheDocument();
    expect(within(bar()).queryByText(/You stop at B6/)).not.toBeInTheDocument();
  });
});

describe('BattleMapPanel: moving (spec §7.4)', () => {
  it('plans with the keyboard (arrows, Enter), warns about the Opportunity Attack, and commits on Enter again', async () => {
    const { spies } = renderPanel({ combat: heroTurnWithBanditAdjacent() });
    act(() => map().focus());
    expect(usePlayView.getState().cursor).toEqual({ x: 1, y: 5 }); // B6, the hero
    await key('ArrowRight');
    await key('ArrowRight');
    await key('ArrowDown');
    await key('ArrowDown'); // D8
    await key('Enter');
    expect(screen.getByTestId('plan-readout')).toHaveTextContent('To D8 · 10 ft · 20 ft left');
    expect(screen.getByText("⚠ Leaves Bandit 1's reach: Opportunity Attack")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disengage (uses your action)' })).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(liveRegion()).toHaveTextContent('Plan: D8, 10 feet, 20 left. Leaves the reach of Bandit 1: Opportunity Attack. Press Enter to move.'));
    await key('Enter');
    await waitFor(() => expect(spies.commitHeroMove).toHaveBeenCalledTimes(1));
    expect(spies.commitHeroMove).toHaveBeenCalledWith({ to: { x: 3, y: 7 }, prefer: 'safest', dash: false, disengage: false, standUp: false });
    // The move stopped on B6 for the attack: the bar says so and offers Tell the DM.
    expect(await screen.findByText("You stop at B6: leaving Bandit 1's reach gives it an Opportunity Attack.")).toBeInTheDocument();
  });

  it('offers Disengage only when the plan provokes, and sends it (G toggles it too)', async () => {
    const { spies, user } = renderPanel({ combat: heroTurnWithBanditAdjacent() });
    await enterOn(3, 7);
    await user.click(screen.getByRole('button', { name: 'Disengage (uses your action)' }));
    expect(screen.getByRole('button', { name: 'Disengage (uses your action)' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText(/Opportunity Attack$/)).not.toBeInTheDocument();
    await key('g');
    await key('g');
    await user.click(screen.getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(spies.commitHeroMove).toHaveBeenCalledWith({ to: { x: 3, y: 7 }, prefer: 'safest', dash: false, disengage: true, standUp: false }));
    expect(await screen.findByTestId('moved-readout')).toHaveTextContent('Moved to D8 · 20 ft left');

    // No provocation, no Disengage offer.
    await enterOn(5, 7);
    expect(screen.queryByRole('button', { name: 'Disengage (uses your action)' })).not.toBeInTheDocument();
  });

  it('makes Dash explicit: a Dash-band square reads "Needs Dash" and the button "Dash and move" (D61)', async () => {
    const { spies, user } = renderPanel();
    await enterOn(9, 5); // J6, 40 ft away
    expect(screen.getByTestId('plan-readout')).toHaveTextContent(/^To J6 · 40 ft · 20 ft left$/);
    expect(screen.getByText('Needs Dash — uses your action')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dash and move' }));
    await waitFor(() => expect(spies.commitHeroMove).toHaveBeenCalledWith({ to: { x: 9, y: 5 }, prefer: 'safest', dash: true, disengage: false, standUp: false }));
    expect(await screen.findByTestId('moved-readout')).toHaveTextContent('Moved to J6 · 20 ft left');
  });

  it('refuses a square out of reach in the player’s words', async () => {
    renderPanel();
    await enterOn(15, 0); // P1, in the office: beyond even a Dash
    expect(within(bar()).getByText(/^(Too far: \d+ ft \(you have 30, or 60 with Dash\)\.|There's no way through from here\.)$/)).toBeInTheDocument();
  });

  it('after a move: Undo, Tell the DM (focus only, the draft untouched) and End turn', async () => {
    const { spies, user } = renderPanel();
    await enterOn(3, 7);
    await key('Enter');
    expect(await screen.findByTestId('moved-readout')).toHaveTextContent('Moved to D8 · 20 ft left');
    expect(map().querySelector('[data-token-id="c-1"]')).toHaveAttribute('data-square', 'D8');

    act(() => usePlayView.getState().setDraft('I raise my staff.'));
    const focus = usePlayView.getState().composerFocus;
    await user.click(within(bar()).getByRole('button', { name: 'Tell the DM' }));
    expect(usePlayView.getState().draft).toBe('I raise my staff.');
    expect(usePlayView.getState().composerFocus).toBe(focus + 1);

    await user.click(within(bar()).getByRole('button', { name: 'Undo' }));
    expect(spies.undoHeroMove).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(map().querySelector('[data-token-id="c-1"]')).toHaveAttribute('data-square', 'B6'));
    expect(screen.getByText('Your turn · 30 ft')).toBeInTheDocument();

    // U undoes too.
    await enterOn(3, 7);
    await key('Enter');
    await screen.findByTestId('moved-readout');
    await key('u');
    await waitFor(() => expect(spies.undoHeroMove).toHaveBeenCalledTimes(2));
  });

  it('Tell the DM on a phone switches to the Story tab', async () => {
    setMatchMedia(TOUCH);
    const { user } = renderPanel({}, 'tab');
    act(() => usePlayView.getState().setMobileTab('combat'));
    await enterOn(3, 7);
    await key('Enter');
    await screen.findByTestId('moved-readout');
    await user.click(within(bar()).getByRole('button', { name: 'Tell the DM' }));
    expect(usePlayView.getState().mobileTab).toBe('story');
  });

  it('End turn sends "I end my turn." with an empty draft, and adds it to a draft with words (never sending them)', async () => {
    const { user } = renderPanel();
    await user.click(within(bar()).getByRole('button', { name: 'End turn' }));
    expect(dm.sendPlayerMessage).toHaveBeenCalledWith('I end my turn.');

    act(() => usePlayView.getState().setDraft('I hold my breath.'));
    await user.click(within(bar()).getByRole('button', { name: 'End turn' }));
    expect(dm.sendPlayerMessage).toHaveBeenCalledTimes(1);
    expect(usePlayView.getState().draft).toBe('I hold my breath.\nI end my turn.');
  });

  it('a save that fails shows a toast, not a crash', async () => {
    const { spies } = renderPanel();
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
    spies.commitHeroMove.mockRejectedValueOnce(new Error('QuotaExceededError'));
    await enterOn(3, 7);
    await key('Enter');
    await waitFor(() => expect(error).toHaveBeenCalledWith("Couldn't save your move. Try again."));
    expect(screen.getByText('Your turn · 30 ft')).toBeInTheDocument();
  });

  it('stands up from Prone with the pill’s button', async () => {
    const { spies, user } = renderPanel({ character: { ...sampleCharacter(), conditions: [{ id: 'prone' }] } });
    await user.click(screen.getByRole('button', { name: 'Stand up · 15 ft' }));
    expect(spies.commitHeroMove).toHaveBeenCalledWith({ prefer: 'safest', dash: false, disengage: false, standUp: true });
  });
});

describe('BattleMapPanel: keyboard (spec §7.9)', () => {
  it('moves the cursor with arrows (Shift: 5), Home/End, and finds creatures with N, H and T', async () => {
    renderPanel({ combat: sampleMappedCombat() });
    act(() => map().focus());
    const cursor = () => usePlayView.getState().cursor;
    expect(cursor()).toEqual({ x: 1, y: 5 });
    await key('ArrowRight', { shiftKey: true });
    expect(cursor()).toEqual({ x: 6, y: 5 });
    await key('Home');
    expect(cursor()).toEqual({ x: 0, y: 5 });
    await key('End');
    expect(cursor()).toEqual({ x: 15, y: 5 });
    await key('ArrowDown', { shiftKey: true });
    await key('ArrowDown', { shiftKey: true });
    expect(cursor()).toEqual({ x: 15, y: 11 });
    await key('t'); // whose turn: Bandit 1
    expect(cursor()).toEqual({ x: 5, y: 3 });
    await waitFor(() => expect(liveRegion()).toHaveTextContent('F4: Bandit 1, enemy, bloodied. 20 feet from you.'));
    await key('h');
    expect(cursor()).toEqual({ x: 1, y: 5 });
    await key('n');
    expect(cursor()).not.toEqual({ x: 1, y: 5 });
    await key('n', { shiftKey: true });
    expect(cursor()).toEqual({ x: 1, y: 5 });
  });

  it('switches modes with V, M and A, and Escape leaves them', async () => {
    renderPanel();
    await key('m');
    expect(usePlayView.getState().mapMode).toBe('measure');
    await key('Escape');
    expect(usePlayView.getState().mapMode).toBe('move');
    await key('a');
    expect(usePlayView.getState().mapMode).toBe('area');
    expect(screen.getByRole('dialog', { name: 'Area of effect' })).toBeInTheDocument();
    await key('v');
    expect(usePlayView.getState().mapMode).toBe('move');
  });

  it('opens the list with L and the help with ?', async () => {
    renderPanel();
    await key('l');
    expect(screen.getByRole('table')).toBeInTheDocument();
    await act(async () => usePlayView.getState().setMapList(false));
    await key('?');
    expect(screen.getByRole('dialog', { name: 'The battle map' })).toBeInTheDocument();
  });

  it('only listens while the map itself has focus', async () => {
    renderPanel();
    const before = usePlayView.getState().cursor;
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('button', { name: 'Zoom in' }), { key: 'ArrowRight' });
    });
    expect(usePlayView.getState().cursor).toBe(before);
  });
});

describe('BattleMapPanel: measuring (spec §7.4)', () => {
  it('measures from you to a creature with sight and cover, swaps and clears', async () => {
    const { user } = renderPanel();
    await key('m');
    expect(screen.getByTestId('measure-readout')).toHaveTextContent('Point at a square or a creature to measure to it.');
    await enterOn(5, 3); // Bandit 1
    expect(screen.getByTestId('measure-readout')).toHaveTextContent(/^Mira Voss → Bandit 1: 20 ft \(4 squares\) · clear line of sight/);
    await user.click(screen.getByRole('button', { name: 'Swap' }));
    expect(screen.getByTestId('measure-readout')).toHaveTextContent(/^Bandit 1 → Mira Voss: 20 ft \(4 squares\)/);
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(usePlayView.getState().measure).toBeNull();
  });

  it('measures to a square under a creature as to the creature', async () => {
    renderPanel();
    await key('m');
    await enterOn(3, 7);
    expect(screen.getByTestId('measure-readout')).toHaveTextContent('Mira Voss → D8: 10 ft (2 squares) · clear line of sight');
    await enterOn(7, 10); // the Dock Ogre's space is H10:I11: its lower-left square
    expect(screen.getByTestId('measure-readout')).toHaveTextContent(/^Mira Voss → Dock Ogre: 30 ft \(6 squares\)/);
  });
});

describe('BattleMapPanel: the first-fight tip (D65)', () => {
  const tip = /your moves reach the DM with your next message · Undo until you send/;

  it('dismisses for good: a remount keeps it dismissed', async () => {
    const { user, unmount } = renderPanel();
    expect(screen.getByText(tip)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss the tip' }));
    expect(screen.queryByText(tip)).not.toBeInTheDocument();
    expect(window.localStorage.getItem(TIP_STORAGE_KEY)).toBe('dismissed');
    unmount();
    resetTipForTests();
    render(<BattleMapPanel variant="dock" />);
    expect(screen.queryByText(tip)).not.toBeInTheDocument();
  });

  it('still works when localStorage throws (remembered for the visit)', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const { user, unmount } = renderPanel();
    expect(screen.getByText(tip)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss the tip' }));
    expect(screen.queryByText(tip)).not.toBeInTheDocument();
    unmount();
    render(<BattleMapPanel variant="dock" />);
    expect(screen.queryByText(tip)).not.toBeInTheDocument();
  });
});

describe('BattleMapPanel: the waiting banner (D54)', () => {
  it('shows when the DM went idle on another creature’s turn, and Remind adds an OOC nudge once', async () => {
    const { user } = renderPanel({ combat: sampleMappedCombat() });
    expect(within(bar()).getByText("Waiting for the DM to finish Bandit 1's turn")).toBeInTheDocument();
    act(() => usePlayView.getState().setDraft('Hm.'));
    await user.click(within(bar()).getByRole('button', { name: 'Remind the DM' }));
    expect(usePlayView.getState().ooc).toBe(true);
    expect(usePlayView.getState().draft).toBe("Hm.\nIt's still Bandit 1's turn on the tracker — please finish it.");
    await user.click(within(bar()).getByRole('button', { name: 'Remind the DM' }));
    expect(usePlayView.getState().draft).toBe("Hm.\nIt's still Bandit 1's turn on the tracker — please finish it.");
  });

  it('names the last visible creature during a hidden one’s turn, and hides while the DM works or without a session', () => {
    renderPanel({ combat: { ...sampleMappedCombat(), turnIndex: 2 } });
    expect(within(bar()).getByText("Waiting for the DM to finish Bandit 1's turn")).toBeInTheDocument();
    act(() => useGame.setState({ dm: { ...useGame.getState().dm, phase: 'thinking' } }));
    expect(within(bar()).queryByText(/Waiting for the DM/)).not.toBeInTheDocument();
    act(() => useGame.setState({ dm: { ...useGame.getState().dm, phase: 'idle' }, activeSession: null }));
    expect(within(bar()).queryByText(/Waiting for the DM/)).not.toBeInTheDocument();
  });
});

describe('BattleMapPanel: plans expire', () => {
  it('drops the plan when the DM starts working or the turn moves on (spec §7.3)', async () => {
    renderPanel();
    await enterOn(3, 7);
    expect(usePlayView.getState().plan).not.toBeNull();
    act(() => useGame.setState({ dm: { ...useGame.getState().dm, phase: 'thinking' } }));
    expect(usePlayView.getState().plan).toBeNull();
    act(() => useGame.setState({ dm: { ...useGame.getState().dm, phase: 'idle' } }));
    await enterOn(3, 7);
    expect(usePlayView.getState().plan).not.toBeNull();
    act(() => useGame.setState({ combat: { ...(useGame.getState().combat as CombatState), turnIndex: 1 } }));
    expect(usePlayView.getState().plan).toBeNull();
  });
});

describe('U6: touch targets of at least 44px on phones (spec §7.9)', () => {
  /** lg Buttons are h-12 (48px) and lg IconButtons size-12; the rest carry min-h-11 (44px). */
  const expectTouchTarget = (el: Element) => expect(el.className).toMatch(/(^|\s)(h-12|size-12|min-h-11)(\s|$)/);

  it('the mode radios, Keys and help, the plan’s toggles, Stand up, a card’s Close and the tip’s Dismiss', async () => {
    setMatchMedia(TOUCH);
    const { user } = renderPanel(
      { combat: heroTurnWithBanditAdjacent(), character: { ...sampleCharacter(), conditions: [{ id: 'prone' }] } },
      'tab',
    );
    expect(screen.getByRole('radiogroup').className).toContain('[&_button]:min-h-11');
    expectTouchTarget(screen.getByRole('button', { name: 'Stand up · 15 ft' }));
    expectTouchTarget(screen.getByRole('button', { name: 'Dismiss the tip' }));
    await user.click(screen.getByRole('button', { name: 'List, key and help' }));
    expectTouchTarget(screen.getByRole('button', { name: 'Keys and help' }));
    await key('Escape');
    // A plan that provokes: the Disengage and Stand up first toggles.
    await enterOn(3, 7);
    expectTouchTarget(screen.getByRole('button', { name: 'Disengage (uses your action)' }));
    expectTouchTarget(screen.getByRole('button', { name: /^Stand up first/ }));
    await key('Escape');
    // A creature's card.
    act(() => usePlayView.getState().setCursor({ x: 1, y: 4 }));
    await key('Enter');
    expectTouchTarget(within(bar()).getByRole('button', { name: 'Close' }));
  });

  it('the list’s Show on map, Move next to and Move to square, and the area bar’s Clear and Snap', async () => {
    setMatchMedia(TOUCH);
    const { user } = renderPanel({ combat: heroTurnWithBanditAdjacent() }, 'tab');
    await key('l');
    expectTouchTarget(screen.getByRole('button', { name: 'Show Bandit 1 on the map' }));
    expectTouchTarget(screen.getByRole('button', { name: 'Move next to Bandit 1' }));
    expectTouchTarget(screen.getByRole('textbox', { name: 'Move to square' }));
    await user.click(screen.getByRole('button', { name: 'Show the map' }));
    await key('a');
    await user.click(screen.getByRole('button', { name: 'Place it' }));
    expectTouchTarget(screen.getByRole('button', { name: 'Clear the area' }));
    expect(screen.getByRole('radio', { name: 'Snap: square' }).parentElement?.className).toContain('[&_button]:min-h-11');
  });
});

describe('the list view (spec §7.9: the complete path without a pointer or sight)', () => {
  const field = () => screen.getByRole('textbox', { name: 'Move to square' }) as HTMLInputElement;
  const listMove = () => within(field().closest('form') as HTMLElement).getByRole('button', { name: /Move/ });

  it('U2: the list’s readout region stays mounted (empty while you can’t move), so its first readout is announced', async () => {
    const { user } = renderPanel({ combat: sampleMappedCombat() });
    act(() => usePlayView.getState().setMapList(true));
    const region = screen.getByTestId('list-readout');
    expect(region).toHaveAttribute('aria-live', 'polite');
    await user.type(field(), 'D8');
    // Off your turn there is no plan to read out: the region is there, and empty.
    expect(screen.getByTestId('list-readout')).toBe(region);
    expect(region).toBeEmptyDOMElement();
    // Your turn: the same region gets the readout.
    const c = useGame.getState().combat as CombatState;
    act(() => useGame.setState({ combat: { ...c, turnIndex: 0, round: c.round + 1 } }));
    await user.clear(field());
    await user.type(field(), 'D8');
    expect(screen.getByTestId('list-readout')).toBe(region);
    expect(region).toHaveTextContent('To D8 · 10 ft · 20 ft left');
    expect(field()).toHaveAttribute('aria-describedby', region.id);
  });

  it('U3: Move to square commits what its own readout previewed, not an earlier map plan’s Disengage', async () => {
    const { spies, user } = renderPanel({ combat: heroTurnWithBanditAdjacent() });
    await enterOn(3, 7); // D8 on the map…
    await key('g'); // …with Disengage
    expect(usePlayView.getState().plan?.disengage).toBe(true);
    await key('l');
    await user.type(field(), 'C8');
    expect(screen.getByText(/^To C8 · 10 ft · 20 ft left · ⚠ Leaves Bandit 1's reach: Opportunity Attack$/)).toBeInTheDocument();
    await user.click(listMove());
    await waitFor(() => expect(spies.commitHeroMove).toHaveBeenCalledTimes(1));
    expect(spies.commitHeroMove).toHaveBeenCalledWith({ to: { x: 2, y: 7 }, prefer: 'safest', dash: false, disengage: false, standUp: false });
  });

  it('U3: …nor an earlier plan’s Dash', async () => {
    const { spies, user } = renderPanel();
    await enterOn(3, 7);
    await key('d');
    expect(usePlayView.getState().plan?.dash).toBe(true);
    await key('l');
    await user.type(field(), 'C7');
    expect(listMove()).toHaveTextContent(/^Move$/);
    await user.click(listMove());
    await waitFor(() => expect(spies.commitHeroMove).toHaveBeenCalledWith({ to: { x: 2, y: 6 }, prefer: 'safest', dash: false, disengage: false, standUp: false }));
  });

  it('U2: a move from the list that stops for an Opportunity Attack is announced, and the list says why you can’t move on', async () => {
    const { user } = renderPanel({ combat: heroTurnWithBanditAdjacent() });
    await user.click(screen.getByRole('button', { name: 'List positions' }));
    await user.type(field(), 'D8');
    await user.click(listMove());
    await waitFor(() => expect(liveRegion()).toHaveTextContent("You stop at B6: leaving Bandit 1's reach gives it an Opportunity Attack."));
    const list = screen.getByRole('region', { name: 'Positions on the battle map' });
    expect(within(list).getByText('Tell the DM what you do first — Bandit 1 gets an Opportunity Attack.')).toBeInTheDocument();
    expect(within(list).queryByText('You can move on your turn.')).not.toBeInTheDocument();
    // The field doesn't hold on to the square (its readout would re-read a plan to where you stand).
    expect(field()).toHaveValue('');
  });

  it('U2: a move from the list is announced as moved, and the field clears', async () => {
    const { user } = renderPanel();
    await user.click(screen.getByRole('button', { name: 'List positions' }));
    await user.type(field(), 'C8');
    await user.click(listMove());
    await waitFor(() => expect(liveRegion()).toHaveTextContent('Moved to C8.'));
    expect(field()).toHaveValue('');
    expect(screen.queryByText(/^To C8/)).not.toBeInTheDocument();
  });

  it('U2: the hero’s turn starting while the list is open is announced, and the list gives the DM’s reason while it works', async () => {
    renderPanel({ combat: sampleMappedCombat(), dm: { phase: 'tool', activity: null, error: null } as GameStoreState['dm'] });
    act(() => usePlayView.getState().setMapList(true));
    expect(screen.getByText("It isn't your turn.")).toBeInTheDocument();
    const c = useGame.getState().combat as CombatState;
    act(() => useGame.setState({ combat: { ...c, turnIndex: 0, round: c.round + 1 } }));
    expect(screen.getByText('The DM is still working.')).toBeInTheDocument();
    act(() => useGame.setState({ dm: { ...useGame.getState().dm, phase: 'idle' } }));
    await waitFor(() => expect(liveRegion()).toHaveTextContent(/^Your turn\. 30 feet of movement\./));
  });
});

describe('U1: focus after the action bar’s own buttons act', () => {
  /** Press a bar button from the keyboard (it has focus, Enter activates it). */
  async function pressInBar(user: ReturnType<typeof userEvent.setup>, name: string | RegExp) {
    const button = within(bar()).getByRole('button', { name });
    act(() => button.focus());
    expect(document.activeElement).toBe(button);
    await user.keyboard('{Enter}');
  }

  it('Move and Undo: focus returns to the map, not the page', async () => {
    const { user } = renderPanel();
    await enterOn(3, 7);
    await pressInBar(user, 'Move');
    expect(await screen.findByTestId('moved-readout')).toHaveTextContent('Moved to D8 · 20 ft left');
    expect(document.activeElement).toBe(map());
    await pressInBar(user, 'Undo');
    await waitFor(() => expect(within(bar()).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument());
    expect(document.activeElement).toBe(map());
  });

  it('Cancel, a card’s Close, Dismiss the tip and Clear the area: back to the map', async () => {
    const { user } = renderPanel();
    await enterOn(3, 7);
    await pressInBar(user, 'Cancel');
    expect(usePlayView.getState().plan).toBeNull();
    expect(document.activeElement).toBe(map());

    act(() => usePlayView.getState().setCursor({ x: 1, y: 4 })); // Old Tam: his card
    await key('Enter');
    await pressInBar(user, 'Close');
    expect(within(bar()).queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(map());

    await pressInBar(user, 'Dismiss the tip');
    expect(document.activeElement).toBe(map());

    await key('a');
    await user.click(screen.getByRole('button', { name: 'Place it' }));
    await pressInBar(user, 'Clear the area');
    expect(usePlayView.getState().template).toBeNull();
    expect(document.activeElement).toBe(map());
  });

  it('in the list view focus goes to the list; focus that moved on elsewhere is left alone', async () => {
    const { user } = renderPanel({ combat: heroTurnWithBanditAdjacent() });
    await key('l');
    await user.click(screen.getByRole('button', { name: 'Move next to Bandit 1' }));
    await pressInBar(user, 'Cancel');
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Positions on the battle map' }));

    // A plan, then the player tabs on to the list's field: the bar changing under it doesn't steal focus.
    await user.click(screen.getByRole('button', { name: 'Move next to Bandit 1' }));
    act(() => within(bar()).getByRole('button', { name: 'Cancel' }).focus());
    const field = screen.getByRole('textbox', { name: 'Move to square' });
    act(() => field.focus());
    act(() => usePlayView.getState().setPlan(null));
    expect(document.activeElement).toBe(field);
  });
});

describe('U10: the next fight on the same table', () => {
  /** The Play table mounts the expiry once, beside the map. */
  function Table({ children }: { children: ReactNode }) {
    useMapPlanExpiry();
    return <>{children}</>;
  }

  /** A second, smaller fight (10×8, a new map id and start) with the visible creatures where they stood. */
  function smallerFight(): CombatState {
    const base = sampleMappedCombat({ heroTurn: true });
    return {
      ...base,
      startedAt: base.startedAt + 1000,
      combatants: base.combatants.filter((c) => c.id !== 'c-5' && c.id !== 'c-6'),
      map: { ...(base.map as NonNullable<CombatState['map']>), id: 'map-7', name: 'The Crooked Lantern', width: 10, height: 8, terrain: [], places: [], effects: [] },
    };
  }

  it('opens in Move mode with no cursor or highlight left from the last fight, so the keyboard starts on the hero', async () => {
    seedGame({ combat: sampleMappedCombat({ heroTurn: true }) });
    render(
      <Table>
        <BattleMapPanel variant="dock" />
      </Table>,
    );
    act(() => usePlayView.getState().setCursor({ x: 15, y: 11 })); // P12
    await key('m');
    act(() => usePlayView.getState().setHighlighted('c-2'));
    act(() => usePlayView.getState().setMapList(true));
    act(() => useGame.setState({ combat: null }));
    act(() => useGame.setState({ combat: smallerFight() }));
    expect(usePlayView.getState()).toMatchObject({ mapMode: 'move', cursor: null, highlightedId: null, plan: null, measure: null, template: null });
    // The list view is a way of playing: it stays.
    expect(usePlayView.getState().mapList).toBe(true);
    act(() => usePlayView.getState().setMapList(false));
    const app = screen.getByRole('application', { name: /The Crooked Lantern, 10 by 8 squares/ });
    act(() => app.focus());
    expect(usePlayView.getState().cursor).toEqual({ x: 1, y: 5 }); // the hero, B6
    await act(async () => {
      fireEvent.keyDown(app, { key: 'Enter' });
    });
    expect(within(bar()).queryByText("That's off the map.")).not.toBeInTheDocument();
  });

  it('a map replaced mid-fight drops the old map’s cursor too', () => {
    seedGame({ combat: sampleMappedCombat({ heroTurn: true }) });
    render(
      <Table>
        <BattleMapPanel variant="dock" />
      </Table>,
    );
    act(() => usePlayView.getState().setCursor({ x: 15, y: 11 }));
    const c = useGame.getState().combat as CombatState;
    act(() => useGame.setState({ combat: { ...c, map: { ...(c.map as NonNullable<CombatState['map']>), id: 'map-2' } } }));
    expect(usePlayView.getState().cursor).toBeNull();
  });
});

describe('E2 and E3: the dock’s action bar and the zoom buttons', () => {
  const zoomGroup = () => screen.queryByRole('group', { name: 'Zoom' });
  const viewportArea = () => document.querySelector('[data-map-part="viewport"]') as HTMLElement;
  const strip = () => document.querySelector('[data-map-part="strip"]') as HTMLElement | null;

  it('E2: the bar sits in a strip of fixed height under the map, so the map keeps its size whatever the bar holds', async () => {
    renderPanel();
    expect(strip()).toHaveClass('h-14', 'shrink-0');
    expect(strip()?.contains(bar())).toBe(true);
    expect(viewportArea().contains(bar())).toBe(false);
    // A taller bar (a creature's card) grows up over the map from the strip; the strip itself stays put.
    act(() => usePlayView.getState().setCursor({ x: 1, y: 4 }));
    await key('Enter');
    expect(within(bar()).getByText('Old Tam')).toBeInTheDocument();
    expect(strip()).toHaveClass('h-14');
    expect(bar().parentElement).toHaveClass('absolute', 'bottom-0', 'z-10');
  });

  it('E3: the zoom buttons float in a lane the bar keeps clear (40px buttons with a mouse, 48px on touch)', () => {
    const { unmount } = renderPanel();
    const group = zoomGroup() as HTMLElement;
    // Above the bar's strip and anything it grows over (z-20 over its z-10), not inside the map's own box.
    expect(viewportArea().contains(group)).toBe(false);
    expect(group.parentElement).toHaveClass('absolute', 'right-2', 'bottom-2', 'z-20');
    expect((bar().parentElement as HTMLElement).style.paddingRight).toBe('56px');
    unmount();
    setMatchMedia((q) => DESKTOP(q) || TOUCH(q));
    renderPanel();
    expect((bar().parentElement as HTMLElement).style.paddingRight).toBe('64px');
  });

  it('E3: the list view has no zoom buttons and no lane; on phones the buttons stay inside the map and the bar is below it', async () => {
    const { unmount } = renderPanel();
    await key('l');
    expect(zoomGroup()).toBeNull();
    expect((bar().parentElement as HTMLElement).style.paddingRight).toBe('');
    unmount();
    act(() => usePlayView.getState().setMapList(false));
    renderPanel({}, 'tab');
    expect(strip()).toBeNull();
    expect(viewportArea().contains(zoomGroup())).toBe(true);
    expect(viewportArea().contains(bar())).toBe(false);
  });
});

describe('E1 in a creature’s card', () => {
  it('the name stays whole in a narrow bar: the side and the square wrap to the next line instead of squeezing it', async () => {
    renderPanel();
    act(() => usePlayView.getState().setCursor({ x: 1, y: 4 })); // Old Tam
    await key('Enter');
    const name = within(bar()).getByText('Old Tam');
    const title = name.parentElement as HTMLElement;
    expect(title).toHaveClass('flex-wrap');
    expect(name).toHaveClass('min-w-0', 'truncate');
    expect(within(title).getByText('(ally)')).toHaveClass('shrink-0');
    expect(title).toHaveTextContent('B5 (the loading door)');
  });
});
