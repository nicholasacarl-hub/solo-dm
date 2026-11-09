/**
 * Where builder options come from (structured imports, spec §5.3): the book badge on imported options,
 * an "SRD" badge only when an import shares the name, the "Older edition" badge and notes, the source
 * filter, and the pending-review hint that links to the book page.
 */
import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { BookMarked, History } from 'lucide-react';
import { countUnreviewedOptions } from '@/data';
import { nameKey } from '@/lib/id';
import { SRD_SOURCE_ID, type OptionSource, type StructuredKind } from '@/types';
import { BOOK_BADGE, OLDER_EDITION, reviewHint } from '@/ui/library/structure/labels';
import { Badge, Select } from '@/ui/components/ui';
import { RadioCards, useSmallScreen } from './BuilderParts';
import { shortTitle, type OptionBook } from './sources';

/** The book an imported option comes from (the full title is the accessible name). */
export function BookBadge({ title }: { title: string }) {
  return (
    <Badge tone={BOOK_BADGE.tone}>
      <BookMarked className="size-3" aria-hidden />
      <span aria-hidden>{shortTitle(title, BOOK_BADGE.maxChars)}</span>
      <span className="sr-only">From {title}</span>
    </Badge>
  );
}

/** "Older edition": the option was adapted to the 2024 rules; the notes say how. */
export function OlderEditionBadge({ notes }: { notes: readonly string[] }) {
  if (!notes.length) return null;
  return (
    <Badge tone={OLDER_EDITION.tone}>
      <History className="size-3" aria-hidden />
      <span title={notes.join('\n')}>{OLDER_EDITION.label}</span>
      <span className="sr-only">: {notes.join(' ')}</span>
    </Badge>
  );
}

/** Badges for an option card: its book (or "SRD" when an import shares its name) and "Older edition". */
export function OptionSourceBadges({ option, clashes }: { option: { name: string; source?: OptionSource }; clashes: ReadonlySet<string> }) {
  if (option.source) {
    return (
      <>
        <BookBadge title={option.source.title} />
        <OlderEditionBadge notes={option.source.adaptations.map((a) => a.note)} />
      </>
    );
  }
  return clashes.has(nameKey(option.name)) ? <Badge>SRD</Badge> : null;
}

/** The older-edition notes of an option, in full (details panels and the Review step). */
export function OlderEditionNotes({ notes, title = 'Older edition' }: { notes: readonly string[]; title?: string }) {
  if (!notes.length) return null;
  return (
    <div className="rounded-xl border border-gold/40 bg-gold-soft/60 px-3.5 py-2.5 text-sm">
      <p className="flex items-center gap-1.5 font-medium text-gold">
        <History className="size-4" aria-hidden /> {title}
      </p>
      <ul className="mt-1 list-disc pl-5 text-text">
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  );
}

const ALL = '__all__';

/** "All · SRD · <book>…" above the option lists when the player has imported books (a select beyond three or on phones). */
export function SourceFilter({ books, value, onChange, label = 'Show options from' }: { books: readonly OptionBook[]; value: string | null; onChange: (value: string | null) => void; label?: string }) {
  const small = useSmallScreen();
  const id = useId();
  if (!books.length) return null;
  const options = [{ value: ALL, title: 'All' }, { value: SRD_SOURCE_ID, title: 'SRD' }, ...books.map((b) => ({ value: b.id, title: shortTitle(b.title) }))];
  const current = value ?? ALL;
  const pick = (next: string) => onChange(next === ALL ? null : next);
  if (small || books.length > 3) {
    return (
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="text-xs font-medium text-muted">
          {label}
        </label>
        <Select id={id} value={current} onChange={(e) => pick(e.target.value)} className="h-9 w-auto max-w-[16rem]">
          <option value={ALL}>All books</option>
          <option value={SRD_SOURCE_ID}>SRD 5.2.1</option>
          {books.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
            </option>
          ))}
        </Select>
      </div>
    );
  }
  return <RadioCards variant="pills" label={label} value={current} onChange={pick} options={options} />;
}

/** "3 more classes from “The Gloamwood Almanac” are waiting for your review in the Library." (links to the book page). */
export function PendingReviewHint({ kinds }: { kinds: readonly StructuredKind[] }) {
  const [counts, setCounts] = useState<{ sourceId: string; title: string; kind: StructuredKind; count: number }[]>([]);
  const key = kinds.join(',');
  useEffect(() => {
    let alive = true;
    countUnreviewedOptions().then(
      (all) => alive && setCounts(all.filter((c) => key.split(',').includes(c.kind))),
      () => undefined, // the hint is a convenience: no library, no hint
    );
    return () => {
      alive = false;
    };
  }, [key]);
  if (!counts.length) return null;
  return (
    <ul className="flex flex-col gap-1 text-sm text-muted">
      {counts.map((c) => (
        <li key={`${c.sourceId}:${c.kind}`}>
          <Link to={`/library/source/${encodeURIComponent(c.sourceId)}?k=${c.kind}`} className="underline-offset-2 hover:text-text hover:underline">
            {reviewHint(c.count, c.kind, c.title)}
          </Link>
        </li>
      ))}
    </ul>
  );
}
