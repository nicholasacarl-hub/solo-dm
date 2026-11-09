/**
 * JSON packs and "Download book data" (spec §3.12, documented in docs/PACKS.md): one `solo-dm-pack` v1
 * format built on DATA_SCHEMAS. Pure; the storage write is saveLibrarySourceWithRecords. Campaign
 * exports and sync never import this module (src/test/layering.test.ts).
 *
 * CONTRACT (Day 0 stub). Owner: E1.
 */
import type { CompendiumEntry, ContentKind, LibrarySource, StructuredKind, StructuredRecord } from '@/types';

export interface PackFileV1 {
  format: 'solo-dm-pack';
  version: 1;
  schemaVersion: 1;                    // STRUCTURED_SCHEMA_VERSION of the records' data
  title: string;
  license?: string; attribution?: string; notes?: string;
  /** "Download book data" files only: the book they were made from. */
  bookFingerprint?: string;
  entries: { id: string; name: string; kind?: ContentKind; summary?: string; text: string; path?: string[] }[];
  records?: PackRecordV1[];
}
export interface PackRecordV1 {
  kind: StructuredKind;
  name: string;
  entries: string[];                   // pack-local entry ids, primary first
  span?: 'entry' | 'section' | 'row';  // default 'entry' for one entry, 'section' for several
  rowIndex?: number;
  parentClass?: string;                // subclass: a class record's name in this pack, or an SRD class name
  /** DATA_SCHEMAS[kind]; every TextSpan may be { entries: string[]; from; to } (pack-local ids) or a plain string (inline text). */
  data: unknown;
  /** Book-data files only: its status on the device that made the file. Never applied without the player's tap. */
  reviewedStatus?: 'accepted' | 'pending';
}
export interface PackImport {
  source: Pick<LibrarySource, 'title' | 'license' | 'attribution' | 'notes' | 'fingerprint'>;
  entries: CompendiumEntry[]; records: StructuredRecord[];
  issues: { path: string; message: string }[];          // first 20 listed
  reviewedElsewhere: number;                             // records with reviewedStatus 'accepted'
}

/** A parsed JSON value that claims to be a pack (`format: 'solo-dm-pack'`); parsePack checks the rest. */
export function isPackFile(json: unknown): boolean {
  return typeof json === 'object' && json !== null && (json as { format?: unknown }).format === 'solo-dm-pack';
}

/** Pure. Throws a readable Error for a file that can't be imported at all; skips invalid records with issues. */
export function parsePack(json: unknown, opts: { sourceId: string; sourceName: string }): PackImport {
  void [json, opts];
  throw new Error('data/structured/packs: parsePack not implemented');
}

/** Pure. Every entry in ordinal order and every non-rejected record with its reviewedStatus. */
export function exportPack(source: LibrarySource, entries: CompendiumEntry[], records: StructuredRecord[]): PackFileV1 {
  void [source, entries, records];
  throw new Error('data/structured/packs: exportPack not implemented');
}
