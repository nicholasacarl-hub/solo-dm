import { describe, expect, it } from 'vitest';
import type { GridPoint, GridRect } from '@/types';
import {
  clipRect,
  columnLabel,
  cornerLabel,
  dirVector,
  footprint,
  mergeSquares,
  parseCorner,
  parseDirection,
  parseSquare,
  parseSquareList,
  rectGap,
  rectInBounds,
  rectLabel,
  rectsContain,
  rectsLabel,
  rectSquares,
  rectsOverlap,
  segmentBlocked,
  sizeSquares,
  snapDirection,
  spaceDistanceFt,
  spaceLabel,
  spaceSamplePoints,
  squareLabel,
  subtractRect,
  type HalfPoint,
  type MapDims,
  type Space,
} from './grid';

const DIMS: MapDims = { width: 16, height: 12 };
const rect = (x0: number, y0: number, x1 = x0, y1 = y0): GridRect => ({ x0, y0, x1, y1 });
/** "B2:D4" → rect (test helper on top of the parser under test). */
const R = (text: string, dims: MapDims = DIMS): GridRect => {
  const parsed = parseSquareList(text, dims);
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.value[0];
};
const space = (r: GridRect, elevationFt = 0, size: Space['size'] = 'Medium'): Space => ({ rect: r, elevationFt, size });
/** Walls as a set of "x,y" keys → a blocks(x, y) predicate. */
const walls = (...squares: string[]) => {
  const keys = new Set<string>();
  for (const s of squares) {
    const r = R(s);
    for (const p of rectSquares(r)) keys.add(`${p.x},${p.y}`);
  }
  return (x: number, y: number) => keys.has(`${x},${y}`);
};
const corner = (x: number, y: number): HalfPoint => ({ x2: 2 * x, y2: 2 * y });
const centre = (p: GridPoint): HalfPoint => ({ x2: 2 * p.x + 1, y2: 2 * p.y + 1 });

describe('labels (app convention C1)', () => {
  it('G1: columnLabel and squareLabel', () => {
    expect([0, 25, 26, 39].map(columnLabel)).toEqual(['A', 'Z', 'AA', 'AN']);
    expect(squareLabel({ x: 2, y: 3 })).toBe('C4');
  });

  it('every column label parses back to its index (A…AN)', () => {
    const dims = { width: 40, height: 40 };
    for (let x = 0; x < 40; x++) {
      const parsed = parseSquare(`${columnLabel(x)}40`, dims);
      expect(parsed).toEqual({ ok: true, value: { x, y: 39 } });
    }
  });

  it('G10: rectLabel, rectsLabel, cornerLabel and spaceLabel', () => {
    expect(rectLabel(rect(2, 3))).toBe('C4');
    expect(rectLabel(rect(1, 1, 3, 3))).toBe('B2:D4');
    expect(rectsLabel([rect(1, 1, 3, 3), rect(5, 4)])).toBe('B2:D4, F5');
    expect(cornerLabel(4, 4)).toBe('D4/E5');
    expect(spaceLabel({ x: 9, y: 2 }, 'Large')).toBe('J3:K4');
    expect(spaceLabel({ x: 9, y: 2 }, 'Medium')).toBe('J3');
  });

  it('a corner on the map edge prints as the corner of its square (app convention)', () => {
    expect(cornerLabel(0, 0)).toBe('A1 north-west corner');
    expect(cornerLabel(3, 0)).toBe('C1 north-east corner');
    expect(cornerLabel(0, 2)).toBe('A2 south-west corner');
  });
});

