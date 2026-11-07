/**
 * Accessible single-choice controls built on native radio inputs (arrow keys, form semantics,
 * a real <legend> as the group name).
 *
 * - <OptionCards> shows every option with a one-line explanation (rules settings, model picker).
 * - <SegmentedField> is the compact variant for short enums (theme, text size).
 */
import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface OptionCardOption<T extends string> {
  value: T;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  /** Right-aligned extra, e.g. a "Recommended" badge or a price. */
  aside?: ReactNode;
}

const columnClasses = {
  1: '',
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-3',
  4: 'sm:grid-cols-2 lg:grid-cols-4',
} as const;

export function OptionCards<T extends string>({
  legend,
  hint,
  value,
  onChange,
  options,
  columns = 1,
  name,
  className,
}: {
  legend: ReactNode;
  hint?: ReactNode;
  value: T;
  onChange: (value: T) => void;
  options: readonly OptionCardOption<T>[];
  columns?: keyof typeof columnClasses;
  /** Radio group name; generated when omitted. */
  name?: string;
  className?: string;
}) {
  const autoName = useId();
  const group = name ?? autoName;
  return (
    <fieldset className={cn('min-w-0', className)}>
      <legend className="text-sm font-medium">{legend}</legend>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      <div className={cn('mt-2 grid grid-cols-1 gap-2', columnClasses[columns])}>
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              'group relative flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-surface px-3 py-2.5 transition-colors',
              'hover:border-faint has-[:checked]:border-accent has-[:checked]:bg-accent-soft/40',
              'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
            )}
          >
            <input
              type="radio"
              name={group}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.icon && <span className="mt-0.5 shrink-0 text-muted group-has-[:checked]:text-accent">{option.icon}</span>}
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                <span className="text-sm font-medium">{option.label}</span>
                {option.aside}
              </span>
              {option.description && (
                <span className="mt-0.5 block text-xs leading-snug text-muted">{option.description}</span>
              )}
            </span>
            <span
              aria-hidden
              className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border border-faint group-has-[:checked]:border-accent"
            >
              <span className="size-2 rounded-full bg-accent opacity-0 group-has-[:checked]:opacity-100" />
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
}

/** Compact segmented control with a visible legend. */
export function SegmentedField<T extends string>({
  legend,
  hint,
  value,
  onChange,
  options,
  name,
  className,
}: {
  legend: ReactNode;
  hint?: ReactNode;
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentOption<T>[];
  name?: string;
  className?: string;
}) {
  const autoName = useId();
  const group = name ?? autoName;
  return (
    <fieldset className={cn('min-w-0', className)}>
      <legend className="text-sm font-medium">{legend}</legend>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      <div className="mt-2 inline-flex max-w-full flex-wrap rounded-xl border border-border bg-surface-2 p-0.5">
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              'flex cursor-pointer items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:text-text',
              'has-[:checked]:bg-surface has-[:checked]:text-text has-[:checked]:shadow-sm',
              'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring',
            )}
          >
            <input
              type="radio"
              name={group}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
