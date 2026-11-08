/**
 * Test environment for the Play screen: jsdom gaps (dialog methods, matchMedia) and cleanup.
 * Import first in every Play test file.
 */
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { usePlayView } from '../playView';
import { resetMediaQueryCache } from '../useMediaQuery';

// jsdom implements <dialog> without showModal()/close().
const dialogProto = HTMLDialogElement.prototype;
if (typeof dialogProto.showModal !== 'function') {
  dialogProto.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  dialogProto.show = function show(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  dialogProto.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}

// jsdom has PointerEvent but no pointer capture and no SVG screen matrix (the battle map guards both; the
// polyfills let tests drive real pointer sequences).
const elementProto = Element.prototype as Element & {
  setPointerCapture?: (id: number) => void;
  releasePointerCapture?: (id: number) => void;
  hasPointerCapture?: (id: number) => boolean;
};
if (typeof elementProto.setPointerCapture !== 'function') {
  const captured = new WeakMap<Element, Set<number>>();
  elementProto.setPointerCapture = function setPointerCapture(this: Element, id: number) {
    const set = captured.get(this) ?? new Set<number>();
    set.add(id);
    captured.set(this, set);
  };
  elementProto.releasePointerCapture = function releasePointerCapture(this: Element, id: number) {
    captured.get(this)?.delete(id);
  };
  elementProto.hasPointerCapture = function hasPointerCapture(this: Element, id: number) {
    return captured.get(this)?.has(id) ?? false;
  };
}
if (typeof SVGElement !== 'undefined') {
  const svgProto = SVGElement.prototype as SVGElement & { getScreenCTM?: () => DOMMatrix | null };
  if (typeof svgProto.getScreenCTM !== 'function') svgProto.getScreenCTM = () => null;
}

const realBoundingRect = Element.prototype.getBoundingClientRect;

/**
 * jsdom lays nothing out (every rect is zero): give every element this size at the page's top-left, so the battle
 * map's viewport has a size and pointer positions map to squares. Undone after each test.
 */
export function stubBoundingRect(width: number, height: number): void {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height, toJSON: () => ({}) } as DOMRect;
  };
}

/** Install window.matchMedia answering with `matches(query)` (desktop layout, touch, reduced motion...). */
export function setMatchMedia(matches: (query: string) => boolean): void {
  resetMediaQueryCache();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: matches(query),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

export const DESKTOP = (query: string) => query.includes('min-width: 1024px');
export const TOUCH = (query: string) => query.includes('pointer: coarse');

afterEach(() => {
  cleanup();
  setMatchMedia(() => false);
  usePlayView.getState().reset();
  Element.prototype.getBoundingClientRect = realBoundingRect;
});

setMatchMedia(() => false);
