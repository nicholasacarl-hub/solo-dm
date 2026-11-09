/**
 * DAY-0 PLACEHOLDER for E4's helper move (spec §5.2): src/ui/builder/featureUses.ts moves here with its
 * tests (git mv over this file; the old path keeps a one-line re-export shim). Until then the @/data
 * barrel exports these names from here, and the UI keeps importing the originals.
 */
import type { AbilityScores, ClassOption, FeatureUses } from '@/types';

/** The same type as src/ui/builder/featureUses.ts's UsesContext. */
export interface UsesContext {
  /** Class level for class and subclass features; character level for species traits and feats. */
  level: number;
  proficiencyBonus: number;
  scores: AbilityScores;
  /** The owning class (for level-table columns), if any. */
  cls?: ClassOption;
}

export function inferFeatureUses(name: string, description: string, ctx: UsesContext): FeatureUses | undefined {
  void [name, description, ctx];
  throw new Error('data/options/featureUses: inferFeatureUses not implemented (E4 moves it here)');
}
