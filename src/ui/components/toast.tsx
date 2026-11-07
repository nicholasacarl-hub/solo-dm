/**
 * Minimal toast notifications: toast.success("Saved"), toast.error("..."), toast.info("...").
 * Render <Toaster /> once at the app root.
 */
import { create } from 'zustand';
import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';
import { cn } from '@/lib/cn';

type ToastTone = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastStore {
  items: ToastItem[];
  push(tone: ToastTone, message: string, ms?: number): void;
  dismiss(id: number): void;
}

let counter = 0;

const useToasts = create<ToastStore>()((set, get) => ({
  items: [],
  push(tone, message, ms = 4000) {
    const id = ++counter;
    set({ items: [...get().items, { id, tone, message }].slice(-3) });
    window.setTimeout(() => get().dismiss(id), ms);
  },
  dismiss(id) {
    set({ items: get().items.filter((t) => t.id !== id) });
  },
}));

export const toast = {
  success: (message: string) => useToasts.getState().push('success', message),
  error: (message: string) => useToasts.getState().push('error', message, 7000),
  info: (message: string) => useToasts.getState().push('info', message),
};

const icons = {
  success: <CheckCircle2 className="size-4 text-success" aria-hidden />,
  error: <TriangleAlert className="size-4 text-danger" aria-hidden />,
  info: <Info className="size-4 text-info" aria-hidden />,
};

export function Toaster() {
  const items = useToasts((s) => s.items);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-16 z-50 flex flex-col items-center gap-2 px-4"
    >
      {items.map((t) => (
        <div
          key={t.id}
          role={t.tone === 'error' ? 'alert' : 'status'}
          className={cn(
            'pointer-events-auto flex max-w-md items-start gap-2 rounded-xl border border-border bg-surface px-4 py-3 text-sm shadow-card',
          )}
        >
          <span className="mt-0.5">{icons[t.tone]}</span>
          <span className="flex-1">{t.message}</span>
          <button type="button" aria-label="Dismiss" className="text-faint hover:text-text" onClick={() => dismiss(t.id)}>
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
