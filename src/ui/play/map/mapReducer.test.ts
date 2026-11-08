import { describe, expect, it } from 'vitest';
import type { MapTemplate } from '../playView';
import { INITIAL_UI, mapReducer, type MapAction, type MapUiState, type ReducerContext, type TapTarget } from './mapReducer';

const ctx: ReducerContext = { canMove: true, heroId: 'c-1', heroAt: { x: 1, y: 5 }, yourTurn: true, block: null };
const D8 = { x: 3, y: 7 };
const E6 = { x: 4, y: 5 };
const square: TapTarget = { kind: 'square' };
const tap = (at: { x: number; y: number }, input: 'mouse' | 'touch' | 'keyboard', opts: { target?: TapTarget; warned?: boolean } = {}): MapAction => ({
  type: 'tap',
  at,
  corner: { x: at.x + 1, y: at.y + 1 },
  input,
  target: opts.target ?? square,
  warned: opts.warned ?? false,
});
const plan = (to: { x: number; y: number }) => ({ to, prefer: 'safest' as const, dash: false, disengage: false, standUp: false });

function reduce(actions: MapAction[], from: MapUiState = INITIAL_UI, c: ReducerContext = ctx) {
  let state = from;
  const commands = [];
  for (const a of actions) {
    const r = mapReducer(state, a, c);
    state = r.state;
    commands.push(...r.commands);
  }
  return { state, commands };
}

