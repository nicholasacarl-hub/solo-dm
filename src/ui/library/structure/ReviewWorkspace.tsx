/**
 * The book page's review (spec §4.4, §4.6, §4.9): filter chips with counts, a kind select and a name
 * search, the record list (links that push ?c=), select mode with the bulk bar, "Accept N confident"
 * with its confirm sheet, and the record detail. ≥ 1280 px: list · fields · source text; 1024–1279:
 * list · detail with a Fields / Source toggle; phones: list → full-screen detail.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { CheckCheck, ChevronDown, FileText, ListChecks, Search, Sparkles, Tags, TriangleAlert, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { BuilderData, CompendiumEntry, LibrarySource, ModelId, StructuredKind, StructuredRecord } from '@/types';
import { Badge, Button, Dialog, EmptyState, Input, Select } from '@/ui/components/ui';
import { TagInput } from '@/ui/components/TagInput';
import { toast } from '@/ui/components/toast';
import { Menu } from '@/ui/play/components/Menu';
import { useMediaQuery } from '@/ui/play/useMediaQuery';
import { errorMessage } from '@/ui/shell/format';
import { filterRecords, isConfident, kindCounts, matchesFilter, reviewCounts, type ReviewCounts } from './bookData';
import { KIND_LABELS, REVIEW_FILTERS, RECORD_STATES, fieldsToCheck, kindCount, recordState, recordStateLabel, type ReviewFilter } from './labels';
import { RecordDetail, type Availability, type DetailLayout } from './RecordDetail';
import { acceptRecords, rereadHere, setRecordsStatus, setSpellClasses } from './reviewActions';
import { TOUCH, TOUCH_BUTTONS, TOUCH_FOOTER, TOUCH_FORM } from './touch';
import { showUndo } from './UndoToast';
import { FROM_LIST, bookPageSearch, cameFromList, type BookPageControls } from './useBookPageState';

const PAGE = 150;
/** A pane on wide and mid screens: sticks below the top bar and scrolls on its own (like Browse's detail pane). */
const PANE = 'min-w-0 rounded-2xl border border-border bg-surface p-4 shadow-card sticky top-[4.5rem] max-h-[calc(100dvh-5.5rem)] overflow-y-auto scroll-thin';
const IN_USE_TAIL = "They're in the builder, combat and spell lists now.";

export interface ReviewWorkspaceProps {
  source: LibrarySource;
  /** Reviewable records (hidden table records removed), in review order. */
  records: StructuredRecord[];
  entriesById: ReadonlyMap<string, CompendiumEntry>;
  builder: BuilderData | null;
  state: BookPageControls;
  availability: Availability;
  /** Open the consent for these records ("Re-read with Claude", "Try again"). */
  onReadWithClaude(ids: string[], title: string, model?: ModelId): void;
  /** Open the consent to retry these failed or declined reads in their job ("Retry N"). */
  onRetry(jobId: string, ids: string[]): void;
  onAllEntries(): void;
}

function useLayout(): DetailLayout {
  const wide = useMediaQuery('(min-width: 1280px)', true);
  const mid = useMediaQuery('(min-width: 1024px)', true);
  return wide ? 'wide' : mid ? 'mid' : 'phone';
}

