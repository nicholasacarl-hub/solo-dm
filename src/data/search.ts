/**
 * The rules index: full-text search (MiniSearch) and name lookup over SRD entries, imported
 * library entries and homebrew. Pure and synchronous once built; see rulesIndexStore.ts for the
 * cached, app-wide instance.
 */
import MiniSearch, { type SearchResult } from 'minisearch';
import { HOMEBREW_SOURCE_ID, SRD_SOURCE_ID, type CompendiumEntry, type ContentKind, type HomebrewEntry } from '@/types';
import { nameKey } from '@/lib/id';
import type { RulesIndex, SearchHit, SearchOptions } from './index';
import { isReviewedImport } from './structured/materialize';
import { escapeRegExp, toPlainText } from './text';

const DEFAULT_LIMIT = 20;
const SNIPPET_CHARS = 240;

/** Frequent words that carry no meaning for rules lookups. */
const STOP_WORDS = new Set(
  'a an and are as at be by can for from has have if in into is it its of on or that the their them then there these they this to was when which while who will with you your'.split(' '),
);

/** Lowercase, trim punctuation, drop stop words and one-letter tokens. */
export function processTerm(term: string): string | null {
  const t = term.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  return t.length < 2 || STOP_WORDS.has(t) ? null : t;
}

/** When names tie, prefer the kind a DM most likely means ("Shield" the spell before the armor). */
const KIND_RANK: Record<ContentKind, number> = {
  spell: 0,
  monster: 1,
  'magic-item': 2,
  item: 3,
  condition: 4,
  feat: 5,
  class: 6,
  subclass: 7,
  species: 8,
  background: 9,
  boon: 10,
  rule: 11,
  other: 12,
};

type HomebrewFields = Partial<Pick<HomebrewEntry, 'campaignId' | 'status'>>;

const isHomebrew = (entry: CompendiumEntry) => entry.sourceId === HOMEBREW_SOURCE_ID;
const homebrewOf = (entry: CompendiumEntry) => entry as CompendiumEntry & HomebrewFields;
const isRetired = (entry: CompendiumEntry) => isHomebrew(entry) && homebrewOf(entry).status === 'retired';

/** Homebrew visibility: shared homebrew always, campaign homebrew only for that campaign. */
function homebrewVisible(entry: CompendiumEntry, campaignId: string | null | undefined): boolean {
  const owner = homebrewOf(entry).campaignId ?? null;
  return owner === null || (campaignId != null && owner === campaignId);
}

/** Kinds the app structures from imports: an unreviewed import of one of these is thin (a guessed `{ cr }` at most). */
const ENTITY_KINDS: ReadonlySet<ContentKind> = new Set<ContentKind>([
  'monster', 'spell', 'magic-item', 'item', 'feat', 'class', 'subclass', 'species', 'background',
]);

/**
 * Name ranking (spec §6.2; dm/tools/rules.ts sourceRank mirrors it): 0 = this campaign's homebrew,
 * 1 = shared homebrew, 2 = reviewed imports and imported rules text (rule, condition, boon, other),
 * 3 = SRD, 4 = unreviewed imported entries of an entity kind — so a thin unreviewed duplicate never
 * shadows an SRD stat block, while a book's own rules sections still answer.
 */
export function sourcePriority(entry: CompendiumEntry): number {
  if (isHomebrew(entry)) return homebrewOf(entry).campaignId ? 0 : 1;
  if (entry.sourceId === SRD_SOURCE_ID) return 3;
  if (isReviewedImport(entry)) return 2;
  return ENTITY_KINDS.has(entry.kind) ? 4 : 2;
}

/**
 * Name keys an entry answers to besides its exact name: both parts of "Stone of Good Luck
 * (Luckstone)", the natural order of "Clothes, Traveler's", and the name without punctuation.
 */
