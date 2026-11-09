/**
 * Detection (spec §3.2): the I/O wrapper around segment → parseOffline → normalize that writes a
 * source's records (re-runs follow §3.10's table) and stores its fingerprint if missing.
 *
 * CONTRACT (Day 0 stub). Owner: E2.
 */
import type { StructuredKind, StructuredRecord } from '@/types';

export interface DetectionSummary {
  byKind: Partial<Record<StructuredKind, { found: number; readyOffline: number; needClaude: number }>>;
  total: number; readyOffline: number; needClaude: number;
  leftOut: number;                                   // over the 5,000-record limit
  duplicateOf?: { id: string; title: string };       // another source with the same fingerprint
}

/** Local and free (~1–3 s for 300 pages); yields every 50 candidates. */
export async function detectStructure(sourceId: string, opts?: { onProgress?(done: number, total: number): void }): Promise<DetectionSummary> {
  void [sourceId, opts];
  throw new Error('data/structured/detect: detectStructure not implemented');
}

/** "All entries › Structure as…": a candidate the player marked (reason 'Marked by you'), read offline if possible. */
export async function structureEntryAs(sourceId: string, entryIds: string[], kind: StructuredKind): Promise<StructuredRecord> {
  void [sourceId, entryIds, kind];
  throw new Error('data/structured/detect: structureEntryAs not implemented');
}

/** Free; writes proposals where §3.10 says so. */
export async function rereadOffline(recordIds: string[]): Promise<void> {
  void recordIds;
  throw new Error('data/structured/detect: rereadOffline not implemented');
}
