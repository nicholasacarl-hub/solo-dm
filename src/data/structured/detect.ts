/**
 * Detection (spec §3.2, §3.10): the I/O wrapper around segment → parseOffline → normalize that writes a
 * source's records (re-runs follow §3.10's table) and stores its fingerprint if missing. The pure parts
 * (readCandidate, mergeReadings, applyReading) are shared with the runner, which writes Claude's
 * readings through the same table.
 *
 * Re-runs never destroy work: a pending, unedited record read on this device is replaced; an edited or
 * accepted one gets a `proposal` when the new reading differs; a rejected or pack record is left alone
 * (unless the player explicitly re-reads it); a reading by Claude is never replaced by an offline one; a
 * record whose text changed gets `stale-text`. The one deletion: after the offline reader improved
 * (PARSER_VERSION rose), a misreading the version change explains is dropped when nobody worked on it,
 * and kept with a note when someone did (settleUnmatched). Detection first corrects the entry kinds an
 * older chunker guessed wrongly (staleKinds.ts), and never overwrites a record that changed while it ran.
 *
 * Owner: E2.
 */
import { nameKey, slugify } from '@/lib/id';
import { bookFingerprint, textFingerprint } from '@/lib/importedContent';
import { headingAncestors, misreadAsFeatBefore } from '../chunk';
import {
  commitRecords,
  compareRecordsByReading,
  findSourcesByFingerprint,
  getRecords,
  getSourceEntries,
  listLibrarySources,
  listRecords,
  markSourceStructured,
  putRecords,
  setSourceFingerprint,
} from '@/storage';
import {
  PARSER_VERSION,
  STRUCTURED_SCHEMA_VERSION,
  type CompendiumEntry,
  type RecordOrigin,
  type RecordSpan,
  type RecordWarning,
  type StructuredDataByKind,
  type StructuredKind,
  type StructuredRecord,
} from '@/types';
import { getRulesIndex } from '../rulesIndexStore';
import { normalize, normalizeItemRows, type NormalizeContext, type Normalized } from './normalize';
import { warning } from './normalize/text';
import { KIND_NOUN, nameNotices, noticeIndex, type NoticeIndex } from './notices';
import { parseOffline } from './parse';
import { STRUCTURED_LIMITS } from './schemas';
import { correctStaleKinds } from './staleKinds';
import { candidateFor, candidateKey, markCandidate, segment, type Candidate, type SegmentContext, type SpellListHint } from './segment';
import type { Wire } from './wire';

export interface DetectionSummary {
  byKind: Partial<Record<StructuredKind, { found: number; readyOffline: number; needClaude: number }>>;
  total: number; readyOffline: number; needClaude: number;
  leftOut: number;                                   // over the 5,000-record limit
  duplicateOf?: { id: string; title: string };       // another source with the same fingerprint
  /** Misreadings of an older offline reader (settleUnmatched) that nobody had worked on, removed: by kind. */
  removed: Partial<Record<StructuredKind, number>>;
  /** The first few of them by name, in reading order. */
  removedNames: string[];
  /** Them, as they were (so Undo can put them back). */
  removedRecords: StructuredRecord[];
  /** Misreadings someone had worked on: kept with a note, for the player to decide. */
  doubted: { id: string; kind: StructuredKind; status: StructuredRecord['status'] }[];
}

/** The warning a record gets when this device couldn't read it (spec §3.13). */
export const NEEDS_CLAUDE_MESSAGE = 'Not read yet: fill it in by hand, or add an API key in Settings and read it with Claude';
const STALE_MESSAGE = 'The text changed since this was read.';

// ---------------------------------------------------------------------------
// Readings (pure)
// ---------------------------------------------------------------------------

/** One fresh reading of a candidate (or of one row of a gear table), before it meets the stored records. */
export interface Reading {
  kind: StructuredKind;
  span: RecordSpan;
  entryIds: string[];
  candidateKey: string;
  rowIndex?: number;
  /** span 'row': the candidateKey of its table's reading. */
  tableKey?: string;
  textHash: string;
  origin: RecordOrigin;
  normalized: Normalized<StructuredKind>;
}

export interface ReadingContext {
  sourceId: string;
  entriesById: ReadonlyMap<string, CompendiumEntry>;
  spellLists: readonly SpellListHint[];
  notices: NoticeIndex | null;
}

