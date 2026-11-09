/**
 * Character-builder data (classes, species, backgrounds, feats, equipment) from the SRD.
 */
import { useEffect, useState } from 'react';
import type { BuilderData, StructuredKind } from '@/types';
import type { MergeProblem } from './structured/merge';
import { loadSrdBuilderData } from './srd';
import { errorMessage } from './text';

let loaded: BuilderData | null = null;

export async function loadBuilderData(): Promise<BuilderData> {
  const data = await loadSrdBuilderData();
  loaded = data;
  return data;
}

export interface BuilderDataState {
  data: BuilderData | null;
  error: string | null;
  loading: boolean;
}

export function useBuilderData(): BuilderDataState {
  const [state, setState] = useState<BuilderDataState>(() =>
    loaded ? { data: loaded, error: null, loading: false } : { data: null, error: null, loading: true },
  );
  const hasData = state.data !== null;
  useEffect(() => {
    if (hasData) return;
    let alive = true;
    loadBuilderData().then(
      (data) => {
        if (alive) setState({ data, error: null, loading: false });
      },
      (err: unknown) => {
        if (alive) setState({ data: null, error: errorMessage(err), loading: false });
      },
    );
    return () => {
      alive = false;
    };
  }, [hasData]);
  return state;
}

// ---------------------------------------------------------------------------
// Structured imports (spec §5.1). CONTRACT (Day 0 stubs). Owner: E4 — loadBuilderData becomes the merged
// data (SRD + accepted imported options), cached per LibrarySnapshot.version.
// ---------------------------------------------------------------------------

/** Problems of the latest merge ("Its class, Wickwright, isn't accepted yet"), for the book page and the builder. */
export function getBuilderProblems(): MergeProblem[] {
  return []; // not implemented (Day-0 stub): safe default
}

/** Pending option records of switched-on books, for "3 more classes … are waiting for your review". */
export async function countUnreviewedOptions(): Promise<{ sourceId: string; title: string; kind: StructuredKind; count: number }[]> {
  throw new Error('data/builderData: countUnreviewedOptions not implemented');
}
