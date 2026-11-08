/**
 * Battle-map camera maths (pure, no DOM). World units: CELL per 5-ft square, origin at the map's top-left corner.
 * A world point w is drawn at w × k + (x, y) CSS px from the viewport's top-left: one `<g transform>` is the camera.
 *
 * The committed camera (usePlayView.cameras[mapId], a MapCamera) is resolution-independent: the square size in px
 * and the view's centre in squares (cx = 7.5 is the middle of column H). It survives a viewport resize, the Combat
 * tab unmounting and the 1024px remount; the live camera is rebuilt from it for whatever size the viewport has.
 */
import type { GridPoint, GridRect } from '@/types';
import type { MapCamera } from '../playView';

/** World units per square (keeps font sizes well above 1 unit). */
export const CELL = 100;
/** Zoom range, px per square (spec §7.5). */
export const MIN_CELL_PX = 8;
export const MAX_CELL_PX = 120;
/** The default camera fits the whole map when its squares come out at least this big… */
export const FIT_MIN_CELL_PX = 24;
/** …but never draws them bigger than this (a 4×4 room shouldn't fill the screen with 150px squares). */
export const FIT_MAX_CELL_PX = 64;
/** Otherwise it centres on the hero at these sizes. */
export const PHONE_CELL_PX = 44;
export const DESKTOP_CELL_PX = 36;
/** A tap on squares smaller than this zooms in to TAP_ZOOM_CELL_PX instead of acting (spec §7.4). */
export const TAP_MIN_CELL_PX = 24;
export const TAP_ZOOM_CELL_PX = 44;
/** At least this much of the map stays on screen however far it is panned. */
const KEEP_PX = 96;
/** The pinned rulers: row numbers down the left, column letters along the top (px). */
export const RULER_LEFT = 22;
export const RULER_TOP = 16;

/** Screen = world × k + (x, y). */
export interface Camera {
  k: number;
  x: number;
  y: number;
}

export interface ViewSize {
  width: number;
  height: number;
}

/** The map's size in squares. */
export interface MapExtent {
  cols: number;
  rows: number;
}

