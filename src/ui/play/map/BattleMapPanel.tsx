/**
 * The battle map's container: store → model (the player view) → controller → viewport and chrome. `dock` is the
 * desktop panel above the story (the action bar floats over the map); `tab` is the phone Combat tab's section (pill,
 * map, action bar stacked; side by side in phone landscape, by CSS only).
 */
import { useId, useRef, useState } from 'react';
import { useRulesIndex } from '@/data';
import { cn } from '@/lib/cn';
import type { GridPoint, MapRef } from '@/types';
import { usePlayView } from '../playView';
import { spellPresets, type AreaPreset } from './areaPresets';
import { AreaPicker } from './AreaPicker';
import { MapActionBar } from './MapActionBar';
import { MapHelpDialog } from './MapHelp';
import { MapToolbar, TurnPill, ZoomControls } from './MapToolbar';
import { MapViewport, type MapViewportHandle } from './MapViewport';
import { useBattleMapModel, type BattleMapModel } from './model';
import { PositionsList } from './PositionsList';
import { approachSquare } from './preview';
import { templateFromPreset } from './templates';
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
  const helpId = useId();
  const [helpOpen, setHelpOpen] = useState(false);
  const mapList = usePlayView((s) => s.mapList);
  const dock = usePlayView((s) => s.mapDock);
  const index = useRulesIndex();
  const presets: AreaPreset[] = spellPresets(model.hero, index);

  const toggleList = () => usePlayView.getState().setMapList(!usePlayView.getState().mapList);
  const showOnMap = (id: string) => {
    const t = model.tokens.get(id);
    const view = usePlayView.getState();
    view.setHighlighted(id);
    if (t?.space) dispatch({ type: 'cursor', at: { x: t.space.x0, y: t.space.y0 } });
    view.setMapList(false);
  };
  const moveTo = (square: GridPoint) => {
    dispatch({ type: 'plan-to', to: square });
    dispatch({ type: 'confirm' });
  };
  const moveNextTo = (id: string) => {
    const at = approachSquare(model, id, ui.plan ?? { prefer: 'safest', dash: false, disengage: false, standUp: false });
    if (at) dispatch({ type: 'plan-to', to: at, target: id });
  };
  const pick = (preset: AreaPreset) => {
    const cam = usePlayView.getState().cameras[model.map.id];
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

  const viewportArea = mapList ? (
    <PositionsList model={model} onShow={showOnMap} onMoveTo={moveTo} onMoveNextTo={moveNextTo} />
  ) : (
    <>
      <MapViewport
        ref={viewport}
        model={model}
        controller={controller}
        cameraKey={model.map.id}
        compact={variant === 'tab'}
        helpId={helpId}
        onHelp={() => setHelpOpen(true)}
        onList={toggleList}
      />
      <div className="pointer-events-none absolute right-2 bottom-2 flex flex-col">
        <ZoomControls
          layout={variant === 'dock' ? 'row' : 'column'}
          onZoom={(f) => viewport.current?.zoom(f)}
          onFit={() => viewport.current?.fit()}
          onCenter={() => viewport.current?.centre()}
        />
      </div>
    </>
  );

  const bar = <MapActionBar model={model} controller={controller} variant={variant} />;

  return (
    <div data-map-part="panel" className={cn('flex min-h-0 flex-col', variant === 'dock' && 'h-full')}>
      <div data-map-part="head" className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-border bg-surface px-3 py-1.5">
        <TurnPill model={model} onStandUp={controller.standUp} />
        <MapToolbar
          mode={ui.mode}
          onMode={(mode) => dispatch({ type: 'mode', mode })}
          variant={variant}
          size={dock === 'large' ? 'large' : 'normal'}
          onSize={variant === 'dock' ? () => usePlayView.getState().setMapDock(dock === 'large' ? 'normal' : 'large') : undefined}
          onCollapse={variant === 'dock' ? () => usePlayView.getState().setMapDock('collapsed') : undefined}
          onList={toggleList}
          onHelp={() => setHelpOpen(true)}
          listOn={mapList}
        />
      </div>
      <div
        data-map-part="viewport"
        className={cn('relative min-h-0 overflow-hidden', variant === 'dock' ? 'flex-1' : 'h-[min(calc(100vw-24px),58dvh)] shrink-0')}
      >
        {viewportArea}
      </div>
      {/* Below the map, never over it: a plan's destination is never hidden under its own readout. */}
      <div data-map-part="bar" className={cn('border-border bg-surface px-3 py-2 empty:hidden', variant === 'dock' ? 'border-t' : 'border-b')}>
        {bar}
      </div>
      <p id={helpId} className="sr-only">
        {HELP_TEXT}
      </p>
      <AreaPicker open={ui.picker} presets={presets} onPick={pick} onClose={() => dispatch({ type: 'picker', open: false })} />
      <MapHelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
