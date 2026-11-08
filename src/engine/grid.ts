/**
 * Battle-map geometry: square labels and parsing, creature footprints, grid distance, compass
 * directions, rectangle algebra and the exact segment test behind line of sight and cover.
 * Pure: no I/O, no React, no clock, no randomness.
 *
 * Squares are 5 ft; x = column (0 = "A"), y = row (0 = "1"); A1 is the top-left (north-west) square,
 * letters run east, numbers run south (app convention C1). Ranges print as "B2:D4", corners as two
 * diagonal squares ("D4/E5").
 */
import type { CompassDirection, CreatureSize, GridPoint, GridRect } from '@/types';

export const SQUARE_FT = 5;

export interface MapDims {
  width: number;
  height: number;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

/** A point in doubled coordinates (integers): a square's centre is (2x+1, 2y+1), a grid corner (2x, 2y). */
export interface HalfPoint {
  x2: number;
  y2: number;
}

// ---------------------------------------------------------------------------
// Labels (app convention C1)
// ---------------------------------------------------------------------------

/** 0 → "A", 25 → "Z", 26 → "AA", 39 → "AN". Negative columns (off the map) print as "?". */
export function columnLabel(x: number): string {
  if (!Number.isInteger(x) || x < 0) return '?';
  let n = x + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** { x: 2, y: 3 } → "C4". */
export function squareLabel(p: GridPoint): string {
  return `${columnLabel(p.x)}${p.y + 1}`;
}

/** "C4" for one square, else "B2:D4". */
export function rectLabel(r: GridRect): string {
  const a = squareLabel({ x: r.x0, y: r.y0 });
  return r.x0 === r.x1 && r.y0 === r.y1 ? a : `${a}:${squareLabel({ x: r.x1, y: r.y1 })}`;
}

/** "B2:D4, F5" (stored order). */
export function rectsLabel(rects: readonly GridRect[]): string {
  return rects.map(rectLabel).join(', ');
}

/**
 * A grid corner (corner coordinates 0..width × 0..height) as two diagonal squares: corner (4, 4) → "D4/E5"
 * (the square to its north-west, then the one to its south-east). A corner on the top or left edge of the map
 * has no square to its north-west; it prints as the corner of the square it belongs to ("A1 north-west corner").
 */
export function cornerLabel(cx: number, cy: number): string {
  if (cx >= 1 && cy >= 1) return `${squareLabel({ x: cx - 1, y: cy - 1 })}/${squareLabel({ x: cx, y: cy })}`;
  const x = Math.max(0, cx >= 1 ? cx - 1 : cx);
  const y = Math.max(0, cy >= 1 ? cy - 1 : cy);
  const ns = cy >= 1 ? 'south' : 'north';
  const ew = cx >= 1 ? 'east' : 'west';
  return `${squareLabel({ x, y })} ${ns}-${ew} corner`;
}

/** A creature's space from its anchor (top-left square): "J3" (Medium) or "J3:K4" (Large). */
export function spaceLabel(anchor: GridPoint, size: CreatureSize): string {
  return rectLabel(footprint(anchor, size));
}

// ---------------------------------------------------------------------------
// Parsing (never a zod regex: the problem names the map's extent)
// ---------------------------------------------------------------------------

/** "columns run A–P and rows 1–12" */
function extentText(dims: MapDims): string {
  return `columns run A–${columnLabel(Math.max(0, dims.width - 1))} and rows 1–${Math.max(1, dims.height)}`;
}

const MAX_LIST_PARTS = 40;

/** Column letters → index ("A" → 0, "AA" → 26); anything past ZZZ is simply "far off the map". */
function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
    if (n > 100_000) return 100_000;
  }
  return n - 1;
}

/** Upper case, no whitespace: " c 4 " → "C4". */
function squeeze(text: string): string {
  return text.replace(/\s+/g, '').toUpperCase();
}

