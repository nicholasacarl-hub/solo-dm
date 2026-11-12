/**
 * Rules content: the bundled SRD 5.2.1, the player's imported library, and homebrew.
 */
import type { Ability, CasterType, CreatureSize, HitDie, Skill } from './character';
import type { FeatData, ImportedRef, ItemBonuses, OptionSource, Rarity, StructuredKind } from './structured';

export type ContentKind =
  | 'rule'
  | 'spell'
  | 'monster'
  | 'magic-item'
  | 'item'
  | 'class'
  | 'subclass'
  | 'species'
  | 'background'
  | 'feat'
  | 'condition'
  | 'boon'
  | 'other';

export const CONTENT_KINDS: readonly ContentKind[] = [
  'rule',
  'spell',
  'monster',
  'magic-item',
  'item',
  'class',
  'subclass',
  'species',
  'background',
  'feat',
  'condition',
  'boon',
  'other',
];

/** The id of the bundled, openly licensed rules source. */
export const SRD_SOURCE_ID = 'srd-5.2.1';
export const HOMEBREW_SOURCE_ID = 'homebrew';

/** One searchable unit of rules content: a rules section, a spell, a monster, a magic item... */
export interface CompendiumEntry {
  /** Stable id, e.g. "srd:spell:fireball", "lib:<sourceId>:<n>", "hb:<uuid>". */
  id: string;
  /** SRD_SOURCE_ID, a library source id, or HOMEBREW_SOURCE_ID. */
  sourceId: string;
  /** Display name of the source: "SRD 5.2.1", "My PHB notes", "Homebrew". */
  sourceName: string;
  kind: ContentKind;
  name: string;
  /** One line, e.g. "Level 3 Evocation (Sorcerer, Wizard)" or "CR 1/4 Small Humanoid". */
  summary?: string;
  /** Full text as markdown. */
  text: string;
  /** For rules sections: the heading path, e.g. ["Playing the Game", "Combat", "Opportunity Attacks"]. */
  path?: string[];
  /** Optional structured fields (spell level, school, CR...). */
  data?: Record<string, unknown>;
}

/** A source in the player's library (the built-in SRD or something the player imported). */
export interface LibrarySource {
  id: string;
  title: string;
  kind: 'builtin' | 'import';
  format?: 'text' | 'markdown' | 'pdf' | 'json';
  /** Switched on in the Library: the DM consults it in every campaign. */
  enabled: boolean;
  entryCount: number;
  /** For builtin sources: license name, e.g. "CC-BY-4.0". */
  license?: string;
  attribution?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
  /** Imports: bookFingerprint() of the entries' texts as imported, in ordinal order. Set once; never recomputed. */
  fingerprint?: string;
  /**
   * A JSON book's provenance: true when its entry kinds are an importer's guesses ("Download book data" of a
   * book imported as text), corrected like imported text's (src/data/chunk.ts kindsAreGuesses); false when
   * they are its file's own. Unset on books imported before this was recorded.
   */
  kindsGuessed?: boolean;
  /**
   * Denormalized counts for the library row; kept by every record write in @/storage (putRecords,
   * setRecordStatus, deleteRecords) in the same transaction. A gear table whose rows exist counts
   * nowhere (its rows stand for it). Absent = never structured.
   */
  structure?: {
    /** When the first record of this source was written. */
    detectedAt: number;
    /** PARSER_VERSION at that time. */
    parserVersion: number;
    counts: Partial<Record<StructuredKind, { pending: number; accepted: number; rejected: number }>>;
    /** Records with data === null that weren't kept as text ("Not read yet"). */
    needsClaude: number;
  };
}

export type HomebrewOrigin = 'dm' | 'player';