describe('mapReducer: the move flow (spec §7.4, D60)', () => {
  it('touch: the first tap plans, the second tap on the same square commits', () => {
    const first = reduce([tap(D8, 'touch')]);
    expect(first.state.plan).toEqual(plan(D8));
    expect(first.commands).toEqual([]);
    const second = reduce([tap(D8, 'touch')], first.state);
    expect(second.commands).toEqual([{ kind: 'commit', plan: plan(D8) }]);
    expect(second.state.committing).toBe(true);
  });

  it('touch: tapping another square re-plans; Escape and Cancel drop the plan', () => {
    const replanned = reduce([tap(D8, 'touch'), tap(E6, 'touch')]);
    expect(replanned.state.plan?.to).toEqual(E6);
    expect(replanned.commands).toEqual([]);
    expect(reduce([{ type: 'escape' }], replanned.state).state.plan).toBeNull();
    expect(reduce([{ type: 'cancel' }], replanned.state).state.plan).toBeNull();
  });

  it('mouse: a click commits at once without a warning, and plans first with one', () => {
    const clean = reduce([tap(D8, 'mouse')]);
    expect(clean.commands).toEqual([{ kind: 'commit', plan: plan(D8) }]);
    const warned = reduce([tap(D8, 'mouse', { warned: true })]);
    expect(warned.commands).toEqual([]);
    expect(warned.state.plan).toEqual(plan(D8));
    expect(reduce([tap(D8, 'mouse', { warned: true })], warned.state).commands).toEqual([{ kind: 'commit', plan: plan(D8) }]);
  });

  it('keyboard: Enter plans, Enter again (or confirm) commits', () => {
    const planned = reduce([tap(D8, 'keyboard')]);
    expect(planned.commands).toEqual([]);
    expect(reduce([tap(D8, 'keyboard')], planned.state).commands).toHaveLength(1);
    expect(reduce([{ type: 'confirm' }], planned.state).commands).toEqual([{ kind: 'commit', plan: plan(D8) }]);
  });

  it('keeps Dash, Disengage, the route and Stand up across re-plans', () => {
    const r = reduce([
      tap(D8, 'touch'),
      { type: 'plan-option', patch: { dash: true, disengage: true, prefer: 'shortest', standUp: true } },
      tap(E6, 'touch'),
    ]);
    expect(r.state.plan).toEqual({ to: E6, prefer: 'shortest', dash: true, disengage: true, standUp: true });
    expect(reduce([{ type: 'plan-option', patch: { dash: true } }]).state.plan).toBeNull();
  });

  it('commits once: a second confirm while committing does nothing; the result clears the plan and keeps a notice', () => {
    const committing = reduce([tap(D8, 'touch'), { type: 'confirm' }]);
    expect(committing.commands).toHaveLength(1);
    expect(reduce([{ type: 'confirm' }, tap(E6, 'touch')], committing.state).commands).toEqual([]);
    const done = reduce([{ type: 'committed', notice: { kind: 'block', block: 'dm-busy' } }], committing.state);
    expect(done.state).toMatchObject({ committing: false, plan: null, notice: { kind: 'block', block: 'dm-busy' } });
  });

  it('tapping an enemy plans to the square next to it (its card in the bar), and commits on the second tap', () => {
    const enemy: TapTarget = { kind: 'token', id: 'c-2', role: 'enemy', approach: { x: 4, y: 3 } };
    const first = reduce([tap({ x: 5, y: 3 }, 'touch', { target: enemy })]);
    expect(first.state.plan?.to).toEqual({ x: 4, y: 3 });
    expect(first.state.planTarget).toBe('c-2');
    const second = reduce([tap({ x: 5, y: 3 }, 'touch', { target: enemy })], first.state);
    expect(second.commands).toEqual([{ kind: 'commit', plan: plan({ x: 4, y: 3 }) }]);
    // Already next to it (or no way closer): its card instead.
    const adjacent: TapTarget = { kind: 'token', id: 'c-2', role: 'enemy', approach: ctx.heroAt };
    expect(reduce([tap({ x: 2, y: 4 }, 'touch', { target: adjacent })]).state.inspect).toEqual({ kind: 'token', id: 'c-2' });
  });

  it('tapping an ally, a neutral or yourself inspects it', () => {
    const ally: TapTarget = { kind: 'token', id: 'c-4', role: 'other', approach: null };
    expect(reduce([tap({ x: 1, y: 4 }, 'touch', { target: ally })]).state).toMatchObject({ inspect: { kind: 'token', id: 'c-4' }, plan: null });
    expect(reduce([tap({ x: 1, y: 5 }, 'touch')]).state.inspect).toEqual({ kind: 'token', id: 'c-1' });
  });

  it("says why on the hero's turn when something comes first (a pending stop, the DM working)", () => {
    const stopped: ReducerContext = { ...ctx, canMove: false, block: 'stop-pending' };
    expect(reduce([tap(D8, 'touch')], INITIAL_UI, stopped).state).toMatchObject({ plan: null, inspect: null, notice: { kind: 'block', block: 'stop-pending' } });
    // The hero's own square still opens the hero's card.
    expect(reduce([tap({ x: 1, y: 5 }, 'touch')], INITIAL_UI, stopped).state.inspect).toEqual({ kind: 'square', at: { x: 1, y: 5 } });
  });

  it("inspects instead of planning when it isn't the hero's turn", () => {
    const stuck: ReducerContext = { ...ctx, canMove: false, yourTurn: false, block: 'not-your-turn' };
    expect(reduce([tap(D8, 'touch')], INITIAL_UI, stuck).state).toMatchObject({ plan: null, inspect: { kind: 'square', at: D8 } });
    expect(reduce([{ type: 'plan-to', to: D8 }], INITIAL_UI, stuck).state.plan).toBeNull();
    expect(reduce([tap(D8, 'touch'), { type: 'confirm' }], INITIAL_UI, { ...ctx }).commands).toHaveLength(1);
    const planned = reduce([tap(D8, 'touch')]).state;
    expect(reduce([{ type: 'confirm' }], planned, stuck).commands).toEqual([]);
  });

  it('long-press / right-click inspects; Escape closes the card first', () => {
    const r = reduce([tap(D8, 'touch'), { type: 'inspect', target: { kind: 'square', at: E6 } }]);
    expect(r.state.inspect).toEqual({ kind: 'square', at: E6 });
    const escaped = reduce([{ type: 'escape' }], r.state);
    expect(escaped.state.inspect).toBeNull();
    expect(escaped.state.plan?.to).toEqual(D8);
  });
});

