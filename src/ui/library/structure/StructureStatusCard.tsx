/**
 * The book page's structuring card (spec §4.7): progress while Claude reads (holds, the back-off, the
 * cache warning), pausing, every pause reason with its actions, waiting behind another book, and the
 * done line. A visually hidden status region announces progress at most every 15 s or 25 records.
 * Resuming spends money, so it only ever happens on the player's tap.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { CircleCheck, Hourglass, Pause, Play, Sparkles, Square, X } from 'lucide-react';
import { cancelJob, estimateJob, pauseJob, resumeJob, type RunnerSnapshot } from '@/dm';
import { cn } from '@/lib/cn';
import { MODELS, type CostEstimate, type ExtractionJob, type LibrarySource, type ModelId, type StructuredKind, type StructuredRecord } from '@/types';
import { ProgressBar } from '@/ui/components/ProgressBar';
import { toast } from '@/ui/components/toast';
import { Button, Dialog, Select } from '@/ui/components/ui';
import { errorMessage } from '@/ui/shell/format';
import { currentJob, filterOf, jobProgress, liveJobs, raisedBudget, remainingUsd, reviewCounts } from './bookData';
import { aboutUsd, usd } from './ConsentDialog';
import { KIND_LABELS, PAUSE_REASONS, modelName } from './labels';
import type { Availability } from './RecordDetail';
import { TOUCH, TOUCH_BUTTONS, TOUCH_FOOTER, TOUCH_SQUARE } from './touch';

const ANNOUNCE_MS = 15_000;
const ANNOUNCE_EVERY = 25;

function Card({ tone = 'neutral', children, className }: { tone?: 'neutral' | 'warn' | 'done'; children: ReactNode; className?: string }) {
  return (
    <section
      aria-label="Structuring"
      className={cn(
        'rounded-2xl border px-4 py-3',
        TOUCH_BUTTONS,
        tone === 'warn' ? 'border-gold/40 bg-gold-soft/40' : tone === 'done' ? 'border-success/30 bg-success-soft/40' : 'border-border bg-surface',
        className,
      )}
    >
      {children}
    </section>
  );
}

async function act(work: () => Promise<void>, fallback: string): Promise<void> {
  try {
    await work();
  } catch (error) {
    toast.error(errorMessage(error, fallback));
  }
}

/**
 * The kind a "format" pause names. Only the app-written start is read ("…the reading format for spells:
 * ‹API message›"): the API's own words can name a field such as classesText.
 */
export function pausedKind(message: string | undefined): StructuredKind | null {
  const named = message ? /reading format for ([^:]+?)\s*(?::|$)/i.exec(message)?.[1].trim().toLowerCase() : undefined;
  if (!named) return null;
  return (Object.keys(KIND_LABELS) as StructuredKind[]).find((k) => KIND_LABELS[k].many === named) ?? null;
}

