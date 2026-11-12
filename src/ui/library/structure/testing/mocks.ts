/**
 * Shared vi.mock factories for Library UI tests (structured imports, Day 0). Every structured-imports
 * name of @/data, @/storage and @/dm, plus the game store's restoreImportedText, as vi.fn()s with
 * defaults built from the Gloamwood fixture, so a test overrides only what it checks:
 *
 *   vi.mock('@/dm', async () => (await import('@/ui/library/structure/testing/mocks')).dmMock());
 *   vi.mock('@/data', async () => ({ ...(await import('@/ui/library/structure/testing/mocks')).structuredDataMock(), …today's names }));
 *
 * Pure @/data functions call through to their real modules (imported by path, never through a mocked
 * barrel), so UI tests pick up E2's and E4's implementations as they land; I/O resolves fixture data.
 * mocks.test.ts keeps these lists equal to the barrels' export lists.
 */
import { vi } from 'vitest';
import * as adaptations from '@/data/structured/adaptations';
import type { DetectionSummary } from '@/data/structured/detect';
import * as materialize from '@/data/structured/materialize';
import * as merge from '@/data/structured/merge';
import * as normalize from '@/data/structured/normalize';
import * as paragraphs from '@/data/structured/paragraphs';
import * as parse from '@/data/structured/parse';
import { DATA_SCHEMAS, RECORD_SCHEMA, STRUCTURED_LIMITS, TEXT_SPAN } from '@/data/structured/schemas';
import * as segment from '@/data/structured/segment';
import * as statsLine from '@/data/structured/statsLine';
import { WIRE } from '@/data/structured/wire';
import * as describeModule from '@/data/options/describe';
import * as featureUses from '@/data/options/featureUses';
import * as leveling from '@/data/options/leveling';
import * as refs from '@/data/options/refs';
import * as resolve from '@/data/options/resolve';
import { ExtractionUnavailableError, describeExtractionError } from '@/dm/extract/errors';
import type { RunnerSnapshot } from '@/dm/extract/runner';
import {
  EXPECTED_MERGED,
  GLOAMWOOD_CANDIDATES,
  GLOAMWOOD_TITLE,
  extractionJob,
  gloamwoodEntries,
  gloamwoodRecords,
  gloamwoodSnapshot,
  gloamwoodSource,
} from '@/test/structuredFixtures';
import type { CostEstimate, ModelId, StructuredKind, StructuredRecord } from '@/types';

/** The value exports each barrel adds for structured imports (types are erased at runtime). */
export const STRUCTURED_DATA_EXPORTS = [
  'detectStructure', 'doubted', 'readingJobIds', 'useCorrectedKindsVersion', 'structureEntryAs', 'rereadOffline', 'segment', 'splitParagraphs', 'resolveSpan', 'featureText',
  'parseOffline', 'normalize', 'validateData', 'DATA_SCHEMAS', 'RECORD_SCHEMA', 'STRUCTURED_LIMITS', 'TEXT_SPAN', 'WIRE',
  'materializeEntries', 'isReviewedImport', 'statsLine', 'getLibrarySnapshot', 'importedOptions', 'mergeBuilderData',
  'getBuilderProblems', 'countUnreviewedOptions', 'backgroundOptionFor', 'classByName', 'classOptionFor', 'findEquipment',
  'findFeat', 'inventoryFromOption', 'isImportedId', 'optionSourceLabel', 'primaryRuleOf', 'speciesOptionFor',
  'subclassOptionFor', 'suggestParentClass', 'refFor', 'describeOption', 'gainedFeatures', 'refreshFeatureUses',
  'featureUseChanges', 'inferFeatureUses', 'restoreImportedText', 'buildLibraryLookup', 'parsePack', 'exportPack',
  'isPackFile', 'adaptationNote',
] as const;
export const STRUCTURED_STORAGE_EXPORTS = [
  'getSourceEntries', 'listRecords', 'useRecords', 'getRecords', 'putRecords', 'commitRecords', 'setRecordStatus', 'deleteRecords',
  'getAcceptedRecords', 'listJobRecords', 'putJob', 'setPausedJobCounts', 'getJob', 'listJobs', 'useJobs', 'structuringSpendUsd',
  'setSourceFingerprint', 'markSourceStructured', 'findSourcesByFingerprint', 'charactersUsingSource', 'saveLibrarySourceWithRecords',
  'redactCopiedImports', 'exportCampaignBundleWithReport', 'downloadCampaign',
] as const;
export const STRUCTURED_DM_EXPORTS = [
  'extractionAvailability', 'estimateJob', 'estimateModels', 'startJob', 'pauseJob', 'resumeJob', 'cancelJob', 'retryRecords',
  'recoverJobsOnStartup', 'useRunner', 'setExtractionDeps', 'ExtractionUnavailableError', 'describeExtractionError',
] as const;

const KIND_COUNTS = () => {
  const byKind: DetectionSummary['byKind'] = {};
  for (const c of GLOAMWOOD_CANDIDATES) {
    const k = (byKind[c.kind] ??= { found: 0, readyOffline: 0, needClaude: 0 });
    k.found += 1;
    // A plausible split for UI copy (not a parser target): the 2014 subclass needs Claude.
    if (c.name === 'Dusk Domain') k.needClaude += 1;
    else k.readyOffline += 1;
  }
  return byKind;
};

