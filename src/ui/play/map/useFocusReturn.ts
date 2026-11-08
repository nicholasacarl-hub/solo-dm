/**
 * Keyboard focus that would fall to the page when a container replaces its own content. The battle map's action bar
 * does that whenever its buttons act — Move, Cancel, Undo, a card's Close, Clear the area, Dismiss the tip, End turn
 * — and the focused button goes with the old content. This puts focus on a stable target instead (U1).
 *
 * Only a loss is repaired: focus that moved somewhere on purpose (another control, a dialog, the composer) is left
 * alone, and so is a container that went away as a whole.
 */
import { useEffect, useRef, type RefObject } from 'react';

export function useFocusReturn(container: RefObject<HTMLElement | null>, fallback: () => void): void {
  const fallbackRef = useRef(fallback);
  useEffect(() => {
    fallbackRef.current = fallback;
  });
  useEffect(() => {
    const el = container.current;
    if (!el || typeof MutationObserver === 'undefined') return undefined;
    /** The control in the container that has (or last had) focus, until focus moves on to something else. */
    let focused: Element | null = null;
    const onFocusIn = (e: FocusEvent) => {
      focused = e.target instanceof Element ? e.target : null;
    };
    const onFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget) focused = null;
    };
    const observer = new MutationObserver(() => {
      if (!focused || focused.isConnected || !el.isConnected) return;
      focused = null;
      const active = document.activeElement;
      if (!active || active === document.body) fallbackRef.current();
    });
    observer.observe(el, { childList: true, subtree: true });
    el.addEventListener('focusin', onFocusIn);
    el.addEventListener('focusout', onFocusOut);
    return () => {
      observer.disconnect();
      el.removeEventListener('focusin', onFocusIn);
      el.removeEventListener('focusout', onFocusOut);
    };
  }, [container]);
}
