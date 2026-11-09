/**
 * Reference data for the twelve SRD 5.2.1 classes: hit die, spellcasting progression, multiclass
 * prerequisites and the class-feature names per level (from each class's features table).
 * Used for level-up reminders and multiclassing; full feature text lives in the compendium.
 */
import type { Ability, CasterType, ClassLevel, FeatureScale, HitDie } from '@/types';
import { nameKey } from '@/lib/id';

export interface SrdClassInfo {
  /** Compendium id, e.g. "srd:class:wizard". */
  id: string;
  name: string;
  hitDie: HitDie;
  casterType: CasterType;
  spellcastingAbility?: Ability;
  /** Multiclassing prerequisite abilities (a score of 13+). */
  primaryAbilities: readonly Ability[];
  /** 'all' = every listed ability needs 13+; 'any' = one of them (Fighter: Strength or Dexterity). */
  primaryRule: 'all' | 'any';
  /** Class feature names by class level; index 0 = level 1. */
  featuresByLevel: readonly (readonly string[])[];
}

const ASI = 'Ability Score Improvement';
const SUB = 'Subclass feature';

/** Twenty "|"-separated feature lists ("" = no new class feature at that level). */
function levels(...rows: string[]): string[][] {
  if (rows.length !== 20) throw new Error(`class table needs 20 rows, got ${rows.length}`);
  return rows.map((row) => (row ? row.split('|') : []));
}