export function ReviewWorkspace({ source, records, entriesById, builder, state, availability, onReadWithClaude, onRetry, onAllEntries }: ReviewWorkspaceProps) {
  const layout = useLayout();
  const navigate = useNavigate();
  const location = useLocation();
  const [selection, setSelection] = useState<Set<string> | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const enabled = source.enabled;
  const rootRef = useRef<HTMLDivElement>(null);
  /** Where focus goes once the open record closes (its heading, which had focus, is gone then). */
  const focusAfterClose = useRef<{ to: 'filter' } | { to: 'row'; id: string } | null>(null);

  const counts = useMemo(() => reviewCounts(records, enabled), [records, enabled]);
  const list = useMemo(() => filterRecords(records, state, enabled), [records, state, enabled]);
  const open = state.recordId ? records.find((r) => r.id === state.recordId) : undefined;
  const index = open ? list.findIndex((r) => r.id === open.id) : -1;
  const position = index >= 0 ? { index, total: list.length } : null;

  const announce = (text: string) => {
    setAnnouncement('');
    window.setTimeout(() => setAnnouncement(text), 30);
  };

  const openRecord = (id: string | null, mode: 'push' | 'replace' = 'replace') => state.set({ recordId: id }, mode);

  /** The active filter chip: where focus lands when what had it is gone (it says what is left). */
  const filterChip = () => rootRef.current?.querySelector<HTMLElement>('[data-filter-chip][aria-pressed="true"]') ?? null;

  // The record closed (Back, or nothing left after Accept & next): put focus on the list, not the page body.
  useEffect(() => {
    const target = focusAfterClose.current;
    if (!target || state.recordId !== null) return;
    focusAfterClose.current = null;
    const root = rootRef.current;
    const row = target.to === 'row' ? root?.querySelector<HTMLElement>(`a[data-record-id="${CSS.escape(target.id)}"]`) : null;
    (row ?? filterChip())?.focus();
  }, [state.recordId]);

  const step = (by: 1 | -1) => {
    if (index < 0) return;
    const next = list[index + by];
    if (next) openRecord(next.id);
  };

  const onDecided = (record: StructuredRecord, decision: 'accepted' | 'text') => {
    const decided = { ...record, status: decision === 'accepted' ? ('accepted' as const) : ('rejected' as const) };
    const at = list.findIndex((r) => r.id === record.id);
    const stays = matchesFilter(decided, state.filter, enabled);
    const after = stays ? list : list.filter((r) => r.id !== record.id);
    const next = list.slice(at + 1).find((r) => r.id !== record.id) ?? list.slice(0, Math.max(at, 0)).reverse().find((r) => r.id !== record.id);
    const verb = decision === 'accepted' ? 'Accepted' : 'Kept as text:';
    if (next) {
      openRecord(next.id);
      announce(`${verb} ${record.name}. Now: ${next.name}, ${after.indexOf(next) + 1} of ${after.length}.`);
    } else {
      // The active filter chip says what is left ("To review 0").
      focusAfterClose.current = { to: 'filter' };
      openRecord(null);
      announce(`${verb} ${record.name}. Nothing else in this list.`);
    }
  };

  const back = () => {
    if (state.recordId) focusAfterClose.current = { to: 'row', id: state.recordId };
    // Back only when a list of this page pushed the record; else the entry before is another page.
    if (cameFromList(location.state)) navigate(-1);
    else openRecord(null);
  };

  const listPane = (
    <div className="flex min-w-0 flex-col gap-3">
      <ReviewToolbar
        counts={counts}
        records={records}
        state={state}
        selecting={selection !== null}
        onSelecting={(on) => setSelection(on ? new Set() : null)}
        sourceId={source.id}
        compact={layout !== 'phone'}
      />
      {state.filter === 'failed' && <RetryButton records={list} onRetry={onRetry} onReadWithClaude={onReadWithClaude} />}
      {records.length === 0 ? (
        <EmptyState
          icon={<FileText className="size-8" aria-hidden />}
          title="Nothing here to structure"
          action={
            <Button className={TOUCH} onClick={onAllEntries}>
              All entries
            </Button>
          }
        >
          Nothing here looks like a spell, monster, item, feat, species, background, class or subclass. The DM can still look up all of it.
          Know better? Use All entries › Structure as…
        </EmptyState>
      ) : list.length === 0 ? (
        <EmptyState title={emptyTitle(state.filter, state.q)} className="py-8">
          {state.filter === 'review' ? 'Everything here has been decided. Other chips show the rest.' : 'Try another chip or kind.'}
        </EmptyState>
      ) : (
        <RecordList
          records={list.slice(0, limit)}
          selectedId={state.recordId}
          selection={selection}
          bookEnabled={enabled}
          label={`${REVIEW_FILTERS[state.filter]}: ${list.length}`}
          onToggle={(id) =>
            setSelection((prev) => {
              const next = new Set(prev ?? []);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
        />
      )}
      {list.length > limit && (
        <Button className={cn('w-full', TOUCH)} onClick={() => setLimit((l) => l + PAGE)}>
          Show more ({list.length - limit} left)
        </Button>
      )}
      {selection !== null && (
        <BulkBar
          ids={[...selection]}
          total={list.length}
          kind={state.kind}
          records={records}
          availability={availability}
          onSelectAll={() => setSelection(new Set(list.map((r) => r.id)))}
          onClear={() => setSelection(new Set())}
          onDone={() => setSelection(null)}
          onReadWithClaude={(ids) => onReadWithClaude(ids, kindCount(state.kind ?? 'spell', ids.length).replace(/^\d+ /, `${ids.length} `))}
          returnFocus={filterChip}
          sticky={layout === 'phone'}
        />
      )}
      {selection === null && layout === 'phone' && <AcceptConfidentButton records={list} returnFocus={filterChip} sticky />}
    </div>
  );

  const detail = open ? (
    <RecordDetail
      key={open.id}
      record={open}
      source={source}
      entriesById={entriesById}
      builder={builder}
      bookRecords={records}
      position={position}
      layout={layout}
      availability={availability}
      onPrev={() => step(-1)}
      onNext={() => step(1)}
      onBack={back}
      onDecided={onDecided}
      onOpenRecord={(id) => openRecord(id)}
      onReadWithClaude={(r, model) => onReadWithClaude([r.id], r.name, model)}
      paneClassName={layout === 'wide' ? PANE : undefined}
    />
  ) : state.recordId ? (
    <EmptyState
      title="That entry isn't in this book any more"
      action={
        <Button className={TOUCH} onClick={() => openRecord(null)}>
          Back to the list
        </Button>
      }
    >
      It may have been read again as another kind.
    </EmptyState>
  ) : (
    <EmptyState icon={<ListChecks className="size-8" aria-hidden />} title="Pick an entry to review it here">
      “Accept confident” takes everything that was read cleanly in one go; classes and subclasses always get a look.
    </EmptyState>
  );

  const live = (
    <p role="status" aria-live="polite" className="sr-only">
      {announcement}
    </p>
  );

  if (layout === 'phone') {
    return (
      <div ref={rootRef} className="flex min-w-0 flex-col gap-3">
        {state.recordId ? detail : listPane}
        {live}
      </div>
    );
  }

  const pane = PANE;
  return (
    <div ref={rootRef} className={cn('grid items-start gap-4', layout === 'wide' ? 'grid-cols-[18rem_minmax(0,1fr)_minmax(0,1fr)]' : 'grid-cols-[16rem_minmax(0,1fr)]')}>
      <div className={cn(pane, 'p-3 pb-0')}>
        {listPane}
        {selection === null && (
          <div className="sticky bottom-0 -mx-3 border-t border-border bg-surface px-3 py-3">
            <AcceptConfidentButton records={list} returnFocus={filterChip} />
          </div>
        )}
      </div>
      {layout === 'wide' && open ? detail : <div className={cn(pane, layout === 'wide' && 'col-span-2', 'pb-0')}>{detail}</div>}
      {live}
    </div>
  );
}

/**
 * "Retry N" on the Couldn't read chip (spec §4.6): the consent for those reads. Reads from one job retry
 * in it (same model requeues, another model starts a scoped job); reads from several jobs become one
 * new scoped job.
 */
function RetryButton({
  records,
  onRetry,
  onReadWithClaude,
}: {
  records: readonly StructuredRecord[];
  onRetry(jobId: string, ids: string[]): void;
  onReadWithClaude(ids: string[], title: string): void;
}) {
  const failed = records.filter((r) => r.runState === 'failed' || r.runState === 'refused');
  if (failed.length === 0) return null;
  const ids = failed.map((r) => r.id);
  const jobs = new Set(failed.map((r) => r.jobId));
  const [jobId] = jobs;
  const retry = () => {
    if (jobs.size === 1 && jobId) onRetry(jobId, ids);
    else onReadWithClaude(ids, failed.length === 1 ? failed[0].name : `${failed.length} entries`);
  };
  return (
    <Button className={TOUCH} icon={<Sparkles className="size-4" aria-hidden />} onClick={retry}>
      Retry {failed.length}
    </Button>
  );
}

function emptyTitle(filter: ReviewFilter, q: string): string {
  if (q.trim()) return `Nothing named like “${q.trim()}” here`;
  switch (filter) {
    case 'review':
      return 'Nothing left to review here';
    case 'fix':
      return 'Nothing needs a fix';
    case 'failed':
      return 'Nothing failed to read';
    case 'unread':
      return 'Everything has been read';
    case 'used':
      return 'Nothing is in use yet';
    case 'text':
      return 'Nothing is kept as text';
    default:
      return 'Nothing here';
  }
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

const CHIP_ORDER: readonly ReviewFilter[] = ['review', 'fix', 'failed', 'unread', 'used', 'text', 'all'];

export function ReviewToolbar({
  counts,
  records,
  state,
  selecting,
  onSelecting,
  compact,
}: {
  counts: ReviewCounts;
  records: readonly StructuredRecord[];
  state: BookPageControls;
  selecting: boolean;
  onSelecting(v: boolean): void;
  sourceId: string;
  compact: boolean;
}) {
  const kinds = useMemo(() => kindCounts(records), [records]);
  const chips = CHIP_ORDER.filter((f) => f === 'review' || f === 'all' || f === state.filter || counts[f] > 0);
  return (
    <div className="flex flex-col gap-2">
      <div role="group" aria-label="Show" className={cn('-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 scroll-thin', compact && 'flex-wrap overflow-visible')}>
        {chips.map((f) => (
          <button
            key={f}
            type="button"
            data-filter-chip
            aria-pressed={state.filter === f}
            onClick={() => state.set({ filter: f })}
            className={cn(
              'inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm whitespace-nowrap transition-colors',
              TOUCH,
              state.filter === f ? 'border-accent bg-accent-soft text-text' : 'border-border bg-surface text-muted hover:text-text',
            )}
          >
            {REVIEW_FILTERS[f]}{' '}
            <span className="tabular-nums text-xs">{counts[f]}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Kind"
          value={state.kind ?? ''}
          className={cn('h-9 min-w-0 flex-1', TOUCH)}
          onChange={(e) => state.set({ kind: (e.target.value || null) as StructuredKind | null })}
        >
          <option value="">All kinds</option>
          {kinds.map(({ kind, count }) => (
            <option key={kind} value={kind}>
              {KIND_LABELS[kind].titleMany} ({count})
            </option>
          ))}
        </Select>
        <Button size="sm" className={TOUCH} variant={selecting ? 'primary' : 'secondary'} aria-pressed={selecting} onClick={() => onSelecting(!selecting)}>
          {selecting ? 'Done' : 'Select'}
        </Button>
      </div>
      <NameSearch q={state.q} onSearch={(q) => state.set({ q })} />
    </div>
  );
}

/**
 * The name search. Its text is its own state: ?q= reaches the page a render later (the router updates
 * in a transition), so an input bound to the URL would drop keys typed in between. The URL's value
 * replaces the text only when it changed elsewhere (Back, a link), never when it echoes this field.
 */
export function NameSearch({ q, onSearch }: { q: string; onSearch(q: string): void }) {
  const [text, setText] = useState(q);
  /** Values this field wrote to the URL, which the router may still hand back one by one. */
  const echoes = useRef(new Set<string>());
  useEffect(() => {
    if (echoes.current.has(q)) return;
    echoes.current.clear();
    setText(q);
  }, [q]);
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" aria-hidden />
      <Input
        type="search"
        aria-label="Search names"
        placeholder="Search names"
        value={text}
        className={cn('h-9 pl-9', TOUCH)}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          echoes.current.add(next);
          onSearch(next);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function RecordList({
  records,
  selectedId,
  selection,
  onToggle,
  bookEnabled,
  label,
}: {
  records: readonly StructuredRecord[];
  selectedId: string | null;
  selection: Set<string> | null;
  onToggle(id: string): void;
  bookEnabled: boolean;
  label: string;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  // Accept & next and Alt+↓ move the selection: keep the open row in view in its pane.
  useEffect(() => {
    if (!selectedId) return;
    listRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedId]);
  return (
    <ul ref={listRef} aria-label={label} className="flex flex-col gap-0.5">
      {records.map((r) => (
        <RecordRow
          key={r.id}
          record={r}
          selected={r.id === selectedId}
          checked={selection ? selection.has(r.id) : undefined}
          onToggle={selection ? () => onToggle(r.id) : undefined}
          bookEnabled={bookEnabled}
        />
      ))}
    </ul>
  );
}

export function RecordRow({
  record,
  selected,
  checked,
  onToggle,
  bookEnabled,
}: {
  record: StructuredRecord;
  selected: boolean;
  checked?: boolean;
  onToggle?(): void;
  bookEnabled: boolean;
}) {
  const [params] = useSearchParams();
  const stateKey = recordState(record, { bookEnabled });
  const style = RECORD_STATES[stateKey];
  const Icon = style.icon;
  const toCheck = fieldsToCheck(record.warnings);
  return (
    <li className="flex items-stretch gap-1">
      {onToggle && (
        <label className="flex w-11 shrink-0 cursor-pointer items-center justify-center">
          <input type="checkbox" checked={checked ?? false} onChange={onToggle} aria-label={`Select ${record.name}`} className="size-4 accent-[var(--accent)]" />
        </label>
      )}
      <Link
        to={{ search: bookPageSearch(params, { recordId: record.id }) }}
        state={FROM_LIST}
        data-record-id={record.id}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'flex min-h-14 min-w-0 flex-1 flex-col justify-center rounded-xl px-3 py-2 transition-colors',
          selected ? 'bg-accent-soft/60' : 'hover:bg-surface-2',
        )}
      >
        <span className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate text-sm font-medium">{record.name}</span>
          {toCheck > 0 && (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-gold">
              <TriangleAlert className="size-3" aria-hidden />
              {toCheck}
              <span className="sr-only"> to check</span>
            </span>
          )}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted">
          <Icon className={cn('size-3 shrink-0', stateKey === 'reading' && 'animate-spin motion-reduce:animate-none')} aria-hidden />
          <span className="truncate">
            {KIND_LABELS[record.kind].title} · {recordStateLabel(record, { bookEnabled })}
          </span>
        </span>
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Bulk actions
// ---------------------------------------------------------------------------

export function BulkBar({
  ids,
  total,
  kind,
  records,
  availability,
  onSelectAll,
  onClear,
  onDone,
  onReadWithClaude,
  returnFocus,
  sticky,
}: {
  ids: string[];
  total: number;
  kind: StructuredKind | null;
  records: readonly StructuredRecord[];
  availability: Availability;
  onSelectAll(): void;
  onClear(): void;
  onDone(): void;
  onReadWithClaude(ids: string[]): void;
  /** Where focus goes after Undo (this bar closes when the action is done). */
  returnFocus?: () => HTMLElement | null;
  sticky?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [classesOpen, setClassesOpen] = useState(false);
  const acceptRef = useRef<HTMLButtonElement>(null);
  const chosen = records.filter((r) => ids.includes(r.id));
  const allSpells = chosen.length > 0 && chosen.every((r) => r.kind === 'spell');
  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    try {
      await work();
    } catch (error) {
      toast.error(errorMessage(error, 'That didn’t work.'));
    } finally {
      setBusy(null);
    }
  };
  const accept = () =>
    run('accept', async () => {
      const result = await acceptRecords(ids);
      const blocked = result.skipped.length;
      const skippedText = blocked ? ` ${blocked} ${blocked === 1 ? 'needs' : 'need'} a fix first.` : '';
      if (result.accepted === 0) {
        toast.info(`Nothing was accepted.${skippedText}`);
        return;
      }
      showUndo(`Accepted ${result.accepted}. ${IN_USE_TAIL}${skippedText}`, result.undo, { focus: true, returnFocus });
      onDone();
    });
  const keepAsText = () =>
    run('text', async () => {
      const result = await setRecordsStatus(ids, 'rejected');
      showUndo(`Kept ${ids.length} as text. The DM can still read them.`, result.undo, { focus: true, returnFocus });
      onDone();
    });
  const none = ids.length === 0;
  return (
    <div
      role="region"
      aria-label="Selected entries"
      className={cn(
        'flex flex-col gap-2 rounded-xl border border-border bg-surface-2 p-2.5 shadow-card',
        TOUCH_BUTTONS,
        sticky && 'sticky bottom-[env(safe-area-inset-bottom)] z-20',
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{ids.length} selected</span>
        {ids.length > 0 && ids.length < total && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onSelectAll();
              // This button goes once all are selected: focus moves on to what comes next.
              acceptRef.current?.focus();
            }}
          >
            Select all {total} in this filter
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button
          ref={acceptRef}
          size="sm"
          variant="primary"
          disabled={none || busy !== null}
          loading={busy === 'accept'}
          icon={<CheckCheck className="size-4" aria-hidden />}
          onClick={() => void accept()}
        >
          Accept
        </Button>
        <Button size="sm" disabled={none || busy !== null} loading={busy === 'text'} onClick={() => void keepAsText()}>
          Keep as text
        </Button>
        <Menu
          label="Re-read"
          placement="top-start"
          items={[
            {
              id: 'here',
              label: 'On this device (free)',
              disabled: none,
              onSelect: () =>
                void run('reread', async () => {
                  const result = await rereadHere(ids);
                  const read = ids.length - result.alreadyNoted - result.busy;
                  const parts = [
                    read > 0 ? `Read ${read} again on this device.` : 'Nothing new to read.',
                    result.doubted ? `${result.doubted} ${result.doubted === 1 ? 'has' : 'have'} a note to check${result.movedBack ? ` (${result.movedBack} you had accepted ${result.movedBack === 1 ? 'is' : 'are'} back in To review)` : ''}.` : '',
                    result.busy ? `${result.busy} ${result.busy === 1 ? 'is' : 'are'} being read by Claude.` : '',
                  ].filter(Boolean);
                  if (result.undo) showUndo(parts.join(' '), result.undo, { focus: true, returnFocus });
                  else toast.success(parts.join(' '));
                }),
            },
            {
              id: 'claude',
              label: 'With Claude…',
              hint: availability.ok ? undefined : availability.reason === 'demo' ? 'Demo mode' : 'Needs a key',
              disabled: none || !availability.ok,
              onSelect: () => onReadWithClaude(ids),
            },
          ]}
          trigger={(t) => (
            <Button {...t} size="sm" disabled={none || busy !== null}>
              Re-read…
              <ChevronDown className="size-3.5" aria-hidden />
            </Button>
          )}
        />
        {(allSpells || kind === 'spell') && (
          <Button size="sm" disabled={none || !allSpells} icon={<Tags className="size-4" aria-hidden />} onClick={() => setClassesOpen(true)}>
            Set classes…
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={<X className="size-4" aria-hidden />} onClick={onClear}>
          Clear
        </Button>
      </div>
      <SetClassesDialog open={classesOpen} ids={ids} onClose={() => setClassesOpen(false)} records={records} />
    </div>
  );
}

function SetClassesDialog({ open, ids, onClose, records }: { open: boolean; ids: string[]; onClose(): void; records: readonly StructuredRecord[] }) {
  const [classes, setClasses] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const suggestions = useMemo(() => {
    const names = new Set<string>(['Bard', 'Cleric', 'Druid', 'Paladin', 'Ranger', 'Sorcerer', 'Warlock', 'Wizard']);
    for (const r of records) if (r.kind === 'class') names.add(r.name);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [records]);
  const save = async () => {
    setBusy(true);
    try {
      await setSpellClasses(ids, classes);
      toast.success(`Set the classes of ${ids.length} ${ids.length === 1 ? 'spell' : 'spells'}.`);
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, 'Could not set the classes.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={`Set the classes of ${ids.length} ${ids.length === 1 ? 'spell' : 'spells'}`}
      description="The spell lists they appear on. This replaces what was read."
      footer={
        <div className={TOUCH_FOOTER}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={classes.length === 0} onClick={() => void save()}>
            Set classes
          </Button>
        </div>
      }
    >
      <TagInput label="Classes" className={TOUCH_FORM} value={classes} onChange={setClasses} suggestions={suggestions} placeholder="Wizard" />
    </Dialog>
  );
}

/** "Accept N confident" for the records the list shows (chip, kind and name search): exactly the N its sheet names. */
export function AcceptConfidentButton({
  records,
  returnFocus,
  sticky,
}: {
  records: readonly StructuredRecord[];
  /** Where focus goes after Undo when this button is disabled by then (nothing confident left). */
  returnFocus?: () => HTMLElement | null;
  sticky?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const confident = records.filter(isConfident);
  const byKind = new Map<StructuredKind, number>();
  for (const r of confident) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
  const n = confident.length;
  const accept = async () => {
    setBusy(true);
    try {
      // The ids the sheet counted, not a fresh query: what the player confirmed is what gets accepted.
      const result = await acceptRecords(confident.map((r) => r.id));
      setOpen(false);
      if (result.accepted > 0) showUndo(`Accepted ${result.accepted}. ${IN_USE_TAIL}`, result.undo, { focus: true, returnFocus });
      else toast.info('Nothing was accepted: those entries changed since.');
    } catch (error) {
      toast.error(errorMessage(error, 'Could not accept them.'));
    } finally {
      setBusy(false);
    }
  };
  const button = (
    <Button
      variant="primary"
      size={sticky ? 'lg' : 'md'}
      className="w-full"
      disabled={n === 0}
      icon={<CheckCheck className="size-4" aria-hidden />}
      onClick={() => setOpen(true)}
    >
      {n === 0 ? 'Nothing confident to accept' : `Accept ${n} confident`}
    </Button>
  );
  return (
    <>
      {sticky ? <div className="sticky bottom-0 z-20 -mx-4 border-t border-border bg-bg px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{button}</div> : button}
      <Dialog
        open={open}
        onClose={() => !busy && setOpen(false)}
        size="sm"
        title={`Accept ${n} ${n === 1 ? 'entry' : 'entries'} that ${n === 1 ? 'was' : 'were'} read cleanly?`}
        footer={
          <div className={TOUCH_FOOTER}>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              Not now
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void accept()}>
              Accept {n}
            </Button>
          </div>
        }
      >
        <p className="text-sm">They'll be used by the builder, combat and spell lists. You can edit or undo any of them later.</p>
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {[...byKind.entries()].map(([k, count]) => (
            <li key={k}>
              <Badge tone="info">{kindCount(k, count)}</Badge>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted">Classes, subclasses and anything with a field to check always get a look first.</p>
      </Dialog>
    </>
  );
}
