/**
 * Rows of named text spans: class and subclass features (level, name, text), species traits and
 * lineages (name, text), and a background's older-edition feature. New rows start at the first
 * paragraph of the record's first block; features are kept in level order when a row is added.
 */
import { Plus, Trash2 } from 'lucide-react';
import type { FeatureData, LineageData, TextSpan, TraitData } from '@/types';
import { Button, IconButton, Input } from '@/ui/components/ui';
import { fieldId, issueId, useRecordForm } from './context';
import { CheckTag, FieldShell, issueAt } from './controls';
import { getPath, isNamed } from './paths';
import { TextSpanChip } from './TextSpanChip';

type Row = { name: string; text: TextSpan; level?: number; form?: LineageData['form'] };

function useFirstSpan(): TextSpan {
  const { blocks, entriesById } = useRecordForm();
  const first = blocks[0]?.entryIds ?? [...entriesById.keys()].slice(0, 1);
  return { entryIds: first.length ? [...first] : ['?'], from: 1, to: 1 };
}

function RowFields({
  path,
  row,
  onChange,
  withLevel,
  nameLabel,
  noun,
}: {
  path: string;
  row: Row;
  onChange(next: Row): void;
  withLevel: boolean;
  /** The name input's accessible name ("Name of feature 3"): each row's own, not just "Name". */
  nameLabel: string;
  /** "feature", "trait"…: names the row in "Change the text of …" until it has a name. */
  noun: string;
}) {
  const form = useRecordForm();
  const nameIssue = issueAt(form.issues, `${path}.name`);
  const textIssue = issueAt(form.issues, `${path}.text`);
  const levelIssue = issueAt(form.issues, `${path}.level`);
  const checked = isNamed(form.check, path);
  return (
    // Level and name on one line, the text chip under them: the form's pane can be narrow.
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex gap-2">
        {withLevel && (
          <div className="w-20 shrink-0">
            <label htmlFor={fieldId(`${path}.level`)} className="sr-only">
              Level of {row.name || 'this feature'}
            </label>
            <Input
              id={fieldId(`${path}.level`)}
              data-field-path={`${path}.level`}
              inputMode="numeric"
              aria-describedby={levelIssue ? issueId(`${path}.level`) : undefined}
              aria-invalid={levelIssue ? true : undefined}
              value={row.level === undefined || Number.isNaN(row.level) ? '' : String(row.level)}
              onFocus={() => form.onFocusField(path)}
              onChange={(e) => {
                const n = e.target.value.trim() === '' ? Number.NaN : Number(e.target.value);
                onChange({ ...row, level: n });
              }}
              placeholder="Lvl"
            />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <label htmlFor={fieldId(`${path}.name`)} className="sr-only">
            {nameLabel}
            {checked ? ' (check)' : ''}
          </label>
          <Input
            id={fieldId(`${path}.name`)}
            data-field-path={`${path}.name`}
            aria-describedby={nameIssue ? issueId(`${path}.name`) : undefined}
            aria-invalid={nameIssue ? true : undefined}
            value={row.name}
            maxLength={120}
            placeholder="Name"
            onFocus={() => form.onFocusField(path)}
            onChange={(e) => onChange({ ...row, name: e.target.value })}
          />
        </div>
      </div>
      <TextSpanChip
        span={row.text}
        blocks={form.blocks}
        entriesById={form.entriesById}
        disabled={form.disabled}
        id={fieldId(`${path}.text`)}
        fieldPath={`${path}.text`}
        describedBy={textIssue ? issueId(`${path}.text`) : undefined}
        onFocus={() => form.onFocusField(`${path}.text`)}
        onChange={(text) => onChange({ ...row, text })}
        owner={row.name.trim() || `this ${noun}`}
      />
      {(levelIssue || nameIssue || textIssue) && (
        <div>
          {levelIssue && <p id={issueId(`${path}.level`)} className="text-xs text-danger">Level: {levelIssue}</p>}
          {nameIssue && <p id={issueId(`${path}.name`)} className="text-xs text-danger">Name: {nameIssue}</p>}
          {textIssue && <p id={issueId(`${path}.text`)} className="text-xs text-danger">Text: {textIssue}</p>}
        </div>
      )}
    </div>
  );
}

export function RowsEditor({
  path,
  label,
  noun,
  withLevel = false,
  optional = false,
}: {
  path: string;
  label: string;
  /** "feature", "trait", "lineage". */
  noun: string;
  withLevel?: boolean;
  /** An optional list is removed (not left empty) when its last row goes. */
  optional?: boolean;
}) {
  const form = useRecordForm();
  const firstSpan = useFirstSpan();
  const raw = getPath(form.data, path);
  const rows = (Array.isArray(raw) ? raw : []) as Row[];
  const setRows = (next: Row[]) => form.set(path, optional && next.length === 0 ? undefined : next);
  const add = () => {
    const level = withLevel ? Math.max(1, ...rows.map((r) => (Number.isFinite(r.level) ? (r.level as number) : 1))) : undefined;
    const row: Row = withLevel ? { level, name: '', text: firstSpan } : { name: '', text: firstSpan };
    if (path === 'lineages') row.form = 'paragraphs';
    setRows([...rows, row]);
  };
  return (
    <FieldShell path={path} label={label} as="legend">
      {rows.length === 0 ? (
        <p className="text-sm text-muted">No {noun}s.</p>
      ) : (
        <ol className="flex flex-col gap-2.5">
          {rows.map((row, i) => (
            <li key={i} className="flex items-start gap-2 rounded-xl border border-border bg-surface p-2.5">
              <RowFields
                path={`${path}.${i}`}
                row={row}
                withLevel={withLevel}
                nameLabel={`Name of ${noun} ${i + 1}${withLevel && Number.isFinite(row.level) ? ` (level ${row.level})` : ''}`}
                noun={noun}
                onChange={(next) => setRows(rows.map((r, j) => (j === i ? next : r)))}
              />
              <IconButton label={`Remove ${row.name || `this ${noun}`}`} size="sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                <Trash2 className="size-4" aria-hidden />
              </IconButton>
            </li>
          ))}
        </ol>
      )}
      <div>
        <Button size="sm" icon={<Plus className="size-4" aria-hidden />} onClick={add}>
          Add a {noun}
        </Button>
      </div>
    </FieldShell>
  );
}

/** A background's older-edition feature: one optional named span. */
export function LegacyFeatureEditor({ path, label }: { path: string; label: string }) {
  const form = useRecordForm();
  const firstSpan = useFirstSpan();
  const value = getPath(form.data, path) as TraitData | undefined;
  const checked = isNamed(form.check, path);
  if (!value) {
    return (
      <div className="flex flex-col gap-1.5" data-field-path={path}>
        <p className="text-sm font-medium">
          {label}
          {checked && <CheckTag />}
        </p>
        <p className="text-sm text-muted">None. Older books print one (“Feature: …”); it goes on the sheet as a background feature.</p>
        <div>
          <Button size="sm" icon={<Plus className="size-4" aria-hidden />} onClick={() => form.set(path, { name: '', text: firstSpan })}>
            Add the feature
          </Button>
        </div>
      </div>
    );
  }
  return (
    <FieldShell path={path} label={label} as="legend">
      <div className="flex items-start gap-2 rounded-xl border border-border bg-surface p-2.5">
        <RowFields
          path={path}
          row={value}
          withLevel={false}
          nameLabel="Name of the background feature"
          noun="background feature"
          onChange={(next) => form.set(path, { name: next.name, text: next.text })}
        />
        <IconButton label="Remove the background feature" size="sm" onClick={() => form.set(path, undefined)}>
          <Trash2 className="size-4" aria-hidden />
        </IconButton>
      </div>
    </FieldShell>
  );
}

export type { FeatureData, LineageData, TraitData };
