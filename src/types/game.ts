/**
 * Dice, combat, campaign, session, journal and log types.
 */
import type {
  Ability,
  ActiveCondition,
  HitDiceEntry,
  HitPoints,
  Skill,
} from './character';

// ---------------------------------------------------------------------------
// Dice
// ---------------------------------------------------------------------------

export type AdvantageState = 'normal' | 'advantage' | 'disadvantage';

export interface DieRoll {
  sides: number;
  value: number;
  /** True when the die was dropped (keep-highest/lowest, advantage). */
  dropped?: boolean;
}

export interface RollResult {
  /** Normalized expression, e.g. "1d20+5" or "2d20kh1+5". */
  expression: string;
  total: number;
  /** Every die rolled, including dropped ones, in roll order. */
  dice: DieRoll[];
  /** Sum of flat modifiers. */
  modifier: number;
  /** Human-readable breakdown, e.g. "d20 (17, 4) + 5 = 22". */
  breakdown: string;
  /** For d20 tests: the kept d20 face. */
  natural?: number;
  /** Natural 20 on a d20 test. */
  isCritical?: boolean;
  /** Natural 1 on a d20 test. */
  isFumble?: boolean;
  advantage?: AdvantageState;
}

/** A d20 test (ability check, saving throw, attack roll). */
export interface D20TestResult extends RollResult {
  dc?: number;
  /** Present when a DC (or target AC) was given. */
  success?: boolean;
}

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

export type CombatSide = 'player' | 'ally' | 'enemy' | 'neutral';

export interface Combatant {
  id: string;
  name: string;
  side: CombatSide;
  /** True for the player character (whose HP lives on the Character, not here). */
  isPlayer: boolean;
  initiative: number;
  initiativeBonus: number;
  ac?: number;
  /** Undefined for the player character. */
  hp?: HitPoints;
  conditions: ActiveCondition[];
  /** Compendium / homebrew id of the stat block, if any. */
  statBlockId?: string;
  /** e.g. "Goblin Warrior". */
  statBlockName?: string;
  notes?: string;
  defeated: boolean;
  /** Hide exact HP from the player (show a health descriptor instead). */
  hideHp?: boolean;
}

export interface CombatState {
  active: boolean;
  round: number;
  /** Index into `combatants` of the creature whose turn it is. */
  turnIndex: number;
  /** Sorted by initiative, highest first. */
  combatants: Combatant[];
  encounterName?: string;
  startedAt: number;
}

// ---------------------------------------------------------------------------
// Campaign & session
// ---------------------------------------------------------------------------

export type RulesFidelity = 'strict' | 'balanced' | 'narrative';
export type HomebrewFreedom = 'none' | 'light' | 'moderate' | 'wild';
export type Difficulty = 'story' | 'standard' | 'hard' | 'brutal';
export type NarrationLength = 'brief' | 'standard' | 'rich';
/** auto = the app rolls instantly; prompt = player taps to roll; physical = player types the result of real dice. */
export type PlayerRollMode = 'auto' | 'prompt' | 'physical';
/**
 * off = the hero stays as built; offered = the DM may offer transformations, the player always chooses;
 * consequences = the player's knowing choices can transform the hero (always with a story path back).
 */
export type TransformationsMode = 'off' | 'offered' | 'consequences';

export interface CampaignSettings {
  /** e.g. "Heroic high fantasy", "Grim and gritty", "Lighthearted". */
  tone: string;
  /** World pitch / setting notes from the player. */
  setting: string;
  rulesFidelity: RulesFidelity;
  homebrewFreedom: HomebrewFreedom;
  difficulty: Difficulty;
  narrationLength: NarrationLength;
  playerRollMode: PlayerRollMode;
  /** Reveal the DM's secret rolls in the log. */
  showDmRolls: boolean;
  /** Milestone leveling (true) or XP (false). */
  milestoneLeveling: boolean;
  /**
   * Extra library source ids for this campaign. The DM always consults the SRD plus every source
   * switched on in the Library; kept for older saves and future per-campaign sourcing.
   */
  enabledSources: string[];
  /** Safety tools: hard limits that never appear. */
  lines: string[];
  /** Safety tools: topics that happen off-screen / fade to black. */
  veils: string[];
  /** Anything else the player wants the DM to know. */
  playerNotes?: string;
  /** Lasting changes to the hero (vampirism, blessings, curses...). Missing = 'offered'. */
  transformations?: TransformationsMode;
  /** Visual style for illustrations, e.g. "painterly fantasy, muted palette, dramatic light". */
  artStyle?: string;
}

