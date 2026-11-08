/**
 * The battle map's container: store → model (the player view) → controller → viewport and chrome. `dock` is the
 * desktop panel above the story (the action bar in a fixed strip under the map, growing up over it when taller, the
 * zoom buttons in a lane at the right that the bar keeps clear); `tab` is the phone Combat tab's section (pill, map,
 * action bar stacked; side by side in phone landscape, by CSS only).
 */
import { useCallback, useId, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import type { GridPoint, MapRef } from '@/types';
import { usePlayView, type MapMode } from '../playView';
import { useIsTouch } from '../useMediaQuery';
import type { AreaPreset } from './areaPresets';
import { SpellAreaPicker } from './AreaPicker';
import { MapActionBar } from './MapActionBar';
import { MapHelpDialog } from './MapHelp';
import { MapToolbar, TurnPill, ZoomControls, zoomControlsInset } from './MapToolbar';
import { MapViewport, type MapViewportHandle } from './MapViewport';
import { useBattleMapModel, type BattleMapModel } from './model';
import { PositionsList } from './PositionsList';
import { approachSquare } from './preview';
import { templateFromPreset } from './templates';
import { useFocusReturn } from './useFocusReturn';
import { useMapController } from './useMapController';

const HELP_TEXT =
  'Arrow keys move the cursor; Enter plans a move to it and Enter again makes it; Escape cancels. N goes to the next creature, H to you. Press question mark for every key.';

export function BattleMapPanel({ variant }: { variant: 'dock' | 'tab' }) {
  const model = useBattleMapModel();
  if (!model) return null;
  return <PanelBody model={model} variant={variant} />;
}

function PanelBody({ model, variant }: { model: BattleMapModel; variant: 'dock' | 'tab' }) {
  const controller = useMapController(model);
  const { ui, dispatch } = controller;
  const viewport = useRef<MapViewportHandle>(null);
  const area = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const [helpOpen, setHelpOpen] = useState(false);
  const mapList = usePlayView((s) => s.mapList);
  const dock = usePlayView((s) => s.mapDock);
  const touch = useIsTouch();

  // Stable handlers: the chrome (toolbar, zoom buttons, pill) is memoized and must not re-render on every hovered
  // square (spec §7.12: hover re-renders only the path, the bands and the bar).
  const toggleList = useCallback(() => usePlayView.getState().setMapList(!usePlayView.getState().mapList), []);
  const openHelp = useCallback(() => setHelpOpen(true), []);
  const onMode = useCallback((mode: MapMode) => dispatch({ type: 'mode', mode }), [dispatch]);
  const onSize = useCallback(() => {
    const view = usePlayView.getState();
    view.setMapDock(view.mapDock === 'large' ? 'normal' : 'large');
  }, []);
  const onCollapse = useCallback(() => usePlayView.getState().setMapDock('collapsed'), []);
  const onZoom = useCallback((factor: number) => viewport.current?.zoom(factor), []);
  const onFit = useCallback(() => viewport.current?.fit(), []);
  const onCenter = useCallback(() => viewport.current?.centre(), []);
  // The bar's buttons replace the bar (Move, Cancel, Undo, a card's Close…): focus goes back to the map, or to the
  // list while it is open, instead of falling to the page (U1).
  const refocus = useCallback(() => {
    if (viewport.current) viewport.current.focus();
    else area.current?.querySelector<HTMLElement>('[data-map-part="list"]')?.focus({ preventScroll: true });
  }, []);
  useFocusReturn(barRef, refocus);
  const showOnMap = (id: string) => {
    const t = model.tokens.get(id);
    const view = usePlayView.getState();
    view.setHighlighted(id);
    if (t?.space) dispatch({ type: 'cursor', at: { x: t.space.x0, y: t.space.y0 } });
    view.setMapList(false);
  };
  // The list's Move to square commits exactly what its readout previewed (the default options): an earlier plan's
  // Disengage, Dash, Stand up or route choice must not ride along (U3).
  const moveTo = (square: GridPoint) => {
    dispatch({ type: 'cancel' });
    dispatch({ type: 'plan-to', to: square });
    dispatch({ type: 'confirm' });
  };
  const moveNextTo = (id: string) => {
    const at = approachSquare(model, id, ui.plan ?? { prefer: 'safest', dash: false, disengage: false, standUp: false });
    if (at) dispatch({ type: 'plan-to', to: at, target: id });
  };
  const pick = (preset: AreaPreset) => {
    const cam = usePlayView.getState().cameras[model.cameraKey];
    const heroAt = model.heroToken?.space ? { x: model.heroToken.space.x0, y: model.heroToken.space.y0 } : { x: 0, y: 0 };
    const centre = cam
      ? { x: Math.min(model.map.width - 1, Math.max(0, Math.floor(cam.cx))), y: Math.min(model.map.height - 1, Math.max(0, Math.floor(cam.cy))) }
      : heroAt;
    const nearest = model.snapshot.tokens
      .filter((t) => t.side === 'enemy' && !t.defeated && t.space && t.distanceFromHeroFt !== null)
      .sort((a, b) => (a.distanceFromHeroFt ?? 0) - (b.distanceFromHeroFt ?? 0))[0];
    const aim: MapRef = nearest?.space ? { kind: 'square', at: { x: nearest.space.x0, y: nearest.space.y0 } } : { kind: 'direction', dir: 'east' };
    dispatch({ type: 'template', template: templateFromPreset(preset, { heroId: model.heroId, centre, aim }) });
  };

  /** The zoom buttons' lane down the map's right edge, which the cameras the app chooses keep clear (E3). */
  const lane = zoomControlsInset(touch);
  // Bottom-right. In the dock they sit above the action bar's strip and its overflow (z-20 over its z-10), in a lane
  // the bar's content keeps clear, so a tall bar (a card, a plan with chips) never hides them or goes under them.
  const zoomControls = mapList ? null : (
    <div className={cn('pointer-events-none absolute right-2 bottom-2 flex flex-col', variant === 'dock' && 'z-20')}>
      <ZoomControls onZoom={onZoom} onFit={onFit} onCenter={onCenter} />
    </div>
  );

  const viewportArea = mapList ? (
    <PositionsList model={model} onShow={showOnMap} onMoveTo={moveTo} onMoveNextTo={moveNextTo} />
  ) : (
    <>
      <MapViewport
        ref={viewport}
        model={model}
        controller={controller}
        cameraKey={model.cameraKey}
        compact={variant === 'tab'}
        helpId={helpId}
        onHelp={openHelp}
        onList={toggleList}
        controlsInset={lane}
      />
      {variant === 'tab' && zoomControls}
    </>
  );

  const bar = <MapActionBar model={model} controller={controller} variant={variant} />;

  return (
    <div data-map-part="panel" className={cn('flex min-h-0 flex-col', variant === 'dock' && 'relative h-full')}>
      <div data-map-part="head" className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-border bg-surface px-3 py-1.5">
        <TurnPill model={model} onStandUp={controller.standUp} />
        <MapToolbar
          mode={ui.mode}
          onMode={onMode}
          variant={variant}
          size={dock === 'large' ? 'large' : 'normal'}
          onSize={variant === 'dock' ? onSize : undefined}
          onCollapse={variant === 'dock' ? onCollapse : undefined}
          onList={toggleList}
          onHelp={openHelp}
          listOn={mapList}
        />
      </div>
      <div
        ref={area}
        data-map-part="viewport"
        className={cn('relative min-h-0 overflow-hidden', variant === 'dock' ? 'flex-1' : 'h-[min(calc(100vw-24px),58dvh)] shrink-0')}
      >
        {viewportArea}
      </div>
      {variant === 'dock' ? (
        // Desktop: below the map in a strip of fixed height, so the map keeps its size whatever the bar holds — a
        // map that shrank and grew with the bar would shift under the pointer, and an opening fit would stop fitting
        // (E2). A bar taller than the strip (a card, a plan with chips) grows up over the map's bottom edge instead.
        <div data-map-part="strip" className="relative h-14 shrink-0">
          <div
            className="absolute inset-x-0 bottom-0 z-10 flex max-h-44 min-h-full flex-col overflow-y-auto border-t border-border bg-surface px-3 py-2 scroll-thin"
            style={zoomControls ? { paddingRight: lane } : undefined}
          >
            <div ref={barRef} data-map-part="bar" className="@container my-auto">
              {bar}
            </div>
          </div>
        </div>
      ) : (
        // Phones: below the map, never over it (portrait), or in the side column (landscape, index.css).
        <div ref={barRef} data-map-part="bar" className="@container border-b border-border bg-surface px-3 py-2 empty:hidden">
          {bar}
        </div>
      )}
      {variant === 'dock' && zoomControls}
      <p id={helpId} className="sr-only">
        {HELP_TEXT}
      </p>
      {/* The map's one polite live region (spec §7.9), here so it serves the list view too (U2): moves, stops and
          turn starts are announced whichever view is open. */}
      <div aria-live="polite" className="sr-only" data-map-part="live">
        {controller.announcement}
      </div>
      {/* Mounted only while open: "Your spells" needs the rules index, which isn't worth building for every fight. */}
      {ui.picker && <SpellAreaPicker hero={model.hero} onPick={pick} onClose={() => dispatch({ type: 'picker', open: false })} />}
      {helpOpen && <MapHelpDialog open onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
