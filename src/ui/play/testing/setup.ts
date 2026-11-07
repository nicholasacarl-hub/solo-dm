/**
 * Test environment for the Play screen: jsdom gaps (dialog methods, matchMedia) and cleanup.
 * Import first in every Play test file.
 */
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { forgetCampaignHolds } from '../campaignLock';
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
  forgetCampaignHolds();
});

setMatchMedia(() => false);
