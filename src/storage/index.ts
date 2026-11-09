/**
 * Persistence API (IndexedDB via Dexie). CONTRACT — implemented by the storage module.
 * The UI and other modules import only from '@/storage'.
 *
 * Everything lives in this browser's IndexedDB database "solo-dm". Imported sourcebook text never
 * leaves the browser except through an explicit export the player chooses. Characters keep
 * provenance for book text they copy; exports replace that text (redact.ts).
 *
 * Each export below is typed with its contract signature; the implementations live next to this
 * file (campaigns, records, library, backup, githubSync, images).
 */
import type {
  Campaign,
  Character,
  Clock,
  CombatState,
  CompendiumEntry,
  ExtractionJob,
  GithubSyncSettings,
  HomebrewEntry,
  JobStatus,
  JournalEntry,
  LibrarySource,
  LogEntry,
  Quest,
  RecordStatus,
  RunState,
  Session,
  StoredImage,
  StructuredKind,
  StructuredRecord,
  TranscriptMessage,
} from '@/types';
import * as backup from './backup';
import * as campaigns from './campaigns';
import * as lock from './campaignLock';
import type { CampaignLock } from './campaignLock';
import * as database from './db';
import * as github from './githubSync';
import * as images from './images';
import type { ImageLogPatch, ImageStats, ImageUrlState, StoredImageMeta } from './images';
import * as library from './library';
import * as records from './records';
import * as redact from './redact';
import type { ExportReport } from './redact';
import * as structured from './structured';
import type {
  CampaignBundle,
  CampaignData,
  CampaignRecords,
  CampaignSummary,
  NewCampaignInput,
  RemoteSave,
  SyncReport,
} from './types';

export type { ExportReport } from './redact';
export type {
  CampaignBundle,
  CampaignData,
  CampaignRecords,
  CampaignSummary,
  NewCampaignInput,
  RemoteSave,
  SyncReport,
} from './types';

// ---------------------------------------------------------------------------
// Save slots (campaigns)
// ---------------------------------------------------------------------------

/** Most recently played first, then most recently created. */
export const listCampaigns: () => Promise<CampaignSummary[]> = campaigns.listCampaigns;
/** React hook: live-updating campaign list (undefined while loading). */
export const useCampaignList: () => CampaignSummary[] | undefined = campaigns.useCampaignList;
export const getCampaign: (id: string) => Promise<Campaign | undefined> = campaigns.getCampaign;
/** New save slot: status 'setup', no character or session yet, tension 5, zero usage. */
export const createCampaign: (input: NewCampaignInput) => Promise<Campaign> = campaigns.createCampaign;
/** Deletes the campaign and everything belonging to it (character, sessions, transcript, log, journal, images...). */
export const deleteCampaign: (id: string) => Promise<void> = campaigns.deleteCampaign;
/** Deep copy with new ids ("<name> (copy)"), illustrations included, e.g. to branch a campaign before a risky choice. */
export const duplicateCampaign: (id: string, newName?: string) => Promise<Campaign> = campaigns.duplicateCampaign;
/**
 * Ask the browser not to evict saved games under storage pressure (call after the first campaign is
 * created). Chrome decides silently; Firefox may prompt. Resolves false when unsupported or refused.
 */
export const requestPersistentStorage: () => Promise<boolean> = database.requestPersistentStorage;

// ---------------------------------------------------------------------------
// Low-level record access (used by the game store). These store exactly what they are given;
// the game store keeps campaign.updatedAt current.
// ---------------------------------------------------------------------------

export const loadCampaignRecords: (campaignId: string) => Promise<CampaignRecords | null> = records.loadCampaignRecords;
export const putCampaign: (c: Campaign) => Promise<void> = records.putCampaign;
/**
 * putCampaign that keeps DM notices queued elsewhere since the caller last saw the record (stored
 * notices in neither `seen` nor `c`). Returns the notices now stored.
 */
export const putCampaignKeepingNotices: (c: Campaign, seen: readonly string[]) => Promise<string[]> =
  records.putCampaignKeepingNotices;
/** Add a DM notice to a stored campaign (bumps updatedAt). Resolves the stored notices, or null if it doesn't exist. */
export const addPendingDmNotice: (campaignId: string, notice: string, updatedAt?: number) => Promise<string[] | null> =
  records.addPendingDmNotice;
