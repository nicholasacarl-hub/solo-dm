/**
 * The active campaign, loaded into memory. Every mutation is write-through: it updates this
 * store AND persists to IndexedDB (src/storage) before resolving.
 *
 * Producers: the DM agent (src/dm) and the UI (player edits). Consumers: the UI.
 *
 * CONTRACT — implemented by the storage/state module. Other modules depend on these exact
 * names and semantics; do not change signatures without updating every caller.
 */
import { create } from 'zustand';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type {
  Campaign,
  Character,
  Clock,
  CombatState,
  HomebrewEntry,
  InteractionRequest,
  InteractionResponse,
  JournalEntry,
  LogEntry,
  NewLogEntry,
  Quest,
  Session,
  TranscriptMessage,
  UsageTotals,
} from '@/types';

export type DmPhase =
  | 'idle'
  | 'starting' // creating a session / building the prompt
  | 'thinking' // request sent, nothing streamed yet
  | 'streaming' // narration text arriving
  | 'tool' // running a tool
  | 'waiting-player' // a tool is waiting on the player (roll prompt, short rest...)
  | 'ending-session' // writing the recap
  | 'error';

export interface DmStatus {
  phase: DmPhase;
  /** Short human text for the activity indicator, e.g. "Consulting the rules…". */
  activity: string | null;
  error: string | null;
  /** True when the failed request can be retried with dm.retry(). */
  retryable: boolean;
}

export type JournalUpsert = Partial<Omit<JournalEntry, 'campaignId'>> & Pick<JournalEntry, 'kind' | 'name'>;
export type QuestUpsert = Partial<Omit<Quest, 'campaignId'>> & Pick<Quest, 'title'>;
export type ClockUpsert = Partial<Omit<Clock, 'campaignId'>> & Pick<Clock, 'name'>;

export interface GameStoreState {
  campaignId: string | null;
  campaign: Campaign | null;
  character: Character | null;
  /** All sessions of the campaign, oldest first. */
  sessions: Session[];
  /** The session with status 'active', if any. */
  activeSession: Session | null;
  /** API transcript of the active session, ordered by seq. */
  transcript: TranscriptMessage[];
  /** Display log for the whole campaign, ordered by seq. */
  log: LogEntry[];
  combat: CombatState | null;
  journal: JournalEntry[];
  quests: Quest[];
  clocks: Clock[];
  /** Homebrew for this campaign plus shared (campaignId null) homebrew. */
  homebrew: HomebrewEntry[];
  dm: DmStatus;
  /** The interaction a DM tool is currently waiting on (one at a time). */
  interaction: InteractionRequest | null;
  /** Notes for the DM about player-side changes (manual sheet edits...), delivered on the next turn. */
  pendingDmNotices: string[];
  loading: boolean;
  loadError: string | null;
}

export interface GameStoreActions {
  /** Load everything for a campaign into memory (replaces any loaded campaign). */
  loadCampaign(id: string): Promise<void>;
  unloadCampaign(): void;
  /** Re-read the loaded campaign from the database (after an import or sync). */
  reload(): Promise<void>;

  updateCampaign(patch: Partial<Campaign> | ((c: Campaign) => Campaign)): Promise<Campaign>;

  /** Replace the character (builder / import) and link it to the campaign. */
  setCharacter(character: Character): Promise<void>;
  /** Apply a pure update; bumps updatedAt; persists. Rejects if no character is loaded. */
  updateCharacter(fn: (c: Character) => Character): Promise<Character>;

  /** Persist a new session, mark it active, set campaign.activeSessionId and bump sessionCount. */
  startSession(session: Session): Promise<void>;
  /** Patch the active session (or the session with `id`). */
  updateSession(patch: Partial<Session>, id?: string): Promise<Session>;
  /** Mark the active session ended (sets endedAt, clears campaign.activeSessionId). */
  endActiveSession(patch?: Partial<Session>): Promise<Session | null>;

