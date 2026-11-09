/**
 * Every review write goes through here (spec §4.6; the homebrewActions pattern): write the records →
 * one debounced refresh of the rules index per batch (which also refreshes the builder data, D28) →
 * restore book text onto the loaded character → one DM notice per campaign with a session in
 * progress, only while the book is switched on (names and counts only).
 *
 * Accept notices wait until the 10-second Undo window has passed, so an accept the player undoes never
 * reaches the DM. Nothing here ever throws after the records are written: a failed refresh, restore
 * or notice must not undo a saved decision.
 */
import { DATA_SCHEMAS, rereadOffline, structureEntryAs, validateData } from '@/data';
import { useGame, queueCampaignNotice } from '@/state/gameStore';
import { deleteRecords, getRecords, getSourceEntries, listCampaigns, listLibrarySources, listRecords, putRecords, setRecordStatus } from '@/storage';
import type {
  LibrarySource,
  RecordConfidence,
  RecordStatus,
  RecordWarning,
  StructuredKind,
  StructuredRecord,
} from '@/types';
import { refreshRulesIndex } from '../kinds';
import { acceptBlocker, blocksFor, isConfident } from './bookData';
import { KIND_LABELS, kindCount } from './labels';
import { mergeWarnings, withoutParentProblems } from './warnings';

// ---------------------------------------------------------------------------
// After every write: refresh once per batch, restore, notices
// ---------------------------------------------------------------------------

const REFRESH_MS = 500;
/** Accept notices wait out the Undo toast (10 s). */
export const NOTICE_DELAY_MS = 11_000;

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function loadedCampaignId(): string | null {
  try {
    return useGame.getState().campaignId;
  } catch {
    return null;
  }
}

/** Refresh the index and the builder data once for a burst of writes, then restore the loaded hero's book text. */
export function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshRulesIndex();
    void restoreLoadedCharacter();
  }, REFRESH_MS);
}

/** Restore book text onto the loaded character (spec §7.4); never throws. */
export async function restoreLoadedCharacter(): Promise<void> {
  if (!loadedCampaignId()) return;
  try {
    await useGame.getState().restoreImportedText();
  } catch (error) {
    console.warn('[library] Could not restore book text onto the character:', error);
  }
}

/** Queue a notice for every campaign with a session in progress (campaigns between sessions read the library fresh). */
export async function tellDmsInSession(text: string): Promise<void> {
  try {
    const campaigns = (await listCampaigns()).map((s) => s.campaign).filter((c) => c.activeSessionId !== null);
    const results = await Promise.allSettled(campaigns.map((c) => queueCampaignNotice(c.id, text)));
    for (const r of results) if (r.status === 'rejected') console.warn('[library] Could not queue a DM notice:', r.reason);
  } catch (error) {
    console.warn('[library] Could not queue the DM notice:', error);
  }
}

const OPTION_KINDS = new Set<StructuredKind>(['class', 'subclass', 'species', 'background', 'feat']);

/** The DM's notice for newly reviewed entries (pure): "The player reviewed 41 entries from their book “…” (12 spells, …)." */
export function structureNotice(source: Pick<LibrarySource, 'title'>, counts: Partial<Record<StructuredKind, number>>): string {
  const parts = (Object.entries(counts) as [StructuredKind, number][]).filter(([, n]) => n > 0);
  const total = parts.reduce((sum, [, n]) => sum + n, 0);
  const list = parts.map(([kind, n]) => kindCount(kind, n)).join(', ');
  const supplies: string[] = [];
  if ((counts.monster ?? 0) > 0) supplies.push('Reviewed stat blocks now supply size, speed, reach, AC, HP and initiative in combat');
  if (parts.some(([kind]) => OPTION_KINDS.has(kind))) supplies.push(supplies.length ? 'new character options are available' : 'New character options are available');
  if ((counts.spell ?? 0) > 0 && supplies.length === 0) supplies.push('Reviewed spells are in the spell lists');
  const middle = supplies.length ? ` ${supplies.join(', and ')}.` : '';
  return `The player reviewed ${total} ${total === 1 ? 'entry' : 'entries'} from their book “${source.title}” (${list}).${middle} Look entries up with get_entry when they come up.`;
}

/** The DM's notice when a book is switched off or deleted (D41; names only). */
export function bookGoneNotice(source: Pick<LibrarySource, 'title'>, change: 'off' | 'deleted'): string {
  const what = change === 'off' ? 'switched off their book' : 'deleted their book';
  return `The player ${what} “${source.title}”. Its entries, stat blocks and character options are no longer available; characters keep the features they already have, and the player may give you the numbers for anything from it.`;
}

// Accepted counts per book, waiting out the Undo window.
const pendingAccepts = new Map<string, Partial<Record<StructuredKind, number>>>();
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function noteAccepted(records: readonly Pick<StructuredRecord, 'sourceId' | 'kind'>[], sign: 1 | -1): void {
  for (const r of records) {
    const counts = pendingAccepts.get(r.sourceId) ?? {};
    counts[r.kind] = Math.max(0, (counts[r.kind] ?? 0) + sign);
    pendingAccepts.set(r.sourceId, counts);
  }
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => void flushAcceptNotices(), NOTICE_DELAY_MS);
}

