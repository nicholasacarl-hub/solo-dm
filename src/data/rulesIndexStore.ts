/**
 * The app-wide rules index: built once from the SRD plus the player's enabled imports and homebrew,
 * rebuilt after invalidateRulesIndex(). React components subscribe with useRulesIndex().
 */
import { useEffect, useSyncExternalStore } from 'react';
import { STRUCTURED_SCHEMA_VERSION, type CompendiumEntry, type LibrarySource, type StructuredRecord } from '@/types';
import { getAcceptedRecords, getLibraryEntries, listHomebrew, listLibrarySources } from '@/storage';
import { createRulesIndex } from './search';
import { loadSrdCompendium } from './srd';
import { materializeEntries } from './structured/materialize';
import { DATA_SCHEMAS } from './structured/schemas';
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
  const [srd, snap, homebrew] = await Promise.all([
    loadSrdCompendium(),
    getLibrarySnapshot(),
    optional('homebrew', () => listHomebrew()),
  ]);
  // Records beside entries (spec D1): accepted records are materialized on read, never written into the library.
  const imports = materializeEntries([...snap.entriesById.values()], snap.accepted, snap.sources);
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

/** Starts a new index version: the rules index, the library snapshot and the builder data (D28) all refresh. */
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

let librarySnapshot: { version: number; promise: Promise<LibrarySnapshot> } | null = null;

/** An accepted record the index and the builder may use: data that DATA_SCHEMAS accepts, from this app's schema version. */
function usableRecord(record: StructuredRecord): boolean {
  if (record.status !== 'accepted' || record.data === null || record.schemaVersion > STRUCTURED_SCHEMA_VERSION) return false;
  const schema = DATA_SCHEMAS[record.kind] as { safeParse(value: unknown): { success: boolean } } | undefined;
  return schema?.safeParse(record.data).success === true;
}

/** Entries in reading order (the numeric suffix of lib:<sourceId>:<n>), source by source. */
function readingOrder(entries: CompendiumEntry[], sources: readonly LibrarySource[]): CompendiumEntry[] {
  const rank = new Map(sources.map((s, i) => [s.id, i]));
  const ordinal = (id: string) => {
    const parts = id.split(':');
    return parts.length === 3 && /^\d+$/.test(parts[2]) ? Number(parts[2]) : Number.MAX_SAFE_INTEGER;
  };
  return [...entries].sort(
    (a, b) => (rank.get(a.sourceId) ?? 0) - (rank.get(b.sourceId) ?? 0) || ordinal(a.id) - ordinal(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

async function readLibrarySnapshot(target: number): Promise<LibrarySnapshot> {
  try {
    const sources = (await listLibrarySources()).filter((s) => s.kind === 'import' && s.enabled);
    const ids = sources.map((s) => s.id);
    const [entries, accepted] = ids.length ? await Promise.all([getLibraryEntries(ids), getAcceptedRecords(ids)]) : [[], []];
    const usable = accepted.filter(usableRecord);
    if (usable.length < accepted.length) {
      console.warn(`Rules index: ${accepted.length - usable.length} accepted structured record(s) failed validation and are left out.`);
    }
    return {
      version: target,
      sources,
      entriesById: new Map(readingOrder(entries, sources).map((e) => [e.id, e])),
      accepted: usable,
    };
  } catch (err) {
    console.warn(`Rules index: couldn't read imported library entries (${errorMessage(err)}); indexing without it.`);
    return { version: target, sources: [], entriesById: new Map(), accepted: [] };
  }
}

/**
 * The player's enabled imports, their entries (reading order) and their accepted, DATA_SCHEMAS-valid records:
 * read once per rules-index version (invalidateRulesIndex() starts a new one) and shared by the index and the
 * builder data. When storage can't be read it is empty (the SRD still works), as the index always was.
 */
export function getLibrarySnapshot(): Promise<LibrarySnapshot> {
  if (librarySnapshot && librarySnapshot.version === version) return librarySnapshot.promise;
  const target = version;
  const promise = readLibrarySnapshot(target);
  librarySnapshot = { version: target, promise };
  return promise;
}

/** The current rules-index version (bumped by invalidateRulesIndex()). */
export function rulesIndexVersion(): number {
  return version;
}

/** Tests only: forget the built index and listeners' state. */
export function resetRulesIndex(): void {
  version += 1;
  building = null;
  builtVersion = -1;
  librarySnapshot = null;
  snapshot = { version, index: null, error: null };
}
