import { FlaskConical } from 'lucide-react';
import type { HomebrewEntry } from '@/types';
import { Markdown } from '@/ui/components/Markdown';
import { Badge, Button, Dialog } from '@/ui/components/ui';
import { capitalize } from './format';

/**
 * Read-only view of a homebrew entry. When the entry can't be found (e.g. a log line for homebrew
 * that was since deleted), `fallbackTitle` / `fallbackText` are shown instead.
 */
export function HomebrewViewer({
  open,
  onClose,
  entry,
  fallbackTitle,
  fallbackText,
  onVeto,
  vetoed,
}: {
  open: boolean;
  onClose: () => void;
  entry: HomebrewEntry | undefined;
  fallbackTitle?: string;
  fallbackText?: string;
  onVeto?: () => void;
  vetoed?: boolean;
}) {
  const title = entry?.name ?? fallbackTitle ?? 'Homebrew';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          <FlaskConical className="size-5 text-arcane" aria-hidden />
          {title}
        </span>
      }
      description={entry?.summary}
      footer={
        <>
          {onVeto && (
            <Button variant="ghost" onClick={onVeto} disabled={vetoed}>
              {vetoed ? 'Veto sent' : 'Veto'}
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      {entry ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-1.5">
            <Badge tone="arcane">{capitalize(entry.kind)}</Badge>
            <Badge tone={entry.status === 'active' ? 'success' : 'neutral'}>
              {entry.status === 'active' ? 'Active' : 'Retired'}
            </Badge>
            <Badge>{entry.origin === 'dm' ? 'Made by the DM' : 'Made by you'}</Badge>
            {entry.campaignId === null && <Badge tone="info">Shared across campaigns</Badge>}
          </div>
          {entry.basedOn && (
            <p className="text-sm text-muted">
              Based on <span className="font-medium text-text">{entry.basedOn.name}</span>
            </p>
          )}
          <Markdown>{entry.text}</Markdown>
          {entry.balanceNotes && (
            <section className="rounded-xl border border-border bg-surface-2 p-3">
              <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Balance notes</h3>
              <Markdown>{entry.balanceNotes}</Markdown>
            </section>
          )}
        </div>
      ) : fallbackText ? (
        <Markdown>{fallbackText}</Markdown>
      ) : (
        <p className="text-sm text-muted">This homebrew is no longer in the campaign compendium.</p>
      )}
    </Dialog>
  );
}
