/**
 * Area templates (D64): the picker ("Your spells" from the sheet's prepared spells, and Custom) and the bar that
 * places a template without dragging — tap or Snap: corner for a centre, Rotate for an aim, nudge buttons — and
 * reads out who it catches on the player's map. Add to message appends exactly one [Area: …] line (D50).
 */
import { useId, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, MessageSquareText, RotateCcw, RotateCw, X } from 'lucide-react';
import { Button, Dialog, IconButton, Input, Segmented, Select } from '@/ui/components/ui';
import { useIsTouch } from '../useMediaQuery';
import { CUSTOM_SIZES, customPreset, SHAPE_LABEL, TEMPLATE_SHAPES, type AreaPreset, type TemplateShape } from './areaPresets';
import type { BattleMapModel } from './model';
import { areaReadout } from './text';
import { isAimed, isCentred, nudgeTemplate, rotateTemplate, snapTemplate, templateLine } from './templates';
import type { MapController } from './useMapController';

/** "20-ft sphere · range 150 ft", "15-ft cone from you", "100-ft line, 5 ft wide from you". */
export function presetSummary(p: AreaPreset): string {
  const size = `${p.sizeFt}-ft ${p.shape}${p.shape === 'line' ? `, ${p.widthFt ?? 5} ft wide` : ''}`;
  if (p.shape === 'emanation') return `${size} around you`;
  if (p.fromSelf) return `${size} from you`;
  return p.rangeFt ? `${size} · range ${p.rangeFt} ft` : size;
}

