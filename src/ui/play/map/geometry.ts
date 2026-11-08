/**
 * SVG path data for the battle map, in world units (CELL per square): merged rectangles (one <path> per terrain
 * kind, ≈ 6–10 elements at 40×40), region outlines traced along the edges whose neighbour is outside the set
 * (bands, places, templates), route polylines through square centres, and the true outline of an area template.
 * Pure.
 */
import { mergeSquares } from '@/engine';
import type { GridPoint, GridRect } from '@/types';
import { CELL, type Pt } from './camera';

export function rectPath(r: GridRect): string {
  const w = (r.x1 - r.x0 + 1) * CELL;
  const h = (r.y1 - r.y0 + 1) * CELL;
  return `M${r.x0 * CELL} ${r.y0 * CELL}h${w}v${h}h${-w}Z`;
}

export function rectsPath(rects: readonly GridRect[]): string {
  return rects.map(rectPath).join('');
}

export function squaresPath(points: readonly GridPoint[]): string {
  return rectsPath(mergeSquares(points));
}

/** Every square of a list of rects (clipped to the map). */
export function rectSquares(rects: readonly GridRect[], cols: number, rows: number): GridPoint[] {
  const out: GridPoint[] = [];
  const seen = new Set<number>();
  for (const r of rects) {
    for (let y = Math.max(0, r.y0); y <= Math.min(rows - 1, r.y1); y++) {
      for (let x = Math.max(0, r.x0); x <= Math.min(cols - 1, r.x1); x++) {
        const key = y * cols + x;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ x, y });
      }
    }
  }
  return out;
}

/**
 * The outline of a set of squares: closed loops along the edges whose neighbour is outside the set (clockwise),
 * with straight runs merged, so a dashed border flows round corners instead of restarting at every square.
 */
export function outlinePath(points: readonly GridPoint[]): string {
  if (points.length === 0) return '';
  const inSet = new Set(points.map((p) => `${p.x},${p.y}`));
  const has = (x: number, y: number) => inSet.has(`${x},${y}`);
  // Directed boundary edges, keyed by their start vertex.
  const edges = new Map<string, Pt[]>();
  const add = (a: Pt, b: Pt) => {
    const key = `${a.x},${a.y}`;
    const list = edges.get(key);
    if (list) list.push(b);
    else edges.set(key, [b]);
  };
  for (const { x, y } of points) {
    if (!has(x, y - 1)) add({ x, y }, { x: x + 1, y });
    if (!has(x + 1, y)) add({ x: x + 1, y }, { x: x + 1, y: y + 1 });
    if (!has(x, y + 1)) add({ x: x + 1, y: y + 1 }, { x, y: y + 1 });
    if (!has(x - 1, y)) add({ x, y: y + 1 }, { x, y });
  }
  const loops: Pt[][] = [];
  for (const [startKey, ends] of edges) {
    while (ends.length > 0) {
      const [sx, sy] = startKey.split(',').map(Number);
      const loop: Pt[] = [{ x: sx, y: sy }];
      let next = ends.pop() as Pt;
      while (next.x !== sx || next.y !== sy) {
        loop.push(next);
        const out = edges.get(`${next.x},${next.y}`);
        if (!out || out.length === 0) break;
        next = out.pop() as Pt;
      }
      loops.push(loop);
    }
  }
  return loops.map((loop) => loopPath(simplify(loop))).join('');
}

/** Drop the middle points of straight runs. */
function simplify(loop: readonly Pt[]): Pt[] {
  if (loop.length < 3) return [...loop];
  const out: Pt[] = [];
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n];
    const cur = loop[i];
    const next = loop[(i + 1) % n];
    const straight = (prev.x === cur.x && cur.x === next.x) || (prev.y === cur.y && cur.y === next.y);
    if (!straight) out.push(cur);
  }
  return out.length ? out : [loop[0]];
}

function loopPath(loop: readonly Pt[]): string {
  return `M${loop.map((p) => `${p.x * CELL} ${p.y * CELL}`).join('L')}Z`;
}

/** World centre of a square. */
export function squareCentre(p: GridPoint): Pt {
  return { x: (p.x + 0.5) * CELL, y: (p.y + 0.5) * CELL };
}

/** World centre of a footprint. */
export function rectCentreWorld(r: GridRect): Pt {
  return { x: ((r.x0 + r.x1 + 1) / 2) * CELL, y: ((r.y0 + r.y1 + 1) / 2) * CELL };
}

/** A polyline through square centres (the planned route; `from` is the mover's own centre). */
export function routePath(from: Pt, squares: readonly Pt[]): string {
  return `M${from.x} ${from.y}${squares.map((p) => `L${p.x} ${p.y}`).join('')}`;
}

export function circlePath(c: Pt, r: number): string {
  return `M${c.x - r} ${c.y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
}

/** A cone's wedge: the 53.13° angle whose width equals its length (srd:rule:cone), from the apex along `u`. */
export function wedgePath(apex: Pt, u: Pt, length: number): string {
  const len = Math.hypot(u.x, u.y) || 1;
  const ux = u.x / len;
  const uy = u.y / len;
  const half = length / 2;
  const a = { x: apex.x + ux * length - uy * half, y: apex.y + uy * length + ux * half };
  const b = { x: apex.x + ux * length + uy * half, y: apex.y + uy * length - ux * half };
  return `M${apex.x} ${apex.y}L${a.x} ${a.y}L${b.x} ${b.y}Z`;
}

/** A line's strip from the apex along `u`. */
export function stripPath(apex: Pt, u: Pt, length: number, width: number): string {
  const len = Math.hypot(u.x, u.y) || 1;
  const ux = u.x / len;
  const uy = u.y / len;
  const w = width / 2;
  const p1 = { x: apex.x - uy * w, y: apex.y + ux * w };
  const p2 = { x: apex.x + uy * w, y: apex.y - ux * w };
  return `M${p1.x} ${p1.y}L${p1.x + ux * length} ${p1.y + uy * length}L${p2.x + ux * length} ${p2.y + uy * length}L${p2.x} ${p2.y}Z`;
}

/** The grid lines of a cols × rows map, as one path. */
export function gridPath(cols: number, rows: number): string {
  const parts: string[] = [];
  for (let x = 1; x < cols; x++) parts.push(`M${x * CELL} 0V${rows * CELL}`);
  for (let y = 1; y < rows; y++) parts.push(`M0 ${y * CELL}H${cols * CELL}`);
  return parts.join('');
}
