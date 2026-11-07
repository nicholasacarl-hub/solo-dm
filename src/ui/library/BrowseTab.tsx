/**
 * Library › Browse: search and read the rules (SRD 5.2.1, enabled imports, shared homebrew).
 * Deep link to an entry with ?entry=<id>.
 */
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { BookOpen, RotateCcw, Search, TriangleAlert } from 'lucide-react';
import { invalidateRulesIndex, useRulesIndexState, type RulesIndex } from '@/data';
import { CONTENT_KINDS, type CompendiumEntry, type ContentKind } from '@/types';
import { cn } from '@/lib/cn';
import { Button, EmptyState, Input, Select, Spinner } from '@/ui/components/ui';
import { plural } from '@/ui/shell/format';
import { EntryDetail } from './EntryDetail';
import { kindInfo } from './kinds';

const PAGE_SIZE = 60;
const SEARCH_LIMIT = 200;

interface BrowseResult {
  entry: CompendiumEntry;
  snippet?: string;
}

type KindFilter = ContentKind | 'all';

const byName = (a: CompendiumEntry, b: CompendiumEntry) => a.name.localeCompare(b.name);

/** Search results, a filtered list, or null for the "browse by kind" overview. */
export function findEntries(index: RulesIndex, query: string, kind: KindFilter, sourceId: string): BrowseResult[] | null {
  const q = query.trim();
  const kindFilter = kind === 'all' ? undefined : kind;
  const sourceFilter = sourceId === 'all' ? undefined : sourceId;
  if (q) {
    return index
      .search(q, { kinds: kindFilter ? [kindFilter] : undefined, sourceIds: sourceFilter ? [sourceFilter] : undefined, limit: SEARCH_LIMIT })
      .map((hit) => ({ entry: hit.entry, snippet: hit.snippet }));
  }
  if (!kindFilter && !sourceFilter) return null;
  return index
    .list({ kind: kindFilter, sourceId: sourceFilter })
    .slice()
    .sort(byName)
    .map((entry) => ({ entry }));
}

export function BrowseTab() {
  const { index, error } = useRulesIndexState();
  if (index) return <BrowseView index={index} />;
  if (error) {
    return (
      <EmptyState
        icon={<TriangleAlert className="size-8 text-danger" aria-hidden />}
        title="The rules didn’t load"
        action={
          <Button icon={<RotateCcw className="size-4" aria-hidden />} onClick={() => invalidateRulesIndex()}>
            Try again
          </Button>
        }
      >
        {error}
      </EmptyState>
    );
  }
  return (
    <div className="flex items-center gap-3 py-16 text-sm text-muted">
      <Spinner label="Loading the rules" />
      <span aria-hidden>Opening the rulebook…</span>
    </div>
  );
}

