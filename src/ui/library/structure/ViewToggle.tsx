/**
 * Two views of one thing (Fields / Source text, Excerpts / Formatted) as a native radio group: arrow
 * keys move between the views, each radio carries its keyboard shortcut in `aria-keyshortcuts`
 * (spec §4.9), and on phones and touch screens each choice is at least 44 px tall. Looks like ui.tsx's
 * Segmented, which has no shortcut or touch sizing.
 */
import { useId } from 'react';
import { cn } from '@/lib/cn';
import { TOUCH } from './touch';

export interface ViewOption<T extends string> {
  value: T;
  label: string;
  /** "Alt+1": shown as the tooltip and announced as the radio's shortcut. */
  shortcut?: string;
}

export function ViewToggle<T extends string>({
  label,
  value,
  onChange,
  options,
  size = 'md',
  className,
}: {
  /** The group's accessible name ("View"). */
  label: string;
  value: T;
  onChange(value: T): void;
  options: readonly ViewOption<T>[];
  size?: 'sm' | 'md';
  className?: string;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex rounded-xl border border-border bg-surface-2 p-0.5', className)}>
      {options.map((o) => (
        <label
          key={o.value}
          title={o.shortcut}
          className={cn(
            'flex cursor-pointer items-center justify-center rounded-[10px] font-medium whitespace-nowrap transition-colors',
            'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring',
            size === 'sm' ? 'min-h-7 px-2.5 text-xs' : 'min-h-9 px-3 text-sm',
            TOUCH,
            value === o.value ? 'bg-surface text-text shadow-sm' : 'text-muted hover:text-text',
          )}
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            aria-keyshortcuts={o.shortcut}
            className="sr-only"
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}
