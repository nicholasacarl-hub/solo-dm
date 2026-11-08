/**
 * The active campaign, loaded into memory. Every mutation is write-through: it updates this
 * store AND persists to IndexedDB (src/storage) before resolving.
 *
 * Producers: the DM agent (src/dm) and the UI (player edits). Consumers: the UI.
 *
 * CONTRACT — implemented by the storage/state module. Other modules depend on these exact
 * names and semantics; do not change signatures without updating every caller.
 *
 * Implementation notes:
 * - Memory updates are synchronous and optimistic (an action has updated the store by the time it
 *   returns its promise); persistence follows, strictly in call order per campaign, so rapid updates
 *   (streaming, batched tool calls) can't interleave or regress. A failed write logs console.error
 *   and rejects the action's promise; memory keeps the optimistic value.
 * - Every persisted change also bumps campaign.updatedAt, which is what cloud sync compares.
 * - One tab writes a campaign at a time: while another tab holds the campaign's lock (it is open at
 *   the table there; storage.acquireCampaignLock), writes are refused with OPEN_ELSEWHERE_ERROR.
 *   Writes queued before the campaign was replaced (import, GitHub pull) or deleted are dropped.
 * - Pending DM notices are saved on the campaign record (campaign.pendingDmNotices), so leaving the
 *   table or reloading doesn't lose them. Notices queued from elsewhere (the Library, another tab)
 *   are kept by every save and picked up into memory.
 * - Battle map: the store may import the engine by path (@/engine/movement, @/engine/battleMap,
 *   @/engine/mapNormalize, @/engine/character, @/engine/combat) and @/lib/answered — a deliberate dependency, so
 *   the player's own move (commitHeroMove) keeps every gate in one place: ./heroMove.ts, pure, shared with the
 *   test fakes. Combat rows are normalized on load (mapNormalize). It imports nothing from @/dm or @/ui.
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
  QuestObjective,
  Session,
  TranscriptMessage,
  UsageTotals,
} from '@/types';
import type { HeroMoveOutcome, HeroMoveRequest, MoveRefusal } from '@/engine/movement';
import { normalizeCombatState } from '@/engine/mapNormalize';
import { nameKey, newId } from '@/lib/id';
import * as storage from '@/storage';
import type { CampaignRecords } from '@/storage';
import { onCampaignChange } from '@/storage/events';
import { isBusyDmPhase, planHeroMoveCommit, planHeroMoveUndo } from './heroMove';

export { canUndoHeroMove, heroMoveBlock, pendingPlayerStop } from './heroMove';

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

/** One hero move of this turn, for Undo (D49). */
export interface HeroMoveSnapshot {
  /** The combat before and after the move (reference identity is the undo check). */
  before: CombatState;
  after: CombatState;
  /** The move stood the hero up (undo re-adds Prone). */
  stoodUp: boolean;
  /** It ran into something hidden: never undoable. */
  revealedHidden: boolean;
}

/** Why commitHeroMove refused, checked in this order (the UI words each one). */
export type HeroMoveBlock =
  | 'no-map'
  | 'not-your-turn'
  | 'dm-busy'
  | 'interaction'
  | 'no-session'
  | 'unplaced'
  | 'stop-pending'
  | 'refused';

export type HeroMoveResult =
  | { ok: true; outcome: Extract<HeroMoveOutcome, { status: 'moved' | 'stopped' }> }
  | { ok: false; block: HeroMoveBlock; refusal?: MoveRefusal };

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
  /**
   * Snapshots of this turn's hero moves, newest last (D49). In memory only: never persisted; reset by
   * loadCampaign / unloadCampaign.
   */
  heroMoveUndo: HeroMoveSnapshot[];
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
  /**
   * Functional update against the latest in-memory combat (mirrors updateCharacter). Rejects when no
   * campaign or no combat is loaded. When fn returns the same object, nothing is set or persisted. Otherwise bumps
   * campaign.updatedAt and persists like setCombat ("the combat tracker"). fn never returns null: end a fight with
   * setCombat(null).
   */
  updateCombat(fn: (c: CombatState) => CombatState): Promise<CombatState>;
  /** The player's own move on the battle map: gated, resolved by the engine on the true map. Never throws for game reasons. */
  commitHeroMove(req: HeroMoveRequest): Promise<HeroMoveResult>;
  /** Undo the newest hero move of this turn if nothing changed since and the DM hasn't been sent it. */
  undoHeroMove(): Promise<boolean>;

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

  /** Queue a note for the DM's next turn; saved with the campaign, so it survives a reload. */
  queueDmNotice(text: string): void;
  /**
   * Return and clear pending DM notices. The stored copy is cleared by the campaign's next save —
   * normally the transcript append that delivers them — so a failed append can't lose them.
   */
  takeDmNotices(): string[];
}

export type GameStore = GameStoreState & GameStoreActions;

export const initialDmStatus: DmStatus = { phase: 'idle', activity: null, error: null, retryable: false };

// ---------------------------------------------------------------------------
// Ordered write-behind persistence
// ---------------------------------------------------------------------------

/** Queue for writes not tied to a loaded campaign (shared homebrew); never a campaign id (UUID). */
const LIBRARY_QUEUE = 'queue:library';

const writeQueues = new Map<string, Promise<void>>();
/** Incremented on every enqueued write, so readers can tell whether writes slipped in meanwhile. */
let writeGeneration = 0;
const noop = () => {};

function enqueueWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (writeQueues.get(key) ?? Promise.resolve()).then(task);
  writeQueues.set(key, run.then(noop, noop));
  writeGeneration += 1;
  return run;
}

/** A write this tab must not make (the campaign is open elsewhere, or was replaced or deleted). */
class WriteRefused extends Error {}

const CAMPAIGN_REPLACED =
  'This campaign was replaced or deleted (by an import, a sync or another tab) before the change was saved.';
const CAMPAIGN_DELETED = 'This campaign has been deleted.';

/**
 * Bumped when a campaign is replaced or deleted behind this store's back (storage events, from this
 * tab or another): writes queued before that are dropped instead of overwriting the new data.
 */
const replacements = new Map<string, number>();
const replacementOf = (campaignId: string) => replacements.get(campaignId) ?? 0;

/** Why this tab may not write the campaign right now, or null. */
async function refusal(key: string, replacement: number): Promise<string | null> {
  if (key === LIBRARY_QUEUE) return null;
  if (replacementOf(key) !== replacement) return CAMPAIGN_REPLACED;
  return (await storage.isCampaignOpenElsewhere(key)) ? storage.OPEN_ELSEWHERE_ERROR : null;
}

/** Run `task` after every earlier write of this campaign. Failures are logged and rethrown readably. */
function persist<T>(key: string, what: string, task: () => Promise<T>): Promise<T> {
  const replacement = replacementOf(key);
  return enqueueWrite(key, async () => {
    const refused = await refusal(key, replacement);
    if (refused) throw new WriteRefused(refused);
    return task();
  }).catch((cause: unknown) => {
    const detail = cause instanceof Error ? cause.message : String(cause);
    if (cause instanceof WriteRefused) console.warn(`[gameStore] Didn't save ${what}: ${detail}`);
    else console.error(`[gameStore] Couldn't save ${what}:`, cause);
    throw new Error(`Couldn't save ${what}: ${detail}`, { cause });
  });
}

// ---------------------------------------------------------------------------
// DM notices on the campaign record
// ---------------------------------------------------------------------------

/** Per campaign: the DM notices stored on its record as of this tab's last load or save. */
const storedNotices = new Map<string, string[]>();

/** Add notices queued elsewhere (the Library, another tab) to the loaded campaign's memory. */
function adoptNotices(campaignId: string, notices: readonly string[]): void {
  const s = useGame.getState();
  if (!s.campaign || s.campaign.id !== campaignId) return;
  const fresh = notices.filter((n) => !s.pendingDmNotices.includes(n));
  if (fresh.length === 0) return;
  const pendingDmNotices = [...s.pendingDmNotices, ...fresh];
  useGame.setState({ pendingDmNotices, campaign: { ...s.campaign, pendingDmNotices } });
}

/** Record what a save left stored; notices this tab neither saw nor wrote were queued elsewhere. */
function noticesSaved(campaignId: string, seen: readonly string[], stored: string[], own: readonly string[]): void {
  storedNotices.set(campaignId, stored);
  const queuedElsewhere = stored.filter((n) => !seen.includes(n) && !own.includes(n));
  if (queuedElsewhere.length > 0) adoptNotices(campaignId, queuedElsewhere);
}

/** Save the campaign record from a write task, keeping (and picking up) notices queued elsewhere. */
async function saveCampaign(campaign: Campaign): Promise<void> {
  const seen = storedNotices.get(campaign.id) ?? [];
  const stored = await storage.putCampaignKeepingNotices(campaign, seen);
  noticesSaved(campaign.id, seen, stored, campaign.pendingDmNotices ?? []);
}

/**
 * Save one notice by adding it to the stored record (a merge, never a snapshot, so it can't
 * overwrite anything newer and never recreates a deleted campaign).
 */
function saveNotice(campaignId: string, notice: string, updatedAt?: number): Promise<void> {
  return enqueueWrite(campaignId, async () => {
    const seen = storedNotices.get(campaignId);
    const stored = await storage.addPendingDmNotice(campaignId, notice, updatedAt);
    if (stored && seen) noticesSaved(campaignId, seen, stored, [notice]);
  }).catch((cause: unknown) => {
    const detail = cause instanceof Error ? cause.message : String(cause);
    console.error("[gameStore] Couldn't save a note for the DM:", cause);
    throw new Error(`Couldn't save the note for the DM: ${detail}`, { cause });
  });
}

/** Queue a notice on the loaded campaign (memory first, then saved). Resolves once it is saved. */
function queueLoadedNotice(text: string): Promise<void> {
  const notice = text.trim();
  const s = useGame.getState();
  if (!notice || s.pendingDmNotices.includes(notice)) return Promise.resolve();
  const pendingDmNotices = [...s.pendingDmNotices, notice];
  if (!s.campaign) {
    // Nothing loaded to save it with (callers outside a campaign should use queueCampaignNotice).
    useGame.setState({ pendingDmNotices });
    return Promise.resolve();
  }
  const touched: Campaign = { ...touch(s.campaign), pendingDmNotices };
  useGame.setState({ pendingDmNotices, campaign: touched });
  return saveNotice(touched.id, notice, touched.updatedAt);
}

// ---------------------------------------------------------------------------
// Streaming narration
// ---------------------------------------------------------------------------

