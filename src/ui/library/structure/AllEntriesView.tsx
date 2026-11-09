/**
 * The book page's "All entries" view (spec §4.6, D14): every entry of the book in reading order, what
 * it was structured as (a link to the record), and "Structure as… ▾" for anything detection missed.
 * A section kind (class, subclass, species, background) takes the entry's heading subtree.
 */
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ChevronDown, Search } from 'lucide-react';
import { STRUCTURED_KINDS, type CompendiumEntry, type StructuredKind, type StructuredRecord } from '@/types';
import { toast } from '@/ui/components/toast';
import { Button, EmptyState, Input } from '@/ui/components/ui';
import { Menu } from '@/ui/play/components/Menu';
import { errorMessage } from '@/ui/shell/format';
import { kindInfo } from '../kinds';
import { KIND_LABELS } from './labels';
import { structureAs } from './reviewActions';
import { TOUCH } from './touch';
import { bookPageSearch } from './useBookPageState';

const PAGE = 100;
const SECTION_KINDS = new Set<StructuredKind>(['class', 'subclass', 'species', 'background']);

/** The entry and everything under its heading (entries after it whose path starts with its path + name). */
export function subtreeOf(entry: CompendiumEntry, entries: readonly CompendiumEntry[]): string[] {
  const at = entries.findIndex((e) => e.id === entry.id);
  if (at < 0) return [entry.id];
  const prefix = [...(entry.path ?? []), entry.name];
  const ownPath = (entry.path ?? []).join('\u0000');
  const isPart = (e: CompendiumEntry) => e.name.startsWith(`${entry.name} (part `) && (e.path ?? []).join('\u0000') === ownPath;
  const out = [entry.id];
  for (const e of entries.slice(at + 1)) {
    const path = e.path ?? [];
    const under = path.length >= prefix.length && prefix.every((p, i) => path[i] === p);
    if (!under && !isPart(e)) break;
    out.push(e.id);
  }
  return out;
}

export function AllEntriesView({
  sourceId,
  entries,
  records,
  onOpenRecord,
}: {
  sourceId: string;
  entries: readonly CompendiumEntry[];
  records: readonly StructuredRecord[];
  onOpenRecord(id: string): void;
}) {
  const [params] = useSearchParams();
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [busy, setBusy] = useState<string | null>(null);
  const byEntry = useMemo(() => {
    const map = new Map<string, StructuredRecord[]>();
    for (const r of records) for (const id of r.entryIds) map.set(id, [...(map.get(id) ?? []), r]);
    return map;
  }, [records]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? entries.filter((e) => e.name.toLowerCase().includes(needle)) : entries;
  }, [entries, q]);

  const structure = async (entry: CompendiumEntry, kind: StructuredKind) => {
    setBusy(entry.id);
    try {
      const ids = SECTION_KINDS.has(kind) ? subtreeOf(entry, entries) : [entry.id];
      const record = await structureAs(sourceId, ids, kind);
      toast.success(`${entry.name}: marked as ${KIND_LABELS[kind].one}. Review it below.`);
      onOpenRecord(record.id);
    } catch (error) {
      toast.error(errorMessage(error, 'Could not structure that entry.'));
    } finally {
      setBusy(null);
    }
  };

  if (entries.length === 0) return <EmptyState title="No entries">This book has no entries on this device.</EmptyState>;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        Everything in the book, in reading order. Detection missed something? Use <span className="font-medium text-text">Structure as…</span> on
        it. A class, subclass, species or background takes the entries under its heading too.
      </p>
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" aria-hidden />
        <Input type="search" aria-label="Search entries" placeholder="Search entries" value={q} className={`pl-9 ${TOUCH}`} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ul aria-label="All entries" className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-surface">
        {shown.slice(0, limit).map((entry) => {
          const recs = byEntry.get(entry.id) ?? [];
          const depth = entry.path?.length ?? 0;
          return (
            <li key={entry.id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1" style={{ paddingLeft: `${Math.min(depth, 4) * 0.75}rem` }}>
                <p className="truncate text-sm font-medium">{entry.name}</p>
                <p className="truncate text-xs text-muted">
                  {recs.length > 0 ? (
                    recs.map((r, i) => (
                      <span key={r.id}>
                        {i > 0 && ', '}
                        <Link to={{ search: bookPageSearch(params, { view: 'review', recordId: r.id, filter: 'all' }) }} className="text-accent underline-offset-2 hover:underline">
                          {KIND_LABELS[r.kind].title}: {r.name}
                        </Link>
                      </span>
                    ))
                  ) : (
                    <>Text only · {kindInfo(entry.kind).label}</>
                  )}
                </p>
              </div>
              <Menu
                label={`Structure ${entry.name} as`}
                placement="bottom-end"
                items={STRUCTURED_KINDS.map((k) => ({ id: k, label: KIND_LABELS[k].title, onSelect: () => void structure(entry, k) }))}
                trigger={(t) => (
                  <Button {...t} size="sm" variant="ghost" className={TOUCH} loading={busy === entry.id} disabled={busy !== null}>
                    Structure as…
                    <ChevronDown className="size-3.5" aria-hidden />
                    <span className="sr-only"> ({entry.name})</span>
                  </Button>
                )}
              />
            </li>
          );
        })}
      </ul>
      {shown.length > limit && (
        <Button className={TOUCH} onClick={() => setLimit((l) => l + PAGE)}>
          Show more ({shown.length - limit} left)
        </Button>
      )}
    </div>
  );
}
