import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { autoCleanup } from '@/ui/shell/testUtils';
import { UNDO_MS, UndoToast, showUndo, undoWindowMs, useUndoToast } from './UndoToast';

autoCleanup();

beforeEach(() => {
  useUndoToast.setState({ item: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the Undo toast (spec §4.6, §4.9)', () => {
  it('announces in a live region that is in the page before the toast appears', () => {
    render(<UndoToast />);
    const region = screen.getByRole('status');
    expect(region).toBeEmptyDOMElement();
    act(() => showUndo('Accepted 3.', async () => undefined));
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent('Accepted 3.');
  });

  it('moves focus to Undo after a bulk action, and undoes', async () => {
    const user = userEvent.setup();
    const undo = vi.fn(async () => undefined);
    render(<UndoToast />);
    act(() => showUndo('Accepted 28.', undo, { focus: true }));
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('after Undo, focus goes back to what had it before', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Accept 3 confident</button>
        <UndoToast />
      </>,
    );
    screen.getByRole('button', { name: 'Accept 3 confident' }).focus();
    act(() => showUndo('Accepted 3.', async () => undefined, { focus: true }));
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('button', { name: 'Accept 3 confident' })).toHaveFocus();
  });

  it("when that is gone or disabled, focus goes to the caller's target, else to <main>, never the page body", async () => {
    const user = userEvent.setup();
    render(
      <main id="main" tabIndex={-1}>
        <button type="button" disabled>
          Nothing confident to accept
        </button>
        <button type="button">To review 4</button>
        <UndoToast />
      </main>,
    );
    act(() => showUndo('Accepted 4.', async () => undefined, { focus: true, returnFocus: () => screen.getByRole('button', { name: 'To review 4' }) }));
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.getByRole('button', { name: 'To review 4' })).toHaveFocus();

    act(() => showUndo('Kept 2 as text.', async () => undefined, { focus: true }));
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    // What had focus (the chip) is still there: it gets focus back.
    expect(screen.getByRole('button', { name: 'To review 4' })).toHaveFocus();
  });

  it('focus in the toast when the window ends goes back too', () => {
    vi.useFakeTimers();
    render(
      <main id="main" tabIndex={-1}>
        <UndoToast />
      </main>,
    );
    act(() => showUndo('Accepted 2.', async () => undefined, { focus: true }));
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus();
    act(() => vi.advanceTimersByTime(UNDO_MS + 10));
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('closes after ten seconds', () => {
    vi.useFakeTimers();
    render(<UndoToast />);
    act(() => showUndo('Kept 2 as text.', async () => undefined));
    act(() => vi.advanceTimersByTime(UNDO_MS - 100));
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('gives a long message longer, and stops the window while the pointer rests on the toast', () => {
    expect(undoWindowMs('Kept 2 as text.')).toBe(UNDO_MS);
    expect(undoWindowMs('x'.repeat(240))).toBe(UNDO_MS + 160 * 50);
    expect(undoWindowMs('x'.repeat(2000))).toBe(30_000);
    vi.useFakeTimers();
    render(<UndoToast />);
    act(() => showUndo('Kept 2 as text.', async () => undefined));
    const toastBox = screen.getByRole('button', { name: 'Undo' }).closest('div')!;
    act(() => vi.advanceTimersByTime(UNDO_MS - 2_000));
    act(() => toastBox.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    act(() => toastBox.dispatchEvent(new PointerEvent('pointerout', { bubbles: true })));
    act(() => vi.advanceTimersByTime(2_500));
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('lets the window run again when the page goes while the pointer rests on the toast', () => {
    vi.useFakeTimers();
    const { unmount } = render(<UndoToast />);
    act(() => showUndo('Kept 2 as text.', async () => undefined));
    const toastBox = screen.getByRole('button', { name: 'Undo' }).closest('div')!;
    act(() => toastBox.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })));
    unmount();
    act(() => vi.advanceTimersByTime(60_000));
    render(<UndoToast />);
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('never offers a stale Undo when the page comes back after the window closed', () => {
    vi.useFakeTimers();
    const first = render(<UndoToast />);
    act(() => showUndo('Accepted 1.', async () => undefined, { focus: true }));
    first.unmount();
    act(() => vi.advanceTimersByTime(UNDO_MS + 1));
    render(<UndoToast />);
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(useUndoToast.getState().item).toBeNull();
  });

  it('keeps the rest of the window when the page comes back in time, without taking focus again', () => {
    vi.useFakeTimers();
    const first = render(<UndoToast />);
    act(() => showUndo('Accepted 1.', async () => undefined, { focus: true }));
    first.unmount();
    act(() => vi.advanceTimersByTime(4_000));
    render(
      <>
        <button type="button">Elsewhere</button>
        <UndoToast />
      </>,
    );
    screen.getByRole('button', { name: 'Elsewhere' }).focus();
    act(() => vi.advanceTimersByTime(10));
    expect(screen.getByRole('button', { name: 'Undo' })).not.toHaveFocus();
    act(() => vi.advanceTimersByTime(UNDO_MS - 4_000));
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });
});
