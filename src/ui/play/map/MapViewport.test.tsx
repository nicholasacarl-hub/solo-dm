import '../testing/setup';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameStoreState } from '@/state/gameStore';
import { sampleMappedCombat } from '@/test/fixtures';
import type { CombatState } from '@/types';
import { usePlayView } from '../playView';
import { resetDmMock } from '../testing/dmMock';
import { seedGame } from '../testing/seed';
import { DESKTOP, setMatchMedia, stubBoundingRect } from '../testing/setup';
import { BattleMapPanel } from './BattleMapPanel';
import { CELL, liveCamera, worldToScreen } from './camera';
import { resetShownBudgetForTests } from './model';

vi.mock('@/dm', () => import('../testing/dmMock'));
vi.mock('@/engine', () => import('../testing/engineMock'));
vi.mock('@/data', () => ({ useRulesIndex: () => null }));

const VIEW = { width: 640, height: 480 };
const CAMERA_KEY = '1700000000000:map-1'; // the fight's start and the map's id

function heroTurnWithBanditAdjacent(): CombatState {
  const base = sampleMappedCombat({ heroTurn: true });
  return { ...base, combatants: base.combatants.map((c) => (c.id === 'c-2' ? { ...c, position: { x: 2, y: 4 } } : c)) };
}

function renderMap(overrides: Partial<GameStoreState> = {}) {
  const spies = seedGame({ combat: sampleMappedCombat({ heroTurn: true }), ...overrides });
  render(<BattleMapPanel variant="dock" />);
  return spies;
}

const svg = () => screen.getByRole('application').querySelector('svg') as SVGSVGElement;
const bar = () => document.querySelector('[data-map-part="bar"]') as HTMLElement;

/** The screen point at the centre of a square, through the camera the map stored. */
function at(x: number, y: number) {
  const cam = usePlayView.getState().cameras[CAMERA_KEY];
  if (!cam) throw new Error('no camera yet');
  const p = worldToScreen(liveCamera(cam, VIEW), (x + 0.5) * CELL, (y + 0.5) * CELL);
  return { clientX: p.x, clientY: p.y };
}

let pointerId = 1;
function tap(x: number, y: number, pointerType: 'mouse' | 'touch' | 'pen') {
  const where = at(x, y);
  const id = pointerId++;
  act(() => {
    fireEvent.pointerDown(svg(), { pointerId: id, pointerType, button: 0, ...where });
    fireEvent.pointerUp(svg(), { pointerId: id, pointerType, button: 0, ...where });
  });
}

beforeEach(() => {
  resetDmMock();
  resetShownBudgetForTests();
  setMatchMedia(DESKTOP);
  stubBoundingRect(VIEW.width, VIEW.height);
});

