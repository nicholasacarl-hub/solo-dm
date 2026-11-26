/**
 * A stand-in for '@/data' in DM tests (vi.mock('@/data', () => import(...))): an in-memory
 * rules index over a few entries, so tests never load SRD JSON, Dexie or pdf.js.
 */
import type { RulesIndex, SearchHit, SearchOptions } from '@/data';
import type { BuilderData, CompendiumEntry, ContentKind } from '@/types';

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

/** An SRD spell entry with the fields spell effects read (data.concentration, data.duration). */
function srdSpell(name: string, level: number, concentration: boolean, duration: string, text: string): CompendiumEntry {
  return {
    id: `srd:spell:${key(name).replace(/ /g, '-')}`,
    sourceId: 'srd-5.2.1',
    sourceName: 'SRD 5.2.1',
    kind: 'spell',
    name,
    text,
    data: { level, concentration, duration },
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
    text: 'AC 12, HP 11. _**Scimitar.**_ _Melee Attack Roll:_ +3, reach 5 ft. _Hit:_ 4 (1d6 + 1) Slashing damage.',
    data: { size: 'Medium', speeds: { walk: 30 } },
  },
  {
    id: 'srd:monster:ogre',
    sourceId: 'srd-5.2.1',
    sourceName: 'SRD 5.2.1',
    kind: 'monster',
    name: 'Ogre',
    summary: 'CR 2 Large Giant',
    text: 'AC 11, HP 68. _**Greatclub.**_ _Melee Attack Roll:_ +6, reach 5 ft. _Hit:_ 13 (2d8 + 4) Bludgeoning damage.',
    data: { size: 'Large', speeds: { walk: 40 } },
  },
  {
    id: 'lib:secret-book:1',
    sourceId: 'lib-disabled',
    sourceName: 'A disabled import',
    kind: 'spell',
    name: 'Forbidden Fire',
    text: 'Fire that is not enabled in this campaign.',
  },
  // Spell effects (SPEC §6): durations and Concentration as SRD 5.2.1 gives them, and stat blocks' saves.
  srdSpell('Bless', 1, true, 'Concentration, up to 1 minute', 'You bless up to three creatures within range.'),
  srdSpell('Hold Person', 2, true, 'Concentration, up to 1 minute', 'The target must succeed on a Wisdom saving throw or have the Paralyzed condition for the duration.'),
  srdSpell('Shield of Faith', 1, true, 'Concentration, up to 10 minutes', 'A shimmering field surrounds a creature of your choice within range, granting it a +2 bonus to AC for the duration.'),
  srdSpell('Web', 2, true, 'Concentration, up to 1 hour', 'You conjure a mass of sticky webbing at a point within range.'),
  srdSpell('Shield', 1, false, '1 round', 'Until the start of your next turn, you have a +5 bonus to AC.'),
  srdSpell('Mage Armor', 1, false, '8 hours', "Until the spell ends, the target's base AC becomes 13 plus its Dexterity modifier."),
  {
    id: 'srd:monster:cultist-fanatic',
    sourceId: 'srd-5.2.1',
    sourceName: 'SRD 5.2.1',
    kind: 'monster',
    name: 'Cultist Fanatic',
    summary: 'CR 2 Medium Humanoid',
    text: 'AC 13, HP 44. Spellcasting: Hold Person, Spiritual Weapon.',
    data: { size: 'Medium', speeds: { walk: 30 }, ac: 13, hp: 44, initiative: 2, savingThrows: { str: 0, dex: 2, con: 1, int: 0, wis: 4, cha: 1 } },
  },
  {
    id: 'srd:monster:mummy-lord',
    sourceId: 'srd-5.2.1',
    sourceName: 'SRD 5.2.1',
    kind: 'monster',
    name: 'Mummy Lord',
    summary: 'CR 15 Medium Undead',
    text: 'AC 17, HP 187. _**Legendary Resistance (3/Day, or 4/Day in Lair).**_ If the mummy fails a saving throw, it can choose to succeed instead.',
    data: { size: 'Medium', speeds: { walk: 30 }, ac: 17, hp: 187, initiative: 10, savingThrows: { str: 4, dex: 0, con: 3, int: 5, wis: 9, cha: 3 } },
  },
  {
    // A reviewed import: numbers the player checked, but no saving throws (src/types/structured.ts MonsterData).
    id: 'lib:lib-phb:7',
    sourceId: 'lib-phb',
    sourceName: 'My PHB notes',
    kind: 'monster',
    name: 'Bog Witch',
    summary: 'CR 3 Medium Fey',
    text: 'AC 14, HP 40. Spellcasting: Hold Person.',
    data: { recordId: 'rec:lib-phb:monster:bog-witch', size: 'Medium', speeds: { walk: 30 }, ac: 14, hp: 40, initiative: 1 },
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
/** The merged builder data of the Gloamwood fixture (SRD Cleric and Fighter + the book), loaded on first use. */
export const loadBuilderData = async (): Promise<BuilderData> => (await import('@/test/structuredFixtures')).EXPECTED_MERGED;
export const useBuilderData = () => ({ data: null, error: null, loading: false });
export const importLibraryDocument = async () => {
  throw new Error('fake data: imports are not used by the DM');
};
export const chunkDocument = () => [];

// ---------------------------------------------------------------------------
// Structured imports (the same names as the @/data barrel). Pure modules are the real ones, imported by
// path; anything that would read storage is a fake (DM tests never load Dexie).
// ---------------------------------------------------------------------------

export { segment } from '@/data/structured/segment';
export { splitParagraphs, resolveSpan, featureText } from '@/data/structured/paragraphs';
export { parseOffline } from '@/data/structured/parse';
export { normalize, validateData } from '@/data/structured/normalize';
export { DATA_SCHEMAS, RECORD_SCHEMA, STRUCTURED_LIMITS, TEXT_SPAN } from '@/data/structured/schemas';
export { WIRE } from '@/data/structured/wire';
export { materializeEntries, isReviewedImport } from '@/data/structured/materialize';
export { statsLine } from '@/data/structured/statsLine';
export { importedOptions, mergeBuilderData } from '@/data/structured/merge';
export {
  backgroundOptionFor,
  classByName,
  classOptionFor,
  findEquipment,
  findFeat,
  inventoryFromOption,
  isImportedId,
  optionSourceLabel,
  primaryRuleOf,
  speciesOptionFor,
  subclassOptionFor,
  suggestParentClass,
} from '@/data/options/resolve';
export { refFor } from '@/data/options/refs';
export { describeOption } from '@/data/options/describe';
export { gainedFeatures, refreshFeatureUses, featureUseChanges } from '@/data/options/leveling';
export { inferFeatureUses } from '@/data/options/featureUses';
export { adaptationNote } from '@/data/structured/adaptations';

const notUsed = (name: string) => async (): Promise<never> => {
  throw new Error(`fake data: ${name} is not used by the DM`);
};
export const detectStructure = notUsed('detectStructure');
export const structureEntryAs = notUsed('structureEntryAs');
export const rereadOffline = notUsed('rereadOffline');
export const doubted = () => {
  throw new Error('fake data: doubted is not used by the DM');
};
export const readingJobIds = () => new Set<string>();
export const useCorrectedKindsVersion = () => 0;
export const getLibrarySnapshot = notUsed('getLibrarySnapshot');
export const buildLibraryLookup = notUsed('buildLibraryLookup');
export const countUnreviewedOptions = async () => [];
export const getBuilderProblems = () => [];
export const restoreImportedText = () => {
  throw new Error('fake data: restoreImportedText is not used by the DM');
};
export const parsePack = () => {
  throw new Error('fake data: packs are not used by the DM');
};
export const exportPack = parsePack;
export const isPackFile = () => false;