/** One squeezed token ("C4") → a square on the map, or a sentence naming the extent. */
function parseToken(token: string, dims: MapDims): Parsed<GridPoint> {
  if (!token) return { ok: false, problem: `A square is missing: write one like "C4" (${extentText(dims)}).` };
  const match = /^([A-Z]+)(\d+)$/.exec(token);
  if (!match) {
    return {
      ok: false,
      problem: `"${token}" isn't a square: write a column letter and a row number, like "C4" (${extentText(dims)}).`,
    };
  }
  const x = columnIndex(match[1]);
  const row = Number(match[2]);
  if (x >= dims.width || row < 1 || row > dims.height) {
    return { ok: false, problem: `"${token}" is off the map: ${extentText(dims)}.` };
  }
  return { ok: true, value: { x, y: row - 1 } };
}

/**
 * One square. Case-insensitive and whitespace-tolerant (" c 4 " → C4). A row number of 0, a column past
 * the map or a malformed token gives a complete sentence naming the map's extent, e.g.
 * `"Q13" is off the map: columns run A–P and rows 1–12.` (never a zod regex: its error would hide the extent).
 */
export function parseSquare(text: string, dims: MapDims): Parsed<GridPoint> {
  return parseToken(squeeze(typeof text === 'string' ? text : ''), dims);
}

/** "A1 to C3", "A1-C3", "A1–C3", "A1—C3" → "A1:C3" (before whitespace is squeezed out). */
function unifyRangeSeparators(part: string): string {
  return part
    .replace(/\s+to\s+/gi, ':')
    .replace(/(\d)\s*to\s*(?=[a-z])/gi, '$1:')
    .replace(/[-–—]/g, ':');
}

/**
 * Squares and ranges: "A1:P1, F5" (≤ 40 parts). Range separators `:`, `-`, `–`, `—` and ` to `; list
 * separators `,` and `;`. Reversed ranges are normalised ("P1:A1" = A1:P1). Problems as parseSquare.
 * Empty parts (a trailing comma) are ignored.
 */
export function parseSquareList(text: string, dims: MapDims): Parsed<GridRect[]> {
  const parts = (typeof text === 'string' ? text : '')
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    return { ok: false, problem: `No squares given: write squares or ranges like "F5" or "A1:P1" (${extentText(dims)}).` };
  }
  if (parts.length > MAX_LIST_PARTS) {
    return {
      ok: false,
      problem: `Too many squares and ranges (${parts.length}): give at most ${MAX_LIST_PARTS}, joining neighbours into ranges like "A1:P1".`,
    };
  }
  const rects: GridRect[] = [];
  for (const part of parts) {
    const ends = squeeze(unifyRangeSeparators(part)).split(':');
    if (ends.length > 2) {
      return {
        ok: false,
        problem: `"${squeeze(part)}" isn't a square or a range: write "F5" or "B2:D4" (${extentText(dims)}).`,
      };
    }
    const a = parseToken(ends[0], dims);
    if (!a.ok) return a;
    const b = ends.length === 2 ? parseToken(ends[1], dims) : a;
    if (!b.ok) return b;
    rects.push({
      x0: Math.min(a.value.x, b.value.x),
      y0: Math.min(a.value.y, b.value.y),
      x1: Math.max(a.value.x, b.value.x),
      y1: Math.max(a.value.y, b.value.y),
    });
  }
  return { ok: true, value: rects };
}

/** A grid corner written as two diagonal neighbours: "D4/E5", "E5/D4" or "E4/D5" → { x: 4, y: 4 }. "D4/D6" is a problem. */
export function parseCorner(text: string, dims: MapDims): Parsed<{ x: number; y: number }> {
  const raw = squeeze(typeof text === 'string' ? text : '');
  const halves = raw.split(/[/\\]/);
  if (halves.length !== 2) {
    return {
      ok: false,
      problem: `"${raw}" isn't a grid corner: write the two squares that touch it diagonally, like "D4/E5".`,
    };
  }
  const a = parseToken(halves[0], dims);
  if (!a.ok) return a;
  const b = parseToken(halves[1], dims);
  if (!b.ok) return b;
  if (Math.abs(a.value.x - b.value.x) !== 1 || Math.abs(a.value.y - b.value.y) !== 1) {
    return {
      ok: false,
      problem: `"${raw}" isn't a grid corner: ${halves[0]} and ${halves[1]} don't touch diagonally. Write two diagonal neighbours, like "D4/E5".`,
    };
  }
  return { ok: true, value: { x: Math.max(a.value.x, b.value.x), y: Math.max(a.value.y, b.value.y) } };
}

