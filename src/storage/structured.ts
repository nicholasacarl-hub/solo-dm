/**
 * Structured-imports storage (spec §2.5): records and jobs (Dexie version 3 tables `libraryRecords` and
 * `libraryJobs`, landed by E1 on Day 1), denormalized counts on the source row, fingerprints, and the
 * "Used by …" query. Neither table is part of campaignTables(): like the library, they never leave this
 * device.
 *
 * CONTRACT (Day 0 stubs). Owner: E1. The two hooks return undefined ("loading") until implemented.
 */
import type {
  CompendiumEntry,
  ExtractionJob,
  JobStatus,
  LibrarySource,
  RecordStatus,
  RunState,
  StructuredKind,
  StructuredRecord,
} from '@/types';

/** A source's entries in reading order (numeric suffix of lib:<sourceId>:<n>, not IndexedDB string order). */
export async function getSourceEntries(sourceId: string): Promise<CompendiumEntry[]> {
  void sourceId;
  throw new Error('storage/structured: getSourceEntries not implemented');
}

export async function listRecords(sourceId: string, opts?: { kind?: StructuredKind; status?: RecordStatus }): Promise<StructuredRecord[]> {
  void [sourceId, opts];
  throw new Error('storage/structured: listRecords not implemented');
}

/** Live query (Dexie) over the [sourceId+status] / [sourceId+kind] indexes, re-emitting at most every 500 ms (a 500-record book ≈ 1 MB). */
export function useRecords(
  sourceId: string | undefined,
  filter?: { status?: RecordStatus; kind?: StructuredKind },
): StructuredRecord[] | undefined {
  void [sourceId, filter];
  return undefined; // not implemented (Day-0 stub): safe default = still loading
}

export async function getRecords(ids: string[]): Promise<(StructuredRecord | undefined)[]> {
  void ids;
  throw new Error('storage/structured: getRecords not implemented');
}

/** Upsert; adjusts source.structure.counts by the delta of each written record (bulkGet of the old rows, same transaction). */
export async function putRecords(records: StructuredRecord[]): Promise<void> {
  void records;
  throw new Error('storage/structured: putRecords not implemented');
}

/** Status changes (accept, reject, undo). Returns the previous statuses (for Undo). Sets reviewedAt. */
export async function setRecordStatus(ids: string[], status: RecordStatus): Promise<{ id: string; status: RecordStatus }[]> {
  void [ids, status];
  throw new Error('storage/structured: setRecordStatus not implemented');
}

export async function deleteRecords(ids: string[]): Promise<void> {
  void ids;
  throw new Error('storage/structured: deleteRecords not implemented');
}

/** Accepted records of enabled import sources (or of the given sources). */
export async function getAcceptedRecords(sourceIds?: string[]): Promise<StructuredRecord[]> {
  void sourceIds;
  throw new Error('storage/structured: getAcceptedRecords not implemented');
}

/** Records of a job in a run state, in queue order (STRUCTURED_KINDS, then reading order). */
export async function listJobRecords(jobId: string, runState: RunState): Promise<StructuredRecord[]> {
  void [jobId, runState];
  throw new Error('storage/structured: listJobRecords not implemented');
}

export async function putJob(job: ExtractionJob): Promise<void> {
  void job;
  throw new Error('storage/structured: putJob not implemented');
}

export async function getJob(id: string): Promise<ExtractionJob | undefined> {
  void id;
  throw new Error('storage/structured: getJob not implemented');
}

export async function listJobs(filter?: { sourceId?: string; status?: JobStatus[] }): Promise<ExtractionJob[]> {
  void filter;
  throw new Error('storage/structured: listJobs not implemented');
}

export function useJobs(sourceId?: string): ExtractionJob[] | undefined {
  void sourceId;
  return undefined; // not implemented (Day-0 stub): safe default = still loading
}

/** Lifetime spend on structuring (sum of job usage, books still in the library). */
export async function structuringSpendUsd(): Promise<number> {
  throw new Error('storage/structured: structuringSpendUsd not implemented');
}

/** db.library.update only. */
export async function setSourceFingerprint(sourceId: string, fingerprint: string): Promise<void> {
  void [sourceId, fingerprint];
  throw new Error('storage/structured: setSourceFingerprint not implemented');
}

export async function findSourcesByFingerprint(fingerprint: string): Promise<LibrarySource[]> {
  void fingerprint;
  throw new Error('storage/structured: findSourcesByFingerprint not implemented');
}

/** Characters with a ref into this source (for "Used by …" on switch-off / delete). */
export async function charactersUsingSource(sourceId: string): Promise<{ campaignId: string; campaignName: string; characterName: string }[]> {
  void sourceId;
  throw new Error('storage/structured: charactersUsingSource not implemented');
}

/** Pack import: a new source with its entries and records in one transaction. */
export async function saveLibrarySourceWithRecords(source: LibrarySource, entries: CompendiumEntry[], records: StructuredRecord[]): Promise<void> {
  void [source, entries, records];
  throw new Error('storage/structured: saveLibrarySourceWithRecords not implemented');
}
