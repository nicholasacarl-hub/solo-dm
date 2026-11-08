/**
 * The battle map's surface (spec §7.5, §7.9): one tab stop — a role="application" div whose <svg> is aria-hidden,
 * with a drawn keyboard cursor and one polite live region. Pointer gestures go through useMapGestures (native
 * listeners); the keyboard works only while the map has focus, so the composer's caret is never hijacked.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { dirVector, healthDescriptor, squareLabel } from '@/engine';
import type { GridPoint, GridRect } from '@/types';
import { usePlayView } from '../playView';
import { usePrefersReducedMotion } from '../useMediaQuery';
import { portraitDisplay } from '@/ui/components/portrait';
import {
  CELL,
  cameraTransform,
  cellPxOf,
  clampCamera,
  committedCamera,
  defaultCamera,
  liveCamera,
  rectCentre,
  revealRect,
  rulerStep,
  screenToCorner,
  screenToSquare,
  TAP_MIN_CELL_PX,
  TAP_ZOOM_CELL_PX,
  zoomCentre,
  zoomTo,
  fitCellPx,
  fillCamera,
  MAX_CELL_PX,
  MIN_CELL_PX,
  RULER_LEFT,
  RULER_TOP,
  type Camera,
  type MapExtent,
  type Pt,
  type ViewSize,
} from './camera';
import { rectCentreWorld, squareCentre } from './geometry';
import {
  BandsLayer,
  CursorLayer,
  EffectsLayer,
  GridLayer,
  MapDefs,
  MeasureLayer,
  PathLayer,
  PlacesLayer,
  TemplateLayer,
  TerrainLayer,
  ThreatLayer,
  Token,
  templateOutline,
  threatSquares,
  tinyQuadrants,
  tokenOrder,
  useMapIds,
  type TemplateDrawing,
  type TokenDrawing,
} from './layers';
import { measureInfo } from './measure';
import type { BattleMapModel } from './model';
import { mapAccessibleName } from './text';
import { isAimed, isCentred, nudgeTemplate, rotateTemplate } from './templates';
import { useMapGestures } from './useMapGestures';
import type { MapController } from './useMapController';
import type { HealthDescriptor } from './tokenStyle';

export interface MapViewportProps {
  model: BattleMapModel;
  controller: MapController;
  /** BattleMap.id: the camera is kept per map. */
  cameraKey: string;
  /** Phone layout: bigger default squares, centred on the hero. */
  compact: boolean;
  /** The id of the help text that describes the map's keys. */
  helpId: string;
  onHelp(): void;
  onList(): void;
}

/** Imperative handles for the toolbar's zoom buttons. */
export interface MapViewportHandle {
  zoom(factor: number): void;
  fit(): void;
  centre(): void;
  focus(): void;
}