/** The normalize context for a candidate (its FULL blocks). */
export function normalizeContextFor(candidate: Candidate, ctx: ReadingContext, origin: RecordOrigin, missing?: string[]): NormalizeContext {
  return {
    blocks: candidate.blocks,
    entriesById: ctx.entriesById,
    origin,
    spellLists: ctx.spellLists,
    ...(missing ? { missing } : {}),
    ...(candidate.parentClassName ? { parentClassName: candidate.parentClassName } : {}),
  };
}

const withNotices = (n: Normalized<StructuredKind>, kind: StructuredKind, ctx: ReadingContext): Normalized<StructuredKind> => {
  const notices = nameNotices({ kind, name: n.name, sourceId: ctx.sourceId, data: n.data }, ctx.notices);
  return notices.length ? { ...n, warnings: [...n.warnings, ...notices] } : n;
};

/**
 * The readings one wire gives for a candidate: one, or for a gear table its table reading followed by
 * one reading per row (a table read offline only counts when every row parsed: otherwise it waits,
 * whole, for Claude). An offline reading that missed a key field has no data and gets `needs-claude`.
 */
export function readCandidate(candidate: Candidate, wire: Wire<StructuredKind>, opts: { origin: RecordOrigin; missing?: string[]; ctx: ReadingContext }): Reading[] {
  const { origin, missing, ctx } = opts;
  const nctx = normalizeContextFor(candidate, ctx, origin, missing);
  const base = { kind: candidate.kind, entryIds: candidate.entryIds, textHash: candidate.textHash, origin };
  const extra: RecordWarning[] = candidate.truncated
    ? [warning('missing', 'warn', `This section has more than ${STRUCTURED_LIMITS.entriesPerRecord} entries; only the first ${STRUCTURED_LIMITS.entriesPerRecord} were read.`)]
    : [];
  if (candidate.kind === 'item' && candidate.span === 'table') {
    const rows = normalizeItemRows(wire as Wire<'item'>, nctx);
    const complete = rows.length > 0 && (origin !== 'parser' || rows.every((r) => r.data !== null));
    const table: Normalized<StructuredKind> = {
      data: null,
      name: candidate.name,
      warnings: complete ? [] : [origin === 'parser' ? warning('needs-claude', 'block', NEEDS_CLAUDE_MESSAGE) : warning('missing', 'block', 'No equipment was read from this table.')],
      adaptations: [],
      excerpts: [],
      confidence: complete ? 'medium' : 'low',
    };
    const tableReading: Reading = { ...base, span: 'table', candidateKey: candidate.key, normalized: table };
    if (!complete) return [tableReading];
    return [
      tableReading,
      ...rows.map((row, i): Reading => ({
        ...base,
        span: 'row',
        rowIndex: i,
        tableKey: candidate.key,
        candidateKey: candidateKey('item', row.name, candidate.entryIds[0], i),
        normalized: withNotices(row, 'item', ctx),
      })),
    ];
  }
  let n = normalize(candidate.kind, wire as never, nctx) as Normalized<StructuredKind>;
  // Offline, a key field the parser couldn't read means the reading waits for Claude (or the player) whole.
  if (origin === 'parser' && (n.data === null || (missing?.length ?? 0) > 0)) {
    n = { ...n, data: null, confidence: 'low', warnings: [...n.warnings, warning('needs-claude', 'block', NEEDS_CLAUDE_MESSAGE)] };
  }
  if (extra.length) n = { ...n, warnings: [...n.warnings, ...extra] };
  return [{ ...base, span: candidate.span, candidateKey: candidate.key, ...(candidate.rowIndex !== undefined ? { rowIndex: candidate.rowIndex } : {}), normalized: withNotices(n, candidate.kind, ctx) }];
}

/** The offline readings of a candidate (parseOffline → normalize). */
export function readOffline(candidate: Candidate, ctx: ReadingContext): Reading[] {
  const { wire, missing } = parseOffline(candidate);
  return readCandidate(candidate, wire, { origin: 'parser', missing, ctx });
}

// ---------------------------------------------------------------------------
// Readings meet stored records (pure; §3.10's re-run table)
// ---------------------------------------------------------------------------

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function withStale(record: StructuredRecord, now: number): StructuredRecord | null {
  if (record.warnings.some((w) => w.code === 'stale-text')) return null;
  return { ...record, warnings: [...record.warnings, warning('stale-text', 'warn', STALE_MESSAGE)], updatedAt: now };
}

