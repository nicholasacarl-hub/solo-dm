/**
 * Derived character statistics under the 2024 rules (SRD 5.2.1). Pure functions.
 */
import type {
  Ability,
  Attack,
  Character,
  EquipmentOption,
  PlayerRollRequest,
  Skill,
} from '@/types';

/** floor((score - 10) / 2) */
export function abilityModifier(_score: number): number {
  throw new Error('not implemented');
}

/** "+3", "+0", "−1" (uses a true minus sign). */
export function formatModifier(_mod: number): string {
  throw new Error('not implemented');
}

/** +2 at levels 1–4, +3 at 5–8, +4 at 9–12, +5 at 13–16, +6 at 17–20. */
export function proficiencyBonus(_level: number): number {
  throw new Error('not implemented');
}

/** Total character level (sum of class levels, minimum 1). */
export function characterLevel(_c: Character): number {
  throw new Error('not implemented');
}

/** 2024 Exhaustion: −2 × exhaustion level applied to every d20 test (0 when not exhausted). */
export function exhaustionPenalty(_c: Character): number {
  throw new Error('not implemented');
}

/** Skill modifier: ability mod + floor(PB × proficiency level). Excludes the exhaustion penalty. */
export function skillModifier(_c: Character, _skill: Skill): number {
  throw new Error('not implemented');
}

export function savingThrowModifier(_c: Character, _ability: Ability): number {
  throw new Error('not implemented');
}

/** Raw ability check (no skill): the ability modifier. */
export function abilityCheckModifier(_c: Character, _ability: Ability): number {
  throw new Error('not implemented');
}

/** DEX modifier + initiativeBonusExtra. */
export function initiativeModifier(_c: Character): number {
  throw new Error('not implemented');
}

/** 10 + Perception modifier + passivePerceptionExtra. */
export function passivePerception(_c: Character): number {
  throw new Error('not implemented');
}

/** The character's spellcasting ability, or null for non-casters. */
export function spellcastingAbility(_c: Character): Ability | null {
  throw new Error('not implemented');
}

/** 8 + PB + spellcasting ability modifier, or null for non-casters. */
export function spellSaveDC(_c: Character, _ability?: Ability): number | null {
  throw new Error('not implemented');
}

/** PB + spellcasting ability modifier, or null for non-casters. */
export function spellAttackBonus(_c: Character, _ability?: Ability): number | null {
  throw new Error('not implemented');
}

/** Ability modifier used by an attack (resolves 'finesse' and 'spell'). */
export function attackAbilityModifier(_c: Character, _attack: Attack): number {
  throw new Error('not implemented');
}

/** Attack roll bonus: ability mod + PB (if proficient) + attackBonusExtra. */
export function attackBonus(_c: Character, _attack: Attack): number {
  throw new Error('not implemented');
}

/**
 * Damage expression including the ability modifier (unless addAbilityToDamage === false),
 * e.g. "1d8+3". With critical=true the dice are doubled ("2d8+3").
 */
export function attackDamageExpression(_c: Character, _attack: Attack, _critical?: boolean): string {
  throw new Error('not implemented');
}

/** Walking speed after exhaustion (−5 ft per level) and speed-zeroing conditions (grappled, restrained...). */
export function effectiveSpeed(_c: Character): number {
  throw new Error('not implemented');
}

/** Armor class from equipped armor/shield in the inventory (falls back to 10 + DEX). Returns a formula note. */
export function computeArmorClass(_c: Character, _catalog: EquipmentOption[]): { ac: number; formula: string } {
  throw new Error('not implemented');
}

/**
 * Modifier and label for a player roll request, e.g. { modifier: 5, label: "Stealth check (DEX)" }.
 * Includes the exhaustion penalty for d20 tests. For 'damage' / 'custom' / 'hit-die' the modifier is 0
 * and the expression carries any bonus.
 */
export function rollRequestModifier(_c: Character, _req: PlayerRollRequest): { modifier: number; label: string } {
  throw new Error('not implemented');
}
