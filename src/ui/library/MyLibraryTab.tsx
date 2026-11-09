/**
 * Library › My library: the bundled SRD plus the player's imports (enable, delete, import). Each book
 * links to its book page and shows its structuring status; switching a book off or deleting it says
 * which characters use it (spec D41).
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { BookOpenText, BookPlus, FileText, ListChecks, Lock, Trash2 } from 'lucide-react';
import { useJobs, useLibrarySources } from '@/storage';
import { SRD_SOURCE_ID, type ExtractionJob, type LibrarySource } from '@/types';
import { ButtonLink } from '@/ui/components/ButtonLink';
import { Badge, Button, EmptyState, IconButton, Spinner, Switch } from '@/ui/components/ui';
import { formatRelativeTime, plural } from '@/ui/shell/format';
import { ImportDialog } from './ImportDialog';
import { DeleteBookDialog, useBookSwitch } from './structure/bookControls';
import { SourceRowStatus } from './structure/SourceRowStatus';
import { UndoToast } from './structure/UndoToast';
import { TOUCH, TOUCH_SQUARE, TOUCH_SWITCH } from './structure/touch';
import { manifestEntryCount, useSrdManifest } from './useSrdManifest';

const FORMAT_LABELS: Record<NonNullable<LibrarySource['format']>, string> = {
  text: 'Plain text',
  markdown: 'Markdown',
  pdf: 'PDF',
  json: 'JSON',
};

export function MyLibraryTab() {
  const sources = useLibrarySources();
  const jobs = useJobs();
  const manifest = useSrdManifest();
  const { toggle, dialog: switchDialog } = useBookSwitch();
  const [importOpen, setImportOpen] = useState(false);
  const [importKey, setImportKey] = useState(0);
  const [toDelete, setToDelete] = useState<LibrarySource | null>(null);

  const srd = sources?.find((s) => s.id === SRD_SOURCE_ID);
  const imports = (sources ?? []).filter((s) => s.kind === 'import').sort((a, b) => b.createdAt - a.createdAt);

  const openImport = () => {
    setImportKey((k) => k + 1);
    setImportOpen(true);
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="max-w-2xl text-sm text-muted">
          Bring in rules from books you own: paste text, upload a PDF that has selectable text, or photograph pages.
          Your DM searches every source that’s switched on. Imports stay on this device. Structure a book to use its
          spells, monsters, items and character options in the builder, combat and spell lists.
        </p>
        <Button variant="primary" icon={<BookPlus className="size-4" aria-hidden />} onClick={openImport}>
          Import
        </Button>
      </div>

      {sources === undefined ? (
        <div className="flex items-center gap-3 py-8 text-sm text-muted">
          <Spinner label="Loading your library" />
          <span aria-hidden>Loading your library…</span>
        </div>
      ) : (
        <ul aria-label="Library sources" className="flex flex-col gap-3">
          <SrdRow entryCount={srd?.entryCount || manifestEntryCount(manifest)} />
          {imports.map((source) => (
            <SourceRow
              key={source.id}
              source={source}
              jobs={jobs ?? []}
              onToggle={(enabled) => toggle(source, enabled)}
              onDelete={() => setToDelete(source)}
            />
          ))}
        </ul>
      )}

      {sources !== undefined && imports.length === 0 && (
        <EmptyState
          icon={<BookOpenText className="size-8" aria-hidden />}
          title="No imports yet"
          action={
            <Button icon={<BookPlus className="size-4" aria-hidden />} onClick={openImport}>
              Import your first book
            </Button>
          }
        >
          Spells, monsters, subclasses and items you import are searchable by your DM alongside the SRD.
        </EmptyState>
      )}

      <ImportDialog key={importKey} open={importOpen} onClose={() => setImportOpen(false)} />
      {/* The import done page's Undo, for what is left of its 10 s once the dialog closes (the dialog has its own). */}
      {!importOpen && <UndoToast />}
      <DeleteBookDialog source={toDelete} onClose={() => setToDelete(null)} />
      {switchDialog}
    </div>
  );
}

const rowClass = 'flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 sm:flex-row sm:items-center';

function SrdRow({ entryCount }: { entryCount?: number }) {
  return (
    <li className={rowClass}>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
          <BookOpenText className="size-[18px]" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            System Reference Document 5.2.1 <Badge>Built in</Badge>
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {entryCount ? `${plural(entryCount, 'entry', 'entries')} · ` : ''}Licensed CC-BY-4.0
          </p>
        </div>
      </div>
      <p className="inline-flex items-center gap-1.5 text-xs text-muted sm:pr-1">
        <Lock className="size-3.5" aria-hidden />
        Always on
      </p>
    </li>
  );
}

function SourceRow({
  source,
  jobs,
  onToggle,
  onDelete,
}: {
  source: LibrarySource;
  jobs: readonly ExtractionJob[];
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const book = `/library/source/${encodeURIComponent(source.id)}`;
  const meta = [
    plural(source.entryCount, 'entry', 'entries'),
    source.format ? FORMAT_LABELS[source.format] : null,
    `added ${formatRelativeTime(source.createdAt)}`,
  ].filter(Boolean);
  return (
    <li className={rowClass}>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-muted">
          <FileText className="size-[18px]" aria-hidden />
        </span>
        <div className="min-w-0">
          <Link to={book} className="font-medium [overflow-wrap:anywhere] underline-offset-2 hover:underline">
            {source.title}
          </Link>
          <p className="mt-0.5 text-xs text-muted">{meta.join(' · ')}</p>
          <SourceRowStatus source={source} jobs={jobs} />
          {source.notes && <p className="mt-1 text-xs text-muted [overflow-wrap:anywhere]">{source.notes}</p>}
        </div>
      </div>
      <div className="flex items-center gap-3 sm:shrink-0">
        <ButtonLink to={book} size="sm" className={TOUCH} icon={<ListChecks className="size-4" aria-hidden />} aria-label={`Review ${source.title}`}>
          Review
        </ButtonLink>
        <div className={`flex-1 sm:w-48 sm:flex-none ${TOUCH_SWITCH}`}>
          <Switch checked={source.enabled} onChange={onToggle} label="Use in rules search" />
        </div>
        <IconButton label={`Delete ${source.title}`} className={TOUCH_SQUARE} onClick={onDelete}>
          <Trash2 className="size-4" aria-hidden />
        </IconButton>
      </div>
    </li>
  );
}
