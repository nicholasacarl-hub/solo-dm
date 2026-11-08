import { describe, expect, it } from 'vitest';
import type { MapTemplate } from '../playView';
import { customPreset } from './areaPresets';
import { areaMessageLine } from './text';
import { aimDirection, isAimed, isCentred, nudgeTemplate, placeTemplate, refText, rotateTemplate, snapTemplate, templateFromPreset, templateLine } from './templates';

const map = { cols: 16, rows: 12 };
const heroRect = { x0: 1, y0: 5, x1: 1, y1: 5 }; // B6
const G4 = { x: 6, y: 3 };
const fireball: MapTemplate = { spec: { shape: 'sphere', sizeFt: 20, fromId: 'c-1', at: { kind: 'square', at: G4 } }, label: 'Fireball', rangeFt: 150, snap: 'square' };
const hands: MapTemplate = { spec: { shape: 'cone', sizeFt: 15, fromId: 'c-1', toward: { kind: 'square', at: { x: 2, y: 4 } } }, label: 'Burning Hands', snap: 'square' };
const nameOf = (id: string) => (id === 'c-2' ? 'Bandit 1' : 'someone');

describe('area templates (D50, D64)', () => {
  it('starts centred shapes at the view centre, aimed shapes at the aim, emanations around the hero', () => {
    const ctx = { heroId: 'c-1', centre: G4, aim: { kind: 'square' as const, at: { x: 5, y: 3 } } };
    const sphere = templateFromPreset({ id: 'srd:spell:fireball', label: 'Fireball', shape: 'sphere', sizeFt: 20, rangeFt: 150, fromSelf: false }, ctx);
    expect(sphere).toEqual({ spec: { shape: 'sphere', sizeFt: 20, fromId: 'c-1', at: { kind: 'square', at: G4 } }, label: 'Fireball', rangeFt: 150, snap: 'square' });
    expect(isCentred(sphere)).toBe(true);
    const cone = templateFromPreset(customPreset('cone', 15), ctx);
    expect(cone.spec).toEqual({ shape: 'cone', sizeFt: 15, fromId: 'c-1', toward: { kind: 'square', at: { x: 5, y: 3 } } });
    expect(isAimed(cone)).toBe(true);
    const aura = templateFromPreset(customPreset('emanation', 15), ctx);
    expect(aura.spec).toEqual({ shape: 'emanation', sizeFt: 15, fromId: 'c-1' });
    expect(isCentred(aura) || isAimed(aura)).toBe(false);
  });

  it('moves a sphere to the tapped square, or to the nearest corner with Snap: corner', () => {
    expect(placeTemplate(fireball, { x: 9, y: 2 }, { x: 10, y: 3 }).spec.at).toEqual({ kind: 'square', at: { x: 9, y: 2 } });
    const cornered = snapTemplate(fireball, 'corner', map);
    expect(cornered.spec.at).toEqual({ kind: 'corner', x: 7, y: 4 }); // G4/H5
    expect(placeTemplate(cornered, { x: 9, y: 2 }, { x: 10, y: 3 }).spec.at).toEqual({ kind: 'corner', x: 10, y: 3 });
    expect(snapTemplate(cornered, 'square', map).spec.at).toEqual({ kind: 'square', at: G4 });
  });

  it('nudges a centre one square at a time and stays on the map', () => {
    expect(nudgeTemplate(fireball, 1, 0, map).spec.at).toEqual({ kind: 'square', at: { x: 7, y: 3 } });
    expect(nudgeTemplate({ ...fireball, spec: { ...fireball.spec, at: { kind: 'square', at: { x: 0, y: 0 } } } }, -1, -1, map).spec.at).toEqual({
      kind: 'square',
      at: { x: 0, y: 0 },
    });
    expect(nudgeTemplate(snapTemplate(fireball, 'corner', map), 0, 1, map).spec.at).toEqual({ kind: 'corner', x: 7, y: 5 });
    expect(nudgeTemplate(hands, 1, 0, map)).toBe(hands);
  });

  it('aims at the tapped square, and Rotate snaps the aim to the 8 directions', () => {
    const aimed = placeTemplate(hands, { x: 3, y: 5 }, { x: 4, y: 6 });
    expect(aimed.spec.toward).toEqual({ kind: 'square', at: { x: 3, y: 5 } });
    expect(aimDirection(aimed, heroRect)).toBe('east');
    expect(rotateTemplate(aimed, 1, heroRect).spec.toward).toEqual({ kind: 'direction', dir: 'south-east' });
    expect(rotateTemplate(aimed, -1, heroRect).spec.toward).toEqual({ kind: 'direction', dir: 'north-east' });
    const west = rotateTemplate(rotateTemplate(rotateTemplate(rotateTemplate(aimed, 1, heroRect), 1, heroRect), 1, heroRect), 1, heroRect);
    expect(west.spec.toward).toEqual({ kind: 'direction', dir: 'west' });
    expect(rotateTemplate(fireball, 1, heroRect)).toBe(fireball);
  });

  it('writes MapRefs exactly as resolve_area takes them', () => {
    expect(refText({ kind: 'square', at: G4 }, nameOf)).toBe('G4');
    expect(refText({ kind: 'corner', x: 7, y: 4 }, nameOf)).toBe('G4/H5');
    expect(refText({ kind: 'direction', dir: 'north-east' }, nameOf)).toBe('north-east');
    expect(refText({ kind: 'creature', id: 'c-2' }, nameOf)).toBe('Bandit 1');
    expect(refText(undefined, nameOf)).toBeUndefined();
  });

  it('gives the exact [Area: …] lines of spec §7.4', () => {
    const cone = templateLine({ ...hands, spec: { ...hands.spec, toward: { kind: 'square', at: { x: 2, y: 4 } } } }, 'Mira Voss', ['Bandit 1'], nameOf);
    expect(areaMessageLine(cone)).toBe('[Area: Burning Hands — 15-ft cone from Mira Voss toward C5; on my map it catches Bandit 1]');
    expect(areaMessageLine(templateLine(fireball, 'Mira Voss', ['Bandit 1', 'Bandit 2'], nameOf))).toBe(
      '[Area: Fireball — 20-ft sphere centred on G4; on my map it catches Bandit 1, Bandit 2]',
    );
    const corner = snapTemplate(fireball, 'corner', map);
    expect(areaMessageLine(templateLine(corner, 'Mira Voss', [], nameOf))).toBe('[Area: Fireball — 20-ft sphere centred on G4/H5; on my map it catches nobody]');
    const bolt: MapTemplate = { spec: { shape: 'line', sizeFt: 100, widthFt: 5, fromId: 'c-1', toward: { kind: 'direction', dir: 'north-east' } }, label: 'Lightning Bolt', snap: 'square' };
    expect(areaMessageLine(templateLine(bolt, 'Mira Voss', [], nameOf))).toBe(
      '[Area: Lightning Bolt — 100-ft line, 5 ft wide from Mira Voss toward north-east; on my map it catches nobody]',
    );
  });
});
