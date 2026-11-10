/**
 * Pure helpers for the book page (spec §4.2–§4.7): review order, the blocks a record was read from,
 * the review filters and their counts, the "Accept N confident" rule, and a job's progress numbers.
 * Everything here is synchronous and side-effect free, so the list, the chips and the cards agree.
 */
import { splitParagraphs, type CandidateBlock, type DetectionSummary } from '@/data';
import {
  PARSER_VERSION,
  STRUCTURED_KINDS,
  STRUCTURED_SCHEMA_VERSION,
  type CompendiumEntry,
  type ExtractionJob,
  type JobStatus,
  type StructuredKind,
  type StructuredRecord,
} from '@/types';
import { KIND_LABELS, readButIncomplete, recordState, type RecordState, type ReviewFilter } from './labels';

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

/** The n of "lib:<sourceId>:<n>" (Infinity for anything else, so it sorts last). */
export function entryOrdinal(id: string): number {
  const n = Number(id.slice(id.lastIndexOf(':') + 1));
  return Number.isInteger(n) ? n : Number.POSITIVE_INFINITY;
}

const KIND_ORDER: ReadonlyMap<StructuredKind, number> = new Map(STRUCTURED_KINDS.map((k, i) => [k, i]));

/** Review order (spec §2.2 STRUCTURED_KINDS): character options first, then reading order, then table rows. */
export function compareForReview(a: StructuredRecord, b: StructuredRecord): number {
  return (
    (KIND_ORDER.get(a.kind) ?? 99) - (KIND_ORDER.get(b.kind) ?? 99) ||
    entryOrdinal(a.entryIds[0] ?? '') - entryOrdinal(b.entryIds[0] ?? '') ||
    (a.rowIndex ?? -1) - (b.rowIndex ?? -1) ||
    a.name.localeCompare(b.name)
  );
}

// ---------------------------------------------------------------------------
// Blocks: one entry, or a "Name (part N)" chain (spec §3.2 rule 2)
// ---------------------------------------------------------------------------

const PART = /^(.*) \(part (\d+)\)$/;
const samePath = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
  (a ?? []).join('\u0000') === (b ?? []).join('\u0000');

/** The block title of an entry: its name without " (part N)". */
export function blockTitle(entry: Pick<CompendiumEntry, 'name'>): string {
  return PART.exec(entry.name)?.[1] ?? entry.name;
}

/** Group entry ids (in reading order) into blocks the way detection does, numbered B1, B2… */
export function blocksFor(entryIds: readonly string[], entriesById: ReadonlyMap<string, CompendiumEntry>): CandidateBlock[] {
  const groups: CompendiumEntry[][] = [];
  for (const id of entryIds) {
    const entry = entriesById.get(id);
    if (!entry) continue;
    const last = groups[groups.length - 1];
    const head = last?.[0];
    const part = PART.exec(entry.name);
    if (head && part && part[1] === blockTitle(head) && samePath(head.path, entry.path)) last.push(entry);
    else groups.push([entry]);
  }
  return groups.map((group, i) => ({
    id: `B${i + 1}`,
    entryIds: group.map((e) => e.id),
    title: blockTitle(group[0]),
    path: group[0].path ?? [],
    paragraphs: splitParagraphs(group.map((e) => e.text).join('\n\n')),
  }));
}

/** The block a span points into (its entry ids), or a block built for it when the record's grouping differs. */
export function blockForSpan(
  entryIds: readonly string[],
  blocks: readonly CandidateBlock[],
  entriesById: ReadonlyMap<string, CompendiumEntry>,
): CandidateBlock | null {
  const key = entryIds.join('\u0000');
  const found = blocks.find((b) => b.entryIds.join('\u0000') === key);
  if (found) return found;
  const entries = entryIds.flatMap((id) => {
    const entry = entriesById.get(id);
    return entry ? [entry] : [];
  });
  if (entries.length === 0 || entries.length !== entryIds.length) return null;
  return {
    id: '',
    entryIds: [...entryIds],
    title: blockTitle(entries[0]),
    path: entries[0].path ?? [],
    paragraphs: splitParagraphs(entries.map((e) => e.text).join('\n\n')),
  };
}

