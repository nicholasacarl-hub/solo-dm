/**
 * The battle map's pointer gestures as a pure state machine (spec §7.5): one pointer pans once it moves past a
 * slop (touch 10px, pen 6px, mouse 4px) and taps if it doesn't; a 500 ms touch or pen hold is a long press; two
 * pointers pinch about their midpoint, and lifting one carries on as a pan, never a tap. useMapGestures feeds it
 * DOM pointer events and carries out the effects (paint the camera, commit it, tap, long-press, the hold timer).
 */
import { panBy, pinchCamera, type Camera, type Pt } from './camera';

export type PointerKind = 'mouse' | 'touch' | 'pen';

export const SLOP_PX: Readonly<Record<PointerKind, number>> = { touch: 10, pen: 6, mouse: 4 };
export const LONG_PRESS_MS = 500;

export interface GestureState {
  /** press: down, not moved past the slop yet; consumed: a long press used it up (no tap, no pan). */
  phase: 'idle' | 'press' | 'pan' | 'pinch' | 'consumed';
  /** Pointers down, oldest first (surface-local px). */
  pointers: readonly { id: number; at: Pt }[];
  pointer: PointerKind;
  /** Where the press or pan started; a pinch's starting pair. */
  origin: readonly Pt[];
  /** The camera when the pan or pinch started. */
  startCamera: Camera;
}

export type GestureInput =
  | { type: 'down'; id: number; at: Pt; pointer: PointerKind; camera: Camera }
  | { type: 'move'; id: number; at: Pt }
  | { type: 'up'; id: number; at: Pt; camera: Camera }
  | { type: 'cancel'; id: number; camera: Camera }
  /** The long-press timer fired. */
  | { type: 'hold' };

export type GestureEffect =
  /** Paint this camera now (live; not committed). */
  | { kind: 'camera'; camera: Camera }
  /** A pan or pinch ended: commit the live camera. */
  | { kind: 'commit' }
  | { kind: 'tap'; at: Pt; pointer: PointerKind }
  | { kind: 'long-press'; at: Pt; pointer: PointerKind }
  | { kind: 'arm-hold' }
  | { kind: 'disarm-hold' };

export const IDLE_GESTURE: GestureState = {
  phase: 'idle',
  pointers: [],
  pointer: 'mouse',
  origin: [],
  startCamera: { k: 1, x: 0, y: 0 },
};

type Step = { state: GestureState; effects: GestureEffect[] };

const distance = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

function withPointer(pointers: GestureState['pointers'], id: number, at: Pt): GestureState['pointers'] {
  return pointers.some((p) => p.id === id) ? pointers.map((p) => (p.id === id ? { id, at } : p)) : [...pointers, { id, at }];
}

function pair(pointers: GestureState['pointers']): [Pt, Pt] {
  return [pointers[0].at, pointers[1].at];
}

export function gestureStep(state: GestureState, input: GestureInput): Step {
  switch (input.type) {
    case 'down':
      return down(state, input);
    case 'move':
      return move(state, input);
    case 'up':
    case 'cancel':
      return lift(state, input);
    case 'hold':
      if (state.phase !== 'press' || state.pointers.length !== 1) return { state, effects: [] };
      return {
        state: { ...state, phase: 'consumed' },
        effects: [{ kind: 'long-press', at: state.origin[0], pointer: state.pointer }],
      };
  }
}

function down(state: GestureState, input: Extract<GestureInput, { type: 'down' }>): Step {
  // A third finger changes nothing.
  if (state.pointers.length >= 2) return { state, effects: [] };
  const pointers = withPointer(state.pointers, input.id, input.at);
  if (pointers.length === 1) {
    const holdable = input.pointer !== 'mouse';
    return {
      state: { phase: 'press', pointers, pointer: input.pointer, origin: [input.at], startCamera: input.camera },
      effects: holdable ? [{ kind: 'arm-hold' }] : [],
    };
  }
  // A second pointer: pinch from where both are now, with the camera as it is now.
  return {
    state: { phase: 'pinch', pointers, pointer: state.pointer, origin: pair(pointers), startCamera: input.camera },
    effects: [{ kind: 'disarm-hold' }],
  };
}

function move(state: GestureState, input: Extract<GestureInput, { type: 'move' }>): Step {
  if (!state.pointers.some((p) => p.id === input.id)) return { state, effects: [] };
  const pointers = withPointer(state.pointers, input.id, input.at);
  if (state.phase === 'press') {
    if (distance(input.at, state.origin[0]) <= SLOP_PX[state.pointer]) return { state: { ...state, pointers }, effects: [] };
    const camera = panBy(state.startCamera, input.at.x - state.origin[0].x, input.at.y - state.origin[0].y);
    return { state: { ...state, phase: 'pan', pointers }, effects: [{ kind: 'disarm-hold' }, { kind: 'camera', camera }] };
  }
  if (state.phase === 'pan') {
    const camera = panBy(state.startCamera, input.at.x - state.origin[0].x, input.at.y - state.origin[0].y);
    return { state: { ...state, pointers }, effects: [{ kind: 'camera', camera }] };
  }
  if (state.phase === 'pinch' && pointers.length >= 2) {
    const camera = pinchCamera(state.startCamera, [state.origin[0], state.origin[1]], pair(pointers));
    return { state: { ...state, pointers }, effects: [{ kind: 'camera', camera }] };
  }
  return { state: { ...state, pointers }, effects: [] };
}

function lift(state: GestureState, input: Extract<GestureInput, { type: 'up' | 'cancel' }>): Step {
  if (!state.pointers.some((p) => p.id === input.id)) return { state, effects: [] };
  const pointers = state.pointers.filter((p) => p.id !== input.id);
  const effects: GestureEffect[] = [{ kind: 'disarm-hold' }];
  if (state.phase === 'press' && input.type === 'up') effects.push({ kind: 'tap', at: input.at, pointer: state.pointer });
  if (state.phase === 'pan' || state.phase === 'pinch') effects.push({ kind: 'commit' });
  if (pointers.length === 0) return { state: { ...IDLE_GESTURE, pointer: state.pointer, startCamera: input.camera }, effects };
  if (state.phase === 'pinch') {
    // One finger left after a pinch: carry on panning from where it is, without a tap.
    return {
      state: { phase: 'pan', pointers, pointer: state.pointer, origin: [pointers[0].at], startCamera: input.camera },
      effects,
    };
  }
  return { state: { ...state, pointers }, effects };
}
