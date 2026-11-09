/**
 * The status line of a book on My library (spec §4.7): "Not structured yet · [Structure this book]",
 * "508 found · 41 to review · 149 not read yet", a mini progress line with [Pause] while Claude reads,
 * "Paused: ‹reason›" with [Resume], or "Switched off: accepted entries aren't used". Counts come from
 * the source row (denormalized), so the list never loads records. The job API is loaded on demand:
 * a Library visit doesn't load the DM code.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Pause, Play, ScanSearch } from 'lucide-react';
import { detectStructure } from '@/data';
import type { ExtractionJob, LibrarySource, PauseReason } from '@/types';
import { toast } from '@/ui/components/toast';
import { Button } from '@/ui/components/ui';
import { errorMessage } from '@/ui/shell/format';
import { ButtonLink } from '@/ui/components/ButtonLink';
import { currentJob, jobProgress } from './bookData';
import { PAUSE_REASONS } from './labels';
import { refreshRulesIndex } from '../kinds';
import { TOUCH_BUTTONS } from './touch';

/** Pauses that need a decision the row can't offer (raise the limit, pick another model, skip a kind): the book page has them. */
const DECIDE_ON_BOOK_PAGE = new Set<PauseReason>(['budget', 'model', 'format']);

/** "508 found · 41 to review · 149 not read yet" from the source row's counts. */
export function structureLine(source: LibrarySource): string | null {
  const s = source.structure;
  if (!s) return null;
  let found = 0;
  let pending = 0;
  for (const c of Object.values(s.counts)) {
    if (!c) continue;
    found += c.pending + c.accepted + c.rejected;
    pending += c.pending;
  }
  const review = Math.max(0, pending - s.needsClaude);
  // Detection ran and found nothing (an empty structure): say so, not "Not structured yet" or "0 found".
  if (found === 0) return 'Nothing found to structure';
  return [`${found} found`, review ? `${review} to review` : null, s.needsClaude ? `${s.needsClaude} not read yet` : null].filter(Boolean).join(' · ');
}

export function SourceRowStatus({ source, jobs }: { source: LibrarySource; jobs: readonly ExtractionJob[] }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const { live } = currentJob(jobs, source.id);
  const book = `/library/source/${encodeURIComponent(source.id)}`;

  const run = async (work: () => Promise<void>, fallback: string) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      toast.error(errorMessage(error, fallback));
    } finally {
      setBusy(false);
    }
  };

  const structure = () =>
    run(async () => {
      const summary = await detectStructure(source.id);
      refreshRulesIndex();
      navigate(`${book}${summary.needClaude > 0 ? '?setup=1' : ''}`);
    }, 'Could not look through the book.');

  let line: React.ReactNode;
  if (live && (live.status === 'running' || live.status === 'pausing')) {
    const p = jobProgress(live);
    line = (
      <>
        <span>{live.status === 'pausing' ? 'Pausing…' : `Claude is reading: ${p.finished} of ${p.total}`}</span>
        {live.status === 'running' && (
          <Button size="sm" variant="ghost" disabled={busy} icon={<Pause className="size-3.5" aria-hidden />} onClick={() => void run(async () => (await import('@/dm')).pauseJob(live.id), 'Could not pause.')}>
            Pause
          </Button>
        )}
      </>
    );
  } else if (live?.status === 'paused') {
    const reason = live.pauseReason ?? 'player';
    line = (
      <>
        <span>Paused: {PAUSE_REASONS[reason]}</span>
        {DECIDE_ON_BOOK_PAGE.has(reason) ? (
          // Resuming as it is would pause again at once (the limit) or resend the same failing request.
          <ButtonLink to={book} size="sm" variant="ghost" icon={<Play className="size-3.5" aria-hidden />}>
            Resume on the book page
          </ButtonLink>
        ) : reason !== 'other-tab' && reason !== 'offline' && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            icon={<Play className="size-3.5" aria-hidden />}
            onClick={() =>
              void run(async () => {
                const dm = await import('@/dm');
                const available = dm.extractionAvailability();
                if (!available.ok) throw new Error(available.message);
                await dm.resumeJob(live.id);
              }, 'Could not resume.')
            }
          >
            Resume
          </Button>
        )}
      </>
    );
  } else if (live?.status === 'queued') {
    line = <span>Waiting for another book to finish</span>;
  } else if (!source.structure) {
    line = (
      <>
        <span>Not structured yet</span>
        <Button size="sm" variant="ghost" loading={busy} icon={<ScanSearch className="size-3.5" aria-hidden />} onClick={() => void structure()}>
          Structure this book
        </Button>
      </>
    );
  } else {
    line = <span>{structureLine(source)}</span>;
  }
  return (
    <div className="mt-1 flex flex-col gap-0.5 text-xs text-muted">
      <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${TOUCH_BUTTONS}`}>{line}</div>
      {!source.enabled && <p>Switched off: accepted entries aren't used</p>}
    </div>
  );
}
