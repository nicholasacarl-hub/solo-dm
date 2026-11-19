/**
 * A hero's imported classes' editions (ImportedRef.format on ClassLevel.ref), which the engine's class rules read
 * (engine/classData.ts rulesClassFor: a 2024 book's class plays by the SRD class of its name). Set when a class is
 * taken (refs.ts optionRef); kept in step here, on load and after a review (gameStore refreshClassEditions). Pure.
 */
import { draconicResilienceHitPoints } from '@/engine/progression';
import { nameKey } from '@/lib/id';
import type { Character, ClassOption, ImportedRef } from '@/types';
import { optionFingerprint } from './refs';

/** A copy of the ref's own book (the same text, by its fingerprint): the book moved to another device. */
function sameText(ref: ImportedRef, classes: readonly ClassOption[]): ClassOption | undefined {
  if (!ref.bookFingerprint) return undefined;
  const key = nameKey(ref.entryName);
  return classes.find((o) => o.source && nameKey(o.name) === key && optionFingerprint(o) === ref.bookFingerprint);
}

/**
 * The character with each imported class's ref recording its own record's edition: by the class's id (heroes made
 * before refs recorded it, and an Edition changed in review), else, only where none is recorded yet, a copy of the
 * same book's text. Never another book's class of the name: a class whose book is switched off or gone keeps what
 * it has. The same object when nothing changes.
 */
export function withClassEditions(c: Character, classes: readonly ClassOption[]): Character {
  let changed = false;
  const next = c.classes.map((cl) => {
    if (!cl.ref) return cl;
    const own = classes.find((o) => o.id === cl.classId);
    const format = own ? own.source?.format : cl.ref.format ? undefined : sameText(cl.ref, classes)?.source?.format;
    if (!format || cl.ref.format === format) return cl;
    changed = true;
    return { ...cl, ref: { ...cl.ref, format } };
  });
  return changed ? { ...c, classes: next } : c;
}

/**
 * Hit Points the class rules owe once a class's edition is recorded: Draconic Resilience's for Sorcerer levels gained
 * while a 2024 book's Sorcerer didn't yet play by the SRD's rules (nothing in the app can raise a Hit Point maximum
 * by hand). Never negative: an Edition changed back keeps what was given.
 */
export function hitPointsOwedForEditions(before: Character, after: Character): number {
  return Math.max(0, draconicResilienceHitPoints(after) - draconicResilienceHitPoints(before));
}
