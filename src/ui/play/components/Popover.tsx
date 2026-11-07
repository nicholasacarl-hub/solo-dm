import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { cn } from '@/lib/cn';

export type Placement = 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';

export const PLACEMENT: Record<Placement, string> = {
  'top-start': 'bottom-full left-0 mb-2',
  'top-end': 'bottom-full right-0 mb-2',
  'bottom-start': 'top-full left-0 mt-2',
  'bottom-end': 'top-full right-0 mt-2',
};

/** Close on Escape and on pointer-down outside `ref`. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onDismiss: (reason: 'escape' | 'outside') => void) {
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  });
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) dismissRef.current('outside');
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        dismissRef.current('escape');
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, ref]);
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface PopoverTriggerProps {
  'aria-expanded': boolean;
  'aria-controls': string;
  'aria-haspopup': 'dialog' | 'menu';
  onClick: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
  ref: RefObject<HTMLButtonElement | null>;
}

/**
 * A non-modal popover panel (role="dialog") anchored to its trigger. Focus moves into the panel
 * when it opens and back to the trigger when it is dismissed with Escape.
 */
export function Popover({
  label,
  trigger,
  children,
  placement = 'bottom-end',
  className,
  open: controlledOpen,
  onOpenChange,
  anchor = 'trigger',
}: {
  label: string;
  trigger: (props: PopoverTriggerProps) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  placement?: Placement;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 'parent' positions the panel against the nearest positioned ancestor instead of the trigger. */
  anchor?: 'trigger' | 'parent';
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  useDismiss(wrapperRef, open, (reason) => close(reason === 'escape'));

  useEffect(() => {
    if (!open) return;
    const first = panelRef.current?.querySelector<HTMLElement>('[data-autofocus]') ?? panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
  }, [open]);

  return (
    <div ref={wrapperRef} className={anchor === 'trigger' ? 'relative' : undefined}>
      {trigger({
        'aria-expanded': open,
        'aria-controls': panelId,
        'aria-haspopup': 'dialog',
        onClick: () => setOpen(!open),
        ref: triggerRef,
      })}
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={label}
          className={cn(
            'absolute z-40 w-72 rounded-2xl border border-border bg-surface p-3 text-text shadow-card',
            PLACEMENT[placement],
            className,
          )}
        >
          {typeof children === 'function' ? children(() => close()) : children}
        </div>
      )}
    </div>
  );
}