/** A detection summary of the Gloamwood book for UI tests (counts per kind; one entry needs Claude). */
export function gloamwoodDetection(): DetectionSummary {
  const byKind = KIND_COUNTS();
  const all = Object.values(byKind);
  return {
    byKind,
    total: all.reduce((n, k) => n + k.found, 0),
    readyOffline: all.reduce((n, k) => n + k.readyOffline, 0),
    needClaude: all.reduce((n, k) => n + k.needClaude, 0),
    leftOut: 0,
    removed: {},
    removedNames: [],
    removedRecords: [],
    doubted: [],
  };
}

export function structuredDataMock() {
  return {
    // I/O (vi.fn()s resolving fixture data)
    detectStructure: vi.fn(async () => gloamwoodDetection()),
    structureEntryAs: vi.fn(async (_sourceId: string, _entryIds: string[], kind: StructuredKind) => gloamwoodRecords().find((r) => r.kind === kind) as StructuredRecord),
    rereadOffline: vi.fn(async () => ({ doubted: 0, accepted: [] as string[], alreadyNoted: 0, busy: 0 })),
    doubted: vi.fn((record: StructuredRecord, now: number) => ({ ...record, updatedAt: now })),
    useCorrectedKindsVersion: vi.fn(() => 0),
    readingJobIds: vi.fn((jobs: readonly { id: string; status: string }[]) => new Set(jobs.filter((j) => ['queued', 'running', 'pausing'].includes(j.status)).map((j) => j.id))),
    getLibrarySnapshot: vi.fn(async () => gloamwoodSnapshot()),
    getBuilderProblems: vi.fn(() => [] as merge.MergeProblem[]),
    countUnreviewedOptions: vi.fn(async () => [] as { sourceId: string; title: string; kind: StructuredKind; count: number }[]),
    restoreImportedText: vi.fn((character: import('@/types').Character) => ({ character, report: { restored: 0, differs: 0, missing: [] } })),
    buildLibraryLookup: vi.fn(async () => ({
      entriesById: new Map(gloamwoodEntries().map((e) => [e.id, e])),
      sourcesByFingerprint: new Map([[gloamwoodSource().fingerprint as string, gloamwoodSource()]]),
      sourcesByTitle: new Map([[GLOAMWOOD_TITLE.toLowerCase(), [gloamwoodSource()]]]),
      builder: EXPECTED_MERGED,
    })),
    parsePack: vi.fn(() => ({ source: { title: GLOAMWOOD_TITLE }, entries: [], records: [], issues: [], reviewedElsewhere: 0 })),
    exportPack: vi.fn(),
    isPackFile: vi.fn((json: unknown) => typeof json === 'object' && json !== null && (json as { format?: unknown }).format === 'solo-dm-pack'),
    // Pure (the real modules)
    segment: vi.fn(segment.segment),
    splitParagraphs: vi.fn(paragraphs.splitParagraphs),
    resolveSpan: vi.fn(paragraphs.resolveSpan),
    featureText: vi.fn(paragraphs.featureText),
    parseOffline: vi.fn(parse.parseOffline),
    normalize: vi.fn(normalize.normalize),
    validateData: vi.fn(normalize.validateData),
    DATA_SCHEMAS,
    RECORD_SCHEMA,
    STRUCTURED_LIMITS,
    TEXT_SPAN,
    WIRE,
    materializeEntries: vi.fn(materialize.materializeEntries),
    isReviewedImport: vi.fn(materialize.isReviewedImport),
    statsLine: vi.fn(statsLine.statsLine),
    importedOptions: vi.fn(merge.importedOptions),
    mergeBuilderData: vi.fn(merge.mergeBuilderData),
    backgroundOptionFor: vi.fn(resolve.backgroundOptionFor),
    classByName: vi.fn(resolve.classByName),
    classOptionFor: vi.fn(resolve.classOptionFor),
    findEquipment: vi.fn(resolve.findEquipment),
    findFeat: vi.fn(resolve.findFeat),
    inventoryFromOption: vi.fn(resolve.inventoryFromOption),
    isImportedId: vi.fn(resolve.isImportedId),
    optionSourceLabel: vi.fn(resolve.optionSourceLabel),
    primaryRuleOf: vi.fn(resolve.primaryRuleOf),
    speciesOptionFor: vi.fn(resolve.speciesOptionFor),
    subclassOptionFor: vi.fn(resolve.subclassOptionFor),
    suggestParentClass: vi.fn(resolve.suggestParentClass),
    refFor: vi.fn(refs.refFor),
    describeOption: vi.fn(describeModule.describeOption),
    gainedFeatures: vi.fn(leveling.gainedFeatures),
    refreshFeatureUses: vi.fn(leveling.refreshFeatureUses),
    featureUseChanges: vi.fn(leveling.featureUseChanges),
    inferFeatureUses: vi.fn(featureUses.inferFeatureUses),
    adaptationNote: vi.fn(adaptations.adaptationNote),
  } satisfies Record<(typeof STRUCTURED_DATA_EXPORTS)[number], unknown>;
}

