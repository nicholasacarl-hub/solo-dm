/**
 * The review form for one record (spec §4.5): Name, What it is (kind) and Edition, then the kind's
 * "Key stats" group (always open) and collapsed groups — the first group with a warning or a problem
 * opens. Rendered from FORM_SPECS; bespoke editors through editors.tsx. A `focusRequest` opens the
 * field's group and focuses it ("Go to field"). Edits arrive with the app-written fields re-derived
 * (a monster's speed line and CR value, a gear row's description).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { CandidateBlock } from '@/data';
import { cn } from '@/lib/cn';
import { STRUCTURED_KINDS, type BuilderData, type CompendiumEntry, type SourceFormat, type StructuredDataByKind, type StructuredKind, type StructuredRecord } from '@/types';
import { Input, Select } from '@/ui/components/ui';
import { KIND_LABELS } from '../labels';
import { FormContext, fieldId, type AnyData, type RecordFormContext } from './context';
import { CheckField, CheckTag, ChipsField, NumberField, SegmentField, SelectField, TagsField, TextField } from './controls';
import { Editor } from './editors';
import { withDerived } from './draft';
import { SUGGESTIONS, groupOfPath, groupsFor, pathsOf, type FieldSpec, type FormGroup } from './formSpecs';
import { isNamed, setPath } from './paths';

export interface RecordFormProps<K extends StructuredKind> {
  kind: K;
  value: StructuredDataByKind[K];
  onChange(next: StructuredDataByKind[K]): void;
  check: ReadonlySet<string>;
  issues: Record<string, string>;
  blocks: CandidateBlock[];
  builder: BuilderData | null;
  disabled: boolean;
  name: string;
  onNameChange(name: string): void;
  /** "What it is" changed: re-detect the record's entries as that kind. */
  onKindChange?(kind: StructuredKind): void;
  entriesById: ReadonlyMap<string, CompendiumEntry>;
  sourceId: string;
  bookRecords: readonly StructuredRecord[];
  parentClassId?: string;
  onParentClassChange(id: string | undefined): void;
  onFocusField(path: string): void;
  /** "Go to field": the path to show and focus (n changes on every request). */
  focusRequest?: { path: string; n: number } | null;
}

function suggestionsFor(field: FieldSpec, ctx: RecordFormContext): readonly string[] {
  if (field.type !== 'tags' || !field.suggest) return [];
  if (field.suggest === 'classes') {
    const names = new Set((ctx.builder?.classes ?? []).map((c) => c.name));
    for (const r of ctx.bookRecords) if (r.kind === 'class' && r.status !== 'rejected') names.add(r.name);
    return [...names].sort((a, b) => a.localeCompare(b));
  }
  if (field.suggest === 'tools') return (ctx.builder?.equipment ?? []).filter((e) => e.category === 'tool').map((e) => e.name);
  return SUGGESTIONS[field.suggest];
}

function FieldView({ field, ctx }: { field: FieldSpec; ctx: RecordFormContext }) {
  switch (field.type) {
    case 'text':
      return <TextField path={field.path} label={field.label} optional={field.optional} placeholder={field.placeholder} hint={field.hint} />;
    case 'number':
      return (
        <NumberField
          path={field.path}
          label={field.label}
          min={field.min}
          max={field.max}
          signed={field.signed}
          decimal={field.decimal}
          unit={field.unit}
          hint={field.hint}
        />
      );
    case 'select':
      return (
        <SelectField
          path={field.path}
          label={field.label}
          options={field.options}
          optional={field.optional}
          numeric={field.numeric}
          emptyLabel={field.emptyLabel}
          hint={field.hint}
        />
      );
    case 'segment':
      return <SegmentField path={field.path} label={field.label} options={field.options} hint={field.hint} />;
    case 'check':
      return <CheckField path={field.path} label={field.label} hint={field.hint} />;
    case 'chips':
      return <ChipsField path={field.path} label={field.label} options={field.options} max={field.max} hint={field.hint} />;
    case 'tags':
      return <TagsField path={field.path} label={field.label} optional={field.optional} hint={field.hint} suggestions={suggestionsFor(field, ctx)} />;
    case 'editor':
      return <Editor editor={field.editor} path={field.path} label={field.label} />;
  }
}

const groupNamed = (group: FormGroup, names: ReadonlySet<string>) => group.fields.some((f) => pathsOf(f).some((p) => isNamed(names, p)));

function Group({ group, open, onToggle, flagged, children }: { group: FormGroup; open: boolean; onToggle(open: boolean): void; flagged: boolean; children: ReactNode }) {
  if (group.key) {
    return (
      <section aria-labelledby={`rf-group-${group.id}`} className="flex flex-col gap-3">
        <h3 id={`rf-group-${group.id}`} className="font-display text-xs font-semibold tracking-[0.14em] text-muted uppercase">
          {group.title}
        </h3>
        {children}
      </section>
    );
  }
  return (
    <details open={open} onToggle={(e) => onToggle(e.currentTarget.open)} className="group/fg rounded-xl border border-border bg-surface">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 text-muted transition-transform group-open/fg:rotate-90" aria-hidden />
        <span className="flex-1">{group.title}</span>
        {flagged && <CheckTag />}
      </summary>
      <div className="flex flex-col gap-3 border-t border-border px-3 pt-3 pb-3">{children}</div>
    </details>
  );
}

