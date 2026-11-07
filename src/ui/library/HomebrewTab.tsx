/** Library › Homebrew: everything the DM invented or the player wrote, across all campaigns. */
import { useMemo, useState } from 'react';
import { FlaskConical, Plus } from 'lucide-react';
import { useCampaignList, useHomebrewList } from '@/storage';
import { CONTENT_KINDS, type HomebrewEntry } from '@/types';
import { cn } from '@/lib/cn';
import { Badge, Button, EmptyState, SectionTitle, Select, Spinner, Switch } from '@/ui/components/ui';
import { HomebrewDialog, type CampaignOption } from './HomebrewDialog';
import { kindInfo } from './kinds';

type Scope = 'all' | 'shared' | `campaign:${string}`;

const byName = (a: HomebrewEntry, b: HomebrewEntry) => a.name.localeCompare(b.name);

function inScope(entry: HomebrewEntry, scope: Scope): boolean {
  if (scope === 'all') return true;
  if (scope === 'shared') return entry.campaignId === null;
  return entry.campaignId === scope.slice('campaign:'.length);
}

export function HomebrewTab() {
  const homebrew = useHomebrewList(undefined);
  const campaigns = useCampaignList();
  const [scope, setScope] = useState<Scope>('all');
  const [showRetired, setShowRetired] = useState(true);
  const [dialog, setDialog] = useState<{ key: number; entry: HomebrewEntry | null } | null>(null);

  const campaignOptions: CampaignOption[] = useMemo(
    () => (campaigns ?? []).map((s) => ({ id: s.campaign.id, name: s.campaign.name })),
    [campaigns],
  );
  const campaignName = (id: string | null) =>
    id === null ? 'All campaigns' : (campaignOptions.find((c) => c.id === id)?.name ?? 'A deleted campaign');

  const groups = useMemo(() => {
    const visible = (homebrew ?? []).filter((h) => (showRetired || h.status === 'active') && inScope(h, scope));
    return CONTENT_KINDS.map((kind) => ({ kind, items: visible.filter((h) => h.kind === kind).sort(byName) })).filter(
      (g) => g.items.length > 0,
    );
  }, [homebrew, scope, showRetired]);

  const open = (entry: HomebrewEntry | null) => setDialog((d) => ({ key: (d?.key ?? 0) + 1, entry }));
  const total = homebrew?.length ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="max-w-2xl text-sm text-muted">
          Spells, items, monsters and boons your DM invented, or that you wrote. Edit, retire or delete any of them;
          if a campaign is open, the DM is told on your next turn.
        </p>
        <Button variant="arcane" icon={<Plus className="size-4" aria-hidden />} onClick={() => open(null)}>
          New homebrew
        </Button>
      </div>

      {total > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Select
            aria-label="Show homebrew from"
            value={scope}
            onChange={(e) => setScope(e.target.value as Scope)}
            className="sm:w-64"
          >
            <option value="all">All campaigns</option>
            <option value="shared">Shared homebrew only</option>
            {campaignOptions.map((c) => (
              <option key={c.id} value={`campaign:${c.id}`}>
                {c.name}
              </option>
            ))}
          </Select>
          <div className="sm:ml-auto sm:w-48">
            <Switch checked={showRetired} onChange={setShowRetired} label="Show retired" />
          </div>
        </div>
      )}

      {homebrew === undefined ? (
        <div className="flex items-center gap-3 py-8 text-sm text-muted">
          <Spinner label="Loading homebrew" />
          <span aria-hidden>Loading homebrew…</span>
        </div>
      ) : total === 0 ? (
        <EmptyState
          icon={<FlaskConical className="size-8" aria-hidden />}
          title="No homebrew yet"
          action={
            <Button icon={<Plus className="size-4" aria-hidden />} onClick={() => open(null)}>
              Write your own
            </Button>
          }
        >
          When your DM invents a spell, an item or a boon, it’s saved here so you can read it, tweak it or veto it.
        </EmptyState>
      ) : groups.length === 0 ? (
        <EmptyState title="Nothing matches these filters" />
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <section key={group.kind} aria-label={kindInfo(group.kind).plural}>
              <SectionTitle>
                {kindInfo(group.kind).plural} ({group.items.length})
              </SectionTitle>
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {group.items.map((entry) => (
                  <li key={entry.id} className="min-w-0">
                    <HomebrewCard entry={entry} campaignLabel={campaignName(entry.campaignId)} onOpen={() => open(entry)} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {dialog && (
        <HomebrewDialog
          key={dialog.key}
          open
          entry={dialog.entry}
          campaigns={campaignOptions}
          campaignName={campaignName}
          defaultCampaignId={scope.startsWith('campaign:') ? scope.slice('campaign:'.length) : null}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function HomebrewCard({ entry, campaignLabel, onOpen }: { entry: HomebrewEntry; campaignLabel: string; onOpen: () => void }) {
  const retired = entry.status === 'retired';
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'flex h-full w-full flex-col gap-1 rounded-xl border border-border bg-surface p-3 text-left transition-colors hover:border-arcane/50',
        retired && 'opacity-70',
      )}
    >
      <span className="flex items-start justify-between gap-2">
        <span className={cn('min-w-0 font-medium [overflow-wrap:anywhere]', retired && 'line-through decoration-faint')}>
          {entry.name}
        </span>
        {retired ? <Badge>Retired</Badge> : <Badge tone="arcane">{entry.origin === 'dm' ? 'DM' : 'You'}</Badge>}
      </span>
      {entry.summary && <span className="line-clamp-2 text-xs text-muted">{entry.summary}</span>}
      <span className="mt-auto pt-1 text-xs text-muted">{campaignLabel}</span>
    </button>
  );
}
