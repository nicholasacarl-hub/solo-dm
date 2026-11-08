/**
 * The battle map's interaction states (spec §7.4) as a pure reducer. The controller (useMapController) resolves
 * what a tap hit — a square, a creature, the square next to an enemy, whether the engine's preview warns — and
 * carries out the commands the reducer returns (commit a move, open the area picker).
 *
 *   inspect (can't move: the pill shows why)
 *   idle ─tap a square─▶ planning ─tap it again / Move / Enter─▶ committing ─ok─▶ idle (the bar shows the move)
 *     │                    ├─tap another square─▶ planning                └─blocked─▶ idle + the reason
 *     │                    └─Esc / Cancel─▶ idle
 *     ├─tap an enemy─▶ planning (to the square next to it; its card in the bar)
 *     ├─tap an ally, a neutral or yourself─▶ inspecting
 *     ├─long-press / right-click─▶ inspecting
 *     ├─Measure: tap─▶ measuring (from you or the token you chose)
 *     └─Area: pick a preset─▶ placing ─tap: centre or aim─▶ … ─Add to message─▶ the line in the draft
 *
 * Input model (D60): touch and keyboard plan first and commit on a second tap / Enter; a mouse commits on click
 * unless the preview warns (an Opportunity Attack, a hazard, Dash needed, Frightened, a refusal), when it plans.
 */
import type { GridPoint } from '@/types';
import type { MapMeasure, MapMeasureEnd, MapMode, MapPlan, MapTemplate } from '../playView';
import type { MoveRefusal } from '@/engine';
import { placeTemplate } from './templates';
import type { MapBlock } from './text';

export type InputKind = 'mouse' | 'touch' | 'pen' | 'keyboard';

export type InspectTarget = { kind: 'token'; id: string } | { kind: 'square'; at: GridPoint };

/** What the bar says after a commit that didn't happen. */
export type MapNotice = { kind: 'block'; block: MapBlock } | { kind: 'refusal'; refusal: MoveRefusal };

export interface MapUiState {
  mode: MapMode;
  plan: MapPlan | null;
  /** The enemy a plan closes on (its card shows in the bar). */
  planTarget: string | null;
  measure: MapMeasure | null;
  template: MapTemplate | null;
  cursor: GridPoint | null;
  /** The square under the mouse (previews only). */
  hover: GridPoint | null;
  inspect: InspectTarget | null;
  committing: boolean;
  notice: MapNotice | null;
  /** The area picker dialog is open. */
  picker: boolean;
}

export const INITIAL_UI: MapUiState = {
  mode: 'move',
  plan: null,
  planTarget: null,
  measure: null,
  template: null,
  cursor: null,
  hover: null,
  inspect: null,
  committing: false,
  notice: null,
  picker: false,
};

/** What a tap hit, resolved by the controller. */
export type TapTarget =
  | { kind: 'square' }
  /** approach: where a move toward an enemy would end (null: it can't get closer). */
  | { kind: 'token'; id: string; role: 'hero' | 'enemy' | 'other'; approach: GridPoint | null };

export type MapAction =
  | {
      type: 'tap';
      at: GridPoint;
      /** The grid corner nearest the tap (area templates with Snap: corner). */
      corner: { x: number; y: number };
      input: InputKind;
      target: TapTarget;
      /** The engine's preview of a move to `at` warns or refuses (mouse clicks plan first then). */
      warned: boolean;
    }
  | { type: 'inspect'; target: InspectTarget }
  | { type: 'hover'; at: GridPoint | null }
  | { type: 'cursor'; at: GridPoint | null }
  | { type: 'escape' }
  | { type: 'mode'; mode: MapMode }
  | { type: 'confirm' }
  | { type: 'cancel' }
  | { type: 'plan-option'; patch: Partial<Pick<MapPlan, 'prefer' | 'dash' | 'disengage' | 'standUp'>> }
  | { type: 'plan-to'; to: GridPoint; target?: string | null }
  | { type: 'committed'; notice: MapNotice | null }
  | { type: 'measure-from'; from: MapMeasureEnd }
  | { type: 'measure-swap' }
  | { type: 'measure-clear' }
  | { type: 'template'; template: MapTemplate | null }
  | { type: 'picker'; open: boolean }
  | { type: 'close-card' }
  | { type: 'reset' };

export type MapCommand = { kind: 'commit'; plan: MapPlan };

export interface ReducerContext {
  canMove: boolean;
  heroId: string;
  heroAt: GridPoint | null;
}

export interface ReducerResult {
  state: MapUiState;
  commands: MapCommand[];
}

const same = (a: GridPoint | null | undefined, b: GridPoint | null | undefined) => !!a && !!b && a.x === b.x && a.y === b.y;

const DEFAULT_OPTIONS: Omit<MapPlan, 'to'> = { prefer: 'safest', dash: false, disengage: false, standUp: false };

function planTo(state: MapUiState, to: GridPoint, target: string | null): MapUiState {
  const options = state.plan ? { prefer: state.plan.prefer, dash: state.plan.dash, disengage: state.plan.disengage, standUp: state.plan.standUp } : DEFAULT_OPTIONS;
  return { ...state, plan: { ...options, to }, planTarget: target, notice: null, inspect: null };
}

