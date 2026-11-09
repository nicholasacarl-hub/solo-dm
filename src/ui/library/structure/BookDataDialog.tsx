/**
 * "Download book data (contains the book's text)" (spec §3.12, D20): a file of the player's own book
 * and their review, to move it to another of their devices without structuring it again. Only on
 * the book page's ⋯ menu; the name and the dialog say it holds the book's text. Campaign exports and
 * sync never touch it.
 */
import { useState } from 'react';
import { Download, TriangleAlert } from 'lucide-react';
import { exportPack } from '@/data';
import { slugify } from '@/lib/id';
import { getSourceEntries, listRecords } from '@/storage';
import type { LibrarySource } from '@/types';
import { toast } from '@/ui/components/toast';
import { Button, Dialog } from '@/ui/components/ui';
import { errorMessage } from '@/ui/shell/format';

export function bookDataFileName(title: string): string {
  return `${slugify(title) || 'book'}.book-data.json`;
}

/** Save JSON as a file the browser downloads (nothing leaves the device). */
export function saveJsonFile(fileName: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function BookDataDialog({ open, source, onClose }: { open: boolean; source: LibrarySource; onClose(): void }) {
  const [busy, setBusy] = useState(false);
  const fileName = bookDataFileName(source.title);
  const download = async () => {
    setBusy(true);
    try {
      const [entries, records] = await Promise.all([getSourceEntries(source.id), listRecords(source.id)]);
      saveJsonFile(fileName, exportPack(source, entries, records));
      toast.success(`Saved ${fileName}. Keep it for yourself.`);
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, 'Could not make the book data file.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      size="md"
      title="Download book data"
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} icon={<Download className="size-4" aria-hidden />} onClick={() => void download()}>
            Download book data
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="flex gap-2 rounded-xl bg-gold-soft/60 px-3 py-2">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-gold" aria-hidden />
          <span>
            This file contains the full text of “{source.title}” and your reviewed data, so you can move this book to another of your devices
            without structuring it again. Keep it for yourself; don't share it. It is never part of campaign saves or GitHub backups.
          </span>
        </p>
        <p className="text-muted">
          File: <span className="font-mono text-text">{fileName}</span>. Import it on your other device from Library › My library › Import.
          Entries you accepted here arrive waiting for review there, with one tap to accept them again.
        </p>
      </div>
    </Dialog>
  );
}