describe('MapViewport pointer input (D60)', () => {
  it('stores the opening camera for this fight and map: the whole 16×12 map at ≈ 37px squares', () => {
    renderMap();
    const cam = usePlayView.getState().cameras[CAMERA_KEY];
    expect(cam.cellPx).toBeGreaterThan(36);
    expect(cam.cellPx).toBeLessThan(38);
  });

  it('touch: the first tap plans, a second tap on the same square moves', async () => {
    const spies = renderMap();
    tap(3, 7, 'touch');
    expect(screen.getByTestId('plan-readout')).toHaveTextContent('To D8 · 10 ft · 20 ft left');
    expect(spies.commitHeroMove).not.toHaveBeenCalled();
    tap(3, 7, 'touch');
    await waitFor(() => expect(spies.commitHeroMove).toHaveBeenCalledWith({ to: { x: 3, y: 7 }, prefer: 'safest', dash: false, disengage: false, standUp: false }));
  });

  it('mouse: hover previews the path without a plan; a click moves at once when nothing warns', async () => {
    const spies = renderMap();
    act(() => {
      fireEvent.pointerMove(svg(), { pointerId: 99, pointerType: 'mouse', buttons: 0, ...at(3, 7) });
    });
    expect(screen.getByRole('application').querySelector('[data-map-layer="path"]')).not.toBeNull();
    expect(screen.queryByTestId('plan-readout')).not.toBeInTheDocument();
    tap(3, 7, 'mouse');
    await waitFor(() => expect(spies.commitHeroMove).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('moved-readout')).toHaveTextContent('Moved to D8 · 20 ft left');
  });

  it('mouse: a click that would provoke an Opportunity Attack plans first, and the second click moves', async () => {
    const spies = renderMap({ combat: heroTurnWithBanditAdjacent() });
    tap(3, 7, 'mouse');
    expect(spies.commitHeroMove).not.toHaveBeenCalled();
    expect(screen.getByText("⚠ Leaves Bandit 1's reach: Opportunity Attack")).toBeInTheDocument();
    tap(3, 7, 'mouse');
    await waitFor(() => expect(spies.commitHeroMove).toHaveBeenCalledTimes(1));
  });

  it('a tap on squares under 24px zooms toward it to 44px instead of acting', () => {
    const spies = renderMap();
    act(() => usePlayView.getState().setCamera(CAMERA_KEY, { cellPx: 12, cx: 8, cy: 6 }));
    tap(3, 7, 'touch');
    expect(usePlayView.getState().cameras[CAMERA_KEY].cellPx).toBeCloseTo(44);
    expect(usePlayView.getState().plan).toBeNull();
    expect(spies.commitHeroMove).not.toHaveBeenCalled();
  });

  it('tapping an enemy plans the move next to it, with its card in the bar', () => {
    renderMap();
    tap(5, 3, 'touch'); // Bandit 1 on F4
    expect(screen.getByTestId('plan-readout')).toHaveTextContent('To E4 · 15 ft · 15 ft left');
    expect(within(bar()).getByText('Bandit 1')).toBeInTheDocument();
  });

  it('right-click shows a creature’s card from the player view; an ally can’t be ended on', () => {
    renderMap();
    act(() => {
      fireEvent.contextMenu(svg(), at(1, 4)); // Old Tam on B5
    });
    expect(within(bar()).getByText('Old Tam')).toBeInTheDocument();
    expect(within(bar()).getByText("Can't end in Old Tam's space.")).toBeInTheDocument();
    tap(5, 3, 'touch');
    act(() => {
      fireEvent.contextMenu(svg(), at(5, 3)); // Bandit 1: Move next to it from its card
    });
    expect(within(bar()).getByRole('button', { name: 'Move next to Bandit 1' })).toBeInTheDocument();
  });

  it('a drag pans and commits the camera when it ends; Ctrl + wheel zooms', async () => {
    renderMap();
    const before = usePlayView.getState().cameras[CAMERA_KEY];
    const start = at(8, 6);
    act(() => {
      fireEvent.pointerDown(svg(), { pointerId: 50, pointerType: 'mouse', button: 0, ...start });
      fireEvent.pointerMove(svg(), { pointerId: 50, pointerType: 'mouse', clientX: start.clientX - 60, clientY: start.clientY });
      fireEvent.pointerUp(svg(), { pointerId: 50, pointerType: 'mouse', button: 0, clientX: start.clientX - 60, clientY: start.clientY });
    });
    const panned = usePlayView.getState().cameras[CAMERA_KEY];
    expect(panned.cx).toBeGreaterThan(before.cx);
    expect(usePlayView.getState().plan).toBeNull();

    act(() => {
      fireEvent.wheel(svg(), { deltaY: -120, ctrlKey: true, ...at(8, 6) });
    });
    await waitFor(() => expect(usePlayView.getState().cameras[CAMERA_KEY].cellPx).toBeGreaterThan(panned.cellPx));
  });

  it('the zoom, fit and centre buttons are the non-gesture path', async () => {
    renderMap();
    const before = usePlayView.getState().cameras[CAMERA_KEY].cellPx;
    act(() => screen.getByRole('button', { name: 'Zoom in' }).click());
    expect(usePlayView.getState().cameras[CAMERA_KEY].cellPx).toBeCloseTo(before * 1.25);
    act(() => screen.getByRole('button', { name: 'Zoom out' }).click());
    act(() => screen.getByRole('button', { name: 'Zoom out' }).click());
    expect(usePlayView.getState().cameras[CAMERA_KEY].cellPx).toBeCloseTo(before * 0.8);
    act(() => screen.getByRole('button', { name: 'Fit the map' }).click());
    expect(usePlayView.getState().cameras[CAMERA_KEY].cellPx).toBeCloseTo(before);
    act(() => usePlayView.getState().setCamera(CAMERA_KEY, { cellPx: 60, cx: 14, cy: 10 }));
    act(() => screen.getByRole('button', { name: 'Centre on you' }).click());
    // A short flight, committed once when it lands.
    await waitFor(() => expect(usePlayView.getState().cameras[CAMERA_KEY].cx).toBeLessThan(14));
    expect(usePlayView.getState().cameras[CAMERA_KEY].cellPx).toBe(60);
  });

  it('recentres at once under reduced motion', () => {
    setMatchMedia((q) => DESKTOP(q) || q.includes('prefers-reduced-motion: reduce'));
    renderMap();
    act(() => usePlayView.getState().setCamera(CAMERA_KEY, { cellPx: 60, cx: 14, cy: 10 }));
    act(() => screen.getByRole('button', { name: 'Centre on you' }).click());
    expect(usePlayView.getState().cameras[CAMERA_KEY].cx).toBeLessThan(14);
  });

  it('brings a creature into view when the tracker’s "Show on map" sets the cursor, even twice in a row', () => {
    renderMap();
    act(() => usePlayView.getState().setCamera(CAMERA_KEY, { cellPx: 60, cx: 3, cy: 3 }));
    act(() => usePlayView.getState().setCursor({ x: 7, y: 9 })); // the Dock Ogre
    const shown = usePlayView.getState().cameras[CAMERA_KEY];
    expect(shown.cx).toBeGreaterThan(3);
    act(() => usePlayView.getState().setCamera(CAMERA_KEY, { cellPx: 60, cx: 3, cy: 3 }));
    act(() => usePlayView.getState().setCursor({ x: 7, y: 9 }));
    expect(usePlayView.getState().cameras[CAMERA_KEY].cx).toBeGreaterThan(3);
  });

  it('draws the keyboard cursor only for keyboard users (a click focuses the map without one)', () => {
    renderMap();
    const app = screen.getByRole('application');
    act(() => {
      fireEvent.pointerDown(app, { pointerId: 7, pointerType: 'mouse', button: 0 });
    });
    expect(app).not.toHaveAttribute('data-keyboard');
    act(() => {
      fireEvent.keyDown(app, { key: 'ArrowRight' });
    });
    expect(app).toHaveAttribute('data-keyboard', 'true');
    expect(app.querySelector('[data-map-layer="cursor"]')).not.toBeNull();
    act(() => {
      fireEvent.pointerDown(svg(), { pointerId: 8, pointerType: 'mouse', button: 0, ...at(3, 7) });
      fireEvent.pointerUp(svg(), { pointerId: 8, pointerType: 'mouse', button: 0, ...at(3, 7) });
    });
    expect(app).not.toHaveAttribute('data-keyboard');
  });
});