function BrowseView({ index }: { index: RulesIndex }) {
  const [params, setParams] = useSearchParams();
  const entryId = params.get('entry');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [sourceId, setSourceId] = useState('all');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const deferredQuery = useDeferredValue(query);

  // Start from the first page whenever the filters change.
  const filterKey = `${deferredQuery}\u0000${kind}\u0000${sourceId}`;
  const [pagedFor, setPagedFor] = useState(filterKey);
  if (pagedFor !== filterKey) {
    setPagedFor(filterKey);
    setLimit(PAGE_SIZE);
  }

  const sources = useMemo(() => index.sources(), [index]);
  const kindCounts = useMemo(
    () =>
      CONTENT_KINDS.map((k) => ({
        kind: k,
        count: index.list({ kind: k, sourceId: sourceId === 'all' ? undefined : sourceId }).length,
      })).filter((k) => k.count > 0 || k.kind === kind),
    [index, sourceId, kind],
  );
  const results = useMemo(() => findEntries(index, deferredQuery, kind, sourceId), [index, deferredQuery, kind, sourceId]);
  const selected = entryId ? index.get(entryId) : undefined;

  // On phones the detail replaces the list, so start it at the top.
  useEffect(() => {
    if (entryId && !window.matchMedia?.('(min-width: 1024px)').matches) window.scrollTo({ top: 0 });
  }, [entryId]);

  const clearSelection = () =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('entry');
        return next;
      },
      { replace: true },
    );

  return (
    <div className="lg:grid lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start lg:gap-8">
      <div className={cn('flex min-w-0 flex-col gap-4', entryId && 'hidden lg:flex')}>
        <div className="flex flex-col gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" aria-hidden />
            <Input
              type="search"
              aria-label="Search the rules"
              placeholder="Search spells, monsters, rules…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="flex gap-2">
            <Select
              aria-label="Kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as KindFilter)}
              className="min-w-0 flex-1"
            >
              <option value="all">All kinds</option>
              {kindCounts.map(({ kind: k, count }) => (
                <option key={k} value={k}>
                  {kindInfo(k).plural} ({count})
                </option>
              ))}
            </Select>
            {sources.length > 1 && (
              <Select
                aria-label="Source"
                value={sourceId}
                onChange={(e) => setSourceId(e.target.value)}
                className="min-w-0 flex-1"
              >
                <option value="all">All sources</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </div>

        {results === null ? (
          <KindOverview counts={kindCounts} onPick={setKind} />
        ) : (
          <ResultList
            results={results.slice(0, limit)}
            total={results.length}
            selectedId={entryId}
            query={deferredQuery}
            showKind={kind === 'all'}
            onMore={() => setLimit((l) => l + PAGE_SIZE)}
          />
        )}
      </div>

      <div
        className={cn(
          'min-w-0 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6.5rem)] lg:overflow-y-auto lg:rounded-2xl lg:border lg:border-border lg:bg-surface lg:p-6 lg:shadow-card lg:scroll-thin',
          !entryId && 'hidden lg:block',
        )}
      >
        {selected ? (
          <EntryDetail entry={selected} onBack={clearSelection} />
        ) : entryId ? (
          <EmptyState title="Entry not found" action={<Button onClick={clearSelection}>Back to results</Button>}>
            It may have been renamed, or it came from an import that’s switched off or deleted.
          </EmptyState>
        ) : (
          <EmptyState icon={<BookOpen className="size-8" aria-hidden />} title="Pick an entry to read it here">
            Search for a spell, a monster or a rule, or browse by kind.
          </EmptyState>
        )}
      </div>
    </div>
  );
}

function KindOverview({ counts, onPick }: { counts: { kind: ContentKind; count: number }[]; onPick: (kind: ContentKind) => void }) {
  if (counts.length === 0) {
    return <EmptyState title="The rulebook is empty">The rules data hasn’t loaded. Try reloading the page.</EmptyState>;
  }
  return (
    <div>
      <p className="mb-2 text-xs text-muted">Browse by kind, or search above.</p>
      <ul className="grid grid-cols-2 gap-2">
        {counts.map(({ kind, count }) => {
          const info = kindInfo(kind);
          const Icon = info.icon;
          return (
            <li key={kind}>
              <button
                type="button"
                onClick={() => onPick(kind)}
                className="flex w-full items-center gap-2.5 rounded-xl border border-border bg-surface px-3 py-2.5 text-left transition-colors hover:border-faint"
              >
                <Icon className="size-4 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{info.plural}</span>
                <span className="text-xs text-muted tabular-nums">{count}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function entrySearch(id: string): string {
  return `?tab=browse&entry=${encodeURIComponent(id)}`;
}

function ResultList({
  results,
  total,
  selectedId,
  query,
  showKind,
  onMore,
}: {
  results: BrowseResult[];
  total: number;
  selectedId: string | null;
  query: string;
  showKind: boolean;
  onMore: () => void;
}) {
  if (total === 0) {
    return (
      <EmptyState title={query.trim() ? `Nothing matches “${query.trim()}”` : 'Nothing here yet'}>
        Try a different word, or widen the filters.
      </EmptyState>
    );
  }
  return (
    <div>
      <p className="mb-2 text-xs text-muted" aria-live="polite">
        {total >= SEARCH_LIMIT && query.trim() ? `Top ${SEARCH_LIMIT} results` : plural(total, 'result')}
      </p>
      <ul className="flex flex-col gap-0.5">
        {results.map(({ entry, snippet }) => {
          const selected = entry.id === selectedId;
          return (
            <li key={entry.id}>
              <Link
                to={{ search: entrySearch(entry.id) }}
                aria-current={selected ? 'true' : undefined}
                className={cn(
                  'block rounded-xl px-3 py-2.5 transition-colors',
                  selected ? 'bg-accent-soft/60' : 'hover:bg-surface-2',
                )}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium">{entry.name}</span>
                  {showKind && <span className="shrink-0 text-[11px] text-muted">{kindInfo(entry.kind).label}</span>}
                </span>
                {entry.summary && <span className="mt-0.5 block truncate text-xs text-muted">{entry.summary}</span>}
                {snippet && <span className="mt-0.5 line-clamp-2 text-xs text-muted">{snippet}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
      {total > results.length && (
        <Button className="mt-3 w-full" onClick={onMore}>
          Show more ({total - results.length} left)
        </Button>
      )}
    </div>
  );
}
