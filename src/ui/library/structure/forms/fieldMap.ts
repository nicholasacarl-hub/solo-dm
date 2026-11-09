/**
 * Warnings and excerpts name the wire field that produced a value ("hpText"); the review form edits
 * data paths ("hp", "hitDice"). This map joins the two, so a warning tags the right inputs with
 * "Check", "Go to field" focuses them, and focusing an input marks the words it came from.
 * A name that isn't a wire field is taken as a data path itself ("hp", "features.2.text").
 */
import type { StructuredKind } from '@/types';

type FieldMap = Readonly<Record<string, readonly string[]>>;

const COMMON: FieldMap = { name: ['name'], format: ['format'], matchesKind: ['kind'], notes: [] };

export const WIRE_FIELDS: Readonly<Record<StructuredKind, FieldMap>> = {
  monster: {
    sizeText: ['size', 'sizes'],
    typeText: ['type', 'tags'],
    alignmentText: ['alignment'],
    acText: ['ac', 'acNote'],
    hpText: ['hp', 'hitDice'],
    speedText: ['speeds', 'speed'],
    initiativeText: ['initiative'],
    crText: ['cr', 'crValue', 'xp', 'pb'],
    abilityScores: ['abilities'],
    sensesText: ['senses', 'passivePerception'],
    languagesText: ['languages'],
    resistancesText: ['resistances'],
    immunitiesText: ['immunities'],
    vulnerabilitiesText: ['vulnerabilities'],
    reachText: ['reachFt'],
  },
  spell: {
    levelText: ['level'],
    classesText: ['classes'],
    castingTimeText: ['castingTime', 'ritual'],
    rangeText: ['range'],
    componentsText: ['components'],
    durationText: ['duration', 'concentration'],
    areaText: ['area'],
    damageText: ['damage', 'damageTypes'],
    cantripScalingText: ['damageByCharacterLevel'],
  },
  'magic-item': {
    typeLineText: ['category', 'rarity', 'attunement', 'baseItem'],
    rarity: ['rarity', 'rarityText'],
    attunementText: ['attunement'],
    baseItemText: ['baseItem'],
    acBonus: ['bonuses.ac'],
    saveBonus: ['bonuses.savingThrows'],
    attackBonus: ['bonuses.attack'],
    damageBonus: ['bonuses.damage'],
    bonusText: ['bonuses'],
    acCondition: ['bonuses.acOnlyWhen'],
    chargesText: ['charges'],
  },
  item: {
    costText: ['costGp'],
    weightText: ['weight'],
    damageText: ['damage', 'damageType'],
    propertiesText: ['properties'],
    masteryText: ['mastery'],
    acText: ['armorClass', 'dexCap'],
    strengthText: ['strengthRequirement'],
  },
  feat: {
    categoryText: ['category'],
    prerequisiteText: ['prerequisite', 'minLevel'],
    abilityIncreaseText: ['abilityIncrease'],
  },
  background: {
    abilityScoresText: ['abilityScores'],
    featText: ['feat'],
    skillsText: ['skills'],
    toolText: ['tool'],
    equipmentText: ['equipment'],
    languagesText: ['languages'],
  },
  species: {
    creatureTypeText: ['creatureType'],
    sizeText: ['sizes'],
    speedText: ['speed'],
    darkvisionText: ['darkvision'],
    lineageTraitName: ['lineageTrait'],
    abilityIncreasesText: ['legacyAbilityIncreases'],
    languagesText: ['languages'],
  },
  class: {
    primaryAbilityText: ['primaryAbilities', 'primaryAbilityRule'],
    hitDieText: ['hitDie'],
    savingThrowsText: ['savingThrows'],
    skillsText: ['skillChoices'],
    weaponsText: ['weaponProficiencies', 'weaponMasteryCount'],
    armorText: ['armorTraining'],
    toolsText: ['tools'],
    equipmentText: ['startingEquipment'],
    preparedSpellsText: ['levelTable'],
    spellListText: ['spellListName', 'spellNames'],
  },
  subclass: {
    parentClassText: ['parentClass', 'parentClassId'],
    taglineText: ['summary'],
  },
};

/** "items[0].damageText" / "items.0.damageText" → "damageText" (a gear row's wire is a one-row table). */
function bare(field: string): string {
  return field.replace(/\[(\d+)\]/g, '.$1').replace(/^items\.\d+\./, '');
}

/** The data paths a warning's or excerpt's field names. */
export function dataPathsFor(kind: StructuredKind, field: string | undefined): string[] {
  if (!field) return [];
  const key = bare(field);
  const mapped = WIRE_FIELDS[kind][key] ?? COMMON[key];
  return mapped ? [...mapped] : [key];
}

/** The wire fields (and the path itself) that fill a data path: what to mark when an input has focus. */
export function wireFieldsFor(kind: StructuredKind, path: string): string[] {
  const out = new Set<string>([path]);
  const root = path.split('.')[0];
  for (const [wire, paths] of Object.entries(WIRE_FIELDS[kind])) {
    if (paths.some((p) => p === path || p === root || path.startsWith(`${p}.`))) out.add(wire);
  }
  return [...out];
}

/** Every data path the given warnings name (the "Check" tags). */
export function checkedPaths(kind: StructuredKind, fields: readonly (string | undefined)[]): Set<string> {
  return new Set(fields.flatMap((f) => dataPathsFor(kind, f)));
}
