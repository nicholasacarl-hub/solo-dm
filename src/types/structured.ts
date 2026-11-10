/**
 * Structured imports: per-kind data read from the player's imported books, its review state,
 * extraction jobs, and provenance for book text copied onto a character. CONTRACT (Day 0).
 * Every `message` / `note` string is written by the app; `modelNote` is Claude's own words; none is book text.
 */
import type { Ability, AbilityScores, CasterType, CreatureSize, HitDie, Skill } from './character';
import type { ContentKind, EquipmentOption, EquipmentPackage, FeatCategory } from './content';
import type { UsageTotals } from './game';
import type { CreatureSpeeds } from './map';
import type { ModelId } from './settings';

export const STRUCTURED_SCHEMA_VERSION = 1;
/**
 * Bump when offline parsing or detection rules change: the book page offers "re-check N entries for
 * free", which looks through the book again (detect.ts settles what an older version misread).
 * History: 1 = the first reader; 2 = a bare "Prerequisite:" line doesn't make a feat when the entry shows
 * it is something else (a stronghold room's type line, labelled lines, a class-level prerequisite).
 */
export const PARSER_VERSION = 2;
/** Bump with any change to a system prompt or wire schema. */
export const EXTRACT_PROMPT_VERSION = 1;

/** What the app structures. A subset of ContentKind, so the DM tool schemas keep their kind enums. */
export type StructuredKind = Extract<
  ContentKind,
  'class' | 'subclass' | 'species' | 'background' | 'feat' | 'spell' | 'magic-item' | 'item' | 'monster'
>;
/** Queue and review order: character options first (they unlock the builder), then the long lists. */
export const STRUCTURED_KINDS: readonly StructuredKind[] = [
  'class', 'subclass', 'species', 'background', 'feat', 'spell', 'magic-item', 'item', 'monster',
];
/** Kinds whose records become builder options. */
export const OPTION_KINDS: readonly StructuredKind[] = ['class', 'subclass', 'species', 'background', 'feat'];

export type SourceFormat = '2024' | '2014' | 'other';

/**
 * Paragraphs `from`..`to` (1-based, inclusive) of one block. A block is the texts of `entryIds`
 * (one entry, or a chain of "Name (part N)" entries) joined by "\n\n", numbered by splitParagraphs().
 */
export interface TextSpan { entryIds: string[]; from: number; to: number }

// ---- Per-kind data (the stored, edited, accepted form) --------------------------------------

export interface MonsterData {
  format: SourceFormat;
  size: CreatureSize;                 // the first size when several are allowed
  sizes?: CreatureSize[];             // "Medium or Small" → ['Medium', 'Small']
  type: string;                       // "Dragon", "Humanoid"
  tags?: string[];                    // ["Goblinoid"]
  alignment?: string;
  ac: number;                         // 1–40 (combatantSpec limit, definitions.ts:198)
  acNote?: string;                    // "natural armor"
  hp: number;                         // 1–2000, the printed average
  hitDice?: string;                   // "8d10 + 8"
  speed: string;                      // app-written display: "30 ft., fly 60 ft. (hover)"
  speeds: CreatureSpeeds;             // what statBlockMapStats reads
  initiative: number;                 // modifier, −10..20
  reachFt: number;                    // longest melee reach, 5–60 (5 when no attack states one)
  cr: string;                         // "1/4"
  crValue: number;                    // 0.25
  xp?: number;
  pb?: number;
  abilities: AbilityScores;           // 1–30
  senses?: string;
  passivePerception?: number;
  languages?: string;
  resistances?: string;
  immunities?: string;
  vulnerabilities?: string;
  legendary: boolean;
}

export type SpellSchool = 'Abjuration' | 'Conjuration' | 'Divination' | 'Enchantment' | 'Evocation'
  | 'Illusion' | 'Necromancy' | 'Transmutation';
export type SpellAreaShape = 'sphere' | 'cylinder' | 'cone' | 'line' | 'cube' | 'emanation';
/** sizeFt: radius (sphere, cylinder, emanation), length (cone, line) or side (cube). Explicit, unlike the SRD's `size`. */
export interface SpellArea { shape: SpellAreaShape; sizeFt: number; widthFt?: number; heightFt?: number }
export interface SpellData {
  format: SourceFormat;
  level: number;                      // 0 = cantrip … 9
  school: SpellSchool;
  classes: string[];                  // class display names as printed: ["Sorcerer", "Wizard", "Wickwright"]
  ritual: boolean;
  concentration: boolean;
  castingTime: string;                // "Action", "1 minute" (without "or Ritual")
  range: string;                      // "150 feet", "Self", "Touch", "Self (15-foot cone)"
  components?: string;
  duration: string;
  area?: SpellArea;
  saveAbility?: Ability;
  attack?: 'melee' | 'ranged';
  damage?: string;                    // "3d8"
  damageTypes?: string[];             // ["fire"]
  damageByCharacterLevel?: Record<string, string>;  // {"5": "2d10", "11": "3d10", "17": "4d10"}
}

