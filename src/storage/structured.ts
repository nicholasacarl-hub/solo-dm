/**
 * Structured-imports storage (spec §2.5): records and jobs (Dexie version 3 tables `libraryRecords` and
 * `libraryJobs`), denormalized counts on the source row, fingerprints, and the "Used by …" query.
 * Neither table is part of campaignTables(): like the library, they never leave this device.
 *
 * Counts: `LibrarySource.structure` is kept by every record write here (putRecords, setRecordStatus,
 * deleteRecords, saveLibrarySourceWithRecords) from the old and new rows, in the same transaction. A
 * record counts once under its kind and status; `needsClaude` counts the records still without data
 * that weren't kept as text and that Claude hasn't read (a reading it returned without data needs a fix,
 * not another read). A gear-table record whose rows exist counts nowhere (its rows stand for
 * it and it is hidden from review), so the library row never shows it twice. A detection that found
 * nothing stores an empty structure (markSourceStructured).
 */
import { liveQuery } from 'dexie';
import { useCallback, useEffect, useState } from 'react';
import {
  PARSER_VERSION,
  STRUCTURED_KINDS,
  type Character,
  type CompendiumEntry,
  type ExtractionJob,
  type ImportedRef,
  type JobStatus,
  type LibrarySource,
  type RecordStatus,
  type RunState,
  type StructuredKind,
  type StructuredRecord,
} from '@/types';
import { db } from './db';

type SourceStructure = NonNullable<LibrarySource['structure']>;

/** Live queries re-emit at most this often (a 500-record book is about 1 MB of rows). */
export const LIVE_THROTTLE_MS = 500;

// ---------------------------------------------------------------------------
// Reading order
// ---------------------------------------------------------------------------

/** n of a chunk id "lib:<sourceId>:<n>"; NaN for any other id (sections' four-segment ids, SRD ids). */
export function entryOrdinal(id: string): number {
  const parts = id.split(':');
  if (parts.length !== 3 || parts[0] !== 'lib' || !/^\d+$/.test(parts[2])) return Number.NaN;
  return Number(parts[2]);
}

const orderKey = (id: string | undefined): number => {
  const n = id === undefined ? Number.NaN : entryOrdinal(id);
  return Number.isNaN(n) ? Number.MAX_SAFE_INTEGER : n;
};

