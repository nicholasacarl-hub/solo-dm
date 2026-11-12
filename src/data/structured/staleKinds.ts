/**
 * Entry kinds an earlier version of the chunker guessed wrongly. Kinds are guessed once, at import:
 * version 1 stored an entry as a feat whenever one of its first two lines was a "Prerequisite:" line
 * (stronghold rooms, class options), and versions 1 and 2 took a mention in prose for a spell, monster
 * or magic item. Today's rules read those as what they are (src/data/chunk.ts misreadBefore); this
 * corrects the stored kinds, quietly, once the app has started and before each look through a book
 * (detectStructure). The rules index refreshes when anything changed. Imported text only: a JSON file's
 * own kinds are the file's (book data of an imported text is corrected too). Cheap (only entries stored as those kinds are read), idempotent, and never
 * throws: a failure leaves the stored kinds as they were, and detection still reads the book with today's
 * kinds (chunk.ts withCurrentKinds).
 *
 * Owner: E2.
 */
import { useSyncExternalStore } from 'react';
import { getEntriesByKind, listLibrarySources, updateEntryKinds } from '@/storage';
import type { CompendiumEntry, LibrarySource } from '@/types';
import { GUESSED_ENTITY_KINDS, kindsAreGuesses, staleEntryKinds, type KindCorrection } from '../chunk';
import { invalidateRulesIndex } from '../rulesIndexStore';

// Bumped whenever stored kinds were corrected, so an open book page reads its entries again.
let correctedVersion = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getVersion = () => correctedVersion;

/** A number that changes whenever stored entry kinds were corrected (a component reloads the entries it shows). */
export function useCorrectedKindsVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

/** Whether a book's kinds are guesses this corrects: imported text and its book data (a JSON file's own kinds are the file's). */
export const guessedKinds = (source: Pick<LibrarySource, 'kind' | 'format' | 'kindsGuessed'>): boolean => kindsAreGuesses(source);


/** The corrections for one book's entries (an unreadable book gets none). */
function correctionsFor(sourceId: string, entries: readonly CompendiumEntry[]): KindCorrection[] {
  try {
    return staleEntryKinds(entries);
  } catch (error) {
    console.warn(`[library] Kept the stored kinds of book ${sourceId}: they couldn't be checked.`, error);
    return [];
  }
}

/** Correct stale kinds in every imported-text book, or in one; returns how many entries changed. */
export async function correctStaleKinds(sourceId?: string): Promise<number> {
  try {
    const sources = (await listLibrarySources()).filter((s) => guessedKinds(s) && (sourceId === undefined || s.id === sourceId));
    if (sources.length === 0) return 0;
    const stored = await getEntriesByKind(GUESSED_ENTITY_KINDS, sources.map((s) => s.id));
    const bySource = new Map<string, CompendiumEntry[]>();
    for (const e of stored) {
      const list = bySource.get(e.sourceId) ?? [];
      list.push(e);
      bySource.set(e.sourceId, list);
    }
    const fixes = [...bySource].flatMap(([id, list]) => correctionsFor(id, list));
    if (fixes.length === 0) return 0;
    await updateEntryKinds(fixes);
    invalidateRulesIndex();
    correctedVersion += 1;
    for (const listener of listeners) listener();
    return fixes.length;
  } catch (error) {
    console.warn('[library] Could not check the kinds of imported entries.', error);
    return 0;
  }
}
