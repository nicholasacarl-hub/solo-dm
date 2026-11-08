import '../testing/setup';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameStoreState } from '@/state/gameStore';
import { sampleMappedCombat } from '@/test/fixtures';
import { usePlayView } from '../playView';
import { resetDmMock } from '../testing/dmMock';
import { seedGame } from '../testing/seed';
import { DESKTOP, setMatchMedia, stubBoundingRect } from '../testing/setup';
import { BattleMapPanel } from './BattleMapPanel';
import { resetShownBudgetForTests } from './model';

vi.mock('@/dm', () => import('../testing/dmMock'));
vi.mock('@/engine', () => import('../testing/engineMock'));
vi.mock('@/data', () => ({ useRulesIndex: () => null }));

async function renderList(overrides: Partial<GameStoreState> = {}) {
  const spies = seedGame({ combat: sampleMappedCombat({ heroTurn: true }), ...overrides });
  render(<BattleMapPanel variant="dock" />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'List positions' }));
  return { spies, user };
}

beforeEach(() => {
  resetDmMock();
  resetShownBudgetForTests();
  setMatchMedia(DESKTOP);
  stubBoundingRect(640, 480);
});

describe('PositionsList (spec §7.9)', () => {
  it('lists you, then every creature you can see by distance, then the terrain near you', async () => {
    await renderList();
    const list = screen.getByRole('region', { name: 'Positions on the battle map' });
    expect(within(list).getByText(/^B6 \(the loading door\) · Your turn · 30 ft$/)).toBeInTheDocument();
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual(['Old Tam', 'Bandit 1', 'Bandit 2', 'Dock Ogre']);
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^Old TamallyB55 ftnorth9\/9—YesNone/),
      expect.stringMatching(/^Bandit 1enemyF420 ftnorth-eastBloodied—Yes/),
      expect.stringMatching(/^Bandit 2enemyF320 ftnorth-eastUnhurtProneYes/),
      expect.stringMatching(/^Dock OgreenemyH10:I1130 ftsouth-eastUnhurt—Yes/),
    ]);
    const terrain = within(list).getByRole('heading', { name: 'Terrain within 30 ft' }).nextElementSibling as HTMLElement;
    expect(within(terrain).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Crates (half cover) E5:F6 · 15 ft',
      'Brazier (hazard) G11 · 25 ft',
      'Spilled grain (difficult terrain) H8:J9 · 30 ft',
    ]);
  });

  it('moves to a typed square without a pointer, with the same readout as the map', async () => {
    const { spies, user } = await renderList();
    const field = screen.getByRole('textbox', { name: 'Move to square' });
    expect(field).toHaveAttribute('placeholder', 'E6');
    await user.type(field, 'q13');
    expect(screen.getByText('"Q13" is off the map: columns run A–P and rows 1–12.')).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, 'd8');
    expect(screen.getByText('To D8 · 10 ft · 20 ft left')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(spies.commitHeroMove).toHaveBeenCalledWith({ to: { x: 3, y: 7 }, prefer: 'safest', dash: false, disengage: false, standUp: false }));
  });

  it('offers Dash and move for a square in the Dash band', async () => {
    const { user } = await renderList();
    await user.type(screen.getByRole('textbox', { name: 'Move to square' }), 'J6');
    expect(screen.getByText('To J6 · 40 ft · 20 ft left · Needs Dash — uses your action')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dash and move' })).toBeEnabled();
  });

  it('shows a creature on the map, and plans a move next to an enemy', async () => {
    const { user } = await renderList();
    await user.click(screen.getByRole('button', { name: 'Show Bandit 1 on the map' }));
    expect(screen.getByRole('application')).toBeInTheDocument();
    expect(usePlayView.getState()).toMatchObject({ highlightedId: 'c-2', cursor: { x: 5, y: 3 }, mapList: false });

    await user.click(screen.getByRole('button', { name: 'List positions' }));
    await user.click(screen.getByRole('button', { name: 'Move next to Bandit 1' }));
    expect(usePlayView.getState().plan?.to).toEqual({ x: 4, y: 3 });
  });

  it('can’t move off your turn, and never lists a hidden creature', async () => {
    await renderList({ combat: { ...sampleMappedCombat(), turnIndex: 2 } });
    expect(screen.getByText('You can move on your turn.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Move next to/ })).not.toBeInTheDocument();
    expect(screen.getByRole('table').textContent).not.toMatch(/Cutthroat/);
  });
});
