/**
 * Rules content API: bundled SRD 5.2.1 data, the rules search index (SRD + imported library +
 * homebrew), and the import pipeline for the player's own sourcebooks.
 * CONTRACT — implemented by the data module. Other modules import only from '@/data'.
 */
import type { BuilderData, CompendiumEntry, ContentKind, LibrarySource } from '@/types';
import { loadBuilderData as loadBuilder, useBuilderData as useBuilder } from './builderData';
import { chunkDocument as chunk } from './chunk';
import { importLibraryDocument as importDocument } from './importer';
import {
  getRulesIndex as getIndex,
  invalidateRulesIndex as invalidateIndex,
  useRulesIndex as useIndex,
} from './rulesIndexStore';

/** The exact CC-BY-4.0 attribution statement required by SRD 5.2.1. */
export const SRD_ATTRIBUTION =
  'This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.';

// ---------------------------------------------------------------------------
// Character-builder data
// ---------------------------------------------------------------------------

/** Classes, species, backgrounds, feats and equipment from the SRD (cached after the first load). */
export const loadBuilderData: () => Promise<BuilderData> = loadBuilder;
export const useBuilderData: () => { data: BuilderData | null; error: string | null; loading: boolean } = useBuilder;

// ---------------------------------------------------------------------------
// Rules search
// ---------------------------------------------------------------------------

export interface SearchOptions {
  kinds?: ContentKind[];
  /** Restrict to these sources (SRD id, library ids, 'homebrew'). Default: SRD + all enabled sources. */
  sourceIds?: string[];
  /** Include homebrew of this campaign (and shared homebrew). Default: shared homebrew only. */
  campaignId?: string | null;
  limit?: number;
}

export interface SearchHit {
  entry: CompendiumEntry;
  score: number;
  /** Short excerpt around the best match (plain text). */
  snippet: string;
}

export interface RulesIndex {
  search(query: string, opts?: SearchOptions): SearchHit[];
  /** Variant ids of the form "srd:item:<base>:<variant>" resolve to the base entry. */
  get(id: string): CompendiumEntry | undefined;
  /** Exact-ish name lookup (case/punctuation-insensitive), preferring homebrew > imports > SRD. */
  findByName(name: string, opts?: { kind?: ContentKind; campaignId?: string | null }): CompendiumEntry | undefined;
  list(opts?: { kind?: ContentKind; sourceId?: string }): CompendiumEntry[];
  sources(): { id: string; name: string; count: number }[];
}

/** Build (once) and return the index. Loads SRD JSON lazily from /srd/*.json. */
export const getRulesIndex: () => Promise<RulesIndex> = getIndex;
/** Drop the cached index (call after library or homebrew changes). */
export const invalidateRulesIndex: () => void = invalidateIndex;
/** React hook: the index, or null while it builds. Re-renders after invalidation. */
export const useRulesIndex: () => RulesIndex | null = useIndex;

// ---------------------------------------------------------------------------
// Importing the player's own books / notes
// ---------------------------------------------------------------------------

export type ImportFormat = 'text' | 'markdown' | 'pdf' | 'json' | 'image';

export interface ImportInput {
  title: string;
  format: ImportFormat;
  /** Pasted text (text / markdown / json). */
  text?: string;
  /** Uploaded files (pdf / image / text / markdown / json). */
  files?: File[];
  notes?: string;
}

export interface ImportProgress {
  stage: 'reading' | 'transcribing' | 'chunking' | 'saving' | 'done';
  done: number;
  total: number;
  message?: string;
}

/**
 * Import content into the library: extract text (PDF text layer; photos are transcribed with
 * Claude vision using the player's API key), split into searchable entries by headings, guess each
 * entry's kind (spell, monster, item, rule...), and save it. Stored only in this browser.
 */
export const importLibraryDocument: (
  input: ImportInput,
  onProgress?: (p: ImportProgress) => void,
  signal?: AbortSignal,
) => Promise<LibrarySource> = importDocument;

/** Split markdown/plain text into entries by headings (pure; exported for tests and previews). */
export const chunkDocument: (
  text: string,
  opts: { sourceId: string; sourceName: string },
) => CompendiumEntry[] = chunk;

// ---------------------------------------------------------------------------
// Extras (beyond the original contract)
// ---------------------------------------------------------------------------