describe('mapReducer: measure and area (spec §7.4)', () => {
  it('measures from the hero to the tapped square or creature; Swap and Clear', () => {
    const r = reduce([{ type: 'mode', mode: 'measure' }, tap(D8, 'touch')]);
    expect(r.state.measure).toEqual({ from: { id: 'c-1' }, to: D8 });
    const toToken = reduce([tap({ x: 5, y: 3 }, 'touch', { target: { kind: 'token', id: 'c-2', role: 'enemy', approach: null } })], r.state);
    expect(toToken.state.measure).toEqual({ from: { id: 'c-1' }, to: { id: 'c-2' } });
    expect(reduce([{ type: 'measure-swap' }], toToken.state).state.measure).toEqual({ from: { id: 'c-2' }, to: { id: 'c-1' } });
    expect(reduce([{ type: 'measure-clear' }], toToken.state).state.measure).toBeNull();
    // Measure from a creature's card.
    expect(reduce([{ type: 'measure-from', from: { id: 'c-4' } }, tap(D8, 'touch')]).state.measure).toEqual({ from: { id: 'c-4' }, to: D8 });
    // Escape leaves Measure.
    expect(reduce([{ type: 'escape' }], toToken.state).state).toMatchObject({ mode: 'move', measure: null });
  });

  it('switching to Measure or Area drops a move plan; Area opens the picker until there is a template', () => {
    const planned = reduce([tap(D8, 'touch')]).state;
    expect(reduce([{ type: 'mode', mode: 'measure' }], planned).state.plan).toBeNull();
    const area = reduce([{ type: 'mode', mode: 'area' }], planned).state;
    expect(area).toMatchObject({ mode: 'area', plan: null, picker: true });
    // A tap with no template opens the picker again.
    expect(reduce([{ type: 'picker', open: false }, tap(D8, 'touch')], area).state.picker).toBe(true);
  });

  it('places a template: a centre moves to the tapped square, or its corner with Snap: corner; an aim turns', () => {
    const sphere: MapTemplate = { spec: { shape: 'sphere', sizeFt: 20, fromId: 'c-1', at: { kind: 'square', at: E6 } }, label: 'Fireball', snap: 'square' };
    const placed = reduce([{ type: 'template', template: sphere }, tap(D8, 'touch')]).state;
    expect(placed).toMatchObject({ mode: 'area', picker: false });
    expect(placed.template?.spec.at).toEqual({ kind: 'square', at: D8 });
    const cornered = reduce([{ type: 'template', template: { ...sphere, snap: 'corner' } }, tap(D8, 'touch')]).state;
    expect(cornered.template?.spec.at).toEqual({ kind: 'corner', x: 4, y: 8 });
    const cone: MapTemplate = { spec: { shape: 'cone', sizeFt: 15, fromId: 'c-1', toward: { kind: 'direction', dir: 'east' } }, label: 'Burning Hands', snap: 'square' };
    expect(reduce([{ type: 'template', template: cone }, tap(D8, 'touch')]).state.template?.spec.toward).toEqual({ kind: 'square', at: D8 });
    // Escape leaves Area and drops the template.
    expect(reduce([{ type: 'escape' }], placed).state).toMatchObject({ mode: 'move', template: null });
  });

  it('a reset (the DM went busy, the turn moved on) drops plans, measures, templates and cards', () => {
    const busy = reduce([tap(D8, 'touch'), { type: 'inspect', target: { kind: 'square', at: E6 } }, { type: 'reset' }]).state;
    expect(busy).toMatchObject({ plan: null, measure: null, template: null, inspect: null, notice: null, picker: false });
  });

  it('remembers the hover only when it changes', () => {
    const hovered = mapReducer(INITIAL_UI, { type: 'hover', at: D8 }, ctx).state;
    expect(hovered.hover).toEqual(D8);
    expect(mapReducer(hovered, { type: 'hover', at: { ...D8 } }, ctx).state).toBe(hovered);
    expect(mapReducer(INITIAL_UI, { type: 'hover', at: null }, ctx).state).toBe(INITIAL_UI);
  });
});
