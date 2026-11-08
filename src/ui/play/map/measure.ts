/**
 * Measuring on the battle map (spec §7.4): from the hero (or the token the player chose) to a square or a token,
 * by the SRD grid count between the two spaces, with line of sight and, to a creature, its cover — all on the
 * player view. Pure.
 */
import { coverAgainst, lineOfSight, rectsSeeEachOther, spaceDistanceFt, squareLabel, type Space } from '@/engine';
import type { GridPoint, GridRect } from '@/types';
import type { MapMeasure, MapMeasureEnd } from '../playView';
import type { Pt } from './camera';
import { rectCentreWorld } from './geometry';
import type { BattleMapModel } from './model';
import { measureText } from './text';

export interface MeasureInfo {
  from: Pt;
  to: Pt;
  feet: number;
  text: string;
  /** The badge on the line ("20 ft"). */
  label: string;
}

interface End {
  id: string | null;
  name: string;
  space: Space;
}

function endOf(model: BattleMapModel, end: MapMeasureEnd): End | null {
  if ('id' in end) {
    const t = model.tokens.get(end.id);
    if (!t?.space) return null;
    const name = t.isHero ? (model.combatants.get(t.id)?.name ?? model.hero.name) : t.name;
    return { id: t.id, name, space: { rect: t.space, elevationFt: t.elevationFt, size: t.size } };
  }
  if (end.x < 0 || end.y < 0 || end.x >= model.map.width || end.y >= model.map.height) return null;
  const rect: GridRect = { x0: end.x, y0: end.y, x1: end.x, y1: end.y };
  return { id: null, name: squareLabel(end), space: { rect, elevationFt: 0, size: 'Medium' } };
}

/** A square with a living creature on it measures to the creature (its whole space, its cover). */
function creatureOrSquare(model: BattleMapModel, end: MapMeasureEnd): MapMeasureEnd {
  if ('id' in end) return end;
  const t = model.snapshot.tokens.find((k) => !k.defeated && k.space && end.x >= k.space.x0 && end.x <= k.space.x1 && end.y >= k.space.y0 && end.y <= k.space.y1);
  return t ? { id: t.id } : end;
}

export function measureInfo(model: BattleMapModel, measure: MapMeasure | null, hover: GridPoint | null): MeasureInfo | null {
  if (!measure) return null;
  const raw = measure.to ?? hover;
  if (!raw) return null;
  const toEnd = creatureOrSquare(model, raw);
  const a = endOf(model, measure.from);
  const b = endOf(model, toEnd);
  if (!a || !b) return null;
  const feet = spaceDistanceFt(a.space, b.space);
  const sees =
    a.id && b.id ? lineOfSight(model.view, model.hero, a.id, b.id, { perspective: 'player' }) : rectsSeeEachOther(model.cells, a.space.rect, b.space.rect);
  let cover: { degree: 'none' | 'half' | 'three-quarters' | 'total'; by: string[] } | null = null;
  if (a.id && b.id && a.id !== b.id) {
    const c = coverAgainst(model.view, model.hero, a.id, b.id, { perspective: 'player' });
    cover = { degree: c.degree, by: [...c.byTerrain, ...c.byCreatureIds.map((id) => model.combatants.get(id)?.name ?? 'someone')] };
  }
  return {
    from: rectCentreWorld(a.space.rect),
    to: rectCentreWorld(b.space.rect),
    feet,
    text: measureText({ from: a.name, to: b.name, feet, lineOfSight: sees, cover }),
    label: `${feet} ft`,
  };
}

