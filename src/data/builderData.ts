/**
 * Character-builder data (classes, species, backgrounds, feats, equipment) from the SRD.
 */
import { useEffect, useState } from 'react';
import type { BuilderData } from '@/types';
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