export function structuredStorageMock() {
  // Stable arrays: hooks must not return a new array on every render.
  const records = gloamwoodRecords();
  const jobs: import('@/types').ExtractionJob[] = [];
  return {
    getSourceEntries: vi.fn(async () => gloamwoodEntries()),
    listRecords: vi.fn(async () => records),
    useRecords: vi.fn(() => records),
    getRecords: vi.fn(async (ids: string[]) => ids.map((id) => records.find((r) => r.id === id))),
    putRecords: vi.fn(async () => undefined),
    commitRecords: vi.fn(async (puts: readonly StructuredRecord[], deletes: readonly string[]) => ({ written: new Set(puts.map((r) => r.id)), deleted: new Set(deletes) })),
    setRecordStatus: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, status: records.find((r) => r.id === id)?.status ?? 'pending' }))),
    deleteRecords: vi.fn(async () => undefined),
    getAcceptedRecords: vi.fn(async () => records.filter((r) => r.status === 'accepted')),
    listJobRecords: vi.fn(async () => [] as StructuredRecord[]),
    putJob: vi.fn(async () => undefined),
    setPausedJobCounts: vi.fn(async () => true),
    getJob: vi.fn(async () => undefined),
    listJobs: vi.fn(async () => jobs),
    useJobs: vi.fn(() => jobs),
    structuringSpendUsd: vi.fn(async () => 4.12),
    setSourceFingerprint: vi.fn(async () => undefined),
    markSourceStructured: vi.fn(async () => undefined),
    findSourcesByFingerprint: vi.fn(async () => [] as import('@/types').LibrarySource[]),
    charactersUsingSource: vi.fn(async () => [] as { campaignId: string; campaignName: string; characterName: string }[]),
    saveLibrarySourceWithRecords: vi.fn(async () => undefined),
    redactCopiedImports: vi.fn((data: import('@/storage').CampaignData) => ({ data, report: { books: [] as string[], passages: 0 } })),
    exportCampaignBundleWithReport: vi.fn(),
    downloadCampaign: vi.fn(async () => ({ books: [] as string[], passages: 0 })),
  } satisfies Record<(typeof STRUCTURED_STORAGE_EXPORTS)[number], unknown>;
}

/** The game store's structured-imports action, to spread into a mocked getState(). */
export function gameStoreRestoreMock() {
  return { restoreImportedText: vi.fn(async () => null) };
}

/**
 * The runner's idle snapshot (equal to IDLE_RUNNER). A copy: importing the real runner here would import
 * @/data and @/storage, which these factories mock (a circular import inside vi.mock).
 */
export const IDLE_RUNNER_SNAPSHOT: RunnerSnapshot = Object.freeze({
  activeJobId: null,
  inFlight: [],
  effectiveConcurrency: 0,
  waitingUntil: null,
  hold: null,
  cacheWarnings: [],
  spentUsd: 0,
  projectedUsd: 0,
  etaMinutes: null,
}) as RunnerSnapshot;

/** A cost estimate in the consent's style (spec §4.7). */
export function costEstimate(model: ModelId, usd: number, minutes: number): CostEstimate {
  return {
    model,
    requests: 199,
    inputTokens: 224_000,
    cacheWriteTokens: 7_700,
    cacheReadTokens: 151_000,
    outputTokens: 110_000,
    usd,
    usdLow: Math.round(usd * 60) / 100,
    usdHigh: Math.round(usd * 160) / 100,
    minutesLow: Math.round(minutes * 0.7),
    minutesHigh: Math.round(minutes * 2),
    byKind: { monster: { requests: 72, usd: usd * 0.35 } },
  };
}

export function dmMock() {
  return {
    extractionAvailability: vi.fn((): { ok: true } | { ok: false; reason: 'demo' | 'no-key'; message: string } => ({ ok: true })),
    estimateJob: vi.fn(async () => costEstimate('claude-opus-5-5', 3.2, 14)),
    estimateModels: vi.fn(async () => [
      costEstimate('claude-opus-5-5', 3.2, 14),
      costEstimate('claude-sonnet-5-5', 1.6, 11),
      costEstimate('claude-haiku-5-5', 0.08, 6),
    ]),
    startJob: vi.fn(async () => extractionJob({ status: 'running' })),
    pauseJob: vi.fn(async () => undefined),
    resumeJob: vi.fn(async () => undefined),
    cancelJob: vi.fn(async () => undefined),
    retryRecords: vi.fn(async () => 'job:retry'),
    recoverJobsOnStartup: vi.fn(async () => undefined),
    useRunner: vi.fn((): RunnerSnapshot => IDLE_RUNNER_SNAPSHOT),
    setExtractionDeps: vi.fn(),
    ExtractionUnavailableError,
    describeExtractionError: vi.fn(describeExtractionError),
  } satisfies Record<(typeof STRUCTURED_DM_EXPORTS)[number], unknown>;
}
