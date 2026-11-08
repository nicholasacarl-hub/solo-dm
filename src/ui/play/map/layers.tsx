/**
 * The battle map's SVG layers, in world units (CELL per square), painted with theme variables only (a theme switch
 * needs no re-render; no filters, masks or gradients; patterns live in <defs> with useId prefixes). Static layers
 * are memoized on what they draw (terrain on map.terrain, so on map.rev); overlays (bands, path, template,
 * measure, cursor) are small and change alone.
 */
import { memo, useId, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { rectsTotalCover, spaceDistanceFt, squareLabel, type MapCells, type ReachableSquare, type SnapshotToken } from '@/engine';
import type { BattleMap, Combatant, GridPoint, GridRect, HitPoints, MapPlace, TerrainFeature, TerrainKind } from '@/types';
import { CELL, type Pt } from './camera';
import { circlePath, gridPath, outlinePath, rectCentreWorld, rectSquares, routePath, squareCentre, squaresPath, stripPath, wedgePath } from './geometry';
import type { PlanPreview } from './preview';
import { conditionPills, healthGlyph, healthTone, hpRatio, TOKEN_FILL, TOKEN_INK, tokenShape, type HealthDescriptor } from './tokenStyle';

// ---------------------------------------------------------------------------
// Ids and patterns
// ---------------------------------------------------------------------------

export interface MapIds {
  hatch: string;
  dashHatch: string;
  waves: string;
  wavesDense: string;
  stripes: string;
  crossHatch: string;
  stipple: string;
  effectHatch: string;
  prefix: string;
}

export function useMapIds(): MapIds {
  const raw = useId();
  return useMemo(() => {
    const prefix = `map${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const id = (name: string) => `${prefix}-${name}`;
    return {
      hatch: id('hatch'),
      dashHatch: id('dash'),
      waves: id('waves'),
      wavesDense: id('waves-dense'),
      stripes: id('stripes'),
      crossHatch: id('cross'),
      stipple: id('stipple'),
      effectHatch: id('effect-hatch'),
      prefix,
    };
  }, [raw]);
}

const url = (id: string) => `url(#${id})`;

export const MapDefs = memo(function MapDefs({ ids }: { ids: MapIds }) {
  return (
    <defs>
      <pattern id={ids.hatch} width="22" height="22" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="22" stroke="var(--map-difficult)" strokeWidth="5" />
      </pattern>
      <pattern id={ids.effectHatch} width="26" height="26" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
        <line x1="0" y1="0" x2="0" y2="26" stroke="var(--arcane)" strokeWidth="4" opacity="0.7" />
      </pattern>
      <pattern id={ids.dashHatch} width="20" height="20" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="20" stroke="var(--accent)" strokeWidth="6" opacity="0.28" />
      </pattern>
      <pattern id={ids.waves} width="50" height="34" patternUnits="userSpaceOnUse">
        <path d="M0 17 q12.5 -10 25 0 t25 0" fill="none" stroke="var(--map-water-ink)" strokeWidth="3" opacity="0.7" />
      </pattern>
      <pattern id={ids.wavesDense} width="40" height="20" patternUnits="userSpaceOnUse">
        <path d="M0 10 q10 -8 20 0 t20 0" fill="none" stroke="var(--map-water-ink)" strokeWidth="3.5" />
      </pattern>
      <pattern id={ids.stripes} width="30" height="30" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
        <line x1="0" y1="0" x2="0" y2="30" stroke="var(--map-hazard)" strokeWidth="8" opacity="0.75" />
      </pattern>
      <pattern id={ids.crossHatch} width="24" height="24" patternUnits="userSpaceOnUse">
        <path d="M0 0L24 24M24 0L0 24" stroke="var(--map-wall)" strokeWidth="2.5" opacity="0.65" />
      </pattern>
      <pattern id={ids.stipple} width="18" height="18" patternUnits="userSpaceOnUse">
        <circle cx="4.5" cy="4.5" r="3" fill="var(--map-obscured)" />
        <circle cx="13.5" cy="13.5" r="3" fill="var(--map-obscured)" />
      </pattern>
    </defs>
  );
});

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

interface TerrainSets {
  byKind: Partial<Record<TerrainKind, GridPoint[]>>;
  doors: { feature: TerrainFeature; at: GridPoint; horizontal: boolean }[];
  glyphs: { at: Pt; text: string; fill: string }[];
  labels: { at: Pt; text: string }[];
}

type TerrainInput = Pick<BattleMap, 'terrain' | 'width' | 'height'>;

function terrainSets(map: TerrainInput): TerrainSets {
  const byKind: Partial<Record<TerrainKind, GridPoint[]>> = {};
  const doorSquares = new Set<string>();
  const solid = new Set<string>();
  for (const f of map.terrain) {
    if (f.kind !== 'door') continue;
    for (const p of rectSquares(f.rects, map.width, map.height)) doorSquares.add(`${p.x},${p.y}`);
  }
  const glyphs: TerrainSets['glyphs'] = [];
  const labels: TerrainSets['labels'] = [];
  for (const f of map.terrain) {
    if (f.kind === 'door') continue;
    let squares = rectSquares(f.rects, map.width, map.height);
    if (f.kind === 'wall') squares = squares.filter((p) => !doorSquares.has(`${p.x},${p.y}`));
    if (f.kind === 'wall' || f.kind === 'three-quarters-cover') for (const p of squares) solid.add(`${p.x},${p.y}`);
    (byKind[f.kind] ??= []).push(...squares);
    for (const r of f.rects) {
      const c = squareCentre({ x: Math.max(0, r.x0), y: Math.max(0, r.y0) });
      if (f.kind === 'hazard') glyphs.push({ at: c, text: '⚠', fill: 'var(--map-hazard)' });
      else if (f.kind === 'half-cover') glyphs.push({ at: c, text: '½', fill: 'var(--map-cover)' });
      else if (f.kind === 'three-quarters-cover') glyphs.push({ at: c, text: '¾', fill: 'var(--map-floor)' });
    }
    if (f.label && squares.length > 0) {
      const r = f.rects[0];
      labels.push({ at: { x: Math.max(0, r.x0) * CELL + 8, y: (Math.min(map.height - 1, r.y1) + 1) * CELL - 10 }, text: f.label });
    }
  }
  const doors: TerrainSets['doors'] = [];
  for (const f of map.terrain) {
    if (f.kind !== 'door') continue;
    for (const p of rectSquares(f.rects, map.width, map.height)) {
      const wallBeside = (x: number, y: number) => solid.has(`${x},${y}`) || doorSquares.has(`${x},${y}`);
      const horizontal = wallBeside(p.x - 1, p.y) || wallBeside(p.x + 1, p.y) || !(wallBeside(p.x, p.y - 1) || wallBeside(p.x, p.y + 1));
      doors.push({ feature: f, at: p, horizontal });
    }
    if (f.label) {
      const r = f.rects[0];
      labels.push({ at: { x: Math.max(0, r.x0) * CELL + 8, y: Math.max(0, r.y0) * CELL - 10 }, text: f.label });
    }
  }
  return { byKind, doors, glyphs, labels };
}

function Door({ at, horizontal, state }: { at: GridPoint; horizontal: boolean; state: TerrainFeature['door'] }) {
  const x = at.x * CELL;
  const y = at.y * CELL;
  const thick = 30;
  const bar = horizontal
    ? { x: x + 6, y: y + (CELL - thick) / 2, width: CELL - 12, height: thick }
    : { x: x + (CELL - thick) / 2, y: y + 6, width: thick, height: CELL - 12 };
  const open = state === 'open';
  return (
    <g data-map-stroke>
      <rect
        {...bar}
        rx="5"
        fill={open ? 'var(--map-floor)' : 'var(--map-door)'}
        stroke="var(--map-door)"
        strokeWidth="5"
        strokeDasharray={open ? '10 7' : undefined}
      />
      {state === 'locked' && (
        <g transform={`translate(${x + CELL / 2} ${y + CELL / 2})`}>
          <rect x="-11" y="-4" width="22" height="18" rx="3" fill="var(--map-floor)" />
          <path d="M-6 -4v-6a6 6 0 0 1 12 0v6" fill="none" stroke="var(--map-floor)" strokeWidth="4" />
        </g>
      )}
    </g>
  );
}

/**
 * Floor, terrain and doors: one path per kind. Memoized on the terrain array, which only changes when the map's
 * layout does (with map.rev) — never on a token move.
 */
export const TerrainLayer = memo(function TerrainLayer({
  terrain,
  width,
  height,
  ids,
  labels,
}: {
  terrain: BattleMap['terrain'];
  width: number;
  height: number;
  ids: MapIds;
  labels: boolean;
}) {
  const sets = useMemo(() => terrainSets({ terrain, width, height }), [terrain, width, height]);
  const map = { width, height };
  const d = (kind: TerrainKind) => (sets.byKind[kind]?.length ? squaresPath(sets.byKind[kind] ?? []) : '');
  return (
    <g>
      <rect width={map.width * CELL} height={map.height * CELL} fill="var(--map-floor)" />
      {d('shallow-water') && (
        <>
          <path d={d('shallow-water')} fill="var(--map-water)" opacity="0.6" />
          <path d={d('shallow-water')} fill={url(ids.waves)} />
        </>
      )}
      {d('deep-water') && (
        <>
          <path d={d('deep-water')} fill="var(--map-water)" />
          <path d={d('deep-water')} fill={url(ids.wavesDense)} />
        </>
      )}
      {d('difficult') && <path d={d('difficult')} fill={url(ids.hatch)} />}
      {d('hazard') && <path d={d('hazard')} fill={url(ids.stripes)} />}
      {d('pit') && (
        <>
          <path d={d('pit')} fill="var(--map-pit)" />
          <path d={d('pit')} fill={url(ids.crossHatch)} />
          <path d={outlinePath(sets.byKind.pit ?? [])} fill="none" stroke="var(--map-wall)" strokeWidth="5" data-map-stroke />
        </>
      )}
      {d('half-cover') && (
        <>
          <path d={d('half-cover')} fill="var(--map-cover)" opacity="0.35" />
          <path d={d('half-cover')} fill={url(ids.hatch)} opacity="0.55" />
        </>
      )}
      {d('obscured') && <path d={d('obscured')} fill={url(ids.stipple)} />}
      {d('three-quarters-cover') && <path d={d('three-quarters-cover')} fill="var(--map-cover)" opacity="0.6" />}
      {d('wall') && <path d={d('wall')} fill="var(--map-wall)" data-map-fill />}
      {sets.doors.map((door) => (
        <Door key={`${door.feature.id}-${door.at.x}-${door.at.y}`} at={door.at} horizontal={door.horizontal} state={door.feature.door} />
      ))}
      {sets.glyphs.map((g, i) => (
        <text
          key={i}
          x={g.at.x}
          y={g.at.y}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="40"
          fontWeight="700"
          fill={g.fill}
          stroke="var(--map-floor)"
          strokeWidth="7"
          paintOrder="stroke"
          className="select-none"
        >
          {g.text}
        </text>
      ))}
      {labels &&
        sets.labels.map((l, i) => (
          <text
            key={i}
            x={l.at.x}
            y={l.at.y}
            fontSize="24"
            fontWeight="600"
            fill="var(--muted)"
            stroke="var(--map-floor)"
            strokeWidth="6"
            paintOrder="stroke"
            className="select-none"
          >
            {l.text}
          </text>
        ))}
    </g>
  );
});

export const GridLayer = memo(function GridLayer({ cols, rows }: { cols: number; rows: number }) {
  return (
    <g>
      <path d={gridPath(cols, rows)} stroke="var(--map-grid)" strokeWidth="1" vectorEffect="non-scaling-stroke" fill="none" data-map-stroke />
      <rect width={cols * CELL} height={rows * CELL} fill="none" stroke="var(--border)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" data-map-stroke />
    </g>
  );
});

function LabelPill({ x, y, text, tone }: { x: number; y: number; text: string; tone: 'info' | 'arcane' }) {
  const width = Math.max(60, text.length * 13 + 22);
  return (
    <g transform={`translate(${x} ${y})`} className="select-none">
      <rect width={width} height="32" rx="16" fill={`var(--${tone}-soft)`} stroke={`var(--${tone})`} strokeWidth="2" />
      <text x={width / 2} y="17" textAnchor="middle" dominantBaseline="central" fontSize="21" fontWeight="600" fill={`var(--${tone})`}>
        {text}
      </text>
    </g>
  );
}

export const PlacesLayer = memo(function PlacesLayer({ places, cols, rows, labels }: { places: readonly MapPlace[]; cols: number; rows: number; labels: boolean }) {
  return (
    <g>
      {places.map((p) => {
        const squares = rectSquares(p.rects, cols, rows);
        if (squares.length === 0) return null;
        const first = squares[0];
        return (
          <g key={p.id}>
            <path d={outlinePath(squares)} fill="none" stroke="var(--info)" strokeWidth="2" strokeDasharray="7 5" vectorEffect="non-scaling-stroke" data-map-stroke />
            {labels && <LabelPill x={first.x * CELL + 6} y={first.y * CELL + 6} text={p.name} tone="info" />}
          </g>
        );
      })}
    </g>
  );
});

export interface EffectView {
  id: string;
  label: string;
  rects: GridRect[];
  terrain: readonly string[];
  duration: 'turn' | 'lasting';
}

function effectsKey(effects: readonly EffectView[]): string {
  return effects.map((e) => `${e.id}|${e.label}|${e.duration}|${e.terrain.join(',')}|${e.rects.map((r) => `${r.x0},${r.y0},${r.x1},${r.y1}`).join(';')}`).join('/');
}

/** Areas on the map. The snapshot rebuilds the list on every change, so it re-renders only when what it draws does. */
export const EffectsLayer = memo(
  function EffectsLayer({ effects, cols, rows, ids, labels }: { effects: readonly EffectView[]; cols: number; rows: number; ids: MapIds; labels: boolean }) {
  return (
    <g>
      {effects.map((e) => {
        const squares = rectSquares(e.rects, cols, rows);
        if (squares.length === 0) return null;
        const d = squaresPath(squares);
        const first = squares[0];
        return (
          <g key={e.id}>
            <path d={d} fill="var(--arcane-soft)" opacity={e.duration === 'turn' ? 0.7 : 0.45} />
            {e.terrain.includes('difficult') && <path d={d} fill={url(ids.effectHatch)} />}
            {e.terrain.includes('obscured') && <path d={d} fill={url(ids.stipple)} />}
            {e.terrain.includes('hazard') && <path d={d} fill={url(ids.stripes)} opacity="0.6" />}
            <path d={outlinePath(squares)} fill="none" stroke="var(--arcane)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" data-map-stroke />
            {labels && <LabelPill x={first.x * CELL + 6} y={first.y * CELL + 44} text={e.label} tone="arcane" />}
          </g>
        );
      })}
    </g>
  );
  },
  (a, b) => a.cols === b.cols && a.rows === b.rows && a.ids === b.ids && a.labels === b.labels && effectsKey(a.effects) === effectsKey(b.effects),
);

// ---------------------------------------------------------------------------
// Planning overlays
// ---------------------------------------------------------------------------

/** The walk band (solid border, 14% fill) and the Dash band (hatched, dashed border): pattern and line, not hue alone. */
export const BandsLayer = memo(function BandsLayer({ reachable, ids }: { reachable: readonly ReachableSquare[]; ids: MapIds }) {
  const move = reachable.filter((r) => r.band === 'move' && r.canEnd).map((r) => r.at);
  const dash = reachable.filter((r) => r.band === 'dash' && r.canEnd).map((r) => r.at);
  return (
    <g data-map-layer="bands">
      {move.length > 0 && (
        <>
          <path d={squaresPath(move)} fill="var(--accent)" opacity="0.14" />
          <path d={outlinePath(move)} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" opacity="0.85" />
        </>
      )}
      {dash.length > 0 && (
        <>
          <path d={squaresPath(dash)} fill={url(ids.dashHatch)} />
          <path d={outlinePath(dash)} fill="none" stroke="var(--accent)" strokeWidth="2" strokeDasharray="6 5" vectorEffect="non-scaling-stroke" opacity="0.8" />
        </>
      )}
    </g>
  );
});

/** Squares within a visible enemy's reach (no Total Cover between, D7): dashed danger outlines while planning. */
export function threatSquares(token: SnapshotToken, cells: MapCells, cols: number, rows: number): GridPoint[] {
  if (!token.space) return [];
  const reach = token.reachFt;
  const n = Math.ceil(reach / 5);
  const out: GridPoint[] = [];
  const space = { rect: token.space, elevationFt: token.elevationFt, size: token.size };
  for (let y = token.space.y0 - n; y <= token.space.y1 + n; y++) {
    for (let x = token.space.x0 - n; x <= token.space.x1 + n; x++) {
      if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
      if (x >= token.space.x0 && x <= token.space.x1 && y >= token.space.y0 && y <= token.space.y1) continue;
      const sq = { x0: x, y0: y, x1: x, y1: y };
      if (spaceDistanceFt(space, { rect: sq, elevationFt: 0, size: 'Medium' }) > reach) continue;
      if (rectsTotalCover(cells, token.space, sq)) continue;
      out.push({ x, y });
    }
  }
  return out;
}

export const ThreatLayer = memo(function ThreatLayer({ threats }: { threats: readonly GridPoint[][] }) {
  return (
    <g data-map-layer="threats">
      {threats.map((squares, i) => (
        <path key={i} d={outlinePath(squares)} fill="none" stroke="var(--danger)" strokeWidth="2" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" data-map-stroke />
      ))}
    </g>
  );
});

/** The planned route: dots per square, the cost badge, and the ⚠ where an Opportunity Attack would stop it. */
export const PathLayer = memo(function PathLayer({ preview, from, faint, size }: { preview: PlanPreview; from: GridRect; faint: boolean; size: number }) {
  const offset = ((size - 1) / 2) * CELL;
  const centre = (p: GridPoint) => ({ x: squareCentre(p).x + offset, y: squareCentre(p).y + offset });
  const start = rectCentreWorld(from);
  const end = centre(preview.to);
  const refused = preview.status === 'refused';
  const points = preview.path.map(centre);
  const badge = refused ? null : `${preview.costFt} ft`;
  return (
    <g data-map-layer="path" opacity={faint ? 0.6 : 1} className="pointer-events-none">
      {points.length > 0 && (
        <path d={routePath(start, points)} fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" data-map-path />
      )}
      {points.slice(0, -1).map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="9" fill="var(--accent)" />
      ))}
      <circle
        cx={end.x}
        cy={end.y}
        r={size * CELL * 0.36}
        fill="none"
        stroke={refused ? 'var(--danger)' : 'var(--accent)'}
        strokeWidth="3"
        strokeDasharray={refused ? '6 5' : undefined}
        vectorEffect="non-scaling-stroke"
        data-map-path
      />
      {refused && <path d={`M${end.x - 18} ${end.y - 18}L${end.x + 18} ${end.y + 18}M${end.x + 18} ${end.y - 18}L${end.x - 18} ${end.y + 18}`} stroke="var(--danger)" strokeWidth="6" strokeLinecap="round" />}
      {preview.stopAt && (
        <g transform={`translate(${centre(preview.stopAt).x} ${centre(preview.stopAt).y})`}>
          <circle r="26" fill="var(--danger)" />
          <text textAnchor="middle" dominantBaseline="central" fontSize="30" fontWeight="700" fill="var(--token-ink)" className="select-none">
            !
          </text>
        </g>
      )}
      {badge && !faint && (
        <g transform={`translate(${end.x} ${end.y - size * CELL * 0.5 - 6})`} className="select-none">
          <rect x={-badge.length * 8 - 12} y="-34" width={badge.length * 16 + 24} height="34" rx="10" fill="var(--accent)" />
          <text y="-16" textAnchor="middle" dominantBaseline="central" fontSize="22" fontWeight="700" fill="var(--accent-ink)">
            {badge}
          </text>
        </g>
      )}
    </g>
  );
});

export interface TemplateDrawing {
  squares: GridPoint[];
  outline: string | null;
  centre: Pt | null;
}

export const TemplateLayer = memo(function TemplateLayer({ drawing }: { drawing: TemplateDrawing }) {
  return (
    <g data-map-layer="template" className="pointer-events-none">
      {drawing.squares.length > 0 && (
        <>
          <path d={squaresPath(drawing.squares)} fill="var(--arcane)" opacity="0.22" />
          <path d={outlinePath(drawing.squares)} fill="none" stroke="var(--arcane)" strokeWidth="2" vectorEffect="non-scaling-stroke" data-map-stroke />
        </>
      )}
      {drawing.outline && <path d={drawing.outline} fill="none" stroke="var(--arcane)" strokeWidth="2.5" strokeDasharray="8 6" vectorEffect="non-scaling-stroke" data-map-stroke />}
      {drawing.centre && <circle cx={drawing.centre.x} cy={drawing.centre.y} r="10" fill="var(--arcane)" stroke="var(--map-floor)" strokeWidth="4" />}
    </g>
  );
});

/** The true outline of a template: a circle, a cone's wedge or a line's strip (cubes and emanations: their squares). */
export function templateOutline(shape: string, origin: Pt | null, aim: Pt | null, sizeFt: number, widthFt: number, casterSquares: number): string | null {
  if (!origin) return null;
  const length = (sizeFt / 5) * CELL;
  if (shape === 'sphere' || shape === 'cylinder') return circlePath(origin, length);
  if (!aim) return null;
  const u = { x: aim.x - origin.x, y: aim.y - origin.y };
  if (u.x === 0 && u.y === 0) return null;
  const reach = length + (casterSquares * CELL) / 2;
  if (shape === 'cone') return wedgePath(origin, u, reach);
  if (shape === 'line') return stripPath(origin, u, reach, (widthFt / 5) * CELL);
  return null;
}

export const MeasureLayer = memo(function MeasureLayer({ from, to, label }: { from: Pt; to: Pt; label: string }) {
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  return (
    <g data-map-layer="measure" className="pointer-events-none">
      <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="var(--info)" strokeWidth="3" strokeLinecap="round" vectorEffect="non-scaling-stroke" data-map-path />
      <circle cx={from.x} cy={from.y} r="11" fill="var(--info)" />
      <circle cx={to.x} cy={to.y} r="11" fill="var(--info)" />
      <g transform={`translate(${mid.x} ${mid.y})`} className="select-none">
        <rect x={-label.length * 8 - 12} y="-20" width={label.length * 16 + 24} height="40" rx="12" fill="var(--info)" />
        <text textAnchor="middle" dominantBaseline="central" fontSize="24" fontWeight="700" fill="var(--token-ink)">
          {label}
        </text>
      </g>
    </g>
  );
});

export const CursorLayer = memo(function CursorLayer({ at }: { at: GridPoint }) {
  return (
    <g data-map-layer="cursor" className="pointer-events-none" data-square={squareLabel(at)}>
      <rect x={at.x * CELL} y={at.y * CELL} width={CELL} height={CELL} fill="none" stroke="var(--text)" strokeWidth="4" vectorEffect="non-scaling-stroke" data-map-cursor />
      <rect x={at.x * CELL + 3} y={at.y * CELL + 3} width={CELL - 6} height={CELL - 6} fill="none" stroke="var(--bg)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" data-map-cursor />
    </g>
  );
});

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface TokenDrawing {
  token: SnapshotToken;
  combatant: Combatant | undefined;
  label: string;
  /** The hero's portrait: an emoji or a data: image. */
  portrait: { kind: 'image'; src: string } | { kind: 'text'; text: string } | null;
  hp: HitPoints | null;
  /** Exact HP may be shown (the hero, allies, creatures without hideHp): the arc as well as the glyph. */
  showArc: boolean;
  descriptor: HealthDescriptor | null;
  conditions: { id: string; level?: number }[];
  current: boolean;
  selected: boolean;
  highlighted: boolean;
  /** Drawn from secretTokens ("Show DM secrets"). */
  secret: boolean;
  /** Tiny creatures share a square: their quadrant (0–3). */
  quadrant: number;
  showLabels: boolean;
  /** Its last move (where it started and the anchors it entered), for the tween. */
  trail: TokenTrail | null;
  reducedMotion: boolean;
}

/** A move as the tween follows it (a TurnMove is one). */
export interface TokenTrail {
  from: GridPoint;
  path: readonly GridPoint[];
}

function drawingKey(d: TokenDrawing): string {
  const t = d.token;
  return [
    t.id,
    t.space ? `${t.space.x0},${t.space.y0},${t.space.x1},${t.space.y1}` : '-',
    t.defeated,
    t.elevationFt,
    t.reactionUsed,
    d.label,
    d.hp ? `${d.hp.current}/${d.hp.max}/${d.hp.temp}` : '-',
    d.showArc,
    d.descriptor,
    d.conditions.map((c) => `${c.id}${c.level ?? ''}`).join('|'),
    d.current,
    d.selected,
    d.highlighted,
    d.secret,
    d.quadrant,
    d.showLabels,
    d.portrait ? (d.portrait.kind === 'image' ? d.portrait.src.length : d.portrait.text) : '-',
    d.reducedMotion,
  ].join(';');
}

const TWEEN_MS_PER_SQUARE = 110;
const TWEEN_MAX_MS = 900;

function anchorWorld(d: TokenDrawing): Pt {
  const s = d.token.space as GridRect;
  if (d.token.size === 'Tiny') {
    const qx = d.quadrant % 2;
    const qy = Math.floor(d.quadrant / 2);
    return { x: s.x0 * CELL + qx * (CELL / 2), y: s.y0 * CELL + qy * (CELL / 2) };
  }
  return { x: s.x0 * CELL, y: s.y0 * CELL };
}

/**
 * The way a token travels from where it was drawn (`from`) to where it is now: along its last move's route when it
 * arrived by that move — it was drawn at the move's start and the route ends here — else straight. An Undo lands the
 * token at the end of the move before the undone one, so it slides straight back instead of walking that move's
 * route again (U14).
 */
export function tweenRoute(from: Pt, target: Pt, trail: TokenTrail | null): Pt[] {
  const at = (p: GridPoint): Pt => ({ x: p.x * CELL, y: p.y * CELL });
  const end = trail?.path.at(-1);
  if (trail && end) {
    const start = at(trail.from);
    const last = at(end);
    if (start.x === from.x && start.y === from.y && last.x === target.x && last.y === target.y) return [from, ...trail.path.map(at)];
  }
  return [from, target];
}

/** Animate a token's <g> from where it was along its route (or straight) to where it is now. */
function useTween(ref: RefObject<SVGGElement | null>, target: Pt, trail: TokenTrail | null, reducedMotion: boolean) {
  const prev = useRef<Pt | null>(null);
  useLayoutEffect(() => {
    const from = prev.current;
    prev.current = target;
    const el = ref.current;
    if (!el || !from || (from.x === target.x && from.y === target.y) || reducedMotion) return undefined;
    const route = tweenRoute(from, target, trail);
    const squares = Math.max(1, route.length - 1, Math.round(Math.hypot(target.x - from.x, target.y - from.y) / CELL));
    const duration = Math.min(TWEEN_MAX_MS, TWEEN_MS_PER_SQUARE * squares);
    if (typeof window.requestAnimationFrame !== 'function') return undefined;
    let frame = 0;
    const started = performance.now();
    const tick = (now: number) => {
      // A frame's timestamp can be a little earlier than `started`.
      const t = Math.max(0, Math.min(1, (now - started) / duration));
      const pos = t * (route.length - 1);
      const i = Math.min(route.length - 2, Math.floor(pos));
      const f = pos - i;
      const a = route[i];
      const b = route[i + 1];
      el.setAttribute('transform', `translate(${a.x + (b.x - a.x) * f} ${a.y + (b.y - a.y) * f})`);
      if (t < 1) frame = window.requestAnimationFrame(tick);
      else el.setAttribute('transform', `translate(${target.x} ${target.y})`);
    };
    el.setAttribute('transform', `translate(${from.x} ${from.y})`);
    frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
      el.setAttribute('transform', `translate(${target.x} ${target.y})`);
    };
    // Only when the token's place changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.x, target.y]);
}

function HealthBadge({ glyph, x, y }: { glyph: 'bloodied' | 'critical' | 'down'; x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle r="17" fill="var(--surface)" stroke="var(--border)" strokeWidth="2.5" />
      {glyph === 'bloodied' && (
        <g>
          <path d="M0 -11 C6 -3 9 1 9 5 A9 9 0 0 1 -9 5 C-9 1 -6 -3 0 -11Z" fill="none" stroke="var(--danger)" strokeWidth="2.5" />
          <path d="M-9 5 A9 9 0 0 0 9 5 Z" fill="var(--danger)" />
        </g>
      )}
      {glyph === 'critical' && (
        <path d="M0 10 C-11 2 -12 -5 -7 -9 C-4 -11 -1 -10 0 -7 C1 -10 4 -11 7 -9 C12 -5 11 2 0 10Z M1 -6 L-2 -1 L2 1 L-1 6" fill="var(--danger)" stroke="var(--surface)" strokeWidth="2" strokeLinejoin="round" />
      )}
      {glyph === 'down' && (
        <g fill="var(--text)">
          <path d="M-9 1 A9 9 0 1 1 9 1 V6 H5 V9 H-5 V6 H-9 Z" />
          <circle cx="-4" cy="0" r="2.6" fill="var(--surface)" />
          <circle cx="4" cy="0" r="2.6" fill="var(--surface)" />
        </g>
      )}
    </g>
  );
}

function Pill({ x, y, text, tone = 'surface' }: { x: number; y: number; text: string; tone?: 'surface' | 'danger' }) {
  const width = text.length * 11 + 14;
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x={-width / 2} y="-12" width={width} height="24" rx="12" fill={tone === 'danger' ? 'var(--danger)' : 'var(--surface)'} stroke="var(--border)" strokeWidth="2" />
      <text textAnchor="middle" dominantBaseline="central" fontSize="17" fontWeight="700" fill={tone === 'danger' ? 'var(--token-ink)' : 'var(--text)'}>
        {text}
      </text>
    </g>
  );
}

export const Token = memo(
  function Token({ d, clipId }: { d: TokenDrawing; clipId: string }) {
    const ref = useRef<SVGGElement>(null);
    const t = d.token;
    const anchor = anchorWorld(d);
    useTween(ref, anchor, d.trail, d.reducedMotion);
    const n = t.size === 'Tiny' ? 0.5 : Math.max(1, (t.space?.x1 ?? 0) - (t.space?.x0 ?? 0) + 1);
    const s = n * CELL;
    const c = s / 2;
    const r = s * 0.44;
    const shape = tokenShape(t.side);
    const fill = t.defeated ? 'var(--surface-3)' : TOKEN_FILL[shape];
    const ink = t.defeated ? 'var(--faint)' : TOKEN_INK[shape];
    const pills = conditionPills(d.conditions);
    const glyph = healthGlyph(d.descriptor);
    const labelSize = Math.min(44, 30 * n + 4);
    const outline = d.secret ? { strokeDasharray: '8 6', stroke: 'var(--text)', strokeWidth: 3 } : null;
    return (
      <g
        ref={ref}
        transform={`translate(${anchor.x} ${anchor.y})`}
        data-token-id={t.id}
        data-square={t.space ? squareLabel({ x: t.space.x0, y: t.space.y0 }) : undefined}
        data-side={t.side}
        opacity={d.secret ? 0.55 : 1}
        className="pointer-events-none"
      >
        {/* Highlighted (the tracker row under the pointer): a thick soft halo. Selected (its card is open, or
            measuring from it): a dashed ring. Shapes and lines, not colour alone. */}
        {d.highlighted && <circle cx={c} cy={c} r={r + 13} fill="none" stroke="var(--text)" strokeWidth="10" opacity="0.22" data-token-highlight />}
        {d.selected && (
          <circle cx={c} cy={c} r={r + 16} fill="none" stroke="var(--text)" strokeWidth="3.5" strokeDasharray="10 7" data-token-selected data-map-stroke />
        )}
        {d.current && !t.defeated && (
          <g key={`current-${t.id}`} className="map-pulse">
            <circle cx={c} cy={c} r={r + 9} fill="none" stroke="var(--map-floor)" strokeWidth="6" />
            <circle cx={c} cy={c} r={r + 12} fill="none" stroke="var(--text)" strokeWidth="6" data-token-ring />
            <path d={`M${c - 14} ${-8} L${c + 14} ${-8} L${c} ${8} Z`} fill="var(--text)" />
          </g>
        )}
        {shape === 'enemy' && !t.defeated ? (
          <path
            d={`M${c} ${c - r * 1.08}L${c + r * 1.08} ${c}L${c} ${c + r * 1.08}L${c - r * 1.08} ${c}Z`}
            fill={fill}
            stroke={outline?.stroke ?? 'var(--map-floor)'}
            strokeWidth={outline?.strokeWidth ?? 3}
            strokeDasharray={outline?.strokeDasharray}
            strokeLinejoin="round"
            data-token-fill
          />
        ) : (
          <circle
            cx={c}
            cy={c}
            r={r}
            fill={fill}
            stroke={outline?.stroke ?? (shape === 'neutral' ? 'var(--faint)' : 'var(--map-floor)')}
            strokeWidth={outline?.strokeWidth ?? (shape === 'neutral' ? 4 : 3)}
            strokeDasharray={outline?.strokeDasharray ?? (shape === 'neutral' ? '9 6' : undefined)}
            data-token-fill
          />
        )}
        {shape === 'hero' && !t.defeated && (
          <>
            <circle cx={c} cy={c} r={r - 5} fill="none" stroke="var(--map-floor)" strokeWidth="3" />
            <circle cx={c} cy={c} r={r - 9} fill="none" stroke="var(--text)" strokeWidth="2" opacity="0.8" data-token-ring />
            <path transform={`translate(${c + r * 0.72} ${c - r * 0.72})`} d="M0 -13L3.8 -4.2L13 -4L5.8 1.8L8.2 11L0 5.6L-8.2 11L-5.8 1.8L-13 -4L-3.8 -4.2Z" fill="var(--gold)" stroke="var(--map-floor)" strokeWidth="2.5" />
          </>
        )}
        {d.showArc && d.hp && !t.defeated && (
          <circle
            cx={c}
            cy={c}
            r={r + 4}
            fill="none"
            stroke={healthTone(d.hp)}
            strokeWidth="5"
            strokeDasharray={`${hpRatio(d.hp) * 2 * Math.PI * (r + 4)} ${2 * Math.PI * (r + 4)}`}
            transform={`rotate(90 ${c} ${c})`}
            strokeLinecap="round"
          />
        )}
        {d.portrait?.kind === 'image' && !t.defeated ? (
          <>
            <clipPath id={clipId}>
              <circle cx={c} cy={c} r={r - 11} />
            </clipPath>
            <image href={d.portrait.src} x={c - r} y={c - r} width={2 * r} height={2 * r} clipPath={`url(#${clipId})`} preserveAspectRatio="xMidYMid slice" />
          </>
        ) : d.showLabels || d.portrait?.kind === 'text' ? (
          <text
            x={c}
            y={c + 1}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={d.portrait?.kind === 'text' && !t.defeated ? labelSize * 1.15 : labelSize}
            fontWeight="600"
            fill={ink}
            className="select-none tabular-nums"
          >
            {d.portrait?.kind === 'text' && !t.defeated ? d.portrait.text : d.label}
          </text>
        ) : null}
        {t.defeated && (
          <g transform={`translate(${c} ${c})`} fill="var(--faint)">
            <path d="M-14 2 A14 14 0 1 1 14 2 V9 H8 V14 H-8 V9 H-14 Z" opacity="0.9" />
            <circle cx="-6" cy="0" r="4" fill="var(--surface-3)" />
            <circle cx="6" cy="0" r="4" fill="var(--surface-3)" />
          </g>
        )}
        {glyph && !t.defeated && <HealthBadge glyph={glyph} x={s - 14} y={s - 14} />}
        {d.showLabels && !t.defeated && pills.pills.length > 0 && (
          <g>
            {[...pills.pills, ...(pills.more ? [`+${pills.more}`] : [])].map((p, i) => (
              <Pill key={i} x={18 + i * 34} y={14} text={p} />
            ))}
          </g>
        )}
        {d.showLabels && t.elevationFt > 0 && <Pill x={s - 26} y={s - 46} text={`↑${t.elevationFt}`} />}
        {d.showLabels && t.reactionUsed && !t.isHero && !t.defeated && <Pill x={s - 18} y={14} text="R̶" tone="danger" />}
        {d.secret && (
          <g transform={`translate(${s - 16} ${16})`}>
            <circle r="15" fill="var(--surface)" stroke="var(--text)" strokeWidth="2" />
            <path d="M-9 0 Q0 -8 9 0 Q0 8 -9 0Z M-9 -7 L9 7" fill="none" stroke="var(--text)" strokeWidth="2.2" strokeLinecap="round" />
          </g>
        )}
      </g>
    );
  },
  (a, b) => drawingKey(a.d) === drawingKey(b.d) && a.clipId === b.clipId && a.d.trail === b.d.trail,
);

/** The fallen first (beneath the living), then the biggest, so small tokens stay on top. */
export function tokenOrder(a: SnapshotToken, b: SnapshotToken): number {
  if (a.defeated !== b.defeated) return a.defeated ? -1 : 1;
  const size = (t: SnapshotToken) => (t.space ? t.space.x1 - t.space.x0 + 1 : 0);
  return size(b) - size(a);
}

/** Tiny creatures sharing a square get quadrants in initiative order (C4). */
export function tinyQuadrants(tokens: readonly SnapshotToken[]): Map<string, number> {
  const bySquare = new Map<string, number>();
  const out = new Map<string, number>();
  for (const t of tokens) {
    if (t.size !== 'Tiny' || !t.space) continue;
    const key = `${t.space.x0},${t.space.y0}`;
    const n = bySquare.get(key) ?? 0;
    bySquare.set(key, n + 1);
    out.set(t.id, n % 4);
  }
  return out;
}
