import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { PLACEMENT, useDismiss, type Placement, type PopoverTriggerProps } from './Popover';

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  disabled?: boolean;
  onSelect: () => void;
}

/**
 * An action menu (WAI-ARIA menu button pattern): arrow keys move between items, Home/End jump,
 * Escape closes and returns focus to the trigger.
 */
export function Menu({
  label,
  items,
  trigger,
  placement = 'bottom-end',
}: {
  label: string;
  items: MenuItem[];
  trigger: (props: PopoverTriggerProps) => ReactNode;
  placement?: Placement;
}) {
  const [open, setOpen] = useState(false);
  const [initialFocus, setInitialFocus] = useState<'first' | 'last'>('first');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();
  const enabled = items.map((item, i) => (item.disabled ? -1 : i)).filter((i) => i >= 0);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  useDismiss(wrapperRef, open, (reason) => close(reason === 'escape'));

  useEffect(() => {
    if (!open) return;
    const index = initialFocus === 'first' ? enabled[0] : enabled[enabled.length - 1];
    if (index !== undefined) itemRefs.current[index]?.focus();
    // Only when the menu opens; `enabled` is derived from items each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFocus]);

  const focusItem = (from: number, step: 1 | -1) => {
    if (enabled.length === 0) return;
    const pos = enabled.indexOf(from);
    const next = enabled[(pos + step + enabled.length) % enabled.length];
    itemRefs.current[next]?.focus();
  };

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setInitialFocus(e.key === 'ArrowDown' ? 'first' : 'last');
      setOpen(true);
    }
  };

  const onItemKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusItem(index, 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusItem(index, -1);
        break;
      case 'Home':
        e.preventDefault();
        itemRefs.current[enabled[0]]?.focus();
        break;
      case 'End':
        e.preventDefault();
        itemRefs.current[enabled[enabled.length - 1]]?.focus();
        break;
      case 'Tab':
        close(false);
        break;
    }
  };

  return (
    <div ref={wrapperRef} className="relative">
      {trigger({
        'aria-expanded': open,
        'aria-controls': menuId,
        'aria-haspopup': 'menu',
        onClick: () => {
          setInitialFocus('first');
          setOpen((v) => !v);
        },
        onKeyDown: onTriggerKeyDown,
        ref: triggerRef,
      })}
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className={cn(
            'absolute z-40 min-w-56 rounded-2xl border border-border bg-surface p-1.5 text-text shadow-card',
            PLACEMENT[placement],
          )}
        >
          {items.map((item, index) => (
            <button
              key={item.id}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={item.disabled}
              onKeyDown={(e) => onItemKeyDown(e, index)}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {item.icon && <span className="text-muted">{item.icon}</span>}
              <span className="flex-1">{item.label}</span>
              {item.hint && <span className="text-xs text-faint">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
