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
 * (PARSER_VERSION rose), a record an older version made that it no longer finds is dropped when nobody
 * reviewed it, and kept with a note when the player did (settleUnmatched). (Entry kinds an older chunker
 * guessed wrongly were corrected by the database upgrade to version 4, src/storage/db.ts.)
 *
 * Owner: E2.
 */
import { nameKey, slugify } from '@/lib/id';
import { bookFingerprint, textFingerprint } from '@/lib/importedContent';
import {
  commitRecords,
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
import { candidateFor, candidateKey, markCandidate, segment, type Candidate, type SegmentContext, type SpellListHint } from './segment';
import type { Wire } from './wire';

export interface DetectionSummary {
  byKind: Partial<Record<StructuredKind, { found: number; readyOffline: number; needClaude: number }>>;
  total: number; readyOffline: number; needClaude: number;
  leftOut: number;                                   // over the 5,000-record limit
  duplicateOf?: { id: string; title: string };       // another source with the same fingerprint
  /** Records an older offline reader made that this one doesn't find, dropped because nobody had reviewed them. */
  removed: Partial<Record<StructuredKind, number>>;
  /** Records like those that the player had reviewed (accepted or edited): kept with a note, for the player to decide. */
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

/**
 * §3.10: what a fresh reading does to a stored record (null = no write). `explicit`: the player asked for
 * this record (Re-read, Retry, a selection), which also reaches rejected and pack records.
 */
export function applyReading(existing: StructuredRecord, fresh: StructuredRecord, opts: { explicit: boolean; now: number }): StructuredRecord | null {
  const { explicit, now } = opts;
  if (existing.schemaVersion > STRUCTURED_SCHEMA_VERSION) return null; // a newer app wrote it: read-only here
  const changedText = fresh.textHash !== existing.textHash;
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
    };
    delete next.proposal;
    if (fresh.modelNote) next.modelNote = fresh.modelNote;
    else delete next.modelNote;
    const keys: (keyof StructuredRecord)[] = ['name', 'entryIds', 'data', 'warnings', 'adaptations', 'excerpts', 'confidence', 'origin', 'textHash', 'modelNote', 'parserVersion', 'proposal', 'extraction'];
    if (keys.every((k) => same(next[k], existing[k]))) return null;
    return { ...next, updatedAt: now };
  }
  let next: StructuredRecord | null = null;
  const reviewed = existing.edited || existing.status === 'accepted';
  if (fresh.data !== null && !same(fresh.data, existing.data) && (explicit || reviewed) && !same(fresh.data, existing.proposal?.data)) {
    next = {
      ...existing,
      proposal: { data: fresh.data, warnings: fresh.warnings, adaptations: fresh.adaptations, excerpts: fresh.excerpts, origin: fresh.origin, createdAt: now },
      updatedAt: now,
    };
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
    ...(reading.origin === 'parser' ? { parserVersion: PARSER_VERSION } : {}),
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
  opts: { explicit: boolean; now: number; limit?: number; decorate?: (record: StructuredRecord, reading: Reading) => StructuredRecord },
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

/** The note on a reviewed record the improved reader doesn't find any more. */
export function doubtMessage(kind: StructuredKind): string {
  return `An earlier version of the offline reader took this for ${KIND_NOUN[kind]}; the current one doesn't. If it isn't one, keep it as text. If it is, accept it.`;
}

const BEING_READ = new Set(['queued', 'running']);

/** A reviewed record the improved reader doesn't find: a note (a `warn`, so it can still be accepted), checked by today's reader. */
function doubted(record: StructuredRecord, now: number): StructuredRecord {
  const message = doubtMessage(record.kind);
  const warnings = record.warnings.some((w) => w.code === 'not-this-kind' && w.message === message)
    ? record.warnings
    : [...record.warnings, warning('not-this-kind', 'warn', message, 'kind')];
  return { ...record, warnings, confidence: record.confidence === 'low' ? 'low' : 'medium', parserVersion: PARSER_VERSION, updatedAt: now };
}

export interface Settled {
  /** Records to delete: nobody reviewed them. */
  remove: Set<string>;
  /** Records to write: reviewed ones with a note, and tables kept for their rows, stamped with today's version. */
  changed: Map<string, StructuredRecord>;
  /** The reviewed ones (also in `changed`). */
  doubted: StructuredRecord[];
}

/**
 * Stored records today's detection didn't find again (`unmatched`), among a source's records (`all`):
 * a record an older version of the offline reader made (PARSER_VERSION rose) was a misreading. When
 * nobody reviewed it (pending, unedited) it goes; when the player did (accepted or edited) it stays with
 * a note, so the player decides. A table stays while a row of it does. Rejected records, records Claude,
 * a pack or the player made, records being read and records today's reader made are left as they are.
 */
export function settleUnmatched(all: readonly StructuredRecord[], unmatched: readonly StructuredRecord[], now: number): Settled {
  const older = unmatched.filter(
    (r) => r.origin === 'parser' && (r.parserVersion ?? 0) < PARSER_VERSION && r.status !== 'rejected' && !BEING_READ.has(r.runState ?? ''),
  );
  const reviewed = (r: StructuredRecord) => r.edited || r.status === 'accepted';
  const remove = new Set(older.filter((r) => !reviewed(r)).map((r) => r.id));
  for (const r of all) if (r.tableRecordId && !remove.has(r.id)) remove.delete(r.tableRecordId);
  const changed = new Map<string, StructuredRecord>();
  const doubts: StructuredRecord[] = [];
  for (const r of older) {
    if (remove.has(r.id)) continue;
    if (reviewed(r)) {
      const next = doubted(r, now);
      changed.set(r.id, next);
      doubts.push(next);
    } else changed.set(r.id, { ...r, parserVersion: PARSER_VERSION, updatedAt: now });
  }
  return { remove, changed, doubted: doubts };
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

const countByKind = (records: readonly StructuredRecord[]): Partial<Record<StructuredKind, number>> => {
  const out: Partial<Record<StructuredKind, number>> = {};
  for (const r of records) out[r.kind] = (out[r.kind] ?? 0) + 1;
  return out;
};

function summarize(records: readonly (StructuredRecord | undefined)[], leftOut: number): Omit<DetectionSummary, 'duplicateOf' | 'removed' | 'doubted'> {
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

/** Local and free (~1–3 s for 300 pages); yields every 50 candidates. */
export async function detectStructure(sourceId: string, opts?: { onProgress?(done: number, total: number): void }): Promise<DetectionSummary> {
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
  const merged = mergeReadings(sourceId, existing, readings, { explicit: false, now, limit: STRUCTURED_LIMITS.recordsPerSource });
  const leftOut = merged.records.filter((r) => r === undefined).length;
  const settled = settleUnmatched(existing, merged.unmatched, now);
  const unmatchedWrites = merged.unmatched.flatMap((r) => {
    if (settled.remove.has(r.id)) return [];
    const base = settled.changed.get(r.id) ?? r;
    const textChanged = r.origin !== 'pack' && r.origin !== 'manual' && r.span !== 'row' && currentHash(r, entriesById) !== r.textHash;
    const next = textChanged ? (withStale(base, now) ?? base) : base;
    return next === r ? [] : [next];
  });
  const removed = existing.filter((r) => settled.remove.has(r.id));
  await commitRecords([...merged.writes, ...unmatchedWrites], [...settled.remove]);
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
    removed: countByKind(removed),
    doubted: settled.doubted.map((r) => ({ id: r.id, kind: r.kind, status: r.status })),
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
  const merged = mergeReadings(sourceId, existing, readings, { explicit: true, now: Date.now() });
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
