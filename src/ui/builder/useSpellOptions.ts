/**
 * All spells from the rules index (SRD + the player's enabled imports + homebrew), as SpellInfo.
 */
import { useEffect, useState } from 'react';
import { getRulesIndex } from '@/data';
import { spellInfo, type SpellInfo } from './spells';

export interface SpellOptionsState {
  spells: SpellInfo[];
  loading: boolean;
  error: string | null;
}

export function useSpellOptions(): SpellOptionsState {
  const [state, setState] = useState<SpellOptionsState>({ spells: [], loading: true, error: null });
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const index = await getRulesIndex();
        const spells = index.list({ kind: 'spell' }).map(spellInfo);
        if (alive) setState({ spells, loading: false, error: null });
      } catch (err) {
        if (alive) setState({ spells: [], loading: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return state;
}