describe('parsing squares (app convention C1)', () => {
  it('G2: case- and whitespace-tolerant squares; malformed and off-map squares name the extent', () => {
    expect(parseSquare('c4', DIMS)).toEqual({ ok: true, value: { x: 2, y: 3 } });
    expect(parseSquare(' C 4 ', DIMS)).toEqual({ ok: true, value: { x: 2, y: 3 } });
    const bad = parseSquare('4C', DIMS);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problem).toBe('"4C" isn\'t a square: write a column letter and a row number, like "C4" (columns run A–P and rows 1–12).');
    const zero = parseSquare('A0', DIMS);
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.problem).toBe('"A0" is off the map: columns run A–P and rows 1–12.');
    expect(parseSquare('Q13', DIMS)).toEqual({ ok: false, problem: '"Q13" is off the map: columns run A–P and rows 1–12.' });
  });

  it('rejects empty input, a column past the map and absurd columns with a full sentence', () => {
    const empty = parseSquare('  ', DIMS);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.problem).toMatch(/columns run A–P and rows 1–12\)\.$/);
    expect(parseSquare('Q1', DIMS).ok).toBe(false);
    expect(parseSquare('P12', DIMS)).toEqual({ ok: true, value: { x: 15, y: 11 } });
    expect(parseSquare('ZZZZZZ1', DIMS).ok).toBe(false);
    expect(parseSquare('A13', DIMS).ok).toBe(false);
  });

  it('G3: lists and ranges with every separator; reversed ranges are normalised', () => {
    expect(parseSquareList('P1:A1, F5', DIMS)).toEqual({ ok: true, value: [rect(0, 0, 15, 0), rect(5, 4)] });
    for (const text of ['A1-C3', 'A1 to C3', 'A1–C3', 'A1—C3', 'C3:A1', 'a1 TO c3', ' A1 : C3 ']) {
      expect(parseSquareList(text, DIMS)).toEqual({ ok: true, value: [rect(0, 0, 2, 2)] });
    }
    expect(parseSquareList('A1:P1; A2:A12', DIMS)).toEqual({ ok: true, value: [rect(0, 0, 15, 0), rect(0, 1, 0, 11)] });
    expect(parseSquareList('C1:A3', DIMS)).toEqual({ ok: true, value: [rect(0, 0, 2, 2)] });
  });

  it('list problems: off the map, three ends, nothing given, more than 40 parts; a trailing comma is fine', () => {
    const off = parseSquareList('A1:Q1', DIMS);
    expect(off).toEqual({ ok: false, problem: '"Q1" is off the map: columns run A–P and rows 1–12.' });
    expect(parseSquareList('A1:B2:C3', DIMS).ok).toBe(false);
    expect(parseSquareList(' , ', DIMS).ok).toBe(false);
    const many = Array.from({ length: 41 }, () => 'A1').join(', ');
    const tooMany = parseSquareList(many, DIMS);
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.problem).toContain('at most 40');
    expect(parseSquareList(Array.from({ length: 40 }, () => 'A1').join(', '), DIMS).ok).toBe(true);
    expect(parseSquareList('F5,', DIMS)).toEqual({ ok: true, value: [rect(5, 4)] });
  });

  it('G4: corners as two diagonal squares, in any order; anything else is a problem', () => {
    for (const text of ['D4/E5', 'E5/D4', 'E4/D5', 'd5 / e4']) {
      expect(parseCorner(text, DIMS)).toEqual({ ok: true, value: { x: 4, y: 4 } });
    }
    const notDiagonal = parseCorner('D4/D6', DIMS);
    expect(notDiagonal.ok).toBe(false);
    if (!notDiagonal.ok) expect(notDiagonal.problem).toContain("don't touch diagonally");
    expect(parseCorner('D4', DIMS).ok).toBe(false);
    expect(parseCorner('P12/Q13', DIMS)).toEqual({ ok: false, problem: '"Q13" is off the map: columns run A–P and rows 1–12.' });
  });

  it('compass directions in every spelling', () => {
    for (const text of ['NE', 'northeast', 'north-east', 'north east', 'North_East']) expect(parseDirection(text)).toBe('north-east');
    expect(parseDirection('s')).toBe('south');
    expect(parseDirection('W')).toBe('west');
    expect(parseDirection('south west')).toBe('south-west');
    expect(parseDirection('up')).toBeNull();
    expect(parseDirection('')).toBeNull();
    expect(parseDirection('toString')).toBeNull();
  });
});

