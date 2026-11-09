/**
 * The review form's controls. Each field's <label> holds a gold "Check" tag when a warning names it
 * (so "Check" is part of the input's accessible name) and its problem is tied to the input with
 * aria-describedby. Composed from ui.tsx's primitives; ui.tsx itself is unchanged.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Input, Select } from '@/ui/components/ui';
import { TagInput } from '@/ui/components/TagInput';
import { fieldId, issueId, useRecordForm } from './context';
import { getPath, isNamed } from './paths';
import { TOUCH } from '../touch';

export interface Option {
  value: string;
  label: string;
}

/** The gold "Check" tag inside a label (with a real space, so the accessible name reads "HP Check"). */
export function CheckTag() {
  return (
    <>
      {' '}
      <span className="ml-1 inline-flex items-center rounded-full bg-gold-soft px-1.5 py-px align-middle text-[11px] font-semibold text-gold">
        Check
      </span>
    </>
  );
}

/** The first problem at a path or under it ("abilities" shows "abilities.str"'s). */
export function issueAt(issues: Readonly<Record<string, string>>, path: string): string | undefined {
  if (issues[path]) return issues[path];
  const nested = Object.keys(issues).find((k) => k.startsWith(`${path}.`));
  return nested ? issues[nested] : undefined;
}

/** Props that tie an input to its label, its problem and the source pane. */
export function useFieldProps(path: string) {
  const form = useRecordForm();
  const issue = issueAt(form.issues, path);
  return {
    id: fieldId(path),
    'aria-describedby': issue ? issueId(path) : undefined,
    'aria-invalid': issue ? true : undefined,
    onFocus: () => form.onFocusField(path),
    'data-field-path': path,
  } as const;
}

export function FieldShell({
  path,
  label,
  hint,
  children,
  className,
  as = 'label',
}: {
  path: string;
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
  /** 'legend' for groups of controls (chips, radios). */
  as?: 'label' | 'legend';
}) {
  const form = useRecordForm();
  const checked = isNamed(form.check, path);
  const issue = issueAt(form.issues, path);
  const title = (
    <>
      {label}
      {checked && <CheckTag />}
    </>
  );
  const foot = issue ? (
    <p id={issueId(path)} className="text-xs text-danger">
      {issue}
    </p>
  ) : hint ? (
    <p className="text-xs text-muted">{hint}</p>
  ) : null;
  if (as === 'legend') {
    return (
      <fieldset className={cn('flex min-w-0 flex-col gap-1.5', className)} data-field-path={path}>
        <legend className="mb-1.5 text-sm font-medium">{title}</legend>
        {children}
        {foot}
      </fieldset>
    );
  }
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={fieldId(path)} className="text-sm font-medium">
        {title}
      </label>
      {children}
      {foot}
    </div>
  );
}

export function TextField({
  path,
  label,
  optional,
  placeholder,
  hint,
  className,
  list,
}: {
  path: string;
  label: string;
  optional?: boolean;
  placeholder?: string;
  hint?: ReactNode;
  className?: string;
  list?: string;
}) {
  const form = useRecordForm();
  const props = useFieldProps(path);
  const value = getPath(form.data, path);
  return (
    <FieldShell path={path} label={label} hint={hint} className={className}>
      <Input
        {...props}
        list={list}
        value={typeof value === 'string' ? value : ''}
        placeholder={placeholder}
        maxLength={400}
        onChange={(e) => {
          const text = e.target.value;
          form.set(path, optional && text.trim() === '' ? undefined : text);
        }}
      />
    </FieldShell>
  );
}

const formatNumber = (n: number | undefined, signed: boolean) =>
  n === undefined || Number.isNaN(n) ? '' : signed && n > 0 ? `+${n}` : String(n);

function parseNumber(text: string): number | undefined | 'partial' {
  const t = text.trim().replace(/^\+/, '').replace(/[−–]/g, '-');
  if (t === '') return undefined;
  if (t === '-' || t === '.' || t === '-.') return 'partial';
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

export function NumberField({
  path,
  label,
  min,
  max,
  signed = false,
  decimal = false,
  unit,
  hint,
  className,
}: {
  path: string;
  label: string;
  min?: number;
  max?: number;
  signed?: boolean;
  decimal?: boolean;
  unit?: string;
  hint?: ReactNode;
  className?: string;
}) {
  const form = useRecordForm();
  const props = useFieldProps(path);
  const raw = getPath(form.data, path);
  const value = typeof raw === 'number' ? raw : undefined;
  const [text, setText] = useState(() => formatNumber(value, signed));
  // Follow outside changes (Use new, Fill in yourself) without fighting the player's typing.
  useEffect(() => {
    const parsed = parseNumber(text);
    if (parsed === 'partial') return;
    if (parsed !== value) setText(formatNumber(value, signed));
    // Only when the stored value changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, signed]);
  const commit = (next: string) => {
    setText(next);
    const parsed = parseNumber(next);
    if (parsed !== 'partial') form.set(path, parsed);
  };
  const step = (by: number) => {
    const base = value ?? 0;
    const next = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, base + by));
    setText(formatNumber(next, signed));
    form.set(path, next);
  };
  return (
    <FieldShell path={path} label={unit ? `${label} (${unit})` : label} hint={hint} className={className}>
      <div className="flex items-center gap-1">
        {signed && (
          <button
            type="button"
            aria-label={`Lower ${label}`}
            onClick={() => step(-1)}
            className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-surface-2 text-muted hover:text-text"
          >
            <Minus className="size-4" aria-hidden />
          </button>
        )}
        <Input
          {...props}
          inputMode={signed ? 'text' : decimal ? 'decimal' : 'numeric'}
          value={text}
          className="min-w-0 tabular-nums"
          onChange={(e) => commit(e.target.value)}
        />
        {signed && (
          <button
            type="button"
            aria-label={`Raise ${label}`}
            onClick={() => step(1)}
            className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-surface-2 text-muted hover:text-text"
          >
            <Plus className="size-4" aria-hidden />
          </button>
        )}
      </div>
    </FieldShell>
  );
}

export function SelectField({
  path,
  label,
  options,
  optional,
  emptyLabel = 'None',
  numeric = false,
  hint,
  className,
}: {
  path: string;
  label: string;
  options: readonly Option[];
  optional?: boolean;
  emptyLabel?: string;
  numeric?: boolean;
  hint?: ReactNode;
  className?: string;
}) {
  const form = useRecordForm();
  const props = useFieldProps(path);
  const raw = getPath(form.data, path);
  const value = raw === undefined || raw === null ? '' : String(raw);
  const known = options.some((o) => o.value === value);
  return (
    <FieldShell path={path} label={label} hint={hint} className={className}>
      <Select
        {...props}
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          form.set(path, v === '' ? undefined : numeric ? Number(v) : v);
        }}
      >
        {(optional || !known) && <option value="">{known || value === '' ? emptyLabel : value}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </FieldShell>
  );
}

