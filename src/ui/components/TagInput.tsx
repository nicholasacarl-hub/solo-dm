/**
 * A list of short text tags with an input (Enter or comma adds, Backspace on an empty input
 * removes the last tag) and optional quick-add suggestions.
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface TagInputProps {
  /** Accessible name of the text box and the tag list, e.g. "Lines". */
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  id?: string;
  placeholder?: string;
  /** Quick-add options; ones already present are hidden. */
  suggestions?: readonly string[];
  suggestionsLabel?: string;
  /** How many suggestions to show before a "More" toggle (default 8). */
  suggestionsLimit?: number;
  /** Max characters per tag. */
  maxLength?: number;
  describedBy?: string;
  className?: string;
}

const sameTag = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

/** Split raw input on commas / new lines and drop blanks and duplicates (case-insensitive). */
export function mergeTags(existing: readonly string[], raw: string, maxLength = 80): string[] {
  const next = [...existing];
  for (const part of raw.split(/[,\n]/)) {
    const tag = part.trim().replace(/\s+/g, ' ').slice(0, maxLength);
    if (tag && !next.some((t) => sameTag(t, tag))) next.push(tag);
  }
  return next;
}

export function TagInput({
  label,
  value,
  onChange,
  id,
  placeholder = 'Type and press Enter',
  suggestions = [],
  suggestionsLabel = 'Suggestions',
  suggestionsLimit = 8,
  maxLength = 80,
  describedBy,
  className,
}: TagInputProps) {
  const [draft, setDraft] = useState('');
  const [showAll, setShowAll] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (raw: string) => {
    const next = mergeTags(value, raw, maxLength);
    if (next.length !== value.length) onChange(next);
    setDraft('');
  };

  const remove = (tag: string) => {
    onChange(value.filter((t) => t !== tag));
    inputRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      if (draft.trim()) commit(draft);
    } else if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      event.preventDefault();
      onChange(value.slice(0, -1));
    }
  };

  const remaining = suggestions.filter((s) => !value.some((t) => sameTag(t, s)));
  const hidden = showAll ? 0 : Math.max(0, remaining.length - suggestionsLimit);
  const shown = hidden > 0 ? remaining.slice(0, suggestionsLimit) : remaining;

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div
        className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-xl border border-border bg-surface px-2 py-1.5 transition-colors focus-within:border-accent"
        onClick={(e) => {
          if (e.target === e.currentTarget) inputRef.current?.focus();
        }}
      >
        {value.length > 0 && (
          <ul aria-label={label} className="flex flex-wrap gap-1.5">
            {value.map((tag) => (
              <li
                key={tag}
                className="inline-flex max-w-full items-center gap-1 rounded-lg border border-border bg-surface-2 py-0.5 pr-0.5 pl-2 text-sm"
              >
                <span className="min-w-0 break-words">{tag}</span>
                <button
                  type="button"
                  aria-label={`Remove ${tag}`}
                  onClick={() => remove(tag)}
                  className="grid size-6 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-surface-3 hover:text-text"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          ref={inputRef}
          id={id}
          value={draft}
          aria-label={id ? undefined : label}
          aria-describedby={describedBy}
          maxLength={maxLength + 20}
          placeholder={value.length === 0 ? placeholder : 'Add another…'}
          onChange={(e) => {
            const text = e.target.value;
            if (text.includes(',')) commit(text);
            else setDraft(text);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (draft.trim()) commit(draft);
          }}
          enterKeyHint="done"
          className="h-7 min-w-[8rem] flex-1 bg-transparent px-1 text-sm text-text placeholder:text-faint focus:outline-none"
        />
      </div>
      {remaining.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs text-muted">{suggestionsLabel}</p>
          <div className="flex flex-wrap gap-1.5">
            {shown.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                aria-label={`Add ${suggestion} to ${label}`}
                onClick={() => commit(suggestion)}
                className="inline-flex items-center gap-1 rounded-lg border border-dashed border-border px-2 py-1 text-xs text-muted transition-colors hover:border-accent hover:text-text"
              >
                <Plus className="size-3" aria-hidden />
                {suggestion}
              </button>
            ))}
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="rounded-lg px-2 py-1 text-xs font-medium text-accent underline-offset-2 hover:underline"
              >
                {hidden} more…
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
