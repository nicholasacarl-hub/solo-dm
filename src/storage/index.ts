/**
 * Persistence API (IndexedDB via Dexie). CONTRACT — implemented by the storage module.
 * The UI and other modules import only from '@/storage'.
 *
 * Everything lives in this browser's IndexedDB database "solo-dm". Imported sourcebook text never
 * leaves the browser except through an explicit export the player chooses.
 */
import type {
  Campaign,
  CampaignSettings,
  Character,
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

const todo = (): never => {
  throw new Error('storage: not implemented');
};

// ---------------------------------------------------------------------------
// Save slots (campaigns)
// ---------------------------------------------------------------------------

export interface CampaignSummary {
  campaign: Campaign;
  character: Pick<Character, 'id' | 'name' | 'species' | 'classes' | 'portrait' | 'hp' | 'xp'> | null;
  /** Total character level (0 when there is no character yet). */
  level: number;
}

export interface NewCampaignInput {
  name: string;
  premise: string;
  settings: CampaignSettings;
  coverEmoji?: string;
  coverColor?: string;
}

/** Most recently played first, then most recently created. */
export const listCampaigns: () => Promise<CampaignSummary[]> = todo;
/** React hook: live-updating campaign list (undefined while loading). */
export const useCampaignList: () => CampaignSummary[] | undefined = todo;
export const getCampaign: (id: string) => Promise<Campaign | undefined> = todo;
export const createCampaign: (input: NewCampaignInput) => Promise<Campaign> = todo;
/** Deletes the campaign and everything belonging to it (character, sessions, transcript, log, journal...). */
export const deleteCampaign: (id: string) => Promise<void> = todo;
/** Deep copy with new ids ("<name> (copy)"), e.g. to branch a campaign before a risky choice. */
export const duplicateCampaign: (id: string, newName?: string) => Promise<Campaign> = todo;

// ---------------------------------------------------------------------------
// Low-level record access (used by the game store)
// ---------------------------------------------------------------------------

export interface CampaignRecords {
  campaign: Campaign;
  character: Character | null;
  sessions: Session[];
  /** Transcript of the active session only. */
  transcript: TranscriptMessage[];
  log: LogEntry[];
  combat: CombatState | null;
  journal: JournalEntry[];
  quests: Quest[];
  /** Campaign homebrew plus shared homebrew. */
  homebrew: HomebrewEntry[];
}

export const loadCampaignRecords: (campaignId: string) => Promise<CampaignRecords | null> = todo;
export const putCampaign: (c: Campaign) => Promise<void> = todo;
export const putCharacter: (c: Character) => Promise<void> = todo;
export const putSession: (s: Session) => Promise<void> = todo;
export const putTranscript: (messages: TranscriptMessage[]) => Promise<void> = todo;
export const deleteTranscriptAfter: (sessionId: string, seq: number) => Promise<void> = todo;
export const getTranscript: (sessionId: string) => Promise<TranscriptMessage[]> = todo;
export const putLog: (entries: LogEntry[]) => Promise<void> = todo;
export const deleteLog: (ids: string[]) => Promise<void> = todo;
export const putCombat: (campaignId: string, state: CombatState | null) => Promise<void> = todo;
export const putJournal: (entries: JournalEntry[]) => Promise<void> = todo;
export const deleteJournalEntry: (id: string) => Promise<void> = todo;
export const putQuest: (q: Quest) => Promise<void> = todo;
export const deleteQuestRecord: (id: string) => Promise<void> = todo;

// ---------------------------------------------------------------------------
// Homebrew & library (imported sourcebooks)
// ---------------------------------------------------------------------------

export const putHomebrew: (h: HomebrewEntry) => Promise<void> = todo;
export const deleteHomebrewRecord: (id: string) => Promise<void> = todo;
/** campaignId undefined = all homebrew; null = shared only; string = that campaign + shared. */
export const listHomebrew: (campaignId?: string | null) => Promise<HomebrewEntry[]> = todo;
export const useHomebrewList: (campaignId?: string | null) => HomebrewEntry[] | undefined = todo;

export const listLibrarySources: () => Promise<LibrarySource[]> = todo;
export const useLibrarySources: () => LibrarySource[] | undefined = todo;
/** Save a source and replace all of its entries. */
export const saveLibrarySource: (source: LibrarySource, entries: CompendiumEntry[]) => Promise<void> = todo;
export const deleteLibrarySource: (id: string) => Promise<void> = todo;
export const setLibrarySourceEnabled: (id: string, enabled: boolean) => Promise<void> = todo;
/** Entries for the given sources (all enabled imported sources when omitted). */
export const getLibraryEntries: (sourceIds?: string[]) => Promise<CompendiumEntry[]> = todo;

// ---------------------------------------------------------------------------
// Backups (export / import save files)
// ---------------------------------------------------------------------------

export interface CampaignBundle {
  format: 'solo-dm-campaign';
  version: 1;
  exportedAt: number;
  campaign: Campaign;
  character: Character | null;
  sessions: Session[];
  /** Transcripts of all sessions. */
  transcript: TranscriptMessage[];
  log: LogEntry[];
  combat: CombatState | null;
  journal: JournalEntry[];
  quests: Quest[];
  /** Campaign-scoped homebrew only. */
  homebrew: HomebrewEntry[];
}

export const exportCampaignBundle: (campaignId: string) => Promise<CampaignBundle> = todo;
/** Export and trigger a browser download of "<campaign-name>.solodm.json". */
export const downloadCampaign: (campaignId: string) => Promise<void> = todo;
/** Validate a parsed file. Throws a readable Error when it isn't a valid bundle. */
export const parseCampaignBundle: (data: unknown) => CampaignBundle = todo;
/**
 * Import a bundle. If a campaign with the same id exists: mode 'replace' overwrites it,
 * 'copy' imports under fresh ids. Returns the imported campaign.
 */
export const importCampaignBundle: (bundle: CampaignBundle, mode?: 'replace' | 'copy') => Promise<Campaign> = todo;

// ---------------------------------------------------------------------------
// Optional cloud saves in the player's own private GitHub repo
// ---------------------------------------------------------------------------

export interface RemoteSave {
  campaignId: string;
  name: string;
  updatedAt: number;
  path: string;
  sha: string;
}

export interface SyncReport {
  pushed: string[];
  pulled: string[];
  skipped: string[];
  conflicts: { campaignId: string; name: string; localUpdatedAt: number; remoteUpdatedAt: number }[];
  errors: string[];
}

/** Check the token and repo; reports whether the repo is private (public repos are refused for saves). */
export const testGithubConnection: (
  settings: GithubSyncSettings,
) => Promise<{ ok: boolean; private?: boolean; error?: string }> = todo;
export const listRemoteSaves: (settings: GithubSyncSettings) => Promise<RemoteSave[]> = todo;
export const pushCampaignToGithub: (campaignId: string, settings: GithubSyncSettings) => Promise<void> = todo;
export const pullCampaignFromGithub: (save: RemoteSave, settings: GithubSyncSettings) => Promise<Campaign> = todo;
/** Two-way sync: newer side wins; both-changed-since-last-sync is reported as a conflict, not overwritten. */
export const syncWithGithub: (settings: GithubSyncSettings) => Promise<SyncReport> = todo;
