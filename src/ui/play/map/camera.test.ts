import { describe, expect, it } from 'vitest';
import {
  CELL,
  cellPxOf,
  clampCamera,
  clampCellPx,
  committedCamera,
  defaultCamera,
  fillCamera,
  fitCamera,
  fitCellPx,
  liveCamera,
  MAX_CELL_PX,
  MIN_CELL_PX,
  pinchCamera,
  rectOnScreen,
  refitOpening,
  revealRect,
  RULER_LEFT,
  RULER_TOP,
  rulerStep,
  sameCamera,
  screenToCorner,
  screenToSquare,
  wheelCamera,
  worldToScreen,
  zoomAt,
  zoomCentre,
  zoomTo,
  type Camera,
  type MapExtent,
  type ViewSize,
} from './camera';
import type { MapCamera } from '../playView';

const warehouse = { cols: 16, rows: 12 };
const B6 = { x0: 1, y0: 5, x1: 1, y1: 5 };
const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6);

describe('camera (spec §7.5)', () => {
  it('keeps the zoom between 8 and 120 px per square', () => {
    expect(clampCellPx(4)).toBe(MIN_CELL_PX);
    expect(clampCellPx(500)).toBe(MAX_CELL_PX);
    expect(clampCellPx(Number.NaN)).toBe(36);
    expect(cellPxOf(zoomAt({ k: 1, x: 0, y: 0 }, 10, 0, 0))).toBe(120);
    expect(cellPxOf(zoomAt({ k: 0.1, x: 0, y: 0 }, 0.01, 0, 0))).toBe(8);
  });

  it('round-trips a committed camera through any viewport size', () => {
    const committed = { cellPx: 40, cx: 7.5, cy: 3.25 };
    for (const view of [
      { width: 608, height: 290 },
      { width: 366, height: 366 },
    ]) {
      const live = liveCamera(committed, view);
      const back = committedCamera(live, view);
      close(back.cellPx, 40);
      close(back.cx, 7.5);
      close(back.cy, 3.25);
      // The committed centre is the middle of the view.
      const centre = worldToScreen(live, 7.5 * CELL, 3.25 * CELL);
      close(centre.x, view.width / 2);
      close(centre.y, view.height / 2);
    }
  });

  it('opens on the whole map when its squares come out at least 24px, else on the hero (44px phone, 36px desktop)', () => {
    // Desktop dock, 608 × 290: the 16×12 warehouse fits at ≈ 22px, under 24: centred on the hero.
    const desk = defaultCamera(warehouse, { width: 608, height: 290 }, B6, false);
    expect(desk.cellPx).toBe(36);
    // Phone, 366 × 366: centred on the hero at 44px.
    expect(defaultCamera(warehouse, { width: 366, height: 366 }, B6, true).cellPx).toBe(44);
    // A big viewport fits the whole map (squares ≥ 24px), centred, never larger than 64px.
    const big = defaultCamera(warehouse, { width: 1200, height: 900 }, B6, false);
    expect(big.cellPx).toBeGreaterThanOrEqual(24);
    expect(big.cellPx).toBeLessThanOrEqual(64);
    // A 10×8 map in the dock fits (squares ≥ 24px).
    expect(defaultCamera({ cols: 10, rows: 8 }, { width: 608, height: 336 }, B6, false).cellPx).toBeGreaterThanOrEqual(24);
  });

  it('keeps the map filling the view when it is bigger than the view (no empty floor beside it)', () => {
    const view = { width: 366, height: 366 };
    // Centring on A1 would show empty space up and left: it is pushed back to the edge beside the rulers.
    const cam = fillCamera({ cellPx: 44, cx: 0.5, cy: 0.5 }, warehouse, view);
    const live = liveCamera(cam, view);
    const topLeft = worldToScreen(live, 0, 0);
    close(topLeft.x, 22); // RULER_LEFT
    close(topLeft.y, 16); // RULER_TOP
  });

  it('fits the map beside the rulers with padding', () => {
    expect(fitCellPx(warehouse, { width: 0, height: 0 })).toBe(0);
    expect(fitCellPx({ cols: 10, rows: 10 }, { width: 438, height: 432 })).toBe(40);
  });

  it('zooms about a point and keeps that point still', () => {
    const cam: Camera = { k: 0.4, x: 30, y: 20 };
    const before = { x: (200 - cam.x) / cam.k, y: (150 - cam.y) / cam.k };
    const next = zoomAt(cam, 1.5, 200, 150);
    const after = worldToScreen(next, before.x, before.y);
    close(after.x, 200);
    close(after.y, 150);
    // A tap on squares under 24px zooms toward the tap to 44px.
    expect(cellPxOf(zoomTo({ k: 0.12, x: 0, y: 0 }, 44, 100, 100))).toBeCloseTo(44);
    expect(zoomCentre({ cellPx: 40, cx: 3, cy: 4 }, 1.25)).toEqual({ cellPx: 50, cx: 3, cy: 4 });
  });

  it('never lets the map be panned off screen (96px stay visible)', () => {
    const view = { width: 400, height: 300 };
    const lost = clampCamera({ k: 0.4, x: 5000, y: -5000 }, warehouse, view);
    expect(lost.x).toBe(400 - 96);
    expect(lost.y).toBe(96 - 12 * CELL * 0.4);
  });

  it('maps screen points to squares and corners, and nothing off the map', () => {
    const cam: Camera = { k: 0.4, x: 22, y: 16 }; // 40px squares beside the rulers
    expect(screenToSquare(cam, 22 + 40 * 3 + 5, 16 + 40 * 7 + 5, warehouse)).toEqual({ x: 3, y: 7 }); // D8
    expect(screenToSquare(cam, 5, 5, warehouse)).toBeNull();
    expect(screenToSquare(cam, 22 + 40 * 16 + 1, 30, warehouse)).toBeNull();
    expect(screenToCorner(cam, 22 + 40 * 4 - 3, 16 + 40 * 4 + 6, warehouse)).toEqual({ x: 4, y: 4 }); // D4/E5
  });

  it('reveals a square only when it is off screen (or under the rulers)', () => {
    const view = { width: 400, height: 300 };
    const cam = { cellPx: 40, cx: 5, cy: 3.75 };
    const onScreen = { x0: 4, y0: 3, x1: 4, y1: 3 };
    expect(rectOnScreen(liveCamera(cam, view), view, onScreen)).toBe(true);
    expect(revealRect(cam, view, warehouse, onScreen)).toBe(cam);
    const far = { x0: 14, y0: 11, x1: 14, y1: 11 }; // O12, in the bottom row
    const moved = revealRect(cam, view, warehouse, far);
    expect(moved).not.toBe(cam);
    // Flush with the map's bottom edge, which stays at the view's edge (no empty floor below it).
    expect(rectOnScreen(liveCamera(moved, view), view, far, 0)).toBe(true);
    expect(moved.cellPx).toBe(40);
    // Already as far as it can go: the same camera, so nothing is written.
    expect(revealRect(moved, view, warehouse, far)).toBe(moved);
  });

  it('pans with a plain wheel and zooms with Ctrl/⌘ + wheel (a trackpad pinch)', () => {
    const cam: Camera = { k: 0.4, x: 0, y: 0 };
    const wheel = { deltaX: 0, deltaY: 30, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false };
    expect(wheelCamera(cam, wheel, 100, 100)).toEqual({ k: 0.4, x: 0, y: -30 });
    expect(wheelCamera(cam, { ...wheel, shiftKey: true }, 100, 100)).toEqual({ k: 0.4, x: -30, y: 0 });
    expect(wheelCamera(cam, { ...wheel, deltaMode: 1, deltaY: 2 }, 100, 100)).toEqual({ k: 0.4, x: 0, y: -32 });
    expect(wheelCamera(cam, { ...wheel, ctrlKey: true }, 100, 100).k).toBeLessThan(0.4);
    expect(wheelCamera(cam, { ...wheel, metaKey: true, deltaY: -30 }, 100, 100).k).toBeGreaterThan(0.4);
  });

  it('pinches about the midpoint and follows it', () => {
    const start: Camera = { k: 0.4, x: 0, y: 0 };
    const spread = pinchCamera(start, [{ x: 100, y: 100 }, { x: 200, y: 100 }], [{ x: 50, y: 100 }, { x: 250, y: 100 }]);
    close(spread.k, 0.8);
    // The world point under the midpoint (150, 100) stays under it.
    const world = { x: 150 / 0.4, y: 100 / 0.4 };
    const p = worldToScreen(spread, world.x, world.y);
    close(p.x, 150);
    close(p.y, 100);
    // Both fingers sliding right pans by the same amount.
    const slide = pinchCamera(start, [{ x: 100, y: 100 }, { x: 200, y: 100 }], [{ x: 130, y: 100 }, { x: 230, y: 100 }]);
    close(slide.k, 0.4);
    close(slide.x, 30);
  });

  it('thins the rulers at small zoom', () => {
    expect(rulerStep(40)).toBe(1);
    expect(rulerStep(12)).toBe(2);
    expect(rulerStep(8)).toBe(5);
  });
});