const CLASSES: readonly SrdClassInfo[] = [
  {
    id: 'srd:class:barbarian',
    name: 'Barbarian',
    hitDie: 12,
    casterType: 'none',
    primaryAbilities: ['str'],
    primaryRule: 'all',
    featuresByLevel: levels(
      'Rage|Unarmored Defense|Weapon Mastery', 'Danger Sense|Reckless Attack', 'Barbarian Subclass|Primal Knowledge', ASI,
      'Extra Attack|Fast Movement', SUB, 'Feral Instinct|Instinctive Pounce', ASI, 'Brutal Strike', SUB,
      'Relentless Rage', ASI, 'Improved Brutal Strike', SUB, 'Persistent Rage', ASI, 'Improved Brutal Strike',
      'Indomitable Might', 'Epic Boon', 'Primal Champion',
    ),
  },
  {
    id: 'srd:class:bard',
    name: 'Bard',
    hitDie: 8,
    casterType: 'full',
    spellcastingAbility: 'cha',
    primaryAbilities: ['cha'],
    primaryRule: 'all',
    featuresByLevel: levels(
      'Bardic Inspiration|Spellcasting', 'Expertise|Jack of All Trades', 'Bard Subclass', ASI, 'Font of Inspiration', SUB,
      'Countercharm', ASI, 'Expertise', 'Magical Secrets', '', ASI, '', SUB, '', ASI, '', 'Superior Inspiration',
      'Epic Boon', 'Words of Creation',
    ),
  },
  {
    id: 'srd:class:cleric',
    name: 'Cleric',
    hitDie: 8,
    casterType: 'full',
    spellcastingAbility: 'wis',
    primaryAbilities: ['wis'],
    primaryRule: 'all',
    featuresByLevel: levels(
      'Spellcasting|Divine Order', 'Channel Divinity', 'Cleric Subclass', ASI, 'Sear Undead', SUB, 'Blessed Strikes', ASI,
      '', 'Divine Intervention', '', ASI, '', 'Improved Blessed Strikes', '', ASI, SUB, '', 'Epic Boon',
      'Greater Divine Intervention',
    ),
  },
  {
    id: 'srd:class:druid',
    name: 'Druid',
    hitDie: 8,
    casterType: 'full',
    spellcastingAbility: 'wis',
    primaryAbilities: ['wis'],
    primaryRule: 'all',
    featuresByLevel: levels(
      'Spellcasting|Druidic|Primal Order', 'Wild Shape|Wild Companion', 'Druid Subclass', ASI, 'Wild Resurgence', SUB,
      'Elemental Fury', ASI, '', SUB, '', ASI, '', SUB, 'Improved Elemental Fury', ASI, '', 'Beast Spells', 'Epic Boon',
      'Archdruid',
    ),
  },
  {
    id: 'srd:class:fighter',
    name: 'Fighter',
    hitDie: 10,
    casterType: 'none',
    primaryAbilities: ['str', 'dex'],
    primaryRule: 'any',
    featuresByLevel: levels(
      'Fighting Style|Second Wind|Weapon Mastery', 'Action Surge (one use)|Tactical Mind', 'Fighter Subclass', ASI,
      'Extra Attack|Tactical Shift', ASI, SUB, ASI, 'Indomitable (one use)|Tactical Master', SUB, 'Two Extra Attacks', ASI,
      'Indomitable (two uses)|Studied Attacks', ASI, SUB, ASI, 'Action Surge (two uses)|Indomitable (three uses)', SUB,
      'Epic Boon', 'Three Extra Attacks',
    ),
  },
  {
    id: 'srd:class:monk',
    name: 'Monk',
    hitDie: 8,
    casterType: 'none',
    primaryAbilities: ['dex', 'wis'],
    primaryRule: 'all',
    featuresByLevel: levels(
      'Martial Arts|Unarmored Defense', "Monk's Focus|Unarmored Movement|Uncanny Metabolism", 'Deflect Attacks|Monk Subclass',
      `${ASI}|Slow Fall`, 'Extra Attack|Stunning Strike', `Empowered Strikes|${SUB}`, 'Evasion', ASI, 'Acrobatic Movement',
      'Heightened Focus|Self-Restoration', SUB, ASI, 'Deflect Energy', 'Disciplined Survivor', 'Perfect Focus', ASI, SUB,
      'Superior Defense', 'Epic Boon', 'Body and Mind',
    ),
  },
  {
    id: 'srd:class:paladin',
    name: 'Paladin',
    hitDie: 10,
    casterType: 'half',
    spellcastingAbility: 'cha',
    primaryAbilities: ['str', 'cha'],
    primaryRule: 'all',
    featuresByLevel: levels(
      'Lay On Hands|Spellcasting|Weapon Mastery', "Fighting Style|Paladin's Smite", 'Channel Divinity|Paladin Subclass', ASI,
      'Extra Attack|Faithful Steed', 'Aura of Protection', SUB, ASI, 'Abjure Foes', 'Aura of Courage', 'Radiant Strikes', ASI,
      '', 'Restoring Touch', SUB, ASI, '', 'Aura Expansion', 'Epic Boon', SUB,
    ),
  },
  {
    id: 'srd:class:ranger',
    name: 'Ranger',
    hitDie: 10,
    casterType: 'half',
    spellcastingAbility: 'wis',
    primaryAbilities: ['dex', 'wis'],
    primaryRule: 'all',
    featuresByLevel: levels(
      'Spellcasting|Favored Enemy|Weapon Mastery', 'Deft Explorer|Fighting Style', 'Ranger Subclass', ASI, 'Extra Attack',
      'Roving', SUB, ASI, 'Expertise', 'Tireless', SUB, ASI, 'Relentless Hunter', "Nature's Veil", SUB, ASI,
      'Precise Hunter', 'Feral Senses', 'Epic Boon', 'Foe Slayer',
    ),
  },
  {
    id: 'srd:class:rogue',
    name: 'Rogue',
    hitDie: 8,
    casterType: 'none',
    primaryAbilities: ['dex'],
    primaryRule: 'all',
    featuresByLevel: levels(
      "Expertise|Sneak Attack|Thieves' Cant|Weapon Mastery", 'Cunning Action', 'Rogue Subclass|Steady Aim', ASI,
      'Cunning Strike|Uncanny Dodge', 'Expertise', 'Evasion|Reliable Talent', ASI, SUB, ASI, 'Improved Cunning Strike', ASI,
      SUB, 'Devious Strikes', 'Slippery Mind', ASI, SUB, 'Elusive', 'Epic Boon', 'Stroke of Luck',
    ),
  },
  {
    id: 'srd:class:sorcerer',
    name: 'Sorcerer',
    hitDie: 6,
    casterType: 'full',
    spellcastingAbility: 'cha',
    primaryAbilities: ['cha'],
    primaryRule: 'all',
    featuresByLevel: levels(
      'Spellcasting|Innate Sorcery', 'Font of Magic|Metamagic', 'Sorcerer Subclass', ASI, 'Sorcerous Restoration', SUB,
      'Sorcery Incarnate', ASI, '', 'Metamagic', '', ASI, '', SUB, '', ASI, 'Metamagic', SUB, 'Epic Boon',
      'Arcane Apotheosis',
    ),
  },
  {
    id: 'srd:class:warlock',
    name: 'Warlock',
    hitDie: 8,
    casterType: 'pact',
    spellcastingAbility: 'cha',
    primaryAbilities: ['cha'],
    primaryRule: 'all',
    featuresByLevel: levels(
      'Eldritch Invocations|Pact Magic', 'Magical Cunning', 'Warlock Subclass', ASI, '', SUB, '', ASI, 'Contact Patron', SUB,
      'Mystic Arcanum (level 6 spell)', ASI, 'Mystic Arcanum (level 7 spell)', SUB, 'Mystic Arcanum (level 8 spell)', ASI,
      'Mystic Arcanum (level 9 spell)', '', 'Epic Boon', 'Eldritch Master',
    ),
  },
  {
    id: 'srd:class:wizard',
    name: 'Wizard',
    hitDie: 6,
    casterType: 'full',
    spellcastingAbility: 'int',
    primaryAbilities: ['int'],
    primaryRule: 'all',
    featuresByLevel: levels(
      'Spellcasting|Ritual Adept|Arcane Recovery', 'Scholar', 'Wizard Subclass', ASI, 'Memorize Spell', SUB, '', ASI, '', SUB,
      '', ASI, '', SUB, '', ASI, '', 'Spell Mastery', 'Epic Boon', 'Signature Spells',
    ),
  },
];

