/**
 * Route: #/library/source/:sourceId — the book page (spec §4.1–§4.7, D21): structure a book, follow
 * Claude's reading, review what was read and accept it. State lives in the URL (useBookPageState).
 * On phones an open record takes the whole screen.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useShallow } from 'zustand/react/shallow';
import { BookX, LoaderCircle, RefreshCw, ScanSearch, TriangleAlert } from 'lucide-react';
import { getBuilderProblems, useBuilderData } from '@/data';
import { extractionAvailability, useRunner } from '@/dm';
import { getSettings, useSettings } from '@/state/settingsStore';
import { getSourceEntries, useJobs, useLibrarySources, useRecords } from '@/storage';
import { PARSER_VERSION, type CompendiumEntry, type ModelId } from '@/types';
import { ErrorBoundary } from '@/ui/components/ErrorBoundary';
import { ProgressBar } from '@/ui/components/ProgressBar';
import { toast } from '@/ui/components/toast';
import { Button, EmptyState, Spinner, Tabs } from '@/ui/components/ui';
import { useMediaQuery } from '@/ui/play/useMediaQuery';
import { errorMessage } from '@/ui/shell/format';
import { Page, useDocumentTitle } from '@/ui/shell/Page';
import { AllEntriesView } from '@/ui/library/structure/AllEntriesView';
import { BookDataDialog } from '@/ui/library/structure/BookDataDialog';
import { DeleteBookDialog, useBookSwitch } from '@/ui/library/structure/bookControls';
import { lookThroughMessage, reviewable, reviewCounts } from '@/ui/library/structure/bookData';
import { BookHeader } from '@/ui/library/structure/BookHeader';
import { ConsentDialog, needsClaude, type ConsentScope } from '@/ui/library/structure/ConsentDialog';
import { kindCount } from '@/ui/library/structure/labels';
import type { Availability } from '@/ui/library/structure/RecordDetail';
import { lookThroughBook } from '@/ui/library/structure/reviewActions';
import { ReviewWorkspace } from '@/ui/library/structure/ReviewWorkspace';
import { StructureAnnouncer, StructureStatusCard } from '@/ui/library/structure/StructureStatusCard';
import { TOUCH, TOUCH_BUTTONS } from '@/ui/library/structure/touch';
import { showUndo, UndoToast } from '@/ui/library/structure/UndoToast';
import { useBookPageState } from '@/ui/library/structure/useBookPageState';

/** The book's entries; read again when `revision` changes (a re-check corrected their kinds). */
function useSourceEntries(sourceId: string, entryCount: number | undefined, revision: number): CompendiumEntry[] | null {
  const [entries, setEntries] = useState<CompendiumEntry[] | null>(null);
  useEffect(() => {
    if (entryCount === undefined) return;
    let alive = true;
    getSourceEntries(sourceId).then(
      (e) => alive && setEntries(e),
      (error: unknown) => {
        console.warn('[library] Could not read the book’s entries:', error);
        if (alive) setEntries([]);
      },
    );
    return () => {
      alive = false;
    };
  }, [sourceId, entryCount, revision]);
  return entries;
}

function useAvailability(): Availability {
  const { mockMode, apiKey } = useSettings(useShallow((s) => ({ mockMode: s.mockMode, apiKey: s.apiKey })));
  // Recomputed when demo mode or the key changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => extractionAvailability(getSettings()), [mockMode, apiKey]);
}