function commit(state: MapUiState, plan: MapPlan, target: string | null = state.planTarget): ReducerResult {
  if (state.committing) return { state, commands: [] };
  return { state: { ...state, plan, planTarget: target, committing: true, notice: null, inspect: null }, commands: [{ kind: 'commit', plan }] };
}

function keep(state: MapUiState): ReducerResult {
  return { state, commands: [] };
}

function tapToMove(state: MapUiState, a: Extract<MapAction, { type: 'tap' }>, ctx: ReducerContext): ReducerResult {
  const { target } = a;
  if (target.kind === 'token' && (target.role !== 'enemy' || !ctx.canMove)) {
    return keep({ ...state, inspect: { kind: 'token', id: target.id }, notice: null });
  }
  if (!ctx.canMove) return keep({ ...state, inspect: { kind: 'square', at: a.at }, notice: null });
  if (target.kind === 'token') {
    // An enemy: close on it. Already next to it (or no way closer): show its card instead.
    if (!target.approach || same(target.approach, ctx.heroAt)) return keep({ ...state, inspect: { kind: 'token', id: target.id }, notice: null });
    if (state.plan && same(state.plan.to, target.approach)) return commit(state, state.plan, target.id);
    return keep(planTo(state, target.approach, target.id));
  }
  if (same(a.at, ctx.heroAt)) return keep({ ...state, plan: null, planTarget: null, inspect: { kind: 'token', id: ctx.heroId }, notice: null });
  if (state.plan && same(state.plan.to, a.at)) return commit(state, state.plan);
  const planned = planTo(state, a.at, null);
  if (a.input === 'mouse' && !a.warned && planned.plan) return commit(planned, planned.plan, null);
  return keep(planned);
}

function tapToMeasure(state: MapUiState, a: Extract<MapAction, { type: 'tap' }>, ctx: ReducerContext): ReducerResult {
  const to: MapMeasureEnd = a.target.kind === 'token' ? { id: a.target.id } : a.at;
  const from: MapMeasureEnd = state.measure?.from ?? { id: ctx.heroId };
  return keep({ ...state, measure: { from, to }, inspect: null, notice: null });
}

function tapToPlace(state: MapUiState, a: Extract<MapAction, { type: 'tap' }>): ReducerResult {
  if (!state.template) return keep({ ...state, picker: true });
  return keep({ ...state, template: placeTemplate(state.template, a.at, a.corner), inspect: null });
}

function escape(state: MapUiState): ReducerResult {
  if (state.picker) return keep({ ...state, picker: false });
  if (state.inspect) return keep({ ...state, inspect: null });
  if (state.plan && !state.committing) return keep({ ...state, plan: null, planTarget: null, notice: null });
  if (state.notice) return keep({ ...state, notice: null });
  if (state.mode === 'measure') return keep({ ...state, mode: 'move', measure: null });
  if (state.mode === 'area') return keep({ ...state, mode: 'move', template: null });
  return keep(state);
}

export function mapReducer(state: MapUiState, action: MapAction, ctx: ReducerContext): ReducerResult {
  switch (action.type) {
    case 'tap':
      if (state.committing) return keep(state);
      if (state.mode === 'measure') return tapToMeasure(state, action, ctx);
      if (state.mode === 'area') return tapToPlace(state, action);
      return tapToMove(state, action, ctx);
    case 'inspect':
      return keep({ ...state, inspect: action.target, notice: null });
    case 'hover':
      return same(state.hover, action.at) || (state.hover === null && action.at === null) ? keep(state) : keep({ ...state, hover: action.at });
    case 'cursor':
      return keep({ ...state, cursor: action.at });
    case 'escape':
      return escape(state);
    case 'mode': {
      if (action.mode === state.mode) return keep(state);
      const next: MapUiState = { ...state, mode: action.mode, inspect: null, notice: null, hover: null };
      if (action.mode !== 'move') {
        next.plan = null;
        next.planTarget = null;
      }
      if (action.mode === 'area' && !state.template) next.picker = true;
      return keep(next);
    }
    case 'confirm':
      if (!state.plan || !ctx.canMove) return keep(state);
      return commit(state, state.plan);
    case 'cancel':
      return keep({ ...state, plan: null, planTarget: null, notice: null, inspect: null });
    case 'plan-option':
      return state.plan ? keep({ ...state, plan: { ...state.plan, ...action.patch } }) : keep(state);
    case 'plan-to':
      if (!ctx.canMove) return keep(state);
      return keep({ ...planTo({ ...state, mode: 'move' }, action.to, action.target ?? null), mode: 'move' });
    case 'committed':
      return keep({ ...state, committing: false, plan: null, planTarget: null, notice: action.notice });
    case 'measure-from':
      return keep({ ...state, mode: 'measure', measure: { from: action.from, to: null }, inspect: null, plan: null, planTarget: null });
    case 'measure-swap':
      return state.measure?.to ? keep({ ...state, measure: { from: state.measure.to, to: state.measure.from } }) : keep(state);
    case 'measure-clear':
      return keep({ ...state, measure: null });
    case 'template':
      return keep({ ...state, template: action.template, picker: false, mode: action.template ? 'area' : state.mode });
    case 'picker':
      return keep({ ...state, picker: action.open });
    case 'close-card':
      return keep({ ...state, inspect: null });
    case 'reset':
      return keep({ ...state, plan: null, planTarget: null, measure: null, template: null, inspect: null, notice: null, picker: false, hover: null });
  }
}
