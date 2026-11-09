/**
 * Character-builder data (classes, species, backgrounds, feats, equipment): the SRD plus the accepted
 * options of the player's switched-on books (spec §5.1), merged without touching the SRD object.
 *
 * Cached per rules-index version (D28): invalidateRulesIndex() starts a new library snapshot, so every
 * call site that refreshes the index refreshes the builder too. Without imports (or when the library
 * can't be read) the data is the SRD object itself.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { OPTION_KINDS, type BuilderData, type StructuredKind } from '@/types';
import { listLibrarySources, listRecords } from '@/storage';
import { getLibrarySnapshot, useRulesIndexState } from './rulesIndexStore';
import { loadSrdBuilderData } from './srd';
import { importedOptions, mergeBuilderData, type MergeProblem } from './structured/merge';
import { errorMessage } from './text';

interface Built {
  /** LibrarySnapshot.version it was merged for; null when the library couldn't be read (SRD only). */
  version: number | null;
  data: BuilderData;
  problems: MergeProblem[];
}

let latest: Built | null = null;
let pending: Promise<Built> | null = null;

async function build(): Promise<Built> {
  const srd = await loadSrdBuilderData();
  let snapshot: Awaited<ReturnType<typeof getLibrarySnapshot>>;
  try {
    snapshot = await getLibrarySnapshot();
  } catch (err) {
    console.warn(`Builder data: couldn't read the library (${errorMessage(err)}); using the SRD only.`);
    return { version: null, data: srd, problems: [] };
  }
  if (latest && latest.version === snapshot.version) return latest;
  const { data, problems } = mergeBuilderData(srd, importedOptions(snapshot));
  // Same data as before (no imports either time): keep the old object so memoized consumers don't churn.
  return { version: snapshot.version, data: latest && latest.data === data ? latest.data : data, problems };
}

/** The merged builder data for the current library (one merge per rules-index version). */
export async function loadBuilderData(): Promise<BuilderData> {
  return (await current()).data;
}

/** One build at a time; a call made while one runs shares it (the next call sees any newer version). */
function current(): Promise<Built> {
  if (pending) return pending;
  const promise: Promise<Built> = build().then(
    (built) => {
      if (pending === promise) pending = null;
      publish({ built, error: null });
      return built;
    },
    (err: unknown) => {
      if (pending === promise) pending = null;
      publish({ built: null, error: errorMessage(err) });
      throw err;
    },
  );
  pending = promise;
  return promise;
}

// ---------------------------------------------------------------------------
// React: the data, kept while a newer version builds; identity changes only with the version.
// ---------------------------------------------------------------------------

export interface BuilderDataState {
  data: BuilderData | null;
  error: string | null;
  loading: boolean;
}

let state: BuilderDataState = { data: null, error: null, loading: true };
const listeners = new Set<() => void>();

function publish(next: { built: Built | null; error: string | null }): void {
  if (next.built) latest = next.built;
  const data = latest?.data ?? null;
  const loading = data === null && next.error === null;
  if (state.data === data && state.error === next.error && state.loading === loading) return;
  state = { data, error: data ? null : next.error, loading };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getState = () => state;

export function useBuilderData(): BuilderDataState {
  const snapshot = useSyncExternalStore(subscribe, getState, getState);
  // Re-merge when the library changes: invalidateRulesIndex() re-renders every index subscriber.
  const { index, loading } = useRulesIndexState();
  useEffect(() => {
    current().catch(() => undefined); // the error is published to the state
  }, [index, loading]);
  return snapshot;
}

/** Problems of the latest merge ("Its class, Wickwright, isn't accepted yet…"), for the book page and the builder. */
export function getBuilderProblems(): MergeProblem[] {
  return latest?.problems ?? [];
}

/** Pending option records of switched-on books, for "3 more classes … are waiting for your review". */
export async function countUnreviewedOptions(): Promise<{ sourceId: string; title: string; kind: StructuredKind; count: number }[]> {
  const sources = (await listLibrarySources()).filter((s) => s.kind === 'import' && s.enabled);
  const out: { sourceId: string; title: string; kind: StructuredKind; count: number }[] = [];
  for (const source of sources) {
    const pendingRecords = await listRecords(source.id, { status: 'pending' });
    for (const kind of OPTION_KINDS) {
      const count = pendingRecords.filter((r) => r.kind === kind && r.data !== null).length;
      if (count) out.push({ sourceId: source.id, title: source.title, kind, count });
    }
  }
  return out;
}

/** Tests only: forget the merged data and its listeners' state. */
export function resetBuilderData(): void {
  latest = null;
  pending = null;
  state = { data: null, error: null, loading: true };
}
