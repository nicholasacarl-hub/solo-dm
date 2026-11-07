/**
 * Persistence API (IndexedDB via Dexie). CONTRACT — implemented by the storage module.
 * The UI and other modules import only from '@/storage'.
 *
 * Everything lives in this browser's IndexedDB database "solo-dm". Imported sourcebook text never
 * leaves the browser except through an explicit export the player chooses.
 *
 * Each export below is typed with its contract signature; the implementations live next to this
 * file (campaigns, records, library, backup, githubSync).
 */
import type {
  Campaign,
  Character,
  Clock,
  CombatState,
  CompendiumEntry,
  GithubSyncSettings,
  HomebrewEntry,
  JournalEntry,
  LibrarySource,
  LogEntry,
  Quest,
  Session,
  TranscriptMessage,
} from '@/types';
import * as backup from './backup';
import * as campaigns from './campaigns';
import * as database from './db';
import * as github from './githubSync';
import * as library from './library';
import * as records from './records';
import type {
  CampaignBundle,
  CampaignRecords,
  CampaignSummary,
  NewCampaignInput,
  RemoteSave,
  SyncReport,
} from './types';

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
/** Deletes the campaign and everything belonging to it (character, sessions, transcript, log, journal...). */
export const deleteCampaign: (id: string) => Promise<void> = campaigns.deleteCampaign;
/** Deep copy with new ids ("<name> (copy)"), e.g. to branch a campaign before a risky choice. */
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
export const deleteLibrarySource: (id: string) => Promise<void> = library.deleteLibrarySource;
export const setLibrarySourceEnabled: (id: string, enabled: boolean) => Promise<void> = library.setLibrarySourceEnabled;
/** Entries for the given sources (all enabled imported sources when omitted). */
export const getLibraryEntries: (sourceIds?: string[]) => Promise<CompendiumEntry[]> = library.getLibraryEntries;

// ---------------------------------------------------------------------------
// Backups (export / import save files)
// ---------------------------------------------------------------------------

export const exportCampaignBundle: (campaignId: string) => Promise<CampaignBundle> = backup.exportCampaignBundle;
/** Export and trigger a browser download of "<campaign-name-slug>.solodm.json". */
export const downloadCampaign: (campaignId: string) => Promise<void> = backup.downloadCampaign;
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
// One tab at a time per campaign (CONTRACT — implemented by the storage module)
// ---------------------------------------------------------------------------

export interface CampaignLock {
  release(): void;
  /** Resolves if another tab takes the campaign over (steal). */
  lost: Promise<void>;
}

/**
 * Hold an exclusive per-campaign lock (Web Locks API) while the campaign is open at the table.
 * Resolves null when another tab already holds it (unless steal: true, which takes it over).
 * Where Web Locks are unavailable, resolves a lock that never conflicts.
 */
export const acquireCampaignLock: (campaignId: string, opts?: { steal?: boolean }) => Promise<CampaignLock | null> =
  async () => {
    throw new Error('storage: acquireCampaignLock not implemented');
  };
