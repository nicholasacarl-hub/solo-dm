/**
 * Shared pieces of the character builder: radio cards (WAI-ARIA radio group with arrow keys),
 * toggle chips, the step header with "Let the DM decide", and issue lists.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronsUpDown, TriangleAlert, Wand2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/components/ui';

export interface RadioCardOption<T extends string> {
  value: T;
  title: ReactNode;
  /** Short line under the title. */
  meta?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export function RadioCards<T extends string>({
  label,
  options,
  value,
  onChange,
  columns = 'sm:grid-cols-2',
  variant = 'cards',
  collapsible = false,
  className,
}: {
  label: string;
  options: RadioCardOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  /** Tailwind grid-cols classes for wider screens (cards variant). */
  columns?: string;
  /** 'pills' = compact inline choices (size, ability, spell list). */
  variant?: 'cards' | 'pills';
  /** On small screens, show only the chosen card (with a "Change" button) once something is chosen. */
  collapsible?: boolean;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const small = useSmallScreen();
  const [expanded, setExpanded] = useState(false);
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  const selectedIndex = options.findIndex((o) => o.value === value);
  const focusable = selectedIndex >= 0 ? selectedIndex : (enabled[0] ?? -1);

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight';
    const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
    if (!forward && !back) return;
    e.preventDefault();
    const pos = enabled.indexOf(index);
    const next = enabled[(pos + (forward ? 1 : -1) + enabled.length) % enabled.length];
    if (next === undefined) return;
    refs.current[next]?.focus();
    onChange(options[next].value);
  };

  if (variant === 'pills') {
    return (
      <div role="radiogroup" aria-label={label} className={cn('flex flex-wrap gap-1.5', className)}>
        {options.map((o, i) => {
          const selected = o.value === value;
          return (
            <button
              key={o.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={o.disabled}
              tabIndex={i === focusable ? 0 : -1}
              onClick={() => onChange(o.value)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors disabled:opacity-45',
                selected ? 'border-accent bg-accent-soft text-text' : 'border-border bg-surface text-muted hover:border-faint hover:text-text',
              )}
            >
              {selected && <Check className="size-3.5" aria-hidden />}
              {o.title}
            </button>
          );
        })}
      </div>
    );
  }

  const collapsed = collapsible && small && !expanded && selectedIndex >= 0;
  const choose = (next: T) => {
    onChange(next);
    setExpanded(false);
  };

  if (collapsed) {
    const o = options[selectedIndex];
    return (
      <div className={cn('flex flex-col gap-2', className)}>
        <div role="radiogroup" aria-label={label}>
          <button
            type="button"
            role="radio"
            aria-checked
            onClick={() => setExpanded(true)}
            className="flex w-full flex-col items-start gap-1 rounded-xl border border-accent bg-accent-soft/60 px-3.5 py-3 text-left shadow-sm"
          >
            <span className="flex w-full items-start justify-between gap-2">
              <span className="font-semibold">{o.title}</span>
              <span aria-hidden className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-accent bg-accent text-accent-ink">
                <Check className="size-3.5" />
              </span>
            </span>
            {o.meta && <span className="flex flex-wrap gap-1 text-xs text-muted">{o.meta}</span>}
            {o.description && <span className="line-clamp-3 text-sm text-muted">{o.description}</span>}
          </button>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setExpanded(true)} icon={<ChevronsUpDown className="size-4" aria-hidden />} className="self-start">
          Show all {options.length} options
        </Button>
      </div>
    );
  }

  return (
    <div role="radiogroup" aria-label={label} className={cn('grid grid-cols-1 gap-2', columns, className)}>
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={o.disabled}
            tabIndex={i === focusable ? 0 : -1}
            onClick={() => choose(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              'relative flex flex-col items-start gap-1 rounded-xl border px-3.5 py-3 text-left transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-50',
              selected ? 'border-accent bg-accent-soft/60 shadow-sm' : 'border-border bg-surface hover:border-faint hover:bg-surface-2',
            )}
          >
            <span className="flex w-full items-start justify-between gap-2">
              <span className="font-semibold">{o.title}</span>
              <span
                aria-hidden
                className={cn(
                  'mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border',
                  selected ? 'border-accent bg-accent text-accent-ink' : 'border-border',
                )}
              >
                {selected && <Check className="size-3.5" />}
              </span>
            </span>
            {o.meta && <span className="flex flex-wrap gap-1 text-xs text-muted">{o.meta}</span>}
            {o.description && <span className="line-clamp-3 text-sm text-muted">{o.description}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** True below the `sm` breakpoint (640px). */
function useSmallScreen(): boolean {
  const query = '(max-width: 639px)';
  const [small, setSmall] = useState(() => typeof window !== 'undefined' && Boolean(window.matchMedia?.(query).matches));
  useEffect(() => {
    const mql = window.matchMedia?.(query);
    if (!mql) return;
    const update = () => setSmall(mql.matches);
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);
  return small;
}

/** A toggle chip (aria-pressed). Disabled chips explain why in `reason`. */
export function ToggleChip({
  pressed,
  onToggle,
  children,
  disabled,
  reason,
  tone = 'accent',
}: {
  pressed: boolean;
  onToggle: () => void;
  children: ReactNode;
  disabled?: boolean;
  reason?: string;
  tone?: 'accent' | 'arcane' | 'danger';
}) {
  const on = { accent: 'border-accent bg-accent-soft text-text', arcane: 'border-arcane bg-arcane-soft text-text', danger: 'border-danger bg-danger-soft text-danger' }[tone];
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      title={reason}
      onClick={onToggle}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-45',
        pressed ? on : 'border-border bg-surface text-muted enabled:hover:border-faint enabled:hover:text-text',
      )}
    >
      {pressed && <Check className="size-3.5" aria-hidden />}
      {children}
      {reason && disabled && <span className="sr-only">({reason})</span>}
    </button>
  );
}

export function StepHeader({
  title,
  description,
  onDmDecide,
  dmLabel = 'Let the DM decide',
}: {
  title: string;
  description: ReactNode;
  onDmDecide?: () => void;
  dmLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 className="font-display text-xl font-semibold tracking-wide">{title}</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>
      </div>
      {onDmDecide && (
        <Button variant="secondary" size="sm" onClick={onDmDecide} icon={<Wand2 className="size-4 text-arcane" aria-hidden />} className="self-start">
          {dmLabel}
        </Button>
      )}
    </div>
  );
}

export function SubHeading({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="font-display text-xs font-semibold tracking-[0.14em] text-muted uppercase">{children}</h3>
      {hint && <span className="text-xs text-muted tabular-nums">{hint}</span>}
    </div>
  );
}

/** Blocking problems for the current step. */
export function Issues({ issues, className }: { issues: string[]; className?: string }) {
  if (!issues.length) return null;
  return (
    <div role="status" className={cn('rounded-xl border border-gold/40 bg-gold-soft/60 px-3.5 py-2.5 text-sm', className)}>
      <p className="flex items-center gap-1.5 font-medium text-gold">
        <TriangleAlert className="size-4" aria-hidden /> Still to do
      </p>
      <ul className="mt-1 list-disc pl-5 text-text">
        {issues.map((issue) => (
          <li key={issue}>{issue}</li>
        ))}
      </ul>
    </div>
  );
}

/** Generated summaries ("Intelligence · d6 Hit Die · Full spellcaster") repeat the card's badges; keep prose only. */
export function proseSummary(summary: string | undefined): string | undefined {
  return summary && !summary.includes(' · ') ? summary : undefined;
}

/** A labelled detail line ("Saving throws: Strength, Constitution"). */
export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="text-sm">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
