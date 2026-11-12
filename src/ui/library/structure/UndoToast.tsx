/**
 * The Undo toast after a review action (spec §4.6, §4.9): "Accepted 94 · They're in the builder, combat
 * and spell lists now. [Undo]". Its window is 10 seconds, longer for a long message, and stops while the
 * pointer rests on it. After a bulk action focus moves to Undo. One at a time; a newer action replaces
 * it. (The app's shared toast has no actions, so this one lives here.)
 *
 * The polite live region is always in the page and only its content changes, so screen readers
 * announce every toast. The Undo window runs from the action, not from the toast's mount: leaving the
 * book page and coming back later never offers a stale Undo. When the toast closes with focus inside it
 * (Undo, ×, or the window ending), focus goes back to where it was, else to the caller's target, else
 * to the page's <main>, never to the page body.
 */
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { LoaderCircle, RotateCcw, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/components/ui';
import { toast } from '@/ui/components/toast';
import { errorMessage } from '@/ui/shell/format';
import { TOUCH, TOUCH_SQUARE } from './touch';

export const UNDO_MS = 10_000;
/** A long message gets longer to read before its Undo goes (up to 30 seconds). */
export const undoWindowMs = (message: string): number => Math.min(30_000, UNDO_MS + Math.max(0, message.length - 80) * 50);

interface UndoItem {
  id: number;
  message: string;
  undo?: () => Promise<void>;
  /** Move focus to Undo (bulk actions). */
  focus: boolean;
  /** Where focus goes when the toast closes with focus in it and the earlier focus is gone or disabled. */
  returnFocus?: () => HTMLElement | null;
  /** When the Undo window closes (epoch ms). */
  expiresAt: number;
  /** While the pointer rests on the toast: how much of the window was left. */
  pausedLeft?: number;
}

export interface UndoOptions {
  focus?: boolean;
  returnFocus?: () => HTMLElement | null;
}

interface UndoStore {
  item: UndoItem | null;
  show(message: string, undo?: () => Promise<void>, opts?: UndoOptions): void;
  dismiss(id?: number): void;
  /** The pointer rests on the toast: its window stops running. */
  pause(id: number): void;
  /** The pointer left: the window runs on, with at least a few seconds left. */
  resume(id: number): void;
}

let counter = 0;
/** The last toast whose Undo took focus: a remount must not take it again. */
let focusedId = 0;

export const useUndoToast = create<UndoStore>()((set, get) => ({
  item: null,
  show(message, undo, opts) {
    set({ item: { id: ++counter, message, undo, focus: opts?.focus ?? false, returnFocus: opts?.returnFocus, expiresAt: Date.now() + undoWindowMs(message) } });
  },
  dismiss(id) {
    if (id === undefined || get().item?.id === id) set({ item: null });
  },
  pause(id) {
    const item = get().item;
    if (item?.id === id && item.pausedLeft === undefined) set({ item: { ...item, pausedLeft: Math.max(0, item.expiresAt - Date.now()) } });
  },
  resume(id) {
    const item = get().item;
    if (item?.id === id && item.pausedLeft !== undefined) {
      const { pausedLeft, ...rest } = item;
      set({ item: { ...rest, expiresAt: Date.now() + Math.max(pausedLeft, 3_000) } });
    }
  },
}));

/** Whether an Undo is still on offer (its window hasn't closed): DM notices about what it would undo wait for it. */
export function undoOffered(): boolean {
  const item = useUndoToast.getState().item;
  return item !== null && (item.pausedLeft !== undefined || item.expiresAt > Date.now());
}

/** Show the Undo toast (focus moves to Undo when `focus`). */
export function showUndo(message: string, undo?: () => Promise<void>, opts?: UndoOptions): void {
  useUndoToast.getState().show(message, undo, opts);
}

const focusable = (el: HTMLElement | null | undefined): el is HTMLElement =>
  !!el && el.isConnected && el !== document.body && !(el as HTMLButtonElement).disabled;

export function UndoToast() {
  const stored = useUndoToast((s) => s.item);
  const dismiss = useUndoToast((s) => s.dismiss);
  const pause = useUndoToast((s) => s.pause);
  const resume = useUndoToast((s) => s.resume);
  const [busy, setBusy] = useState(false);
  const undoRef = useRef<HTMLButtonElement>(null);
  const toastRef = useRef<HTMLDivElement>(null);
  /** What had focus before Undo took it. */
  const before = useRef<HTMLElement | null>(null);
  // An item whose window closed while this page was away is not shown again.
  const item = stored && (stored.pausedLeft !== undefined || stored.expiresAt > Date.now()) ? stored : null;

  /** Close the toast; if focus is in it, put focus back first (the buttons are about to go). */
  const close = (closing: UndoItem) => {
    if (toastRef.current?.contains(document.activeElement)) {
      const target = [before.current, closing.returnFocus?.(), document.getElementById('main')].find(focusable);
      target?.focus({ preventScroll: true });
    }
    before.current = null;
    dismiss(closing.id);
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  // The page goes while the pointer rests on the toast: its window runs again, so it can't wait forever.
  useEffect(
    () => () => {
      const left = useUndoToast.getState().item;
      if (left?.pausedLeft !== undefined) useUndoToast.getState().resume(left.id);
    },
    [],
  );

  useEffect(() => {
    if (!stored) return;
    const left = stored.expiresAt - Date.now();
    if (stored.pausedLeft === undefined && left <= 0) {
      dismiss(stored.id);
      return;
    }
    const timer = stored.pausedLeft === undefined ? window.setTimeout(() => closeRef.current(stored), left) : undefined;
    if (stored.focus && focusedId !== stored.id) {
      focusedId = stored.id;
      const active = document.activeElement;
      before.current = active instanceof HTMLElement && !toastRef.current?.contains(active) ? active : null;
      undoRef.current?.focus();
    }
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [stored, dismiss]);

  const undo = async () => {
    if (!item?.undo || busy) return;
    setBusy(true);
    try {
      await item.undo();
      close(item);
      toast.info('Undone.');
    } catch (error) {
      toast.error(errorMessage(error, 'Could not undo that.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-50 flex justify-center px-4 lg:bottom-6"
    >
      {item && (
        <div
          key={item.id}
          ref={toastRef}
          onPointerEnter={() => pause(item.id)}
          onPointerLeave={() => resume(item.id)}
          className="pointer-events-auto flex max-w-xl items-center gap-3 rounded-xl border border-border bg-surface px-4 py-2.5 text-sm shadow-card"
        >
          <span className="min-w-0 flex-1">{item.message}</span>
          {/* Busy is aria-disabled, not disabled: disabling the focused button would drop focus to the page body. */}
          {item.undo && (
            <Button
              ref={undoRef}
              size="sm"
              className={TOUCH}
              aria-disabled={busy || undefined}
              icon={busy ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : <RotateCcw className="size-3.5" aria-hidden />}
              onClick={() => void undo()}
            >
              Undo
            </Button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            className={cn('grid size-8 place-items-center rounded-lg text-faint hover:text-text', TOUCH_SQUARE)}
            onClick={() => close(item)}
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}
