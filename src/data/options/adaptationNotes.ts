/**
 * Older-edition notes on a character (spec §5.6, D33): the app-written notes of the adaptations the options
 * it uses carry, once each, so the sheet text tells the DM how the app adapted them. The builder collects
 * them at creation; a level-up (the dialog and the DM's level_up) adds those of the class it levels or adds,
 * that class's subclass and a feat taken, so a subclass chosen at level 3 brings its notes too. Pure.
 */
import type { Adaptation, Character, OptionSource } from '@/types';

type Sourced = { source?: OptionSource };

/** Every adaptation note of the given options, once each (for adaptationNotes and the builder's Review step). */
export function adaptationNotes(options: readonly (Sourced | null | undefined)[]): string[] {
  const notes: string[] = [];
  for (const o of options) {
    for (const a of o?.source?.adaptations ?? ([] as Adaptation[])) if (!notes.includes(a.note)) notes.push(a.note);
  }
  return notes;
}

/** The character with the notes of these options added after its own, once each; the same object when none is new. */
export function withAdaptationNotes(c: Character, options: readonly (Sourced | null | undefined)[]): Character {
  const have = c.adaptationNotes ?? [];
  const added = adaptationNotes(options).filter((n) => !have.includes(n));
  return added.length ? { ...c, adaptationNotes: [...have, ...added] } : c;
}