/** Whether a fresh reading may replace a stored record outright (else it can only be offered as a proposal). */
function replaceable(existing: StructuredRecord, fresh: StructuredRecord): boolean {
  if (existing.edited || existing.status === 'accepted') return false;
  if (existing.origin === 'pack' || existing.origin === 'manual') return false;
  return !(existing.origin === 'claude' && fresh.origin === 'parser');
}

const BEING_READ = new Set(['queued', 'running']);

/** The fingerprint of an offline reading's data (StructuredRecord.readingHash). */
export function readingHashOf(data: unknown): string {
  return textFingerprint(JSON.stringify(data));
}

export interface ApplyOptions {
  explicit: boolean;
  now: number;
  /** Whether the record's own text changed since it was read (default: the fresh reading's hash differs). */
  textChanged?: (existing: StructuredRecord) => boolean;
}

/**
 * §3.10: what a fresh reading does to a stored record (null = no write). `explicit`: the player asked for
 * this record (Re-read, Retry, a selection), which also reaches rejected and pack records. A look
 * through the book (not explicit) leaves alone a record Claude is reading (that reading settles it),
 * never offers an offline reading over the player's own edit (Re-read still does), and never replaces
 * a Claude reading waiting as a proposal with an offline one.
 */
export function applyReading(existing: StructuredRecord, fresh: StructuredRecord, opts: ApplyOptions): StructuredRecord | null {
  const { explicit, now } = opts;
  if (existing.schemaVersion > STRUCTURED_SCHEMA_VERSION) return null; // a newer app wrote it: read-only here
  if (!explicit && BEING_READ.has(existing.runState ?? '')) return null;
  const changedText = opts.textChanged ? opts.textChanged(existing) : fresh.textHash !== existing.textHash;
  if (!explicit && (existing.status === 'rejected' || existing.origin === 'pack')) return changedText ? withStale(existing, now) : null;
  if (replaceable(existing, fresh)) {
    const next: StructuredRecord = {
      ...existing,
      name: fresh.name,
      entryIds: fresh.entryIds,
      data: fresh.data,
      warnings: fresh.warnings,
      adaptations: fresh.adaptations,
      excerpts: fresh.excerpts,
      confidence: fresh.confidence,
      origin: fresh.origin,
      textHash: fresh.textHash,
      ...(fresh.parserVersion !== undefined ? { parserVersion: fresh.parserVersion } : {}),
      ...(fresh.extraction ? { extraction: fresh.extraction } : {}),
      ...(fresh.marked ? { marked: true as const } : {}),
    };
    delete next.proposal;
    if (fresh.readingHash) next.readingHash = fresh.readingHash;
    else delete next.readingHash;
    if (fresh.modelNote) next.modelNote = fresh.modelNote;
    else delete next.modelNote;
    const keys: (keyof StructuredRecord)[] = ['name', 'entryIds', 'data', 'warnings', 'adaptations', 'excerpts', 'confidence', 'origin', 'textHash', 'modelNote', 'parserVersion', 'proposal', 'extraction', 'marked', 'readingHash'];
    if (keys.every((k) => same(next[k], existing[k]))) return null;
    return { ...next, updatedAt: now };
  }
  let next: StructuredRecord | null = null;
  const reviewed = existing.edited || existing.status === 'accepted';
  // A look through the book offers an offline reading only when the reader's reading changed since this
  // record was last read (not merely because the player's edit differs from it), and never over Claude's.
  const offline = !explicit && fresh.origin === 'parser';
  // Only a record the offline reader made has a baseline: Claude's, a pack's or the player's own fields are never second-guessed.
  const baseline =
    existing.origin !== 'parser' ? undefined : (existing.readingHash ?? (existing.edited || existing.data === null ? undefined : readingHashOf(existing.data)));
  const readerChanged = fresh.readingHash !== undefined && baseline !== undefined && fresh.readingHash !== baseline;
  const mayPropose = !offline || (readerChanged && existing.proposal?.origin !== 'claude');
  if (fresh.data !== null && !same(fresh.data, existing.data) && (explicit || reviewed) && !same(fresh.data, existing.proposal?.data) && mayPropose) {
    next = {
      ...existing,
      proposal: { data: fresh.data, warnings: fresh.warnings, adaptations: fresh.adaptations, excerpts: fresh.excerpts, origin: fresh.origin, createdAt: now },
      updatedAt: now,
    };
  }
  // Remember what the reader said this time (also for a record from before readings were remembered).
  if (fresh.origin === 'parser' && fresh.readingHash !== undefined && existing.origin === 'parser' && existing.readingHash !== fresh.readingHash) {
    next = { ...(next ?? existing), readingHash: fresh.readingHash, updatedAt: now };
  }
  // The current offline reader has looked at it (any difference waits in the proposal): "Re-check" is done for it.
  if (existing.origin === 'parser' && fresh.origin === 'parser' && fresh.parserVersion !== undefined && (existing.parserVersion ?? 0) < fresh.parserVersion) {
    next = { ...(next ?? existing), parserVersion: fresh.parserVersion, updatedAt: now };
  }
  if (changedText) next = withStale(next ?? existing, now) ?? next;
  return next;
}

