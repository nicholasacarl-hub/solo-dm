/**
 * Text renderings of game state for the DM (system prompt snapshot, tool results, per-turn status).
 * Keep them compact and deterministic (stable ordering) — they feed the prompt cache.
 */
import type { Character } from '@/types';

/**
 * One- or two-line status, e.g.
 * "Mira (Wizard 3) · HP 14/20 (+5 temp) · AC 12 · Slots 1st 2/4, 2nd 1/2 · Hit Dice 2/3 d6 ·
 *  Conditions: Poisoned · Exhaustion 1 · Concentrating: Fly · Inspiration"
 */
export function characterStatusLine(_c: Character): string {
  throw new Error('not implemented');
}

/** Full character sheet as compact markdown for the DM (abilities, saves, skills, attacks, spells, features, inventory, money). */
export function characterSheetText(_c: Character): string {
  throw new Error('not implemented');
}