// ---------------------------------------------------------------------------
// Filters and counts (URL ?f=, spec §4.2)
// ---------------------------------------------------------------------------

const STATE_FILTER: Readonly<Record<RecordState, Exclude<ReviewFilter, 'all'>>> = {
  clean: 'review',
  check: 'review',
  'needs-fix': 'fix',
  failed: 'failed',
  refused: 'failed',
  'not-read': 'unread',
  waiting: 'unread',
  reading: 'unread',
  'in-use': 'used',
  'accepted-off': 'used',
  'text-only': 'text',
};

/** The chip a record belongs to (by its state). */
export function filterOf(record: StructuredRecord, bookEnabled: boolean): Exclude<ReviewFilter, 'all'> {
  return STATE_FILTER[recordState(record, { bookEnabled })];
}

/**
 * Table records whose rows exist are hidden from review: the rows are listed instead (spec §3.9 item).
 * Returns the ids to hide.
 */
export function hiddenTableIds(records: readonly StructuredRecord[]): Set<string> {
  const withRows = new Set(records.flatMap((r) => (r.tableRecordId ? [r.tableRecordId] : [])));
  return new Set(records.filter((r) => r.span === 'table' && r.data === null && withRows.has(r.id)).map((r) => r.id));
}

/** Records the review shows (hidden tables removed), in review order. */
export function reviewable(records: readonly StructuredRecord[]): StructuredRecord[] {
  const hidden = hiddenTableIds(records);
  return records.filter((r) => !hidden.has(r.id)).sort(compareForReview);
}

/** A newer reading waits for the player (re-runs of edited or accepted records, spec §3.10). */
export const hasProposal = (record: StructuredRecord): boolean => record.proposal !== undefined;

export function matchesFilter(record: StructuredRecord, filter: ReviewFilter, bookEnabled: boolean): boolean {
  if (filter === 'all') return true;
  // A fresh reading of an accepted or text-only record is something to review too.
  if (filter === 'review' && hasProposal(record)) return true;
  return filterOf(record, bookEnabled) === filter;
}

export type ReviewCounts = Record<ReviewFilter, number>;

export function reviewCounts(records: readonly StructuredRecord[], bookEnabled: boolean): ReviewCounts {
  const counts: ReviewCounts = { review: 0, fix: 0, failed: 0, unread: 0, used: 0, text: 0, all: 0 };
  for (const r of records) {
    counts.all += 1;
    const f = filterOf(r, bookEnabled);
    counts[f] += 1;
    if (f !== 'review' && hasProposal(r)) counts.review += 1;
  }
  return counts;
}

export interface ListQuery {
  filter: ReviewFilter;
  kind: StructuredKind | null;
  q: string;
}

/** The records a list shows for the chips, the kind select and the name search. */
export function filterRecords(records: readonly StructuredRecord[], query: ListQuery, bookEnabled: boolean): StructuredRecord[] {
  const q = query.q.trim().toLowerCase();
  return records.filter(
    (r) =>
      matchesFilter(r, query.filter, bookEnabled) &&
      (query.kind === null || r.kind === query.kind) &&
      (q === '' || r.name.toLowerCase().includes(q)),
  );
}

/** Kinds present in the book, in review order, with their counts. */
export function kindCounts(records: readonly StructuredRecord[]): { kind: StructuredKind; count: number }[] {
  const counts = new Map<StructuredKind, number>();
  for (const r of records) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  return STRUCTURED_KINDS.filter((k) => counts.has(k)).map((kind) => ({ kind, count: counts.get(kind) ?? 0 }));
}

// ---------------------------------------------------------------------------
// What may be accepted
// ---------------------------------------------------------------------------

const BUSY = new Set(['queued', 'running']);
export const isBeingRead = (record: Pick<StructuredRecord, 'runState'>): boolean => BUSY.has(record.runState ?? '');
export const isNewerVersion = (record: Pick<StructuredRecord, 'schemaVersion'>): boolean =>
  record.schemaVersion > STRUCTURED_SCHEMA_VERSION;

