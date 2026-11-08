import '../testing/setup';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dm } from '@/dm';
import { useGame, type GameStoreState } from '@/state/gameStore';
import { sampleMappedCombat, sampleStopCombat } from '@/test/fixtures';
import type { CombatState, TranscriptMessage } from '@/types';
import { toast } from '@/ui/components/toast';
import { usePlayView } from '../playView';
import { resetDmMock } from '../testing/dmMock';
import { seedGame } from '../testing/seed';
import { DESKTOP, setMatchMedia, stubBoundingRect, TOUCH } from '../testing/setup';
import { resetTipForTests, TIP_STORAGE_KEY } from './banners';
import { BattleMapPanel } from './BattleMapPanel';

vi.mock('@/dm', () => import('../testing/dmMock'));
vi.mock('@/engine', () => import('../testing/engineMock'));
vi.mock('@/data', () => ({ useRulesIndex: () => null }));

/** Bandit 1 moved next to the hero (C5): leaving B6 provokes it (spec M24). */
function heroTurnWithBanditAdjacent(): CombatState {
  const base = sampleMappedCombat({ heroTurn: true });
  return { ...base, combatants: base.combatants.map((c) => (c.id === 'c-2' ? { ...c, position: { x: 2, y: 4 } } : c)) };
}

function renderPanel(overrides: Partial<GameStoreState> = {}, variant: 'dock' | 'tab' = 'dock') {
  const spies = seedGame({ combat: sampleMappedCombat({ heroTurn: true }), ...overrides });
  const utils = render(<BattleMapPanel variant={variant} />);
  return { spies, user: userEvent.setup(), ...utils };
}

const map = () => screen.getByRole('application', { name: /Battle map: Dockside warehouse, 16 by 12 squares/ });

async function key(name: string, opts: { shiftKey?: boolean } = {}) {
  await act(async () => {
    fireEvent.keyDown(map(), { key: name, ...opts });
  });
}

beforeEach(() => {
  resetDmMock();
  resetTipForTests();
  try {
    window.localStorage.removeItem(TIP_STORAGE_KEY);
  } catch {
    /* jsdom storage */
  }
  setMatchMedia(DESKTOP);
  stubBoundingRect(640, 480);
});

describe('BattleMapPanel', () => {
  it('is one application with the map name, and its drawing is hidden from assistive tech', () => {
    renderPanel();
    const app = map();
    expect(app).toHaveAttribute('aria-roledescription', 'battle map');
    expect(app).toHaveAttribute('tabindex', '0');
    expect(app.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('Your turn · 30 ft')).toBeInTheDocument();
  });

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
    await key('Enter');
    await waitFor(() => expect(spies.commitHeroMove).toHaveBeenCalledTimes(1));
    expect(spies.commitHeroMove).toHaveBeenCalledWith({ to: { x: 3, y: 7 }, prefer: 'safest', dash: false, disengage: false, standUp: false });
    // The move stopped on B6 for the attack: the bar says so and offers Tell the DM.
    expect(await screen.findByText("You stop at B6: leaving Bandit 1's reach gives it an Opportunity Attack.")).toBeInTheDocument();
  });
});