export const putCharacter: (c: Character) => Promise<void> = records.putCharacter;
/** Remove one character record (the game store calls it when a campaign's character is replaced). */
export const deleteCharacterRecord: (id: string) => Promise<void> = records.deleteCharacterRecord;
export const putSession: (s: Session) => Promise<void> = records.putSession;
export const putTranscript: (messages: TranscriptMessage[]) => Promise<void> = records.putTranscript;
/** Deletes only messages with seq > `seq`. */
export const deleteTranscriptAfter: (sessionId: string, seq: number) => Promise<void> = records.deleteTranscriptAfter;
/** Ordered by seq. */
export const getTranscript: (sessionId: string) => Promise<TranscriptMessage[]> = records.getTranscript;
export const putLog: (entries: LogEntry[]) => Promise<void> = records.putLog;
export const deleteLog: (ids: string[]) => Promise<void> = records.deleteLog;
/** null removes the campaign's combat tracker. */
export const putCombat: (campaignId: string, state: CombatState | null) => Promise<void> = records.putCombat;
export const putJournal: (entries: JournalEntry[]) => Promise<void> = records.putJournal;
export const deleteJournalEntry: (id: string) => Promise<void> = records.deleteJournalEntry;
export const putQuest: (q: Quest) => Promise<void> = records.putQuest;
export const deleteQuestRecord: (id: string) => Promise<void> = records.deleteQuestRecord;
export const putClock: (c: Clock) => Promise<void> = records.putClock;
export const deleteClockRecord: (id: string) => Promise<void> = records.deleteClockRecord;

// ---------------------------------------------------------------------------
// Homebrew & library (imported sourcebooks)
// ---------------------------------------------------------------------------

/** Also bumps the owning campaign's updatedAt, so cloud sync picks up edits made in the Library. */
export const putHomebrew: (h: HomebrewEntry) => Promise<void> = library.putHomebrew;
export const deleteHomebrewRecord: (id: string) => Promise<void> = library.deleteHomebrewRecord;
/** campaignId undefined = all homebrew; null = shared only; string = that campaign + shared. Sorted by name. */
export const listHomebrew: (campaignId?: string | null) => Promise<HomebrewEntry[]> = library.listHomebrew;
export const useHomebrewList: (campaignId?: string | null) => HomebrewEntry[] | undefined = library.useHomebrewList;

/** Built-in sources first, then by title. */
export const listLibrarySources: () => Promise<LibrarySource[]> = library.listLibrarySources;
export const useLibrarySources: () => LibrarySource[] | undefined = library.useLibrarySources;
/** Save a source and replace all of its entries. */
export const saveLibrarySource: (source: LibrarySource, entries: CompendiumEntry[]) => Promise<void> =
  library.saveLibrarySource;
/** Deletes the source, its entries, structured records and extraction jobs. Refused (STRUCTURING_BUSY_ERROR) while a job runs. */
export const deleteLibrarySource: (id: string) => Promise<void> = library.deleteLibrarySource;
/** The error deleteLibrarySource gives while structuring is running or pausing for that book. */
export const STRUCTURING_BUSY_ERROR: string = library.STRUCTURING_BUSY_ERROR;
export const setLibrarySourceEnabled: (id: string, enabled: boolean) => Promise<void> = library.setLibrarySourceEnabled;
/** Entries for the given sources (all enabled imported sources when omitted). */
export const getLibraryEntries: (sourceIds?: string[]) => Promise<CompendiumEntry[]> = library.getLibraryEntries;

// ---------------------------------------------------------------------------
// Backups (export / import save files)
// ---------------------------------------------------------------------------

export const exportCampaignBundle: (campaignId: string) => Promise<CampaignBundle> = backup.exportCampaignBundle;
/**
 * The export with book text copied onto the character left out too (placeholders, ref.redacted), and a
 * report of what was left out for the toast. The stored campaign is never changed.
 */
export const exportCampaignBundleWithReport: (campaignId: string) => Promise<{ bundle: CampaignBundle; report: ExportReport }> =
  backup.exportCampaignBundleWithReport;
/** Pure: the export copy with ref'd copied descriptions (and DM tool inputs echoing them) replaced by placeholders. */
export const redactCopiedImports: (data: CampaignData) => { data: CampaignData; report: ExportReport } = redact.redactCopiedImports;
/** Export and trigger a browser download of "<campaign-name-slug>.solodm.json". Resolves what was left out (callers may ignore it). */
export const downloadCampaign: (campaignId: string) => Promise<ExportReport> = backup.downloadCampaign;
/** Validate a parsed file (a JSON string is also accepted). Throws a readable Error when it isn't a valid bundle. */
export const parseCampaignBundle: (data: unknown) => CampaignBundle = backup.parseCampaignBundle;
/**
 * Import a bundle. If a campaign with the same id exists: mode 'replace' overwrites it,
 * 'copy' imports under fresh ids. Returns the imported campaign.
 */
