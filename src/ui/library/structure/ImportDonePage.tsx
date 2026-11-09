/**
 * The ImportDialog's last page (spec §4.1, §3.12): what was imported, what detection found ("Found 508
 * things the app can use: 2 classes, 16 subclasses, …"), a warning when the same book is already in
 * the Library, and the next step. A JSON pack instead offers "Accept the N confident" and, for a
 * "Download book data" file, an unticked "Also accept the N you accepted on your other device".
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CopyCheck, Info } from 'lucide-react';
import type { DetectionSummary, PackImport } from '@/data';
import { cn } from '@/lib/cn';
import { STRUCTURED_KINDS, type LibrarySource } from '@/types';
import { toast } from '@/ui/components/toast';
import { Button } from '@/ui/components/ui';
import { errorMessage, plural } from '@/ui/shell/format';
import { isConfident } from './bookData';
import { kindCount } from './labels';
import { acceptRecords } from './reviewActions';
import { TOUCH, TOUCH_BUTTONS } from './touch';

/** "2 classes, 16 subclasses, 8 species, …" in STRUCTURED_KINDS order. */
export function foundList(summary: Pick<DetectionSummary, 'byKind'>): string {
  return STRUCTURED_KINDS.flatMap((k) => {
    const n = summary.byKind[k]?.found ?? 0;
    return n > 0 ? [kindCount(k, n)] : [];
  }).join(', ');
}

/** The done page's main sentence. */
export function detectionText(source: Pick<LibrarySource, 'title' | 'entryCount'>, summary: DetectionSummary): string {
  const head = `Imported ${plural(source.entryCount, 'entry', 'entries')} from “${source.title}”.`;
  if (summary.total === 0) {
    return `${head} Nothing here looks like a spell, monster, item, feat, species, background, class or subclass. The DM can still look up all of it.`;
  }
  const ready = `${summary.readyOffline} ${summary.readyOffline === 1 ? 'was' : 'were'} read on this device`;
  const where =
    summary.needClaude > 0
      ? ` ${ready}; ${summary.needClaude} ${summary.needClaude === 1 ? 'needs' : 'need'} Claude.`
      : summary.readyOffline === 1
        ? ' It was read on this device.'
        : ` All ${summary.readyOffline} were read on this device.`;
  return `${head} Found ${summary.total} ${summary.total === 1 ? 'thing' : 'things'} the app can use: ${foundList(summary)}.${where}`;
}

export function ImportDonePage({
  source,
  summary,
  pack,
  detectError,
  duplicateOf,
  onDone,
  onOpenBook,
}: {
  source: LibrarySource;
  summary: DetectionSummary | null;
  pack: PackImport | null;
  detectError?: string | null;
  duplicateOf?: { id: string; title: string } | null;
  onDone(): void;
  onOpenBook(): void;
}) {
  const [alsoElsewhere, setAlsoElsewhere] = useState(false);
  // The dialog's progress view (and the button that had focus) is gone: focus the summary, so it is read
  // and Tab goes on to the actions.
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    summaryRef.current?.focus({ preventScroll: true });
  }, []);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState<number | null>(null);
  const duplicate = duplicateOf ?? summary?.duplicateOf ?? null;
  const confident = pack ? pack.records.filter(isConfident) : [];
  const elsewhere = pack ? pack.records.filter((r) => r.reviewedElsewhere) : [];

  const acceptPack = async () => {
    setBusy(true);
    try {
      const ids = new Set(confident.map((r) => r.id));
      if (alsoElsewhere) for (const r of elsewhere) ids.add(r.id);
      const result = await acceptRecords([...ids]);
      setAccepted(result.accepted);
      // The accept box goes: focus the next step.
      openRef.current?.focus();
      toast.success(`Accepted ${result.accepted}.${result.skipped.length ? ` ${result.skipped.length} need a look first.` : ''}`);
    } catch (error) {
      toast.error(errorMessage(error, 'Could not accept them.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn('flex flex-col gap-4 py-2', TOUCH_BUTTONS)}>
      {pack ? (
        <>
          <p ref={summaryRef} tabIndex={-1} className="text-sm font-medium focus:outline-none">
            Imported {plural(pack.entries.length || source.entryCount, 'entry', 'entries')} and {plural(pack.records.length, 'structured entry', 'structured entries')} from “
            {source.title}”.
          </p>
          <p className="text-sm text-muted">Everything from a file waits for your review before the builder, combat or spell lists use it.</p>
          {source.notes && <p className="rounded-xl bg-surface-2 px-3 py-2 text-xs text-muted [overflow-wrap:anywhere]">{source.notes}</p>}
          {pack.issues.length > 0 && (
            <details className="text-xs text-muted">
              <summary className="cursor-pointer">{plural(pack.issues.length, 'record was', 'records were')} skipped</summary>
              <ul className="mt-1 list-disc pl-4">
                {pack.issues.slice(0, 20).map((i) => (
                  <li key={`${i.path}-${i.message}`}>
                    {i.path}: {i.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {accepted === null && (confident.length > 0 || elsewhere.length > 0) && (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3">
              {elsewhere.length > 0 && (
                <label className={cn('flex cursor-pointer items-start gap-2.5 text-sm', TOUCH)}>
                  <input type="checkbox" checked={alsoElsewhere} onChange={(e) => setAlsoElsewhere(e.target.checked)} className="mt-0.5 size-4 accent-[var(--accent)]" />
                  <span>Also accept the {plural(elsewhere.length, 'entry', 'entries')} you accepted on your other device</span>
                </label>
              )}
              <div>
                <Button variant="primary" loading={busy} disabled={confident.length === 0 && !alsoElsewhere} onClick={() => void acceptPack()}>
                  {alsoElsewhere ? `Accept ${new Set([...confident, ...elsewhere].map((r) => r.id)).size}` : `Accept the ${confident.length} confident`}
                </Button>
              </div>
            </div>
          )}
        </>
      ) : summary ? (
        <>
          <p ref={summaryRef} tabIndex={-1} className="text-sm font-medium focus:outline-none">
            {detectionText(source, summary)}
          </p>
          {summary.leftOut > 0 && (
            <p className="text-xs text-muted">
              {plural(summary.leftOut, 'more was', 'more were')} left out: a book can hold 5,000 structured entries.
            </p>
          )}
        </>
      ) : (
        <>
          <p ref={summaryRef} tabIndex={-1} className="text-sm font-medium focus:outline-none">
            Imported {plural(source.entryCount, 'entry', 'entries')} from “{source.title}”.
          </p>
          {detectError && (
            <p className="flex gap-2 text-xs text-muted">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>Looking for spells, monsters and character options didn't finish ({detectError}). Try “Structure this book” on its page.</span>
            </p>
          )}
        </>
      )}
      {duplicate && (
        <p className="flex gap-2 rounded-xl bg-gold-soft/60 px-3 py-2 text-sm">
          <CopyCheck className="mt-0.5 size-4 shrink-0 text-gold" aria-hidden />
          <span>This looks like the same book as “{duplicate.title}”.</span>
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
        <Button variant="ghost" onClick={onDone}>
          Done
        </Button>
        <Button ref={openRef} variant="primary" icon={<ArrowRight className="size-4" aria-hidden />} onClick={onOpenBook}>
          {pack || (summary && summary.total === 0) ? 'Open the book' : 'Review and set up'}
        </Button>
      </div>
    </div>
  );
}