function aliasKeys(name: string): string[] {
  const keys = new Set<string>();
  const paren = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(name);
  if (paren) {
    keys.add(nameKey(paren[1]));
    keys.add(nameKey(paren[2]));
  }
  const inverted = /^([^,(]+), ([^,(]+)$/.exec(name);
  if (inverted) keys.add(nameKey(`${inverted[2]} ${inverted[1]}`));
  keys.add(nameKey(name).replace(/-/g, ''));
  keys.delete('');
  keys.delete(nameKey(name));
  return [...keys];
}

function singularKey(key: string): string {
  if (key.endsWith('ies')) return `${key.slice(0, -3)}y`;
  if (/(?:ch|sh|ss|x)es$/.test(key)) return key.slice(0, -2);
  return key.endsWith('s') && !key.endsWith('ss') ? key.slice(0, -1) : key;
}

/** Index of the earliest whole-word occurrence of any term (case-insensitive), or -1. */
function firstTermPosition(plain: string, terms: string[]): number {
  let best = -1;
  for (const term of terms) {
    const match = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}`, 'iu').exec(plain);
    if (match && (best < 0 || match.index < best)) best = match.index;
  }
  return best;
}

/** About `size` characters of plain text around the first matched term (word-aligned, with ellipses). */
export function makeSnippet(markdown: string, terms: string[], size = SNIPPET_CHARS): string {
  const plain = toPlainText(markdown);
  if (plain.length <= size) return plain;
  const pos = firstTermPosition(plain, terms);
  let start = pos < 0 ? 0 : Math.max(0, pos - Math.floor(size / 3));
  if (start > 0) {
    const space = plain.indexOf(' ', start);
    start = space >= 0 && space < pos ? space + 1 : start;
  }
  let end = Math.min(plain.length, start + size);
  if (end < plain.length) {
    const space = plain.lastIndexOf(' ', end);
    if (space > start) end = space;
  }
  return `${start > 0 ? '…' : ''}${plain.slice(start, end).trim()}${end < plain.length ? '…' : ''}`;
}

class MiniSearchRulesIndex implements RulesIndex {
  private readonly entries: CompendiumEntry[];
  private readonly byId = new Map<string, CompendiumEntry>();
  private readonly keyById = new Map<string, string>();
  private readonly order = new Map<string, number>();
  private readonly byName = new Map<string, CompendiumEntry[]>();
  private readonly byAlias = new Map<string, CompendiumEntry[]>();
  /** Chunk ids a materialized entry replaced (`data.aliasIds`): resolvable by get(), never listed or searched. */
  private readonly aliasIds = new Map<string, CompendiumEntry>();
  private readonly mini: MiniSearch<CompendiumEntry>;

  constructor(entries: CompendiumEntry[]) {
    this.entries = [];
    for (const entry of entries) {
      if (this.byId.has(entry.id)) continue; // first wins: SRD ids are unique, imports/homebrew are namespaced
      const key = nameKey(entry.name);
      this.byId.set(entry.id, entry);
      this.keyById.set(entry.id, key);
      this.order.set(entry.id, this.entries.length);
      this.entries.push(entry);
      push(this.byName, key, entry);
      for (const alias of aliasKeys(entry.name)) push(this.byAlias, alias, entry);
    }
    // Old ids (Browse links, KnownSpell ids, statBlockIds) keep resolving to the entry that replaced their chunk.
    for (const entry of this.entries) {
      const ids = entry.data?.aliasIds;
      if (!Array.isArray(ids)) continue;
      for (const id of ids) {
        if (typeof id === 'string' && !this.byId.has(id) && !this.aliasIds.has(id)) this.aliasIds.set(id, entry);
      }
    }
    this.mini = new MiniSearch<CompendiumEntry>({
      idField: 'id',
      fields: ['name', 'summary', 'text', 'path'],
      extractField: (doc, field) => {
        if (field === 'path') return doc.path?.join(' ') ?? '';
        const value = (doc as unknown as Record<string, unknown>)[field];
        return typeof value === 'string' ? value : '';
      },
      processTerm,
    });
    this.mini.addAll(this.entries);
  }

  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const text = query.trim();
    if (!text) return [];
    const queryKey = nameKey(text);
    const results: SearchResult[] = this.mini.search(text, {
      boost: { name: 3, summary: 1.5 },
      prefix: (term) => term.length >= 3,
      fuzzy: (term) => (term.length >= 4 ? 0.2 : false),
      filter: (result) => {
        const entry = this.byId.get(result.id as string);
        return entry !== undefined && this.allowed(entry, opts);
      },
      // A name that is (or starts with) the query outranks entries that merely mention the words.
      boostDocument: (id) => {
        const key = this.keyById.get(id as string) ?? '';
        return key === queryKey ? 3 : key.startsWith(queryKey) ? 2 : 1;
      },
    });
    return results.slice(0, Math.max(1, opts.limit ?? DEFAULT_LIMIT)).map((result) => {
      const entry = this.byId.get(result.id as string) as CompendiumEntry;
      return { entry, score: result.score, snippet: makeSnippet(entry.text, result.terms) };
    });
  }

  get(id: string): CompendiumEntry | undefined {
    const exact = this.byId.get(id) ?? this.aliasIds.get(id);
    if (exact) return exact;
    // Variant ids ("srd:item:arcane-focus:crystal") resolve to their base entry.
    const parts = id.split(':');
    while (parts.length > 3) {
      parts.pop();
      const base = this.byId.get(parts.join(':'));
      if (base) return base;
    }
    return undefined;
  }

  findByName(name: string, opts: { kind?: ContentKind; campaignId?: string | null } = {}): CompendiumEntry | undefined {
    const key = nameKey(name);
    if (!key) return undefined;
    const compact = key.replace(/-/g, '');
    const tiers = [
      this.byName.get(key),
      this.byName.get(singularKey(key)),
      this.byAlias.get(key),
      this.byName.get(compact),
      this.byAlias.get(compact),
    ];
    for (const tier of tiers) {
      const found = this.pick(tier ?? [], opts);
      if (found) return found;
    }
    return undefined;
  }

  list(opts: { kind?: ContentKind; sourceId?: string } = {}): CompendiumEntry[] {
    return this.entries.filter(
      (e) => !isRetired(e) && (!opts.kind || e.kind === opts.kind) && (!opts.sourceId || e.sourceId === opts.sourceId),
    );
  }

  sources(): { id: string; name: string; count: number }[] {
    const out = new Map<string, { id: string; name: string; count: number }>();
    for (const entry of this.entries) {
      if (isRetired(entry)) continue;
      const source = out.get(entry.sourceId) ?? { id: entry.sourceId, name: entry.sourceName, count: 0 };
      source.count += 1;
      out.set(entry.sourceId, source);
    }
    const rank = (id: string) => (id === SRD_SOURCE_ID ? 0 : id === HOMEBREW_SOURCE_ID ? 2 : 1);
    return [...out.values()].sort((a, b) => rank(a.id) - rank(b.id));
  }

  private allowed(entry: CompendiumEntry, opts: SearchOptions): boolean {
    if (opts.kinds?.length && !opts.kinds.includes(entry.kind)) return false;
    if (opts.sourceIds && !opts.sourceIds.includes(entry.sourceId)) return false;
    if (isHomebrew(entry)) return !isRetired(entry) && homebrewVisible(entry, opts.campaignId);
    return true;
  }

  private pick(candidates: CompendiumEntry[], opts: { kind?: ContentKind; campaignId?: string | null }): CompendiumEntry | undefined {
    const eligible = candidates.filter(
      (e) =>
        (!opts.kind || e.kind === opts.kind) &&
        !isRetired(e) &&
        (!isHomebrew(e) || homebrewVisible(e, opts.campaignId)),
    );
    eligible.sort(
      (a, b) =>
        sourcePriority(a) - sourcePriority(b) ||
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        (a.path?.length ?? 0) - (b.path?.length ?? 0) ||
        (this.order.get(a.id) ?? 0) - (this.order.get(b.id) ?? 0),
    );
    return eligible[0];
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Build a rules index over the given entries (SRD, imports and homebrew, in that order). */
export function createRulesIndex(entries: CompendiumEntry[]): RulesIndex {
  return new MiniSearchRulesIndex(entries);
}
