/**
 * Public data shapes of the storage module (re-exported from '@/storage').
 */
import type {
  Campaign,
  CampaignSettings,
  Character,
  Clock,
  CombatState,
  HomebrewEntry,
  JournalEntry,
  LogEntry,
  Quest,
  Session,
  TranscriptMessage,
} from '@/types';

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
  clocks: Clock[];
  /** Campaign homebrew plus shared homebrew. */
  homebrew: HomebrewEntry[];
}

/** Everything that belongs to one campaign (the payload of a bundle). */
export interface CampaignData {
  campaign: Campaign;
  character: Character | null;
  sessions: Session[];
  /** Transcripts of all sessions. */
  transcript: TranscriptMessage[];
  log: LogEntry[];
  combat: CombatState | null;
  journal: JournalEntry[];
  quests: Quest[];
  clocks: Clock[];
  /** Campaign-scoped homebrew only. */
  homebrew: HomebrewEntry[];
}

export interface CampaignBundle extends CampaignData {
  format: 'solo-dm-campaign';
  version: 1;
  exportedAt: number;
}

export interface RemoteSave {
  campaignId: string;
  name: string;
  updatedAt: number;
  path: string;
  sha: string;
}

export interface SyncReport {
  /** Ids of campaigns uploaded to GitHub. */
  pushed: string[];
  /** Ids of campaigns downloaded from GitHub (they replaced the local copy, if any). */
  pulled: string[];
  /** Ids of campaigns that needed no transfer (already in sync, or deleted on this device since the last sync). */
  skipped: string[];
  conflicts: { campaignId: string; name: string; localUpdatedAt: number; remoteUpdatedAt: number }[];
  /** Readable per-campaign problems; the rest of the sync still ran. */
  errors: string[];
}