/** Announce progress politely, at most every 15 s or every 25 records. */
function useThrottledAnnouncement(text: string, finished: number): string {
  const [said, setSaid] = useState(text);
  const last = useRef({ at: Date.now(), finished });
  useEffect(() => {
    const now = Date.now();
    if (now - last.current.at >= ANNOUNCE_MS || finished - last.current.finished >= ANNOUNCE_EVERY) {
      last.current = { at: now, finished };
      setSaid(text);
    }
  }, [text, finished]);
  return said;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export function JobProgress({
  job,
  runner,
  records,
  onPause,
  onCancel,
}: {
  job: ExtractionJob;
  runner: RunnerSnapshot;
  records: readonly StructuredRecord[];
  onPause(): void;
  onCancel(): void;
}) {
  const p = jobProgress(job);
  const mine = runner.activeJobId === job.id;
  const spent = mine ? runner.spentUsd : job.usage.estimatedCostUsd;
  const projected = mine && runner.projectedUsd > 0 ? runner.projectedUsd : job.estimate.usd;
  const reading = mine ? runner.inFlight.map((id) => records.find((r) => r.id === id)?.name).filter(Boolean) : [];
  const now = useNow(mine && runner.waitingUntil !== null);
  const wait = mine && runner.waitingUntil ? Math.max(0, Math.ceil((runner.waitingUntil - now) / 1000)) : 0;
  const pausing = job.status === 'pausing';
  const line = `Reading with ${modelName(job.model)} · ${p.finished} of ${p.total} · ${usd(spent)} so far · ${aboutUsd(projected)} in all${
    mine && runner.etaMinutes !== null ? ` · about ${Math.max(1, Math.round(runner.etaMinutes))} ${Math.round(runner.etaMinutes) === 1 ? 'minute' : 'minutes'} left` : ''
  }`;
  const announcement = useThrottledAnnouncement(`${p.finished} of ${p.total} read.`, p.finished);
  return (
    <Card>
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{pausing ? `Pausing… finishing ${p.inFlight} ${p.inFlight === 1 ? 'entry' : 'entries'} already being read.` : line}</p>
          {!pausing && reading.length > 0 && <p className="mt-0.5 truncate text-xs text-muted">Now reading: {reading.join(', ')}</p>}
          {mine && runner.hold === 'dm-turn' && <p className="mt-0.5 text-xs text-muted">Waiting while the DM replies.</p>}
          {mine && runner.hold === 'hidden' && <p className="mt-0.5 text-xs text-muted">Paused while this tab is in the background.</p>}
          {wait > 0 && <p className="mt-0.5 text-xs text-muted">Claude asked us to slow down. Continuing in {wait} s.</p>}
          {mine &&
            runner.cacheWarnings.map((k) => (
              <p key={k} className="mt-0.5 text-xs text-gold">
                Caching isn't working for {KIND_LABELS[k].many}; this may cost more than estimated.
              </p>
            ))}
          <p className="mt-0.5 text-xs text-muted">Review entries as they finish; nothing is used until you accept it.</p>
        </div>
        {!pausing && (
          <div className="flex shrink-0 gap-2">
            <Button size="sm" icon={<Pause className="size-4" aria-hidden />} onClick={onPause}>
              Pause
            </Button>
            <Button size="sm" variant="ghost" icon={<Square className="size-3.5" aria-hidden />} onClick={onCancel}>
              Cancel
            </Button>
          </div>
        )}
      </div>
      <ProgressBar
        className="mt-2.5 [&>div]:motion-reduce:transition-none"
        label="Structuring progress"
        value={p.finished}
        max={Math.max(1, p.total)}
        valueText={`${p.finished} of ${p.total} read`}
      />
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </Card>
  );
}

/** "Resume with…" starts at the next cheaper model, never a pricier one by default; else the cheapest other one. */
export function nextCheaperModel(current: ModelId): ModelId {
  const priceOf = (id: ModelId) => MODELS.find((m) => m.id === id)?.pricing.output ?? MODELS[0].pricing.output;
  const others = MODELS.filter((m) => m.id !== current);
  const cheaper = others.filter((m) => m.pricing.output < priceOf(current)).sort((a, b) => b.pricing.output - a.pricing.output);
  return (cheaper[0] ?? [...others].sort((a, b) => a.pricing.output - b.pricing.output)[0] ?? MODELS[0]).id;
}

/** About what the records still waiting would cost at a model (the consent's estimator); null until known. */
function useCostAt(job: ExtractionJob, recordIds: readonly string[], model: ModelId, active: boolean): CostEstimate | null {
  const [estimate, setEstimate] = useState<{ key: string; value: CostEstimate } | null>(null);
  const idsKey = recordIds.join('\u0000');
  const key = `${model}\u0000${idsKey}`;
  useEffect(() => {
    if (!active || !idsKey) return;
    let alive = true;
    estimateJob(job.sourceId, { claudeFor: 'selection', recordIds: idsKey.split('\u0000'), model, concurrency: job.concurrency }).then(
      (value) => alive && setEstimate({ key: `${model}\u0000${idsKey}`, value }),
      (error: unknown) => console.warn('[library] Could not estimate the rest at another model:', error),
    );
    return () => {
      alive = false;
    };
  }, [active, job.sourceId, job.concurrency, model, idsKey]);
  return active && estimate?.key === key ? estimate.value : null;
}

function ModelPicker({ value, onChange, exclude }: { value: ModelId; onChange(m: ModelId): void; exclude?: ModelId }) {
  return (
    <Select aria-label="Model" value={value} className={cn('h-8 w-auto text-sm', TOUCH)} onChange={(e) => onChange(e.target.value)}>
      {MODELS.filter((m) => m.id !== exclude).map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
    </Select>
  );
}

export function PausedCard({
  job,
  availability,
  queuedIds = [],
  onResume,
  onCancel,
}: {
  job: ExtractionJob;
  availability: Availability;
  /** The job's records still waiting to be read (priced at the model picked for "Resume with this model"). */
  queuedIds?: readonly string[];
  onResume(patch?: { budgetUsd?: number | null; model?: ModelId; skipKinds?: StructuredKind[] }): void;
  onCancel(): void;
}) {
  const p = jobProgress(job);
  const spent = job.usage.estimatedCostUsd;
  const more = remainingUsd(job);
  const left = `${p.left} ${p.left === 1 ? 'entry' : 'entries'} left, ${aboutUsd(more)} more`;
  const others = MODELS.filter((m) => m.id !== job.model);
  const [model, setModel] = useState<ModelId>(() => nextCheaperModel(job.model));
  const can = availability.ok;
  const switching = job.pauseReason === 'rate-limit' || job.pauseReason === 'model';
  const atModel = useCostAt(job, queuedIds, model, switching && can);
  const priceAtModel = atModel ? (
    <span className="text-xs text-muted tabular-nums">
      {aboutUsd(atModel.usd)} for the {p.left} left
    </span>
  ) : null;
  const resume = (patch?: Parameters<typeof onResume>[0], label = 'Resume') => (
    <Button size="sm" variant="primary" disabled={!can} icon={<Play className="size-4" aria-hidden />} onClick={() => onResume(patch)}>
      {label}
    </Button>
  );
  const stop = (
    <Button size="sm" variant="ghost" icon={<Square className="size-3.5" aria-hidden />} onClick={onCancel}>
      Stop here
    </Button>
  );
  let text: ReactNode;
  let actions: ReactNode;
  switch (job.pauseReason) {
    case 'budget': {
      const raised = raisedBudget(job);
      text = `Paused at your ${usd(job.budgetUsd ?? 0).replace('.00', '')} limit. ${usd(spent)} spent · ${p.left} left, ${aboutUsd(more)} more.`;
      actions = (
        <>
          {resume({ budgetUsd: raised }, `Raise the limit to $${raised} and resume`)}
          {can && (
            <Button size="sm" onClick={() => onResume({ budgetUsd: null })}>
              Resume without a limit
            </Button>
          )}
          {stop}
        </>
      );
      break;
    }
    case 'reload':
      text = `Paused when the page closed.${
        job.interrupted > 0
          ? ` ${job.interrupted} ${job.interrupted === 1 ? 'entry that was' : 'entries that were'} being read ${job.interrupted === 1 ? 'was' : 'were'} lost; ${job.interrupted === 1 ? 'its' : 'their'} cost isn't counted.`
          : ''
      } ${left}.`;
      actions = (
        <>
          {resume()}
          {stop}
        </>
      );
      break;
    case 'offline':
      text = "You're offline. Structuring continues when you're back online.";
      actions = stop;
      break;
    case 'rate-limit':
      text = 'Claude kept asking us to slow down.';
      actions = (
        <>
          {resume()}
          {can && others.length > 0 && (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <ModelPicker value={model} onChange={setModel} exclude={job.model} />
              <Button size="sm" onClick={() => onResume({ model })}>
                Resume with this model
              </Button>
              {priceAtModel}
            </span>
          )}
          {stop}
        </>
      );
      break;
    case 'auth':
      text = job.pauseMessage || 'Claude rejected your API key. Fix it in Settings, then resume.';
      actions = (
        <>
          <Link to="/settings" className="inline-flex h-8 items-center rounded-lg border border-border bg-surface-2 px-3 text-sm font-medium hover:bg-surface-3">
            Open Settings
          </Link>
          {resume()}
        </>
      );
      break;
    case 'model':
      text = (
        <>
          Your key can't use {modelName(job.model)}.{job.pauseMessage ? ` ${job.pauseMessage}` : ''}
        </>
      );
      actions = (
        <>
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <ModelPicker value={model} onChange={setModel} exclude={job.model} />
            <Button size="sm" variant="primary" disabled={!can} onClick={() => onResume({ model })}>
              Resume with this model
            </Button>
            {priceAtModel}
          </span>
          {stop}
        </>
      );
      break;
    case 'format': {
      const kind = pausedKind(job.pauseMessage);
      text = job.pauseMessage || "Claude couldn't use the reading format for one kind of entry.";
      actions = (
        <>
          {kind ? resume({ skipKinds: [kind] }, `Skip ${KIND_LABELS[kind].many} and resume`) : resume()}
          {stop}
        </>
      );
      break;
    }
    case 'storage':
      text = 'This browser is out of storage space for Solo DM. Free some space, then resume.';
      actions = resume();
      break;
    case 'other-tab':
      text = 'Structuring is running in another tab.';
      actions = null;
      break;
    default:
      text = `Paused. ${usd(spent)} spent · ${left}.`;
      actions = (
        <>
          {resume()}
          <Button size="sm" variant="ghost" icon={<Square className="size-3.5" aria-hidden />} onClick={onCancel}>
            Cancel
          </Button>
        </>
      );
  }
  return (
    <Card tone={job.pauseReason && job.pauseReason !== 'player' ? 'warn' : 'neutral'}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">{text}</p>
          {!can && <p className="mt-0.5 text-xs text-muted">{availability.ok ? '' : availability.message}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </Card>
  );
}

export function QueuedCard({ job, jobs, sources, onCancel }: { job: ExtractionJob; jobs: readonly ExtractionJob[]; sources: readonly LibrarySource[]; onCancel(): void }) {
  const running = jobs.find((j) => j.id !== job.id && (j.status === 'running' || j.status === 'pausing'));
  const title = running ? (sources.find((s) => s.id === running.sourceId)?.title ?? 'another book') : null;
  const p = running ? jobProgress(running) : null;
  const text = !running || !p ? 'Waiting to start.' : running.sourceId === job.sourceId ? `Waiting for this book's current reading to finish (${p.finished}/${p.total}).` : `Waiting for “${title}” to finish (${p.finished}/${p.total}).`;
  return (
    <Card>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="inline-flex items-center gap-2 text-sm font-medium">
          <Hourglass className="size-4 text-muted" aria-hidden />
          {text}
        </p>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

const DISMISSED = (jobId: string) => `solo-dm:structure-done:${jobId}`;
function readDismissed(jobId: string): boolean {
  try {
    return window.localStorage.getItem(DISMISSED(jobId)) === '1';
  } catch {
    return false;
  }
}

export function DoneCard({
  source,
  job,
  records,
  onRetry,
  onReview,
}: {
  source: LibrarySource;
  job: ExtractionJob;
  records: readonly StructuredRecord[];
  onRetry(ids: string[]): void;
  onReview(): void;
}) {
  const [hidden, setHidden] = useState(() => readDismissed(job.id));
  if (hidden) return null;
  const p = jobProgress(job);
  const counts = reviewCounts(records, source.enabled);
  // The job's reads still listed under "Couldn't read": not those since kept as text or accepted as they are.
  const retry = records.filter((r) => r.jobId === job.id && filterOf(r, source.enabled) === 'failed').map((r) => r.id);
  const options = records.some((r) => r.status === 'accepted' && (r.kind === 'class' || r.kind === 'subclass' || r.kind === 'species' || r.kind === 'background' || r.kind === 'feat'));
  const settled = counts.review === 0 && counts.fix === 0 && counts.failed === 0 && counts.unread === 0;
  const text =
    job.status === 'cancelled'
      ? `Stopped: ${p.finished} read, ${job.counts.skipped} not read.`
      : settled
        ? `All set: ${counts.used} in use${counts.text ? `, ${counts.text} kept as text` : ''}.`
        : `Done: ${p.finished} read. ${counts.review} to review${retry.length ? `, ${retry.length} couldn't be read` : ''}.`;
  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISSED(job.id), '1');
    } catch {
      // Storage blocked: hide it for now.
    }
    // The card (and its focused button) goes: focus the page's main content, not the page body.
    document.getElementById('main')?.focus({ preventScroll: true });
    setHidden(true);
  };
  return (
    <Card tone="done" className="py-2">
      <div className="flex flex-wrap items-center gap-2">
        <CircleCheck className="size-4 shrink-0 text-success" aria-hidden />
        <p className="min-w-0 flex-1 text-sm font-medium">{text}</p>
        {counts.review > 0 && (
          <Button size="sm" onClick={onReview}>
            Review now
          </Button>
        )}
        {retry.length > 0 && (
          <Button size="sm" icon={<Sparkles className="size-3.5" aria-hidden />} onClick={() => onRetry(retry)}>
            Retry {retry.length}
          </Button>
        )}
        {options && (
          <Link to="/new" className="inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium text-accent hover:bg-surface-2">
            Open the character builder
          </Link>
        )}
        <button type="button" aria-label="Hide this" onClick={dismiss} className={cn('grid size-8 place-items-center rounded-lg text-faint hover:text-text', TOUCH_SQUARE)}>
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </Card>
  );
}

/** What a job's latest state means, for screen readers (spec §4.9; WCAG 4.1.3 status messages). */
export function jobStatusLine(job: ExtractionJob): string {
  const p = jobProgress(job);
  const missed = p.failed + p.refused;
  switch (job.status) {
    case 'paused':
      return job.pauseReason === 'budget'
        ? `Structuring paused at your ${usd(job.budgetUsd ?? 0).replace('.00', '')} limit.`
        : `Structuring paused: ${PAUSE_REASONS[job.pauseReason ?? 'player']}.`;
    case 'done':
      return `Structuring finished: ${p.finished} read${missed ? `, ${missed} couldn't be read` : ''}.`;
    case 'cancelled':
      return `Structuring stopped: ${p.finished} read.`;
    case 'queued':
      return 'Structuring is waiting for another reading to finish.';
    default:
      return `Claude is reading: ${p.finished} of ${p.total} read.`;
  }
}

/** The states whose card swaps in with nothing else said: a pause (often a decision), the end, a stop. */
const ANNOUNCED: ReadonlySet<ExtractionJob['status']> = new Set(['paused', 'done', 'cancelled']);

/**
 * One persistent, visually hidden status line for the book's jobs. The cards swap (and on phones are
 * off screen while a record is open), so this lives outside them and says when a job pauses, finishes
 * or stops. Nothing is said on first render: only changes are news.
 */
export function StructureAnnouncer({ sourceId, jobs }: { sourceId: string; jobs: readonly ExtractionJob[] }) {
  const [said, setSaid] = useState('');
  const seen = useRef<Map<string, string> | null>(null);
  const mine = useMemo(() => jobs.filter((j) => j.sourceId === sourceId), [jobs, sourceId]);
  useEffect(() => {
    const now = new Map(mine.map((j) => [j.id, `${j.status}\u0000${j.pauseReason ?? ''}`]));
    const before = seen.current;
    seen.current = now;
    if (!before) return;
    const news = mine.filter((j) => before.has(j.id) && before.get(j.id) !== now.get(j.id) && ANNOUNCED.has(j.status));
    if (news.length === 0) return;
    // Cleared first, so the same words twice in a row are still announced.
    setSaid('');
    const timer = window.setTimeout(() => setSaid(news.map(jobStatusLine).join(' ')), 30);
    return () => window.clearTimeout(timer);
  }, [mine]);
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {said}
    </p>
  );
}