describe('footprints and distance (SRD 5.2.1 Creature Size; Playing on a Grid)', () => {
  it('G5: sizeSquares and footprint (srd:rule:combat-movement-and-position-creature-size)', () => {
    expect((['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'] as const).map(sizeSquares)).toEqual([1, 1, 1, 2, 3, 4]);
    expect(footprint({ x: 2, y: 4 }, 'Large')).toEqual({ x0: 2, y0: 4, x1: 3, y1: 5 });
    expect(rectLabel(footprint({ x: 2, y: 4 }, 'Large'))).toBe('C5:D6');
  });

  it('G6: spaceDistanceFt counts squares by the shortest route (srd:rule:combat-movement-and-position-playing-on-a-grid, Ranges)', () => {
    expect(spaceDistanceFt(space(R('A1')), space(R('B1')))).toBe(5);
    expect(spaceDistanceFt(space(R('A1')), space(R('B2')))).toBe(5);
    expect(spaceDistanceFt(space(R('A1')), space(R('A1')))).toBe(0);
    expect(spaceDistanceFt(space(R('A1')), space(R('C1:D2'), 0, 'Large'))).toBe(10);
    expect(spaceDistanceFt(space(R('C4')), space(R('F7')))).toBe(15);
    // Symmetric.
    expect(spaceDistanceFt(space(R('F7')), space(R('C4')))).toBe(15);
  });

  it('G7: vertical distance counts 5-ft levels; a creature fills a cube of its side (app convention C3)', () => {
    expect(spaceDistanceFt(space(R('A1')), space(R('B1'), 10))).toBe(10);
    expect(spaceDistanceFt(space(R('A1')), space(R('B1'), 5))).toBe(5);
    // A Large (10-ft-tall) ogre at A1:B2 and a flier 10 ft up in the next square (C1).
    expect(spaceDistanceFt(space(R('A1:B2'), 0, 'Large'), space(R('C1'), 10))).toBe(5);
    expect(spaceDistanceFt(space(R('C1'), 10), space(R('A1:B2'), 0, 'Large'))).toBe(5);
  });

  it('rect helpers: gap, bounds, containment, overlap, clipping, squares', () => {
    expect(rectGap(R('A1'), R('B1'))).toEqual({ x: 1, y: 0 });
    expect(rectGap(R('A1:C3'), R('B2'))).toEqual({ x: 0, y: 0 });
    expect(rectGap(R('F7'), R('C4'))).toEqual({ x: 3, y: 3 });
    expect(rectInBounds(R('O11:P12'), DIMS)).toBe(true);
    expect(rectInBounds({ x0: 15, y0: 11, x1: 16, y1: 12 }, DIMS)).toBe(false);
    expect(rectInBounds({ x0: -1, y0: 0, x1: 0, y1: 0 }, DIMS)).toBe(false);
    expect(rectsContain([R('B2:D4'), R('F5')], { x: 5, y: 4 })).toBe(true);
    expect(rectsContain([R('B2:D4')], { x: 4, y: 1 })).toBe(false);
    expect(rectsOverlap(R('B2:D4'), R('D4:E5'))).toBe(true);
    expect(rectsOverlap(R('B2:D4'), R('E5'))).toBe(false);
    expect(clipRect({ x0: -3, y0: 10, x1: 2, y1: 20 }, DIMS)).toEqual({ x0: 0, y0: 10, x1: 2, y1: 11 });
    expect(clipRect({ x0: 20, y0: 0, x1: 22, y1: 1 }, DIMS)).toBeNull();
    expect(rectSquares(R('B2:C3'))).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
    ]);
  });
});

