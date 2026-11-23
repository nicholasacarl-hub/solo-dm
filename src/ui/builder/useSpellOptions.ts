/**
 * All spells from the rules index (SRD + the player's enabled imports + homebrew), as SpellInfo. The list
 * follows the index version (D28): accepting a book's spells re-lists them without a reload, and the
 * previous list stays while the index rebuilds. Given the campaign, homebrew is that campaign's and shared
 * homebrew only, as the rules search shows it, so a hero never takes a spell their DM can't look up.
 */
import { useMemo } from 'react';
import { useRulesIndexState } from '@/data';
import { spellInfo, type SpellInfo } from './spells';

export interface SpellOptionsState {
  spells: SpellInfo[];
  loading: boolean;
  error: string | null;
}

export function useSpellOptions(campaignId?: string | null): SpellOptionsState {
  const { index, error } = useRulesIndexState();
  const spells = useMemo(() => (index ? index.list({ kind: 'spell', campaignId }).map(spellInfo) : []), [index, campaignId]);
  return { spells, loading: index === null && !error, error: index ? null : error };
}
