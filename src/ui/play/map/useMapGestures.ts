/**
 * Pan, pinch, wheel, tap, long-press and hover for the battle map, on Pointer Events (spec §7.5; no library).
 * Native listeners on the <svg>: React's onWheel and touch handlers are passive, so preventDefault (page zoom and
 * scroll) needs `{ passive: false }`. During a gesture the camera goes straight to the camera <g> at most once per
 * animation frame; it is committed (onCommit → the view store) when the gesture ends, wheel zooms debounced to
 * 150 ms. Nothing here writes the game store.
 */
import { useEffect, useRef, type RefObject } from 'react';
import { cameraTransform, clampCamera, wheelCamera, type Camera, type MapExtent, type Pt, type ViewSize } from './camera';
import { gestureStep, IDLE_GESTURE, LONG_PRESS_MS, type GestureEffect, type GestureState, type PointerKind } from './gestures';

export interface MapGestureOptions {
  extent: MapExtent;
  /** The committed camera, as a live camera for the current viewport size. */
  camera: Camera;
  viewSize(): ViewSize;
  /** A frame of a gesture was painted (the rulers follow it). */
  onFrame?(camera: Camera): void;
  onCommit(camera: Camera): void;
  /** A tap or click that didn't become a pan or a pinch (surface-local px). */
  onTap(at: Pt, pointer: PointerKind): void;
  onLongPress(at: Pt, pointer: PointerKind): void;
  /** The mouse or pen moved over the map with nothing pressed (null: it left). */
  onHover(at: Pt | null): void;
  /** Right-click. */
  onContextMenu(at: Pt): void;
}

const WHEEL_COMMIT_MS = 150;

function pointerKind(type: string): PointerKind {
  return type === 'touch' || type === 'pen' ? type : 'mouse';
}

const raf: (cb: () => void) => number =
  typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
    ? (cb) => window.requestAnimationFrame(cb)
    : (cb) => window.setTimeout(cb, 16);
const cancelRaf: (id: number) => void =
  typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function'
    ? (id) => window.cancelAnimationFrame(id)
    : (id) => window.clearTimeout(id);

export function useMapGestures(surface: RefObject<SVGSVGElement | null>, group: RefObject<SVGGElement | null>, opts: MapGestureOptions): RefObject<Camera> {
  const latest = useRef(opts);
  const live = useRef<Camera>(opts.camera);
  const gesture = useRef<GestureState>(IDLE_GESTURE);

  useEffect(() => {
    latest.current = opts;
  });

  // A new committed camera from outside (Fit, Centre on you, a resize) replaces the live one between gestures.
  useEffect(() => {
    if (gesture.current.phase === 'idle') live.current = opts.camera;
  }, [opts.camera]);

  useEffect(() => {
    const svg = surface.current;
    if (!svg) return undefined;
    let frame = 0;
    let hold = 0;
    let wheelTimer = 0;
    let hovering = false;

    const local = (e: { clientX: number; clientY: number }): Pt => {
      const r = svg.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const paint = () => {
      if (frame) return;
      frame = raf(() => {
        frame = 0;
        group.current?.setAttribute('transform', cameraTransform(live.current));
        latest.current.onFrame?.(live.current);
      });
    };
    const setLive = (cam: Camera) => {
      live.current = clampCamera(cam, latest.current.extent, latest.current.viewSize());
      paint();
    };
    const commit = () => latest.current.onCommit(live.current);
    const disarm = () => {
      window.clearTimeout(hold);
      hold = 0;
    };
    const run = (effects: GestureEffect[]) => {
      for (const fx of effects) {
        switch (fx.kind) {
          case 'camera':
            setLive(fx.camera);
            break;
          case 'commit':
            commit();
            break;
          case 'tap':
            latest.current.onTap(fx.at, fx.pointer);
            break;
          case 'long-press':
            latest.current.onLongPress(fx.at, fx.pointer);
            break;
          case 'arm-hold':
            disarm();
            hold = window.setTimeout(() => {
              hold = 0;
              step({ type: 'hold' });
            }, LONG_PRESS_MS);
            break;
          case 'disarm-hold':
            disarm();
            break;
        }
      }
    };
    const step = (input: Parameters<typeof gestureStep>[1]) => {
      const { state, effects } = gestureStep(gesture.current, input);
      gesture.current = state;
      run(effects);
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // jsdom and some older engines have no pointer capture.
      try {
        svg.setPointerCapture?.(e.pointerId);
      } catch {
        /* capture is a nicety: the gesture still works without it */
      }
      step({ type: 'down', id: e.pointerId, at: local(e), pointer: pointerKind(e.pointerType), camera: live.current });
    };
    const onMove = (e: PointerEvent) => {
      if (gesture.current.pointers.some((p) => p.id === e.pointerId)) {
        step({ type: 'move', id: e.pointerId, at: local(e) });
        return;
      }
      if (e.pointerType === 'touch') return;
      hovering = true;
      latest.current.onHover(local(e));
    };
    const onUp = (e: PointerEvent) => {
      step({ type: e.type === 'pointercancel' ? 'cancel' : 'up', id: e.pointerId, at: local(e), camera: live.current });
      try {
        if (svg.hasPointerCapture?.(e.pointerId)) svg.releasePointerCapture(e.pointerId);
      } catch {
        /* see onDown */
      }
    };
    const onLeave = () => {
      if (!hovering) return;
      hovering = false;
      latest.current.onHover(null);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setLive(wheelCamera(live.current, e, local(e).x, local(e).y));
      window.clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(commit, WHEEL_COMMIT_MS);
    };
    // Safari's own trackpad pinch events would zoom the page.
    const onGesture = (e: Event) => e.preventDefault();
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      latest.current.onContextMenu(local(e));
    };
    // iOS: keep a two-finger pinch on the map from zooming the page.
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 1) e.preventDefault();
    };

    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
    svg.addEventListener('pointercancel', onUp);
    svg.addEventListener('pointerleave', onLeave);
    svg.addEventListener('wheel', onWheel, { passive: false });
    svg.addEventListener('touchmove', onTouchMove, { passive: false });
    svg.addEventListener('gesturestart', onGesture);
    svg.addEventListener('gesturechange', onGesture);
    svg.addEventListener('contextmenu', onContextMenu);
    return () => {
      cancelRaf(frame);
      disarm();
      window.clearTimeout(wheelTimer);
      svg.removeEventListener('pointerdown', onDown);
      svg.removeEventListener('pointermove', onMove);
      svg.removeEventListener('pointerup', onUp);
      svg.removeEventListener('pointercancel', onUp);
      svg.removeEventListener('pointerleave', onLeave);
      svg.removeEventListener('wheel', onWheel);
      svg.removeEventListener('touchmove', onTouchMove);
      svg.removeEventListener('gesturestart', onGesture);
      svg.removeEventListener('gesturechange', onGesture);
      svg.removeEventListener('contextmenu', onContextMenu);
      gesture.current = IDLE_GESTURE;
    };
  }, [surface, group]);

  return live;
}