describe('directions (app convention C17)', () => {
  it('G8: snapDirection picks the nearest of 8; 26.57° is past the 22.5° boundary (by hand)', () => {
    expect(snapDirection(3, 1)).toBe('east');
    expect(snapDirection(2, 1)).toBe('south-east');
    expect(snapDirection(1, 1)).toBe('south-east');
    expect(snapDirection(0, -1)).toBe('north');
    expect(snapDirection(-5, 1)).toBe('west');
    expect(snapDirection(-1, -2)).toBe('north-west');
    expect(snapDirection(1, -1)).toBe('north-east');
    expect(snapDirection(-1, 3)).toBe('south');
  });

  it('an exact 22.5° tie goes to the orthogonal', () => {
    const t = Math.tan(Math.PI / 8);
    expect(snapDirection(1, t)).toBe('east');
    expect(snapDirection(t, -1)).toBe('north');
    expect(snapDirection(1, t + 1e-9)).toBe('south-east');
  });

  it('dirVector is the unit step of each direction (y grows south)', () => {
    expect(dirVector('north-east')).toEqual({ dx: 1, dy: -1 });
    expect(dirVector('south')).toEqual({ dx: 0, dy: 1 });
    expect(dirVector('west')).toEqual({ dx: -1, dy: 0 });
    for (const d of ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'] as const) {
      const v = dirVector(d);
      expect(snapDirection(v.dx, v.dy)).toBe(d);
    }
  });
});

describe('rect algebra', () => {
  it('G9: subtractRect keeps the rest of a rect as top, left, right and bottom bands', () => {
    expect(subtractRect([R('B2:D4')], R('C3')).map(rectLabel)).toEqual(['B2:D2', 'B3', 'D3', 'B4:D4']);
    expect(subtractRect([R('B2:D4'), R('F5')], R('A1:P1')).map(rectLabel)).toEqual(['B2:D4', 'F5']);
    expect(subtractRect([R('B2:D4')], R('A1:P12'))).toEqual([]);
    expect(subtractRect([R('B2:D4')], R('A3:P3')).map(rectLabel)).toEqual(['B2:D2', 'B4:D4']);
  });

  it('mergeSquares: row runs merged vertically, deterministic whatever the input order, duplicates ignored', () => {
    const squares = rectSquares(R('B2:D4')).concat(rectSquares(R('F5')), rectSquares(R('B2')));
    const shuffled = [...squares].reverse();
    expect(mergeSquares(squares).map(rectLabel)).toEqual(['B2:D4', 'F5']);
    expect(mergeSquares(shuffled)).toEqual(mergeSquares(squares));
    // A plus shape: one run per row; the middle row is wider.
    const plus = [
      { x: 2, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 2, y: 3 },
    ];
    expect(mergeSquares(plus).map(rectLabel)).toEqual(['C2', 'B3:D3', 'C4']);
    expect(mergeSquares([])).toEqual([]);
  });
});

