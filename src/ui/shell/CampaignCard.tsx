/** A save-slot card on the Home screen. */
import { useId, useState } from 'react';
import { Clock, Copy, Download, Loader2, Play, ScrollText, Trash2 } from 'lucide-react';
import { downloadCampaign, duplicateCampaign, type CampaignSummary } from '@/storage';
import { Badge, IconButton } from '@/ui/components/ui';
import { ButtonLink } from '@/ui/components/ButtonLink';
import { portraitDisplay } from '@/ui/components/portrait';
import { toast } from '@/ui/components/toast';
import { DEFAULT_COVER_COLOR, DEFAULT_COVER_EMOJI, coverTint } from './campaignOptions';
import { characterLine, errorMessage, formatRelativeTime, plural } from './format';
import { askToKeepSaves } from './persistentStorage';

/** Where "Continue" goes: the table if there's a character, otherwise the builder. */
export function continuePath(campaign: CampaignSummary['campaign']): string {
  return campaign.characterId ? `/play/${campaign.id}` : `/campaign/${campaign.id}/character`;
}

function Portrait({ portrait }: { portrait?: string }) {
  // An emoji or an embedded image; never fetch remote URLs from a save file.
  const shown = portraitDisplay(portrait);
  if (!shown) return null;
  if (shown.kind === 'image') {
    return <img src={shown.src} alt="" className="size-5 shrink-0 rounded-full object-cover" />;
  }
  return (
    <span aria-hidden className="shrink-0 text-base leading-none">
      {shown.text}
    </span>
  );
}

export function CampaignCard({ summary, onDelete }: { summary: CampaignSummary; onDelete: () => void }) {
  const titleId = useId();
  const { campaign, character } = summary;
  const [working, setWorking] = useState<'duplicate' | 'export' | null>(null);
  const color = campaign.coverColor || DEFAULT_COVER_COLOR;

  const run = async (kind: 'duplicate' | 'export') => {
    setWorking(kind);
    try {
      if (kind === 'duplicate') {
        const copy = await duplicateCampaign(campaign.id);
        toast.success(`Duplicated as “${copy.name}”.`);
      } else {
        await downloadCampaign(campaign.id);
        toast.success(`Exported “${campaign.name}”.`);
      }
    } catch (error) {
      toast.error(errorMessage(error, kind === 'duplicate' ? 'Could not duplicate the campaign.' : 'Could not export the campaign.'));
    } finally {
      setWorking(null);
    }
  };

  const lastPlayed = campaign.lastPlayedAt ? `Last played ${formatRelativeTime(campaign.lastPlayedAt)}` : 'Not played yet';
  const sessions = campaign.sessionCount > 0 ? plural(campaign.sessionCount, 'session') : 'No sessions yet';

  return (
    <article
      aria-labelledby={titleId}
      className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-card"
    >
      <div aria-hidden className="h-1" style={{ background: color }} />
      <div className="flex flex-1 gap-4 p-4">
        <div
          aria-hidden
          className="grid size-14 shrink-0 place-items-center rounded-xl text-[1.75rem] leading-none"
          style={{ background: coverTint(color) }}
        >
          {campaign.coverEmoji || DEFAULT_COVER_EMOJI}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h2 id={titleId} className="min-w-0 font-serif text-lg leading-snug font-semibold [overflow-wrap:anywhere]">
              {campaign.name}
            </h2>
            {campaign.status === 'setup' && <Badge tone="accent">Setting up</Badge>}
            {campaign.status === 'archived' && <Badge>Archived</Badge>}
          </div>
          <p className="mt-1 flex min-w-0 items-start gap-1.5 text-sm text-muted">
            {character && <Portrait portrait={character.portrait} />}
            <span className="line-clamp-2 min-w-0">{character ? characterLine(character) : 'No character yet'}</span>
          </p>
          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3.5" aria-hidden />
              {lastPlayed}
            </span>
            <span className="inline-flex items-center gap-1">
              <ScrollText className="size-3.5" aria-hidden />
              {sessions}
            </span>
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1 border-t border-border px-3 py-2.5">
        <ButtonLink
          to={continuePath(campaign)}
          variant="primary"
          size="sm"
          aria-label={`Continue ${campaign.name}`}
          icon={<Play className="size-3.5" aria-hidden />}
          onClick={askToKeepSaves}
        >
          Continue
        </ButtonLink>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton
            label={`Duplicate ${campaign.name}`}
            size="sm"
            disabled={working !== null}
            onClick={() => void run('duplicate')}
          >
            {working === 'duplicate' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          </IconButton>
          <IconButton
            label={`Export ${campaign.name}`}
            size="sm"
            disabled={working !== null}
            onClick={() => void run('export')}
          >
            {working === 'export' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />}
          </IconButton>
          <IconButton label={`Delete ${campaign.name}`} size="sm" disabled={working !== null} onClick={onDelete}>
            <Trash2 className="size-4" aria-hidden />
          </IconButton>
        </div>
      </div>
    </article>
  );
}

export function CampaignCardSkeleton() {
  return (
    <div aria-hidden className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="h-1 bg-surface-3" />
      <div className="flex gap-4 p-4">
        <div className="size-14 animate-pulse rounded-xl bg-surface-2" />
        <div className="flex flex-1 flex-col gap-2 pt-1">
          <div className="h-4 w-2/3 animate-pulse rounded bg-surface-2" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-surface-2" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-surface-2" />
        </div>
      </div>
      <div className="h-[53px] border-t border-border" />
    </div>
  );
}