const DIRECTION_WORDS: Readonly<Record<string, CompassDirection>> = {
  n: 'north',
  north: 'north',
  ne: 'north-east',
  northeast: 'north-east',
  e: 'east',
  east: 'east',
  se: 'south-east',
  southeast: 'south-east',
  s: 'south',
  south: 'south',
  sw: 'south-west',
  southwest: 'south-west',
  w: 'west',
  west: 'west',
  nw: 'north-west',
  northwest: 'north-west',
};

/** "NE", "northeast", "north-east", "north east" → 'north-east'; null when it isn't a compass direction. */
export function parseDirection(text: string): CompassDirection | null {
  const key = (typeof text === 'string' ? text : '').toLowerCase().replace(/[\s_-]+/g, '');
  return Object.hasOwn(DIRECTION_WORDS, key) ? DIRECTION_WORDS[key] : null;
}

// ---------------------------------------------------------------------------
// Footprints and rects (srd:rule:combat-movement-and-position-creature-size)
// ---------------------------------------------------------------------------

/** Squares per side of a creature's space: Tiny/Small/Medium 1, Large 2, Huge 3, Gargantuan 4. */
export function sizeSquares(size: CreatureSize): 1 | 2 | 3 | 4 {
  switch (size) {
    case 'Large':
      return 2;
    case 'Huge':
      return 3;
    case 'Gargantuan':
      return 4;
    default:
      return 1;
  }
}

/** The space of a creature whose top-left square is `anchor`: footprint({ x: 2, y: 4 }, 'Large') = C5:D6. */
export function footprint(anchor: GridPoint, size: CreatureSize): GridRect {
  const n = sizeSquares(size);
  return { x0: anchor.x, y0: anchor.y, x1: anchor.x + n - 1, y1: anchor.y + n - 1 };
}

export function rectInBounds(r: GridRect, dims: MapDims): boolean {
  return r.x0 >= 0 && r.y0 >= 0 && r.x1 < dims.width && r.y1 < dims.height && r.x0 <= r.x1 && r.y0 <= r.y1;
}

export function rectsContain(rects: readonly GridRect[], p: GridPoint): boolean {
  return rects.some((r) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1);
}

/**
 * The grid count between two rects along each axis (the gapX / gapY of the distance formula):
 * max(0, b.x0 − a.x1, a.x0 − b.x1). 0 when they overlap on that axis, 1 when they are next to each other.
 */
export function rectGap(a: GridRect, b: GridRect): { x: number; y: number } {
  return {
    x: Math.max(0, b.x0 - a.x1, a.x0 - b.x1),
    y: Math.max(0, b.y0 - a.y1, a.y0 - b.y1),
  };
}

/** Do two rects share a square? */
export function rectsOverlap(a: GridRect, b: GridRect): boolean {
  return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
}

/** `r` clipped to the map, or null when nothing of it is on the map. */
export function clipRect(r: GridRect, dims: MapDims): GridRect | null {
  const x0 = Math.max(0, Math.min(r.x0, r.x1));
  const y0 = Math.max(0, Math.min(r.y0, r.y1));
  const x1 = Math.min(dims.width - 1, Math.max(r.x0, r.x1));
  const y1 = Math.min(dims.height - 1, Math.max(r.y0, r.y1));
  return x0 <= x1 && y0 <= y1 ? { x0, y0, x1, y1 } : null;
}

/** Every square of a rect, row-major. */
export function rectSquares(r: GridRect): GridPoint[] {
  const out: GridPoint[] = [];
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) out.push({ x, y });
  return out;
}

/** A creature's space in 3D: it fills a cube of its space's side, from `elevationFt` up (app convention C3). */
export interface Space {
  rect: GridRect;
  elevationFt: number;
  size: CreatureSize;
}