/** Narration that is still streaming is also saved this often, so a reload mid-stream keeps most of it. */
export const STREAM_CHECKPOINT_MS = 3000;
/** When each streaming narration entry was last saved. */
const streamSavedAt = new Map<string, number>();

/**
 * DM narration still marked as streaming when a campaign is opened fresh in a tab was cut off (the
 * tab closed, reloaded or left mid-stream): from here on it is finished text.
 */
function settleCutOffNarration(log: LogEntry[]): { log: LogEntry[]; settled: LogEntry[] } {
  const settled: LogEntry[] = [];
  const next = log.map((entry) => {
    if (entry.kind !== 'dm' || !entry.streaming) return entry;
    const done: LogEntry = { ...entry, streaming: false };
    settled.push(done);
    return done;
  });
  return settled.length > 0 ? { log: next, settled } : { log, settled };
}

/** Resolves once every queued write (of one campaign, or of all) has finished. */
export async function whenPersisted(campaignId?: string): Promise<void> {
  for (;;) {
    const generation = writeGeneration;
    if (campaignId === undefined) await Promise.all(writeQueues.values());
    else await writeQueues.get(campaignId);
    if (generation === writeGeneration) return;
  }
}

/** Read a campaign once its queued writes have landed (re-reading if more writes arrive meanwhile). */
async function readSettled(campaignId: string): Promise<CampaignRecords | null> {
  for (let attempt = 0; ; attempt += 1) {
    await whenPersisted(campaignId);
    const generation = writeGeneration;
    const records = await storage.loadCampaignRecords(campaignId);
    if (generation === writeGeneration || attempt >= 2) return records;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function requireCampaign(campaign: Campaign | null): Campaign {
  if (!campaign) throw new Error('No campaign is loaded.');
  return campaign;
}

/** A strictly increasing updatedAt, even if the clock steps backwards. */
function nextUpdatedAt(previous: number, now = Date.now()): number {
  return Math.max(now, previous + 1);
}

function touch(campaign: Campaign, now = Date.now()): Campaign {
  return { ...campaign, updatedAt: nextUpdatedAt(campaign.updatedAt, now) };
}

/** A Character the engine changed, saved the way updateCharacter saves one: same id and campaign, newer updatedAt. */
function sheetWrite(next: Character, current: Character, campaign: Campaign, now: number): Character {
  return { ...next, id: current.id, campaignId: campaign.id, updatedAt: nextUpdatedAt(current.updatedAt, now) };
}

/**
 * One persist chain for a hero move or its undo. The Character (standing up, or Prone again) goes first, so a crash
 * between the writes leaves the more conservative state (spec §6.2); then the combat, then the campaign.
 */
function persistHeroMove(campaign: Campaign, combat: CombatState, character: Character | null): Promise<void> {
  return persist(campaign.id, 'the battle map', async () => {
    if (character) await storage.putCharacter(character);
    await storage.putCombat(campaign.id, combat);
    await saveCampaign(campaign);
  });
}

/** Comparison key for names: nameKey, falling back to lowercase for names it strips entirely (e.g. CJK). */
function matchKey(name: string): string {
  return nameKey(name) || name.trim().toLowerCase();
}

function definedOnly<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function replaceById<T extends { id: string }>(list: T[], item: T): T[] {
  return list.map((x) => (x.id === item.id ? item : x));
}

/**
 * The display name after an upsert: matching by id is a rename; matching by name keeps the existing
 * spelling (the DM writing "old tam" shouldn't rename "Old Tam").
 */
function keptName(existing: { id: string; name: string }, upsertId: string | undefined, name: string): string {
  return upsertId === existing.id ? name : existing.name;
}

/** Index of the record with `id`, else of the one whose key matches. */
function findMatch<T extends { id: string }>(list: T[], id: string | undefined, key: (x: T) => string, wanted: string): number {
  const byId = id ? list.findIndex((x) => x.id === id) : -1;
  return byId >= 0 ? byId : list.findIndex((x) => key(x) === wanted);
}

function mergeTags(existing: string[], incoming: string[] = []): string[] {
  const seen = new Set(existing.map((t) => t.trim().toLowerCase()));
  const tags = [...existing];
  for (const raw of incoming) {
    const tag = raw.trim();
    if (tag && !seen.has(tag.toLowerCase())) {
      seen.add(tag.toLowerCase());
      tags.push(tag);
    }
  }
  return tags;
}

function sumUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    requests: a.requests + b.requests,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    estimatedCostUsd: a.estimatedCostUsd + b.estimatedCostUsd,
  };
}

const byName = (a: HomebrewEntry, b: HomebrewEntry) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

