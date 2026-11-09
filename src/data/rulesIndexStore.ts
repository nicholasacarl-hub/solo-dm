/**
 * The app-wide rules index: built once from the SRD plus the player's enabled imports and homebrew,
 * rebuilt after invalidateRulesIndex(). React components subscribe with useRulesIndex().
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { CompendiumEntry, LibrarySource, StructuredRecord } from '@/types';
import { getLibraryEntries, listHomebrew } from '@/storage';
import { createRulesIndex } from './search';
import { loadSrdCompendium } from './srd';
import { errorMessage } from './text';
import type { RulesIndex } from './index';

interface Snapshot {
  /** Bumped by invalidateRulesIndex(). */
  version: number;
  /** The newest index built (possibly for an older version while a rebuild runs). */
  index: RulesIndex | null;
  /** Error of the latest failed build, if it failed. */
  error: string | null;
}

let version = 0;
let snapshot: Snapshot = { version, index: null, error: null };
let building: { version: number; promise: Promise<RulesIndex> } | null = null;
let builtVersion = -1;
const listeners = new Set<() => void>();

function publish(patch: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

/** Player data from storage; the SRD is still indexed when storage is unavailable. */
async function optional(what: string, load: () => Promise<CompendiumEntry[]>): Promise<CompendiumEntry[]> {
  try {
    return await load();
  } catch (err) {
    console.warn(`Rules index: couldn't read ${what} (${errorMessage(err)}); indexing without it.`);
    return [];
  }
}

async function buildIndex(): Promise<RulesIndex> {
  const [srd, imports, homebrew] = await Promise.all([
    loadSrdCompendium(),
    optional('imported library entries', () => getLibraryEntries()),
    optional('homebrew', () => listHomebrew()),
  ]);
  return createRulesIndex([...srd, ...imports, ...homebrew]);
}

export function getRulesIndex(): Promise<RulesIndex> {
  if (snapshot.index && builtVersion === version) return Promise.resolve(snapshot.index);
  if (building && building.version === version) return building.promise;
  const target = version;
  const promise = buildIndex().then(
    (index) => {
      if (target === version) {
        builtVersion = target;
        publish({ index, error: null });
      }
      return index;
    },
    (err: unknown) => {
      if (building?.promise === promise) building = null;
      if (target === version) publish({ error: errorMessage(err) });
      throw err;
    },
  );
  building = { version: target, promise };
  return promise;
}

export function invalidateRulesIndex(): void {
  version += 1;
  building = null;
  publish({ version, error: null });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => snapshot;

/** Index state for components that also want loading and error information. */
export function useRulesIndexState(): { index: RulesIndex | null; loading: boolean; error: string | null } {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const stale = builtVersion !== current.version;
  useEffect(() => {
    if (stale && !current.error) {
      getRulesIndex().catch((err: unknown) => console.error('Rules index failed to build:', err));
    }
  }, [stale, current.version, current.error]);
  return { index: current.index, loading: stale && !current.error, error: current.error };
}

/** The index, or null while it is first built. After invalidation the previous index is kept until the new one is ready. */
export function useRulesIndex(): RulesIndex | null {
  return useRulesIndexState().index;
}

// ---------------------------------------------------------------------------
// Structured imports (spec §5.1): one library snapshot per index version, shared by the index and the
// builder data.
// ---------------------------------------------------------------------------

export interface LibrarySnapshot {
  version: number;
  sources: LibrarySource[];                          // enabled imports
  entriesById: ReadonlyMap<string, CompendiumEntry>; // their entries
  accepted: StructuredRecord[];                      // accepted, DATA_SCHEMAS-valid records of those sources
}

/** Read once per rules-index version (invalidateRulesIndex() starts a new one). CONTRACT (Day 0 stub). Owner: E1. */
export async function getLibrarySnapshot(): Promise<LibrarySnapshot> {
  throw new Error('data/rulesIndexStore: getLibrarySnapshot not implemented');
}

/** Tests only: forget the built index and listeners' state. */
export function resetRulesIndex(): void {
  version += 1;
  building = null;
  builtVersion = -1;
  snapshot = { version, index: null, error: null };
}
