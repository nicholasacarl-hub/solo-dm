/**
 * Initiative tracker and NPC hit points. Pure functions over CombatState.
 */
import type { Combatant, CombatState, GameEvent, HitPoints } from '@/types';

/** Highest initiative first; ties broken by initiativeBonus, then the player first, then name. */
export function sortCombatants(_list: Combatant[]): Combatant[] {
  throw new Error('not implemented');
}

export function createCombat(_combatants: Combatant[], _encounterName?: string): CombatState {
  throw new Error('not implemented');
}

export function currentCombatant(_state: CombatState): Combatant | null {
  throw new Error('not implemented');
}

/** Advance to the next non-defeated combatant; increments the round when wrapping. */
export function nextTurn(_state: CombatState): CombatState {
  throw new Error('not implemented');
}

/** Insert by initiative; the current turn keeps pointing at the same creature. */
export function addCombatant(_state: CombatState, _combatant: Combatant): CombatState {
  throw new Error('not implemented');
}

export function removeCombatant(_state: CombatState, _id: string): CombatState {
  throw new Error('not implemented');
}

export function updateCombatant(_state: CombatState, _id: string, _patch: Partial<Combatant>): CombatState {
  throw new Error('not implemented');
}

/** Find by id, or by case-insensitive name ("goblin 2"). */
export function findCombatant(_state: CombatState, _idOrName: string): Combatant | undefined {
  throw new Error('not implemented');
}

/** Damage a non-player combatant: temp HP first; defeated at 0 HP. */
export function damageCombatant(
  _state: CombatState,
  _id: string,
  _amount: number,
): { state: CombatState; events: GameEvent[] } {
  throw new Error('not implemented');
}

export function healCombatant(
  _state: CombatState,
  _id: string,
  _amount: number,
): { state: CombatState; events: GameEvent[] } {
  throw new Error('not implemented');
}

/** Player-safe health description for hidden HP: "unhurt" | "scratched" | "bloodied" (≤ half) | "critical" (≤ 1/4) | "down". */
export function healthDescriptor(_hp: HitPoints): 'unhurt' | 'scratched' | 'bloodied' | 'critical' | 'down' {
  throw new Error('not implemented');
}

/**
 * Text summary of the tracker: round, turn order with initiative, HP, AC, conditions.
 * forPlayer = true hides exact HP of hideHp combatants (uses healthDescriptor).
 */
export function summarizeCombat(_state: CombatState, _opts?: { forPlayer?: boolean }): string {
  throw new Error('not implemented');
}
