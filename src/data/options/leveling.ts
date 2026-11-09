/**
 * DAY-0 PLACEHOLDER for E4's helper move (spec §5.2, §5.4): src/ui/builder/leveling.ts moves here with
 * its tests (git mv over this file; the old path keeps a one-line re-export shim), and gainedFeatures
 * moves in from src/ui/sheet/LevelUpDialog.tsx with the catch-up of §5.4. Until then the @/data barrel
 * exports these names from here, and the UI keeps importing the originals.
 */
import type { AbilityScores, BuilderData, Character, ClassOption, Feature, SubclassOption } from '@/types';

export type LevelingData = Pick<BuilderData, 'classes' | 'species'>;

export interface GainedFeaturesOptions {
  /** Features already on the sheet: catch-up skips any of these. */
  have?: readonly Pick<Feature, 'name' | 'source' | 'sourceName'>[];
  /** The subclass is chosen at this level-up: every subclass feature up to classLevel the sheet lacks is added (catch-up). */
  subclassChosenNow?: boolean;
}

/**
 * The features gained at a class level, as sheet features: the class's features at this level minus
 * "Subclass feature" placeholders, then the subclass's (with catch-up when it is chosen now); uses from
 * inferFeatureUses, ref from the def, sourceName "<Subclass> <level>". Signature defined from §5.4.
 */
export function gainedFeatures(
  cls: ClassOption,
  classLevel: number,
  sub: SubclassOption | undefined,
  ctx: { scores: AbilityScores; characterLevel: number },
  opts?: GainedFeaturesOptions,
): Omit<Feature, 'id'>[] {
  void [cls, classLevel, sub, ctx, opts];
  throw new Error('data/options/leveling: gainedFeatures not implemented (E4 moves it here)');
}

export function refreshFeatureUses(c: Character, data: LevelingData | null | undefined): Character {
  void [c, data];
  throw new Error('data/options/leveling: refreshFeatureUses not implemented (E4 moves it here)');
}

export function featureUseChanges(before: Character, after: Character): string[] {
  void [before, after];
  throw new Error('data/options/leveling: featureUseChanges not implemented (E4 moves it here)');
}
