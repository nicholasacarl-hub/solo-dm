/**
 * The battle map's chrome: the turn pill (whose turn it is as the player sees it, D42, and Stand up while Prone),
 * the toolbar (Move | Measure | Area, the list view, the key and help, and on desktop the dock's size), and the
 * zoom / fit / centre buttons — the full non-gesture path (WCAG 2.5.1, 2.5.7).
 */
import { memo } from 'react';
import { ChevronUp, Ellipsis, Footprints, List, LocateFixed, Map as MapIcon, Maximize2, Minimize2, Minus, Plus, Radius, Ruler, Scan } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Badge, Button, IconButton, Segmented } from '@/ui/components/ui';
import { Popover } from '../components/Popover';
import type { MapMode } from '../playView';
import { useIsTouch } from '../useMediaQuery';
import { MapKey } from './MapHelp';
import type { BattleMapModel } from './model';
import { turnPillText } from './text';

export const TurnPill = memo(function TurnPill({ model, onStandUp }: { model: BattleMapModel; onStandUp(): void }) {
  const touch = useIsTouch();
  const currentName = model.currentId ? (model.combatants.get(model.currentId)?.name ?? null) : null;
  // Whose turn the player's view shows (D42): a hidden creature's turn never changes it.
  const text = turnPillText({ yourTurn: model.yourTurn, currentName, budget: model.budget });
  const b = model.budget;
  const canStand = model.canMove && b !== null && b.prone && !b.stoodUp && !b.speedZero;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span
        className={cn(
          'inline-flex min-w-0 items-center rounded-full px-3 py-1 text-sm font-semibold whitespace-nowrap',
          model.yourTurn ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted',
        )}
      >
        <span className="truncate">{text}</span>
      </span>
      {model.heroToken?.reactionUsed && <Badge tone="danger">Reaction used</Badge>}
      {canStand && (
        <Button size={touch ? 'md' : 'sm'} variant="secondary" onClick={onStandUp} disabled={b.leftFt < b.standCostFt}>
          Stand up · {b.standCostFt} ft
        </Button>
      )}
    </div>
  );
});

const MODES: { value: MapMode; label: string; key: string; Icon: typeof Footprints }[] = [
  { value: 'move', label: 'Move', key: 'V', Icon: Footprints },
  { value: 'measure', label: 'Measure', key: 'M', Icon: Ruler },
  { value: 'area', label: 'Area', key: 'A', Icon: Radius },
];

export const MapToolbar = memo(function MapToolbar({
  mode,
  onMode,
  variant,
  size,
  onSize,
  onCollapse,
  onList,
  onHelp,
  listOn = false,
}: {
  mode: MapMode;
  onMode(m: MapMode): void;
  variant: 'dock' | 'tab';
  size?: 'normal' | 'large';
  onSize?(): void;
  onCollapse?(): void;
  onList(): void;
  onHelp(): void;
  listOn?: boolean;
}) {
  const touch = useIsTouch();
  const iconOnly = variant === 'tab';
  const buttonSize = touch ? 'lg' : 'sm';
  // Phones keep the pill and the toolbar on one row (spec §7.1): the list view moves into the ⋯ menu, except while
  // it is open (its way back to the map stays in sight).
  const listInMenu = variant === 'tab' && !listOn;
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Segmented
        size="sm"
        value={mode}
        onChange={onMode}
        className={touch ? '[&_button]:min-h-10 [&_button]:min-w-11' : undefined}
        options={MODES.map(({ value, label, key, Icon }) => ({
          value,
          title: `${label} (${key})`,
          label: (
            <span className="inline-flex items-center gap-1">
              <Icon className="size-4" aria-hidden />
              <span className={iconOnly ? 'sr-only' : undefined}>{label}</span>
            </span>
          ),
        }))}
      />
      {!listInMenu && (
        <IconButton
          label={listOn ? 'Show the map' : 'List positions'}
          aria-pressed={listOn}
          size={buttonSize}
          onClick={onList}
          className={listOn ? 'bg-surface-2 text-text' : undefined}
        >
          {listOn ? <MapIcon className="size-4" aria-hidden /> : <List className="size-4" aria-hidden />}
        </IconButton>
      )}
      <Popover
        label="Map key"
        placement="bottom-end"
        className="w-80 max-w-[calc(100vw-2rem)]"
        trigger={(props) => (
          <IconButton {...props} label={listInMenu ? 'List, key and help' : 'Map key and help'} size={buttonSize}>
            <Ellipsis className="size-4" aria-hidden />
          </IconButton>
        )}
      >
        {(close) => (
          <div className="flex flex-col gap-3">
            {listInMenu && (
              <Button
                size={touch ? 'lg' : 'sm'}
                variant="secondary"
                icon={<List className="size-4" aria-hidden />}
                onClick={() => {
                  close();
                  onList();
                }}
              >
                List positions
              </Button>
            )}
            <MapKey />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                close();
                onHelp();
              }}
            >
              Keys and help
            </Button>
          </div>
        )}
      </Popover>
      {variant === 'dock' && onSize && (
        <IconButton label={size === 'large' ? 'Smaller map' : 'Larger map'} size={buttonSize} onClick={onSize}>
          {size === 'large' ? <Minimize2 className="size-4" aria-hidden /> : <Maximize2 className="size-4" aria-hidden />}
        </IconButton>
      )}
      {variant === 'dock' && onCollapse && (
        <IconButton label="Collapse the map" size={buttonSize} onClick={onCollapse}>
          <ChevronUp className="size-4" aria-hidden />
        </IconButton>
      )}
    </div>
  );
});

export const ZoomControls = memo(function ZoomControls({
  onZoom,
  onFit,
  onCenter,
  layout = 'column',
}: {
  onZoom(factor: number): void;
  onFit(): void;
  onCenter(): void;
  /** A row in the desktop dock (short), a column on phones. */
  layout?: 'row' | 'column';
}) {
  const touch = useIsTouch();
  // The non-gesture path (WCAG 2.5.1, 2.5.7): 48px on touch screens, 40px with a mouse.
  const size = touch ? 'lg' : 'md';
  const button = 'border border-border bg-surface/90 text-text shadow-card hover:bg-surface-2';
  return (
    <div className={cn('pointer-events-auto flex gap-1.5', layout === 'column' ? 'flex-col' : 'flex-row')} role="group" aria-label="Zoom">
      <IconButton label="Zoom in" size={size} className={button} onClick={() => onZoom(1.25)}>
        <Plus className="size-4" aria-hidden />
      </IconButton>
      <IconButton label="Zoom out" size={size} className={button} onClick={() => onZoom(0.8)}>
        <Minus className="size-4" aria-hidden />
      </IconButton>
      <IconButton label="Fit the map" size={size} className={button} onClick={onFit}>
        <Scan className="size-4" aria-hidden />
      </IconButton>
      <IconButton label="Centre on you" size={size} className={button} onClick={onCenter}>
        <LocateFixed className="size-4" aria-hidden />
      </IconButton>
    </div>
  );
});
