/**
 * The move preview (spec §7.4): what a planned move would do, from planMove on the player view — the route all the
 * way to the destination, where an Opportunity Attack would stop it (D34), the cost and what is left, Dash when the
 * destination needs it (D61, never switched on silently), the warning chips and the Safe / Short alternative.
 * Pure; a commit re-plans in the store and replays on the true map (C24).
 */
import { moverStats, opportunityTriggers, planMove, type MovePlan, type MoveRefusal, type MoveRequest } from '@/engine';
import type { GridPoint } from '@/types';
import type { MapPlan } from '../playView';
import type { BattleMapModel } from './model';
import {
  CRAWLING_CHIP,
  NEEDS_DASH_CHIP,
  difficultChip,
  enteredChip,
  frightenedChip,
  opportunityChip,
  standsUpChip,
} from './text';

export interface PlanChip {
  text: string;
  /** A mouse click plans first (instead of moving at once) when any chip warns (D60). */
  warn: boolean;
}

export interface PlanPreview {
  to: GridPoint;
  status: 'moved' | 'stopped' | 'refused';
  /** The route, start excluded, all the way to the destination. */
  path: GridPoint[];
  /** Where an Opportunity Attack would stop the move, and who makes it (visible creatures only). */
  stopAt: GridPoint | null;
  stopReactors: string[];
  /** To the destination, and what is left after it. */
  costFt: number;
  leftFt: number;
  /** The destination needs a Dash the player hasn't asked for: the commit takes it (the button says so). */
  needsDash: boolean;
  /** What the commit sends as `dash`. */
  dash: boolean;
  chips: PlanChip[];
  refusal: MoveRefusal | null;
  /** The other route preference gives a different route: the chip that switches to it. */
  alternative: { prefer: 'safest' | 'shortest'; provokes: number } | null;
  /** Plan first on a mouse click. */
  warned: boolean;
}

function request(model: BattleMapModel, plan: Pick<MapPlan, 'prefer' | 'dash' | 'disengage' | 'standUp'>, to: MoveRequest['to']): MoveRequest {
  return {
    moverId: model.heroId,
    kind: 'move',
    by: 'player',
    to,
    prefer: plan.prefer,
    dash: plan.dash,
    disengage: plan.disengage,
    stayProne: !plan.standUp,
  };
}

function plan(model: BattleMapModel, req: MoveRequest): MovePlan {
  return planMove(model.view, model.hero, req, { perspective: 'player' });
}

/** Labels of hazards (terrain and lasting effects that hurt): "Enters the brazier (hazard)". */
function hazardLabels(model: BattleMapModel): Set<string> {
  const out = new Set<string>(['hazard']);
  for (const f of model.map.terrain) if (f.kind === 'hazard' && f.label) out.add(f.label);
  for (const e of model.map.effects) if (e.terrain.includes('hazard')) out.add(e.label);
  return out;
}

function fullPath(p: Exclude<MovePlan, { status: 'refused' }>): GridPoint[] {
  return p.status === 'stopped' ? [...p.path, ...p.remainingPath] : p.path;
}

const samePath = (a: readonly GridPoint[], b: readonly GridPoint[]) => a.length === b.length && a.every((p, i) => p.x === b[i].x && p.y === b[i].y);

/**
 * `alternative: false` skips the Safe / Short comparison (a second path search): a hover preview draws only the
 * path and needs only `warned`.
 */
