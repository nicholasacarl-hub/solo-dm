/**
 * Character-builder draft: everything the player has chosen so far. Plain JSON so it can be kept
 * in sessionStorage while the player works through the steps.
 */
import type { Ability, AbilityScores, CreatureSize, Personality, Skill } from '@/types';

/** Steps in the 2024 character-creation order. */
export const BUILDER_STEPS = [
  'class',
  'background',
  'species',
  'abilities',
  'skills',
  'equipment',
  'spells',
  'details',
  'review',
] as const;

export type BuilderStep = (typeof BUILDER_STEPS)[number];

export const STEP_LABELS: Record<BuilderStep, string> = {
  class: 'Class',
  background: 'Background',
  species: 'Species',
  abilities: 'Ability scores',
  skills: 'Skills & languages',
  equipment: 'Equipment',
  spells: 'Spells',
  details: 'Details',
  review: 'Review',
};

export type AbilityMethod = 'standard' | 'point-buy' | 'roll';

/** Background ability score increase: +2 to one and +1 to another, or +1 to all three. */
export type BonusMode = 'two-one' | 'one-one-one';

/** One 4d6-drop-lowest roll. */
export interface RolledScore {
  total: number;
  /** All four dice in roll order. */
  dice: number[];
  /** Index (into dice) of the dropped die. */
  droppedIndex: number;
}

/** Choices for a Magic Initiate feat (two cantrips and one level 1 spell from one class list). */
export interface MagicInitiateChoice {
  /** INT, WIS or CHA (null until chosen). */
  ability: Ability | null;
  /** Spell entry ids. */
  cantrips: string[];
  spell: string | null;
}

export interface BuilderDraft {
  version: 1;
  step: BuilderStep;

  classId: string | null;
  /** Fighting Style feat name (e.g. Fighter level 1). */
  fightingStyle: string | null;
  /** Chosen option per level-1 "choose one of the following" class feature, e.g. { "Divine Order": "Protector" }. */
  classOptions: Record<string, string>;

  backgroundId: string | null;
  bonusMode: BonusMode;
  bonusPlus2: Ability | null;
  bonusPlus1: Ability | null;

  speciesId: string | null;
  lineage: string | null;
  /** Spellcasting ability for lineage spells (INT, WIS or CHA). */
  lineageAbility: Ability | null;
  size: CreatureSize | null;
  /** Skill from a species trait (Human Skillful, Elf Keen Senses). */
  speciesSkill: Skill | null;
  /** Extra Origin feat from a species trait (Human Versatile), by feat id. */
  speciesFeat: string | null;
  /** Spell list for a Magic Initiate species feat ("Cleric", "Druid" or "Wizard"). */
  speciesFeatList: string | null;

  abilityMethod: AbilityMethod;
  /** Standard array / rolled scores: index into the score pool for each ability. */
  assignment: Partial<Record<Ability, number>>;
  pointBuy: AbilityScores;
  rolls: RolledScore[] | null;

  /** Skills picked from the class list (or replacements when the class list runs out). */
  classSkills: Skill[];
  /** Skills from an Origin feat such as Skilled. */
  featSkills: Skill[];
  /** Expertise picks (e.g. Rogue level 1). */
  expertise: Skill[];
  /** Languages chosen beyond Common and any granted automatically. */
  languages: string[];

  /** Index into the class's starting-equipment packages. */
  classEquipment: number | null;
  /** Index into the background's equipment packages. */
  backgroundEquipment: number | null;
  /** Weapon names whose mastery property the character can use. */
  weaponMasteries: string[];

  /** Spell entry ids. */
  cantrips: string[];
  /** Wizard spellbook (level 1 spells). */
  spellbook: string[];
  /** Prepared level 1+ spells. */
  prepared: string[];
  /** Magic Initiate choices keyed by spell list ("Cleric", "Druid", "Wizard"). */
  magicInitiate: Record<string, MagicInitiateChoice>;

  name: string;
  pronouns: string;
  alignment: string;
  portrait: string;
  personality: Personality;
}

export const STANDARD_ARRAY: readonly number[] = [15, 14, 13, 12, 10, 8];

export function emptyDraft(): BuilderDraft {
  return {
    version: 1,
    step: 'class',
    classId: null,
    fightingStyle: null,
    classOptions: {},
    backgroundId: null,
    bonusMode: 'two-one',
    bonusPlus2: null,
    bonusPlus1: null,
    speciesId: null,
    lineage: null,
    lineageAbility: null,
    size: null,
    speciesSkill: null,
    speciesFeat: null,
    speciesFeatList: null,
    abilityMethod: 'standard',
    assignment: {},
    pointBuy: { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 },
    rolls: null,
    classSkills: [],
    featSkills: [],
    expertise: [],
    languages: [],
    classEquipment: null,
    backgroundEquipment: null,
    weaponMasteries: [],
    cantrips: [],
    spellbook: [],
    prepared: [],
    magicInitiate: {},
    name: '',
    pronouns: '',
    alignment: '',
    portrait: '',
    personality: {},
  };
}