export function LibrarySourceScreen() {
  const { sourceId = '' } = useParams();
  const navigate = useNavigate();
  const sources = useLibrarySources();
  const source = sources?.find((s) => s.id === sourceId);
  const seen = useRef(false);
  if (source) seen.current = true;
  useDocumentTitle(source?.title ?? 'Book');

  const state = useBookPageState();
  const stored = useRecords(source ? sourceId : undefined);
  const jobs = useJobs();
  const runner = useRunner();
  const [entriesRevision, setEntriesRevision] = useState(0);
  const entries = useSourceEntries(sourceId, source?.entryCount, entriesRevision);
  const { data: builder } = useBuilderData();
  const availability = useAvailability();
  const phone = !useMediaQuery('(min-width: 1024px)', true);
  const { toggle, dialog: switchDialog } = useBookSwitch();

  const records = useMemo(() => reviewable(stored ?? []), [stored]);
  const entriesById = useMemo(() => new Map((entries ?? []).map((e) => [e.id, e])), [entries]);
  const counts = useMemo(() => reviewCounts(records, source?.enabled ?? true), [records, source?.enabled]);
  const unread = records.filter(needsClaude).length;
  const recheck = records.filter((r) => r.origin === 'parser' && (r.parserVersion ?? 0) < PARSER_VERSION && r.status !== 'rejected');
  const problems = useMemo(() => {
    const ids = new Set(records.map((r) => r.id));
    return getBuilderProblems().filter((p) => ids.has(p.recordId));
    // getBuilderProblems() reads the latest merge: recompute when the merged data (or the records) change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, builder]);

  const [consent, setConsent] = useState<ConsentScope | null>(null);
  const [bookData, setBookData] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [detect, setDetect] = useState<{ done: number; total: number } | null>(null);
  /** Detection ran here and found nothing (no records means no counts on the source row). */
  const [nothingFound, setNothingFound] = useState(false);

  // ?setup=1 opens the consent once when anything needs Claude, then leaves the URL.
  const { setup, set } = state;
  const ready = stored !== undefined;
  useEffect(() => {
    if (!setup || !ready) return;
    if (unread > 0) setConsent({ kind: 'all' });
    set({ setup: false });
  }, [setup, ready, unread, set]);

  // "Look for entries again" and "Re-check" (after the offline reader improved) are the same look through the book.
  const runDetect = async () => {
    if (!source || detect) return;
    setDetect({ done: 0, total: 1 });
    try {
      const { summary, movedBack, undo } = await lookThroughBook(source.id, { onProgress: (done, total) => setDetect({ done, total }) });
      setNothingFound(summary.total === 0);
      if (summary.rekinded > 0) setEntriesRevision((n) => n + 1);
      const message = lookThroughMessage(summary, movedBack);
      if (undo) showUndo(message, undo);
      else toast.success(message);
    } catch (error) {
      toast.error(errorMessage(error, 'Could not look through the book.'));
    } finally {
      setDetect(null);
    }
  };

  const readWithClaude = (ids: string[], title: string, model?: ModelId) => setConsent({ kind: 'ids', ids, title, model });
  const retry = (jobId: string, ids: string[]) => {
    const first = records.find((r) => r.id === ids[0]);
    const title = ids.length === 1 && first ? first.name : kindCount(first?.kind ?? 'spell', ids.length);
    setConsent({ kind: 'ids', ids, title, retryJobId: jobId });
  };

  if (sources === undefined) {
    return (
      <Page width="full">
        <div className="flex items-center gap-3 py-16 text-sm text-muted">
          <Spinner label="Opening the book" />
          <span aria-hidden>Opening the book…</span>
        </div>
      </Page>
    );
  }
  if (!source) {
    return (
      <Page width="narrow">
        <EmptyState
          icon={<BookX className="size-8" aria-hidden />}
          title={seen.current ? 'This book was deleted.' : 'This book isn’t in this device’s Library.'}
          action={
            <Button className={TOUCH} onClick={() => navigate('/library?tab=mine')}>
              Back to the Library
            </Button>
          }
        >
          {seen.current ? 'It was removed, maybe in another tab.' : 'Books you import stay on the device that imported them.'}
        </EmptyState>
      </Page>
    );
  }

  const structured = source.structure !== undefined || records.length > 0 || nothingFound;
  const recordOpen = state.view === 'review' && state.recordId !== null;
  const loading = stored === undefined || entries === null;

  return (
    <Page width="full" className={phone && recordOpen ? 'pt-3' : undefined}>
      {!(phone && recordOpen) && (
        <>
          <BookHeader
            source={source}
            counts={counts}
            structured={structured}
            unread={unread}
            recheck={recheck.length}
            detecting={detect !== null}
            onToggle={(enabled) => toggle(source, enabled)}
            onRead={() => setConsent({ kind: 'all' })}
            onDetect={() => void runDetect()}
            onRecheck={() => void runDetect()}
            onDownloadBookData={() => setBookData(true)}
            onDelete={() => setDeleting(true)}
          />
          <div className="mb-4 flex flex-col gap-2.5">
            {!source.enabled && (
              <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface-2 px-4 py-2.5 text-sm">
                <p className="min-w-0 flex-1">This book is switched off: accepted entries aren't used anywhere until you switch it on.</p>
                <Button size="sm" className={TOUCH} onClick={() => toggle(source, true)}>
                  Switch it on
                </Button>
              </div>
            )}
            {recheck.length > 0 && (
              <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-info/30 bg-info-soft/40 px-4 py-2.5 text-sm">
                <p className="min-w-0 flex-1">The offline reader improved: re-check {recheck.length} {recheck.length === 1 ? 'entry' : 'entries'} for free.</p>
                <Button size="sm" className={TOUCH} icon={<RefreshCw className="size-4" aria-hidden />} disabled={detect !== null} onClick={() => void runDetect()}>
                  Re-check
                </Button>
              </div>
            )}
            {problems.length > 0 && (
              <div className="flex gap-2.5 rounded-2xl border border-gold/40 bg-gold-soft/40 px-4 py-2.5 text-sm">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-gold" aria-hidden />
                <div>
                  <p className="font-medium">
                    {problems.length === 1 ? '1 option can’t be used yet.' : `${problems.length} options can’t be used yet.`}
                  </p>
                  <ul className="mt-0.5 text-muted">
                    {problems.map((p) => (
                      <li key={p.recordId}>
                        {p.name}: {p.message}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            {detect && (
              <div role="status" className="rounded-2xl border border-border bg-surface px-4 py-3">
                <p className="text-sm font-medium">Looking for spells, monsters and character options…</p>
                <ProgressBar className="mt-2" label="Looking through the book" value={detect.done} max={Math.max(1, detect.total)} valueText={`${detect.done} of ${detect.total}`} />
              </div>
            )}
            <StructureStatusCard
              source={source}
              jobs={jobs ?? []}
              runner={runner}
              records={records}
              sources={sources}
              availability={availability}
              onRetry={retry}
              onReview={() => state.set({ view: 'review', filter: 'review' })}
            />
            {structured && unread === 0 && records.length > 0 && counts.review > 0 && !records.some((r) => r.origin === 'claude') && (jobs ?? []).every((j) => j.sourceId !== source.id) && (
              <p className="text-sm text-muted">
                All {records.length} {records.length === 1 ? 'entry was' : 'entries were'} read on this device. Review them below.
              </p>
            )}
          </div>
          <Tabs
            value={state.view}
            onChange={(view) => state.set({ view, recordId: null })}
            className={`mb-4 ${TOUCH_BUTTONS}`}
            tabs={[
              { value: 'review', label: 'Review' },
              { value: 'entries', label: 'All entries' },
            ]}
          />
        </>
      )}
      <div role="tabpanel" aria-label={state.view === 'review' ? 'Review' : 'All entries'}>
        <ErrorBoundary label="The book page" resetKeys={[state.view, sourceId]}>
          {loading ? (
            <div className="flex items-center gap-3 py-10 text-sm text-muted">
              <LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" aria-hidden />
              Reading the book…
            </div>
          ) : !structured && state.view === 'review' ? (
            <EmptyState
              icon={<ScanSearch className="size-8" aria-hidden />}
              title="Not structured yet"
              action={
                <Button variant="primary" className={TOUCH} loading={detect !== null} onClick={() => void runDetect()}>
                  Structure this book
                </Button>
              }
            >
              The app looks through the book on this device, for free, and lists the spells, monsters, items and character options it finds for
              you to review. Nothing is sent anywhere.
            </EmptyState>
          ) : state.view === 'entries' ? (
            <AllEntriesView sourceId={source.id} entries={entries ?? []} records={records} onOpenRecord={(id) => state.set({ view: 'review', recordId: id, filter: 'all' })} />
          ) : (
            <ReviewWorkspace
              source={source}
              records={records}
              entriesById={entriesById}
              builder={builder}
              state={state}
              availability={availability}
              onReadWithClaude={readWithClaude}
              onRetry={retry}
              onAllEntries={() => state.set({ view: 'entries' })}
            />
          )}
        </ErrorBoundary>
      </div>

      <ConsentDialog
        open={consent !== null}
        onClose={() => setConsent(null)}
        source={source}
        records={records}
        jobs={jobs ?? []}
        sources={sources}
        scope={consent ?? { kind: 'all' }}
        availability={availability}
      />
      <BookDataDialog open={bookData} source={source} onClose={() => setBookData(false)} />
      <DeleteBookDialog source={deleting ? source : null} onClose={() => setDeleting(false)} onDeleted={() => navigate('/library?tab=mine', { replace: true })} />
      {switchDialog}
      {/* Outside the header and its cards: on phones they are off screen while a record is open. */}
      <StructureAnnouncer sourceId={source.id} jobs={jobs ?? []} />
      <UndoToast />
    </Page>
  );
}