const EDITIONS: { value: SourceFormat; label: string }[] = [
  { value: '2024', label: '2024' },
  { value: '2014', label: 'Older' },
];

export function RecordForm<K extends StructuredKind>(props: RecordFormProps<K>) {
  const { kind, value, onChange, check, issues, blocks, builder, disabled, name, onNameChange, onKindChange, entriesById, sourceId, bookRecords, parentClassId, onParentClassChange, onFocusField, focusRequest } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => groupsFor(kind, value), [kind, value]);
  const flaggedNames = useMemo(() => new Set([...check, ...Object.keys(issues)]), [check, issues]);
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const first = groups.find((g) => !g.key && groupNamed(g, flaggedNames));
    return first ? { [first.id]: true } : {};
  });

  const ctx: RecordFormContext = {
    kind,
    data: value as AnyData,
    set: (path, next) => onChange(withDerived(kind, value, setPath(value, path, next))),
    check,
    issues,
    blocks,
    entriesById,
    builder,
    sourceId,
    bookRecords,
    parentClassId,
    setParentClassId: onParentClassChange,
    disabled,
    onFocusField,
  };

  useEffect(() => {
    if (!focusRequest) return;
    const group = groupOfPath(groups, focusRequest.path);
    if (group && !group.key) setOpen((o) => ({ ...o, [group.id]: true }));
    const frame = requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) return;
      const p = focusRequest.path;
      const target =
        root.querySelector<HTMLElement>(`[data-field-path="${CSS.escape(p)}"]:not(fieldset)`) ??
        root.querySelector<HTMLElement>(`[data-field-path^="${CSS.escape(`${p}.`)}"]:not(fieldset)`) ??
        root.querySelector<HTMLElement>(`#${CSS.escape(fieldId(p))}`);
      target?.focus();
      target?.scrollIntoView?.({ block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
    // Only for a new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.n]);

  const format = (value as { format: SourceFormat }).format;
  const editions = format === 'other' ? [...EDITIONS, { value: 'other' as const, label: 'Other' }] : EDITIONS;

  return (
    <FormContext.Provider value={ctx}>
      <div ref={rootRef}>
        <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-5">
          <legend className="sr-only">Fields of {name || 'this entry'}</legend>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor={fieldId('name')} className="text-sm font-medium">
                Name
                {isNamed(check, 'name') && <CheckTag />}
              </label>
              <Input id={fieldId('name')} data-field-path="name" value={name} maxLength={120} onChange={(e) => onNameChange(e.target.value)} />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor={fieldId('kind')} className="text-sm font-medium">
                What it is
                {isNamed(check, 'kind') && <CheckTag />}
              </label>
              <Select
                id={fieldId('kind')}
                data-field-path="kind"
                value={kind}
                disabled={!onKindChange}
                onChange={(e) => onKindChange?.(e.target.value as StructuredKind)}
              >
                {STRUCTURED_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k].title}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <fieldset className="min-w-0" data-field-path="format">
            <legend className="text-sm font-medium">
              Edition
              {isNamed(check, 'format') && <CheckTag />}
            </legend>
            <div className="mt-1.5 inline-flex rounded-xl border border-border bg-surface-2 p-0.5">
              {editions.map((e, i) => (
                <label
                  key={e.value}
                  className="flex min-h-9 cursor-pointer items-center rounded-[10px] px-3 text-sm font-medium text-muted transition-colors hover:text-text has-[:checked]:bg-surface has-[:checked]:text-text has-[:checked]:shadow-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring"
                >
                  <input
                    type="radio"
                    name={`${fieldId('format')}-radio`}
                    id={i === 0 ? fieldId('format') : undefined}
                    checked={format === e.value}
                    onChange={() => onChange({ ...value, format: e.value })}
                    className="sr-only"
                  />
                  {e.label}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted">Older-edition entries get the app's adaptation notes for the 2024 rules.</p>
          </fieldset>

          {groups.map((group) => (
            <Group
              key={group.id}
              group={group}
              open={open[group.id] ?? false}
              flagged={!group.key && groupNamed(group, flaggedNames)}
              onToggle={(isOpen) => setOpen((o) => (o[group.id] === isOpen ? o : { ...o, [group.id]: isOpen }))}
            >
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {group.fields.map((field, i) => (
                  <div key={`${field.path}-${i}`} className={cn(field.type === 'editor' || field.wide || field.type === 'tags' || field.type === 'chips' ? 'col-span-2 sm:col-span-4' : 'col-span-1 sm:col-span-2')}>
                    <FieldView field={field} ctx={ctx} />
                  </div>
                ))}
              </div>
            </Group>
          ))}
        </fieldset>
      </div>
    </FormContext.Provider>
  );
}