export const importCampaignBundle: (bundle: CampaignBundle, mode?: 'replace' | 'copy') => Promise<Campaign> =
  backup.importCampaignBundle;

// ---------------------------------------------------------------------------
// Optional cloud saves in the player's own private GitHub repo
// ---------------------------------------------------------------------------

/** The error every GitHub operation gives for a public repository. */
export const PUBLIC_REPO_ERROR: string = github.PUBLIC_REPO_ERROR;
/** The error every GitHub operation gives for an internal (enterprise-visible) repository. */
export const INTERNAL_REPO_ERROR: string = github.INTERNAL_REPO_ERROR;

/** Check the token and repo; reports whether the repo is private (public repos are refused for saves). */
export const testGithubConnection: (
  settings: GithubSyncSettings,
) => Promise<{ ok: boolean; private?: boolean; error?: string }> = github.testGithubConnection;
/** Saves in the configured folder, most recently updated first. Throws for public or unreachable repos. */
export const listRemoteSaves: (settings: GithubSyncSettings) => Promise<RemoteSave[]> = github.listRemoteSaves;
export const pushCampaignToGithub: (campaignId: string, settings: GithubSyncSettings) => Promise<void> =
  github.pushCampaignToGithub;
/** Replaces the local campaign with the same id. Ask the player first if it has unsynced changes. */
export const pullCampaignFromGithub: (save: RemoteSave, settings: GithubSyncSettings) => Promise<Campaign> =
  github.pullCampaignFromGithub;
/**
 * Two-way sync: newer side wins; both-changed-since-last-sync is reported as a conflict, not overwritten.
 * Report lists hold campaign ids. Problems with the repository itself throw; per-campaign problems
 * are collected in `errors`. The caller records settings.lastSyncedAt. Resolve a conflict with
 * pushCampaignToGithub (keep this device's copy) or pullCampaignFromGithub (keep GitHub's).
 * A campaign deleted on this device after syncing is not pulled back unless it changes on GitHub.
 */
export const syncWithGithub: (settings: GithubSyncSettings) => Promise<SyncReport> = github.syncWithGithub;

// ---------------------------------------------------------------------------
// One tab at a time per campaign (Web Locks)
// ---------------------------------------------------------------------------

export type { CampaignLock } from './campaignLock';

/**
 * Hold an exclusive per-campaign lock (Web Locks API) while the campaign is open at the table.
 * Resolves null when another tab already holds it (unless steal: true, which takes it over).
 * Where Web Locks are unavailable, resolves a lock that never conflicts.
 * Holders in one tab share the lock; it is released when the last one calls release().
 */
export const acquireCampaignLock: (campaignId: string, opts?: { steal?: boolean }) => Promise<CampaignLock | null> =
  lock.acquireCampaignLock;
/**
 * True when another tab or window holds the campaign's lock. The game store, imports that replace
 * a campaign and deletes refuse to touch such a campaign (with OPEN_ELSEWHERE_ERROR).
 */
export const isCampaignOpenElsewhere: (campaignId: string) => Promise<boolean> = lock.isCampaignOpenElsewhere;
/** The error for changes refused because the campaign is open at the table in another tab. */
export const OPEN_ELSEWHERE_ERROR: string = lock.OPEN_ELSEWHERE_ERROR;

// ---------------------------------------------------------------------------
// Illustrations. Stored in their own IndexedDB tables, only on this device: never in exports or
// GitHub saves (the story log's image entries travel without their pictures). Deleting a campaign
// deletes its images; duplicating one copies them; a campaign replaced by an import or a pull keeps them.
// ---------------------------------------------------------------------------

export type { ImageLogPatch, ImageStats, ImageUrlState, StoredImageMeta } from './images';

/** Save a picture. Rejects when its campaign no longer exists (with IMAGE_CAMPAIGN_MISSING). */
export const saveImage: (image: StoredImage) => Promise<void> = images.saveImage;
export const getImage: (id: string) => Promise<StoredImage | undefined> = images.getImage;
/** Newest first. */
export const listImages: (campaignId: string) => Promise<StoredImageMeta[]> = images.listImages;
export const deleteImage: (id: string) => Promise<void> = images.deleteImage;
/** React hook: live list of a campaign's images (metadata only), newest first. */
export const useImageList: (campaignId: string | null) => StoredImageMeta[] | undefined = images.useImageList;
/**
 * React hook: an object URL for a stored image (revoked on unmount), or null while loading/missing.
 * Live: a picture saved after mounting appears as soon as it lands.
 */
