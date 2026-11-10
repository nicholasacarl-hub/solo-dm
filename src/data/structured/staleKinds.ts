/**
 * Entry kinds the first version of the chunker guessed wrongly. Kinds are guessed once, at import, and
 * version 1 stored an entry as a feat whenever one of its first two lines was a "Prerequisite:" line,
 * so stronghold rooms and class options with one became feats. Today's rules read those as rules
 * (src/data/chunk.ts misreadAsFeatBefore); this corrects the stored kinds, quietly, once the app has
 * started and before each look through a book (detectStructure). The rules index refreshes when
 * anything changed. Imported text only: a JSON file's kinds are the file's own. Cheap (only entries
 * stored as feats are read), idempotent, and never throws: a failure leaves the kinds as they were.
 *
 * Owner: E2.
 */
import { getEntriesByKind, listLibrarySources, updateEntryKinds } from '@/storage';
import type { CompendiumEntry } from '@/types';
import { staleFeatKinds, type KindCorrection } from '../chunk';
import { invalidateRulesIndex } from '../rulesIndexStore';

/** The corrections for one book's entries stored as feats (an unreadable book gets none). */
function correctionsFor(sourceId: string, feats: readonly CompendiumEntry[]): KindCorrection[] {
  try {
    return staleFeatKinds(feats);
  } catch (error) {
    console.warn(`[library] Kept the stored kinds of book ${sourceId}: they couldn't be checked.`, error);
    return [];
  }
}

/** Correct stale kinds in every imported-text book, or in one; returns how many entries changed. */
export async function correctStaleKinds(sourceId?: string): Promise<number> {
  try {
    const sources = (await listLibrarySources()).filter(
      (s) => s.kind === 'import' && s.format !== 'json' && (sourceId === undefined || s.id === sourceId),
    );
    if (sources.length === 0) return 0;
    const feats = await getEntriesByKind('feat', sources.map((s) => s.id));
    const bySource = new Map<string, CompendiumEntry[]>();
    for (const e of feats) {
      const list = bySource.get(e.sourceId) ?? [];
      list.push(e);
      bySource.set(e.sourceId, list);
    }
    const fixes = [...bySource].flatMap(([id, list]) => correctionsFor(id, list));
    if (fixes.length === 0) return 0;
    await updateEntryKinds(fixes);
    invalidateRulesIndex();
    return fixes.length;
  } catch (error) {
    console.warn('[library] Could not check the kinds of imported entries.', error);
    return 0;
  }
}