export function AreaPicker({ open, presets, onPick, onClose }: { open: boolean; presets: AreaPreset[]; onPick(p: AreaPreset): void; onClose(): void }) {
  const [shape, setShape] = useState<TemplateShape>('sphere');
  const [size, setSize] = useState(20);
  const [width, setWidth] = useState(5);
  const [name, setName] = useState('');
  const sizeId = useId();
  const widthId = useId();
  const nameId = useId();
  const touch = useIsTouch();
  return (
    <Dialog open={open} onClose={onClose} size="sm" title="Area of effect" description="See who an area would catch. It stays on your map only, until you add it to your message.">
      <div className="flex flex-col gap-4">
        {presets.length > 0 && (
          <section aria-label="Your spells">
            <h3 className="mb-1.5 font-display text-xs font-semibold tracking-[0.14em] text-muted uppercase">Your spells</h3>
            <ul className="flex flex-col gap-1">
              {presets.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => onPick(p)}
                    className="flex w-full items-baseline justify-between gap-3 rounded-xl border border-border px-3 py-2 text-left text-sm hover:bg-surface-2"
                  >
                    <span className="font-medium">{p.label}</span>
                    <span className="text-xs text-muted">{presetSummary(p)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section aria-label="Custom area" className="flex flex-col gap-3">
          <h3 className="font-display text-xs font-semibold tracking-[0.14em] text-muted uppercase">Custom</h3>
          <Segmented<TemplateShape>
            size="sm"
            value={shape}
            onChange={setShape}
            className="flex-wrap"
            options={TEMPLATE_SHAPES.map((s) => ({ value: s, label: SHAPE_LABEL[s] }))}
          />
          <div className="flex items-end gap-2">
            <div className="flex flex-1 flex-col gap-1.5">
              <label htmlFor={sizeId} className="text-sm font-medium">
                {shape === 'sphere' || shape === 'cylinder' ? 'Radius' : shape === 'cube' ? 'Side' : shape === 'emanation' ? 'Distance' : 'Length'}
              </label>
              <Select id={sizeId} value={CUSTOM_SIZES.includes(size) ? String(size) : ''} onChange={(e) => e.target.value && setSize(Number(e.target.value))}>
                {!CUSTOM_SIZES.includes(size) && <option value="">{size} ft</option>}
                {CUSTOM_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n} ft
                  </option>
                ))}
              </Select>
            </div>
            <Input
              type="number"
              inputMode="numeric"
              min={5}
              max={500}
              step={5}
              aria-label="Size in feet"
              className="w-24"
              value={size}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n > 0) setSize(Math.min(500, n));
              }}
            />
          </div>
          {shape === 'line' && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={widthId} className="text-sm font-medium">
                Width
              </label>
              <Select id={widthId} value={String(width)} onChange={(e) => setWidth(Number(e.target.value))}>
                {[5, 10, 15, 20].map((n) => (
                  <option key={n} value={n}>
                    {n} ft
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={nameId} className="text-sm font-medium">
              What is it? <span className="font-normal text-muted">(optional)</span>
            </label>
            <Input id={nameId} value={name} maxLength={40} placeholder={SHAPE_LABEL[shape]} onChange={(e) => setName(e.target.value)} />
          </div>
          <Button variant="primary" size={touch ? 'lg' : 'md'} onClick={() => onPick(customPreset(shape, size, width, name))}>
            Place it
          </Button>
        </section>
      </div>
    </Dialog>
  );
}

export function TemplateBar({ model, controller }: { model: BattleMapModel; controller: MapController }) {
  const touch = useIsTouch();
  const { ui, dispatch, area } = controller;
  const t = ui.template;
  const btn = touch ? 'lg' : 'sm';
  if (!t) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">See who an area of effect would catch.</p>
        <Button size={btn} variant="arcane" onClick={() => dispatch({ type: 'picker', open: true })}>
          Choose an area
        </Button>
      </div>
    );
  }
  const extent = { cols: model.map.width, rows: model.map.height };
  const heroName = model.combatants.get(model.heroId)?.name ?? model.hero.name;
  const heroRect = model.heroToken?.space ?? null;
  const readout = area?.problem ?? areaReadout(templateLine(t, heroName, area?.catches ?? [], model.nameOf));
  const nudge = (dx: number, dy: number) => dispatch({ type: 'template', template: nudgeTemplate(t, dx, dy, extent) });
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-sm font-medium" data-testid="area-readout">
          {readout}
        </p>
        <IconButton label="Clear the area" size={touch ? 'md' : 'sm'} className="-my-1 -mr-1" onClick={() => dispatch({ type: 'template', template: null })}>
          <X className="size-4" aria-hidden />
        </IconButton>
      </div>
      {area && area.warnings.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {area.warnings.map((w) => (
            <li key={w} className="rounded-full bg-danger-soft px-2 py-0.5 text-xs font-medium text-danger">
              {w}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {isCentred(t) && (
          <>
            <Segmented<'square' | 'corner'>
              size="sm"
              value={t.snap}
              onChange={(snap) => dispatch({ type: 'template', template: snapTemplate(t, snap, extent) })}
              options={[
                { value: 'square', label: 'Snap: square' },
                { value: 'corner', label: 'Corner' },
              ]}
            />
            <div className="flex items-center gap-0.5" role="group" aria-label="Nudge the centre">
              <IconButton label="Nudge north" size={btn} onClick={() => nudge(0, -1)}>
                <ArrowUp className="size-4" aria-hidden />
              </IconButton>
              <IconButton label="Nudge west" size={btn} onClick={() => nudge(-1, 0)}>
                <ArrowLeft className="size-4" aria-hidden />
              </IconButton>
              <IconButton label="Nudge east" size={btn} onClick={() => nudge(1, 0)}>
                <ArrowRight className="size-4" aria-hidden />
              </IconButton>
              <IconButton label="Nudge south" size={btn} onClick={() => nudge(0, 1)}>
                <ArrowDown className="size-4" aria-hidden />
              </IconButton>
            </div>
          </>
        )}
        {isAimed(t) && (
          <div className="flex items-center gap-0.5" role="group" aria-label="Aim">
            <IconButton label="Rotate left" size={btn} onClick={() => dispatch({ type: 'template', template: rotateTemplate(t, -1, heroRect) })}>
              <RotateCcw className="size-4" aria-hidden />
            </IconButton>
            <IconButton label="Rotate right" size={btn} onClick={() => dispatch({ type: 'template', template: rotateTemplate(t, 1, heroRect) })}>
              <RotateCw className="size-4" aria-hidden />
            </IconButton>
          </div>
        )}
        <span className="hidden text-xs text-faint sm:inline">{isCentred(t) ? (touch ? 'Tap a square to move it.' : 'Click a square to move it.') : isAimed(t) ? (touch ? 'Tap a square to aim.' : 'Click a square to aim.') : 'It surrounds you.'}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button size={btn} variant="ghost" onClick={() => dispatch({ type: 'picker', open: true })}>
            Change
          </Button>
          <Button
            size={btn}
            variant="arcane"
            disabled={!area || area.problem !== null}
            icon={<MessageSquareText className="size-4" aria-hidden />}
            onClick={controller.addAreaToMessage}
          >
            Add to message
          </Button>
        </div>
      </div>
    </div>
  );
}
