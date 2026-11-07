import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { BookOpen, MessageCircle, Search } from 'lucide-react';
import { useRulesIndex } from '@/data';
import { useGame } from '@/state/gameStore';
import { CONTENT_KINDS, type CompendiumEntry, type ContentKind } from '@/types';
import { Markdown } from '@/ui/components/Markdown';
import { Badge, Button, Dialog, EmptyState, Input, Select, Spinner } from '@/ui/components/ui';
import { capitalize } from './format';
import { usePlayView } from './playView';

const SUGGESTIONS = ['Grappled', 'Opportunity Attacks', 'Concentration', 'Cover', 'Hide', 'Exhaustion', 'Short Rest'];
const MIN_QUERY = 2;

/** Search the SRD, the player's imports and this campaign's homebrew. */
export function RulesPanel({ autoFocus, onAskDm }: { autoFocus?: boolean; onAskDm?: () => void }) {
  const index = useRulesIndex();
  const campaignId = useGame((s) => s.campaignId);
  const prefillComposer = usePlayView((s) => s.prefillComposer);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<ContentKind | 'all'>('all');
  const [selected, setSelected] = useState<CompendiumEntry | null>(null);
  const deferredQuery = useDeferredValue(query.trim());
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const kindId = useId();

  useEffect(() => {
    if (!autoFocus) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [autoFocus]);

  const hits = useMemo(() => {
    if (!index || deferredQuery.length < MIN_QUERY) return [];
    return index.search(deferredQuery, { campaignId, limit: 30, kinds: kind === 'all' ? undefined : [kind] });
  }, [index, deferredQuery, kind, campaignId]);

  const askDm = (entry: CompendiumEntry) => {
    setSelected(null);
    prefillComposer(`OOC: About ${entry.name}: `);
    onAskDm?.();
  };

  return (
    <section aria-label="Rules lookup" className="flex flex-col gap-3">
      <form role="search" onSubmit={(e) => e.preventDefault()} className="flex gap-2">
        <div className="relative flex-1">
          <label htmlFor={inputId} className="sr-only">
            Search the rules
          </label>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input
            ref={inputRef}
            id={inputId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search spells, monsters, rules…"
            autoComplete="off"
            className="pl-9"
          />
        </div>
        <label htmlFor={kindId} className="sr-only">
          Kind
        </label>
        <Select
          id={kindId}
          value={kind}
          onChange={(e) => setKind(e.target.value as ContentKind | 'all')}
          className="w-32 shrink-0"
        >
          <option value="all">All kinds</option>
          {CONTENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {capitalize(k)}
            </option>
          ))}
        </Select>
      </form>

      {!index ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted" role="status">
          <Spinner label="Loading the rules" className="size-4" />
          Loading the rules…
        </div>
      ) : deferredQuery.length < MIN_QUERY ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-faint">Try:</p>
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setQuery(s)}
                className="rounded-full border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : hits.length === 0 ? (
        <EmptyState icon={<BookOpen className="size-7" aria-hidden />} title="No matches" className="py-6">
          Nothing in your rules library matches “{deferredQuery}”.
        </EmptyState>
      ) : (
        <ul aria-label="Search results" className="flex flex-col gap-1.5">
          {hits.map(({ entry, snippet }) => (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => setSelected(entry)}
                className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-left transition-colors hover:border-accent/50 hover:bg-surface-2"
              >
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-semibold">{entry.name}</span>
                  <Badge tone={entry.sourceId === 'homebrew' ? 'arcane' : 'neutral'}>{capitalize(entry.kind)}</Badge>
                  <span className="text-xs text-faint">{entry.sourceName}</span>
                </span>
                {(entry.summary || snippet) && (
                  <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{entry.summary || snippet}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={selected !== null}
        onClose={() => setSelected(null)}
        size="lg"
        title={selected?.name ?? ''}
        description={selected ? [selected.summary, selected.sourceName].filter(Boolean).join(' · ') : undefined}
        footer={
          selected && (
            <>
              <Button variant="ghost" icon={<MessageCircle className="size-4" aria-hidden />} onClick={() => askDm(selected)}>
                Ask the DM about this
              </Button>
              <Button variant="primary" onClick={() => setSelected(null)}>
                Close
              </Button>
            </>
          )
        }
      >
        {selected && (
          <div className="flex flex-col gap-3">
            {selected.path && selected.path.length > 0 && <p className="text-xs text-faint">{selected.path.join(' › ')}</p>}
            <Markdown>{selected.text}</Markdown>
          </div>
        )}
      </Dialog>
    </section>
  );
}
