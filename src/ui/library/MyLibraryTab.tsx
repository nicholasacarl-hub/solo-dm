/** Library › My library: the bundled SRD plus the player's imports (enable, delete, import). */
import { useState } from 'react';
import { BookOpenText, BookPlus, FileText, Lock, Trash2 } from 'lucide-react';
import { deleteLibrarySource, setLibrarySourceEnabled, useLibrarySources } from '@/storage';
import { SRD_SOURCE_ID, type LibrarySource } from '@/types';
import { Badge, Button, Dialog, EmptyState, IconButton, Spinner, Switch } from '@/ui/components/ui';
import { toast } from '@/ui/components/toast';
import { errorMessage, formatRelativeTime, plural } from '@/ui/shell/format';
import { ImportDialog } from './ImportDialog';
import { refreshRulesIndex } from './kinds';

const FORMAT_LABELS: Record<NonNullable<LibrarySource['format']>, string> = {
  text: 'Plain text',
  markdown: 'Markdown',
  pdf: 'PDF',
  json: 'JSON',
};

export function MyLibraryTab() {
  const sources = useLibrarySources();
  const [importOpen, setImportOpen] = useState(false);
  const [importKey, setImportKey] = useState(0);
  const [toDelete, setToDelete] = useState<LibrarySource | null>(null);

  const srd = sources?.find((s) => s.id === SRD_SOURCE_ID);
  const imports = (sources ?? []).filter((s) => s.kind === 'import').sort((a, b) => b.createdAt - a.createdAt);

  const openImport = () => {
    setImportKey((k) => k + 1);
    setImportOpen(true);
  };

  const toggle = async (source: LibrarySource, enabled: boolean) => {
    try {
      await setLibrarySourceEnabled(source.id, enabled);
      refreshRulesIndex();
    } catch (error) {
      toast.error(errorMessage(error, 'Could not update that source.'));
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="max-w-2xl text-sm text-muted">
          Bring in rules from books you own: paste text, upload a PDF that has selectable text, or photograph pages.
          Your DM searches every source that’s switched on. Imports stay on this device.
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
          <SrdRow entryCount={srd?.entryCount} />
          {imports.map((source) => (
            <SourceRow
              key={source.id}
              source={source}
              onToggle={(enabled) => void toggle(source, enabled)}
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
      <DeleteSourceDialog source={toDelete} onClose={() => setToDelete(null)} />
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
  onToggle,
  onDelete,
}: {
  source: LibrarySource;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
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
          <p className="font-medium [overflow-wrap:anywhere]">{source.title}</p>
          <p className="mt-0.5 text-xs text-muted">{meta.join(' · ')}</p>
          {source.notes && <p className="mt-1 text-xs text-faint [overflow-wrap:anywhere]">{source.notes}</p>}
        </div>
      </div>
      <div className="flex items-center gap-3 sm:shrink-0">
        <div className="flex-1 sm:w-48 sm:flex-none">
          <Switch checked={source.enabled} onChange={onToggle} label="Use in rules search" />
        </div>
        <IconButton label={`Delete ${source.title}`} onClick={onDelete}>
          <Trash2 className="size-4" aria-hidden />
        </IconButton>
      </div>
    </li>
  );
}

function DeleteSourceDialog({ source, onClose }: { source: LibrarySource | null; onClose: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const confirm = async () => {
    if (!source) return;
    setDeleting(true);
    try {
      await deleteLibrarySource(source.id);
      refreshRulesIndex();
      toast.success(`Deleted “${source.title}”.`);
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, 'Could not delete that source.'));
    } finally {
      setDeleting(false);
    }
  };
  return (
    <Dialog
      open={source !== null}
      onClose={() => {
        if (!deleting) onClose();
      }}
      size="sm"
      title="Delete this import?"
      footer={
        <>
          <Button variant="ghost" disabled={deleting} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={deleting} onClick={() => void confirm()}>
            Delete
          </Button>
        </>
      }
    >
      {source && (
        <p className="text-sm">
          “{source.title}” and its {plural(source.entryCount, 'entry', 'entries')} will be removed from this browser. Your
          campaigns keep any homebrew based on it.
        </p>
      )}
    </Dialog>
  );
}