function upsertJournalEntry(
  journal: JournalEntry[],
  upsert: JournalUpsert,
  ctx: { campaignId: string; sessionNumber: number; now: number },
): JournalEntry {
  const name = upsert.name.trim();
  if (!name) throw new Error('Journal entries need a name.');
  const index = findMatch(journal, upsert.id, (j) => (j.kind === upsert.kind ? matchKey(j.name) : ''), matchKey(name));
  const { id, tags, firstSession: _first, lastSession: _last, createdAt: _created, updatedAt: _updated, ...fields } = upsert;
  if (index >= 0) {
    const existing = journal[index];
    const merged: JournalEntry = {
      ...existing,
      ...definedOnly(fields),
      campaignId: existing.campaignId,
      name: keptName(existing, id, name),
      tags: mergeTags(existing.tags, tags),
      lastSession: ctx.sessionNumber,
      updatedAt: nextUpdatedAt(existing.updatedAt, ctx.now),
    };
    journal[index] = merged;
    return merged;
  }
  const created: JournalEntry = {
    summary: '',
    secret: false,
    ...definedOnly(fields),
    id: id ?? newId(),
    campaignId: ctx.campaignId,
    kind: upsert.kind,
    name,
    tags: mergeTags([], tags),
    firstSession: ctx.sessionNumber,
    lastSession: ctx.sessionNumber,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  journal.push(created);
  return created;
}

/** Keep objective ids stable (reuse the id of an existing objective with the same text) and unique. */
function withObjectiveIds(incoming: QuestObjective[], existing: QuestObjective[]): QuestObjective[] {
  const used = new Set<string>();
  return incoming.map((o) => {
    const candidate = o.id || existing.find((e) => matchKey(e.text) === matchKey(o.text))?.id;
    const id = candidate && !used.has(candidate) ? candidate : newId();
    used.add(id);
    return { id, text: o.text, done: o.done ?? false };
  });
}

function clampClock(clock: Clock, fallbackSegments: number): Clock {
  const segments = Number.isFinite(clock.segments) ? Math.max(1, Math.round(clock.segments)) : fallbackSegments;
  const filled = Number.isFinite(clock.filled) ? Math.min(segments, Math.max(0, Math.round(clock.filled))) : 0;
  return { ...clock, segments, filled };
}

const DEFAULT_CLOCK_SEGMENTS = 4;

// ---------------------------------------------------------------------------
// Player interactions (one shown at a time; extra requests wait their turn)
// ---------------------------------------------------------------------------

interface PendingInteraction {
  request: InteractionRequest;
  resolve: (response: InteractionResponse) => void;
  reject: (error: Error) => void;
}

const pendingInteractions = new Map<string, PendingInteraction>();

function firstPendingInteraction(): InteractionRequest | null {
  const [first] = pendingInteractions.values();
  return first?.request ?? null;
}

function cancelAllInteractions(): void {
  const pending = [...pendingInteractions.values()];
  pendingInteractions.clear();
  for (const p of pending) p.reject(new Error('cancelled'));
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

type CampaignSlice = Omit<GameStoreState, 'dm' | 'interaction'>;

function emptyCampaignSlice(): CampaignSlice {
  return {
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
    pendingDmNotices: [],
    heroMoveUndo: [],
    loading: false,
    loadError: null,
  };
}

function sliceFromRecords(r: CampaignRecords): CampaignSlice {
  const activeSession =
    r.sessions.find((s) => s.id === r.campaign.activeSessionId && s.status === 'active') ?? null;
  return {
    campaignId: r.campaign.id,
    campaign: r.campaign,
    character: r.character,
    sessions: r.sessions,
    activeSession,
    transcript: activeSession ? r.transcript : [],
    log: r.log,
    // IndexedDB rows are never validated on the way in (old saves, other versions): read leniently, write nothing back.
    combat: r.combat ? normalizeCombatState(r.combat) : null,
    journal: r.journal,
    quests: r.quests,
    clocks: r.clocks,
    homebrew: r.homebrew,
    pendingDmNotices: r.campaign.pendingDmNotices ?? [],
    heroMoveUndo: [],
    loading: false,
    loadError: null,
  };
}

/** Bumped by every load/unload; a load whose token is stale discards its result. */
let loadToken = 0;

export const useGame = create<GameStore>()((set, get) => ({
  ...emptyCampaignSlice(),
  dm: initialDmStatus,
  interaction: null,

  async loadCampaign(id) {
    const token = ++loadToken;
    // Opened fresh in this tab (not a reload of what it already shows): no narration of its own
    // can still be streaming into it.
    const fresh = get().campaignId !== id;
    if (!fresh) {
      set({ loading: true, loadError: null });
    } else {
      cancelAllInteractions();
      set({ ...emptyCampaignSlice(), campaignId: id, loading: true, dm: initialDmStatus, interaction: null });
    }
    try {
      const records = await readSettled(id);
      if (token !== loadToken) return;
      if (!records) {
        set({ ...emptyCampaignSlice(), campaignId: id, loadError: 'This campaign could not be found. It may have been deleted.' });
        return;
      }
      storedNotices.set(id, records.campaign.pendingDmNotices ?? []);
      const slice = sliceFromRecords(records);
      const { log, settled } = fresh ? settleCutOffNarration(slice.log) : { log: slice.log, settled: [] };
      if (settled.length === 0 || !slice.campaign) {
        set(slice);
        return;
      }
      const touched = touch(slice.campaign);
      set({ ...slice, log, campaign: touched });
      void persist(id, 'the log', async () => {
        await storage.putLog(settled);
        await saveCampaign(touched);
      }).catch(noop);
    } catch (error) {
      if (token !== loadToken) return;
      console.error('[gameStore] Failed to load the campaign:', error);
      const detail = error instanceof Error ? error.message : String(error);
      set({ loading: false, loadError: `Couldn't load this campaign: ${detail}` });
    }
  },

  unloadCampaign() {
    loadToken += 1;
    cancelAllInteractions();
    // Pending notices stay saved on the campaign record and come back when it is loaded again.
    set({ ...emptyCampaignSlice(), dm: initialDmStatus, interaction: null });
  },

  async reload() {
    const { campaignId } = get();
    if (campaignId) await get().loadCampaign(campaignId);
  },

  async updateCampaign(patch) {
    const current = requireCampaign(get().campaign);
    const patched = typeof patch === 'function' ? patch(current) : { ...current, ...patch };
    const next: Campaign = { ...patched, id: current.id, updatedAt: nextUpdatedAt(current.updatedAt) };
    set({ campaign: next });
    await persist(current.id, 'the campaign', () => saveCampaign(next));
    return next;
  },

  async setCharacter(character) {
    const campaign = requireCampaign(get().campaign);
    const now = Date.now();
    const next: Character = { ...character, campaignId: campaign.id, updatedAt: now };
    const replacedId = campaign.characterId && campaign.characterId !== next.id ? campaign.characterId : null;
    const linked: Campaign = { ...touch(campaign, now), characterId: next.id };
    set({ character: next, campaign: linked });
    await persist(campaign.id, 'the character', async () => {
      await storage.putCharacter(next);
      if (replacedId) await storage.deleteCharacterRecord(replacedId);
      await saveCampaign(linked);
    });
  },

  async updateCharacter(fn) {
    const { campaign: loaded, character } = get();
    const campaign = requireCampaign(loaded);
    if (!character) throw new Error('This campaign has no character yet.');
    const now = Date.now();
    const next: Character = {
      ...fn(character),
      id: character.id,
      campaignId: campaign.id,
      updatedAt: nextUpdatedAt(character.updatedAt, now),
    };
    const touched = touch(campaign, now);
    set({ character: next, campaign: touched });
    await persist(campaign.id, 'the character sheet', async () => {
      await storage.putCharacter(next);
      await saveCampaign(touched);
    });
    return next;
  },

  async startSession(session) {
    const s = get();
    const campaign = requireCampaign(s.campaign);
    const now = Date.now();
    const previous =
      s.activeSession && s.activeSession.id !== session.id
        ? { ...s.activeSession, status: 'ended' as const, endedAt: s.activeSession.endedAt ?? now }
        : null;
    const started: Session = { ...session, campaignId: campaign.id, status: 'active', endedAt: null };
    const isNew = !s.sessions.some((x) => x.id === started.id);
    const sessions = [
      ...s.sessions.filter((x) => x.id !== started.id).map((x) => (previous && x.id === previous.id ? previous : x)),
      started,
    ].sort((a, b) => a.number - b.number);
    const next: Campaign = {
      ...touch(campaign, now),
      activeSessionId: started.id,
      sessionCount: Math.max(campaign.sessionCount + (isNew ? 1 : 0), started.number),
      lastPlayedAt: now,
      status: 'active',
    };
    set({
      campaign: next,
      sessions,
      activeSession: started,
      transcript: s.activeSession?.id === started.id ? s.transcript : [],
    });
    await persist(campaign.id, 'the new session', async () => {
      if (previous) await storage.putSession(previous);
      await storage.putSession(started);
      await saveCampaign(next);
    });
  },

  async updateSession(patch, id) {
    const s = get();
    const campaign = requireCampaign(s.campaign);
    const target = id === undefined ? s.activeSession : s.sessions.find((x) => x.id === id);
    if (!target) throw new Error(id === undefined ? 'There is no active session.' : 'That session is not part of this campaign.');
    if (target.id === s.activeSession?.id && patch.status === 'ended') {
      const ended = await get().endActiveSession(patch);
      if (ended) return ended;
    }
    const next: Session = { ...target, ...patch, id: target.id, campaignId: target.campaignId };
    const touched = touch(campaign);
    set({
      sessions: replaceById(s.sessions, next),
      activeSession: s.activeSession?.id === next.id ? next : s.activeSession,
      campaign: touched,
    });
    await persist(campaign.id, 'the session', async () => {
      await storage.putSession(next);
      await saveCampaign(touched);
    });
    return next;
  },

  async endActiveSession(patch = {}) {
    const s = get();
    const campaign = requireCampaign(s.campaign);
    const active = s.activeSession;
    if (!active) return null;
    const now = Date.now();
    const ended: Session = {
      ...active,
      ...patch,
      id: active.id,
      campaignId: active.campaignId,
      status: 'ended',
      endedAt: patch.endedAt ?? now,
    };
    const next: Campaign = { ...touch(campaign, now), activeSessionId: null, lastPlayedAt: now };
    set({ sessions: replaceById(s.sessions, ended), activeSession: null, transcript: [], campaign: next });
    await persist(campaign.id, 'the session', async () => {
      await storage.putSession(ended);
      await saveCampaign(next);
    });
    return ended;
  },

  async appendTranscript(params) {
    const s = get();
    const campaign = requireCampaign(s.campaign);
    const session = s.activeSession;
    if (!session) throw new Error('No active session: start a session before adding to the DM transcript.');
    if (params.length === 0) return [];
    const now = Date.now();
    const lastSeq = s.transcript.at(-1)?.seq ?? 0;
    const messages: TranscriptMessage[] = params.map((param, i) => ({
      id: newId(),
      sessionId: session.id,
      seq: lastSeq + 1 + i,
      param,
      createdAt: now,
    }));
    const touched = touch(campaign, now);
    set({ transcript: [...s.transcript, ...messages], campaign: touched });
    await persist(campaign.id, 'the DM transcript', async () => {
      await storage.putTranscript(messages);
      await saveCampaign(touched);
    });
    return messages;
  },

  async truncateTranscriptAfter(seq) {
    const s = get();
    const campaign = requireCampaign(s.campaign);
    const session = s.activeSession;
    if (!session) throw new Error('No active session: there is no DM transcript to trim.');
    const kept = s.transcript.filter((m) => m.seq <= seq);
    const changed = kept.length !== s.transcript.length;
    const touched = changed ? touch(campaign) : campaign;
    if (changed) set({ transcript: kept, campaign: touched });
    await persist(campaign.id, 'the DM transcript', async () => {
      await storage.deleteTranscriptAfter(session.id, seq);
      if (changed) await saveCampaign(touched);
    });
  },

  async appendLog(entry) {
    const s = get();
    const campaign = requireCampaign(s.campaign);
    const now = Date.now();
    const full: LogEntry = {
      ...entry,
      id: newId(),
      campaignId: campaign.id,
      sessionId: s.activeSession?.id ?? null,
      seq: (s.log.at(-1)?.seq ?? 0) + 1,
      createdAt: now,
    };
    // Activity in a running session counts as playing (save slots sort by lastPlayedAt).
    const touched: Campaign = { ...touch(campaign, now), ...(s.activeSession && { lastPlayedAt: now }) };
    if (full.kind === 'dm' && full.streaming) streamSavedAt.set(full.id, now);
    set({ log: [...s.log, full], campaign: touched });
    await persist(campaign.id, 'the log', async () => {
      await storage.putLog([full]);
      await saveCampaign(touched);
    });
    return full;
  },

  async updateLog(id, patch, opts) {
    const s = get();
    const campaign = requireCampaign(s.campaign);
    const index = s.log.findLastIndex((e) => e.id === id);
    // Gone (removed, or the campaign was reloaded mid-stream): nothing to update.
    if (index < 0) return;
    const current = s.log[index];
    const next = { ...current, ...patch, id: current.id, campaignId: current.campaignId, seq: current.seq, kind: current.kind } as LogEntry;
    const log = s.log.slice();
    log[index] = next;
    const now = Date.now();
    const streaming = next.kind === 'dm' && next.streaming === true;
    if (opts?.persist === false) {
      const savedAt = streamSavedAt.get(id);
      if (streaming && savedAt === undefined) streamSavedAt.set(id, now);
      if (!streaming || savedAt === undefined || now - savedAt < STREAM_CHECKPOINT_MS) {
        set({ log });
        return;
      }
      // A checkpoint of narration still streaming: best effort, the final text is saved anyway.
      streamSavedAt.set(id, now);
      const checkpoint = touch(campaign, now);
      set({ log, campaign: checkpoint });
      void persist(campaign.id, 'the narration', async () => {
        await storage.putLog([next]);
        await saveCampaign(checkpoint);
      }).catch(noop);
      return;
    }
    if (streaming) streamSavedAt.set(id, now);
    else streamSavedAt.delete(id);
    const touched = touch(campaign, now);
    set({ log, campaign: touched });
    await persist(campaign.id, 'the log', async () => {
      await storage.putLog([next]);
      await saveCampaign(touched);
    });
  },

  async removeLog(ids) {
    const s = get();
    const campaign = requireCampaign(s.campaign);
    if (ids.length === 0) return;
    for (const id of ids) streamSavedAt.delete(id);
    const removed = new Set(ids);
    const touched = touch(campaign);
    set({ log: s.log.filter((e) => !removed.has(e.id)), campaign: touched });
    await persist(campaign.id, 'the log', async () => {
      await storage.deleteLog(ids);
      await saveCampaign(touched);
    });
  },

  async setCombat(state) {
    const campaign = requireCampaign(get().campaign);
    const touched = touch(campaign);
    set({ combat: state, campaign: touched });
    await persist(campaign.id, 'the combat tracker', async () => {
      await storage.putCombat(campaign.id, state);
      await saveCampaign(touched);
    });
  },

  async updateCombat(fn) {
    const { campaign: loaded, combat } = get();
    const campaign = requireCampaign(loaded);
    if (!combat) throw new Error('There is no combat running.');
    const next = fn(combat);
    // Ending a fight is setCombat(null): a functional update can never delete the row by accident.
    if (!next) throw new Error('updateCombat must return a combat state; end a fight with setCombat(null).');
    if (next === combat) return combat;
    const touched = touch(campaign);
    set({ combat: next, campaign: touched });
    await persist(campaign.id, 'the combat tracker', async () => {
      await storage.putCombat(campaign.id, next);
      await saveCampaign(touched);
    });
    return next;
  },

  async commitHeroMove(req) {
    const s = get();
    const plan = planHeroMoveCommit(s, req);
    if (!plan.ok) return plan;
    if (!plan.changed) return { ok: true, outcome: plan.outcome };
    const campaign = requireCampaign(s.campaign);
    const now = Date.now();
    const character = plan.character && s.character ? sheetWrite(plan.character, s.character, campaign, now) : null;
    const touched = touch(campaign, now);
    set({ combat: plan.outcome.state, ...(character && { character }), campaign: touched, heroMoveUndo: plan.heroMoveUndo });
    await persistHeroMove(touched, plan.outcome.state, character);
    return { ok: true, outcome: plan.outcome };
  },

  async undoHeroMove() {
    const s = get();
    const undo = planHeroMoveUndo(s);
    if (!undo) return false;
    const campaign = requireCampaign(s.campaign);
    const now = Date.now();
    const character = undo.character && s.character ? sheetWrite(undo.character, s.character, campaign, now) : null;
    const touched = touch(campaign, now);
    set({ combat: undo.combat, ...(character && { character }), campaign: touched, heroMoveUndo: undo.heroMoveUndo });
    await persistHeroMove(touched, undo.combat, character);
    return true;
  },

  async upsertJournal(entries) {
    const s = get();
    const campaign = requireCampaign(s.campaign);
    if (entries.length === 0) return [];
    const now = Date.now();
    const ctx = { campaignId: campaign.id, sessionNumber: s.activeSession?.number ?? campaign.sessionCount, now };
    const journal = s.journal.slice();
    const order: string[] = [];
    // Latest version of each entry (one named twice in a call is merged twice and saved once).
    const latest = new Map<string, JournalEntry>();
    for (const upsert of entries) {
      const entry = upsertJournalEntry(journal, upsert, ctx);
      order.push(entry.id);
      latest.set(entry.id, entry);
    }
    const touched = touch(campaign, now);
    set({ journal, campaign: touched });
    await persist(campaign.id, 'the journal', async () => {
      await storage.putJournal([...latest.values()]);
      await saveCampaign(touched);
    });
    return order.flatMap((id) => latest.get(id) ?? []);
  },

  async deleteJournal(id) {
    const s = get();
    const campaign = requireCampaign(s.campaign);
    const touched = touch(campaign);
    set({ journal: s.journal.filter((j) => j.id !== id), campaign: touched });
    await persist(campaign.id, 'the journal', async () => {
      await storage.deleteJournalEntry(id);
      await saveCampaign(touched);
    });
  },

  async upsertQuest(quest) {
    const s = get();
    const campaign = requireCampaign(s.campaign);
    const title = quest.title.trim();
    if (!title) throw new Error('Quests need a title.');
    const now = Date.now();
    const index = findMatch(s.quests, quest.id, (q) => matchKey(q.title), matchKey(title));
    const existing = index >= 0 ? s.quests[index] : undefined;
    const { id, objectives, createdAt: _created, updatedAt: _updated, ...fields } = quest;
    const nextObjectives = objectives && withObjectiveIds(objectives, existing?.objectives ?? []);
    const next: Quest = existing
      ? {
          ...existing,
          ...definedOnly(fields),
          campaignId: existing.campaignId,
          title: id === existing.id ? title : existing.title,
          ...(nextObjectives && { objectives: nextObjectives }),
          updatedAt: nextUpdatedAt(existing.updatedAt, now),
        }
      : {
          status: 'active',
          summary: '',
          ...definedOnly(fields),
          id: id ?? newId(),
          campaignId: campaign.id,
          title,
          objectives: nextObjectives ?? [],
          createdAt: now,
          updatedAt: now,
        };
    const quests = existing ? replaceById(s.quests, next) : [...s.quests, next];
    const touched = touch(campaign, now);
    set({ quests, campaign: touched });
    await persist(campaign.id, 'the quest', async () => {
      await storage.putQuest(next);
      await saveCampaign(touched);
    });
    return next;
  },

  async deleteQuest(id) {
    const s = get();
    const campaign = requireCampaign(s.campaign);
    const touched = touch(campaign);
    set({ quests: s.quests.filter((q) => q.id !== id), campaign: touched });
    await persist(campaign.id, 'the quest', async () => {
      await storage.deleteQuestRecord(id);
      await saveCampaign(touched);
    });
  },

  async upsertClock(clock) {
    const s = get();
    const campaign = requireCampaign(s.campaign);
    const name = clock.name.trim();
    if (!name) throw new Error('Clocks need a name.');
    const now = Date.now();
    const index = findMatch(s.clocks, clock.id, (c) => matchKey(c.name), matchKey(name));
    const existing = index >= 0 ? s.clocks[index] : undefined;
    const { id, createdAt: _created, updatedAt: _updated, ...fields } = clock;
    const merged: Clock = existing
      ? {
          ...existing,
          ...definedOnly(fields),
          campaignId: existing.campaignId,
          name: keptName(existing, id, name),
          updatedAt: nextUpdatedAt(existing.updatedAt, now),
        }
      : {
          segments: DEFAULT_CLOCK_SEGMENTS,
          filled: 0,
          kind: 'threat',
          secret: false,
          resolved: false,
          ...definedOnly(fields),
          id: id ?? newId(),
          campaignId: campaign.id,
          name,
          createdAt: now,
          updatedAt: now,
        };
    const next = clampClock(merged, existing?.segments ?? DEFAULT_CLOCK_SEGMENTS);
    const clocks = existing ? replaceById(s.clocks, next) : [...s.clocks, next];
    const touched = touch(campaign, now);
    set({ clocks, campaign: touched });
    await persist(campaign.id, 'the clock', async () => {
      await storage.putClock(next);
      await saveCampaign(touched);
    });
    return next;
  },

  async deleteClock(id) {
    const s = get();
    const campaign = requireCampaign(s.campaign);
    const touched = touch(campaign);
    set({ clocks: s.clocks.filter((c) => c.id !== id), campaign: touched });
    await persist(campaign.id, 'the clock', async () => {
      await storage.deleteClockRecord(id);
      await saveCampaign(touched);
    });
  },

  async saveHomebrew(entry) {
    const s = get();
    const now = Date.now();
    const saved: HomebrewEntry = { ...entry, createdAt: entry.createdAt || now, updatedAt: now };
    const visible = saved.campaignId === null || saved.campaignId === s.campaignId;
    const others = s.homebrew.filter((h) => h.id !== saved.id);
    const homebrew = visible ? [...others, saved].sort(byName) : others;
    const touched = s.campaign && saved.campaignId === s.campaign.id ? touch(s.campaign, now) : null;
    set(touched ? { homebrew, campaign: touched } : { homebrew });
    await persist(s.campaignId ?? LIBRARY_QUEUE, 'the homebrew', async () => {
      await storage.putHomebrew(saved);
      if (touched) await saveCampaign(touched);
    });
    return saved;
  },

  async deleteHomebrew(id) {
    const s = get();
    const existing = s.homebrew.find((h) => h.id === id);
    const touched = s.campaign && existing?.campaignId === s.campaign.id ? touch(s.campaign) : null;
    const homebrew = s.homebrew.filter((h) => h.id !== id);
    set(touched ? { homebrew, campaign: touched } : { homebrew });
    await persist(s.campaignId ?? LIBRARY_QUEUE, 'the homebrew', async () => {
      await storage.deleteHomebrewRecord(id);
      if (touched) await saveCampaign(touched);
    });
  },

  async addUsage(delta) {
    const s = get();
    const campaign = requireCampaign(s.campaign);
    const next: Campaign = { ...touch(campaign), usage: sumUsage(campaign.usage, delta) };
    const session = s.activeSession && { ...s.activeSession, usage: sumUsage(s.activeSession.usage, delta) };
    set({ campaign: next, ...(session && { activeSession: session, sessions: replaceById(s.sessions, session) }) });
    await persist(campaign.id, 'usage totals', async () => {
      if (session) await storage.putSession(session);
      await saveCampaign(next);
    });
  },

  setDmStatus(patch) {
    const dm = { ...get().dm, ...patch };
    // A DM run has started: this turn's hero moves are on their way to the DM (D49), so they can't be undone.
    const sent = isBusyDmPhase(dm.phase) && get().heroMoveUndo.length > 0;
    set(sent ? { dm, heroMoveUndo: [] } : { dm });
  },

  requestInteraction(request) {
    return new Promise<InteractionResponse>((resolve, reject) => {
      // Re-using an id supersedes the earlier request.
      pendingInteractions.get(request.id)?.reject(new Error('cancelled'));
      pendingInteractions.delete(request.id);
      pendingInteractions.set(request.id, { request, resolve, reject });
      set({ interaction: firstPendingInteraction() });
    });
  },

  resolveInteraction(id, response) {
    const pending = pendingInteractions.get(id);
    if (!pending) return;
    pendingInteractions.delete(id);
    set({ interaction: firstPendingInteraction() });
    pending.resolve(response);
  },

  cancelInteraction(id, reason) {
    const pending = pendingInteractions.get(id);
    if (!pending) return;
    pendingInteractions.delete(id);
    set({ interaction: firstPendingInteraction() });
    pending.reject(new Error('cancelled', reason === undefined ? undefined : { cause: reason }));
  },

  queueDmNotice(text) {
    // A failed save is logged; the notice stays in memory and is saved with the next write.
    void queueLoadedNotice(text).catch(noop);
  },

  takeDmNotices() {
    const s = get();
    const notices = s.pendingDmNotices;
    if (notices.length === 0) return notices;
    // Memory only: the campaign's next save (normally the transcript append that delivers these)
    // clears the stored copy, so a failed append can't lose them.
    set({ pendingDmNotices: [], ...(s.campaign && { campaign: { ...s.campaign, pendingDmNotices: [] } }) });
    return notices;
  },
}));

// A campaign replaced by an import / GitHub pull, or deleted from the save slots (in this tab or
// another), must not keep being written from a stale in-memory copy.
onCampaignChange((change) => {
  replacements.set(change.campaignId, replacementOf(change.campaignId) + 1);
  if (change.type === 'deleted') storedNotices.delete(change.campaignId);
  const state = useGame.getState();
  if (change.campaignId !== state.campaignId) return;
  if (change.type === 'deleted') {
    state.unloadCampaign();
    // Keep the id, so a table still showing it explains what happened instead of loading forever.
    useGame.setState({ campaignId: change.campaignId, loadError: CAMPAIGN_DELETED });
  } else {
    void state.reload();
  }
});

/**
 * Queue a DM notice for any campaign: delivered through the loaded store when that campaign is open
 * at the table, otherwise persisted on the campaign record for its next turn.
 * Resolves once the notice is saved (a campaign that doesn't exist is ignored).
 */
export async function queueCampaignNotice(campaignId: string, text: string): Promise<void> {
  const notice = text.trim();
  if (!notice) return;
  if (useGame.getState().campaign?.id === campaignId) {
    await queueLoadedNotice(notice);
    return;
  }
  // Not loaded in this tab: add it to the stored record. A tab that has it open at the table picks
  // it up with its next save.
  await saveNotice(campaignId, notice);
}