export function CheckField({ path, label, hint }: { path: string; label: string; hint?: ReactNode }) {
  const form = useRecordForm();
  const props = useFieldProps(path);
  const checked = isNamed(form.check, path);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium">
        <input
          {...props}
          type="checkbox"
          checked={getPath(form.data, path) === true}
          onChange={(e) => form.set(path, e.target.checked)}
          className="size-4 accent-[var(--accent)]"
        />
        <span>
          {label}
          {checked && <CheckTag />}
        </span>
      </label>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** Several of a fixed set (abilities, sizes, skills): toggle buttons in a fieldset. */
export function ChipsField({
  path,
  label,
  options,
  hint,
  max,
  className,
}: {
  path: string;
  label: string;
  options: readonly Option[];
  hint?: ReactNode;
  max?: number;
  className?: string;
}) {
  const form = useRecordForm();
  const raw = getPath(form.data, path);
  const value = Array.isArray(raw) ? (raw as string[]) : [];
  const toggle = (v: string) => {
    const on = value.includes(v);
    if (!on && max !== undefined && value.length >= max) return;
    const next = on ? value.filter((x) => x !== v) : options.map((o) => o.value).filter((o) => o === v || value.includes(o));
    form.set(path, next);
  };
  return (
    <FieldShell path={path} label={label} hint={hint} as="legend" className={className}>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o, i) => {
          const pressed = value.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={pressed}
              id={i === 0 ? fieldId(path) : undefined}
              data-field-path={path}
              onFocus={() => form.onFocusField(path)}
              onClick={() => toggle(o.value)}
              className={cn(
                'min-h-9 rounded-lg border px-2.5 text-sm transition-colors',
                TOUCH,
                pressed ? 'border-accent bg-accent-soft text-text' : 'border-border bg-surface text-muted hover:text-text',
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </FieldShell>
  );
}

/** One of a few (radio semantics through native radios, like SegmentedField). */
export function SegmentField({ path, label, options, hint }: { path: string; label: string; options: readonly Option[]; hint?: ReactNode }) {
  const form = useRecordForm();
  const value = String(getPath(form.data, path) ?? '');
  const name = fieldId(path);
  return (
    <FieldShell path={path} label={label} hint={hint} as="legend">
      <div className="inline-flex max-w-full flex-wrap rounded-xl border border-border bg-surface-2 p-0.5">
        {options.map((o, i) => (
          <label
            key={o.value}
            className={cn(
              'flex min-h-9 cursor-pointer items-center rounded-[10px] px-3 text-sm font-medium text-muted transition-colors hover:text-text',
              TOUCH,
              'has-[:checked]:bg-surface has-[:checked]:text-text has-[:checked]:shadow-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring',
            )}
          >
            <input
              type="radio"
              name={name}
              id={i === 0 ? fieldId(path) : undefined}
              data-field-path={path}
              value={o.value}
              checked={value === o.value}
              onFocus={() => form.onFocusField(path)}
              onChange={() => form.set(path, o.value)}
              className="sr-only"
            />
            {o.label}
          </label>
        ))}
      </div>
    </FieldShell>
  );
}

export function TagsField({
  path,
  label,
  suggestions = [],
  optional,
  hint,
  placeholder,
}: {
  path: string;
  label: string;
  suggestions?: readonly string[];
  optional?: boolean;
  hint?: ReactNode;
  placeholder?: string;
}) {
  const form = useRecordForm();
  const props = useFieldProps(path);
  const raw = getPath(form.data, path);
  const value = Array.isArray(raw) ? (raw as string[]) : [];
  return (
    <FieldShell path={path} label={label} hint={hint}>
      <div onFocus={props.onFocus}>
        <TagInput
          id={props.id}
          label={label}
          value={value}
          describedBy={props['aria-describedby']}
          suggestions={suggestions}
          placeholder={placeholder}
          maxLength={120}
          onChange={(next) => form.set(path, optional && next.length === 0 ? undefined : next)}
        />
      </div>
    </FieldShell>
  );
}