/** Where a committed camera draws the map, in view px. */
function mapBox(cam: MapCamera, view: ViewSize, map: MapExtent) {
  const live = liveCamera(cam, view);
  const a = worldToScreen(live, 0, 0);
  const b = worldToScreen(live, map.cols * CELL, map.rows * CELL);
  return { left: a.x, top: a.y, right: b.x, bottom: b.y };
}

describe('E3: the cameras the app chooses keep the map clear of the zoom buttons', () => {
  // The demo DM's 10×8 map, as in the end-to-end flow.
  const lantern = { cols: 10, rows: 8 };
  const D3 = { x0: 3, y0: 2, x1: 3, y1: 2 };

  it('fits the whole map between the rulers and the zoom buttons’ lane (desktop dock and phone)', () => {
    // Desktop dock at 1280×800: a 608 × 232 view, 40px buttons in a 56px lane down the right edge.
    const dock = { width: 608, height: 232, right: 56 };
    const cam = defaultCamera(lantern, dock, D3, false);
    expect(cam.cellPx).toBe(25); // height-bound: (232 − 16 − 16) / 8
    const box = mapBox(cam, dock, lantern);
    expect(box.left).toBeGreaterThanOrEqual(RULER_LEFT);
    expect(box.top).toBeGreaterThanOrEqual(RULER_TOP);
    expect(box.right).toBeLessThanOrEqual(dock.width - dock.right);
    expect(box.bottom).toBeLessThanOrEqual(dock.height);
    // Phone at 390×844: a 390 × 366 view, 48px buttons in a 64px lane. Without the lane the squares would be 35px and
    // columns I and J would sit under the buttons.
    const phone = { width: 390, height: 366, right: 64 };
    expect(fitCellPx(lantern, { width: 390, height: 366 })).toBeCloseTo(35.2);
    const pc = defaultCamera(lantern, phone, D3, true);
    expect(pc.cellPx).toBeCloseTo(28.8); // (390 − 22 − 64 − 16) / 10, still ≥ 24: the whole map
    expect(mapBox(pc, phone, lantern).right).toBeLessThanOrEqual(phone.width - phone.right);
    expect(fitCamera(lantern, phone)).toEqual(pc);
  });

  it('a map wider than the view stops at the lane when the app scrolls it to its east edge', () => {
    const view = { width: 400, height: 300, right: 56 };
    const east = fillCamera({ cellPx: 40, cx: 99, cy: 6 }, warehouse, view);
    close(mapBox(east, view, warehouse).right, view.width - view.right);
    // The west edge is unchanged: beside the row numbers.
    close(mapBox(fillCamera({ cellPx: 40, cx: 0, cy: 6 }, warehouse, view), view, warehouse).left, RULER_LEFT);
  });

  it('a square under the zoom buttons is not on screen: revealing it brings it out from under them', () => {
    const view = { width: 400, height: 300, right: 56 };
    const cam = { cellPx: 40, cx: 5, cy: 3.75 };
    // I4 is drawn at x 320–360: inside the view, but under the lane (344–400).
    const i4 = { x0: 8, y0: 3, x1: 8, y1: 3 };
    expect(rectOnScreen(liveCamera(cam, { width: 400, height: 300 }), { width: 400, height: 300 }, i4)).toBe(true);
    expect(rectOnScreen(liveCamera(cam, view), view, i4)).toBe(false);
    const moved = revealRect(cam, view, warehouse, i4);
    expect(moved.cellPx).toBe(40);
    expect(rectOnScreen(liveCamera(moved, view), view, i4)).toBe(true);
  });
});

