/**
 * The player's area template (D50, D64): made from a preset, then placed without dragging — spheres, cylinders and
 * placed cubes move their centre to each tapped square (or the nearest grid corner with Snap: corner) and nudge one
 * square at a time; cones, lines and cubes from the hero aim at a tapped square's centre and rotate in 45° steps;
 * emanations surround the hero. Pure: every function returns a new template.
 */
import { COMPASS_DIRECTIONS, type AreaSpec, type CompassDirection, type GridPoint, type GridRect, type MapRef } from '@/types';
import { cornerLabel, snapDirection, squareLabel } from '@/engine';
import type { MapTemplate } from '../playView';
import type { AreaPreset, TemplateShape } from './areaPresets';
import type { AreaLineInput } from './text';
import { rectCentre, type MapExtent } from './camera';

/** Does it have a centre the player places (rather than an aim from the hero)? */
export function isCentred(t: MapTemplate): boolean {
  return t.spec.at !== undefined;
}

/** Does it aim from the hero (a cone, a line, a cube from the hero)? */
export function isAimed(t: MapTemplate): boolean {
  return t.spec.at === undefined && t.spec.shape !== 'emanation';
}

export function templateFromPreset(preset: AreaPreset, ctx: { heroId: string; centre: GridPoint; aim: MapRef }): MapTemplate {
  const spec: AreaSpec = { shape: preset.shape, sizeFt: preset.sizeFt, fromId: ctx.heroId };
  if (preset.widthFt) spec.widthFt = preset.widthFt;
  if (preset.heightFt) spec.heightFt = preset.heightFt;
  if (!preset.fromSelf) spec.at = { kind: 'square', at: ctx.centre };
  else if (preset.shape !== 'emanation') spec.toward = ctx.aim;
  return { spec, label: preset.label, ...(preset.rangeFt ? { rangeFt: preset.rangeFt } : {}), snap: 'square' };
}

/** A tap at `square` (whose nearest grid corner is `corner`): move the centre there, or aim there. */
export function placeTemplate(t: MapTemplate, square: GridPoint, corner: { x: number; y: number }): MapTemplate {
  if (isCentred(t)) {
    const at: MapRef = t.snap === 'corner' ? { kind: 'corner', x: corner.x, y: corner.y } : { kind: 'square', at: square };
    return { ...t, spec: { ...t.spec, at } };
  }
  if (isAimed(t)) return { ...t, spec: { ...t.spec, toward: { kind: 'square', at: square } } };
  return t;
}

/** Snap: square / corner. A square goes to its south-east corner; a corner to the square north-west of it. */
export function snapTemplate(t: MapTemplate, snap: 'square' | 'corner', map: MapExtent): MapTemplate {
  const at = t.spec.at;
  if (!at || t.snap === snap) return { ...t, snap };
  if (snap === 'corner' && at.kind === 'square') {
    const x = Math.min(map.cols, at.at.x + 1);
    const y = Math.min(map.rows, at.at.y + 1);
    return { ...t, snap, spec: { ...t.spec, at: { kind: 'corner', x, y } } };
  }
  if (snap === 'square' && at.kind === 'corner') {
    const x = Math.min(map.cols - 1, Math.max(0, at.x - 1));
    const y = Math.min(map.rows - 1, Math.max(0, at.y - 1));
    return { ...t, snap, spec: { ...t.spec, at: { kind: 'square', at: { x, y } } } };
  }
  return { ...t, snap };
}

/** Move the centre one square (the nudge buttons and arrow keys), staying on the map. */
export function nudgeTemplate(t: MapTemplate, dx: number, dy: number, map: MapExtent): MapTemplate {
  const at = t.spec.at;
  if (!at) return t;
  if (at.kind === 'square') {
    const x = Math.min(map.cols - 1, Math.max(0, at.at.x + dx));
    const y = Math.min(map.rows - 1, Math.max(0, at.at.y + dy));
    return { ...t, spec: { ...t.spec, at: { kind: 'square', at: { x, y } } } };
  }
  if (at.kind === 'corner') {
    const x = Math.min(map.cols, Math.max(0, at.x + dx));
    const y = Math.min(map.rows, Math.max(0, at.y + dy));
    return { ...t, spec: { ...t.spec, at: { kind: 'corner', x, y } } };
  }
  return t;
}

/** The compass direction the aim points in, seen from the hero's space. */
export function aimDirection(t: MapTemplate, heroRect: GridRect | null): CompassDirection | null {
  const toward = t.spec.toward;
  if (!toward) return null;
  if (toward.kind === 'direction') return toward.dir;
  if (!heroRect) return null;
  const from = rectCentre(heroRect);
  const to = toward.kind === 'square' ? { x: toward.at.x + 0.5, y: toward.at.y + 0.5 } : toward.kind === 'corner' ? { x: toward.x, y: toward.y } : null;
  if (!to || (to.x === from.x && to.y === from.y)) return null;
  return snapDirection(to.x - from.x, to.y - from.y);
}

/** Rotate ⟲ ⟳: snap the aim to the next of the 8 directions (step 1 = clockwise). */
export function rotateTemplate(t: MapTemplate, step: 1 | -1, heroRect: GridRect | null): MapTemplate {
  if (!isAimed(t)) return t;
  const current = aimDirection(t, heroRect) ?? 'east';
  const i = COMPASS_DIRECTIONS.indexOf(current);
  const dir = COMPASS_DIRECTIONS[(i + step + COMPASS_DIRECTIONS.length) % COMPASS_DIRECTIONS.length];
  return { ...t, spec: { ...t.spec, toward: { kind: 'direction', dir } } };
}

/** A MapRef as resolve_area takes it: "G4", "G4/H5", "north-east". */
export function refText(ref: MapRef | undefined, nameOf: (id: string) => string): string | undefined {
  if (!ref) return undefined;
  switch (ref.kind) {
    case 'square':
      return squareLabel(ref.at);
    case 'corner':
      return cornerLabel(ref.x, ref.y);
    case 'direction':
      return ref.dir;
    case 'creature':
      return nameOf(ref.id);
  }
}

/** The facts the [Area: …] line and the readout are built from. */
export function templateLine(t: MapTemplate, heroName: string, catches: readonly string[], nameOf: (id: string) => string): AreaLineInput {
  const shape = t.spec.shape as TemplateShape;
  return {
    label: t.label,
    shape,
    sizeFt: t.spec.sizeFt ?? 5,
    ...(shape === 'line' ? { widthFt: t.spec.widthFt ?? 5 } : {}),
    ...(isCentred(t) ? { at: refText(t.spec.at, nameOf) } : { fromName: heroName, toward: refText(t.spec.toward, nameOf) }),
    catches,
  };
}