/** Send the waiting accept notices now (one per book, to every campaign in session). */
export async function flushAcceptNotices(): Promise<void> {
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = null;
  const waiting = [...pendingAccepts.entries()];
  pendingAccepts.clear();
  if (waiting.every(([, counts]) => Object.values(counts).every((n) => !n))) return;
  let sources: LibrarySource[];
  try {
    sources = await listLibrarySources();
  } catch (error) {
    console.warn('[library] Could not read the library for the DM notice:', error);
    return;
  }
  for (const [sourceId, counts] of waiting) {
    const source = sources.find((s) => s.id === sourceId);
    if (!source?.enabled || Object.values(counts).every((n) => !n)) continue;
    const ordered: Partial<Record<StructuredKind, number>> = {};
    for (const kind of Object.keys(KIND_LABELS) as StructuredKind[]) if (counts[kind]) ordered[kind] = counts[kind];
    await tellDmsInSession(structureNotice(source, ordered));
  }
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', () => void flushAcceptNotices());

// ---------------------------------------------------------------------------
// Status changes
// ---------------------------------------------------------------------------

export interface Undoable {
  undo(): Promise<void>;
}

async function restoreStatuses(previous: readonly { id: string; status: RecordStatus }[]): Promise<void> {
  const byStatus = new Map<RecordStatus, string[]>();
  for (const p of previous) byStatus.set(p.status, [...(byStatus.get(p.status) ?? []), p.id]);
  for (const [status, ids] of byStatus) await setRecordStatus(ids, status);
}

const present = <T,>(xs: readonly (T | undefined)[]): T[] => xs.filter((x): x is T => x !== undefined);

/** Why a stored record can't be accepted (its data must also pass DATA_SCHEMAS), or null. */
export function cannotAccept(record: StructuredRecord): string | null {
  const blocker = acceptBlocker(record);
  if (blocker) return blocker;
  if (!DATA_SCHEMAS[record.kind].safeParse(record.data).success) return 'Some fields need fixing first.';
  return null;
}

/** Accept what can be accepted; the rest is skipped with its reason ("2 need a fix first"). */
export async function acceptRecords(ids: string[]): Promise<{ accepted: number; skipped: { id: string; reason: string }[] } & Undoable> {
  const records = present(await getRecords(ids));
  const skipped: { id: string; reason: string }[] = [];
  const ok: StructuredRecord[] = [];
  for (const r of records) {
    const reason = r.status === 'accepted' ? null : cannotAccept(r);
    if (reason) skipped.push({ id: r.id, reason });
    else if (r.status !== 'accepted') ok.push(r);
  }
  if (ok.length === 0) return { accepted: 0, skipped, undo: async () => {} };
  const previous = await setRecordStatus(
    ok.map((r) => r.id),
    'accepted',
  );
  scheduleRefresh();
  noteAccepted(ok, 1);
  return {
    accepted: ok.length,
    skipped,
    undo: async () => {
      await restoreStatuses(previous);
      scheduleRefresh();
      noteAccepted(ok, -1);
    },
  };
}

/** Keep as text (rejected), Move back to review (pending), or accepted without the checks (Undo uses restoreStatuses). */
export async function setRecordsStatus(ids: string[], status: Exclude<RecordStatus, 'accepted'>): Promise<Undoable> {
  const before = present(await getRecords(ids));
  const previous = await setRecordStatus(ids, status);
  const wasAccepted = before.filter((r) => r.status === 'accepted');
  scheduleRefresh();
  if (wasAccepted.length) noteAccepted(wasAccepted, -1);
  return {
    undo: async () => {
      await restoreStatuses(previous);
      scheduleRefresh();
      if (wasAccepted.length) noteAccepted(wasAccepted, 1);
    },
  };
}

/** "Accept N confident" (D22): pending, high, nothing to check, never a class or a subclass. */
export async function acceptConfident(sourceId: string, filter: { kind?: StructuredKind } = {}): Promise<{ accepted: number } & Undoable> {
  const pending = await listRecords(sourceId, { status: 'pending', ...(filter.kind ? { kind: filter.kind } : {}) });
  const ids = pending.filter(isConfident).map((r) => r.id);
  const result = await acceptRecords(ids);
  return { accepted: result.accepted, undo: result.undo };
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/** Confidence from warnings (spec §3.9.2): any block or 3+ ungrounded → low; any warn → medium; classes and subclasses are never high. */
export function confidenceOf(kind: StructuredKind, warnings: readonly RecordWarning[]): RecordConfidence {
  if (warnings.some((w) => w.severity === 'block') || warnings.filter((w) => w.code === 'ungrounded').length >= 3) return 'low';
  if (warnings.some((w) => w.severity === 'warn') || kind === 'class' || kind === 'subclass') return 'medium';
  return 'high';
}

/**
 * Validate an edit with DATA_SCHEMAS (throws a readable error), re-check it, and save it (edited).
 * What changed is measured against the stored record, not `record`: a saved draft arrives with its new
 * fields already in it, and the warnings about the fields the player changed must be re-checked.
 */
export async function saveRecordEdit(record: StructuredRecord, data: unknown): Promise<StructuredRecord> {
  const parsed = DATA_SCHEMAS[record.kind].safeParse(data);
  if (!parsed.success) throw new Error('Some fields need fixing before this can be saved.');
  const [[stored], entries] = await Promise.all([getRecords([record.id]), getSourceEntries(record.sourceId)]);
  const before = stored ?? record;
  const entriesById = new Map(entries.map((e) => [e.id, e]));
  const blocks = blocksFor(record.entryIds, entriesById);
  const checked = validateData(record.kind, parsed.data, { blocks, entriesById, origin: record.origin, spellLists: [] });
  const merged = mergeWarnings(record.kind, before.data, parsed.data, before.warnings, checked.warnings);
  const warnings = record.kind === 'subclass' && record.parentClassId ? withoutParentProblems(merged) : merged;
  const filledIn = record.runState === 'failed' || record.runState === 'refused';
  const { runState: _runState, runError: _runError, ...rest } = record;
  const next: StructuredRecord = {
    ...(filledIn ? rest : record),
    data: parsed.data,
    warnings,
    adaptations: checked.adaptations,
    // From what is stored: the kept notices about untouched fields count too.
    confidence: confidenceOf(record.kind, warnings),
    edited: true,
    origin: record.origin,
    updatedAt: Date.now(),
  };
  await putRecords([next]);
  scheduleRefresh();
  return next;
}

/** A newer reading: take it ("Use new") or keep the current fields ("Keep mine"). */
export async function resolveProposal(recordId: string, use: 'new' | 'mine'): Promise<void> {
  const [record] = await getRecords([recordId]);
  if (!record?.proposal) return;
  const { proposal, ...rest } = record;
  const next: StructuredRecord =
    use === 'mine'
      ? { ...rest, updatedAt: Date.now() }
      : {
          ...rest,
          data: proposal.data,
          warnings: proposal.warnings,
          adaptations: proposal.adaptations,
          excerpts: proposal.excerpts,
          origin: proposal.origin,
          confidence: confidenceOf(record.kind, proposal.warnings),
          edited: false,
          updatedAt: Date.now(),
        };
  await putRecords([next]);
  if (record.status === 'accepted') scheduleRefresh();
}

/** "Keep these fields" after the book's text changed: the stale-text notice goes. */
export async function keepFields(recordId: string): Promise<void> {
  const [record] = await getRecords([recordId]);
  if (!record) return;
  await putRecords([{ ...record, warnings: record.warnings.filter((w) => w.code !== 'stale-text'), updatedAt: Date.now() }]);
}

/** A subclass's "Attaches to" (required to accept, D26); a parent problem the player resolved goes. */
export async function setParentClass(recordId: string, classId: string): Promise<void> {
  const [record] = await getRecords([recordId]);
  if (!record || record.kind !== 'subclass') return;
  const warnings = withoutParentProblems(record.warnings);
  const next: StructuredRecord = { ...record, parentClassId: classId, warnings, confidence: confidenceOf(record.kind, warnings), updatedAt: Date.now() };
  await putRecords([next]);
  if (record.status === 'accepted') scheduleRefresh();
}

/** "Set classes…" for a selection of spells. */
export async function setSpellClasses(recordIds: string[], classes: string[]): Promise<void> {
  const records = present(await getRecords(recordIds)).filter((r): r is StructuredRecord<'spell'> => r.kind === 'spell' && r.data !== null);
  if (records.length === 0) return;
  const now = Date.now();
  await putRecords(records.map((r) => ({ ...r, data: { ...r.data!, classes: [...classes] }, edited: true, updatedAt: now })));
  if (records.some((r) => r.status === 'accepted')) scheduleRefresh();
}

/** "What it is": re-detect the record's entries as another kind; the old reading goes. Returns the new record. */
export async function changeKind(record: StructuredRecord, kind: StructuredKind): Promise<StructuredRecord> {
  const next = await structureEntryAs(record.sourceId, record.entryIds, kind);
  if (next.id !== record.id) await deleteRecords([record.id]);
  if (record.status === 'accepted') scheduleRefresh();
  return next;
}

/** "Structure as…" from All entries. */
export async function structureAs(sourceId: string, entryIds: string[], kind: StructuredKind): Promise<StructuredRecord> {
  return structureEntryAs(sourceId, entryIds, kind);
}

/** "On this device (free)". */
export async function rereadHere(recordIds: string[]): Promise<void> {
  await rereadOffline(recordIds);
  scheduleRefresh();
}

/** Tests: run the pending refresh and drop pending notices. */
export function resetReviewActionsForTests(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (noticeTimer) clearTimeout(noticeTimer);
  refreshTimer = null;
  noticeTimer = null;
  pendingAccepts.clear();
}
