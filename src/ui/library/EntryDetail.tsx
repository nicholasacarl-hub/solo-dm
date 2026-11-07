/** Full text of one compendium entry (spell, monster, rule...). */
import { ArrowLeft, Link2 } from 'lucide-react';
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
      <Markdown className="mt-4">{entry.text}</Markdown>
    </article>
  );
}