describe('E2: the opening camera follows the view’s size until the player moves it', () => {
  const lantern = { cols: 10, rows: 8 };
  const D3 = { x0: 3, y0: 2, x1: 3, y1: 2 };

  it('a fit stays a fit: chosen before the action bar took its height, chosen again for the smaller view', () => {
    const tall = { width: 608, height: 288, right: 56 };
    const short = { width: 608, height: 232, right: 56 };
    const opening = defaultCamera(lantern, tall, D3, false);
    expect(opening.cellPx).toBe(32);
    // Kept as it was, the map would overflow the smaller view (row 8 cut off)…
    expect(mapBox(opening, short, lantern).bottom).toBeGreaterThan(short.height);
    // …chosen again, the whole map is in it.
    const again = refitOpening(opening, lantern, short, false);
    expect(again).toEqual(defaultCamera(lantern, short, D3, false));
    const box = mapBox(again, short, lantern);
    expect(box.top).toBeGreaterThanOrEqual(RULER_TOP);
    expect(box.bottom).toBeLessThanOrEqual(short.height);
  });

  it('a camera on the hero keeps its centre at the opening square size when the map still doesn’t fit', () => {
    const view = { width: 608, height: 232, right: 56 };
    const opening = defaultCamera(warehouse, view, B6, false);
    expect(opening.cellPx).toBe(36);
    const wider = { width: 700, height: 260, right: 56 };
    const again = refitOpening(opening, warehouse, wider, false);
    expect(again.cellPx).toBe(36);
    expect(again).toEqual(fillCamera({ cellPx: 36, cx: opening.cx, cy: opening.cy }, warehouse, wider));
    expect(sameCamera(again, { ...again, cx: again.cx + 0.0001 })).toBe(true);
    expect(sameCamera(again, { ...again, cx: again.cx + 0.01 })).toBe(false);
  });
});
