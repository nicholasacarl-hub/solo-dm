/**
 * Name notices (spec §3.9.2), added by detectStructure and the runner, which can see the rules index:
 * `info` name-collision when the SRD or another book has the same kind and name, and `warn` engine-name
 * for the names the engine treats specially (the name checks in engine/rules.ts, engine/character.ts and
 * ui/builder/origin.ts). App-written messages; pure.
 *
 * Owner: E2.
 */
import { nameKey } from '@/lib/id';
import { SRD_SOURCE_ID, type CompendiumEntry, type RecordWarning, type StructuredDataByKind, type StructuredKind } from '@/types';
import { quote, warning } from './normalize/text';

/** Names the engine gives an automatic effect to (spec §3.9.2). */
export const ENGINE_NAMES = [
  'Alert', 'Aura of Protection', 'Defense', 'Draconic Resilience', 'Improved Critical', 'Luck', 'Skilled', 'Superior Critical', 'Tough',
  'Unarmored Defense',
] as const;
const ENGINE_KEYS = new Map(ENGINE_NAMES.map((n) => [nameKey(n), n]));

/** "a monster", "an item"…: a kind as a noun with its article. */
export const KIND_NOUN: Readonly<Record<StructuredKind, string>> = {
  monster: 'a monster', spell: 'a spell', 'magic-item': 'a magic item', item: 'an item', feat: 'a feat', background: 'a background',
  species: 'a species', class: 'a class', subclass: 'a subclass',
};

/** The note on a record someone worked on that the improved reader doesn't find any more. */
export function doubtMessage(kind: StructuredKind): string {
  return `An earlier version of the offline reader took this for ${KIND_NOUN[kind]}; the current one doesn't. If it isn't one, keep it as text. If it is, accept it.`;
}

/** Rules-index entries by kind and nameKey (built once per detection or job). */
export type NoticeIndex = ReadonlyMap<string, readonly Pick<CompendiumEntry, 'sourceId' | 'sourceName' | 'name' | 'kind'>[]>;

export function noticeIndex(entries: readonly Pick<CompendiumEntry, 'sourceId' | 'sourceName' | 'name' | 'kind'>[]): NoticeIndex {
  const out = new Map<string, Pick<CompendiumEntry, 'sourceId' | 'sourceName' | 'name' | 'kind'>[]>();
  for (const e of entries) {
    const key = `${e.kind}\u0000${nameKey(e.name)}`;
    const list = out.get(key) ?? [];
    list.push(e);
    out.set(key, list);
  }
  return out;
}

/** The names inside an option that the engine might match (features, traits, lineages). */
function partNames(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as Partial<StructuredDataByKind['class'] & StructuredDataByKind['species']>;
  return [...(d.features ?? []), ...(d.traits ?? []), ...(d.lineages ?? [])].map((p) => p.name).filter((n): n is string => typeof n === 'string');
}

/** name-collision and engine-name notices for one record. */
export function nameNotices(
  record: { kind: StructuredKind; name: string; sourceId: string; data: unknown },
  index: NoticeIndex | null,
): RecordWarning[] {
  const out: RecordWarning[] = [];
  const others = (index?.get(`${record.kind}\u0000${nameKey(record.name)}`) ?? []).filter((e) => e.sourceId !== record.sourceId);
  const srd = others.find((e) => e.sourceId === SRD_SOURCE_ID);
  const book = others.find((e) => e.sourceId !== SRD_SOURCE_ID && e.sourceId !== 'homebrew');
  if (srd) {
    out.push(warning('name-collision', 'info',
      `The SRD also has ${KIND_NOUN[record.kind]} called ${quote(record.name)}. Once you accept this one, combat and the DM use this book's version when they look that name up. Both stay in the Library.`, 'name'));
  } else if (book) {
    out.push(warning('name-collision', 'info', `“${book.sourceName}” also has ${KIND_NOUN[record.kind]} called ${quote(record.name)}. Both stay in the Library.`, 'name'));
  }
  for (const name of [record.name, ...partNames(record.data)]) {
    const engine = ENGINE_KEYS.get(nameKey(name));
    if (engine) {
      out.push(warning('engine-name', 'warn', `The app gives anything named ${quote(engine)} the SRD ${engine}'s automatic effect. Rename this one if it works differently.`, name === record.name ? 'name' : 'features'));
    }
  }
  return out;
}
