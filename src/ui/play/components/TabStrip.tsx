import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface TabStripItem<T extends string> {
  value: T;
  label: string;
  icon: ReactNode;
  /** Small attention dot (e.g. combat is active). */
  dot?: 'danger' | 'accent';
  /** Screen-reader text for the dot. */
  dotLabel?: string;
}

/**
 * Compact icon-over-label tabs with roving focus (Left/Right/Home/End), shared by the journal
 * panel and the mobile bottom bar. Panels use ids `${idPrefix}-panel-${value}`.
 */
export function TabStrip<T extends string>({
  label,
  items,
  value,
  onChange,
  idPrefix,
  className,
  variant = 'panel',
  labels = 'always',
}: {
  label: string;
  items: TabStripItem<T>[];
  value: T;
  onChange: (value: T) => void;
  idPrefix: string;
  className?: string;
  /** 'panel' = underline tabs in a card; 'bar' = the mobile bottom tab bar. */
  variant?: 'panel' | 'bar';
  /** 'selected' = only the active tab shows its label (narrow rails); others show it on hover. */
  labels?: 'always' | 'selected';
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const move = (index: number) => {
    const next = (index + items.length) % items.length;
    onChange(items[next].value);
    refs.current[next]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key === 'ArrowRight') move(index + 1);
    else if (e.key === 'ArrowLeft') move(index - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(items.length - 1);
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        labels === 'selected' ? 'flex' : 'grid',
        variant === 'panel' && 'border-b border-border',
        className,
      )}
      style={labels === 'selected' ? undefined : { gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
    >
      {items.map((item, index) => {
        const selected = item.value === value;
        const showLabel = labels === 'always' || selected;
        return (
          <button
            key={item.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            id={`${idPrefix}-tab-${item.value}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${item.value}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.value)}
            onKeyDown={(e) => onKeyDown(e, index)}
            title={showLabel ? undefined : item.label}
            className={cn(
              'relative flex min-w-0 items-center font-medium transition-colors',
              // Narrow rails: icon-only tabs stay small so the selected one has room for its label.
              labels === 'selected'
                ? cn('justify-center gap-1 text-xs', selected ? 'flex-1 px-1' : 'w-6 shrink-0')
                : cn('flex-col gap-1 text-[0.6875rem]', variant === 'panel' ? 'px-0 tracking-tight' : 'px-1'),
              variant === 'panel' ? '-mb-px border-b-2 pt-1.5 pb-2' : 'pt-2 pb-1.5',
              selected
                ? variant === 'panel'
                  ? 'border-accent text-text'
                  : 'text-accent'
                : cn('text-muted hover:text-text', variant === 'panel' && 'border-transparent'),
            )}
          >
            <span className="relative">
              {item.icon}
              {item.dot && (
                <span
                  aria-hidden
                  className={cn(
                    'absolute -top-0.5 -right-1 size-2 rounded-full ring-2 ring-surface',
                    item.dot === 'danger' ? 'bg-danger' : 'bg-accent',
                  )}
                />
              )}
            </span>
            <span className={cn('max-w-full truncate', !showLabel && 'sr-only')}>{item.label}</span>
            {item.dot && item.dotLabel && <span className="sr-only">({item.dotLabel})</span>}
          </button>
        );
      })}
    </div>
  );
}