describe('the segment test (app convention C20)', () => {
  it('G11: a segment along the seam between two wall squares is blocked', () => {
    const blocks = walls('B2', 'C2');
    // The vertical grid line x = 2 between B2 and C2, from the top of the map down through row 3.
    expect(segmentBlocked(corner(2, 0), corner(2, 3), blocks)).toBe(true);
    // The horizontal seam between rows 2 and 3 of a two-square-thick wall B2:D3.
    const thick = walls('B2:D3');
    expect(segmentBlocked(corner(0, 2), corner(6, 2), thick)).toBe(true);
  });

  it('G12: grazing one wall face or peeking past one wall corner is not blocked', () => {
    const blocks = walls('B1');
    const b2 = centre({ x: 1, y: 1 });
    // A1's north-west corner → B2's centre passes B1's corner.
    expect(segmentBlocked(corner(0, 0), b2, blocks)).toBe(false);
    // A1's south-east corner (B1's south-west corner) → B2's centre.
    expect(segmentBlocked(corner(1, 1), b2, blocks)).toBe(false);
    // A1's south-west corner → B2's centre stays in row 2.
    expect(segmentBlocked(corner(0, 1), b2, blocks)).toBe(false);
    // Along B1's west face (the seam between A1 and B1): only one side blocks.
    expect(segmentBlocked(corner(1, 0), corner(1, 2), blocks)).toBe(false);
    // A1's north-east corner → B2's centre cuts through B1.
    expect(segmentBlocked(corner(1, 0), b2, blocks)).toBe(true);
  });

  it('G13: a crack between walls B1 and A2 seals A1 from B2; without the wedged-corner exclusion one segment is open', () => {
    const blocks = walls('B1', 'A2');
    const a1 = R('A1');
    const b2 = R('B2');
    const from = spaceSamplePoints(a1, blocks);
    const to = spaceSamplePoints(b2, blocks);
    // The shared corner (1, 1) is wedged for both spaces.
    expect(from).not.toContainEqual(corner(1, 1));
    expect(to).not.toContainEqual(corner(1, 1));
    for (const p of from) for (const q of to) expect(segmentBlocked(p, q, blocks)).toBe(true);
    // Regression (the rules prototype): with every corner kept, the shared corner sees B2's centre.
    const allCorners = (r: GridRect) => spaceSamplePoints(r, () => false);
    const open = allCorners(a1).flatMap((p) => allCorners(b2).filter((q) => !segmentBlocked(p, q, blocks)).map((q) => [p, q]));
    expect(open.length).toBeGreaterThan(0);
    expect(open).toContainEqual([corner(1, 1), centre({ x: 1, y: 1 })]);
  });

  it('G14: endpoints exactly on a blocker boundary are not blocked', () => {
    const blocks = walls('B1');
    // A1's centre → the middle of B1's west face, and → B1's south-west corner.
    expect(segmentBlocked(centre({ x: 0, y: 0 }), { x2: 2, y2: 1 }, blocks)).toBe(false);
    expect(segmentBlocked(centre({ x: 0, y: 0 }), corner(1, 1), blocks)).toBe(false);
    // From B1's own corner outward.
    expect(segmentBlocked(corner(2, 1), centre({ x: 3, y: 3 }), blocks)).toBe(false);
  });

  it('crossing a wall interior blocks; a zero-length segment never does', () => {
    const blocks = walls('C1:C12');
    expect(segmentBlocked(centre({ x: 0, y: 5 }), centre({ x: 5, y: 5 }), blocks)).toBe(true);
    expect(segmentBlocked(centre({ x: 0, y: 5 }), centre({ x: 1, y: 2 }), blocks)).toBe(false);
    expect(segmentBlocked(corner(3, 3), corner(3, 3), blocks)).toBe(false);
  });

  it('a diagonal staircase of walls is sealed at every crack', () => {
    const blocks = walls('C1', 'D2', 'E3', 'F4', 'G5');
    // From B3 to G3 across the staircase.
    const from = spaceSamplePoints(R('B3'), blocks);
    const to = spaceSamplePoints(R('G3'), blocks);
    for (const p of from) for (const q of to) expect(segmentBlocked(p, q, blocks)).toBe(true);
  });

  it('works in every direction (reversing a segment never changes the answer)', () => {
    const blocks = walls('B1', 'A2', 'D4:E5', 'H2');
    const pts: HalfPoint[] = [];
    for (let y = 0; y <= 12; y += 3) for (let x = 0; x <= 16; x += 3) pts.push({ x2: x, y2: y }, { x2: x + 1, y2: y + 1 });
    for (const p of pts) for (const q of pts) expect(segmentBlocked(p, q, blocks)).toBe(segmentBlocked(q, p, blocks));
  });
});

describe('sample points (app convention C20)', () => {
  it('a Medium space has its 4 corners and its centre; a Large one 9 corners and 4 centres', () => {
    expect(spaceSamplePoints(R('B2'), () => false)).toEqual([corner(1, 1), corner(2, 1), corner(1, 2), corner(2, 2), centre({ x: 1, y: 1 })]);
    expect(spaceSamplePoints(R('B2:C3'), () => false)).toHaveLength(13);
    expect(spaceSamplePoints(R('B2:C3'), () => false, { corners: false })).toHaveLength(4);
    expect(spaceSamplePoints(R('B2:C3'), () => false, { centres: false })).toHaveLength(9);
  });
});