export function previewMove(model: BattleMapModel, mapPlan: MapPlan, opts: { alternative?: boolean } = {}): PlanPreview {
  const req = request(model, mapPlan, { kind: 'square', at: mapPlan.to });
  let result = plan(model, req);
  let needsDash = false;
  if (result.status === 'refused' && result.refusal.code === 'too-far' && result.refusal.dashWouldReach && !mapPlan.dash) {
    const withDash = plan(model, { ...req, dash: true });
    if (withDash.status !== 'refused') {
      result = withDash;
      needsDash = true;
    }
  }
  const dash = mapPlan.dash || needsDash;
  if (result.status === 'refused') {
    return {
      to: mapPlan.to,
      status: 'refused',
      path: [],
      stopAt: null,
      stopReactors: [],
      costFt: 0,
      leftFt: model.budget?.leftFt ?? 0,
      needsDash: false,
      dash: mapPlan.dash,
      chips: [],
      refusal: result.refusal,
      alternative: null,
      warned: true,
    };
  }
  const chips: PlanChip[] = [];
  const stopReactors = result.status === 'stopped' ? result.reactors.filter((r) => !r.hidden).map((r) => r.reactorId) : [];
  if (stopReactors.length) chips.push({ text: opportunityChip(stopReactors.map(model.nameOf)), warn: true });
  if (needsDash) chips.push({ text: NEEDS_DASH_CHIP, warn: true });
  // Frightened (C13): the route can't bring the hero closer to its source; worth a look before a click moves.
  for (const id of moverStats(model.view, model.hero, model.heroId)?.frightenedOfIds ?? []) {
    if (model.combatants.has(id)) chips.push({ text: frightenedChip(model.nameOf(id)), warn: true });
  }
  const hazards = hazardLabels(model);
  for (const note of result.notes) {
    if (note.kind === 'difficult') chips.push({ text: difficultChip(note.squares), warn: false });
    else if (note.kind === 'entered') chips.push({ text: enteredChip(note.label, hazards.has(note.label)), warn: hazards.has(note.label) });
    else if (note.kind === 'crawled') chips.push({ text: CRAWLING_CHIP, warn: false });
    else if (note.kind === 'stood-up') chips.push({ text: standsUpChip(note.costFt), warn: false });
  }
  const remaining = result.status === 'stopped' ? result.remainingCostFt : 0;
  const path = fullPath(result);
  return {
    to: mapPlan.to,
    status: result.status,
    path,
    stopAt: result.status === 'stopped' ? result.at : null,
    stopReactors,
    costFt: result.costFt + remaining,
    leftFt: Math.max(0, (result.budget?.leftFt ?? 0) - remaining),
    needsDash,
    dash,
    chips,
    refusal: null,
    alternative: opts.alternative === false ? null : alternativeRoute(model, { ...mapPlan, dash }, path),
    warned: chips.some((c) => c.warn),
  };
}

/** The Safe / Short chip (C16): shown only when the other preference takes a different route. */
function alternativeRoute(model: BattleMapModel, mapPlan: MapPlan, path: readonly GridPoint[]): PlanPreview['alternative'] {
  const prefer = mapPlan.prefer === 'safest' ? 'shortest' : 'safest';
  const other = plan(model, request(model, { ...mapPlan, prefer }, { kind: 'square', at: mapPlan.to }));
  if (other.status === 'refused') return null;
  const otherPath = fullPath(other);
  if (samePath(otherPath, path)) return null;
  const from = model.heroToken?.space ? { x: model.heroToken.space.x0, y: model.heroToken.space.y0 } : null;
  if (!from) return null;
  const provokes = opportunityTriggers(model.view, model.hero, model.heroId, [from, ...otherPath], {
    disengaged: mapPlan.disengage || (model.budget?.disengaged ?? false),
    kind: 'move',
    perspective: 'player',
  }).filter((p) => !p.hidden).length;
  return { prefer, provokes };
}

/**
 * Where tapping an enemy plans to: the square a move toward it would end on (within the hero's reach of it, by the
 * cheapest legal route), with a Dash when only a Dash gets there, else as close as the hero can get. Null when the
 * hero can't get any closer.
 */
export function approachSquare(model: BattleMapModel, enemyId: string, options: Pick<MapPlan, 'prefer' | 'dash' | 'disengage' | 'standUp'>): GridPoint | null {
  const req = request(model, options, { kind: 'creature', id: enemyId });
  const result = plan(model, req);
  if (result.status === 'moved') return result.to;
  if (result.status === 'stopped') return result.destination;
  const refusal = result.refusal;
  if (refusal.code === 'too-far') {
    if (refusal.dashWouldReach && !options.dash) {
      const withDash = plan(model, { ...req, dash: true });
      if (withDash.status === 'moved') return withDash.to;
      if (withDash.status === 'stopped') return withDash.destination;
    }
    return refusal.closest?.at ?? null;
  }
  if (refusal.code === 'no-route') return refusal.closest?.at ?? null;
  return null;
}

/**
 * A small per-model cache, so hovering back and forth doesn't re-plan. A full preview (with the Safe / Short
 * alternative) also answers a light one (hover, the click's warning check).
 */
export class PreviewCache {
  private readonly cache = new Map<string, PlanPreview>();
  constructor(private readonly model: BattleMapModel) {}

  get(mapPlan: MapPlan, opts: { light?: boolean } = {}): PlanPreview {
    const key = `${mapPlan.to.x},${mapPlan.to.y}|${mapPlan.prefer}|${mapPlan.dash}|${mapPlan.disengage}|${mapPlan.standUp}`;
    const full = this.cache.get(key);
    if (full) return full;
    const lightKey = `${key}|light`;
    if (opts.light) {
      const hit = this.cache.get(lightKey);
      if (hit) return hit;
    }
    const preview = previewMove(this.model, mapPlan, { alternative: !opts.light });
    if (this.cache.size > 64) this.cache.clear();
    this.cache.set(opts.light ? lightKey : key, preview);
    return preview;
  }
}
