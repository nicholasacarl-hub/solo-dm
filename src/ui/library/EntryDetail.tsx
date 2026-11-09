/**
 * Full text of one compendium entry (spell, monster, rule...). An entry the player reviewed from an
 * imported book also shows its "Reviewed stats" (the stats line the DM's lookups carry) with a link to
 * the record on the book page.
 */
import { Link } from 'react-router';
import { ArrowLeft, CircleCheck, Link2 } from 'lucide-react';
import { isReviewedImport, statsLine } from '@/data';
import type { CompendiumEntry } from '@/types';
import { Badge, Button, IconButton } from '@/ui/components/ui';
import { Markdown } from '@/ui/components/Markdown';
import { toast } from '@/ui/components/toast';
import { kindInfo } from './kinds';

async function copyCurrentLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(window.location.href);
    toast.success('Link copied.');
  } catch {
    toast.error('Could not copy the link.');
  }
}

export function EntryDetail({ entry, onBack }: { entry: CompendiumEntry; onBack?: () => void }) {
  const info = kindInfo(entry.kind);
  return (
    <article aria-labelledby="library-entry-title" className="min-w-0">
      {onBack && (
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 mb-3 lg:hidden"
          icon={<ArrowLeft className="size-4" aria-hidden />}
          onClick={onBack}
        >
          Back to results
        </Button>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={info.tone}>{info.label}</Badge>
        <span className="text-xs text-muted">{entry.sourceName}</span>
        <IconButton label="Copy a link to this entry" size="sm" className="ml-auto" onClick={() => void copyCurrentLink()}>
          <Link2 className="size-4" aria-hidden />
        </IconButton>
      </div>
      <h2 id="library-entry-title" className="mt-2 font-serif text-2xl leading-tight font-semibold">
        {entry.name}
      </h2>
      {entry.summary && <p className="mt-1 text-sm text-muted italic">{entry.summary}</p>}
      {entry.path && entry.path.length > 0 && <p className="mt-1 text-xs text-muted">{entry.path.join(' › ')}</p>}
      <ReviewedStats entry={entry} />
      <Markdown className="mt-4">{entry.text}</Markdown>
    </article>
  );
}

/** The card for an entry materialized from an accepted record (spec §6.7). */
function ReviewedStats({ entry }: { entry: CompendiumEntry }) {
  if (!isReviewedImport(entry)) return null;
  const line = statsLine(entry).replace(/^Reviewed stats:\s*/, '');
  const recordId = typeof entry.data?.recordId === 'string' ? entry.data.recordId : null;
  if (!line) return null;
  return (
    <section aria-labelledby="reviewed-stats-title" className="mt-3 rounded-xl border border-success/30 bg-success-soft/40 px-3 py-2.5">
      <h3 id="reviewed-stats-title" className="inline-flex items-center gap-1.5 font-display text-xs font-semibold tracking-[0.14em] text-success uppercase">
        <CircleCheck className="size-3.5" aria-hidden />
        Reviewed stats
      </h3>
      <p className="mt-1 text-sm whitespace-pre-line">{line}</p>
      {recordId && (
        <Link
          to={`/library/source/${encodeURIComponent(entry.sourceId)}?c=${encodeURIComponent(recordId)}&f=all`}
          className="mt-1 inline-block text-xs text-accent underline underline-offset-2"
        >
          Edit it on the book's page
        </Link>
      )}
    </section>
  );
}
