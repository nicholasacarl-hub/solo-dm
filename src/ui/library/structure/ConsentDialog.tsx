/**
 * Before anything is sent (spec §4.7, D13): what to read, three models with their estimates (the
 * Settings model first), the spending limit (default: the high estimate rounded up, at least $1),
 * what leaves the device, and the lifetime spend on structuring. Nothing is sent before Start. In demo
 * mode or without a key it explains why and offers Settings instead; while another book is being
 * structured, Start becomes "Queue it".
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { Info, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router';
import { estimateModels, retryRecords, startJob, type JobChoices } from '@/dm';
import { cn } from '@/lib/cn';
import { useSettings } from '@/state/settingsStore';
import { structuringSpendUsd } from '@/storage';
import { MODELS, type CostEstimate, type ExtractionJob, type LibrarySource, type ModelId, type StructuredKind, type StructuredRecord, STRUCTURED_KINDS } from '@/types';
import { OptionCards } from '@/ui/components/OptionCards';
import { toast } from '@/ui/components/toast';
import { Button, Dialog, Input, Select } from '@/ui/components/ui';
import { errorMessage } from '@/ui/shell/format';
import { defaultBudget, isBeingRead } from './bookData';
import { KIND_LABELS, PRIVACY_PROMISES, modelName } from './labels';
import type { Availability } from './RecordDetail';
import { TOUCH, TOUCH_FORM } from './touch';

export type ConsentScope =
  | { kind: 'all' }
  | { kind: 'ids'; ids: string[]; title: string; model?: ModelId; retryJobId?: string };

/** "$3.20", "<$0.01". */
export function usd(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

/** An estimate in words: "about $3.20 ($1.92–$5.12)", or "under $0.01" for a few cheap entries. */
export function priceText(e: Pick<CostEstimate, 'usd' | 'usdLow' | 'usdHigh'>): string {
  if (e.usdHigh < 0.01) return 'under $0.01';
  if (e.usd < 0.01) return `under $0.01 (up to ${usd(e.usdHigh)})`;
  return `about ${usd(e.usd)} (${usd(e.usdLow)}–${usd(e.usdHigh)})`;
}

/** "about $3.20", "under $0.01". */
export const aboutUsd = (n: number): string => (n < 0.01 ? 'under $0.01' : `about ${usd(n)}`);

export function minutesText(e: Pick<CostEstimate, 'minutesLow' | 'minutesHigh'>): string {
  const lo = Math.max(1, Math.round(e.minutesLow));
  const hi = Math.max(lo, Math.round(e.minutesHigh));
  return lo === hi ? `About ${lo} ${lo === 1 ? 'minute' : 'minutes'}.` : `About ${lo} to ${hi} minutes.`;
}

const BLURB: Readonly<Record<string, string>> = {
  'claude-opus-5-5': 'The most careful reader.',
  'claude-sonnet-5-5': 'Nearly as careful, half the price.',
  'claude-haiku-5-5': 'Cheapest. Check its readings more closely.',
};

/**
 * Records the offline reader couldn't read (what "the rest" means; the job planner's "misses"). Callers
 * pass reviewable() records, so a gear table whose rows were read is already left out; an unread table
 * still needs Claude.
 */
export const needsClaude = (r: StructuredRecord): boolean => r.data === null && r.status !== 'rejected' && !isBeingRead(r);
/** Records read on this device that "Also re-read" would send. */
export const readHere = (r: StructuredRecord): boolean => r.data !== null && r.origin === 'parser' && r.status !== 'rejected' && !isBeingRead(r);

function KindChoice({
  counts,
  value,
  onChange,
}: {
  counts: Partial<Record<StructuredKind, number>>;
  value: StructuredKind[];
  onChange(v: StructuredKind[]): void;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="text-sm font-medium">What to read</legend>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
        {STRUCTURED_KINDS.map((k) => {
          const n = counts[k] ?? 0;
          return (
            <label key={k} className={cn('flex min-h-10 cursor-pointer items-center gap-2 text-sm has-[:disabled]:cursor-not-allowed has-[:disabled]:text-faint', TOUCH)}>
              <input
                type="checkbox"
                disabled={n === 0}
                checked={n > 0 && value.includes(k)}
                onChange={(e) => onChange(e.target.checked ? STRUCTURED_KINDS.filter((x) => x === k || value.includes(x)) : value.filter((x) => x !== k))}
                className="size-4 accent-[var(--accent)]"
              />
              <span>
                {KIND_LABELS[k].titleMany} <span className="text-muted tabular-nums">{n === 0 ? 'none found' : n}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function ModelChoice({
  estimates,
  settingsModel,
  value,
  onChange,
}: {
  estimates: readonly CostEstimate[];
  settingsModel: ModelId;
  value: ModelId;
  onChange(m: ModelId): void;
}) {
  return (
    <OptionCards
      legend="Model"
      value={value}
      onChange={onChange}
      options={estimates.map((e) => {
        const known = MODELS.some((m) => m.id === e.model);
        return {
          value: e.model,
          // Spaces as their own text nodes: the label, price and blurb are read as one name.
          label: (
            <>
              {modelName(e.model)}
              {e.model === settingsModel && (
                <>
                  {' '}
                  <span className="font-normal text-muted">· your Settings model</span>
                </>
              )}{' '}
            </>
          ),
          aside: (
            <>
              <span className="text-xs text-muted tabular-nums">{priceText(e)}</span>{' '}
            </>
          ),
          description: `${known ? (BLURB[e.model] ?? '') : 'Price unknown — estimated at Opus rates.'} ${minutesText(e)}`.trim(),
        };
      })}
    />
  );
}

function BudgetField({ value, suggested, onChange }: { value: number | null; suggested: number; onChange(v: number | null): void }) {
  const id = useId();
  // The player's typing while the field has focus; otherwise the field shows the limit (it follows a new suggestion).
  const [typing, setTyping] = useState<string | null>(null);
  const text = typing ?? (value === null ? '' : String(value));
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${id}-limit`} className="text-sm font-medium">
        Spending limit
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-28">
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted">$</span>
          <Input
            id={`${id}-limit`}
            inputMode="decimal"
            className="pl-6 tabular-nums"
            disabled={value === null}
            aria-describedby={`${id}-hint`}
            value={text}
            onChange={(e) => {
              setTyping(e.target.value);
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n > 0) onChange(n);
            }}
            onBlur={() => setTyping(null)}
          />
        </div>
        <label className={cn('flex min-h-10 cursor-pointer items-center gap-2 text-sm', TOUCH)}>
          <input type="checkbox" checked={value === null} onChange={(e) => onChange(e.target.checked ? null : suggested)} className="size-4 accent-[var(--accent)]" />
          No limit
        </label>
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted">
        Structuring pauses before it would pass this.
      </p>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 rounded-xl bg-surface-2 px-3 py-2.5 text-xs text-muted">
      <Info className="mt-0.5 size-3.5 shrink-0 text-info" aria-hidden />
      <div>{children}</div>
    </div>
  );
}

export function ConsentDialog({
  open,
  onClose,
  source,
  records,
  jobs,
  sources,
  scope,
  availability,
}: {
  open: boolean;
  onClose(): void;
  source: LibrarySource;
  records: readonly StructuredRecord[];
  /** Every job (to tell whether another book is being structured). */
  jobs: readonly ExtractionJob[];
  sources: readonly LibrarySource[];
  scope: ConsentScope;
  availability: Availability;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={consentTitle(scope, records)}
      description={scope.kind === 'all' ? `Turn the rest of “${source.title}” into options for the builder, combat and spell lists. You check everything before it's used.` : 'You check what Claude reads before it is used.'}
    >
      {open && <ConsentBody source={source} records={records} jobs={jobs} sources={sources} scope={scope} availability={availability} onClose={onClose} />}
    </Dialog>
  );
}

function consentTitle(scope: ConsentScope, records: readonly StructuredRecord[]): string {
  if (scope.kind === 'ids') return scope.ids.length === 1 ? `Read “${scope.title}” with Claude` : `Read ${scope.ids.length} entries with Claude`;
  const n = records.filter(needsClaude).length;
  return `Read ${n} ${n === 1 ? 'entry' : 'entries'} with Claude`;
}

function ConsentBody({
  source,
  records,
  jobs,
  sources,
  scope,
  availability,
  onClose,
}: {
  source: LibrarySource;
  records: readonly StructuredRecord[];
  jobs: readonly ExtractionJob[];
  sources: readonly LibrarySource[];
  scope: ConsentScope;
  availability: Availability;
  onClose(): void;
}) {
  const navigate = useNavigate();
  const settingsModel = useSettings((s) => s.model);
  const misses = useMemo(() => records.filter(needsClaude), [records]);
  const here = useMemo(() => records.filter(readHere), [records]);
  const counts = useMemo(() => {
    const c: Partial<Record<StructuredKind, number>> = {};
    for (const r of misses) c[r.kind] = (c[r.kind] ?? 0) + 1;
    return c;
  }, [misses]);
  const [kinds, setKinds] = useState<StructuredKind[]>(() => STRUCTURED_KINDS.filter((k) => (counts[k] ?? 0) > 0));
  const [alsoReread, setAlsoReread] = useState(false);
  const [model, setModel] = useState<ModelId>(scope.kind === 'ids' && scope.model ? scope.model : settingsModel);
  const [concurrency, setConcurrency] = useState<1 | 2 | 3 | 4>(3);
  const [budget, setBudget] = useState<number | null | 'default'>('default');
  const [estimates, setEstimates] = useState<CostEstimate[] | null>(null);
  const [allEstimates, setAllEstimates] = useState<CostEstimate[] | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [spent, setSpent] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);

  const choices = useMemo((): Omit<JobChoices, 'model'> => {
    if (scope.kind === 'ids') return { claudeFor: 'selection', recordIds: scope.ids, concurrency };
    return { claudeFor: alsoReread ? 'all' : 'misses', kinds, concurrency };
  }, [scope, alsoReread, kinds, concurrency]);

  // Estimates recompute as the kinds, the model list or "also re-read" change (pure on E2's side).
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      const base = scope.kind === 'ids' ? choices : { ...choices, claudeFor: 'misses' as const };
      Promise.all([
        estimateModels(source.id, base),
        scope.kind === 'all' && here.length > 0 ? estimateModels(source.id, { ...base, claudeFor: 'all' }) : Promise.resolve(null),
      ]).then(
        ([misses, all]) => {
          if (!alive) return;
          setEstimates(misses);
          setAllEstimates(all);
          setEstimateError(null);
        },
        (error: unknown) => {
          if (alive) setEstimateError(errorMessage(error, 'The cost couldn’t be estimated.'));
        },
      );
    }, 120);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [source.id, scope, choices, here.length]);

  useEffect(() => {
    let alive = true;
    structuringSpendUsd().then(
      (n) => alive && setSpent(n),
      () => alive && setSpent(null),
    );
    return () => {
      alive = false;
    };
  }, []);

  const shown = alsoReread && allEstimates ? allEstimates : estimates;
  const chosen = shown?.find((e) => e.model === model) ?? shown?.[0];
  const missesFor = (m: ModelId) => estimates?.find((e) => e.model === m);
  const extra = allEstimates?.find((e) => e.model === (chosen?.model ?? model));
  const extraUsd = extra && missesFor(extra.model) ? Math.max(0, extra.usd - (missesFor(extra.model)?.usd ?? 0)) : null;
  const suggested = defaultBudget(chosen?.usdHigh ?? 0);
  const limit = budget === 'default' ? suggested : budget;
  const elsewhere = jobs.find((j) => j.sourceId !== source.id && (j.status === 'running' || j.status === 'pausing' || j.status === 'queued'));
  const elsewhereTitle = elsewhere ? (sources.find((s) => s.id === elsewhere.sourceId)?.title ?? 'another book') : null;
  const nothing = scope.kind === 'all' && kinds.length === 0 && !alsoReread;

  const start = async () => {
    if (!chosen) return;
    setStarting(true);
    try {
      if (scope.kind === 'ids' && scope.retryJobId) {
        await retryRecords(scope.retryJobId, 'both', chosen.model);
      } else {
        await startJob(source.id, { ...choices, model: chosen.model, budgetUsd: limit });
      }
      toast.success(elsewhereTitle ? `Queued: it starts when “${elsewhereTitle}” finishes.` : 'Claude is reading. Review entries as they finish.');
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, 'Structuring couldn’t start.'));
    } finally {
      setStarting(false);
    }
  };

  const total = scope.kind === 'ids' ? scope.ids.length : misses.filter((r) => kinds.includes(r.kind)).length + (alsoReread ? here.length : 0);

  return (
    <div className={cn('flex flex-col gap-5', TOUCH_FORM)}>
      {!availability.ok && (
        <div role="note" className="rounded-xl border border-gold/40 bg-gold-soft/60 px-3 py-2.5 text-sm">
          {availability.reason === 'demo' ? (
            <p>
              Demo mode makes no API calls. {here.length} {here.length === 1 ? 'entry was' : 'entries were'} read on this device; the other{' '}
              {misses.length} can be filled in by hand.
            </p>
          ) : (
            <p>Add an Anthropic API key in Settings to have Claude read the rest.</p>
          )}
        </div>
      )}
      {scope.kind === 'all' && <KindChoice counts={counts} value={kinds} onChange={setKinds} />}
      {scope.kind === 'all' && here.length > 0 && (
        <p className="text-sm text-muted">
          {here.length} more {here.length === 1 ? 'was' : 'were'} already read on this device, for free.
        </p>
      )}
      {estimateError ? (
        <p role="alert" className="rounded-xl bg-danger-soft/60 px-3 py-2 text-sm text-danger">
          {estimateError} Nothing is sent without an estimate.
        </p>
      ) : !shown ? (
        <p className="text-sm text-muted">Estimating the cost…</p>
      ) : (
        <ModelChoice estimates={shown} settingsModel={settingsModel} value={chosen?.model ?? model} onChange={setModel} />
      )}
      {scope.kind === 'all' && here.length > 0 && (
        <label className={cn('flex cursor-pointer items-start gap-2.5 text-sm max-sm:items-center pointer-coarse:items-center', TOUCH)}>
          <input type="checkbox" checked={alsoReread} onChange={(e) => setAlsoReread(e.target.checked)} className="mt-0.5 size-4 accent-[var(--accent)]" />
          <span>
            Also have Claude re-read the {here.length} {here.length === 1 ? 'entry' : 'entries'} read on this device
            {extraUsd !== null ? ` (+ ${aboutUsd(extraUsd)})` : ''}
          </span>
        </label>
      )}
      {!(scope.kind === 'ids' && scope.retryJobId) && (
        <BudgetField value={limit} suggested={suggested} onChange={(v) => setBudget(v)} />
      )}
      <details className="text-sm">
        <summary className="cursor-pointer font-medium text-muted max-sm:py-3 pointer-coarse:py-3">Advanced</summary>
        <div className="mt-2 flex items-center gap-2">
          <label htmlFor="consent-concurrency" className="text-sm">
            Requests at once
          </label>
          <Select
            id="consent-concurrency"
            value={String(concurrency)}
            className="w-20"
            onChange={(e) => setConcurrency(Number(e.target.value) as 1 | 2 | 3 | 4)}
          >
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </div>
      </details>
      <Note>
        <p>
          <strong className="font-medium text-text">{PRIVACY_PROMISES[0].title}</strong> What's sent: each entry's text, one at a time, to Anthropic with
          your API key — not the book's title, your characters or your campaigns. Structuring waits while the DM is replying, so play keeps its
          speed.
        </p>
        <p className="mt-1">
          <strong className="font-medium text-text">{PRIVACY_PROMISES[1].title}</strong>
        </p>
      </Note>
      <Note>
        Estimates are rough; your Anthropic console has the real bill.
        {spent !== null && ` You've spent ${usd(spent)} on structuring so far.`}
      </Note>
      {elsewhereTitle && (
        <p className="text-sm text-muted">
          Structuring “{elsewhereTitle}” is still running. This one starts when it finishes.
        </p>
      )}
      {/* The dialog body scrolls with 1rem of padding: -bottom-4 keeps this footer flush with its bottom edge. */}
      <div className="sticky -bottom-4 -mx-5 -mb-4 flex justify-end gap-2 border-t border-border bg-surface px-5 py-3">
        {availability.ok ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Not now
            </Button>
            <Button
              variant="primary"
              loading={starting}
              disabled={!chosen || nothing || total === 0}
              icon={<Sparkles className="size-4" aria-hidden />}
              onClick={() => void start()}
            >
              {elsewhereTitle ? 'Queue it' : `Start · ${chosen ? aboutUsd(chosen.usd) : '…'}`}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                onClose();
                navigate('/settings');
              }}
            >
              Open Settings
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