export type MagicItemCategory = 'armor' | 'shield' | 'weapon' | 'ammunition' | 'potion' | 'ring' | 'rod'
  | 'scroll' | 'staff' | 'wand' | 'wondrous-item' | 'other';
export type Rarity = 'common' | 'uncommon' | 'rare' | 'very rare' | 'legendary' | 'artifact' | 'varies';
/** Flat bonuses that always apply while worn or wielded (and attuned, when attunement is required). */
export interface ItemBonuses {
  ac?: number;                        // 1–5
  savingThrows?: number;              // 1–5
  attack?: number;                    // shown on the item, not applied to attacks (deferred)
  damage?: number;                    // shown on the item, not applied (deferred)
  acOnlyWhen?: 'no-armor' | 'no-armor-no-shield';
}
export interface MagicItemData {
  format: SourceFormat;
  category: MagicItemCategory;
  rarity: Rarity;
  rarityText?: string;                // only when rarity is 'varies'
  attunement: boolean | string;       // SRD convention: true, false, or the requirement ("by a Wizard")
  baseItem?: string;                  // "Chain Mail", "Any Medium or Heavy Armor"
  bonuses?: ItemBonuses;
  charges?: number;
}

/** One row of a weapon / armor / gear table, or one gear entry: the builder's EquipmentOption fields. */
export type ItemData = Omit<EquipmentOption, 'id' | 'name' | 'source' | 'magic'> & { format: SourceFormat };

export interface FeatData {
  format: SourceFormat;
  category: FeatCategory;             // 2014 feats without one: 'general' (adaptation feat-general)
  prerequisite?: string;              // as printed, without its label
  minLevel?: number;                  // from "Level N+": the only prerequisite part the app checks
  repeatable: boolean;
  abilityIncrease?: { abilities: Ability[]; amount: 1 | 2 };
  text: TextSpan;                     // the feat's text below its category line
}

export interface TraitData { name: string; text: TextSpan }
export interface LineageData {
  name: string;
  text: TextSpan;
  /** 'table-row': the span is one table row; merge builds the SRD-style "…. Level 3: X. Level 5: Y." text from its cells. */
  form: 'paragraphs' | 'table-row';
}
export interface SpeciesData {
  format: SourceFormat;
  creatureType: string;               // "Humanoid" when not printed (2014)
  sizes: CreatureSize[];
  speed: number;
  darkvision?: number;
  traits: TraitData[];
  lineageTrait?: string;              // the trait (one of `traits`) that offers the lineages
  lineages?: LineageData[];
  /** 2014 species: the printed increases, shown and never applied (adaptation species-asi-not-applied). */
  legacyAbilityIncreases?: { ability: Ability | 'any'; amount: number }[];
  /** Printed languages: suggested for the two 2024 language picks, never added. */
  languages?: string[];
}

export interface BackgroundData {
  format: SourceFormat;
  abilityScores: Ability[];           // 3 in 2024 books; [] = the player picks any three (background-any-three)
  feat: string;                       // Origin feat by name; '' = the player picks one (background-feat-choice)
  skills: Skill[];
  tool: string;                       // '' when none
  equipment: EquipmentPackage[];      // a 2014 single list becomes one package "Option A"
  languages?: string[];               // printed; suggested for the two 2024 picks
  legacyFeature?: TraitData;          // 2014 feature → a source 'background' feature
}

export interface FeatureData { level: number; name: string; text: TextSpan }
export interface ClassData {
  format: SourceFormat;
  hitDie: HitDie;
  primaryAbilities: Ability[];
  primaryAbilityRule: 'all' | 'any';  // "Strength or Dexterity" = any (replaces the Fighter name check)
  savingThrows: Ability[];            // exactly 2
  skillChoices: { count: number; from: Skill[] };   // from [] = any skill
  weaponProficiencies: string[];      // builder phrasings: "Simple weapons", "Martial weapons", or the phrase
  armorTraining: string[];            // "Light armor" … "Shields"
  tools: string[];
  casterType: CasterType;
  spellcastingAbility?: Ability;
  spellListName?: string;             // another class's list it uses ("Wizard"); absent = its own name
  spellNames?: string[];              // spell names its own list prints (SRD spells included)
  weaponMasteryCount: number;
  startingEquipment: EquipmentPackage[];
  subclassLevel: number;              // 1–3
  features: FeatureData[];            // without "Subclass feature" placeholders
  levelTable: Array<Record<string, string | number>>;   // exactly 20 rows; builder.json keys (§3.4)
}

