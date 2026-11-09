/**
 * "Attaches to" for a subclass (spec §4.5, D26): SRD classes, this book's classes (accepted or not:
 * "waiting for review" noted) and other books' accepted classes, pre-selected by suggestParentClass.
 * Required to accept; a missing or ambiguous match says why.
 */
import { useId } from 'react';
import { suggestParentClass } from '@/data';
import type { BuilderData, StructuredRecord } from '@/types';
import { Select } from '@/ui/components/ui';
import { fieldId, issueId } from './context';
import { CheckTag } from './controls';

export interface ParentChoice {
  id: string;
  name: string;
  sourceId?: string;
  group: 'srd' | 'book' | 'other';
  waiting?: boolean;
  sourceTitle?: string;
}

/** Every class a subclass of this book could attach to. */
export function parentChoices(builder: BuilderData | null, sourceId: string, bookRecords: readonly StructuredRecord[]): ParentChoice[] {
  const out = new Map<string, ParentChoice>();
  for (const c of builder?.classes ?? []) {
    if (!c.source) out.set(c.id, { id: c.id, name: c.name, group: 'srd' });
    else if (c.source.sourceId === sourceId) out.set(c.id, { id: c.id, name: c.name, sourceId, group: 'book' });
    else out.set(c.id, { id: c.id, name: c.name, sourceId: c.source.sourceId, sourceTitle: c.source.title, group: 'other' });
  }
  for (const r of bookRecords) {
    if (r.kind !== 'class' || r.status === 'rejected') continue;
    if (!out.has(r.publicId)) out.set(r.publicId, { id: r.publicId, name: r.name, sourceId, group: 'book', waiting: r.status !== 'accepted' });
  }
  return [...out.values()];
}

/** The choice to show selected: the stored one, else the suggestion. */
export function suggestedParent(parentClass: string, sourceId: string, choices: readonly ParentChoice[]) {
  return suggestParentClass(parentClass, sourceId, choices);
}

const REASONS = {
  'same-book': (name: string) => `Matched this book's ${name}.`,
  srd: (name: string) => `Matched the SRD ${name}.`,
  'other-book': (name: string) => `Matched ${name} from another of your books.`,
  ambiguous: (name: string) => `Several classes are called “${name}”: pick the right one.`,
  missing: (name: string) => (name ? `No class called “${name}” is available: accept that class first, or pick another.` : 'Pick the class this subclass belongs to.'),
} as const;

export function ParentClassSelect({
  value,
  onChange,
  parentClass,
  sourceId,
  choices,
  checked,
  issue,
  disabled,
  onFocus,
}: {
  value: string | undefined;
  onChange(id: string | undefined): void;
  /** As printed ("Fighter"). */
  parentClass: string;
  /** The subclass's book (its own classes come first). */
  sourceId: string;
  choices: readonly ParentChoice[];
  checked?: boolean;
  issue?: string;
  disabled?: boolean;
  onFocus?(): void;
}) {
  const hintId = useId();
  const suggestion = suggestedParent(parentClass, sourceId, choices);
  const chosen = choices.find((c) => c.id === value);
  const groups: { id: ParentChoice['group']; label: string }[] = [
    { id: 'srd', label: 'SRD' },
    { id: 'book', label: 'This book' },
    { id: 'other', label: 'Other books' },
  ];
  const hint = chosen
    ? chosen.waiting
      ? `${chosen.name} is waiting for review: accept it too, or this subclass won't appear in the builder.`
      : value === suggestion.id
        ? REASONS[suggestion.reason](chosen.name)
        : `Attaches to ${chosen.name}.`
    : REASONS[suggestion.reason](parentClass);
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-field-path="parentClassId">
      <label htmlFor={fieldId('parentClassId')} className="text-sm font-medium">
        Attaches to
        {checked && <CheckTag />}
      </label>
      <Select
        id={fieldId('parentClassId')}
        value={value ?? ''}
        disabled={disabled}
        aria-describedby={issue ? `${issueId('parentClassId')} ${hintId}` : hintId}
        aria-invalid={issue ? true : undefined}
        onFocus={onFocus}
        onChange={(e) => onChange(e.target.value || undefined)}
      >
        <option value="">Choose a class…</option>
        {groups.map((g) => {
          const members = choices.filter((c) => c.group === g.id).sort((a, b) => a.name.localeCompare(b.name));
          if (members.length === 0) return null;
          return (
            <optgroup key={g.id} label={g.label}>
              {members.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.waiting ? ' (waiting for review)' : ''}
                  {c.sourceTitle ? ` · ${c.sourceTitle}` : ''}
                </option>
              ))}
            </optgroup>
          );
        })}
      </Select>
      {issue && (
        <p id={issueId('parentClassId')} className="text-xs text-danger">
          {issue}
        </p>
      )}
      <p id={hintId} className="text-xs text-muted">
        {parentClass ? `The book says “${parentClass}”. ` : ''}
        {hint}
      </p>
    </div>
  );
}
