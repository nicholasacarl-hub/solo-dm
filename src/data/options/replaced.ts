/**
 * A 2024 book's option stands in for the SRD option of the same name: SRD 5.2.1 is drawn from the 2024
 * rules, so the two are one option, and the lists a player chooses from show the book's alone. Options
 * from older-edition books are other designs and stay beside the SRD's (with their badges). Pure.
 *
 * Only lists hide: lookups by id still see every option, so a hero or draft that chose the SRD option
 * before the book was accepted keeps it, and the "SRD" source filter still lists the SRD's.
 */
import { nameKey } from '@/lib/id';
import type { ClassOption, OptionSource, SubclassOption } from '@/types';

type Named = { name: string; source?: OptionSource };

/** An imported option in the 2024 format: it stands in for the SRD option of its name. */
export const replacesSrd = (o: { source?: OptionSource }): boolean => o.source?.format === '2024';

/** Every subclass a hero of the class may choose: its own, then those it shares (ClassOption.sharedSubclasses). */
export const subclassesOf = (cls: Pick<ClassOption, 'subclasses' | 'sharedSubclasses'>): SubclassOption[] => [...cls.subclasses, ...(cls.sharedSubclasses ?? [])];

/**
 * `list` without the SRD options that a 2024 book's option of the same name in the list stands in for.
 * Ids in `keep` always stay (the chosen option's card never disappears).
 */
export function withoutReplacedSrd<T extends Named & { id: string }>(list: readonly T[], keep: Iterable<string | null | undefined> = []): T[] {
  const replaced = new Set(list.filter(replacesSrd).map((o) => nameKey(o.name)));
  if (!replaced.size) return [...list];
  const kept = new Set(keep);
  return list.filter((o) => Boolean(o.source) || !replaced.has(nameKey(o.name)) || kept.has(o.id));
}
