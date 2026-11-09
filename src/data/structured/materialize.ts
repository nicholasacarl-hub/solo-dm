/**
 * Materialized index entries (spec §6.1, pure): accepted records become SRD-shaped rules-index entries
 * on read, beside the raw chunks (records beside entries, D1). One-entry records keep their chunk id;
 * sections and table rows get four-segment ids; hidden chunk ids stay resolvable as `data.aliasIds`.
 *
 * CONTRACT (Day 0 stub). Owner: E1.
 */
import type { CompendiumEntry, LibrarySource, StructuredRecord } from '@/types';

/** Enabled entries + accepted, valid records → index entries in reading order. No accepted records → `entries` itself. */
export function materializeEntries(entries: CompendiumEntry[], accepted: StructuredRecord[], sources: LibrarySource[]): CompendiumEntry[] {
  void [accepted, sources];
  return entries; // not implemented (Day-0 stub): safe default = the no-imports identity
}

/** True for an entry materialized from an accepted record (data.recordId is a string). SRD entries never are. */
export function isReviewedImport(entry: CompendiumEntry): boolean {
  return typeof entry.data?.recordId === 'string';
}