export interface SubclassData {
  format: SourceFormat;
  parentClass: string;                // as printed; resolved in review into StructuredRecord.parentClassId
  summary: string;                    // its tagline (≤ 200 chars)
  features: FeatureData[];
  casterType?: 'third';               // a subclass that grants Spellcasting
  spellcastingAbility?: Ability;
  alwaysPreparedSpells?: { level: number; spells: string[] }[];
}

export interface StructuredDataByKind {
  monster: MonsterData; spell: SpellData; 'magic-item': MagicItemData; item: ItemData; feat: FeatData;
  species: SpeciesData; background: BackgroundData; class: ClassData; subclass: SubclassData;
}

// ---- Review state ---------------------------------------------------------------------------

export type RecordStatus = 'pending' | 'accepted' | 'rejected';
export type RecordConfidence = 'high' | 'medium' | 'low';
export type RecordOrigin = 'parser' | 'claude' | 'pack' | 'manual';
/** entry: one chunk (or a part chain); section: a heading subtree; table: an unread gear table; row: one table row. */
export type RecordSpan = 'entry' | 'section' | 'table' | 'row';

export type WarningCode =
  | 'ungrounded'        // an excerpt isn't in the source text
  | 'cross-check'       // XP vs CR, HP vs dice, PB column, cantrip level, concentration vs duration…
  | 'missing'           // a required field had no value
  | 'default-used'      // the app filled a default the rules dictate (initiative = DEX modifier…)
  | 'out-of-range'      // outside what the engine or DM tools accept (always 'block')
  | 'unresolved-text'   // a span doesn't resolve, or doesn't start at the named feature
  | 'unresolved-ref'    // a subclass's parent or a background's feat isn't available
  | 'name-collision'    // same kind and name as an SRD entry or another import
  | 'engine-name'       // a name the engine treats specially (Alert, Tough, Defense, Champion…)
  | 'spell-list'        // classes taken from the book's "<Class> Spells" list
  | 'needs-claude'      // the offline parser couldn't read it and Claude wasn't used
  | 'refused'           // stop_reason "refusal", with its category
  | 'failed'            // the request failed (truncated, invalid output, bad request…)
  | 'not-this-kind'     // Claude said matchesKind: false ('block'), or an improved offline reader no longer finds this kind ('warn')
  | 'stale-text'        // the source text changed since extraction
  | 'model-note'        // Claude's `notes`
  | 'newer-version';    // written by a newer app version: read-only
export interface RecordWarning { code: WarningCode; severity: 'info' | 'warn' | 'block'; field?: string; message: string }

export type AdaptationCode =
  | 'species-asi-not-applied' | 'species-languages-suggested'
  | 'background-any-three' | 'background-feat-choice' | 'background-feature-kept' | 'background-languages-suggested'
  | 'feat-general' | 'fighting-style-inline'
  | 'subclass-early-features' | 'subclass-overlap' | 'subclass-at-level-1'
  | 'prepared-2024-column' | 'half-caster-slots-2024' | 'monster-2014-statblock';
export interface Adaptation { code: AdaptationCode; note: string }

/** A grounded excerpt, for highlighting in review: the wire field it filled and the words. */
export interface Excerpt { field: string; text: string; grounded: boolean }

export type RunState = 'queued' | 'running' | 'done' | 'failed' | 'refused' | 'skipped';
export type RunErrorCode = 'refused' | 'truncated' | 'invalid-output' | 'too-long' | 'bad-request'
  | 'overloaded' | 'network' | 'interrupted' | 'other';

export interface RecordProposal<K extends StructuredKind = StructuredKind> {
  data: StructuredDataByKind[K]; warnings: RecordWarning[]; adaptations: Adaptation[]; excerpts: Excerpt[];
  origin: RecordOrigin; createdAt: number;
}