function useViewSize(ref: RefObject<HTMLElement | null>): ViewSize {
  const [size, setSize] = useState<ViewSize>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((s) => (s.width === r.width && s.height === r.height ? s : { width: r.width, height: r.height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

interface RulersHandle {
  update(camera: Camera): void;
}

/** Column letters and row numbers pinned to the top and left edges (outside the camera group). */
const Rulers = forwardRef<RulersHandle, { camera: Camera; extent: MapExtent; size: ViewSize }>(function Rulers({ camera, extent, size }, ref) {
  const cols = useRef<SVGGElement>(null);
  const rows = useRef<SVGGElement>(null);
  const place = useCallback((cam: Camera) => {
    const px = cellPxOf(cam);
    const step = rulerStep(px);
    cols.current?.querySelectorAll('text').forEach((t, i) => {
      const x = cam.x + (i + 0.5) * px;
      t.setAttribute('x', String(x));
      t.style.display = i % step === 0 && x > RULER_LEFT + 4 ? '' : 'none';
    });
    rows.current?.querySelectorAll('text').forEach((t, i) => {
      const y = cam.y + (i + 0.5) * px;
      t.setAttribute('y', String(y));
      t.style.display = i % step === 0 && y > RULER_TOP + 4 ? '' : 'none';
    });
  }, []);
  useImperativeHandle(ref, () => ({ update: place }), [place]);
  useLayoutEffect(() => place(camera), [camera, place, extent.cols, extent.rows]);
  const letters = useMemo(() => Array.from({ length: extent.cols }, (_, x) => squareLabel({ x, y: 0 }).replace(/\d+$/, '')), [extent.cols]);
  return (
    <g className="pointer-events-none select-none" fontSize="11" fontWeight="600" fill="var(--muted)">
      <rect width={size.width} height={RULER_TOP} fill="var(--surface)" opacity="0.9" />
      <rect width={RULER_LEFT} height={size.height} fill="var(--surface)" opacity="0.9" />
      <g ref={cols}>
        {letters.map((l) => (
          <text key={l} y="12" textAnchor="middle">
            {l}
          </text>
        ))}
      </g>
      <g ref={rows}>
        {Array.from({ length: extent.rows }, (_, y) => (
          <text key={y} x="11" textAnchor="middle" dominantBaseline="central" className="tabular-nums">
            {y + 1}
          </text>
        ))}
      </g>
    </g>
  );
});

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** Focus that came from the keyboard (where :focus-visible can't be asked, assume it did). */
function focusVisible(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

function clampPoint(p: GridPoint, extent: MapExtent): GridPoint {
  return { x: Math.min(extent.cols - 1, Math.max(0, p.x)), y: Math.min(extent.rows - 1, Math.max(0, p.y)) };
}

function anchorOf(rect: GridRect | null | undefined): GridPoint | null {
  return rect ? { x: rect.x0, y: rect.y0 } : null;
}

export const MapViewport = forwardRef<MapViewportHandle, MapViewportProps>(function MapViewport(
  { model, controller, cameraKey, compact, helpId, onHelp, onList },
  ref,
) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const groupRef = useRef<SVGGElement>(null);
  const rulersRef = useRef<RulersHandle>(null);
  const ids = useMapIds();
  const reducedMotion = usePrefersReducedMotion();
  const size = useViewSize(wrapRef);
  const map = model.map;
  const extent = useMemo<MapExtent>(() => ({ cols: map.width, rows: map.height }), [map.width, map.height]);
  const stored = usePlayView((s) => s.cameras[cameraKey]);
  const highlightedId = usePlayView((s) => s.highlightedId);
  const heroRect = model.heroToken?.space ?? null;
  const hasSize = size.width > 0 && size.height > 0;
  const committed = useMemo(() => stored ?? defaultCamera(extent, size, heroRect, compact), [stored, extent, size, heroRect, compact]);
  const camera = useMemo(() => liveCamera(committed, size), [committed, size]);
  const cellPx = cellPxOf(camera);
  const { ui, dispatch } = controller;

  const setCamera = useCallback((cam: Camera) => {
    if (!hasSize) return;
    usePlayView.getState().setCamera(cameraKey, committedCamera(clampCamera(cam, extent, size), size));
  }, [cameraKey, extent, size, hasSize]);

  // Keep the opening camera once the viewport has a size, so it doesn't follow the hero around afterwards.
  useEffect(() => {
    if (!stored && hasSize) usePlayView.getState().setCamera(cameraKey, committed);
  }, [stored, hasSize, cameraKey, committed]);

  const pointToSquare = useCallback((at: Pt, cam: Camera) => screenToSquare(cam, at.x, at.y, extent), [extent]);

  const live = useMapGestures(svgRef, groupRef, {
    extent,
    camera,
    viewSize: () => size,
    onFrame: (cam) => rulersRef.current?.update(cam),
    onCommit: setCamera,
    onTap: (at, pointer) => {
      const cam = live.current;
      const square = pointToSquare(at, cam);
      if (!square) return;
      // Squares too small to hit reliably: zoom in toward the tap instead of acting on it.
      if (cellPxOf(cam) < TAP_MIN_CELL_PX) {
        setCamera(zoomTo(cam, TAP_ZOOM_CELL_PX, at.x, at.y));
        return;
      }
      controller.tap(square, screenToCorner(cam, at.x, at.y, extent), pointer);
    },
    onLongPress: (at) => {
      const square = pointToSquare(at, live.current);
      if (square) controller.inspectAt(square);
    },
    onContextMenu: (at) => {
      const square = pointToSquare(at, live.current);
      if (square) controller.inspectAt(square);
    },
    onHover: (at) => controller.hoverAt(at ? pointToSquare(at, live.current) : null),
  });

  const zoom = useCallback((factor: number) => {
    if (!hasSize) return;
    usePlayView.getState().setCamera(cameraKey, zoomCentre(committed, factor));
  }, [cameraKey, committed, hasSize]);
  const fit = useCallback(() => {
    if (!hasSize) return;
    const px = Math.max(MIN_CELL_PX, Math.min(MAX_CELL_PX, fitCellPx(extent, size)));
    usePlayView.getState().setCamera(cameraKey, fillCamera({ cellPx: px, cx: extent.cols / 2, cy: extent.rows / 2 }, extent, size));
  }, [cameraKey, extent, size, hasSize]);
  const centre = useCallback(() => {
    if (!hasSize || !heroRect) return;
    const c = rectCentre(heroRect);
    usePlayView.getState().setCamera(cameraKey, fillCamera({ cellPx: committed.cellPx, cx: c.x, cy: c.y }, extent, size));
  }, [cameraKey, committed.cellPx, heroRect, hasSize, extent, size]);
  useImperativeHandle(ref, () => ({ zoom, fit, centre, focus: () => wrapRef.current?.focus() }), [zoom, fit, centre]);

  // The camera follows the keyboard cursor (and "Show on map" from the tracker, which sets it).
  const cursor = ui.cursor;
  useEffect(() => {
    if (!cursor || !hasSize) return;
    const cam = usePlayView.getState().cameras[cameraKey] ?? committed;
    const next = revealRect(cam, size, extent, { x0: cursor.x, y0: cursor.y, x1: cursor.x, y1: cursor.y }, Math.min(40, cam.cellPx));
    if (next !== cam) usePlayView.getState().setCamera(cameraKey, next);
    // Only when the cursor moves (or the viewport first gets a size).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor?.x, cursor?.y, hasSize]);

  // At the hero's turn start, bring the hero back on screen if it is off it.
  const turnKey = `${model.view.round}:${model.yourTurn}`;
  useEffect(() => {
    if (!model.yourTurn || !heroRect || !hasSize) return;
    const cam = usePlayView.getState().cameras[cameraKey] ?? committed;
    const next = revealRect(cam, size, extent, heroRect);
    if (next !== cam) usePlayView.getState().setCamera(cameraKey, next);
    // Only at the turn change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnKey, hasSize]);

  const heroAnchor = anchorOf(heroRect);
  // The keyboard cursor shows only while the keyboard is in use (data-keyboard; see index.css): a click focuses the
  // map too, and pointer users shouldn't get a stray outline.
  const onFocus = () => {
    const el = wrapRef.current;
    if (!ui.cursor && heroAnchor && el && focusVisible(el)) {
      el.dataset.keyboard = 'true';
      dispatch({ type: 'cursor', at: heroAnchor });
    }
  };
  const onPointerDown = () => {
    if (wrapRef.current) delete wrapRef.current.dataset.keyboard;
  };

  const tokenList = useMemo(() => model.snapshot.tokens.filter((t) => t.space), [model.snapshot.tokens]);
  const cycle = (step: 1 | -1) => {
    const living = tokenList.filter((t) => !t.defeated);
    if (living.length === 0) return;
    const at = ui.cursor;
    const i = at ? living.findIndex((t) => t.space && at.x >= t.space.x0 && at.x <= t.space.x1 && at.y >= t.space.y0 && at.y <= t.space.y1) : -1;
    const next = living[(i + step + living.length) % living.length];
    const a = anchorOf(next.space);
    if (a) dispatch({ type: 'cursor', at: a });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.altKey || e.metaKey) return;
    e.currentTarget.dataset.keyboard = 'true';
    const at = ui.cursor ?? heroAnchor ?? { x: 0, y: 0 };
    const arrow = ARROWS[e.key];
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (arrow && !e.ctrlKey) {
      const n = e.shiftKey ? 5 : 1;
      const [dx, dy] = arrow;
      if (ui.mode === 'area' && ui.template && isCentred(ui.template)) {
        const t = nudgeTemplate(ui.template, dx * n, dy * n, extent);
        dispatch({ type: 'template', template: t });
      }
      dispatch({ type: 'cursor', at: clampPoint({ x: at.x + dx * n, y: at.y + dy * n }, extent) });
      return handled();
    }
    const key = e.key;
    if (key === 'Home' || key === 'End') {
      const end = key === 'End';
      dispatch({ type: 'cursor', at: e.ctrlKey ? (end ? { x: extent.cols - 1, y: extent.rows - 1 } : { x: 0, y: 0 }) : { x: end ? extent.cols - 1 : 0, y: at.y } });
      return handled();
    }
    if (key === 'PageUp' || key === 'PageDown') {
      const rows = Math.max(1, Math.floor(size.height / Math.max(1, cellPx)) - 1);
      dispatch({ type: 'cursor', at: clampPoint({ x: at.x, y: at.y + (key === 'PageDown' ? rows : -rows) }, extent) });
      return handled();
    }
    if (e.ctrlKey) return;
    if (key === 'Enter' || key === ' ') {
      controller.tap(at, { x: at.x + 1, y: at.y + 1 }, 'keyboard');
      if (!ui.cursor) dispatch({ type: 'cursor', at });
      return handled();
    }
    if (key === 'Escape') {
      dispatch({ type: 'escape' });
      return handled();
    }
    const lower = key.toLowerCase();
    switch (lower) {
      case 'n':
        cycle(e.shiftKey ? -1 : 1);
        return handled();
      case 'h':
        if (heroAnchor) dispatch({ type: 'cursor', at: heroAnchor });
        return handled();
      case 't': {
        const a = anchorOf(model.currentId ? model.tokens.get(model.currentId)?.space : null);
        if (a) dispatch({ type: 'cursor', at: a });
        return handled();
      }
      case 'v':
        dispatch({ type: 'mode', mode: 'move' });
        return handled();
      case 'm':
        dispatch({ type: 'mode', mode: 'measure' });
        return handled();
      case 'a':
        dispatch({ type: 'mode', mode: 'area' });
        return handled();
      case 'r':
        if (ui.template && isAimed(ui.template)) dispatch({ type: 'template', template: rotateTemplate(ui.template, e.shiftKey ? -1 : 1, heroRect) });
        return handled();
      case 'd':
        if (ui.plan) dispatch({ type: 'plan-option', patch: { dash: !ui.plan.dash } });
        return handled();
      case 'g':
        if (ui.plan) dispatch({ type: 'plan-option', patch: { disengage: !ui.plan.disengage } });
        return handled();
      case 'u':
        if (model.canUndo) controller.undo();
        return handled();
      case '+':
      case '=':
        zoom(1.25);
        return handled();
      case '-':
      case '_':
        zoom(0.8);
        return handled();
      case '0':
        fit();
        return handled();
      case 'c':
        centre();
        return handled();
      case 'l':
        onList();
        return handled();
      case '?':
        onHelp();
        return handled();
    }
  };

  const showLabels = cellPx >= 20;
  const showTerrainLabels = cellPx >= 30;
  const quadrants = useMemo(() => tinyQuadrants(tokenList), [tokenList]);
  const unseenTrail = model.unseenMoves.at(-1)?.path ?? null;

  const drawings = useMemo(() => {
    const draw = (t: (typeof tokenList)[number], secret: boolean): TokenDrawing => {
      const c = secret ? undefined : model.combatants.get(t.id);
      const hp = t.isHero ? model.hero.hp : (c?.hp ?? null);
      // Exact HP the player may see (the hero, allies, creatures without hideHp): the arc as well as the glyph.
      const showArc = !secret && (t.isHero || (!!hp && c?.hideHp !== true));
      const descriptor: HealthDescriptor | null = secret ? null : t.defeated ? 'down' : hp ? healthDescriptor(hp) : null;
      const conditions = secret
        ? []
        : t.isHero
          ? [...model.hero.conditions, ...(model.hero.exhaustion ? [{ id: 'exhaustion', level: model.hero.exhaustion }] : [])]
          : (c?.conditions ?? []);
      return {
        token: t,
        combatant: c,
        label: (secret ? model.secretLabels : model.labels).get(t.id) ?? '?',
        portrait: t.isHero ? portraitDisplay(model.hero.portrait) : null,
        hp,
        showArc,
        descriptor,
        conditions,
        current: !secret && t.id === model.currentId,
        selected: !secret && ((ui.inspect?.kind === 'token' && ui.inspect.id === t.id) || (ui.mode === 'measure' && !!ui.measure && 'id' in ui.measure.from && ui.measure.from.id === t.id)),
        highlighted: !secret && t.id === highlightedId,
        secret,
        quadrant: quadrants.get(t.id) ?? 0,
        showLabels,
        trail: t.isHero ? unseenTrail : null,
        reducedMotion,
      };
    };
    return [...[...tokenList].sort(tokenOrder).map((t) => draw(t, false)), ...model.secretTokens.map((t) => draw(t, true))];
  }, [tokenList, model, ui.inspect, ui.mode, ui.measure, highlightedId, quadrants, showLabels, unseenTrail, reducedMotion]);

  const planning = ui.mode === 'move' && model.canMove && (ui.plan !== null || controller.hoverPreview !== null);
  const threats = useMemo(() => {
    if (!planning) return [];
    return tokenList
      .filter((t) => t.side === 'enemy' && !t.defeated)
      .map((t) => threatSquares(t, model.cells, extent.cols, extent.rows))
      .filter((s) => s.length > 0);
  }, [planning, tokenList, model.cells, extent]);

  const template = useMemo((): TemplateDrawing | null => {
    const t = ui.template;
    const result = controller.area?.result;
    if (ui.mode !== 'area' || !t || !result) return null;
    const squares = result.squares.flatMap((r) => {
      const out: GridPoint[] = [];
      for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) out.push({ x, y });
      return out;
    });
    const heroCentre = heroRect ? rectCentreWorld(heroRect) : null;
    const at = t.spec.at;
    const centreAt = at?.kind === 'square' ? squareCentre(at.at) : at?.kind === 'corner' ? { x: at.x * CELL, y: at.y * CELL } : null;
    const toward = t.spec.toward;
    const aim =
      toward?.kind === 'square'
        ? squareCentre(toward.at)
        : toward?.kind === 'direction' && heroCentre
          ? { x: heroCentre.x + dirVector(toward.dir).dx * CELL, y: heroCentre.y + dirVector(toward.dir).dy * CELL }
          : null;
    const casterSquares = heroRect ? heroRect.x1 - heroRect.x0 + 1 : 1;
    const outline = templateOutline(t.spec.shape, centreAt ?? heroCentre, aim, t.spec.sizeFt ?? 5, t.spec.widthFt ?? 5, casterSquares);
    return { squares, outline, centre: centreAt };
  }, [ui.mode, ui.template, controller.area, heroRect]);

  const measure = ui.mode === 'measure' ? measureInfo(model, ui.measure ?? (heroAnchor ? { from: { id: model.heroId }, to: null } : null), ui.hover) : null;
  const preview = controller.preview ?? controller.hoverPreview;

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      role="application"
      aria-roledescription="battle map"
      aria-label={mapAccessibleName(map)}
      aria-describedby={helpId}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onPointerDownCapture={onPointerDown}
      className="map-surface relative h-full w-full overflow-hidden bg-[var(--map-floor)] outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ring)]"
    >
      <svg ref={svgRef} aria-hidden="true" width="100%" height="100%" className="absolute inset-0 block" style={{ fontFamily: 'var(--font-sans)' }}>
        <MapDefs ids={ids} />
        <g ref={groupRef} transform={cameraTransform(camera)}>
          <TerrainLayer map={map} ids={ids} labels={showTerrainLabels} />
          <GridLayer cols={map.width} rows={map.height} />
          <PlacesLayer places={map.places} cols={map.width} rows={map.height} labels={showLabels} />
          <EffectsLayer effects={model.snapshot.effects} cols={map.width} rows={map.height} ids={ids} labels={showLabels} />
          {ui.mode === 'move' && model.canMove && model.reachable.length > 0 && <BandsLayer reachable={model.reachable} ids={ids} />}
          {threats.length > 0 && <ThreatLayer threats={threats} />}
          {template && <TemplateLayer drawing={template} />}
          {drawings.map((d) => (
            <Token key={`${d.secret ? 's' : 't'}-${d.token.id}`} d={d} clipId={`${ids.prefix}-portrait-${d.token.id}`} />
          ))}
          {preview && heroRect && ui.mode === 'move' && (
            <PathLayer preview={preview} from={heroRect} faint={!controller.preview} size={heroRect.x1 - heroRect.x0 + 1} />
          )}
          {measure && <MeasureLayer from={measure.from} to={measure.to} label={measure.label} />}
          {ui.cursor && <CursorLayer at={ui.cursor} />}
        </g>
        {hasSize && <Rulers ref={rulersRef} camera={camera} extent={extent} size={size} />}
      </svg>
      <div aria-live="polite" className="sr-only">
        {controller.announcement}
      </div>
    </div>
  );
});
