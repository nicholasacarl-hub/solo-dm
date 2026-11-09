/**
 * Where builder options come from (structured imports, spec §5.3): the books in the merged data, the
 * source filter ("All · SRD · <book>"), which SRD options need an "SRD" badge (an import shares the name),
 * and the older-edition notes and book refs a draft's choices carry. Pure.
 */
import { nameKey } from '@/lib/id';
import { SRD_SOURCE_ID, type BuilderData, type OptionSource } from '@/types';
import type { SpellInfo } from './spells';

export interface OptionBook {
  id: string;
  title: string;
}

type Sourced = { source?: OptionSource };

/** The imported books that give the builder options (or spells), in title order. */
export function optionBooks(data: BuilderData, spells: readonly SpellInfo[] = []): OptionBook[] {
  const books = new Map<string, string>();
  const add = (o: Sourced) => {
    if (o.source && !books.has(o.source.sourceId)) books.set(o.source.sourceId, o.source.title);
  };
  for (const c of data.classes) {
    add(c);
    c.subclasses.forEach(add);
  }
  data.species.forEach(add);
  data.backgrounds.forEach(add);
  data.feats.forEach(add);
  for (const s of spells) {
    if (s.entry.id.startsWith('lib:') && !books.has(s.entry.sourceId)) books.set(s.entry.sourceId, s.entry.sourceName);
  }
  return [...books.entries()].map(([id, title]) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title, 'en'));
}

/** Does an option pass the source filter (null = everything)? */
export function inSourceFilter(o: Sourced, filter: string | null): boolean {
  if (!filter) return true;
  if (filter === SRD_SOURCE_ID) return !o.source;
  return o.source?.sourceId === filter;
}

/** The same for a spell from the rules index. */
export function spellInSourceFilter(spell: SpellInfo, filter: string | null): boolean {
  if (!filter) return true;
  return spell.entry.sourceId === filter;
}

/** Only what the filter shows, but never hiding the one that is chosen (its card stays visible). */
export function filtered<T extends Sourced & { id: string }>(list: readonly T[], filter: string | null, keepId?: string | null): T[] {
  return list.filter((o) => inSourceFilter(o, filter) || o.id === keepId);
}

/** SRD options that need an "SRD" badge: an imported option of the same list shares their name. */
export function clashingNames(list: readonly ({ name: string } & Sourced)[]): Set<string> {
  const imported = new Set(list.filter((o) => o.source).map((o) => nameKey(o.name)));
  return new Set(list.filter((o) => !o.source && imported.has(nameKey(o.name))).map((o) => nameKey(o.name)));
}

/** "The Gloamwood Almanac" → itself; longer titles are cut at 24 characters (the full title goes in the accessible name). */
export function shortTitle(title: string, max = 24): string {
  return title.length > max ? `${title.slice(0, max - 1).trimEnd()}…` : title;
}

/** Every adaptation note of the given options, once each (moved to src/data/options so a level-up adds them too). */
export { adaptationNotes } from '@/data/options/adaptationNotes';

/** The builder's one muted line about imported options it can't use (§5.1 rule 10). */
export function builderProblemLine(problems: readonly { kind: string; message: string }[]): string | null {
  if (!problems.length) return null;
  const orphans = problems.filter((p) => p.kind === 'subclass' && /^Its class/.test(p.message)).length;
  const other = problems.length - orphans;
  const parts: string[] = [];
  if (orphans) parts.push(`${orphans} ${orphans === 1 ? "subclass can't" : "subclasses can't"} be used yet: ${orphans === 1 ? "its class isn't" : "their class isn't"} available`);
  if (other) parts.push(`${other} ${other === 1 ? 'option from your books needs' : 'options from your books need'} a look in the Library`);
  return `${parts.join('; ')}.`;
}
