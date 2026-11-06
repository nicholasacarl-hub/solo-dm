/**
 * Shared UI primitives. Use these instead of ad-hoc styles so every screen feels consistent.
 * Styling uses theme tokens from src/index.css (bg, surface, border, text, muted, accent...).
 */
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Loader2, X } from 'lucide-react';
import { cn } from '@/lib/cn';

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'arcane';
export type ButtonSize = 'sm' | 'md' | 'lg';

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-hover shadow-sm',
  secondary: 'bg-surface-2 text-text hover:bg-surface-3 border border-border',
  ghost: 'text-muted hover:text-text hover:bg-surface-2',
  danger: 'bg-danger text-white hover:opacity-90',
  arcane: 'bg-arcane text-white hover:opacity-90',
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-6 text-base gap-2 rounded-xl',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-medium transition-colors select-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible label (also used as the tooltip). */
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, variant = 'ghost', size = 'md', className, children, type = 'button', ...rest },
  ref,
) {
  const dims = size === 'sm' ? 'size-8 rounded-lg' : size === 'lg' ? 'size-12 rounded-xl' : 'size-10 rounded-xl';
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center transition-colors disabled:opacity-50',
        buttonVariants[variant],
        dims,
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-2xl border border-border bg-surface shadow-card', className)} {...rest} />;
}

export function SectionTitle({ children, className, action }: { children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <div className={cn('mb-2 flex items-center justify-between gap-2', className)}>
      <h3 className="font-display text-xs font-semibold tracking-[0.14em] text-muted uppercase">{children}</h3>
      {action}
    </div>
  );
}

export type BadgeTone = 'neutral' | 'accent' | 'danger' | 'success' | 'arcane' | 'gold' | 'info';

const badgeTones: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-muted border-border',
  accent: 'bg-accent-soft text-accent border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
  success: 'bg-success-soft text-success border-transparent',
  arcane: 'bg-arcane-soft text-arcane border-transparent',
  gold: 'bg-gold-soft text-gold border-transparent',
  info: 'bg-info-soft text-info border-transparent',
};

export function Badge({ tone = 'neutral', className, children }: { tone?: BadgeTone; className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        badgeTones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return <Loader2 className={cn('size-5 animate-spin text-muted', className)} aria-label={label} role="status" />;
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-3 px-6 py-10 text-center', className)}>
      {icon && <div className="text-faint">{icon}</div>}
      <p className="font-display text-base font-semibold">{title}</p>
      {children && <div className="max-w-sm text-sm text-muted">{children}</div>}
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

export function Field({
  label,
  hint,
  error,
  children,
  className,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

const controlBase =
  'w-full rounded-xl border border-border bg-surface px-3 text-sm text-text placeholder:text-faint ' +
  'transition-colors focus:border-accent focus:outline-none disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cn(controlBase, 'h-10', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cn(controlBase, 'min-h-24 py-2 leading-relaxed', className)} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={cn(controlBase, 'h-10 pr-8', className)} {...rest}>
      {children}
    </select>
  );
});

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {description && <span className="text-xs text-muted">{description}</span>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
          checked ? 'bg-accent' : 'bg-surface-3',
        )}
      >
        <span
          className={cn(
            'inline-block size-5 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-5' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  );
}

/** Pill-free segmented control for small enums. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = 'md',
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: ReactNode; title?: string }[];
  className?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div role="radiogroup" className={cn('inline-flex rounded-xl border border-border bg-surface-2 p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-[10px] font-medium transition-colors',
            size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm',
            value === o.value ? 'bg-surface text-text shadow-sm' : 'text-muted hover:text-text',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  tabs: { value: T; label: ReactNode; icon?: ReactNode; badge?: ReactNode }[];
  className?: string;
}) {
  return (
    <div role="tablist" className={cn('flex gap-1 overflow-x-auto border-b border-border scroll-thin', className)}>
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          type="button"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cn(
            '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors',
            value === t.value ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text',
          )}
        >
          {t.icon}
          {t.label}
          {t.badge}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog (modal) — native <dialog> for focus trapping and Escape handling
// ---------------------------------------------------------------------------

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** When false, Escape and backdrop clicks don't close it (e.g. a roll the DM is waiting on). */
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(e) => {
        if (dismissible && e.target === ref.current) onClose();
      }}
      className={cn(
        'm-auto w-[calc(100%-2rem)] rounded-2xl border border-border bg-surface p-0 text-text shadow-card backdrop:bg-black/60',
        widths[size],
      )}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div>
              <h2 className="font-display text-lg font-semibold">{title}</h2>
              {description && <p className="mt-1 text-sm text-muted">{description}</p>}
            </div>
            {dismissible && (
              <IconButton label="Close" size="sm" onClick={onClose}>
                <X className="size-4" />
              </IconButton>
            )}
          </div>
          <div className="overflow-y-auto px-5 py-4 scroll-thin">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}
