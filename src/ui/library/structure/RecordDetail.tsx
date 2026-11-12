/**
 * One record on the book page (spec §4.4–§4.7, §4.9): its notices, the form, the stats-line preview,
 * a newer reading to compare, and the actions (Accept & next, Save, Keep as text, Move back to review,
 * Re-read ▾, Fill in yourself). On wide screens the source text is the third column; below 1280 px a
 * Fields / Source toggle switches between them, and on phones the actions are a sticky bar.
 *
 * Keyboard: Ctrl/⌘+Enter accepts and opens the next record (also inside fields); Alt+↓/↑ next and
 * previous; Alt+1/2 Fields / Source. No single-key shortcuts.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, Check, ChevronDown, ChevronLeft, ChevronRight, FileText, LoaderCircle, MoreHorizontal, PencilLine, RotateCcw, Save } from 'lucide-react';
import { suggestParentClass, validateData } from '@/data';
import { cn } from '@/lib/cn';
import { useSettings } from '@/state/settingsStore';
import { MODELS, type BuilderData, type CompendiumEntry, type LibrarySource, type ModelId, type StructuredKind, type StructuredRecord } from '@/types';
import { Badge, Button, Dialog, IconButton } from '@/ui/components/ui';
import { Menu, type MenuItem } from '@/ui/play/components/Menu';
import { toast } from '@/ui/components/toast';
import { errorMessage } from '@/ui/shell/format';
import { INCOMPLETE_READING, blocksFor, isBeingRead, isNewerVersion } from './bookData';
import { AdaptationNotes, DetailNotices, Notice, ProposalDiff, SpoilerGuard, StatsPreview, previewLine } from './detailParts';
import { checkedPaths } from './forms/fieldMap';
import { draftOf, emptyData, issuesOf, recordFromDraft, type RecordDraft } from './forms/draft';
import { RecordForm } from './forms/RecordForm';
import { parentChoices } from './forms/ParentClassSelect';
import { KIND_LABELS, OLDER_EDITION, RECORD_STATES, modelName, originLabel, readButIncomplete, recordState, recordStateLabel } from './labels';
import { changeKind, keepFields, rereadHere, resolveProposal, saveRecordEdit, setParentClass, setRecordsStatus, acceptRecords } from './reviewActions';
import { SourceTextPane } from './SourceTextPane';
import { TOUCH, TOUCH_FOOTER, TOUCH_SQUARE } from './touch';
import { showUndo } from './UndoToast';
import { ViewToggle } from './ViewToggle';
import { mergeWarnings, withoutParentProblems } from './warnings';

export type DetailLayout = 'wide' | 'mid' | 'phone';
export type Availability = { ok: true } | { ok: false; reason: 'demo' | 'no-key'; message: string };

export interface RecordDetailProps {
  record: StructuredRecord;
  source: LibrarySource;
  entriesById: ReadonlyMap<string, CompendiumEntry>;
  builder: BuilderData | null;
  bookRecords: readonly StructuredRecord[];
  position: { index: number; total: number } | null;
  layout: DetailLayout;
  availability: Availability;
  onPrev(): void;
  onNext(): void;
  onBack(): void;
  /** Accepted or kept as text: the page opens the next record and announces it. */
  onDecided(record: StructuredRecord, decision: 'accepted' | 'text'): void;
  onOpenRecord(id: string): void;
  /** Open the consent for this record (with a model preselected). */
  onReadWithClaude(record: StructuredRecord, model?: ModelId): void;
  /** Wide layout: the class of each of the two panes (fields, source text) this renders. */
  paneClassName?: string;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The models the consent estimates: the Settings model, then every cheaper one (a custom id: all of them). */
export function modelsFrom(settingsModel: ModelId): ModelId[] {
  const at = MODELS.findIndex((m) => m.id === settingsModel);
  return at < 0 ? [settingsModel, ...MODELS.map((m) => m.id)] : MODELS.slice(at).map((m) => m.id);
}