export interface HomebrewEntry extends CompendiumEntry {
  sourceId: typeof HOMEBREW_SOURCE_ID;
  /** null = shared across all campaigns. */
  campaignId: string | null;
  origin: HomebrewOrigin;
  /** The official content this was modified from, if any. */
  basedOn?: { name: string; id?: string };
  /** The DM's reasoning about balance (compared against SRD benchmarks). */
  balanceNotes?: string;
  status: 'active' | 'retired';
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Character-builder options (derived from the SRD; imports can add more later)
// ---------------------------------------------------------------------------

export interface EquipmentPackage {
  /** "Option A" / "Option B" etc. */
  label: string;
  items: { name: string; quantity: number }[];
  gp: number;
}

export interface ClassFeatureDef {
  level: number;
  name: string;
  /** Full rules text (the builder reads choice options and counts from it). */
  description: string;
  /** Short version (≈300 chars) for sheets and the DM prompt. */
  summary?: string;
  /** Imported options only: where the text came from (copied onto the sheet with the feature). */
  ref?: ImportedRef;
}

export interface SubclassOption {
  id: string;
  name: string;
  summary: string;
  features: ClassFeatureDef[];
  /** Imported options only. */
  source?: OptionSource;
  /** Level of its first feature as printed (1–2 in some 2014 books); features below the parent's subclassLevel arrive then. */
  firstLevel?: number;
  /** A subclass that grants Spellcasting with its own slots (third caster). */
  casterType?: 'third';
  spellcastingAbility?: Ability;
  alwaysPreparedSpells?: { level: number; spells: string[] }[];
}

export interface ClassOption {
  id: string;
  name: string;
  summary: string;
  hitDie: HitDie;
  primaryAbilities: Ability[];
  savingThrows: Ability[];
  skillChoices: { count: number; from: Skill[] };
  weaponProficiencies: string[];
  armorTraining: string[];
  tools: string[];
  casterType: CasterType;
  spellcastingAbility?: Ability;
  /** Number of weapons with usable mastery at level 1 (0 if the class lacks Weapon Mastery). */
  weaponMasteryCount: number;
  startingEquipment: EquipmentPackage[];
  /** Level at which the subclass is chosen (3 for every 2024 class). */
  subclassLevel: number;
  subclasses: SubclassOption[];
  features: ClassFeatureDef[];
  /** Per-level class table rows: { level, proficiencyBonus, ...class-specific columns }. */
  levelTable: Array<Record<string, string | number>>;
  /** Imported options only. */
  source?: OptionSource;
  /** "Strength or Dexterity" = 'any'. Absent: 'any' for the SRD Fighter, else 'all' (resolve.ts primaryRuleOf). */
  primaryAbilityRule?: 'all' | 'any';
  /** Another class's spell list it casts from ("Wizard"); absent = its own name. */
  spellListName?: string;
  /** Spell names its own list prints (SRD spells included). */
  spellNames?: string[];
}

export interface SpeciesTrait {
  name: string;
  description: string;
  /** Imported options only. */
  ref?: ImportedRef;
}

export interface SpeciesOption {
  id: string;
  name: string;
  summary: string;
  creatureType: string;
  sizes: CreatureSize[];
  speed: number;
  darkvision?: number;
  traits: SpeciesTrait[];
  /** Lineages / ancestries the player picks from (e.g. elven lineages, draconic ancestry). */
  lineages?: { name: string; description: string; ref?: ImportedRef }[];
  /** Imported options only. */
  source?: OptionSource;
  /** The trait that offers the lineages (wins over the /Lineage|Ancestry|Legacy/ name rule). */
  lineageTrait?: string;
  /** Older books: printed ability score increases, shown for reference and never applied. */
  legacyAbilityIncreases?: { ability: Ability | 'any'; amount: number }[];
  /** Printed languages: suggested for the two language picks, never added. */
  languages?: string[];
}

export interface BackgroundOption {
  id: string;
  name: string;
  summary: string;
  /** The three abilities a background lets you increase (+2/+1 or +1/+1/+1). */
  abilityScores: Ability[];
  /** Origin feat granted, by name. */
  feat: string;
  skills: Skill[];
  tool: string;
  equipment: EquipmentPackage[];
  /** Imported options only. */
  source?: OptionSource;
  /** 'any': the player picks any three abilities (absent = 'listed'). */
  abilityChoice?: 'listed' | 'any';
  /** true: `feat` is '' and the player picks an Origin feat. */
  featChoice?: boolean;
  /** Printed languages: suggested for the two language picks. */
  languages?: string[];
  /** Older books: the background's named feature (with its ref), kept as a 'background' feature. */
  legacyFeature?: SpeciesTrait;
}

export type FeatCategory = 'origin' | 'general' | 'fighting-style' | 'epic-boon';

export interface FeatOption {
  id: string;
  name: string;
  category: FeatCategory;
  prerequisite?: string;
  repeatable?: boolean;
  description: string;
  /** Imported options only. */
  source?: OptionSource;
  /** From "Level N+": the only prerequisite part the app checks. */
  minLevel?: number;
  abilityIncrease?: FeatData['abilityIncrease'];
  /** Imported options only: where `description` came from. */
  ref?: ImportedRef;
}

export interface BuilderData {
  classes: ClassOption[];
  species: SpeciesOption[];
  backgrounds: BackgroundOption[];
  feats: FeatOption[];
  /** Common gear the builder can offer (weapons, armor, packs) with basic stats. */
  equipment: EquipmentOption[];
}

export interface EquipmentOption {
  id: string;
  name: string;
  category: 'weapon' | 'armor' | 'shield' | 'gear' | 'tool' | 'pack';
  costGp?: number;
  weight?: number;
  /** Weapons: 'simple' or 'martial'. */
  weaponCategory?: 'simple' | 'martial';
  /** Weapons: 'melee' or 'ranged'. */
  weaponType?: 'melee' | 'ranged';
  /** Weapons with range, e.g. "80/320". */
  range?: string;
  /** Weapons: damage dice and type, e.g. "1d8" / "slashing". */
  damage?: string;
  damageType?: string;
  properties?: string[];
  mastery?: string;
  /** Armor: base AC and DEX cap (null = no cap, 0 = no DEX). */
  armorClass?: number;
  dexCap?: number | null;
  strengthRequirement?: number;
  stealthDisadvantage?: boolean;
  armorType?: 'light' | 'medium' | 'heavy';
  description?: string;
  /** Imported options only. */
  source?: OptionSource;
  /** Magic items in the catalog (imported): base stats are the base item's; bonuses apply once, in the engine. */
  magic?: EquipmentMagic;
}

/** A magic item's numbers on a catalog option. */
export interface EquipmentMagic {
  rarity: Rarity;
  attunement: boolean | string;
  bonuses?: ItemBonuses;
  /** The catalog option whose stats it copied. */
  baseItemId?: string;
}