/** The 5-ft levels a space fills: lo = elevationFt / 5 (rounded down), hi = lo + side − 1 (C3). */
function levels(s: Space): { lo: number; hi: number } {
  const lo = Math.floor((Number.isFinite(s.elevationFt) ? s.elevationFt : 0) / SQUARE_FT);
  return { lo, hi: lo + sizeSquares(s.size) - 1 };
}

/**
 * SRD Playing on a Grid (Ranges) + C3: 5 × max(gapX, gapY, gapZ), where gapX = max(0, b.x0 − a.x1, a.x0 − b.x1)
 * (gapY likewise) and gapZ compares 5-ft levels (lo = elevationFt / 5, hi = lo + sizeSquares − 1).
 * "Within N ft" always means `≤ N`. Walls don't lengthen distance (C2).
 */
export function spaceDistanceFt(a: Space, b: Space): number {
  const g = rectGap(a.rect, b.rect);
  const za = levels(a);
  const zb = levels(b);
  const gz = Math.max(0, zb.lo - za.hi, za.lo - zb.hi);
  return SQUARE_FT * Math.max(g.x, g.y, gz);
}

// ---------------------------------------------------------------------------
// Directions (app convention C17)
// ---------------------------------------------------------------------------

/** tan(22.5°): the boundary between an orthogonal and a diagonal direction. */
const TAN_22_5 = Math.SQRT2 - 1;

/**
 * The nearest of the 8 compass directions to (dx, dy) (y grows south); exact 22.5° ties go to the orthogonal.
 * A zero vector has no direction; it gives 'north'.
 */
export function snapDirection(dx: number, dy: number): CompassDirection {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax === 0 && ay === 0) return 'north';
  if (ay <= ax * TAN_22_5) return dx > 0 ? 'east' : 'west';
  if (ax <= ay * TAN_22_5) return dy > 0 ? 'south' : 'north';
  if (dy < 0) return dx > 0 ? 'north-east' : 'north-west';
  return dx > 0 ? 'south-east' : 'south-west';
}

const DIR_VECTORS: Readonly<Record<CompassDirection, { dx: -1 | 0 | 1; dy: -1 | 0 | 1 }>> = {
  north: { dx: 0, dy: -1 },
  'north-east': { dx: 1, dy: -1 },
  east: { dx: 1, dy: 0 },
  'south-east': { dx: 1, dy: 1 },
  south: { dx: 0, dy: 1 },
  'south-west': { dx: -1, dy: 1 },
  west: { dx: -1, dy: 0 },
  'north-west': { dx: -1, dy: -1 },
};

/** One square's step in direction `d` (y grows south): 'north-east' → { dx: 1, dy: -1 }. */
export function dirVector(d: CompassDirection): { dx: -1 | 0 | 1; dy: -1 | 0 | 1 } {
  return DIR_VECTORS[d];
}

// ---------------------------------------------------------------------------
// Rect algebra
// ---------------------------------------------------------------------------

