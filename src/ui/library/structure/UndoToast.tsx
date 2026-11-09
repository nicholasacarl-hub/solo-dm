/**
 * The 10-second Undo toast after a review action (spec §4.6, §4.9): "Accepted 94 · They're in the
 * builder, combat and spell lists now. [Undo]". After a bulk action focus moves to Undo. One at a
 * time; a newer action replaces it. (The app's shared toast has no actions, so this one lives here.)
 */
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { RotateCcw, X } from 'lucide-react';
import { Button } from '@/ui/components/ui';
import { toast } from '@/ui/components/toast';
import { errorMessage } from '@/ui/shell/format';

export const UNDO_MS = 10_000;

interface UndoItem {
  id: number;
  message: string;
  undo?: () => Promise<void>;
  /** Move focus to Undo (bulk actions). */
  focus: boolean;
}

interface UndoStore {
  item: UndoItem | null;
  show(message: string, undo?: () => Promise<void>, opts?: { focus?: boolean }): void;
  dismiss(id?: number): void;
}

let counter = 0;

export const useUndoToast = create<UndoStore>()((set, get) => ({
  item: null,
  show(message, undo, opts) {
    set({ item: { id: ++counter, message, undo, focus: opts?.focus ?? false } });
  },
  dismiss(id) {
    if (id === undefined || get().item?.id === id) set({ item: null });
  },
}));

/** Show the Undo toast (focus moves to Undo when `focus`). */
export function showUndo(message: string, undo?: () => Promise<void>, opts?: { focus?: boolean }): void {
  useUndoToast.getState().show(message, undo, opts);
}

export function UndoToast() {
  const item = useUndoToast((s) => s.item);
  const dismiss = useUndoToast((s) => s.dismiss);
  const [busy, setBusy] = useState(false);
  const undoRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!item) return;
    const timer = window.setTimeout(() => dismiss(item.id), UNDO_MS);
    if (item.focus) undoRef.current?.focus();
    return () => window.clearTimeout(timer);
  }, [item, dismiss]);

  if (!item) return <div role="status" aria-live="polite" className="sr-only" />;

  const undo = async () => {
    if (!item.undo) return;
    setBusy(true);
    try {
      await item.undo();
      dismiss(item.id);
      toast.info('Undone.');
    } catch (error) {
      toast.error(errorMessage(error, 'Could not undo that.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-50 flex justify-center px-4 lg:bottom-6">
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex max-w-xl items-center gap-3 rounded-xl border border-border bg-surface px-4 py-2.5 text-sm shadow-card"
      >
        <span className="min-w-0 flex-1">{item.message}</span>
        {item.undo && (
          <Button ref={undoRef} size="sm" loading={busy} icon={<RotateCcw className="size-3.5" aria-hidden />} onClick={() => void undo()}>
            Undo
          </Button>
        )}
        <button type="button" aria-label="Dismiss" className="grid size-8 place-items-center rounded-lg text-faint hover:text-text" onClick={() => dismiss(item.id)}>
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