export const SRD_CLASSES: readonly SrdClassInfo[] = CLASSES;

/** Eldritch Invocations known by Warlock level (index 0 = level 1). */
export const WARLOCK_INVOCATIONS: readonly number[] = [1, 3, 3, 3, 5, 5, 6, 6, 7, 7, 7, 8, 8, 8, 9, 9, 9, 10, 10, 10];

const table = (className: string, values: number[]): FeatureScale => ({ by: 'table', className, values });

/**
 * SRD 5.2.1 class features whose number of uses grows with class level: the class tables' Rages,
 * Second Wind, Channel Divinity, Wild Shape, Favored Enemy, Focus Points and Sorcery Points columns
 * (0 = not gained yet), and Lay On Hands (a pool of 5 × Paladin level). Used for features saved
 * before FeatureUses.scale existed.
 */
export const SRD_FEATURE_USE_SCALES: ReadonlyArray<{ className: string; feature: string; scale: FeatureScale }> = [
  { className: 'Barbarian', feature: 'Rage', scale: table('Barbarian', [2, 2, 3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 6, 6, 6, 6]) },
  { className: 'Fighter', feature: 'Second Wind', scale: table('Fighter', [2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4]) },
  { className: 'Cleric', feature: 'Channel Divinity', scale: table('Cleric', [0, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4]) },
  { className: 'Paladin', feature: 'Channel Divinity', scale: table('Paladin', [0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]) },
  { className: 'Druid', feature: 'Wild Shape', scale: table('Druid', [0, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4]) },
  { className: 'Ranger', feature: 'Favored Enemy', scale: table('Ranger', [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6]) },
  { className: 'Paladin', feature: 'Lay On Hands', scale: { by: 'class-level', className: 'Paladin', multiplier: 5 } },
  { className: 'Monk', feature: "Monk's Focus", scale: { by: 'class-level', className: 'Monk' } },
  { className: 'Sorcerer', feature: 'Font of Magic', scale: { by: 'class-level', className: 'Sorcerer' } },
];

/** Look up an SRD class by name ("wizard") or compendium id ("srd:class:wizard"). */
export function findSrdClass(nameOrId: string | undefined): SrdClassInfo | undefined {
  if (!nameOrId) return undefined;
  const key = nameKey(nameOrId.replace(/^srd:class:/i, ''));
  return CLASSES.find((c) => nameKey(c.name) === key);
}

/** A class or subclass id from an imported book ("lib:<sourceId>:…"): never an SRD class by name. */
export function isLibraryId(id: string | undefined): boolean {
  return Boolean(id?.startsWith('lib:'));
}

/**
 * The SRD class a character's class entry refers to (by id first, then by name). An imported class is
 * never the SRD class of the same name (SRD 5.2.1 "Classes": an imported "Fighter" gets no SRD Fighter
 * reminders, critical range, Unarmored Defense or Hit Point rules).
 */
export function srdClassFor(cl: Pick<ClassLevel, 'classId' | 'name'>): SrdClassInfo | undefined {
  const byId = cl.classId.startsWith('srd:class:') ? findSrdClass(cl.classId) : undefined;
  if (byId || isLibraryId(cl.classId)) return byId;
  return findSrdClass(cl.name);
}

/** Class levels at which a class gains the Ability Score Improvement feature (Fighter 6/14, Rogue 10 included). */
export function asiLevels(info: SrdClassInfo): number[] {
  return info.featuresByLevel.flatMap((features, i) => (features.includes(ASI) ? [i + 1] : []));
}

/** Class feature names gained at a class level (empty for unknown levels). */
export function featuresAtLevel(info: SrdClassInfo, level: number): readonly string[] {
  return info.featuresByLevel[level - 1] ?? [];
}
