import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStickToBottom, type StickToBottom } from './useStickToBottom';

/** A ResizeObserver the test drives: it records what is observed and fires on demand. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {
    this.observed = [];
  }
  fire() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

let hook: StickToBottom | null = null;

function Log() {
  hook = useStickToBottom(0);
  return (
    <div ref={hook.scrollRef} onScroll={hook.onScroll} data-testid="scroll">
      <div ref={hook.contentRef}>story</div>
    </div>
  );
}

/** jsdom lays nothing out: give the scroll container a size and a scroll position. */
function layout(el: HTMLElement, sizes: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: sizes.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: sizes.clientHeight });
  el.scrollTop = sizes.scrollTop;
}

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  hook = null;
});

describe('useStickToBottom (spec §7.10)', () => {
  it('watches the scroll container as well as the content, so the log re-pins when the map’s dock shrinks it', () => {
    const { getByTestId } = render(<Log />);
    const el = getByTestId('scroll');
    const observer = FakeResizeObserver.instances.at(-1) as FakeResizeObserver;
    expect(observer.observed).toContain(el);
    expect(observer.observed).toContain(el.firstElementChild);

    const scrollTo = vi.fn();
    el.scrollTo = scrollTo as unknown as typeof el.scrollTo;
    // The dock opens above the log: the container gets shorter while the reader was at the bottom.
    layout(el, { scrollHeight: 2000, clientHeight: 290, scrollTop: 1710 });
    act(() => observer.fire());
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 2000, behavior: 'auto' });
  });

  it('leaves a reader who scrolled up where they are', () => {
    const { getByTestId } = render(<Log />);
    const el = getByTestId('scroll');
    const observer = FakeResizeObserver.instances.at(-1) as FakeResizeObserver;
    const scrollTo = vi.fn();
    el.scrollTo = scrollTo as unknown as typeof el.scrollTo;
    layout(el, { scrollHeight: 2000, clientHeight: 336, scrollTop: 400 });
    act(() => hook?.onScroll());
    expect(hook?.atBottom).toBe(false);
    scrollTo.mockClear();
    act(() => observer.fire());
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