  /** Append API messages to the active session's transcript (append-only), assigning seq. */
  appendTranscript(params: BetaMessageParam[]): Promise<TranscriptMessage[]>;
  /**
   * Remove transcript messages with seq > `seq` (only ever trims from the END — used for
   * regenerate / cancelled turns; never edit the middle of a transcript).
   */
  truncateTranscriptAfter(seq: number): Promise<void>;

  /** Append a display-log entry (assigns id, seq, campaignId, sessionId, createdAt) and persist it. */
  appendLog(entry: NewLogEntry): Promise<LogEntry>;
  /**
   * Patch a log entry. With persist: false only memory is updated (use for streaming text deltas),
   * then call again with persist: true (the default) when the text is final.
   */
  updateLog(id: string, patch: Partial<LogEntry>, opts?: { persist?: boolean }): Promise<void>;
  removeLog(ids: string[]): Promise<void>;

  setCombat(state: CombatState | null): Promise<void>;

  /** Insert or update journal entries matched by kind + case-insensitive name. Sets first/lastSession. */
  upsertJournal(entries: JournalUpsert[]): Promise<JournalEntry[]>;
  deleteJournal(id: string): Promise<void>;
  /** Insert or update a quest matched by case-insensitive title. */
  upsertQuest(quest: QuestUpsert): Promise<Quest>;
  deleteQuest(id: string): Promise<void>;
  /** Insert or update a clock matched by case-insensitive name (filled is clamped to 0..segments). */
  upsertClock(clock: ClockUpsert): Promise<Clock>;
  deleteClock(id: string): Promise<void>;

  saveHomebrew(entry: HomebrewEntry): Promise<HomebrewEntry>;
  deleteHomebrew(id: string): Promise<void>;

  /** Add token usage to the campaign and the active session totals. */
  addUsage(delta: UsageTotals): Promise<void>;

  setDmStatus(patch: Partial<DmStatus>): void;

  /** Show an interaction to the player and wait for the answer. Rejects if cancelled. */
  requestInteraction(request: InteractionRequest): Promise<InteractionResponse>;
  resolveInteraction(id: string, response: InteractionResponse): void;
  cancelInteraction(id: string, reason?: string): void;

  queueDmNotice(text: string): void;
  /** Return and clear pending DM notices. */
  takeDmNotices(): string[];
}

export type GameStore = GameStoreState & GameStoreActions;

export const initialDmStatus: DmStatus = { phase: 'idle', activity: null, error: null, retryable: false };

const notImplemented = (): never => {
  throw new Error('gameStore: not implemented');
};

/** STUB — replaced by the storage/state module implementation. */
export const useGame = create<GameStore>()(() => ({
  campaignId: null,
  campaign: null,
  character: null,
  sessions: [],
  activeSession: null,
  transcript: [],
  log: [],
  combat: null,
  journal: [],
  quests: [],
  clocks: [],
  homebrew: [],
  dm: initialDmStatus,
  interaction: null,
  pendingDmNotices: [],
  loading: false,
  loadError: null,
  loadCampaign: notImplemented,
  unloadCampaign: notImplemented,
  reload: notImplemented,
  updateCampaign: notImplemented,
  setCharacter: notImplemented,
  updateCharacter: notImplemented,
  startSession: notImplemented,
  updateSession: notImplemented,
  endActiveSession: notImplemented,
  appendTranscript: notImplemented,
  truncateTranscriptAfter: notImplemented,
  appendLog: notImplemented,
  updateLog: notImplemented,
  removeLog: notImplemented,
  setCombat: notImplemented,
  upsertJournal: notImplemented,
  deleteJournal: notImplemented,
  upsertQuest: notImplemented,
  deleteQuest: notImplemented,
  upsertClock: notImplemented,
  deleteClock: notImplemented,
  saveHomebrew: notImplemented,
  deleteHomebrew: notImplemented,
  addUsage: notImplemented,
  setDmStatus: notImplemented,
  requestInteraction: notImplemented,
  resolveInteraction: notImplemented,
  cancelInteraction: notImplemented,
  queueDmNotice: notImplemented,
  takeDmNotices: notImplemented,
}));
