import { describe, expect, it } from 'vitest';
import type { Camera } from './camera';
import { gestureStep, IDLE_GESTURE, type GestureEffect, type GestureInput, type GestureState } from './gestures';

const cam: Camera = { k: 0.4, x: 0, y: 0 };

/** Feed inputs in order; collect every effect. */
function run(inputs: GestureInput[], from: GestureState = IDLE_GESTURE): { state: GestureState; effects: GestureEffect[] } {
  let state = from;
  const effects: GestureEffect[] = [];
  for (const input of inputs) {
    const step = gestureStep(state, input);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}

const kinds = (effects: GestureEffect[]) => effects.map((e) => e.kind);
const down = (id: number, x: number, y: number, pointer: 'mouse' | 'touch' | 'pen' = 'touch'): GestureInput => ({
  type: 'down',
  id,
  at: { x, y },
  pointer,
  camera: cam,
});
const move = (id: number, x: number, y: number): GestureInput => ({ type: 'move', id, at: { x, y } });
const up = (id: number, x: number, y: number): GestureInput => ({ type: 'up', id, at: { x, y }, camera: cam });

describe('gestures (spec §7.5)', () => {
  it('taps when a press stays within the slop', () => {
    const { state, effects } = run([down(1, 100, 100), move(1, 106, 104), up(1, 106, 104)]);
    expect(kinds(effects)).toEqual(['arm-hold', 'disarm-hold', 'tap']);
    expect(effects.at(-1)).toEqual({ kind: 'tap', at: { x: 106, y: 104 }, pointer: 'touch' });
    expect(state.phase).toBe('idle');
  });

  it('pans once a press moves past the slop: 10px touch, 6px pen, 4px mouse', () => {
    // 8px is a tap with a finger…
    expect(kinds(run([down(1, 0, 0), move(1, 8, 0), up(1, 8, 0)]).effects)).toContain('tap');
    // …but a pan with a mouse (no hold timer for mice).
    const mouse = run([down(1, 0, 0, 'mouse'), move(1, 8, 0), move(1, 20, 5), up(1, 20, 5)]);
    expect(kinds(mouse.effects)).toEqual(['disarm-hold', 'camera', 'camera', 'disarm-hold', 'commit']);
    expect(mouse.effects[2]).toEqual({ kind: 'camera', camera: { k: 0.4, x: 20, y: 5 } });
    expect(kinds(run([down(1, 0, 0, 'pen'), move(1, 7, 0)]).effects)).toContain('camera');
    expect(kinds(run([down(1, 0, 0, 'pen'), move(1, 5, 0)]).effects)).not.toContain('camera');
  });

  it('long-presses after a 500 ms hold, and the press then neither taps nor pans', () => {
    const held = run([down(1, 50, 60), { type: 'hold' }, move(1, 90, 60), up(1, 90, 60)]);
    expect(held.effects).toContainEqual({ kind: 'long-press', at: { x: 50, y: 60 }, pointer: 'touch' });
    expect(kinds(held.effects)).not.toContain('tap');
    expect(kinds(held.effects)).not.toContain('camera');
    // A hold timer firing after the press became a pan does nothing.
    expect(kinds(run([down(1, 0, 0), move(1, 30, 0), { type: 'hold' }]).effects)).not.toContain('long-press');
  });

  it('pinches with two fingers, and lifting one carries on as a pan (never a tap)', () => {
    const pinch = run([down(1, 100, 100), down(2, 200, 100), move(2, 300, 100)]);
    expect(pinch.state.phase).toBe('pinch');
    const zoomed = pinch.effects.filter((e): e is Extract<GestureEffect, { kind: 'camera' }> => e.kind === 'camera');
    expect(zoomed.at(-1)?.camera.k).toBeGreaterThan(0.4);

    const lifted = run([up(2, 300, 100)], pinch.state);
    expect(kinds(lifted.effects)).toEqual(['disarm-hold', 'commit']);
    expect(lifted.state.phase).toBe('pan');
    const panned = run([move(1, 130, 110), up(1, 130, 110)], lifted.state);
    expect(kinds(panned.effects)).toEqual(['camera', 'disarm-hold', 'commit']);
    expect(panned.effects[0]).toEqual({ kind: 'camera', camera: { k: 0.4, x: 30, y: 10 } });
  });

  it('ignores a third finger and pointers it never saw', () => {
    const two = run([down(1, 0, 0), down(2, 100, 0)]);
    const three = run([down(3, 50, 50)], two.state);
    expect(three.effects).toEqual([]);
    expect(three.state).toBe(two.state);
    expect(run([move(9, 10, 10), up(9, 10, 10)]).effects).toEqual([]);
  });

  it('a cancelled press never taps', () => {
    const cancelled = run([down(1, 10, 10), { type: 'cancel', id: 1, camera: cam }]);
    expect(kinds(cancelled.effects)).toEqual(['arm-hold', 'disarm-hold']);
    expect(cancelled.state.phase).toBe('idle');
  });
});
