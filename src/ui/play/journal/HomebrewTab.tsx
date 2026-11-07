import { useState } from 'react';
import { ChevronRight, FlaskConical } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useGame } from '@/state/gameStore';
import type { HomebrewEntry } from '@/types';
import { Badge, EmptyState } from '@/ui/components/ui';
import { capitalize } from '../format';
import { HomebrewViewer } from '../HomebrewViewer';
import { vetoHomebrew } from '../homebrew';
import { Group } from './Group';

export function HomebrewTab() {
  const homebrew = useGame((s) => s.homebrew);
  const campaignId = useGame((s) => s.campaignId);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [vetoed, setVetoed] = useState<ReadonlySet<string>>(new Set());

  if (homebrew.length === 0) {
    return (
      <EmptyState icon={<FlaskConical className="size-7" aria-hidden />} title="No homebrew yet" className="py-8">
        Spells, boons and monsters the DM invents for this campaign are collected here.
      </EmptyState>
    );
  }

  const byStatus = (a: HomebrewEntry, b: HomebrewEntry) =>
    a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'active' ? -1 : 1;
  const campaignItems = homebrew.filter((h) => h.campaignId === campaignId).sort(byStatus);
  const sharedItems = homebrew.filter((h) => h.campaignId !== campaignId).sort(byStatus);
  const viewing = homebrew.find((h) => h.id === viewingId);

  const veto = (entry: HomebrewEntry) => {
    vetoHomebrew(entry.name);
    setVetoed((prev) => new Set(prev).add(entry.id));
  };

  const list = (items: HomebrewEntry[]) =>
    items.map((h) => (
      <button
        key={h.id}
        type="button"
        onClick={() => setViewingId(h.id)}
        className={cn(
          'flex w-full items-start gap-2 rounded-xl border border-border bg-surface p-3 text-left transition-colors hover:border-arcane/50 hover:bg-arcane-soft/30',
          h.status === 'retired' && 'opacity-60',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold">{h.name}</span>
            <Badge tone="arcane">{capitalize(h.kind)}</Badge>
            {h.status === 'retired' && <Badge>Retired</Badge>}
          </span>
          {h.summary && <span className="mt-0.5 block text-sm text-muted">{h.summary}</span>}
        </span>
        <ChevronRight className="mt-0.5 size-4 shrink-0 text-faint" aria-hidden />
      </button>
    ));

  return (
    <div className="flex flex-col gap-4">
      {campaignItems.length > 0 && (
        <Group label="This campaign" count={campaignItems.length}>
          {list(campaignItems)}
        </Group>
      )}
      {sharedItems.length > 0 && (
        <Group label="Shared" count={sharedItems.length}>
          {list(sharedItems)}
        </Group>
      )}
      <HomebrewViewer
        open={viewing !== undefined}
        onClose={() => setViewingId(null)}
        entry={viewing}
        onVeto={viewing && viewing.status === 'active' ? () => veto(viewing) : undefined}
        vetoed={viewing ? vetoed.has(viewing.id) : false}
      />
    </div>
  );
}
