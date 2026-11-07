/**
 * Helpers for the shell/screen component tests (not shipped: only *.test.tsx files import this).
 */
import type { ReactElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach } from 'vitest';
import { createMemoryRouter, RouterProvider, useLocation, type RouteObject } from 'react-router';

/** jsdom has no <dialog> modal API; the shared Dialog primitive calls showModal()/close(). */
export function installDialogPolyfill(): void {
  const proto = (globalThis.HTMLDialogElement ?? HTMLElement).prototype as HTMLDialogElement;
  if (typeof proto.showModal !== 'function') {
    proto.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  }
  if (typeof proto.close !== 'function') {
    proto.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  }
}

/** Unmount rendered trees after each test (vitest runs without globals, so RTL can't register it). */
export function autoCleanup(): void {
  afterEach(() => cleanup());
}

/** Shows the current path, so tests can assert on navigation. */
export function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
}

/** Render `element` at `path` in a memory router; any other path renders a LocationProbe. */
export function renderRoute(element: ReactElement, { path = '/', at = path }: { path?: string; at?: string } = {}) {
  const routes: RouteObject[] = [
    { path, element },
    { path: '*', element: <LocationProbe /> },
  ];
  const router = createMemoryRouter(routes, { initialEntries: [at] });
  const utils = render(<RouterProvider router={router} />);
  return { ...utils, router };
}