/** The draft the form starts from: the stored fields, and a subclass's suggested parent. */
function baselineFor(record: StructuredRecord, suggestedParent: string | undefined): RecordDraft | null {
  const draft = draftOf(record);
  if (!draft) return null;
  if (record.kind === 'subclass' && !draft.parentClassId && suggestedParent) return { ...draft, parentClassId: suggestedParent };
  return draft;
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function RecordDetail(props: RecordDetailProps) {
  const { record, source, entriesById, builder, bookRecords, position, layout, availability } = props;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const reasonId = useId();
  const settingsModel = useSettings((s) => s.model);
  const bookEnabled = source.enabled;
  const blocks = useMemo(() => blocksFor(record.entryIds, entriesById), [record.entryIds, entriesById]);

  const suggestedParent = useMemo(() => {
    if (record.kind !== 'subclass' || record.data === null) return undefined;
    const parentClass = (record.data as { parentClass: string }).parentClass;
    return suggestParentClass(parentClass, record.sourceId, parentChoices(builder, record.sourceId, bookRecords)).id;
  }, [record, builder, bookRecords]);

  // The draft follows the stored record until the player changes something.
  const [state, setState] = useState(() => {
    const base = baselineFor(record, suggestedParent);
    return { id: record.id, at: record.updatedAt, base, draft: base };
  });
  const dirty = !same(state.draft, state.base);
  if (state.id !== record.id || (state.at !== record.updatedAt && !dirty)) {
    const base = baselineFor(record, suggestedParent);
    setState({ id: record.id, at: record.updatedAt, base, draft: base });
  } else if (state.at !== record.updatedAt) {
    setState((s) => ({ ...s, at: record.updatedAt }));
  }
  const draft = state.draft;
  const setDraft = (next: RecordDraft | null) => setState((s) => ({ ...s, draft: next }));

  const [pane, setPane] = useState<'fields' | 'source'>('fields');
  const [activeField, setActiveField] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ path: string; n: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const acceptRef = useRef<HTMLButtonElement>(null);
  /**
   * After an action whose button goes away or turns disabled (Save, Use new, Keep these fields, Show
   * details…), focus would fall to the page body: once the action is done, it goes to Accept & next when
   * that can be pressed, else to the heading.
   */
  const [refocus, setRefocusState] = useState<{ to: 'primary' | 'heading'; since: number } | null>(null);
  const setRefocus = (to: 'primary' | 'heading') => setRefocusState({ to, since: record.updatedAt });
  useEffect(() => {
    if (!refocus || busy) return;
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected || (active as HTMLButtonElement).disabled;
    if (!lost) {
      // The saved record (whose update removes the button) may still be on its way from storage.
      if (record.updatedAt !== refocus.since) setRefocusState(null);
      return;
    }
    setRefocusState(null);
    const accept = acceptRef.current;
    if (refocus.to === 'primary' && accept && !accept.disabled) accept.focus();
    else headingRef.current?.focus({ preventScroll: true });
  }, [refocus, busy, record.updatedAt]);
  const [confirmAccept, setConfirmAccept] = useState(false);
  const [kindChange, setKindChange] = useState<StructuredKind | null>(null);

  // Opening a record moves focus to its heading (spec §4.9).
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: layout !== 'phone' });
    setPane('fields');
    setActiveField(null);
  }, [record.id, layout]);

  // Validate on every change, debounced (DATA_SCHEMAS + validateData).
  const settled = useDebounced(draft, 150);
  const checkedDraft = useMemo(() => {
    if (!settled) return null;
    const issues = issuesOf(record.kind, settled.data);
    if (record.kind === 'subclass' && !settled.parentClassId) issues.parentClassId = 'Choose the class it attaches to.';
    if (!dirty) return { issues, warnings: record.warnings, adaptations: record.adaptations };
    let fresh = { warnings: [] as StructuredRecord['warnings'], adaptations: record.adaptations };
    try {
      const v = validateData(record.kind, settled.data, { blocks, entriesById, origin: record.origin, spellLists: [] });
      fresh = { warnings: v.warnings, adaptations: v.adaptations };
    } catch (error) {
      console.warn('[library] Could not re-check the fields:', error);
    }
    return { issues, warnings: mergeWarnings(record.kind, record.data, settled.data, record.warnings, fresh.warnings), adaptations: fresh.adaptations };
  }, [settled, dirty, record, blocks, entriesById]);

  const parentChosen = record.kind === 'subclass' && Boolean(draft?.parentClassId);
  const warnings = useMemo(() => {
    const all = checkedDraft?.warnings ?? record.warnings;
    // Choosing "Attaches to" answers a subclass's parent problem ("isn't named: choose it").
    return parentChosen ? withoutParentProblems(all) : all;
  }, [checkedDraft, record.warnings, parentChosen]);
  const issues = checkedDraft?.issues ?? {};
  const adaptations = checkedDraft?.adaptations ?? record.adaptations;
  const check = useMemo(
    () => checkedPaths(record.kind, warnings.filter((w) => w.severity !== 'info').map((w) => w.field)),
    [record.kind, warnings],
  );
  const line = useMemo(() => (draft ? previewLine(record, draft.data, entriesById, source) : ''), [draft, record, entriesById, source]);

  const readOnly = isNewerVersion(record) || isBeingRead(record);
  const blocked = (() => {
    if (isNewerVersion(record)) return 'Made by a newer version of Solo DM: read-only here.';
    if (isBeingRead(record)) return 'Claude is reading this one.';
    if (!draft) return readButIncomplete(record) ? INCOMPLETE_READING : 'Not read yet: fill it in yourself or read it with Claude.';
    const problems = Object.keys(issues).filter((k) => k !== 'parentClassId').length + warnings.filter((w) => w.severity === 'block').length;
    if (problems > 0) return `Fix ${problems} ${problems === 1 ? 'problem' : 'problems'} to accept.`;
    if (record.kind === 'subclass' && !draft.parentClassId) return 'Choose the class it attaches to.';
    return null;
  })();
  const toCheck = warnings.filter((w) => w.severity === 'warn');
  const accepted = record.status === 'accepted';

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

  const saveDraft = async (): Promise<StructuredRecord> => {
    if (!draft) return record;
    return saveRecordEdit(recordFromDraft(draft, record, Date.now()), draft.data);
  };

  const accept = (confirmed = false) => {
    if (blocked || busy) return;
    if (toCheck.length > 0 && !confirmed) {
      setConfirmAccept(true);
      return;
    }
    setConfirmAccept(false);
    void run('accept', async () => {
      if (dirty) await saveDraft();
      // A subclass's suggested "Attaches to" is where the form starts, not an edit: accepting confirms it (D26).
      else if (record.kind === 'subclass' && draft?.parentClassId && draft.parentClassId !== record.parentClassId) await setParentClass(record.id, draft.parentClassId);
      const result = await acceptRecords([record.id]);
      if (result.accepted === 0 && !accepted) {
        toast.error(result.skipped[0]?.reason ?? 'It couldn’t be accepted.');
        return;
      }
      showUndo(`Accepted ${draft?.name.trim() || record.name}.`, result.undo);
      props.onDecided(record, 'accepted');
    });
  };

  const save = () =>
    void run('save', async () => {
      await saveDraft();
      toast.success(accepted ? 'Saved. The change is in use now.' : 'Saved.');
      setRefocus('primary');
    });

  const keepAsText = () =>
    void run('text', async () => {
      const result = await setRecordsStatus([record.id], 'rejected');
      showUndo(`Kept ${record.name} as text: the DM can still read it.`, result.undo);
      props.onDecided(record, 'text');
    });

  const moveBack = () =>
    void run('back', async () => {
      const result = await setRecordsStatus([record.id], 'pending');
      showUndo(`Moved ${record.name} back to review.`, result.undo);
    });

  const rereadOffline = () =>
    void run('reread', async () => {
      const result = await rereadHere([record.id]);
      const kind = `a ${KIND_LABELS[record.kind].one}`;
      if (result.movedBack) showUndo(`The current reader doesn't take ${record.name} for ${kind}: it is back in To review with a note.`, result.undo);
      else if (result.doubted) toast.success(`Read again on this device. The current reader doesn't take this for ${kind}: see the note.`);
      else if (result.alreadyNoted) toast.info(`Nothing new to read: the current reader still doesn't take this for ${kind} (see the note).`);
      else if (result.busy) toast.info('Claude is reading this entry: read it again once that is done.');
      else toast.success('Read again on this device. A different reading shows here to compare.');
    });

  const fillIn = () => {
    const base = draftOf(record);
    setDraft(
      base ?? {
        name: record.name,
        data: emptyData(record.kind, { entryId: record.entryIds[0] ?? '', paragraphs: blocks[0]?.paragraphs.length ?? 1 }),
      },
    );
    setFocusRequest({ path: 'name', n: Date.now() });
  };

  const goToField = (path: string) => {
    setPane('fields');
    setFocusRequest({ path, n: Date.now() });
  };
  const showExcerpt = (path: string) => {
    setActiveField(path);
    if (layout !== 'wide') setPane('source');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!accepted) accept();
      return;
    }
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target instanceof HTMLSelectElement) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      props.onNext();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      props.onPrev();
    } else if (layout !== 'wide' && (e.code === 'Digit1' || e.code === 'Digit2')) {
      e.preventDefault();
      setPane(e.code === 'Digit1' ? 'fields' : 'source');
    }
  };

  const models = useMemo(() => modelsFrom(settingsModel), [settingsModel]);
  const rereadItems: MenuItem[] = [
    { id: 'here', label: 'On this device (free)', onSelect: rereadOffline, disabled: readOnly },
    ...models.map((m) => ({
      id: m,
      label: `With ${modelName(m)}…`,
      hint: availability.ok ? undefined : availability.reason === 'demo' ? 'Demo mode' : 'Needs a key',
      disabled: !availability.ok || readOnly,
      onSelect: () => props.onReadWithClaude(record, m),
    })),
  ];
  const moreItems: MenuItem[] = [
    ...(record.status !== 'pending' ? [{ id: 'back', label: 'Move back to review', icon: <RotateCcw className="size-4" aria-hidden />, onSelect: moveBack }] : []),
    ...(record.status !== 'rejected' && accepted ? [{ id: 'text', label: 'Keep as text', icon: <FileText className="size-4" aria-hidden />, onSelect: keepAsText }] : []),
    ...(record.data === null && !draft ? [{ id: 'fill', label: 'Fill in yourself', icon: <PencilLine className="size-4" aria-hidden />, onSelect: fillIn }] : []),
  ];

  const stateKey = recordState(record, { bookEnabled });
  const stateStyle = RECORD_STATES[stateKey];
  const StateIcon = stateStyle.icon;

  // ---------------------------------------------------------------------------
  // Pieces
  // ---------------------------------------------------------------------------

  const header = (
    <header className="flex flex-col gap-1.5">
      {layout === 'phone' && (
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" className={cn('-ml-2', TOUCH)} icon={<ArrowLeft className="size-4" aria-hidden />} onClick={props.onBack}>
            List
          </Button>
          {position && <Pager position={position} onPrev={props.onPrev} onNext={props.onNext} />}
        </div>
      )}
      <div className="flex items-start justify-between gap-3">
        <h2 ref={headingRef} tabIndex={-1} id="record-title" className="min-w-0 font-serif text-2xl leading-tight font-semibold [overflow-wrap:anywhere] focus:outline-none">
          {draft?.name.trim() || record.name}
        </h2>
        {layout !== 'phone' && position && <Pager position={position} onPrev={props.onPrev} onNext={props.onNext} />}
      </div>
      <p className="text-sm text-muted">
        {KIND_LABELS[record.kind].title} · {record.data === null && record.origin === 'parser' ? 'Found on this device' : originLabel(record)}
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Badge tone={stateStyle.tone}>
          <StateIcon className={cn('size-3.5', stateKey === 'reading' && 'animate-spin motion-reduce:animate-none')} aria-hidden />
          {recordStateLabel(record, { bookEnabled })}
        </Badge>
        {adaptations.length > 0 && (
          <Badge tone={OLDER_EDITION.tone}>
            <OLDER_EDITION.icon className="size-3.5" aria-hidden />
            {OLDER_EDITION.label}
          </Badge>
        )}
        {record.proposal && <Badge tone="info">Newer reading to compare</Badge>}
      </div>
    </header>
  );

  const runNotices = (
    <RunNotices
      record={record}
      hasDraft={draft !== null}
      availability={availability}
      onFillIn={fillIn}
      onRead={(model) => props.onReadWithClaude(record, model)}
      onKeepAsText={keepAsText}
      onReread={rereadOffline}
      onKeepFields={() =>
        void run('keep', async () => {
          await keepFields(record.id);
          setRefocus('primary');
        })
      }
      jobModel={record.extraction?.requestedModel}
    />
  );

  const fields = (
    <div className="flex min-w-0 flex-col gap-4">
      {runNotices}
      <SpoilerGuard key={record.sourceId} kind={record.kind} sourceId={record.sourceId} onShown={() => setRefocus('heading')}>
        <div className="flex min-w-0 flex-col gap-4">
          <DetailNotices kind={record.kind} warnings={warnings} modelNote={record.modelNote} onGoToField={goToField} onShowExcerpt={showExcerpt} />
          <AdaptationNotes notes={adaptations.map((a) => a.note)} />
          <ProposalDiff
            record={record}
            busy={busy !== null}
            onUse={() =>
              void run('use', async () => {
                await resolveProposal(record.id, 'new');
                setRefocus('primary');
              })
            }
            onKeep={() =>
              void run('mine', async () => {
                await resolveProposal(record.id, 'mine');
                setRefocus('primary');
              })
            }
          />
          {draft && (
            <RecordForm
              key={record.id}
              kind={record.kind}
              value={draft.data}
              onChange={(data) => setDraft({ ...draft, data })}
              check={check}
              issues={issues}
              blocks={blocks}
              builder={builder}
              disabled={readOnly}
              name={draft.name}
              onNameChange={(name) => setDraft({ ...draft, name })}
              onKindChange={readOnly ? undefined : (kind) => kind !== record.kind && setKindChange(kind)}
              entriesById={entriesById}
              sourceId={record.sourceId}
              bookRecords={bookRecords}
              parentClassId={draft.parentClassId}
              onParentClassChange={(id) => setDraft({ ...draft, parentClassId: id })}
              onFocusField={setActiveField}
              focusRequest={focusRequest}
            />
          )}
          <StatsPreview line={line} />
        </div>
      </SpoilerGuard>
    </div>
  );

  const sourcePane = (
    <SpoilerGuard key={`${record.sourceId}-source`} kind={record.kind} sourceId={record.sourceId} onShown={() => setRefocus('heading')}>
      <SourceTextPane kind={record.kind} blocks={blocks} excerpts={record.excerpts} activeField={activeField} entriesById={entriesById} />
    </SpoilerGuard>
  );

  const actions = (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 border-t border-border bg-surface pt-3',
        layout === 'phone' ? 'sticky bottom-0 z-20 -mx-4 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))]' : 'sticky bottom-0 z-10 pb-3',
      )}
    >
      {!accepted && record.status !== 'rejected' && (
        <Button size={layout === 'phone' ? 'lg' : 'md'} disabled={busy !== null || readOnly} loading={busy === 'text'} onClick={keepAsText}>
          Keep as text
        </Button>
      )}
      {layout !== 'phone' && (
        <Menu
          label="Re-read"
          items={rereadItems}
          placement="top-start"
          trigger={(t) => (
            <Button {...t} variant="ghost" aria-label="Re-read options" disabled={busy !== null} icon={<RotateCcw className="size-4" aria-hidden />}>
              Re-read
              <ChevronDown className="size-3.5" aria-hidden />
            </Button>
          )}
        />
      )}
      {(moreItems.length > 0 || layout === 'phone') && (
        <Menu
          label="More actions"
          items={layout === 'phone' ? [...moreItems, ...rereadItems.map((i) => ({ ...i, label: `Re-read ${i.label.charAt(0).toLowerCase()}${i.label.slice(1)}` }))] : moreItems}
          placement="top-start"
          trigger={(t) => (
            <IconButton {...t} label="More actions" size={layout === 'phone' ? 'lg' : 'md'}>
              <MoreHorizontal className="size-4" aria-hidden />
            </IconButton>
          )}
        />
      )}
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        {blocked && !accepted && (
          <p id={reasonId} className="text-xs text-danger">
            {blocked}
          </p>
        )}
        {(dirty || (accepted && draft)) && (
          <Button
            size={layout === 'phone' ? 'lg' : 'md'}
            variant={accepted ? 'primary' : 'secondary'}
            disabled={!dirty || busy !== null || readOnly || Object.keys(issues).some((k) => k !== 'parentClassId')}
            loading={busy === 'save'}
            icon={<Save className="size-4" aria-hidden />}
            onClick={save}
          >
            Save
          </Button>
        )}
        {!accepted && (
          <Button
            ref={acceptRef}
            variant="primary"
            size={layout === 'phone' ? 'lg' : 'md'}
            disabled={blocked !== null || busy !== null}
            loading={busy === 'accept'}
            aria-describedby={blocked ? reasonId : undefined}
            aria-keyshortcuts="Control+Enter Meta+Enter"
            icon={<Check className="size-4" aria-hidden />}
            onClick={() => accept()}
          >
            {layout === 'phone' ? 'Accept' : 'Accept & next'}
          </Button>
        )}
      </div>
    </div>
  );

  const dialogs = (
    <>
      <Dialog
        open={confirmAccept}
        onClose={() => setConfirmAccept(false)}
        size="sm"
        title={`Accept with ${toCheck.length} ${toCheck.length === 1 ? 'thing' : 'things'} to check?`}
        footer={
          <div className={TOUCH_FOOTER}>
            <Button variant="ghost" onClick={() => setConfirmAccept(false)}>
              Check them
            </Button>
            <Button variant="primary" onClick={() => accept(true)}>
              Accept anyway
            </Button>
          </div>
        }
      >
        <ul className="flex list-disc flex-col gap-1 pl-4 text-sm">
          {toCheck.map((w, i) => (
            <li key={i}>{w.message}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted">You can edit an accepted entry later, or move it back to review.</p>
      </Dialog>
      <Dialog
        open={kindChange !== null}
        onClose={() => setKindChange(null)}
        size="sm"
        title={kindChange ? `Read “${record.name}” as ${KIND_LABELS[kindChange].one === 'piece of gear' ? 'gear' : `a ${KIND_LABELS[kindChange].one}`}?` : ''}
        footer={
          <div className={TOUCH_FOOTER}>
            <Button variant="ghost" onClick={() => setKindChange(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy === 'kind'}
              onClick={() => {
                const kind = kindChange;
                if (!kind) return;
                void run('kind', async () => {
                  const next = await changeKind(record, kind);
                  setKindChange(null);
                  props.onOpenRecord(next.id);
                });
              }}
            >
              Read it again
            </Button>
          </div>
        }
      >
        <p className="text-sm">
          The app reads its text again as {kindChange ? KIND_LABELS[kindChange].one : ''}. These fields are replaced; if it can't be read on
          this device, you can have Claude read it or fill it in yourself.
        </p>
      </Dialog>
    </>
  );

  // ---------------------------------------------------------------------------
  // Layouts
  // ---------------------------------------------------------------------------

  if (layout === 'wide') {
    return (
      <>
        <div className={cn(props.paneClassName, 'pb-0')}>
          <article aria-labelledby="record-title" onKeyDown={onKeyDown} className="flex min-w-0 flex-col gap-4">
            {header}
            {fields}
            {actions}
          </article>
        </div>
        {/* The shortcuts work from the source text too (it sits outside the article on wide screens). */}
        <aside aria-label="Source text" onKeyDown={onKeyDown} className={props.paneClassName}>
          {sourcePane}
        </aside>
        {dialogs}
      </>
    );
  }
  return (
    <article aria-labelledby="record-title" onKeyDown={onKeyDown} className="flex min-w-0 flex-col gap-4">
      {header}
      <ViewToggle<'fields' | 'source'>
        label="View"
        className={layout === 'phone' ? 'grid w-full grid-cols-2' : 'self-start'}
        value={pane}
        onChange={setPane}
        options={[
          { value: 'fields', label: 'Fields', shortcut: 'Alt+1' },
          { value: 'source', label: 'Source text', shortcut: 'Alt+2' },
        ]}
      />
      {pane === 'fields' ? fields : sourcePane}
      {actions}
      {dialogs}
    </article>
  );
}

function Pager({ position, onPrev, onNext }: { position: { index: number; total: number }; onPrev(): void; onNext(): void }) {
  return (
    <div className="flex shrink-0 items-center gap-1 text-xs text-muted">
      <span className="tabular-nums" aria-live="off">
        {position.index + 1} of {position.total}
      </span>
      <IconButton label="Previous" size="sm" className={TOUCH_SQUARE} disabled={position.index <= 0} aria-keyshortcuts="Alt+ArrowUp" onClick={onPrev}>
        <ChevronLeft className="size-4" aria-hidden />
      </IconButton>
      <IconButton label="Next" size="sm" className={TOUCH_SQUARE} disabled={position.index >= position.total - 1} aria-keyshortcuts="Alt+ArrowDown" onClick={onNext}>
        <ChevronRight className="size-4" aria-hidden />
      </IconButton>
    </div>
  );
}

const RUN_ERRORS: Partial<Record<NonNullable<StructuredRecord['runError']>['code'], string>> = {
  truncated: 'Too long to read in one go.',
  'too-long': 'Too long to read in one go.',
  'invalid-output': "Claude's answer didn't fit the format.",
  network: "Couldn't reach Claude.",
  overloaded: 'Claude was too busy to read it.',
  'bad-request': 'Claude couldn’t take this request.',
  interrupted: 'Reading was stopped before it finished.',
};

/** Not read, being read, failed, declined, stale text, newer version (spec §4.7). */
function RunNotices({
  record,
  hasDraft,
  availability,
  onFillIn,
  onRead,
  onKeepAsText,
  onReread,
  onKeepFields,
  jobModel,
}: {
  record: StructuredRecord;
  hasDraft: boolean;
  availability: Availability;
  onFillIn(): void;
  onRead(model?: ModelId): void;
  onKeepAsText(): void;
  onReread(): void;
  onKeepFields(): void;
  jobModel?: string;
}) {
  const claude = availability.ok ? (
    <Button size="sm" onClick={() => onRead()}>
      Read with Claude…
    </Button>
  ) : null;
  const unavailable = !availability.ok ? (
    <p className="mt-1 text-xs text-muted">{availability.reason === 'demo' ? 'Demo mode makes no API calls: fill it in by hand, or turn demo mode off in Settings.' : availability.message}</p>
  ) : null;
  const items = [];
  if (isNewerVersion(record)) items.push(<Notice key="newer" tone="info">Made by a newer version of Solo DM: read-only here.</Notice>);
  if (isBeingRead(record)) {
    items.push(
      <Notice key="busy" tone="info" icon={<LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />}>
        {record.runState === 'running' ? 'Claude is reading this one…' : 'Waiting to be read by Claude.'}
      </Notice>,
    );
  }
  if (record.runState === 'failed' && !isBeingRead(record)) {
    const reason = (record.runError && (RUN_ERRORS[record.runError.code] ?? record.runError.message)) ?? "Claude couldn't read it.";
    items.push(
      <Notice
        key="failed"
        tone="block"
        actions={
          <>
            {availability.ok && (
              <Button size="sm" onClick={() => onRead(jobModel)}>
                Try again
              </Button>
            )}
            {availability.ok && (
              <Button size="sm" variant="ghost" onClick={() => onRead()}>
                Try another model
              </Button>
            )}
            {!hasDraft && (
              <Button size="sm" variant="ghost" onClick={onFillIn}>
                Fill in yourself
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onKeepAsText}>
              Keep as text
            </Button>
          </>
        }
      >
        <span className="font-medium">Couldn't read.</span> {reason}
        {unavailable}
      </Notice>,
    );
  } else if (record.runState === 'refused' && !isBeingRead(record)) {
    const why = record.extraction?.refusal ? ` (reason: ${record.extraction.refusal})` : '';
    items.push(
      <Notice
        key="refused"
        tone="block"
        actions={
          <>
            {!hasDraft && (
              <Button size="sm" onClick={onFillIn}>
                Fill in yourself
              </Button>
            )}
            {availability.ok && (
              <Button size="sm" variant="ghost" onClick={() => onRead()}>
                Try another model
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onKeepAsText}>
              Keep as text
            </Button>
          </>
        }
      >
        Claude declined to read this one{why}. You can fill it in yourself, try another model, or keep it as text — the DM can still read it.
        {unavailable}
      </Notice>,
    );
  } else if (readButIncomplete(record) && !hasDraft && !isBeingRead(record)) {
    // Claude answered, but without fields the app needs: a fix, not "Not read yet" (no second paid read offered).
    items.push(
      <Notice
        key="incomplete"
        tone="block"
        actions={
          <>
            <Button size="sm" onClick={onFillIn}>
              Fill in yourself
            </Button>
            {availability.ok && (
              <Button size="sm" variant="ghost" onClick={() => onRead()}>
                Try another model
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onKeepAsText}>
              Keep as text
            </Button>
          </>
        }
      >
        <span className="font-medium">Needs a fix.</span> Claude read it, but its answer is missing fields the app needs. Fill them in yourself,
        try another model, or keep it as text — the DM can still read it.
        {unavailable}
      </Notice>,
    );
  } else if (record.data === null && !hasDraft && !isBeingRead(record)) {
    items.push(
      <Notice
        key="unread"
        tone="info"
        actions={
          <>
            <Button size="sm" onClick={onFillIn}>
              Fill in yourself
            </Button>
            {claude}
          </>
        }
      >
        <span className="font-medium">Not read yet.</span> This device couldn't read it on its own.
        {unavailable}
      </Notice>,
    );
  }
  if (record.warnings.some((w) => w.code === 'stale-text')) {
    items.push(
      <Notice
        key="stale"
        tone="warn"
        actions={
          <>
            <Button size="sm" onClick={onReread}>
              Re-read
            </Button>
            <Button size="sm" variant="ghost" onClick={onKeepFields}>
              Keep these fields
            </Button>
          </>
        }
      >
        The text changed since this was read.
      </Notice>,
    );
  }
  return items.length ? <div className="flex flex-col gap-2">{items}</div> : null;
}
