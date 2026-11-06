/**
 * Leveling and resting under the 2024 rules.
 */
import type { Ability, CasterType, Character, Feature, GameEvent, HitDie, RollResult } from '@/types';
import type { Rng } from './dice';

/** XP needed to reach each level; index 0 = level 1 (0 XP) … index 19 = level 20. */
export const XP_THRESHOLDS: readonly number[] = [];

export function levelForXp(_xp: number): number {
  throw new Error('not implemented');
}

/** XP still needed for the next level, or null at level 20. */
export function xpToNextLevel(_c: Character): number | null {
  throw new Error('not implemented');
}

export interface LevelUpOptions {
  /** Class to gain a level in (existing class name, or a new class for multiclassing). */
  className: string;
  classId?: string;
  /** Required when adding a new class. */
  hitDie?: HitDie;
  casterType?: CasterType;
  spellcastingAbility?: Ability;
  subclass?: string;
  /** 'average' = fixed value (die/2 + 1) + CON mod; 'roll' = roll the hit die + CON mod; minimum 1 HP. */
  hpMethod: 'average' | 'roll' | { fixed: number };
  newFeatures?: Omit<Feature, 'id'>[];
  rng?: Rng;
}

export interface LevelUpResult {
  character: Character;
  events: GameEvent[];
  newLevel: number;
  hpGained: number;
  hpRoll?: RollResult;
  /** Choices the player still has to make, e.g. "Level 4: choose an Ability Score Improvement or a feat". */
  reminders: string[];
}

/** Gain one level: class level, HP max and current HP, hit dice, spell slots (recomputed), features. */
export function levelUp(_c: Character, _opts: LevelUpOptions): LevelUpResult {
  throw new Error('not implemented');
}

/**
 * Spend one hit die during a short rest: roll it + CON modifier and heal that much
 * (follow SRD 5.2.1 for the minimum). Fails with a warning if no die of that size remains.
 */
export function spendHitDie(
  _c: Character,
  _die: HitDie,
  _opts?: { rng?: Rng; roll?: RollResult },
): { character: Character; events: GameEvent[]; roll: RollResult | null; healed: number } {
  throw new Error('not implemented');
}

/** Short rest: restores features that recharge on a short rest and pact magic slots (hit dice are spent separately). */
export function applyShortRest(_c: Character): { character: Character; events: GameEvent[] } {
  throw new Error('not implemented');
}

/**
 * Long rest (2024): regain all HP and spent hit dice per SRD 5.2.1, all spell slots, features that
 * recharge on short/long rest or dawn; exhaustion −1; death saves reset; temp HP removed.
 */
export function applyLongRest(_c: Character): { character: Character; events: GameEvent[] } {
  throw new Error('not implemented');
}