export interface StructuredRecord<K extends StructuredKind = StructuredKind> {
  id: string;                         // "rec:<sourceId>:<kind>:<slug>[-n]", assigned once
  sourceId: string;
  kind: K;
  name: string;
  schemaVersion: number;              // STRUCTURED_SCHEMA_VERSION when written
  publicId: string;                   // materialized entry id = builder option id (§2.6), assigned once
  entryIds: string[];                 // entries read, in reading order; [0] is the primary entry
  span: RecordSpan;
  rowIndex?: number;                  // span 'row': 0-based body row
  tableRecordId?: string;             // span 'row': the table record it was read from
  candidateKey: string;               // re-run matching key (§3.1)
  status: RecordStatus;
  confidence: RecordConfidence;
  origin: RecordOrigin;
  data: StructuredDataByKind[K] | null;   // null: not read yet (needs Claude or manual entry)
  warnings: RecordWarning[];
  adaptations: Adaptation[];
  excerpts: Excerpt[];
  modelNote?: string;                 // ≤ 300 chars
  parentClassId?: string;             // subclass: the class option it attaches to (required to accept)
  edited: boolean;                    // the player changed a field: re-runs write `proposal`
  proposal?: RecordProposal<K>;
  textHash: string;                   // textFingerprint() of the joined source texts when read
  parserVersion?: number;
  /** The player chose this entry and kind (All entries › Structure as…, What it is): a later reader never removes it. */
  marked?: true;
  /** A fingerprint of the offline reading the record was last read with: a later look offers a reading only when it changed. */
  readingHash?: string;
  extraction?: {
    model: string;                    // message.model (may be a fallback model)
    requestedModel: string;
    promptVersion: number;
    at: number;
    usage: UsageTotals;               // usageDelta(), dm/cost.ts:127-142
    refusal?: string;                 // stop_details.category
  };
  // Run state of the latest job that touched this record (flat, so Dexie can index [jobId+runState]).
  jobId?: string;
  runState?: RunState;
  runAttempts?: number;
  runMaxTokens?: number;              // raised once after a max_tokens stop
  runError?: { code: RunErrorCode; message: string; retryable: boolean };
  reviewedAt?: number;
  /** From a "Download book data" file: accepted on the device that made it (offered, never applied, on import). */
  reviewedElsewhere?: true;
  createdAt: number;
  updatedAt: number;
}

// ---- Jobs -----------------------------------------------------------------------------------

export type JobStatus = 'queued' | 'running' | 'pausing' | 'paused' | 'done' | 'cancelled';
export type PauseReason = 'player' | 'reload' | 'budget' | 'offline' | 'rate-limit' | 'auth' | 'model'
  | 'format' | 'storage' | 'other-tab';

export interface CostEstimate {
  model: ModelId;
  requests: number;
  inputTokens: number;                // uncached
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;               // JSON + low-effort thinking
  usd: number; usdLow: number; usdHigh: number;
  minutesLow: number; minutesHigh: number;
  byKind: Partial<Record<StructuredKind, { requests: number; usd: number }>>;
}

export interface ExtractionJob {
  id: string;
  sourceId: string;
  status: JobStatus;
  pauseReason?: PauseReason;
  pauseMessage?: string;              // app-written; for auth/model/format, describeError's text
  model: ModelId;
  useFallbacks: boolean;              // settings.useFallbacks at creation
  concurrency: 1 | 2 | 3 | 4;
  budgetUsd: number | null;           // null = no limit
  scope: { kinds: StructuredKind[]; claudeFor: 'misses' | 'all' | 'selection'; recordIds?: string[] };
  estimate: CostEstimate;
  usage: UsageTotals;
  counts: Record<RunState, number>;
  interrupted: number;                // requests cut off by Cancel or a reload; their cost is unknown
  createdAt: number; updatedAt: number; startedAt?: number; finishedAt?: number;
}

// ---- Provenance ---------------------------------------------------------------------------

/** Where something on a character came from. Present only for content from an imported book. */
export interface ImportedRef {
  sourceId: string;                   // the copying device's source id
  sourceTitle: string;                // the book's title when copied (kept in saves, as titles are today)
  bookFingerprint?: string;           // LibrarySource.fingerprint: finds the same book on another device
  entryId: string;                    // option / entry id when copied ("lib:…")
  kind: StructuredKind;
  entryName: string;                  // "Ember Warden"
  part?: string;                      // feature, trait, lineage or background-feature name; absent = whole option
  level?: number;                     // class or subclass feature level
  /** Where the copied text sits: the block's entry ordinals (n of "lib:<sourceId>:<n>") and paragraphs. */
  at?: { ordinals: number[]; from: number; to: number };
  textHash: string;                   // textFingerprint() of the copied text; '' when nothing was copied
  /** The description holds book text, or the DM's words about this entry: exports leave it out. */
  textCopied: boolean;
  redacted?: true;                    // set in exported copies
}

/** Where a builder option came from. Absent on SRD options. */
export interface OptionSource {
  sourceId: string;
  title: string;
  recordId: string;
  format: SourceFormat;
  adaptations: Adaptation[];          // app-written notes (§5.6)
}
