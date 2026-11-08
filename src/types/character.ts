/**
 * Character model for the 2024 fifth-edition rules (SRD 5.2.1).
 *
 * The app — never the language model — owns this state. The DM changes it only
 * through tools (see src/dm/tools), and every change is shown to the player.
 */

export type Ability = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';

export const ABILITIES: readonly Ability[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

export const ABILITY_NAMES: Record<Ability, string> = {
  str: 'Strength',
  dex: 'Dexterity',
  con: 'Constitution',
  int: 'Intelligence',
  wis: 'Wisdom',
  cha: 'Charisma',
};

export type AbilityScores = Record<Ability, number>;

export type Skill =
  | 'acrobatics'
  | 'animal-handling'
  | 'arcana'
  | 'athletics'
  | 'deception'
  | 'history'
  | 'insight'
  | 'intimidation'
  | 'investigation'
  | 'medicine'
  | 'nature'
  | 'perception'
  | 'performance'
  | 'persuasion'
  | 'religion'
  | 'sleight-of-hand'
  | 'stealth'
  | 'survival';

export const SKILLS: readonly Skill[] = [
  'acrobatics',
  'animal-handling',
  'arcana',
  'athletics',
  'deception',
  'history',
  'insight',
  'intimidation',
  'investigation',
  'medicine',
  'nature',
  'perception',
  'performance',
  'persuasion',
  'religion',
  'sleight-of-hand',
  'stealth',
  'survival',
];

export const SKILL_ABILITY: Record<Skill, Ability> = {
  acrobatics: 'dex',
  'animal-handling': 'wis',
  arcana: 'int',
  athletics: 'str',
  deception: 'cha',
  history: 'int',
  insight: 'wis',
  intimidation: 'cha',
  investigation: 'int',
  medicine: 'wis',
  nature: 'int',
  perception: 'wis',
  performance: 'cha',
  persuasion: 'cha',
  religion: 'int',
  'sleight-of-hand': 'dex',
  stealth: 'dex',
  survival: 'wis',
};

export const SKILL_NAMES: Record<Skill, string> = {
  acrobatics: 'Acrobatics',
  'animal-handling': 'Animal Handling',
  arcana: 'Arcana',
  athletics: 'Athletics',
  deception: 'Deception',
  history: 'History',
  insight: 'Insight',
  intimidation: 'Intimidation',
  investigation: 'Investigation',
  medicine: 'Medicine',
  nature: 'Nature',
  perception: 'Perception',
  performance: 'Performance',
  persuasion: 'Persuasion',
  religion: 'Religion',
  'sleight-of-hand': 'Sleight of Hand',
  stealth: 'Stealth',
  survival: 'Survival',
};

/** 0 = none, 0.5 = half proficiency (e.g. Jack of All Trades), 1 = proficient, 2 = expertise. */
export type ProficiencyLevel = 0 | 0.5 | 1 | 2;

export type HitDie = 6 | 8 | 10 | 12;

/** How a class contributes to spell slots (2024 multiclass rules). */
export type CasterType = 'full' | 'half' | 'third' | 'pact' | 'none';

export interface ClassLevel {
  /** Compendium id such as "srd:class:wizard", or a homebrew / imported id. */
  classId: string;
  /** Display name, e.g. "Wizard". */
  name: string;
  /** Levels taken in this class (1–20). */
  level: number;
  hitDie: HitDie;
  subclass?: string;
  casterType: CasterType;
  spellcastingAbility?: Ability;
}

export interface HitPoints {
  max: number;
  current: number;
  temp: number;
}

export interface HitDiceEntry {
  die: HitDie;
  total: number;
  spent: number;
}

export interface SlotTrack {
  max: number;
  used: number;
}

export type SpellSlotLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export type SpellSlots = Partial<Record<SpellSlotLevel, SlotTrack>>;

export interface PactMagic {
  slotLevel: SpellSlotLevel;
  slots: SlotTrack;
}

export interface KnownSpell {
  /** Compendium id when known (e.g. "srd:spell:fireball"), otherwise a generated id. */
  id: string;
  name: string;
  /** 0 = cantrip. */
  level: number;
  prepared: boolean;
  /** Always prepared (subclass spells, feat spells...). */
  alwaysPrepared?: boolean;
  /** Where the spell comes from: "Wizard", "Magic Initiate (Cleric)", "Homebrew". */
  source?: string;
  ritual?: boolean;
  concentration?: boolean;
  homebrewId?: string;
  notes?: string;
}

export interface Spellcasting {
  /** Primary spellcasting ability (used for save DC / attack in the sheet). */
  ability: Ability;
  slots: SpellSlots;
  pact?: PactMagic;
  spells: KnownSpell[];
  /** Name of the spell currently being concentrated on, if any. */
  concentratingOn?: string | null;
}

export type RechargeOn = 'short' | 'long' | 'dawn' | 'turn' | 'none';

export interface FeatureUses {
  max: number;
  used: number;
  recharge: RechargeOn;
  /**
   * Uses regained on a Short Rest when the feature otherwise recharges on a Long Rest
   * (2024: e.g. Channel Divinity and Wild Shape regain one use on a Short Rest).
   */
  shortRestRegain?: number;
  /** How `max` grows as the hero levels (recomputed on level-up). */
  scale?: FeatureScale;
}

/**
 * How a feature's maximum uses grow: equal to the proficiency bonus; a multiple of a class's level
 * (Lay on Hands = 5 × Paladin level); or read from a per-level table (Rage, Channel Divinity...).
 */
export type FeatureScale =
  | { by: 'proficiency-bonus' }
  | { by: 'class-level'; className: string; multiplier?: number }
  | { by: 'table'; className: string; /** index 0 = class level 1 */ values: number[] };

/** A bonus added to some skill checks: a flat number and/or an ability modifier (with a minimum). */
export interface SkillBonus {
  skills: Skill[];
  /** Add this ability's modifier (e.g. Thaumaturge: WIS to Arcana and Religion). */
  ability?: Ability;
  flat?: number;
  /** Minimum total bonus, e.g. 1 for "minimum of +1". */
  minimum?: number;
  /** Where it comes from, e.g. "Thaumaturge (Divine Order)". */
  source: string;
}

export type FeatureSource =
  | 'class'
  | 'subclass'
  | 'species'
  | 'background'
  | 'feat'
  | 'boon'
  | 'transformation'
  | 'item'
  | 'homebrew'
  | 'other';

export interface Feature {
  id: string;
  name: string;
  source: FeatureSource;
  /** Human label such as "Fighter 2" or "Alert (Origin feat)". */
  sourceName?: string;
  /** Short rules text (markdown). */
  description: string;
  uses?: FeatureUses;
  homebrewId?: string;
}

export type ItemCategory =
  | 'weapon'
  | 'armor'
  | 'shield'
  | 'gear'
  | 'tool'
  | 'consumable'
  | 'treasure'
  | 'magic-item'
  | 'other';

export interface InventoryItem {
  id: string;
  name: string;
  quantity: number;
  /** Weight in pounds per unit. */
  weight?: number;
  equipped?: boolean;
  attuned?: boolean;
  magic?: boolean;
  category?: ItemCategory;
  description?: string;
  charges?: SlotTrack;
  compendiumId?: string;
  homebrewId?: string;
}

export interface Currency {
  cp: number;
  sp: number;
  ep: number;
  gp: number;
  pp: number;
}

export interface Attack {
  id: string;
  name: string;
  /** Ability used for attack and damage rolls; 'finesse' uses the higher of STR/DEX; 'spell' uses the spellcasting ability. */
  ability: Ability | 'finesse' | 'spell';
  proficient: boolean;
  /** Damage dice plus any flat bonus beyond the ability modifier, e.g. "1d8" or "2d6+1". */
  damage: string;
  damageType: string;
  /** Additional attack-roll bonus (e.g. +1 weapon). */
  attackBonusExtra?: number;
  /** When false the ability modifier is NOT added to damage (e.g. off-hand attacks). Default true. */
  addAbilityToDamage?: boolean;
  /** "5 ft." or "80/320 ft." */
  range?: string;
  properties?: string[];
  /** 2024 weapon mastery property, e.g. "Vex". */
  mastery?: string;
  /**
   * Damage dice that grow with level: 'cantrip' = the cantrip's dice multiply at character levels
   * 5, 11 and 17; 'martial-arts' = the Monk's Martial Arts die (d6 → d8 at Monk 5, d10 at 11, d12 at 17).
   */
  scaling?: 'cantrip' | 'martial-arts';
  notes?: string;
}

export type ConditionId =
  | 'blinded'
  | 'charmed'
  | 'deafened'
  | 'exhaustion'
  | 'frightened'
  | 'grappled'
  | 'incapacitated'
  | 'invisible'
  | 'paralyzed'
  | 'petrified'
  | 'poisoned'
  | 'prone'
  | 'restrained'
  | 'stunned'
  | 'unconscious';

export const CONDITION_IDS: readonly ConditionId[] = [
  'blinded',
  'charmed',
  'deafened',
  'exhaustion',
  'frightened',
  'grappled',
  'incapacitated',
  'invisible',
  'paralyzed',
  'petrified',
  'poisoned',
  'prone',
  'restrained',
  'stunned',
  'unconscious',
];

export interface ActiveCondition {
  /** A standard condition id, or a homebrew condition name. */
  id: ConditionId | (string & {});
  /** Exhaustion level (combatants only — characters use Character.exhaustion). */
  level?: number;
  source?: string;
  /** Free text: "1 minute", "until the end of your next turn", "until cured". */
  duration?: string;
}

export interface DeathSaves {
  successes: number;
  failures: number;
  stable: boolean;
  dead: boolean;
}

export interface Personality {
  traits?: string;
  ideals?: string;
  bonds?: string;
  flaws?: string;
  appearance?: string;
  backstory?: string;
}

export type CreatureSize = 'Tiny' | 'Small' | 'Medium' | 'Large' | 'Huge' | 'Gargantuan';

/** Smallest to largest (SRD 5.2.1 Creature Size); index differences give "two sizes larger or smaller". */
export const CREATURE_SIZES: readonly CreatureSize[] = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'];

export interface Character {
  id: string;
  campaignId: string;
  name: string;
  pronouns?: string;
  /** Display string, e.g. "Elf (Wood Elf lineage)". */
  species: string;
  speciesId?: string;
  background: string;
  backgroundId?: string;
  /** First entry is the starting class. */
  classes: ClassLevel[];
  alignment?: string;
  xp: number;
  abilityScores: AbilityScores;
  /** Abilities with saving-throw proficiency. */
  savingThrows: Ability[];
  skills: Partial<Record<Skill, ProficiencyLevel>>;
  tools: string[];
  languages: string[];
  /** e.g. ["Simple weapons", "Martial weapons"]. */
  weaponProficiencies: string[];
  /** e.g. ["Light armor", "Medium armor", "Shields"]. */
  armorTraining: string[];
  /** 2024 Weapon Mastery: weapons whose mastery property the character can use. */
  weaponMasteries?: string[];
  armorClass: number;
  /** Human-readable note such as "Chain mail 16 + Shield 2". */
  acFormula?: string;
  /** Walking speed in feet (before exhaustion penalties). */
  speed: number;
  otherSpeeds?: Partial<Record<OtherSpeed, number>>;
  size: CreatureSize;
  /** Extra initiative bonus beyond DEX (e.g. Alert adds the proficiency bonus). */
  initiativeBonusExtra?: number;
  /** Extra passive Perception bonus (e.g. Observant-style features). */
  passivePerceptionExtra?: number;
  /** Darkvision range in feet; 0 or undefined = none. */
  darkvision?: number;
  /** Damage types the character resists (half damage), e.g. ["Fire"]. */
  damageResistances?: string[];
  /** Damage types the character is immune to. */
  damageImmunities?: string[];
  /** Damage types the character is vulnerable to (double damage). */
  damageVulnerabilities?: string[];
  /** Conditions the character can't be given, e.g. ["Poisoned"]. */
  conditionImmunities?: string[];
  /** Extra bonuses to particular skill checks (Thaumaturge, Magician...). */
  skillBonuses?: SkillBonus[];
  /** Lasting changes the story made to the hero (vampirism, lycanthropy, a celestial blessing...). */
  transformations?: Transformation[];
  hp: HitPoints;
  hitDice: HitDiceEntry[];
  deathSaves: DeathSaves;
  /** Active conditions. Exhaustion is tracked in `exhaustion`, not here. */
  conditions: ActiveCondition[];
  /** Exhaustion level 0–6 (2024: −2 per level to d20 tests, −5 ft speed per level, death at 6). */
  exhaustion: number;
  heroicInspiration: boolean;
  spellcasting?: Spellcasting;
  features: Feature[];
  attacks: Attack[];
  inventory: InventoryItem[];
  currency: Currency;
  personality: Personality;
  /** Player's free-form notes. */
  notes: string;
  /** Emoji or data URL. */
  portrait?: string;
  createdAt: number;
  updatedAt: number;
}

/** Movement other than walking. */
export type OtherSpeed = 'fly' | 'swim' | 'climb' | 'burrow';

/** The defenses a transformation can grant (damage types, or conditions for conditionImmunities). */
export type TransformationDefenseKind = 'resistances' | 'immunities' | 'vulnerabilities' | 'conditionImmunities';

/** Entries a transformation gives, and the ones it actually put on the sheet (the hero lacked them). */
export interface GrantedEntries {
  granted: string[];
  added: string[];
}

/** A range or speed a transformation gives, and the hero's own value before any transformation. */
export interface GrantedNumber {
  value: number;
  natural: number;
}

/**
 * What a transformation changed on the sheet, stored with it so that its end undoes exactly that
 * (and never the hero's own traits). Written only by the engine (src/engine/transform.ts); anything
 * that edits a transformation by hand must keep it.
 */
export interface TransformationGrants {
  defenses?: Partial<Record<TransformationDefenseKind, GrantedEntries>>;
  darkvision?: GrantedNumber;
  otherSpeeds?: Partial<Record<OtherSpeed, GrantedNumber>>;
  /** Walking speed change actually applied, in feet. */
  speed?: number;
  /** The size it sets, the hero's own size, and when it was set (the latest grant wins). */
  size?: { size: CreatureSize; natural: CreatureSize; at: number };
  /** Ability score changes actually applied (after the 1–30 limits). */
  abilities?: Partial<Record<Ability, number>>;
}

/**
 * A lasting, story-driven change to the hero: accepted as a bargain or temptation, or imposed as the
 * consequence of choices the player made knowingly (only when the campaign allows it). Its mechanics
 * live in features (source 'transformation'), defenses, senses and ability scores on the character;
 * this record tracks the story side and exactly what to undo when it ends.
 */
export interface Transformation {
  id: string;
  name: string;
  /** One or two sentences: what the hero is becoming, and what it costs. */
  summary: string;
  /** Free-text stage, e.g. "The hunger wakes" or "Stage 2 of 3". */
  stage?: string;
  /** 'accepted' = the player chose it; 'imposed' = a consequence of their choices. */
  origin: 'accepted' | 'imposed';
  status: 'active' | 'ended';
  /** How it could end: a cure, a ritual, a price to pay. */
  howItEnds?: string;
  /** Ids of the features this transformation added (removed when it ends). */
  featureIds: string[];
  /** Everything else it changed on the sheet (missing in records that changed nothing else). */
  grants?: TransformationGrants;
  startedSession: number;
  endedSession?: number;
  createdAt: number;
  updatedAt: number;
}