export function StructureStatusCard({
  source,
  jobs,
  runner,
  records,
  sources,
  availability,
  onRetry,
  onReview,
}: {
  source: LibrarySource;
  jobs: readonly ExtractionJob[];
  runner: RunnerSnapshot;
  records: readonly StructuredRecord[];
  sources: readonly LibrarySource[];
  availability: Availability;
  onRetry(jobId: string, ids: string[]): void;
  onReview(): void;
}) {
  // Every unfinished job of the book gets its card, the one being read first: a newer job waiting
  // behind it never hides the Pause and Cancel of the one spending money.
  const live = liveJobs(jobs, source.id);
  const { last } = currentJob(jobs, source.id);
  const [confirmCancel, setConfirmCancel] = useState<ExtractionJob | null>(null);
  const cancel = (job: ExtractionJob) => void act(() => cancelJob(job.id), 'Could not stop it.');
  const inFlight = confirmCancel ? jobProgress(confirmCancel).inFlight : 0;

  const cardFor = (job: ExtractionJob): ReactNode => {
    const resume = (patch?: { budgetUsd?: number | null; model?: ModelId; skipKinds?: StructuredKind[] }) =>
      void act(() => resumeJob(job.id, patch), 'Could not resume.');
    switch (job.status) {
      case 'running':
      case 'pausing':
        return <JobProgress key={job.id} job={job} runner={runner} records={records} onPause={() => void act(() => pauseJob(job.id), 'Could not pause.')} onCancel={() => setConfirmCancel(job)} />;
      case 'paused': {
        const queuedIds = records.filter((r) => r.jobId === job.id && r.runState === 'queued').map((r) => r.id);
        return <PausedCard key={job.id} job={job} availability={availability} queuedIds={queuedIds} onResume={resume} onCancel={() => cancel(job)} />;
      }
      case 'queued':
        return <QueuedCard key={job.id} job={job} jobs={jobs} sources={sources} onCancel={() => cancel(job)} />;
      default:
        return null;
    }
  };

  const cards: ReactNode =
    live.length > 0
      ? live.map(cardFor)
      : last && (last.status === 'done' || last.status === 'cancelled')
        ? <DoneCard key={last.id} source={source} job={last} records={records} onRetry={(ids) => onRetry(last.id, ids)} onReview={onReview} />
        : null;
  return (
    <>
      {cards}
      <Dialog
        open={confirmCancel !== null}
        onClose={() => setConfirmCancel(null)}
        size="sm"
        title="Stop now?"
        footer={
          <div className={TOUCH_FOOTER}>
            <Button variant="ghost" onClick={() => setConfirmCancel(null)}>
              Keep reading
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirmCancel) cancel(confirmCancel);
                setConfirmCancel(null);
              }}
            >
              Stop
            </Button>
          </div>
        }
      >
        <p className="text-sm">
          {inFlight > 0
            ? `${inFlight} ${inFlight === 1 ? 'entry' : 'entries'} being read will be stopped, and you may still be charged for ${inFlight === 1 ? 'it' : 'them'}. `
            : ''}
          Everything already read is kept.
        </p>
      </Dialog>
    </>
  );
}
