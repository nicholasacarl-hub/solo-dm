/**
 * A stand-in for '@/data' in DM tests (vi.mock('@/data', () => import(...))): an in-memory
 * rules index over a few entries, so tests never load SRD JSON, Dexie or pdf.js.
 */
import type { RulesIndex, SearchHit, SearchOptions } from '@/data';
import type { CompendiumEntry, ContentKind } from '@/types';

export const SRD_ATTRIBUTION = 'SRD 5.2.1 attribution (test)';

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const rank = (e: CompendiumEntry) => (e.sourceId === 'homebrew' ? 0 : e.sourceId === 'srd-5.2.1' ? 2 : 1);

export function createFakeRulesIndex(entries: CompendiumEntry[]): RulesIndex {
  const allowed = (e: CompendiumEntry, opts?: SearchOptions) =>
    (!opts?.kinds || opts.kinds.includes(e.kind)) && (!opts?.sourceIds || opts.sourceIds.includes(e.sourceId));
  return {
    search(query, opts) {
      const words = key(query).split(' ').filter(Boolean);
      const hits: SearchHit[] = [];
      for (const entry of entries) {
        if (!allowed(entry, opts)) continue;
        const hay = key(`${entry.name} ${entry.summary ?? ''} ${entry.text}`);
        const score = words.filter((w) => hay.includes(w)).length;
        if (score > 0) hits.push({ entry, score, snippet: entry.text.slice(0, 120) });
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, opts?.limit ?? 10);
    },
    get: (id) => entries.find((e) => e.id === id),
    // Like the real index: homebrew, then imports, then the SRD.
    findByName: (name, opts?: { kind?: ContentKind }) =>
      entries
        .filter((e) => key(e.name) === key(name) && (!opts?.kind || e.kind === opts.kind))
        .sort((a, b) => rank(a) - rank(b))[0],
    list: (opts) => entries.filter((e) => (!opts?.kind || e.kind === opts.kind) && (!opts?.sourceId || e.sourceId === opts.sourceId)),
    sources: () => [
      { id: 'srd-5.2.1', name: 'SRD 5.2.1', count: entries.filter((e) => e.sourceId === 'srd-5.2.1').length },
      { id: 'lib-phb', name: 'My PHB notes', count: entries.filter((e) => e.sourceId === 'lib-phb').length },
    ],
  };
}

export const SAMPLE_RULES: CompendiumEntry[] = [
  {
    id: 'srd:rule:opportunity-attacks',
    sourceId: 'srd-5.2.1',
    sourceName: 'SRD 5.2.1',
    kind: 'rule',
    name: 'Opportunity Attacks',
    path: ['Playing the Game', 'Combat'],
    text: 'You can make an Opportunity Attack when a creature that you can see leaves your reach using its action, Bonus Action, Reaction, or one of its speeds. '.repeat(30),
  },
  {
    id: 'srd:spell:fireball',
    sourceId: 'srd-5.2.1',
    sourceName: 'SRD 5.2.1',
    kind: 'spell',
    name: 'Fireball',
    summary: 'Level 3 Evocation (Sorcerer, Wizard)',
    text: 'A bright streak flashes from you to a point you choose within range and then blossoms with a low roar into a fiery explosion. Each creature in a 20-foot-radius Sphere makes a Dexterity saving throw, taking 8d6 Fire damage on a failed save or half as much on a success.',
  },
  {
    id: 'srd:monster:bandit',
    sourceId: 'srd-5.2.1',
    sourceName: 'SRD 5.2.1',
    kind: 'monster',
    name: 'Bandit',
    summary: 'CR 1/8 Medium Humanoid',
    text: 'AC 12, HP 11. Scimitar: +3 to hit, 4 (1d6 + 1) Slashing damage.',
  },
  {
    id: 'lib:secret-book:1',
    sourceId: 'lib-disabled',
    sourceName: 'A disabled import',
    kind: 'spell',
    name: 'Forbidden Fire',
    text: 'Fire that is not enabled in this campaign.',
  },
];

let index: RulesIndex = createFakeRulesIndex(SAMPLE_RULES);
export let invalidations = 0;

export const getRulesIndex = async (): Promise<RulesIndex> => index;
export const invalidateRulesIndex = (): void => {
  invalidations += 1;
};
export function setFakeRulesIndex(next: RulesIndex): void {
  index = next;
}
export const useRulesIndex = (): RulesIndex | null => index;
export const loadBuilderData = async () => {
  throw new Error('fake data: builder data is not used by the DM');
};
export const useBuilderData = () => ({ data: null, error: null, loading: false });
export const importLibraryDocument = async () => {
  throw new Error('fake data: imports are not used by the DM');
};
export const chunkDocument = () => [];
