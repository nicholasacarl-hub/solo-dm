import { useId, useMemo, useState } from 'react';
import { NotebookPen, Search } from 'lucide-react';
import { useGame } from '@/state/gameStore';
import type { JournalEntry, JournalKind } from '@/types';
import { Markdown } from '@/ui/components/Markdown';
import { Badge, EmptyState, Input } from '@/ui/components/ui';
import { usePlayView } from '../playView';
import { Group, HiddenNote } from './Group';

const KIND_GROUPS: { kind: JournalKind; label: string }[] = [
  { kind: 'npc', label: 'People' },
  { kind: 'location', label: 'Places' },
  { kind: 'faction', label: 'Factions' },
  { kind: 'item', label: 'Items' },
  { kind: 'lore', label: 'Lore' },
  { kind: 'event', label: 'Events' },
  { kind: 'ruling', label: 'House rules' },
  { kind: 'note', label: 'Notes' },
];

function matches(entry: JournalEntry, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return [entry.name, entry.summary, entry.status ?? '', ...entry.tags].some((text) => text.toLowerCase().includes(q));
}

export function JournalTab() {
  const journal = useGame((s) => s.journal);
  const spoilers = usePlayView((s) => s.showSpoilers);
  const [query, setQuery] = useState('');
  const filterId = useId();

  const visible = useMemo(
    () => journal.filter((e) => (spoilers || !e.secret) && matches(e, query.trim())),
    [journal, spoilers, query],
  );
  const hiddenSecrets = spoilers ? 0 : journal.filter((e) => e.secret).length;

  if (journal.length === 0) {
    return (
      <EmptyState icon={<NotebookPen className="size-7" aria-hidden />} title="The journal is empty" className="py-8">
        People, places and house rules are recorded here as you meet them.
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <label htmlFor={filterId} className="sr-only">
          Filter the journal
        </label>
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" aria-hidden />
        <Input
          id={filterId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter the journal"
          className="h-9 pl-9"
        />
      </div>
      {KIND_GROUPS.map(({ kind, label }) => {
        const items = visible.filter((e) => e.kind === kind);
        if (items.length === 0) return null;
        return (
          <Group key={kind} label={label} count={items.length}>
            {items.map((e) => (
              <JournalCard key={e.id} entry={e} />
            ))}
          </Group>
        );
      })}
      {visible.length === 0 && <p className="text-sm text-muted">Nothing matches “{query.trim()}”.</p>}
      <HiddenNote count={hiddenSecrets} singular="entry" plural="entries" />
    </div>
  );
}

function JournalCard({ entry }: { entry: JournalEntry }) {
  return (
    <article className="rounded-xl border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <h4 className="text-sm font-semibold">{entry.name}</h4>
        {entry.status && <Badge>{entry.status}</Badge>}
        {entry.secret && <Badge tone="arcane">DM secret</Badge>}
      </div>
      <p className="mt-0.5 text-sm text-muted">{entry.summary}</p>
      {entry.details && (
        <details className="mt-1.5 text-sm">
          <summary className="cursor-pointer text-xs font-medium text-faint hover:text-text">More</summary>
          <div className="mt-1">
            <Markdown>{entry.details}</Markdown>
          </div>
        </details>
      )}
      {entry.tags.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1" aria-label="Tags">
          {entry.tags.map((tag) => (
            <li key={tag} className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[0.6875rem] text-muted">
              {tag}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