function byEntryOrder(a: CompendiumEntry, b: CompendiumEntry): number {
  return orderKey(a.id) - orderKey(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Reading order of records: by their primary entry; a table before its rows, rows by index. */
export function compareRecordsByReading(a: StructuredRecord, b: StructuredRecord): number {
  const rowRank = (r: StructuredRecord) => (r.span === 'row' ? (r.rowIndex ?? 0) + 1 : 0);
  return (
    a.sourceId.localeCompare(b.sourceId) ||
    orderKey(a.entryIds[0]) - orderKey(b.entryIds[0]) ||
    rowRank(a) - rowRank(b) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

const KIND_ORDER = new Map(STRUCTURED_KINDS.map((k, i) => [k, i]));

/** Queue order: STRUCTURED_KINDS (character options first), then reading order. */
function compareQueueOrder(a: StructuredRecord, b: StructuredRecord): number {
  return (KIND_ORDER.get(a.kind) ?? 99) - (KIND_ORDER.get(b.kind) ?? 99) || compareRecordsByReading(a, b);
}

// ---------------------------------------------------------------------------
// Entries and records
// ---------------------------------------------------------------------------

/** A source's entries in reading order (numeric suffix of lib:<sourceId>:<n>, not IndexedDB string order). */
export async function getSourceEntries(sourceId: string): Promise<CompendiumEntry[]> {
  const entries = await db.libraryEntries.where('sourceId').equals(sourceId).toArray();
  return entries.sort(byEntryOrder);
}

/** A source's records in reading order, optionally of one kind and/or status. */
export async function listRecords(sourceId: string, opts: { kind?: StructuredKind; status?: RecordStatus } = {}): Promise<StructuredRecord[]> {
  const { kind, status } = opts;
  let rows: StructuredRecord[];
  if (kind && status) {
    rows = await db.libraryRecords.where('[sourceId+kind]').equals([sourceId, kind]).filter((r) => r.status === status).toArray();
  } else if (kind) {
    rows = await db.libraryRecords.where('[sourceId+kind]').equals([sourceId, kind]).toArray();
  } else if (status) {
    rows = await db.libraryRecords.where('[sourceId+status]').equals([sourceId, status]).toArray();
  } else {
    rows = await db.libraryRecords.where('sourceId').equals(sourceId).toArray();
  }
  return rows.sort(compareRecordsByReading);
}

/** Live query (Dexie) over the [sourceId+status] / [sourceId+kind] indexes, re-emitting at most every 500 ms (a 500-record book ≈ 1 MB). */
export function useRecords(
  sourceId: string | undefined,
  filter?: { status?: RecordStatus; kind?: StructuredKind },
): StructuredRecord[] | undefined {
  const status = filter?.status;
  const kind = filter?.kind;
  const query = useCallback(() => listRecords(sourceId ?? '', { status, kind }), [sourceId, status, kind]);
  return useThrottledLiveQuery(sourceId ? `records\u0000${sourceId}\u0000${status ?? ''}\u0000${kind ?? ''}` : null, query);
}

export async function getRecords(ids: string[]): Promise<(StructuredRecord | undefined)[]> {
  return db.libraryRecords.bulkGet(ids);
}

/** Upsert; adjusts source.structure.counts by the delta of each written record (bulkGet of the old rows, same transaction). */
export async function putRecords(records: StructuredRecord[]): Promise<void> {
  await commitRecords(records, []);
}

/** Status changes (accept, reject, undo). Returns the previous statuses (for Undo). Sets reviewedAt. */
export async function setRecordStatus(ids: string[], status: RecordStatus): Promise<{ id: string; status: RecordStatus }[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  return db.transaction('rw', db.libraryRecords, db.library, async () => {
    const rows = await db.libraryRecords.bulkGet(unique);
    const now = Date.now();
    const previous: { id: string; status: RecordStatus }[] = [];
    const next: StructuredRecord[] = [];
    for (const row of rows) {
      if (!row) continue;
      previous.push({ id: row.id, status: row.status });
      // reviewedAt is when the player last decided; a record moved back to review has no decision.
      const { reviewedAt: _was, ...rest } = row;
      next.push({ ...rest, status, updatedAt: now, ...(status === 'pending' ? {} : { reviewedAt: now }) });
    }
    await writeCounted(next, []);
    return previous;
  });
}

export async function deleteRecords(ids: string[]): Promise<void> {
  await commitRecords([], ids);
}

/** Writes (the last one per id wins) and deletes in one transaction, keeping the counts; detection's re-run uses both. */
export async function commitRecords(puts: readonly StructuredRecord[], deleteIds: readonly string[]): Promise<void> {
  const latest = new Map<string, StructuredRecord>();
  for (const r of puts) latest.set(r.id, r);
  const deletes = [...new Set(deleteIds)].filter((id) => !latest.has(id));
  if (latest.size === 0 && deletes.length === 0) return;
  await db.transaction('rw', db.libraryRecords, db.library, () => writeCounted([...latest.values()], deletes));
}

/** Accepted records of enabled import sources (or of the given sources), by source and reading order. */
export async function getAcceptedRecords(sourceIds?: string[]): Promise<StructuredRecord[]> {
  const ids = sourceIds ?? (await enabledImportIds());
  if (ids.length === 0) return [];
  const rows = await db.libraryRecords
    .where('[sourceId+status]')
    .anyOf(ids.map((id) => [id, 'accepted']))
    .toArray();
  return rows.sort(compareRecordsByReading);
}

async function enabledImportIds(): Promise<string[]> {
  return (await db.library.toArray()).filter((s) => s.enabled && s.kind === 'import').map((s) => s.id);
}

/** Records of a job in a run state, in queue order (STRUCTURED_KINDS, then reading order). */
export async function listJobRecords(jobId: string, runState: RunState): Promise<StructuredRecord[]> {
  const rows = await db.libraryRecords.where('[jobId+runState]').equals([jobId, runState]).toArray();
  return rows.sort(compareQueueOrder);
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export async function putJob(job: ExtractionJob): Promise<void> {
  await db.libraryJobs.put(job);
}

export async function getJob(id: string): Promise<ExtractionJob | undefined> {
  return db.libraryJobs.get(id);
}

/** Oldest first (the runner starts the oldest queued job). */
export async function listJobs(filter: { sourceId?: string; status?: JobStatus[] } = {}): Promise<ExtractionJob[]> {
  const rows = filter.sourceId
    ? await db.libraryJobs.where('sourceId').equals(filter.sourceId).toArray()
    : await db.libraryJobs.toArray();
  const statuses = filter.status;
  return rows
    .filter((j) => !statuses || statuses.includes(j.status))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Live jobs (of one source, or all), oldest first, re-emitting at most every 500 ms. */
export function useJobs(sourceId?: string): ExtractionJob[] | undefined {
  const query = useCallback(() => listJobs(sourceId ? { sourceId } : {}), [sourceId]);
  return useThrottledLiveQuery(`jobs\u0000${sourceId ?? ''}`, query);
}

/** Lifetime spend on structuring (sum of job usage, books still in the library). */
export async function structuringSpendUsd(): Promise<number> {
  const [jobs, sources] = await Promise.all([db.libraryJobs.toArray(), db.library.toArray()]);
  const present = new Set(sources.map((s) => s.id));
  return jobs.reduce((sum, j) => (present.has(j.sourceId) ? sum + (j.usage?.estimatedCostUsd ?? 0) : sum), 0);
}

// ---------------------------------------------------------------------------
// Sources: fingerprints and who uses them
// ---------------------------------------------------------------------------

/**
 * db.library.update only (no other field changes, updatedAt included). A fingerprint is set once and
 * never recomputed, so a source that already has one keeps it.
 */
export async function setSourceFingerprint(sourceId: string, fingerprint: string): Promise<void> {
  await db.transaction('rw', db.library, async () => {
    const source = await db.library.get(sourceId);
    if (!source) throw new Error('That library source no longer exists.');
    if (!source.fingerprint) await db.library.update(sourceId, { fingerprint });
  });
}

/** Sources with this fingerprint, oldest first. */
export async function findSourcesByFingerprint(fingerprint: string): Promise<LibrarySource[]> {
  if (!fingerprint) return [];
  const sources = await db.library.toArray();
  return sources.filter((s) => s.fingerprint === fingerprint).sort((a, b) => a.createdAt - b.createdAt);
}

/** Every provenance ref on a character (classes, subclasses, species, background, features, spells, items). */
export function characterRefs(c: Character): ImportedRef[] {
  const refs: (ImportedRef | undefined)[] = [
    c.speciesRef,
    c.backgroundRef,
    ...c.classes.flatMap((cl) => [cl.ref, cl.subclassRef]),
    ...c.features.map((f) => f.ref),
    ...(c.spellcasting?.spells ?? []).map((s) => s.ref),
    ...c.inventory.map((i) => i.ref),
  ];
  return refs.filter((r): r is ImportedRef => Boolean(r));
}

/**
 * Characters with a ref into this source (for "Used by …" on switch-off / delete): refs copied on this
 * device name its id; refs from another device name the same book by fingerprint.
 */
export async function charactersUsingSource(sourceId: string): Promise<{ campaignId: string; campaignName: string; characterName: string }[]> {
  const [source, characters, campaigns] = await Promise.all([db.library.get(sourceId), db.characters.toArray(), db.campaigns.toArray()]);
  const fingerprint = source?.fingerprint;
  const uses = (ref: ImportedRef) => ref.sourceId === sourceId || (fingerprint !== undefined && ref.bookFingerprint === fingerprint);
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  const out: { campaignId: string; campaignName: string; characterName: string }[] = [];
  for (const character of characters) {
    const campaign = byId.get(character.campaignId);
    if (!campaign || campaign.characterId !== character.id) continue;
    if (characterRefs(character).some(uses)) out.push({ campaignId: campaign.id, campaignName: campaign.name, characterName: character.name });
  }
  return out.sort((a, b) => a.campaignName.localeCompare(b.campaignName, undefined, { sensitivity: 'base' }) || a.campaignId.localeCompare(b.campaignId));
}

/** Pack import: a new source with its entries and records in one transaction (its counts computed from the records). */
export async function saveLibrarySourceWithRecords(source: LibrarySource, entries: CompendiumEntry[], records: StructuredRecord[]): Promise<void> {
  const foreign = records.find((r) => r.sourceId !== source.id);
  if (foreign) throw new Error(`saveLibrarySourceWithRecords: record ${foreign.id} belongs to another source.`);
  await db.transaction('rw', [db.library, db.libraryEntries, db.libraryRecords], async () => {
    await db.libraryEntries.where('sourceId').equals(source.id).delete();
    await db.libraryRecords.where('sourceId').equals(source.id).delete();
    await db.libraryEntries.bulkPut(entries.map((e) => (e.sourceId === source.id ? e : { ...e, sourceId: source.id })));
    await db.libraryRecords.bulkPut(records);
    await db.library.put({ ...source, entryCount: entries.length, structure: countRecords(records, Date.now()) });
  });
}

// ---------------------------------------------------------------------------
// Denormalized counts
// ---------------------------------------------------------------------------

interface Contribution { kind: StructuredKind; status: RecordStatus; unread: boolean }

/**
 * What one record adds to its source's counts (a table whose rows exist adds nothing). A reading Claude
 * returned without data isn't "not read yet": it needs a fix (spec §4.3), so it counts as one to review.
 */
function contribution(r: StructuredRecord | undefined, tableHasRows: boolean): Contribution | null {
  if (!r) return null;
  if (r.span === 'table' && tableHasRows) return null;
  return { kind: r.kind, status: r.status, unread: r.data === null && r.status !== 'rejected' && r.origin !== 'claude' };
}

const emptyStructure = (now: number): SourceStructure => ({ detectedAt: now, parserVersion: PARSER_VERSION, counts: {}, needsClaude: 0 });

/**
 * Detection ran and found nothing (spec §4.7 "nothing detected"): a source with no structure gets an empty
 * one, so the book page and its library row remember that after a reload. A structure the source has stays
 * as it is, and a source no longer in the library is left alone. db.library.update only (updatedAt included).
 */
export async function markSourceStructured(sourceId: string): Promise<void> {
  await db.transaction('rw', db.library, async () => {
    const source = await db.library.get(sourceId);
    if (source && !source.structure) await db.library.update(sourceId, { structure: emptyStructure(Date.now()) });
  });
}

function addTo(structure: SourceStructure, c: Contribution | null, sign: 1 | -1): void {
  if (!c) return;
  const row = structure.counts[c.kind] ?? { pending: 0, accepted: 0, rejected: 0 };
  row[c.status] = Math.max(0, row[c.status] + sign);
  if (row.pending + row.accepted + row.rejected === 0) delete structure.counts[c.kind];
  else structure.counts[c.kind] = row;
  if (c.unread) structure.needsClaude = Math.max(0, structure.needsClaude + sign);
}

/** Counts of a whole set of records (a new source). */
function countRecords(records: readonly StructuredRecord[], now: number): SourceStructure {
  const structure = emptyStructure(now);
  const withRows = new Set(records.flatMap((r) => (r.tableRecordId ? [r.tableRecordId] : [])));
  for (const r of records) addTo(structure, contribution(r, withRows.has(r.id)), 1);
  return structure;
}

/** Item records of these sources (gear tables and their rows live among them). A Dexie promise, awaited directly. */
function itemRecordsOf(sourceIds: readonly string[]) {
  return db.libraryRecords
    .where('[sourceId+kind]')
    .anyOf(sourceIds.map((id) => [id, 'item']))
    .toArray();
}

/** Each table's row (as read, by id) and whether rows of it exist among the given item records. */
function tableStates(
  ids: readonly string[],
  tables: readonly (StructuredRecord | undefined)[],
  items: readonly StructuredRecord[],
): Map<string, { record?: StructuredRecord; hasRows: boolean }> {
  const out = new Map<string, { record?: StructuredRecord; hasRows: boolean }>();
  ids.forEach((id, i) => {
    const record = tables[i];
    out.set(id, { record, hasRows: record?.span === 'table' && items.some((r) => r.tableRecordId === id) });
  });
  return out;
}

/**
 * Write `puts` and delete `deletes`, adjusting each touched source's counts by the records' deltas.
 * Runs inside the caller's rw transaction on libraryRecords + library, awaiting only Dexie promises
 * directly (nested native async helpers can lose the transaction zone). A source missing from the
 * library (deleted meanwhile) gets its rows written but no counts.
 */
async function writeCounted(puts: readonly StructuredRecord[], deletes: readonly string[]): Promise<void> {
  const ids = [...new Set([...puts.map((r) => r.id), ...deletes])];
  const olds = await db.libraryRecords.bulkGet(ids);
  const oldById = new Map(ids.map((id, i) => [id, olds[i]]));
  const newById = new Map(puts.map((r) => [r.id, r]));

  // Tables whose "rows exist" may change: written or deleted tables, and tables of written or deleted rows.
  const tables = new Set<string>();
  const tableSources = new Set<string>();
  for (const r of [...puts, ...olds]) {
    if (!r) continue;
    if (r.span === 'table') tables.add(r.id);
    if (r.tableRecordId) tables.add(r.tableRecordId);
    if (r.span === 'table' || r.tableRecordId) tableSources.add(r.sourceId);
  }
  const tableIds = [...tables];
  const beforeTables = tableIds.length ? await db.libraryRecords.bulkGet(tableIds) : [];
  const beforeItems = tableIds.length ? await itemRecordsOf([...tableSources]) : [];
  const before = tableStates(tableIds, beforeTables, beforeItems);

  if (deletes.length) await db.libraryRecords.bulkDelete([...deletes]);
  if (puts.length) await db.libraryRecords.bulkPut([...puts]);

  const afterTables = tableIds.length ? await db.libraryRecords.bulkGet(tableIds) : [];
  const afterItems = tableIds.length ? await itemRecordsOf([...tableSources]) : [];
  const after = tableStates(tableIds, afterTables, afterItems);

  const deltas = new Map<string, { c: Contribution; sign: 1 | -1 }[]>();
  const push = (sourceId: string | undefined, c: Contribution | null, sign: 1 | -1) => {
    if (!sourceId || !c) return;
    const list = deltas.get(sourceId) ?? [];
    list.push({ c, sign });
    deltas.set(sourceId, list);
  };
  for (const id of ids) {
    if (tables.has(id)) continue;
    const old = oldById.get(id);
    const next = newById.get(id);
    push(old?.sourceId, contribution(old, false), -1);
    push(next?.sourceId, contribution(next, false), 1);
  }
  for (const id of tableIds) {
    const was = before.get(id);
    const now = after.get(id);
    push(was?.record?.sourceId, contribution(was?.record, was?.hasRows ?? false), -1);
    push(now?.record?.sourceId, contribution(now?.record, now?.hasRows ?? false), 1);
  }

  const now = Date.now();
  for (const [sourceId, list] of deltas) {
    const source = await db.library.get(sourceId);
    if (!source) continue;
    if (!source.structure) {
      // First structured write for this source (or counts lost): count every row it now has.
      const all = await db.libraryRecords.where('sourceId').equals(sourceId).toArray();
      await db.library.update(sourceId, { structure: countRecords(all, now) });
      continue;
    }
    const structure: SourceStructure = { ...source.structure, counts: cloneCounts(source.structure.counts) };
    for (const { c, sign } of list) addTo(structure, c, sign);
    await db.library.update(sourceId, { structure });
  }
}

function cloneCounts(counts: SourceStructure['counts']): SourceStructure['counts'] {
  const out: SourceStructure['counts'] = {};
  for (const [kind, row] of Object.entries(counts) as [StructuredKind, { pending: number; accepted: number; rejected: number }][]) {
    out[kind] = { ...row };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Throttled live queries
// ---------------------------------------------------------------------------

/** Emits the first value at once, then at most one value per `ms` (always the latest; a trailing one is never lost). */
export function throttler<T>(emit: (value: T) => void, ms: number, now: () => number = Date.now): { push(value: T): void; cancel(): void } {
  let last = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: { value: T } | undefined;
  const flush = () => {
    timer = undefined;
    if (!latest) return;
    const { value } = latest;
    latest = undefined;
    last = now();
    emit(value);
  };
  return {
    push(value: T) {
      latest = { value };
      if (timer !== undefined) return;
      const wait = last + ms - now();
      if (wait <= 0) flush();
      else timer = setTimeout(flush, wait);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      latest = undefined;
    },
  };
}

/** A Dexie live query whose results reach React at most every LIVE_THROTTLE_MS. `key` null = no query (undefined). */
function useThrottledLiveQuery<T>(key: string | null, query: () => Promise<T>): T | undefined {
  const [state, setState] = useState<{ key: string; value: T } | null>(null);
  useEffect(() => {
    if (key === null) return undefined;
    const throttle = throttler<T>((value) => setState({ key, value }), LIVE_THROTTLE_MS);
    const subscription = liveQuery(query).subscribe({
      next: (value) => throttle.push(value),
      error: (err: unknown) => console.error('[storage] A live query failed:', err),
    });
    return () => {
      subscription.unsubscribe();
      throttle.cancel();
    };
  }, [key, query]);
  return key !== null && state?.key === key ? state.value : undefined;
}
