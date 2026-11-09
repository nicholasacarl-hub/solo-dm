/**
 * Offline parsers (spec §3.9): fill the same wire object Claude returns, by regex segmentation and the
 * heading scan, dispatched per kind (monster, spell, magic item, item: E2; feat, background, species,
 * class, subclass: E4). `missing` lists the wire fields left empty.
 *
 * CONTRACT (Day 0 stub). Owner: E2 (the dispatcher).
 */
import type { StructuredKind } from '@/types';
import type { Candidate } from '../segment';
import type { Wire } from '../wire';

export interface OfflineParse<K extends StructuredKind> {
  wire: Wire<K>;
  /** Top-level wire fields the parser couldn't fill (left at their sentinels). */
  missing: string[];
}

export function parseOffline<K extends StructuredKind>(candidate: Candidate & { kind: K }): OfflineParse<K> {
  void candidate;
  throw new Error('data/structured/parse: parseOffline not implemented');
}
