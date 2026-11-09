/**
 * The book page's structuring card (spec §4.7): progress while Claude reads (holds, the back-off, the
 * cache warning), pausing, every pause reason with its actions, waiting behind another book, and the
 * done line. A visually hidden status region announces progress at most every 15 s or 25 records.
 * Resuming spends money, so it only ever happens on the player's tap.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { CircleCheck, Hourglass, Pause, Play, Sparkles, Square, X } from 'lucide-react';
import { cancelJob, pauseJob, resumeJob, type RunnerSnapshot } from '@/dm';
import { cn } from '@/lib/cn';
import { MODELS, type ExtractionJob, type LibrarySource, type ModelId, type StructuredKind, type StructuredRecord } from '@/types';
import { ProgressBar } from '@/ui/components/ProgressBar';
import { toast } from '@/ui/components/toast';
import { Button, Dialog, Select } from '@/ui/components/ui';
import { errorMessage } from '@/ui/shell/format';
import { currentJob, jobProgress, raisedBudget, remainingUsd, reviewCounts } from './bookData';
import { aboutUsd, usd } from './ConsentDialog';
import { KIND_LABELS, modelName } from './labels';
import type { Availability } from './RecordDetail';

const ANNOUNCE_MS = 15_000;
const ANNOUNCE_EVERY = 25;

function Card({ tone = 'neutral', children, className }: { tone?: 'neutral' | 'warn' | 'done'; children: ReactNode; className?: string }) {
  return (
    <section
      aria-label="Structuring"
      className={cn(
        'rounded-2xl border px-4 py-3',
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

/** The kind a "format" pause names ("…the reading format for spells: …"). */
export function pausedKind(message: string | undefined): StructuredKind | null {
  if (!message) return null;
  const lower = message.toLowerCase();
  const kinds = (Object.keys(KIND_LABELS) as StructuredKind[]).sort((a, b) => KIND_LABELS[b].many.length - KIND_LABELS[a].many.length);
  return kinds.find((k) => lower.includes(KIND_LABELS[k].many)) ?? null;
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

function ModelPicker({ value, onChange, exclude }: { value: ModelId; onChange(m: ModelId): void; exclude?: ModelId }) {
  return (
    <Select aria-label="Model" value={value} className="h-8 w-auto text-sm" onChange={(e) => onChange(e.target.value)}>
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
  onResume,
  onCancel,
}: {
  job: ExtractionJob;
  availability: Availability;
  onResume(patch?: { budgetUsd?: number | null; model?: ModelId; skipKinds?: StructuredKind[] }): void;
  onCancel(): void;
}) {
  const p = jobProgress(job);
  const spent = job.usage.estimatedCostUsd;
  const more = remainingUsd(job);
  const left = `${p.left} ${p.left === 1 ? 'entry' : 'entries'} left, ${aboutUsd(more)} more`;
  const others = MODELS.filter((m) => m.id !== job.model);
  const [model, setModel] = useState<ModelId>(others[0]?.id ?? job.model);
  const can = availability.ok;
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
            <span className="inline-flex items-center gap-1.5">
              <ModelPicker value={model} onChange={setModel} exclude={job.model} />
              <Button size="sm" onClick={() => onResume({ model })}>
                Resume with this model
              </Button>
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
          <span className="inline-flex items-center gap-1.5">
            <ModelPicker value={model} onChange={setModel} exclude={job.model} />
            <Button size="sm" variant="primary" disabled={!can} onClick={() => onResume({ model })}>
              Resume with this model
            </Button>
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
  return (
    <Card>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="inline-flex items-center gap-2 text-sm font-medium">
          <Hourglass className="size-4 text-muted" aria-hidden />
          {title && p ? `Waiting for “${title}” to finish (${p.finished}/${p.total}).` : 'Waiting to start.'}
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
  const retry = records.filter((r) => r.jobId === job.id && (r.runState === 'failed' || r.runState === 'refused')).map((r) => r.id);
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
        <button type="button" aria-label="Hide this" onClick={dismiss} className="grid size-8 place-items-center rounded-lg text-faint hover:text-text">
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </Card>
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
  const { live, last } = currentJob(jobs, source.id);
  const [confirmCancel, setConfirmCancel] = useState<ExtractionJob | null>(null);
  const job = live ?? last;
  if (!job) return null;
  const pause = () => void act(() => pauseJob(job.id), 'Could not pause.');
  const resume = (patch?: { budgetUsd?: number | null; model?: ModelId; skipKinds?: StructuredKind[] }) =>
    void act(() => resumeJob(job.id, patch), 'Could not resume.');
  const cancel = () => void act(() => cancelJob(job.id), 'Could not stop it.');
  const inFlight = jobProgress(job).inFlight;

  let card: ReactNode = null;
  if (live?.status === 'running' || live?.status === 'pausing') {
    card = <JobProgress job={live} runner={runner} records={records} onPause={pause} onCancel={() => setConfirmCancel(live)} />;
  } else if (live?.status === 'paused') {
    card = <PausedCard job={live} availability={availability} onResume={resume} onCancel={cancel} />;
  } else if (live?.status === 'queued') {
    card = <QueuedCard job={live} jobs={jobs} sources={sources} onCancel={cancel} />;
  } else if (last && (last.status === 'done' || last.status === 'cancelled')) {
    card = <DoneCard source={source} job={last} records={records} onRetry={(ids) => onRetry(last.id, ids)} onReview={onReview} />;
  }
  return (
    <>
      {card}
      <Dialog
        open={confirmCancel !== null}
        onClose={() => setConfirmCancel(null)}
        size="sm"
        title="Stop now?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmCancel(null)}>
              Keep reading
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmCancel(null);
                cancel();
              }}
            >
              Stop
            </Button>
          </>
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