export interface Pt {
  x: number;
  y: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function clampCellPx(px: number): number {
  return Number.isFinite(px) ? clamp(px, MIN_CELL_PX, MAX_CELL_PX) : DESKTOP_CELL_PX;
}

/** Square size on screen. */
export function cellPxOf(cam: Camera): number {
  return cam.k * CELL;
}

/** The live camera for a committed one, in a viewport of this size. */
export function liveCamera(cam: MapCamera, view: ViewSize): Camera {
  const k = clampCellPx(cam.cellPx) / CELL;
  return { k, x: view.width / 2 - cam.cx * CELL * k, y: view.height / 2 - cam.cy * CELL * k };
}

/** The committed form of a live camera: square size and the view's centre in squares. */
export function committedCamera(cam: Camera, view: ViewSize): MapCamera {
  const px = cellPxOf(cam);
  return { cellPx: px, cx: (view.width / 2 - cam.x) / px, cy: (view.height / 2 - cam.y) / px };
}

/** The largest square size that shows the whole map beside the rulers, with `pad` px around it. */
export function fitCellPx(map: MapExtent, view: ViewSize, pad = 8): number {
  if (view.width <= 0 || view.height <= 0) return 0;
  return Math.min((view.width - RULER_LEFT - 2 * pad) / map.cols, (view.height - RULER_TOP - 2 * pad) / map.rows);
}

/**
 * Keep the map filling the view beside the rulers when it is bigger than the view (no empty floor on one side),
 * or centred in it when it is smaller. Used for cameras the app chooses (the opening view, fit, recentring); the
 * player's own panning only keeps 96px on screen.
 */
export function fillCamera(cam: MapCamera, map: MapExtent, view: ViewSize): MapCamera {
  if (view.width <= 0 || view.height <= 0) return cam;
  const px = clampCellPx(cam.cellPx);
  const axis = (c: number, squares: number, size: number, gutter: number) => {
    const lo = (size / 2 - gutter) / px;
    const hi = squares - size / 2 / px;
    return lo > hi ? squares / 2 - gutter / (2 * px) : clamp(c, lo, hi);
  };
  const cx = axis(cam.cx, map.cols, view.width, RULER_LEFT);
  const cy = axis(cam.cy, map.rows, view.height, RULER_TOP);
  return cx === cam.cx && cy === cam.cy && px === cam.cellPx ? cam : { cellPx: px, cx, cy };
}

export function rectCentre(r: GridRect): Pt {
  return { x: (r.x0 + r.x1 + 1) / 2, y: (r.y0 + r.y1 + 1) / 2 };
}

/**
 * The camera a map opens with (spec §7.5): the whole map when its squares come out at least 24px, otherwise
 * centred on the hero at 44px (phones) or 36px (desktop).
 */
export function defaultCamera(map: MapExtent, view: ViewSize, hero: GridRect | null, compact: boolean): MapCamera {
  const fit = fitCellPx(map, view);
  if (fit >= FIT_MIN_CELL_PX || !hero) return fitCamera(map, view);
  const c = rectCentre(hero);
  return fillCamera({ cellPx: compact ? PHONE_CELL_PX : DESKTOP_CELL_PX, cx: c.x, cy: c.y }, map, view);
}

/** The whole map, centred beside the rulers (squares no bigger than FIT_MAX_CELL_PX). */
export function fitCamera(map: MapExtent, view: ViewSize): MapCamera {
  const px = clamp(fitCellPx(map, view) || DESKTOP_CELL_PX, MIN_CELL_PX, FIT_MAX_CELL_PX);
  return fillCamera({ cellPx: px, cx: map.cols / 2, cy: map.rows / 2 }, map, view);
}

/** Zoom by `factor` keeping the screen point (px, py) still. */
export function zoomAt(cam: Camera, factor: number, px: number, py: number): Camera {
  const k = clampCellPx(cam.k * factor * CELL) / CELL;
  const f = k / cam.k;
  return { k, x: px - (px - cam.x) * f, y: py - (py - cam.y) * f };
}

export function panBy(cam: Camera, dx: number, dy: number): Camera {
  return { k: cam.k, x: cam.x + dx, y: cam.y + dy };
}

/** Keep at least 96px of the map on screen on every side, so the map can't be lost off-screen. */
export function clampCamera(cam: Camera, map: MapExtent, view: ViewSize, keep = KEEP_PX): Camera {
  const w = map.cols * CELL * cam.k;
  const h = map.rows * CELL * cam.k;
  const kx = Math.min(keep, w, view.width);
  const ky = Math.min(keep, h, view.height);
  return { k: cam.k, x: clamp(cam.x, kx - w, view.width - kx), y: clamp(cam.y, ky - h, view.height - ky) };
}

export function clampMapCamera(cam: MapCamera, map: MapExtent, view: ViewSize): MapCamera {
  if (view.width <= 0 || view.height <= 0) return cam;
  const live = liveCamera(cam, view);
  const clamped = clampCamera(live, map, view);
  return clamped.x === live.x && clamped.y === live.y && live.k * CELL === cam.cellPx ? cam : committedCamera(clamped, view);
}

export function screenToWorld(cam: Camera, sx: number, sy: number): Pt {
  return { x: (sx - cam.x) / cam.k, y: (sy - cam.y) / cam.k };
}

export function worldToScreen(cam: Camera, wx: number, wy: number): Pt {
  return { x: wx * cam.k + cam.x, y: wy * cam.k + cam.y };
}

/** The square under a screen point, or null off the map. */
export function screenToSquare(cam: Camera, sx: number, sy: number, map: MapExtent): GridPoint | null {
  const w = screenToWorld(cam, sx, sy);
  const x = Math.floor(w.x / CELL);
  const y = Math.floor(w.y / CELL);
  return x >= 0 && y >= 0 && x < map.cols && y < map.rows ? { x, y } : null;
}

/** The grid corner nearest a screen point (corner coordinates 0…cols × 0…rows). */
export function screenToCorner(cam: Camera, sx: number, sy: number, map: MapExtent): { x: number; y: number } {
  const w = screenToWorld(cam, sx, sy);
  return { x: clamp(Math.round(w.x / CELL), 0, map.cols), y: clamp(Math.round(w.y / CELL), 0, map.rows) };
}

/** Is the whole rect on screen, clear of the rulers and `margin` px in from the edges? */
export function rectOnScreen(cam: Camera, view: ViewSize, r: GridRect, margin = 8): boolean {
  const a = worldToScreen(cam, r.x0 * CELL, r.y0 * CELL);
  const b = worldToScreen(cam, (r.x1 + 1) * CELL, (r.y1 + 1) * CELL);
  return a.x >= RULER_LEFT + margin && a.y >= RULER_TOP + margin && b.x <= view.width - margin && b.y <= view.height - margin;
}

/** The same camera when `r` is already on screen (clear of the rulers); otherwise one centred on it (same zoom). */
export function revealRect(cam: MapCamera, view: ViewSize, map: MapExtent, r: GridRect, margin = 8): MapCamera {
  if (view.width <= 0 || view.height <= 0) return cam;
  if (rectOnScreen(liveCamera(cam, view), view, r, margin)) return cam;
  const c = rectCentre(r);
  return fillCamera({ cellPx: cam.cellPx, cx: c.x, cy: c.y }, map, view);
}

/** Zoom by `factor` about the view's centre (the zoom buttons and keys). */
export function zoomCentre(cam: MapCamera, factor: number): MapCamera {
  return { ...cam, cellPx: clampCellPx(cam.cellPx * factor) };
}

/** Zoom toward a screen point until squares are `cellPx` (a tap on squares too small to hit). */
export function zoomTo(cam: Camera, cellPx: number, px: number, py: number): Camera {
  return zoomAt(cam, clampCellPx(cellPx) / cellPxOf(cam), px, py);
}

/** Two fingers: zoom about the starting midpoint, then follow the midpoint (pan and zoom at once). */
export function pinchCamera(start: Camera, from: readonly [Pt, Pt], to: readonly [Pt, Pt]): Camera {
  const d0 = Math.hypot(from[1].x - from[0].x, from[1].y - from[0].y) || 1;
  const d1 = Math.hypot(to[1].x - to[0].x, to[1].y - to[0].y) || 1;
  const m0 = { x: (from[0].x + from[1].x) / 2, y: (from[0].y + from[1].y) / 2 };
  const m1 = { x: (to[0].x + to[1].x) / 2, y: (to[0].y + to[1].y) / 2 };
  return panBy(zoomAt(start, d1 / d0, m0.x, m0.y), m1.x - m0.x, m1.y - m0.y);
}

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** A plain wheel pans (Shift: sideways); Ctrl/⌘ + wheel zooms — a trackpad pinch arrives as a ctrlKey wheel. */
export function wheelCamera(cam: Camera, e: WheelInput, px: number, py: number): Camera {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1; // lines / pages → px
  const dx = e.deltaX * unit;
  const dy = e.deltaY * unit;
  if (e.ctrlKey || e.metaKey) return zoomAt(cam, Math.exp(-dy * 0.01), px, py);
  return e.shiftKey && dx === 0 ? panBy(cam, -dy, 0) : panBy(cam, -dx, -dy);
}

export function cameraTransform(cam: Camera): string {
  return `matrix(${round(cam.k)} 0 0 ${round(cam.k)} ${round(cam.x)} ${round(cam.y)})`;
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Ruler labels every `step` squares, so they never overlap at small zoom. */
export function rulerStep(cellPx: number): number {
  if (cellPx >= 18) return 1;
  if (cellPx >= 10) return 2;
  return 5;
}