export interface Scene {
  location: string;
  region?: string;
  timeOfDay?: string;
  inWorldDate?: string;
  weather?: string;
  mood?: string;
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Estimated from published per-token prices; not a bill. */
  estimatedCostUsd: number;
}

export interface Campaign {
  id: string;
  name: string;
  /** The player's pitch, or a DM-generated hook. */
  premise: string;
  characterId: string | null;
  settings: CampaignSettings;
  status: 'setup' | 'active' | 'archived';
  scene: Scene;
  /** Number of sessions started so far. */
  sessionCount: number;
  activeSessionId: string | null;
  coverEmoji?: string;
  /** Accent color for the save-slot card (CSS color). */
  coverColor?: string;
  /**
   * Solo-play tension dial, 1 (calm) to 9 (chaos). At the start of each new scene the app rolls a
   * d10: at or under the tension the scene is altered (odd roll) or interrupted (even roll).
   * The DM nudges it up when things slip out of the hero's control and down when they take charge.
   */
  tension: number;
  /**
   * Notes for the DM about player-side changes (sheet edits, vetoes, library edits) not yet
   * delivered; persisted so a reload or leaving the table doesn't lose them.
   */
  pendingDmNotices?: string[];
  usage: UsageTotals;
  createdAt: number;
  updatedAt: number;
  lastPlayedAt: number | null;
}

export interface Session {
  id: string;
  campaignId: string;
  /** 1-based session number. */
  number: number;
  status: 'active' | 'ended';
  model: string;
  /**
   * The system prompt is frozen for the whole session: the harness is append-only so
   * prompt caching and preserved thinking stay valid. State changes arrive via tool
   * results, per-turn status blocks, and appended role:"system" messages.
   */
  systemPrompt: string;
  startedAt: number;
  endedAt: number | null;
  /** Player-facing recap written by the DM when the session ends. */
  recap: string | null;
  /** DM-only notes (plans, secrets) carried into the next session. */
  dmNotes: string | null;
  usage: UsageTotals;
  /** Input tokens of the most recent request (≈ current context size). */
  contextTokens: number;
  /**
   * Results of tools that already ran in the current, unfinished tool batch (persisted as each tool
   * finishes, cleared once the batch's tool_result message is appended). After a reload these are
   * returned as the real results instead of "interrupted", so finished effects aren't applied twice.
   */
  pendingToolResults?: PendingToolResult[] | null;
}