/**
 * "Accept N confident" (spec §4.6, D22): pending, read cleanly (high), nothing to check (no warn or block,
 * no name clash the player should see first), no newer reading waiting, never a class or a subclass. A
 * clean offline reading whose re-read by Claude failed or was declined shows "Couldn't read": it gets a
 * look first too.
 */
export function isConfident(record: StructuredRecord): boolean {
  return (
    record.status === 'pending' &&
    record.confidence === 'high' &&
    record.data !== null &&
    record.kind !== 'class' &&
    record.kind !== 'subclass' &&
    record.runState !== 'failed' &&
    record.runState !== 'refused' &&
    !hasProposal(record) &&
    !isBeingRead(record) &&
    !isNewerVersion(record) &&
    !record.warnings.some((w) => w.severity !== 'info' || w.code === 'name-collision')
  );
}

/**
 * A record an older offline reader made that "Re-check" would look at again: read on this device by an
 * earlier PARSER_VERSION, not kept as text, not being read by Claude (that reading settles it) and not
 * written by a newer app.
 */
export function needsRecheck(record: StructuredRecord): boolean {
  return (
    record.origin === 'parser' &&
    (record.parserVersion ?? 0) < PARSER_VERSION &&
    record.status !== 'rejected' &&
    !isBeingRead(record) &&
    !isNewerVersion(record)
  );
}

/** Why a Claude reading without data can't be accepted (spec §4.3 "Needs a fix"). */
export const INCOMPLETE_READING = "Claude's reading left out fields the app needs: fill it in yourself first.";

