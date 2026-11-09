/**
 * The stats line (spec §6.7, pure): one line per kind — "Reviewed stats: Large Dragon · AC 17 (natural
 * armor) · …" — then "Adapted for 2024: …" when the entry has adaptation notes. The same text the DM's
 * lookups carry (inside the imported-content wrapper) and the review page previews.
 *
 * CONTRACT (Day 0 stub). Owner: E1.
 */
import type { CompendiumEntry } from '@/types';

/** '' for anything that isn't a reviewed import (SRD entries, raw chunks). */
export function statsLine(entry: CompendiumEntry): string {
  void entry;
  return ''; // not implemented (Day-0 stub): safe default
}