export const useImageUrl: (imageId: string | null) => string | null = images.useImageUrl;
/** useImageUrl that tells loading from missing ('missing' = not on this device, e.g. a save made elsewhere). */
export const useImageUrlState: (imageId: string | null) => ImageUrlState = images.useImageUrlState;
/** How many pictures this device holds and their size, in total and per campaign. */
export const getImageStats: () => Promise<ImageStats> = images.getImageStats;
export const useImageStats: () => ImageStats | undefined = images.useImageStats;
/**
 * Set an image log entry's status (and error) directly in storage, bumping its campaign's updatedAt:
 * for pictures that finish after the player left the table. Resolves false when the entry is gone.
 */
export const markImageLogEntry: (entryId: string, patch: ImageLogPatch) => Promise<boolean> = images.markImageLogEntry;
/** The error saveImage gives when the picture's campaign no longer exists. */
export const IMAGE_CAMPAIGN_MISSING: string = images.IMAGE_CAMPAIGN_MISSING;

// ---------------------------------------------------------------------------
// Structured imports (records and extraction jobs; spec §2.5). Only on this device: never in exports or
// GitHub saves. Characters keep provenance for book text they copy; exports replace that text (redact.ts).
// ---------------------------------------------------------------------------

/** A source's entries in reading order (numeric suffix of lib:<sourceId>:<n>, not IndexedDB string order). */
export const getSourceEntries: (sourceId: string) => Promise<CompendiumEntry[]> = structured.getSourceEntries;
export const listRecords: (sourceId: string, opts?: { kind?: StructuredKind; status?: RecordStatus }) => Promise<StructuredRecord[]> =
  structured.listRecords;
/** React hook: live records of a source (undefined while loading), re-emitting at most every 500 ms. */
export const useRecords: (
  sourceId: string | undefined,
  filter?: { status?: RecordStatus; kind?: StructuredKind },
) => StructuredRecord[] | undefined = structured.useRecords;
export const getRecords: (ids: string[]) => Promise<(StructuredRecord | undefined)[]> = structured.getRecords;
/** Upsert; keeps the source's denormalized counts (source.structure) right in the same transaction. */
export const putRecords: (records: StructuredRecord[]) => Promise<void> = structured.putRecords;
/** Accept, reject or undo. Returns the previous statuses (for Undo). Sets reviewedAt. */
export const setRecordStatus: (ids: string[], status: RecordStatus) => Promise<{ id: string; status: RecordStatus }[]> =
  structured.setRecordStatus;
export const deleteRecords: (ids: string[]) => Promise<void> = structured.deleteRecords;
/** Accepted records of enabled import sources (or of the given sources). */
export const getAcceptedRecords: (sourceIds?: string[]) => Promise<StructuredRecord[]> = structured.getAcceptedRecords;
/** Records of a job in a run state, in queue order (STRUCTURED_KINDS, then reading order). */
export const listJobRecords: (jobId: string, runState: RunState) => Promise<StructuredRecord[]> = structured.listJobRecords;
export const putJob: (job: ExtractionJob) => Promise<void> = structured.putJob;
export const getJob: (id: string) => Promise<ExtractionJob | undefined> = structured.getJob;
export const listJobs: (filter?: { sourceId?: string; status?: JobStatus[] }) => Promise<ExtractionJob[]> = structured.listJobs;
/** React hook: live jobs (of one source, or all), undefined while loading. */
export const useJobs: (sourceId?: string) => ExtractionJob[] | undefined = structured.useJobs;
/** Lifetime spend on structuring (sum of job usage, books still in the library). */
export const structuringSpendUsd: () => Promise<number> = structured.structuringSpendUsd;
export const setSourceFingerprint: (sourceId: string, fingerprint: string) => Promise<void> = structured.setSourceFingerprint;
export const findSourcesByFingerprint: (fingerprint: string) => Promise<LibrarySource[]> = structured.findSourcesByFingerprint;
/** Characters with a ref into this source (for "Used by …" on switch-off / delete). */
export const charactersUsingSource: (
  sourceId: string,
) => Promise<{ campaignId: string; campaignName: string; characterName: string }[]> = structured.charactersUsingSource;
/** Pack import: a new source with its entries and records in one transaction. */
export const saveLibrarySourceWithRecords: (
  source: LibrarySource,
  entries: CompendiumEntry[],
  records: StructuredRecord[],
) => Promise<void> = structured.saveLibrarySourceWithRecords;