interface IdSpace { ids: Set<string>; publicIds: Set<string> }

/** rec:<sourceId>:<kind>:<slug>[-n] and its publicId (§2.6), unique within the source; reserved in `space`. */
function newIds(sourceId: string, kind: StructuredKind, name: string, span: RecordSpan, primaryEntryId: string, space: IdSpace): { id: string; publicId: string } {
  const slug = slugify(name) || 'entry';
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : `-${n}`;
    const id = `rec:${sourceId}:${kind}:${slug}${suffix}`;
    const publicId = span === 'entry' ? primaryEntryId : `lib:${sourceId}:${kind}:${slug}${suffix}`;
    if (space.ids.has(id) || (span !== 'entry' && space.publicIds.has(publicId))) continue;
    space.ids.add(id);
    space.publicIds.add(publicId);
    return { id, publicId };
  }
}

/** A record for a reading: the stored one's ids when it matched, else new ones. */
function recordOf(reading: Reading, sourceId: string, matched: StructuredRecord | undefined, space: IdSpace, now: number, tableRecordId?: string): StructuredRecord {
  const n = reading.normalized;
  const ids = matched ? { id: matched.id, publicId: matched.publicId } : newIds(sourceId, reading.kind, n.name, reading.span, reading.entryIds[0], space);
  return {
    ...ids,
    sourceId,
    kind: reading.kind,
    name: n.name.slice(0, STRUCTURED_LIMITS.nameChars) || 'Untitled',
    schemaVersion: STRUCTURED_SCHEMA_VERSION,
    entryIds: reading.entryIds.slice(0, STRUCTURED_LIMITS.entriesPerRecord),
    span: reading.span,
    ...(reading.rowIndex !== undefined ? { rowIndex: reading.rowIndex } : {}),
    ...(tableRecordId ? { tableRecordId } : {}),
    candidateKey: reading.candidateKey,
    status: 'pending',
    confidence: n.confidence,
    origin: reading.origin,
    data: n.data as StructuredDataByKind[StructuredKind] | null,
    warnings: n.warnings,
    adaptations: n.adaptations,
    excerpts: n.excerpts,
    ...(n.modelNote ? { modelNote: n.modelNote.slice(0, STRUCTURED_LIMITS.modelNoteChars) } : {}),
    edited: false,
    textHash: reading.textHash,
    ...(reading.origin === 'parser' ? { parserVersion: PARSER_VERSION, ...(n.data !== null ? { readingHash: readingHashOf(n.data) } : {}) } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

export interface MergeResult {
  /** Records to write (new or changed). */
  writes: StructuredRecord[];
  /** The record each reading ended up in (stored or new), by reading index. */
  records: (StructuredRecord | undefined)[];
  /** Stored records no reading matched. */
  unmatched: StructuredRecord[];
}

/**
 * Readings meet a source's stored records: matched by candidateKey, else by kind and name when that is
 * unique among the unmatched ones; new readings get ids; matched ones follow applyReading. Rows join
 * their table's record (tableRecordId). `limit`: the most records the source may hold (new ones beyond
 * it are left out; their readings get no record).
 */
export function mergeReadings(
  sourceId: string,
  existing: readonly StructuredRecord[],
  readings: readonly Reading[],
  opts: ApplyOptions & { limit?: number; decorate?: (record: StructuredRecord, reading: Reading) => StructuredRecord },
): MergeResult {
  const space: IdSpace = { ids: new Set(existing.map((r) => r.id)), publicIds: new Set(existing.map((r) => r.publicId)) };
  const byKey = new Map(existing.map((r) => [r.candidateKey, r]));
  const byName = new Map<string, StructuredRecord[]>();
  for (const r of existing) {
    const key = `${r.kind}\u0000${r.span}\u0000${nameKey(r.name)}`;
    byName.set(key, [...(byName.get(key) ?? []), r]);
  }
  const used = new Set<string>();
  const tableIds = new Map<string, string>();
  const writes: StructuredRecord[] = [];
  const records: (StructuredRecord | undefined)[] = [];
  let count = existing.length;
  for (const reading of readings) {
    let match = byKey.get(reading.candidateKey);
    if (match && used.has(match.id)) match = undefined;
    if (!match) {
      const named = (byName.get(`${reading.kind}\u0000${reading.span}\u0000${nameKey(reading.normalized.name)}`) ?? []).filter((r) => !used.has(r.id));
      if (named.length === 1 && !readings.some((o) => o !== reading && o.candidateKey === named[0].candidateKey)) match = named[0];
    }
    if (!match && opts.limit !== undefined && count >= opts.limit) {
      records.push(undefined);
      continue;
    }
    if (match) used.add(match.id);
    else count += 1;
    const tableRecordId = reading.tableKey ? tableIds.get(reading.tableKey) : undefined;
    let fresh = recordOf(reading, sourceId, match, space, opts.now, tableRecordId);
    if (opts.decorate) fresh = opts.decorate(fresh, reading);
    const result = match ? applyReading(match, fresh, opts) : fresh;
    const final = result ?? match;
    if (reading.span === 'table' && final) tableIds.set(reading.candidateKey, final.id);
    if (result) writes.push(match && tableRecordId && !result.tableRecordId ? { ...result, tableRecordId } : result);
    records.push(final);
  }
  return { writes, records, unmatched: existing.filter((r) => !used.has(r.id)) };
}

// ---------------------------------------------------------------------------
// After the offline reader improved (pure)
// ---------------------------------------------------------------------------

/** The note on a record someone worked on that the improved reader doesn't find any more. */
export function doubtMessage(kind: StructuredKind): string {
  return `An earlier version of the offline reader took this for ${KIND_NOUN[kind]}; the current one doesn't. If it isn't one, keep it as text. If it is, accept it.`;
}

/** A note (a `warn`, so it can still be accepted), and today's reader version: the re-check is done for it. */
function doubted(record: StructuredRecord, now: number): StructuredRecord {
  const message = doubtMessage(record.kind);
  const warnings = record.warnings.some((w) => w.code === 'not-this-kind' && w.message === message)
    ? record.warnings
    : [...record.warnings, warning('not-this-kind', 'warn', message, 'kind')];
  return { ...record, warnings, confidence: record.confidence === 'low' ? 'low' : 'medium', parserVersion: PARSER_VERSION, updatedAt: now };
}

/** Anything a person or Claude did to a record: accepted, edited, a newer reading waiting, a Claude reading or run. */
const workedOn = (r: StructuredRecord) =>
  r.status === 'accepted' || r.edited || r.proposal !== undefined || r.extraction !== undefined || r.runState !== undefined;

/**
 * The misreadings PARSER_VERSION 2 explains: a feat version 1 read from a bare Prerequisite line that
 * today's rules read as something else (a stronghold room, a class option). Never a record the player
 * marked (All entries › Structure as…, What it is).
 */
function explainedMisreading(r: StructuredRecord, entriesById: ReadonlyMap<string, CompendiumEntry>): boolean {
  if (r.kind !== 'feat' || r.span !== 'entry' || r.marked) return false;
  const entry = entriesById.get(r.entryIds[0]);
  return entry !== undefined && misreadAsFeatBefore(entry.name, entry.text, headingAncestors(entry.path, entry.name));
}

export interface Settled {
  /** Explained misreadings nobody worked on: deleted. */
  remove: Set<string>;
  /** Explained misreadings someone worked on: kept with a note (doubted()). */
  doubted: StructuredRecord[];
  /** The other records an older reader made: read again with today's reader (the player's markings among them). */
  reread: StructuredRecord[];
}

/**
 * Stored records today's detection didn't find again (`unmatched`) that an older offline reader made
 * (PARSER_VERSION rose). Only misreadings the version change explains are settled: removed when nobody
 * worked on them, kept with a note when someone did, so the player decides. The rest are read again.
 * Rejected records, records Claude, a pack or the player filled in, records being read and records a
 * newer app wrote are left as they are.
 */
export function settleUnmatched(unmatched: readonly StructuredRecord[], entriesById: ReadonlyMap<string, CompendiumEntry>, now: number): Settled {
  const older = unmatched.filter(
    (r) =>
      r.origin === 'parser' &&
      (r.parserVersion ?? 0) < PARSER_VERSION &&
      r.status !== 'rejected' &&
      !BEING_READ.has(r.runState ?? '') &&
      r.schemaVersion <= STRUCTURED_SCHEMA_VERSION,
  );
  const remove = new Set<string>();
  const doubts: StructuredRecord[] = [];
  const reread: StructuredRecord[] = [];
  for (const r of older) {
    if (!explainedMisreading(r, entriesById)) reread.push(r);
    else if (workedOn(r)) doubts.push(doubted(r, now));
    else remove.add(r.id);
  }
  return { remove, doubted: doubts, reread };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/** The segment context and name notices from the rules index (empty when it can't be built). */
export async function detectionContext(): Promise<{ segment: SegmentContext; notices: NoticeIndex | null }> {
  try {
    const index = await getRulesIndex();
    const spells = index.list({ kind: 'spell' });
    const classes = index.list({ kind: 'class' });
    const kinds = ['monster', 'spell', 'magic-item', 'item', 'feat', 'background', 'species', 'class', 'subclass'] as const;
    return {
      segment: { knownSpellNames: new Set(spells.map((e) => nameKey(e.name))), knownClassNames: new Set(classes.map((e) => nameKey(e.name))) },
      notices: noticeIndex(kinds.flatMap((kind) => index.list({ kind }))),
    };
  } catch (err) {
    console.warn('Structuring: the rules index is unavailable, so SRD names are unknown for this pass.', err);
    return { segment: { knownSpellNames: new Set(), knownClassNames: new Set() }, notices: null };
  }
}

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The book's current text hash for a record's entries (null when one is gone). */
function currentHash(record: StructuredRecord, entriesById: ReadonlyMap<string, CompendiumEntry>): string | null {
  const texts: string[] = [];
  for (const id of record.entryIds) {
    const e = entriesById.get(id);
    if (!e) return null;
    texts.push(e.text);
  }
  return textFingerprint(texts.join('\n\n'));
}

/** How many of these records there are by kind, counted like "Found N" (a gear table whose rows are there counts as its rows). */
function countFound(records: readonly StructuredRecord[]): Partial<Record<StructuredKind, number>> {
  const out: Partial<Record<StructuredKind, number>> = {};
  for (const [kind, row] of Object.entries(summarize(records, 0).byKind) as [StructuredKind, { found: number }][]) out[kind] = row.found;
  return out;
}

function summarize(records: readonly (StructuredRecord | undefined)[], leftOut: number): Omit<DetectionSummary, 'duplicateOf' | 'removed' | 'removedNames' | 'removedRecords' | 'doubted'> {
  const byKind: DetectionSummary['byKind'] = {};
  const withRows = new Set(records.flatMap((r) => (r?.tableRecordId ? [r.tableRecordId] : [])));
  for (const r of records) {
    if (!r || (r.span === 'table' && withRows.has(r.id))) continue;
    const row = byKind[r.kind] ?? { found: 0, readyOffline: 0, needClaude: 0 };
    row.found += 1;
    if (r.data === null) row.needClaude += 1;
    else row.readyOffline += 1;
    byKind[r.kind] = row;
  }
  const rows = Object.values(byKind);
  return {
    byKind,
    total: rows.reduce((s, r) => s + r.found, 0),
    readyOffline: rows.reduce((s, r) => s + r.readyOffline, 0),
    needClaude: rows.reduce((s, r) => s + r.needClaude, 0),
    leftOut,
  };
}

/** The readings today's reader gives for records it didn't find again (their candidates rebuilt from the records). */
function rereadings(records: readonly StructuredRecord[], ctx: ReadingContext): Reading[] {
  return records.flatMap((r) => {
    if (r.span === 'table' || r.span === 'row') return [];
    const parentClassName = r.kind === 'subclass' ? (r.data as StructuredDataByKind['subclass'] | null)?.parentClass || undefined : undefined;
    const candidate = candidateFor(r, ctx.entriesById, parentClassName ? { parentClassName } : {});
    return candidate ? readOffline(candidate, ctx) : [];
  });
}

/**
 * Local and free (~1–3 s for 300 pages); yields every 50 candidates. The records are read at the start
 * and the results written at the end: a record that changed meanwhile (an accept, an edit, a Claude
 * reading) keeps its change and is left for the next look.
 */
export async function detectStructure(sourceId: string, opts?: { onProgress?(done: number, total: number): void }): Promise<DetectionSummary> {
  await correctStaleKinds(sourceId);
  const [entries, sources, existing, context] = await Promise.all([getSourceEntries(sourceId), listLibrarySources(), listRecords(sourceId), detectionContext()]);
  const source = sources.find((s) => s.id === sourceId);
  if (!source) throw new Error('This book is no longer in the library.');
  const entriesById = new Map(entries.map((e) => [e.id, e]));
  const { candidates, spellLists } = segment(entries, context.segment);
  const ctx: ReadingContext = { sourceId, entriesById, spellLists, notices: context.notices };
  const readings: Reading[] = [];
  for (let i = 0; i < candidates.length; i++) {
    readings.push(...readOffline(candidates[i], ctx));
    if ((i + 1) % 50 === 0) {
      opts?.onProgress?.(i + 1, candidates.length);
      await yieldToUi();
    }
  }
  opts?.onProgress?.(candidates.length, candidates.length);
  const now = Date.now();
  // Stale text is judged on a record's own entries: a section whose scope changed isn't a text change.
  const textChanged = (r: StructuredRecord) => currentHash(r, entriesById) !== r.textHash;
  const merged = mergeReadings(sourceId, existing, readings, { explicit: false, now, limit: STRUCTURED_LIMITS.recordsPerSource, textChanged });
  const leftOut = merged.records.filter((r) => r === undefined).length;
  const settled = settleUnmatched(merged.unmatched, entriesById, now);
  const reread = mergeReadings(sourceId, settled.reread, rereadings(settled.reread, ctx), { explicit: false, now, textChanged });
  const rereadById = new Map(reread.writes.map((r) => [r.id, r]));
  const doubtedById = new Map(settled.doubted.map((r) => [r.id, r]));
  const rereadIds = new Set(settled.reread.map((r) => r.id));
  const unmatchedWrites = merged.unmatched.flatMap((r) => {
    if (settled.remove.has(r.id) || BEING_READ.has(r.runState ?? '')) return [];
    const rereadNext = rereadById.get(r.id);
    if (rereadNext) return [rereadNext];
    // Read again and unchanged, or nothing to read it from (a table, a row, entries gone): today's reader has seen it.
    let base = doubtedById.get(r.id) ?? (rereadIds.has(r.id) ? { ...r, parserVersion: PARSER_VERSION, updatedAt: now } : r);
    const stale = r.origin !== 'pack' && r.origin !== 'manual' && r.span !== 'row' && textChanged(r);
    if (stale) base = withStale(base, now) ?? base;
    return base === r ? [] : [base];
  });
  // Every write and delete is checked against the record as it was read at the start.
  const expected = new Map<string, number | null>(existing.map((r) => [r.id, r.updatedAt]));
  for (const w of merged.writes) if (!expected.has(w.id)) expected.set(w.id, null);
  const applied = await commitRecords([...merged.writes, ...unmatchedWrites], [...settled.remove], expected);
  const removed = existing.filter((r) => applied.deleted.has(r.id));
  // Nothing found: the source remembers that detection ran (an empty structure), so "nothing detected" outlasts this page (§4.7).
  if (merged.records.length === 0) await markSourceStructured(sourceId);

  let fingerprint = source.fingerprint;
  if (!fingerprint) {
    fingerprint = bookFingerprint(entries.map((e) => e.text));
    await setSourceFingerprint(sourceId, fingerprint);
  }
  const duplicate = (await findSourcesByFingerprint(fingerprint)).find((s) => s.id !== sourceId);
  return {
    ...summarize(merged.records, leftOut),
    removed: countFound(removed),
    removedNames: removed.slice().sort(compareRecordsByReading).slice(0, 3).map((r) => r.name),
    removedRecords: removed,
    doubted: settled.doubted.filter((r) => applied.written.has(r.id)).map((r) => ({ id: r.id, kind: r.kind, status: r.status })),
    ...(duplicate ? { duplicateOf: { id: duplicate.id, title: duplicate.title } } : {}),
  };
}

/** "All entries › Structure as…": a candidate the player marked (reason 'Marked by you'), read offline if possible. */
export async function structureEntryAs(sourceId: string, entryIds: string[], kind: StructuredKind): Promise<StructuredRecord> {
  const [entries, existing, context] = await Promise.all([getSourceEntries(sourceId), listRecords(sourceId), detectionContext()]);
  const candidate = markCandidate(entries, entryIds, kind);
  if (!candidate) throw new Error("Those entries aren't in this book any more.");
  const { spellLists } = segment(entries, context.segment);
  const ctx: ReadingContext = { sourceId, entriesById: new Map(entries.map((e) => [e.id, e])), spellLists, notices: context.notices };
  const readings = readOffline(candidate, ctx);
  // The player's marking: never removed by a later version of the reader (settleUnmatched).
  const merged = mergeReadings(sourceId, existing, readings, { explicit: true, now: Date.now(), decorate: (record) => ({ ...record, marked: true }) });
  await putRecords(merged.writes);
  const record = merged.records[0];
  if (!record) throw new Error("This book can't hold any more structured entries.");
  return record;
}

/** The candidates behind stored records: detection's own when the key still matches (same blocks and parent), else rebuilt from the record. */
export function candidatesForRecords(
  records: readonly StructuredRecord[],
  entries: readonly CompendiumEntry[],
  segmentCtx: SegmentContext,
): { candidates: Map<string, Candidate>; spellLists: SpellListHint[] } {
  const { candidates, spellLists } = segment(entries, segmentCtx);
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const entriesById = new Map(entries.map((e) => [e.id, e]));
  const byId = new Map(records.map((r) => [r.id, r]));
  const out = new Map<string, Candidate>();
  for (const r of records) {
    const table = r.span === 'row' && r.tableRecordId ? byId.get(r.tableRecordId) : undefined;
    const key = table?.candidateKey ?? r.candidateKey;
    const detected = byKey.get(key);
    const parentClassName = r.kind === 'subclass' ? (r.data as StructuredDataByKind['subclass'] | null)?.parentClass || undefined : undefined;
    const candidate =
      detected && (r.span !== 'row' || detected.span === 'table')
        ? detected
        : candidateFor(table ?? r, entriesById, { ...(parentClassName ? { parentClassName } : {}), ...(table ? { tableName: table.name } : {}) });
    if (candidate) out.set(r.id, candidate);
  }
  return { candidates: out, spellLists };
}

/** Free; writes proposals where §3.10 says so. */
export async function rereadOffline(recordIds: string[]): Promise<void> {
  const records = (await getRecords(recordIds)).filter((r): r is StructuredRecord => Boolean(r));
  const context = await detectionContext();
  const bySource = new Map<string, StructuredRecord[]>();
  for (const r of records) bySource.set(r.sourceId, [...(bySource.get(r.sourceId) ?? []), r]);
  const now = Date.now();
  for (const [sourceId, list] of bySource) {
    const [entries, existing] = await Promise.all([getSourceEntries(sourceId), listRecords(sourceId)]);
    // A row is re-read with its table (one parse gives every row).
    const byId = new Map(existing.map((r) => [r.id, r]));
    const targets = [...new Map(list.map((r) => {
      const t = r.span === 'row' && r.tableRecordId ? byId.get(r.tableRecordId) ?? r : r;
      return [t.id, t];
    })).values()];
    const { candidates, spellLists } = candidatesForRecords(targets, entries, context.segment);
    const ctx: ReadingContext = { sourceId, entriesById: new Map(entries.map((e) => [e.id, e])), spellLists, notices: context.notices };
    const readings: Reading[] = [];
    for (const target of targets) {
      const candidate = candidates.get(target.id);
      if (candidate) readings.push(...readOffline({ ...candidate, key: target.candidateKey }, ctx));
    }
    const merged = mergeReadings(sourceId, existing, readings, { explicit: true, now });
    await putRecords(merged.writes);
  }
}
