/**
 * All spells from the rules index (SRD + the player's enabled imports + homebrew), as SpellInfo. The list
 * follows the index version (D28): accepting a book's spells re-lists them without a reload, and the
 * previous list stays while the index rebuilds.
 */
import { useMemo } from 'react';
import { useRulesIndexState } from '@/data';
import { spellInfo, type SpellInfo } from './spells';

export interface SpellOptionsState {
  spells: SpellInfo[];
  loading: boolean;
  error: string | null;
}

export function useSpellOptions(): SpellOptionsState {
  const { index, error } = useRulesIndexState();
  const spells = useMemo(() => (index ? index.list({ kind: 'spell' }).map(spellInfo) : []), [index]);
  return { spells, loading: index === null && !error, error: index ? null : error };
}