/** Why a record can't be accepted as it is stored, or null. */
export function acceptBlocker(record: StructuredRecord): string | null {
  if (isNewerVersion(record)) return 'Made by a newer version of Solo DM: read-only here.';
  if (isBeingRead(record)) return 'Claude is reading this one.';
  if (record.data === null) return readButIncomplete(record) ? INCOMPLETE_READING : 'Not read yet: fill it in or read it with Claude first.';
  const blocks = record.warnings.filter((w) => w.severity === 'block').length;
  if (blocks > 0) return `Fix ${blocks} ${blocks === 1 ? 'problem' : 'problems'} to accept.`;
  if (record.kind === 'subclass' && !record.parentClassId) return 'Choose the class it attaches to.';
  return null;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** Unfinished jobs, the one spending money first: being read, then waiting, then paused. */
const LIVE_RANK: Readonly<Partial<Record<JobStatus, number>>> = { running: 0, pausing: 0, queued: 1, paused: 2 };

/** The book's unfinished jobs in that order (newest first within each), so a waiting job never hides the one being read. */
export function liveJobs(jobs: readonly ExtractionJob[] | undefined, sourceId: string): ExtractionJob[] {
  return (jobs ?? [])
    .filter((j) => j.sourceId === sourceId && LIVE_RANK[j.status] !== undefined)
    .sort((a, b) => (LIVE_RANK[a.status] ?? 9) - (LIVE_RANK[b.status] ?? 9) || b.createdAt - a.createdAt);
}

/** The book's current job (the first of liveJobs), else its latest finished one. */
export function currentJob(jobs: readonly ExtractionJob[] | undefined, sourceId: string): { live: ExtractionJob | null; last: ExtractionJob | null } {
  const live = liveJobs(jobs, sourceId)[0] ?? null;
  const last = live ? null : ((jobs ?? []).filter((j) => j.sourceId === sourceId).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null);
  return { live, last };
}

export interface JobProgress {
  /** Read so far (done, failed or declined). */
  finished: number;
  total: number;
  left: number;
  done: number;
  failed: number;
  refused: number;
  inFlight: number;
}

export function jobProgress(job: Pick<ExtractionJob, 'counts'>): JobProgress {
  const c = job.counts;
  const finished = c.done + c.failed + c.refused;
  const left = c.queued + c.running;
  return { finished, total: finished + left, left, done: c.done, failed: c.failed, refused: c.refused, inFlight: c.running };
}

/** About how much the rest of a job costs: its measured mean once it has five requests, else the estimate's. */
export function remainingUsd(job: Pick<ExtractionJob, 'counts' | 'estimate' | 'usage'>): number {
  const { left } = jobProgress(job);
  if (left === 0) return 0;
  const measured = job.usage.requests >= 5 ? job.usage.estimatedCostUsd / job.usage.requests : null;
  const planned = job.estimate.requests > 0 ? job.estimate.usd / job.estimate.requests : 0;
  return left * (measured ?? planned);
}

/** The limit offered by "Raise the limit to $N and resume": enough for the rest, in whole dollars. */
export function raisedBudget(job: Pick<ExtractionJob, 'counts' | 'estimate' | 'usage' | 'budgetUsd'>): number {
  const need = job.usage.estimatedCostUsd + remainingUsd(job) * 1.1;
  return Math.max(Math.ceil(need), Math.floor(job.budgetUsd ?? 0) + 1, 1);
}

/** The default spending limit: the high estimate rounded up, at least $1 (spec D13). */
export function defaultBudget(usdHigh: number): number {
  return Math.max(1, Math.ceil(usdHigh));
}

// ---------------------------------------------------------------------------
// Looking through a book again (spec §4.7; detect.ts settles an earlier reader's misreadings)
// ---------------------------------------------------------------------------

const andList = (parts: readonly string[]) => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

/**
 * The toast after "Look for entries again" or "Re-check": what was found, or, when an earlier reader's
 * misreadings were settled, what happened to them (removed ones nobody had reviewed, by name; the
 * reviewed ones, `movedBack` of them accepted ones moved back to review).
 */
export function lookThroughMessage(
  summary: Pick<DetectionSummary, 'total' | 'readyOffline' | 'needClaude' | 'removed' | 'removedNames' | 'doubted'>,
  movedBack: number,
): string {
  const removed = (Object.entries(summary.removed) as [StructuredKind, number][]).filter(([, n]) => n > 0);
  const removedCount = removed.reduce((sum, [, n]) => sum + n, 0);
  const doubted = summary.doubted.length;
  if (removedCount === 0 && doubted === 0) {
    if (summary.total === 0) return 'Nothing here looks like something the app can use. All entries › Structure as… marks it by hand.';
    const claude = summary.needClaude ? `, ${summary.needClaude} ${summary.needClaude === 1 ? 'needs' : 'need'} Claude` : '';
    return `Found ${summary.total}: ${summary.readyOffline} read on this device${claude}.`;
  }
  const parts: string[] = [];
  if (removedCount > 0) {
    const one = removedCount === 1;
    const kinds = removed.map(([kind]) => kind);
    const took = kinds.length === 1 ? (one ? `a ${KIND_LABELS[kinds[0]].one}` : KIND_LABELS[kinds[0]].many) : kinds.map((k) => KIND_LABELS[k].many).join(' or ');
    const names = summary.removedNames;
    const examples = names.length === 0 ? '' : removedCount <= names.length ? `: ${andList(names)}` : `, such as ${andList(names.slice(0, 2))}`;
    parts.push(`Removed ${one ? '1 entry' : `${removedCount} entries`} an earlier version of the reader took for ${took}${examples} (you hadn't reviewed ${one ? 'it' : 'them'}).`);
  }
  if (doubted > 0) {
    const one = doubted === 1;
    const kinds = [...new Set(summary.doubted.map((d) => d.kind))];
    const notKind = kinds.length === 1 ? `may not be ${one ? `a ${KIND_LABELS[kinds[0]].one}` : KIND_LABELS[kinds[0]].many}` : 'may have been misread';
    const entries = one ? '1 entry' : `${doubted} entries`;
    if (movedBack === doubted) parts.push(`${entries} you had accepted ${one ? 'is' : 'are'} back in To review: ${one ? 'it' : 'they'} ${notKind}.`);
    else if (movedBack === 0) parts.push(`${entries} you had edited ${one ? 'has' : 'have'} a note in To review: ${one ? 'it' : 'they'} ${notKind}.`);
    else parts.push(`${entries} you had reviewed ${one ? 'is' : 'are'} in To review with a note: ${one ? 'it' : 'they'} ${notKind}.`);
  }
  return parts.join(' ');
}