export interface PendingToolResult {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Journal & quests (the DM's long-term memory)
// ---------------------------------------------------------------------------

/** 'ruling' records a rules call the DM made, so later calls stay consistent (house rules). */
export type JournalKind = 'npc' | 'location' | 'faction' | 'item' | 'lore' | 'event' | 'ruling' | 'note';

export interface JournalEntry {
  id: string;
  campaignId: string;
  kind: JournalKind;
  name: string;
  /** One or two sentences. */
  summary: string;
  /** Longer markdown notes. */
  details?: string;
  /** e.g. "ally", "hostile", "deceased", "explored". */
  status?: string;
  tags: string[];
  /** DM-only (hidden from the player unless they reveal spoilers). */
  secret: boolean;
  firstSession: number;
  lastSession: number;
  createdAt: number;
  updatedAt: number;
}

export type QuestStatus = 'rumor' | 'active' | 'completed' | 'failed' | 'abandoned';

export interface QuestObjective {
  id: string;
  text: string;
  done: boolean;
}

export interface Quest {
  id: string;
  campaignId: string;
  title: string;
  status: QuestStatus;
  summary: string;
  giver?: string;
  reward?: string;
  objectives: QuestObjective[];
  /**
   * A goal the player set for themselves (found a guild, take the throne). Not a checklist: progress is
   * tracked on a progress clock and only advances for what the hero actually earns.
   */
  ambition?: boolean;
  /** DM-only notes. */
  secretNotes?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * A progress clock (a "front" or countdown): a threat or project that advances, often off-screen.
 * When filled, its consequence happens.
 */
export interface Clock {
  id: string;
  campaignId: string;
  name: string;
  /** What happens when the clock fills. */
  consequence?: string;
  segments: number;
  filled: number;
  kind: 'threat' | 'progress' | 'countdown';
  /** DM-only (hidden from the player unless they reveal spoilers). */
  secret: boolean;
  /** True once the clock has filled and its consequence has landed, or it was abandoned. */
  resolved: boolean;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Display log (what the player sees). The API transcript is stored separately.
// ---------------------------------------------------------------------------

export interface LogEntryBase {
  id: string;
  campaignId: string;
  sessionId: string | null;
  /** Monotonic per campaign. */
  seq: number;
  createdAt: number;
}

export interface PlayerLogEntry extends LogEntryBase {
  kind: 'player';
  text: string;
}

export interface DmLogEntry extends LogEntryBase {
  kind: 'dm';
  /** Markdown narration with any ```choices block removed. */
  text: string;
  /** Suggested actions parsed from a ```choices fenced block. */
  choices?: string[];
  /** Reasoning summary / progress note when thinking display is enabled. */
  reasoning?: string;
  /** True while the text is still streaming. */
  streaming?: boolean;
}

export interface RollLogEntry extends LogEntryBase {
  kind: 'roll';
  actor: 'player' | 'dm';
  /** What kind of roll this was (attack rolls are compared to AC, checks and saves to a DC). */
  rollType?: PlayerRollType;
  /** What the roll was for: "Stealth check", "Goblin 2 attack". */
  purpose: string;
  roll: D20TestResult;
  /** DM secret roll: hidden unless the campaign shows DM rolls. */
  secret: boolean;
  /** True when the player entered the result of physical dice. */
  manual?: boolean;
}

export type ToolActivityIcon =
  | 'transform'
  | 'image'
  | 'hp'
  | 'heal'
  | 'condition'
  | 'item'
  | 'coin'
  | 'xp'
  | 'level'
  | 'spell'
  | 'rest'
  | 'combat'
  | 'journal'
  | 'quest'
  | 'scene'
  | 'rules'
  | 'homebrew'
  | 'oracle'
  | 'info';

export interface ToolLogEntry extends LogEntryBase {
  kind: 'tool';
  tool: string;
  /** Id of the record this line is about (homebrew, quest, journal entry, clock), when there is one. */
  refId?: string;
  icon: ToolActivityIcon;
  /** One-line summary such as "HP 23 → 15 (8 piercing)". */
  summary: string;
  /** Optional markdown detail (expandable). */
  detail?: string;
  /** Spoiler-level detail hidden from the player by default. */
  secret?: boolean;
}

export interface SystemLogEntry extends LogEntryBase {
  kind: 'system';
  text: string;
  level: 'info' | 'warning';
}

export interface SessionLogEntry extends LogEntryBase {
  kind: 'session';
  event: 'start' | 'end';
  sessionNumber: number;
}

export interface RecapLogEntry extends LogEntryBase {
  kind: 'recap';
  sessionNumber: number;
  text: string;
}

export interface ErrorLogEntry extends LogEntryBase {
  kind: 'error';
  text: string;
  retryable: boolean;
}

export type ImageSubject = 'scene' | 'character' | 'npc' | 'creature' | 'item' | 'battle';

/** An illustration in the story log. The image itself is stored separately (StoredImage). */
export interface ImageLogEntry extends LogEntryBase {
  kind: 'image';
  imageId: string;
  title: string;
  subject: ImageSubject;
  status: 'pending' | 'ready' | 'failed';
  /** Friendly reason when status is 'failed'. */
  error?: string;
}

export type LogEntry =
  | PlayerLogEntry
  | DmLogEntry
  | RollLogEntry
  | ToolLogEntry
  | SystemLogEntry
  | SessionLogEntry
  | RecapLogEntry
  | ErrorLogEntry
  | ImageLogEntry;

export type LogEntryKind = LogEntry['kind'];

/** A new log entry before the store assigns id / seq / campaignId / sessionId / createdAt. */
export type NewLogEntry = LogEntry extends infer E
  ? E extends LogEntry
    ? Omit<E, 'id' | 'seq' | 'campaignId' | 'sessionId' | 'createdAt'>
    : never
  : never;

// ---------------------------------------------------------------------------
// Player interactions requested by DM tools (the tool handler awaits the UI)
// ---------------------------------------------------------------------------

export type PlayerRollType =
  | 'ability'
  | 'skill'
  | 'save'
  | 'attack'
  | 'damage'
  | 'initiative'
  | 'death-save'
  | 'hit-die'
  | 'custom';

export interface PlayerRollRequest {
  rollType: PlayerRollType;
  ability?: Ability;
  skill?: Skill;
  /** Name of an Attack on the sheet (for attack / damage rolls). */
  attackName?: string;
  /** Explicit dice for damage / custom rolls, e.g. "2d6+3". */
  expression?: string;
  dc?: number;
  /** Show the DC to the player before rolling. */
  revealDc: boolean;
  advantage: AdvantageState;
  /** Why the roll is happening: "Leap the chasm". */
  reason: string;
  /** For damage rolls after a critical hit: double the dice. */
  critical?: boolean;
}

export interface PlayerRollResponse {
  result: D20TestResult;
  /** True when the player typed in a physical-dice result. */
  manual: boolean;
}

export interface ShortRestResponse {
  /** Hit dice the player chose to spend, with each roll. */
  spent: { die: number; roll: RollResult; healed: number }[];
}

export type InteractionRequest =
  | { kind: 'roll'; id: string; request: PlayerRollRequest; modifier: number; label: string }
  | { kind: 'short-rest'; id: string; hitDice: HitDiceEntry[]; conMod: number; reason?: string }
  | { kind: 'confirm'; id: string; title: string; body: string; confirmLabel?: string; cancelLabel?: string };

export type InteractionResponse =
  | { kind: 'roll'; response: PlayerRollResponse }
  | { kind: 'short-rest'; response: ShortRestResponse }
  | { kind: 'confirm'; confirmed: boolean };

// ---------------------------------------------------------------------------
// Game events emitted by engine functions (for log summaries and warnings)
// ---------------------------------------------------------------------------

export type GameEventType =
  | 'hp-changed'
  | 'temp-hp'
  | 'dropped-to-zero'
  | 'death-save'
  | 'stabilized'
  | 'revived'
  | 'died'
  | 'condition-added'
  | 'condition-removed'
  | 'exhaustion-changed'
  | 'slot-spent'
  | 'slot-restored'
  | 'feature-used'
  | 'feature-restored'
  | 'feature-added'
  | 'feature-removed'
  | 'spell-added'
  | 'spell-removed'
  | 'concentration'
  | 'inspiration'
  | 'item-added'
  | 'item-removed'
  | 'item-updated'
  | 'currency-changed'
  | 'xp-gained'
  | 'level-up'
  | 'rest'
  | 'combat'
  | 'transformation'
  | 'warning';

export interface GameEvent {
  type: GameEventType;
  /** Human-readable, e.g. "Dropped to 0 HP — unconscious. Death saving throws begin." */
  message: string;
}