/** Version, entry counts, attribution and upstream sources of the bundled SRD data (for the Library). */
export { loadSrdManifest, type SrdManifest } from './srd';
/** Like useRulesIndex, plus loading and error state. */
export { useRulesIndexState } from './rulesIndexStore';
/** Build a standalone index over given entries (tests, previews). */
export { createRulesIndex } from './search';
/** The kind an imported entry would get ('spell', 'monster', 'magic-item', 'feat' or 'rule'). */
export { guessKind } from './chunk';

// ---------------------------------------------------------------------------
// Structured imports (spec §2–§7): records beside entries, read on this device (and, with the player's
// key and consent, by Claude), reviewed, then used by the index, the builder, combat and the DM.
// CONTRACT (Day 0): these names are final; change them only with every caller.
// ---------------------------------------------------------------------------

/** Detection: segment → parse offline → normalize → records (local and free). */
export { detectStructure, doubted, readingJobIds, structureEntryAs, rereadOffline, type DetectionSummary } from './structured/detect';
export { useCorrectedKindsVersion } from './structured/staleKinds';
/**
 * The pure halves of detection, shared with the extraction runner (src/dm/extract): a reading of a
 * candidate (offline or Claude's wire) and §3.10's re-run table for writing it over stored records.
 */
export {
  applyReading,
  candidatesForRecords,
  detectionContext,
  mergeReadings,
  NEEDS_CLAUDE_MESSAGE,
  readCandidate,
  readOffline,
  type MergeResult,
  type Reading,
  type ReadingContext,
} from './structured/detect';
export { ENGINE_NAMES, nameNotices, noticeIndex, type NoticeIndex } from './structured/notices';
/** Segmentation (pure) and paragraph numbering (pure; every TextSpan counts these paragraphs). */
export {
  segment,
  blocksOf,
  candidateFor,
  gfmTables,
  markCandidate,
  type Candidate,
  type CandidateBlock,
  type SegmentContext,
  type SpellListHint,
} from './structured/segment';
export { splitParagraphs, resolveSpan, featureText, requestParagraphs } from './structured/paragraphs';
/** Offline parsers and the one normalizer per kind, shared with Claude's answers. */
export { parseOffline, emptyWire, type OfflineParse } from './structured/parse';
export {
  normalize,
  validateData,
  schemaWarnings,
  normalizeItemRows,
  MONSTER_FIELDS,
  SPELL_FIELDS,
  MAGIC_ITEM_FIELDS,
  ITEM_FIELDS,
  type NormalizeContext,
  type Normalized,
} from './structured/normalize';
/** The stored form's schemas (ranges, strict) and the wire format both producers return. */
export { DATA_SCHEMAS, RECORD_SCHEMA, STRUCTURED_LIMITS, TEXT_SPAN } from './structured/schemas';
export { WIRE, type Wire } from './structured/wire';
/** Accepted records as rules-index entries, and the stats line the review and the DM's lookups show. */
export { materializeEntries, isReviewedImport } from './structured/materialize';
export { statsLine } from './structured/statsLine';
/** One library snapshot per rules-index version (shared by the index and the builder data). */
export { getLibrarySnapshot, type LibrarySnapshot } from './rulesIndexStore';
/** Merged builder data: SRD + accepted imported options (the SRD object is never mutated). */
export { importedOptions, mergeBuilderData, type ImportedOptions, type MergeProblem } from './structured/merge';
export { getBuilderProblems, countUnreviewedOptions } from './builderData';
/** Option lookups (id-first; an imported id never binds to an SRD option by name). */
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
  type CatalogMatch,
} from './options/resolve';
/** Provenance for copies, and app-written item descriptions (numbers, never book text). */
export { refFor, type RefOption, type RefText } from './options/refs';
export { describeOption } from './options/describe';
/** Level-up and feature-use helpers (moved here from src/ui/builder by E4, so src/dm never imports src/ui). */
export { gainedFeatures, refreshFeatureUses, featureUseChanges, type GainedFeaturesOptions, type LevelingData } from './options/leveling';
export { inferFeatureUses, type UsesContext } from './options/featureUses';
/** Restore book text onto a character on a device that has the book. */
export { restoreImportedText, buildLibraryLookup, type LibraryLookup, type RestoreReport } from './structured/restore';
/** JSON packs and "Download book data". */
export { parsePack, exportPack, isPackFile, type PackFileV1, type PackImport, type PackRecordV1 } from './structured/packs';
/** Older-format (2014) adaptation notes. */
export { adaptationNote, type AdaptationFields } from './structured/adaptations';