/** Squares → rects: row runs, then merged vertically; deterministic (row-major). Duplicates are ignored. */
export function mergeSquares(points: readonly GridPoint[]): GridRect[] {
  const sorted = [...points].sort((a, b) => a.y - b.y || a.x - b.x);
  // Row runs.
  const runs: GridRect[] = [];
  for (const p of sorted) {
    const last = runs[runs.length - 1];
    if (last && last.y0 === p.y && p.x <= last.x1 + 1) {
      if (p.x > last.x1) last.x1 = p.x;
      continue;
    }
    runs.push({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  }
  // Merge runs with the same columns on consecutive rows.
  const open = new Map<string, GridRect>();
  const out: GridRect[] = [];
  for (const run of runs) {
    const key = `${run.x0},${run.x1}`;
    const above = open.get(key);
    if (above && above.y1 === run.y0 - 1) {
      above.y1 = run.y0;
      continue;
    }
    const rect = { ...run };
    open.set(key, rect);
    out.push(rect);
  }
  return out.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

/** `rects` minus `cut`: subtractRect([B2:D4], C3) = [B2:D2, B3, D3, B4:D4] (top, left, right, bottom per rect). */
export function subtractRect(rects: readonly GridRect[], cut: GridRect): GridRect[] {
  const out: GridRect[] = [];
  for (const r of rects) {
    if (!rectsOverlap(r, cut)) {
      out.push({ ...r });
      continue;
    }
    if (cut.y0 > r.y0) out.push({ x0: r.x0, y0: r.y0, x1: r.x1, y1: cut.y0 - 1 });
    const my0 = Math.max(r.y0, cut.y0);
    const my1 = Math.min(r.y1, cut.y1);
    if (cut.x0 > r.x0) out.push({ x0: r.x0, y0: my0, x1: cut.x0 - 1, y1: my1 });
    if (cut.x1 < r.x1) out.push({ x0: cut.x1 + 1, y0: my0, x1: r.x1, y1: my1 });
    if (cut.y1 < r.y1) out.push({ x0: r.x0, y0: cut.y1 + 1, x1: r.x1, y1: r.y1 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The exact segment test (app convention C20)
// ---------------------------------------------------------------------------

/** A square's centre in doubled coordinates. */
export function squareCentreHalf(p: GridPoint): HalfPoint {
  return { x2: 2 * p.x + 1, y2: 2 * p.y + 1 };
}

/**
 * The sample points of a space for sight and cover (C20): every corner of every square of it, then every square
 * centre (row-major), in doubled coordinates. A corner wedged between two blocking squares outside the space that
 * meet diagonally at it is left out, so a creature standing at a crack can't see through it.
 * With `corners: false` only the centres are returned; with `centres: false` only the corners.
 */
export function spaceSamplePoints(
  rect: GridRect,
  blocks: (x: number, y: number) => boolean,
  opts: { corners?: boolean; centres?: boolean } = {},
): HalfPoint[] {
  const own = (x: number, y: number) => x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1;
  const out: HalfPoint[] = [];
  if (opts.corners !== false) {
    for (let y = rect.y0; y <= rect.y1 + 1; y++) {
      for (let x = rect.x0; x <= rect.x1 + 1; x++) {
        const nwOut = !own(x - 1, y - 1);
        const neOut = !own(x, y - 1);
        const swOut = !own(x - 1, y);
        const seOut = !own(x, y);
        const wedged =
          (neOut && swOut && blocks(x, y - 1) && blocks(x - 1, y)) ||
          (nwOut && seOut && blocks(x - 1, y - 1) && blocks(x, y));
        if (!wedged) out.push({ x2: 2 * x, y2: 2 * y });
      }
    }
  }
  if (opts.centres !== false) {
    for (let y = rect.y0; y <= rect.y1; y++) for (let x = rect.x0; x <= rect.x1; x++) out.push({ x2: 2 * x + 1, y2: 2 * y + 1 });
  }
  return out;
}

/**
 * C20: does p→q cross a blocking square's interior, run along a seam between two blockers, or pass a crack?
 * Exact, in doubled integer coordinates: interior midpoints block when their square blocks; seam midpoints
 * only when the squares on both sides block; a grid point strictly inside the segment blocks when one
 * blocking square around it lies strictly left of the segment and another strictly right. `blocks(x, y)`
 * answers for one square; it may be asked about squares just outside the map (answer false there).
 * The endpoints themselves never block (a line that ends on a wall's face or corner is clear).
 */
export function segmentBlocked(p: HalfPoint, q: HalfPoint, blocks: (x: number, y: number) => boolean): boolean {
  return scanSegment(p, q, blocks, null);
}

/**
 * The squares that block p→q under the same test as segmentBlocked, in order along the segment (each once):
 * the interior squares crossed, both squares of a blocked seam, the blockers on both sides of a crack.
 * Empty exactly when segmentBlocked is false.
 */
export function segmentBlockers(p: HalfPoint, q: HalfPoint, blocks: (x: number, y: number) => boolean): GridPoint[] {
  const found: GridPoint[] = [];
  const seen = new Set<string>();
  scanSegment(p, q, blocks, (x, y) => {
    const key = `${x},${y}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ x, y });
  });
  return found;
}

/** Floor division for integers (works for negatives). */
function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** a mod b in [0, b). */
function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

/** The segment test; with `onBlock` it reports every blocker instead of stopping at the first. */
function scanSegment(
  p: HalfPoint,
  q: HalfPoint,
  blocks: (x: number, y: number) => boolean,
  onBlock: ((x: number, y: number) => void) | null,
): boolean {
  const dx = q.x2 - p.x2;
  const dy = q.y2 - p.y2;
  if (dx === 0 && dy === 0) return false;
  let blocked = false;
  // Parameters t = k / L of every grid-line crossing, k integer in [0, L].
  const L = Math.max(1, Math.abs(dx)) * Math.max(1, Math.abs(dy));
  const ks: number[] = [0, L];
  if (dx !== 0) {
    const step = L / dx; // an integer: L is a multiple of |dx|
    const lo = Math.min(p.x2, q.x2);
    const hi = Math.max(p.x2, q.x2);
    for (let g = lo + mod(-lo, 2); g <= hi; g += 2) ks.push((g - p.x2) * step);
  }
  if (dy !== 0) {
    const step = L / dy;
    const lo = Math.min(p.y2, q.y2);
    const hi = Math.max(p.y2, q.y2);
    for (let g = lo + mod(-lo, 2); g <= hi; g += 2) ks.push((g - p.y2) * step);
  }
  ks.sort((a, b) => a - b);

  // Sub-segments between consecutive crossings: test their midpoints (parameter (a + b) / 2L).
  // A point at parameter s / 2L has doubled x = p.x2 + s·dx / 2L, i.e. 2L·x2 = p.x2·2L + s·dx; it lies on a
  // vertical grid line when x2 is even, i.e. when that product is a multiple of 4L; its column is ⌊x2 / 2⌋.
  const L2 = 2 * L;
  const L4 = 4 * L;
  for (let i = 0; i + 1 < ks.length; i++) {
    const a = ks[i];
    const b = ks[i + 1];
    if (a === b) continue;
    const s = a + b;
    const X = p.x2 * L2 + s * dx;
    const Y = p.y2 * L2 + s * dy;
    const onX = mod(X, L4) === 0;
    const onY = mod(Y, L4) === 0;
    const col = floorDiv(X, L4);
    const row = floorDiv(Y, L4);
    let hit: [number, number][] = [];
    if (!onX && !onY) {
      if (blocks(col, row)) hit = [[col, row]];
    } else if (onY && !onX) {
      // Along a horizontal grid line between rows row − 1 and row.
      if (blocks(col, row - 1) && blocks(col, row)) hit = [[col, row - 1], [col, row]];
    } else if (onX && !onY) {
      // Along a vertical grid line between columns col − 1 and col.
      if (blocks(col - 1, row) && blocks(col, row)) hit = [[col - 1, row], [col, row]];
    }
    if (hit.length) {
      if (!onBlock) return true;
      blocked = true;
      for (const [x, y] of hit) onBlock(x, y);
    }
  }

  // Cracks: a grid point strictly inside the segment with blockers strictly on both sides.
  for (let i = 0; i < ks.length; i++) {
    const k = ks[i];
    if (k <= 0 || k >= L || (i > 0 && ks[i - 1] === k)) continue;
    // Doubled coordinates scaled by L: L·x2 = p.x2·L + k·dx; a grid point when x2 and y2 are both even.
    const X = p.x2 * L + k * dx;
    const Y = p.y2 * L + k * dy;
    if (mod(X, L2) !== 0 || mod(Y, L2) !== 0) continue;
    const gx = X / L2;
    const gy = Y / L2;
    const left: [number, number][] = [];
    const right: [number, number][] = [];
    for (let sy = gy - 1; sy <= gy; sy++) {
      for (let sx = gx - 1; sx <= gx; sx++) {
        if (!blocks(sx, sy)) continue;
        // The square's centre relative to the grid point, in doubled units: (±1, ±1).
        const cx = 2 * (sx - gx) + 1;
        const cy = 2 * (sy - gy) + 1;
        const cross = dx * cy - dy * cx;
        if (cross > 0) left.push([sx, sy]);
        else if (cross < 0) right.push([sx, sy]);
      }
    }
    if (left.length && right.length) {
      if (!onBlock) return true;
      blocked = true;
      for (const [x, y] of [...left, ...right]) onBlock(x, y);
    }
  }
  return blocked;
}
