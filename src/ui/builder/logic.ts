/**
 * Character-builder rules (SRD 5.2.1 "Creating a Character"): turn a BuilderDraft into a level 1
 * Character, compute the live preview, decide which steps apply and validate each one.
 * Pure functions; derived numbers come from '@/engine'.
 *
 * This module is the builder's public API: it re-exports the focused helpers it is built from.
 */
import {
  abilityModifier,
  attackBonus,
  attackDamageExpression,
  computeArmorClass,
  createBlankCharacter,
  initiativeModifier,
  passivePerception,
  proficiencyBonus,
  savingThrowModifier,
  skillModifier,
  spellAttackBonus,
  spellSaveDC,
  spellSlotsForClasses,
  spellcastingAbility,
} from '@/engine';
import {
  ABILITIES,
  ABILITY_NAMES,
  SKILLS,
  SKILL_NAMES,
  type Ability,
  type BuilderData,
  type Character,
  type ClassLevel,
  type ClassOption,
  type EquipmentOption,
  type Feature,
  type KnownSpell,
  type ProficiencyLevel,
  type Skill,
  type SkillBonus,
  type Spellcasting,
} from '@/types';
import { nameKey, newId } from '@/lib/id';
import { finalAbilityScores, validateAbilities } from './abilities';
import {
  alwaysPreparedSpellNames,
  cantripsKnown,
  classChoiceFeatures,
  featuresAtLevel,
  martialArtsDie,
  masteryMeleeOnly,
  needsFightingStyle,
  optionGrants,
  preparedSpellCount,
  spellbookSize,
} from './classFeatures';
import { attacksForInventory, gearFromPackages, masteryCandidates } from './equipment';
import { inferFeatureUses, type UsesContext } from './featureUses';
import { defaultPortrait } from './flavor';
import {
  allLanguages,
  findFeat,
  grantsInitiativeProficiency,
  isMagicInitiate,
  magicInitiateSources,
  originFeats,
  picks,
  skillProficiencies,
  validateLanguages,
  validateSkills,
  validateSpeciesSkill,
  type Picks,
} from './origin';
import { cantripNames, hpBonusPerLevel, lineageEffects, lineageFeatureText, speciesDisplayName, speciesResistances } from './species';
import { findSpellByName, knownSpell, spellAttack, spellsForClass, spellsForClassOption, type SpellInfo } from './spells';
import { BUILDER_STEPS, type BuilderDraft, type BuilderStep } from './types';

export * from './abilities';
export * from './classFeatures';
export * from './equipment';
export * from './featureUses';
export * from './origin';
export * from './species';
export * from './spells';
export * from './types';

export interface BuilderContext {
  data: BuilderData;
  /** Every spell from the rules index (empty while it loads or if it is unavailable). */
  spells: SpellInfo[];
}

const MENTAL_ABILITIES: Ability[] = ['int', 'wis', 'cha'];

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function notNone(text: string): boolean {
  return text.trim() !== '' && !/^none$/i.test(text.trim());
}

// ---------------------------------------------------------------------------
// Class choices
// ---------------------------------------------------------------------------

/** Proficiencies, cantrips and skill bonuses granted by the chosen level-1 class options (Divine Order...). */
export function classOptionGrants(draft: BuilderDraft, cls: ClassOption | undefined) {
  const grants = { weapons: [] as string[], armor: [] as string[], extraCantrips: 0, skillBonuses: [] as SkillBonus[] };
  for (const { feature, options } of classChoiceFeatures(cls)) {
    const chosen = options.find((o) => o.name === draft.classOptions[feature.name]);
    if (!chosen) continue;
    const g = optionGrants(chosen.description);
    grants.weapons.push(...g.weapons);
    grants.armor.push(...g.armor);
    grants.extraCantrips += g.extraCantrips;
    // Thaumaturge / Magician: "Thaumaturge (Divine Order)" adds WIS (min +1) to Arcana and Religion.
    if (g.skillBonus) grants.skillBonuses.push({ ...g.skillBonus, source: `${chosen.name} (${feature.name})` });
  }
  return grants;
}

export function weaponProficienciesFor(draft: BuilderDraft, cls: ClassOption | undefined): string[] {
  return unique([...(cls?.weaponProficiencies ?? []), ...classOptionGrants(draft, cls).weapons]).filter(notNone);
}

export function armorTrainingFor(draft: BuilderDraft, cls: ClassOption | undefined): string[] {
  return unique([...(cls?.armorTraining ?? []), ...classOptionGrants(draft, cls).armor]).filter(notNone);
}

/** Weapons the class may master, and how many to pick. */
export function masteryPlan(draft: BuilderDraft, data: BuilderData): { count: number; candidates: EquipmentOption[] } {
  const { cls } = picks(draft, data);
  if (!cls || cls.weaponMasteryCount <= 0) return { count: 0, candidates: [] };
  const candidates = masteryCandidates(data.equipment, weaponProficienciesFor(draft, cls), { meleeOnly: masteryMeleeOnly(cls) });
  return { count: Math.min(cls.weaponMasteryCount, candidates.length), candidates };
}

function chosenMasteries(draft: BuilderDraft, data: BuilderData): string[] {
  const { candidates } = masteryPlan(draft, data);
  const names = new Set(candidates.map((c) => nameKey(c.name)));
  return draft.weaponMasteries.filter((m) => names.has(nameKey(m)));
}

// ---------------------------------------------------------------------------
// Spells
// ---------------------------------------------------------------------------

export interface SpellPlan {
  /** The class has Spellcasting or Pact Magic at level 1. */
  casting: boolean;
  cantrips: number;
  /** Level 1+ spells to prepare. */
  prepared: number;
  /** Wizard-style spellbook size (0 = no spellbook). */
  spellbook: number;
  magicInitiate: { list: string; source: string }[];
}

export function spellPlan(draft: BuilderDraft, data: BuilderData): SpellPlan {
  const { cls } = picks(draft, data);
  const magicInitiate = magicInitiateSources(draft, data);
  if (!cls || cls.casterType === 'none') {
    return { casting: false, cantrips: 0, prepared: 0, spellbook: 0, magicInitiate };
  }
  const cantrips = cantripsKnown(cls, 1) + classOptionGrants(draft, cls).extraCantrips;
  const prepared = preparedSpellCount(cls, 1);
  const spellbook = spellbookSize(cls);
  return { casting: cantrips + prepared + spellbook > 0, cantrips, prepared, spellbook, magicInitiate };
}

/** Class cantrip / level 1 options. */
export function classSpellOptions(draft: BuilderDraft, ctx: BuilderContext, level: 0 | 1): SpellInfo[] {
  const { cls } = picks(draft, ctx.data);
  return cls ? spellsForClassOption(ctx.spells, cls, level) : [];
}

function speciesSpellNames(p: Picks): { cantrips: string[]; alwaysPrepared: string[] } {
  const cantrips: string[] = [];
  for (const trait of p.species?.traits ?? []) {
    if (trait === p.choices.lineageTrait) continue;
    cantrips.push(...cantripNames(trait.description));
  }
  const fx = p.lineage ? lineageEffects(p.lineage.description) : { cantrips: [], alwaysPrepared: [] };
  return { cantrips: [...cantrips, ...fx.cantrips], alwaysPrepared: fx.alwaysPrepared };
}

function abilityNote(ability: Ability | null | undefined): string | undefined {
  return ability ? `Spellcasting ability: ${ABILITY_NAMES[ability]}` : undefined;
}

function buildSpellcasting(draft: BuilderDraft, ctx: BuilderContext, p: Picks, classes: ClassLevel[]): Spellcasting | undefined {
  const plan = spellPlan(draft, ctx.data);
  const byId = new Map(ctx.spells.map((s) => [s.id, s]));
  const spells: KnownSpell[] = [];
  const add = (spell: KnownSpell) => {
    if (!spells.some((s) => nameKey(s.name) === nameKey(spell.name))) spells.push(spell);
  };
  const { cls } = p;
  if (cls && plan.casting) {
    for (const id of draft.cantrips) {
      const s = byId.get(id);
      if (s) add(knownSpell(s, s, { source: cls.name }));
    }
    const levelled = plan.spellbook ? draft.spellbook : draft.prepared;
    for (const id of levelled) {
      const s = byId.get(id);
      if (s) add(knownSpell(s, s, { source: cls.name, prepared: draft.prepared.includes(id) }));
    }
    for (const def of featuresAtLevel(cls, 1)) {
      for (const name of alwaysPreparedSpellNames(def.description)) {
        add(knownSpell(findSpellByName(ctx.spells, name), { name, level: 1 }, { alwaysPrepared: true, source: def.name }));
      }
    }
  }
  for (const { list } of plan.magicInitiate) {
    const choice = draft.magicInitiate[list];
    if (!choice) continue;
    const source = `Magic Initiate (${list})`;
    const notes = abilityNote(choice.ability);
    for (const id of choice.cantrips) {
      const s = byId.get(id);
      if (s) add(knownSpell(s, s, { source, notes }));
    }
    const s = choice.spell ? byId.get(choice.spell) : undefined;
    if (s) add(knownSpell(s, s, { source, alwaysPrepared: true, notes: [notes, 'Once per Long Rest without a spell slot'].filter(Boolean).join('. ') }));
  }
  const speciesSource = p.lineage?.name ?? p.species?.name;
  const speciesNotes = abilityNote(draft.lineageAbility);
  const fromSpecies = speciesSpellNames(p);
  for (const name of fromSpecies.cantrips) {
    add(knownSpell(findSpellByName(ctx.spells, name), { name, level: 0 }, { source: speciesSource, notes: speciesNotes }));
  }
  for (const name of fromSpecies.alwaysPrepared) {
    add(knownSpell(findSpellByName(ctx.spells, name), { name, level: 1 }, { source: speciesSource, alwaysPrepared: true, notes: speciesNotes }));
  }

  if (!plan.casting && spells.length === 0) return undefined;
  const { slots, pact } = spellSlotsForClasses(classes);
  const firstInitiate = plan.magicInitiate.map((m) => draft.magicInitiate[m.list]?.ability).find(Boolean);
  const ability = cls?.spellcastingAbility ?? draft.lineageAbility ?? firstInitiate ?? 'int';
  return { ability, slots, ...(pact ? { pact } : {}), spells, concentratingOn: null };
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

function feature(name: string, source: Feature['source'], sourceName: string, description: string, uses: Feature['uses']): Feature {
  return { id: newId(), name, source, sourceName, description, ...(uses ? { uses } : {}) };
}

function buildFeatures(draft: BuilderDraft, data: BuilderData, p: Picks, usesCtx: UsesContext): Feature[] {
  const out: Feature[] = [];
  const { cls, species, lineage, choices } = p;
  if (cls) {
    // Only real choices get the option in their name (a stale draft may still hold e.g. Rage: "Duration").
    const choiceOptions = new Map(classChoiceFeatures(cls).map(({ feature: def, options }) => [def.name, options]));
    for (const def of featuresAtLevel(cls, 1)) {
      const chosen = choiceOptions.get(def.name)?.find((o) => o.name === draft.classOptions[def.name])?.name;
      const name = chosen ? `${def.name} (${chosen})` : def.name;
      out.push(feature(name, 'class', `${cls.name} 1`, def.description, inferFeatureUses(def.name, def.description, { ...usesCtx, cls })));
    }
    if (needsFightingStyle(cls) && draft.fightingStyle) {
      const feat = findFeat(data.feats, draft.fightingStyle);
      out.push(feature(feat?.name ?? draft.fightingStyle, 'feat', `Fighting Style (${cls.name} 1)`, feat?.description ?? '', undefined));
    }
  }
  for (const originFeat of originFeats(draft, data)) {
    const description = originFeat.feat?.description ?? '';
    out.push(feature(originFeat.name, 'feat', originFeat.source, description, inferFeatureUses(originFeat.name, description, usesCtx)));
  }
  for (const trait of species?.traits ?? []) {
    if (trait === choices.lineageTrait && lineage) {
      // Only the chosen option: Giant Ancestry's use limit is in its preamble, and the Forest Gnome's
      // Proficiency Bonus uses must not reach a Rock Gnome.
      const text = lineageFeatureText(trait, lineage);
      out.push(feature(`${trait.name} (${lineage.name})`, 'species', species!.name, text, inferFeatureUses(trait.name, text, usesCtx)));
      continue;
    }
    let name = trait.name;
    if (choices.skill?.trait === trait.name && draft.speciesSkill) name = `${trait.name} (${SKILL_NAMES[draft.speciesSkill]})`;
    if (choices.originFeat?.trait === trait.name) {
      const feat = data.feats.find((f) => f.id === draft.speciesFeat);
      if (feat) name = `${trait.name} (${feat.name})`;
    }
    out.push(feature(name, 'species', species!.name, trait.description, inferFeatureUses(trait.name, trait.description, usesCtx)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface BuildOptions {
  campaignId: string;
  /** Keep this id (rebuilding an existing character from scratch). */
  id?: string;
}

/** The finished level 1 Character, built on top of the engine's blank character. */
export function buildCharacter(draft: BuilderDraft, ctx: BuilderContext, opts: BuildOptions): Character {
  const { data } = ctx;
  const p = picks(draft, data);
  const { cls, background, species, lineage } = p;
  const blank = createBlankCharacter(opts.campaignId);
  const scores = finalAbilityScores(draft, background);
  const pb = proficiencyBonus(1);
  const weaponProficiencies = weaponProficienciesFor(draft, cls);
  const armorTraining = armorTrainingFor(draft, cls);

  const classes: ClassLevel[] = cls
    ? [
        {
          classId: cls.id,
          name: cls.name,
          level: 1,
          hitDie: cls.hitDie,
          casterType: cls.casterType,
          ...(cls.spellcastingAbility ? { spellcastingAbility: cls.spellcastingAbility } : {}),
        },
      ]
    : [];

  const classPackage = draft.classEquipment === null ? undefined : cls?.startingEquipment[draft.classEquipment];
  const backgroundPackage = draft.backgroundEquipment === null ? undefined : background?.equipment[draft.backgroundEquipment];
  const gear = gearFromPackages([classPackage, backgroundPackage], data.equipment, { armorTraining });
  const masteries = chosenMasteries(draft, data);
  const unarmedDie = martialArtsDie(cls);
  const attacks = attacksForInventory(gear.items, data.equipment, {
    weaponProficiencies,
    masteries,
    martialArts: unarmedDie !== null,
    martialArtsDie: unarmedDie,
  });

  const spellcasting = buildSpellcasting(draft, ctx, p, classes);
  for (const spell of spellcasting?.spells ?? []) {
    const info = spell.level === 0 ? ctx.spells.find((s) => s.id === spell.id) : undefined;
    const attack = info && spellAttack(info);
    if (attack) attacks.push(attack);
  }

  const features = buildFeatures(draft, data, p, { level: 1, proficiencyBonus: pb, scores });
  const hpBonus = hpBonusPerLevel(species?.traits ?? []);
  const maxHp = Math.max(1, (cls?.hitDie ?? 8) + abilityModifier(scores.con) + hpBonus);
  const lineageFx = lineage ? lineageEffects(lineage.description) : undefined;
  const feats = originFeats(draft, data);
  const resourceful = (species?.traits ?? []).some((t) => /gain Heroic Inspiration whenever you finish a Long Rest/i.test(t.description));
  // The engine halves damage of these types (Dwarven Resilience, Dragonborn ancestry, Tiefling legacy).
  const resistances = speciesResistances(species, lineage);
  const skillBonuses = classOptionGrants(draft, cls).skillBonuses;

  const character: Character = {
    ...blank,
    id: opts.id ?? blank.id,
    campaignId: opts.campaignId,
    name: draft.name.trim(),
    pronouns: draft.pronouns.trim() || undefined,
    species: speciesDisplayName(species, lineage?.name ?? null),
    speciesId: species?.id,
    background: background?.name ?? '',
    backgroundId: background?.id,
    classes,
    alignment: draft.alignment.trim() || undefined,
    xp: 0,
    abilityScores: scores,
    savingThrows: cls?.savingThrows ?? [],
    skills: skillProficiencies(draft, data),
    tools: unique([...(cls?.tools ?? []), ...(background?.tool ? [background.tool] : [])]).filter(notNone),
    languages: allLanguages(draft, data),
    weaponProficiencies,
    armorTraining,
    weaponMasteries: masteries,
    speed: lineageFx?.speed ?? species?.speed ?? 30,
    size: draft.size ?? species?.sizes[0] ?? 'Medium',
    initiativeBonusExtra: feats.some(grantsInitiativeProficiency) ? pb : 0,
    darkvision: lineageFx?.darkvision ?? species?.darkvision,
    ...(resistances.length ? { damageResistances: resistances } : {}),
    ...(skillBonuses.length ? { skillBonuses } : {}),
    hp: { max: maxHp, current: maxHp, temp: 0 },
    hitDice: cls ? [{ die: cls.hitDie, total: 1, spent: 0 }] : [],
    deathSaves: { successes: 0, failures: 0, stable: false, dead: false },
    conditions: [],
    exhaustion: 0,
    heroicInspiration: resourceful,
    spellcasting,
    features,
    attacks,
    inventory: gear.items,
    currency: { cp: 0, sp: 0, ep: 0, gp: gear.gp, pp: 0 },
    personality: cleanPersonality(draft.personality),
    notes: '',
    portrait: draft.portrait || defaultPortrait(species?.name),
  };
  // The engine applies worn armor, shields, Unarmored Defense and the Defense fighting style.
  const ac = computeArmorClass(character, data.equipment);
  return { ...character, armorClass: ac.ac, acFormula: ac.formula };
}

function cleanPersonality(personality: BuilderDraft['personality']): Character['personality'] {
  const out: Character['personality'] = {};
  for (const [key, value] of Object.entries(personality) as [keyof Character['personality'], string | undefined][]) {
    const text = value?.trim();
    if (text) out[key] = text;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface PreviewStats {
  proficiencyBonus: number;
  hp: number;
  ac: number;
  acFormula: string;
  initiative: number;
  speed: number;
  passivePerception: number;
  abilities: { ability: Ability; score: number; modifier: number; save: number; saveProficient: boolean }[];
  skills: { skill: Skill; modifier: number; level: ProficiencyLevel }[];
  spell: { ability: Ability; saveDc: number; attackBonus: number } | null;
  attacks: { id: string; name: string; bonus: number; damage: string; damageType: string }[];
}

/** Derived numbers for the live preview, computed by the engine from the built character. */
export function previewStats(c: Character): PreviewStats {
  const ability = spellcastingAbility(c);
  const saveDc = ability ? spellSaveDC(c, ability) : null;
  const attack = ability ? spellAttackBonus(c, ability) : null;
  return {
    proficiencyBonus: proficiencyBonus(1),
    hp: c.hp.max,
    ac: c.armorClass,
    acFormula: c.acFormula ?? '',
    initiative: initiativeModifier(c),
    speed: c.speed,
    passivePerception: passivePerception(c),
    abilities: ABILITIES.map((a) => ({
      ability: a,
      score: c.abilityScores[a],
      modifier: abilityModifier(c.abilityScores[a]),
      save: savingThrowModifier(c, a),
      saveProficient: c.savingThrows.includes(a),
    })),
    skills: SKILLS.map((s) => ({ skill: s, modifier: skillModifier(c, s), level: c.skills[s] ?? 0 })),
    spell: ability && saveDc !== null && attack !== null ? { ability, saveDc, attackBonus: attack } : null,
    attacks: c.attacks.map((a) => ({
      id: a.id,
      name: a.name,
      bonus: attackBonus(c, a),
      damage: attackDamageExpression(c, a),
      damageType: a.damageType,
    })),
  };
}

// ---------------------------------------------------------------------------
// Steps & validation
// ---------------------------------------------------------------------------

/** Steps that apply to this draft (Spells only for casters and Magic Initiate). */
export function activeSteps(draft: BuilderDraft, data: BuilderData): BuilderStep[] {
  const plan = spellPlan(draft, data);
  return BUILDER_STEPS.filter((s) => s !== 'spells' || plan.casting || plan.magicInitiate.length > 0);
}

function validateClass(draft: BuilderDraft, data: BuilderData): string[] {
  const { cls } = picks(draft, data);
  if (!cls) return ['Choose a class.'];
  const errors: string[] = [];
  if (needsFightingStyle(cls) && !draft.fightingStyle) errors.push('Choose a Fighting Style.');
  for (const { feature: def, options } of classChoiceFeatures(cls)) {
    if (!options.some((o) => o.name === draft.classOptions[def.name])) errors.push(`Choose your ${def.name}.`);
  }
  return errors;
}

function validateSpecies(draft: BuilderDraft, data: BuilderData): string[] {
  const p = picks(draft, data);
  const { species, choices } = p;
  if (!species) return ['Choose a species.'];
  const errors: string[] = [];
  if (choices.lineages.length && !p.lineage) errors.push(`Choose a ${choices.lineageNoun}.`);
  if (choices.lineageNeedsAbility && !(draft.lineageAbility && MENTAL_ABILITIES.includes(draft.lineageAbility))) {
    errors.push(`Choose the spellcasting ability for your ${choices.lineageNoun} (Intelligence, Wisdom or Charisma).`);
  }
  if (choices.sizes.length > 1 && !(draft.size && choices.sizes.includes(draft.size))) errors.push('Choose your size.');
  errors.push(...validateSpeciesSkill(draft, data));
  if (choices.originFeat) {
    const feat = data.feats.find((f) => f.id === draft.speciesFeat);
    if (!feat) errors.push(`Choose an Origin feat for ${choices.originFeat.trait}.`);
    else if (isMagicInitiate(feat.name)) {
      if (!draft.speciesFeatList) errors.push('Choose a spell list for Magic Initiate.');
      const fromBackground = originFeats(draft, data).find((f) => f.from === 'background' && isMagicInitiate(f.name));
      if (fromBackground?.option && fromBackground.option === draft.speciesFeatList) {
        errors.push(`You already have Magic Initiate (${fromBackground.option}); choose a different spell list.`);
      }
    } else if (!feat.repeatable && originFeats(draft, data).filter((f) => f.feat?.id === feat.id).length > 1) {
      errors.push(`You already have ${feat.name} from your background; choose a different feat.`);
    }
  }
  return errors;
}

function validateEquipment(draft: BuilderDraft, data: BuilderData): string[] {
  const { cls, background } = picks(draft, data);
  const errors: string[] = [];
  // Starting gear comes from the class and background, so the step isn't done before both exist.
  if (!cls) errors.push('Choose a class first: your starting equipment depends on it.');
  if (!background) errors.push('Choose a background first: it adds its own equipment.');
  if (cls?.startingEquipment.length && (draft.classEquipment === null || !cls.startingEquipment[draft.classEquipment])) {
    errors.push('Choose your class starting equipment (or the gold).');
  }
  if (background?.equipment.length && (draft.backgroundEquipment === null || !background.equipment[draft.backgroundEquipment])) {
    errors.push('Choose your background equipment (or the gold).');
  }
  const { count } = masteryPlan(draft, data);
  const chosen = chosenMasteries(draft, data);
  if (count && chosen.length !== count) errors.push(`Choose ${count} weapons for Weapon Mastery (${chosen.length} chosen).`);
  return errors;
}

function validateSpells(draft: BuilderDraft, ctx: BuilderContext): string[] {
  // Without the spell list the player can't choose; the DM can help during the first session.
  if (!ctx.spells.length) return [];
  const plan = spellPlan(draft, ctx.data);
  const errors: string[] = [];
  if (plan.casting) {
    const cantripIds = new Set(classSpellOptions(draft, ctx, 0).map((s) => s.id));
    const levelOneIds = new Set(classSpellOptions(draft, ctx, 1).map((s) => s.id));
    const cantrips = draft.cantrips.filter((id) => cantripIds.has(id));
    if (cantrips.length !== Math.min(plan.cantrips, cantripIds.size)) errors.push(`Choose ${plan.cantrips} cantrips (${cantrips.length} chosen).`);
    if (plan.spellbook) {
      const book = draft.spellbook.filter((id) => levelOneIds.has(id));
      if (book.length !== Math.min(plan.spellbook, levelOneIds.size)) errors.push(`Choose ${plan.spellbook} spells for your spellbook (${book.length} chosen).`);
      const prepared = draft.prepared.filter((id) => book.includes(id));
      if (prepared.length !== Math.min(plan.prepared, book.length)) errors.push(`Prepare ${plan.prepared} spells from your spellbook (${prepared.length} prepared).`);
    } else if (plan.prepared) {
      const prepared = draft.prepared.filter((id) => levelOneIds.has(id));
      if (prepared.length !== Math.min(plan.prepared, levelOneIds.size)) errors.push(`Prepare ${plan.prepared} level 1 spells (${prepared.length} chosen).`);
    }
  }
  for (const { list } of plan.magicInitiate) {
    const choice = draft.magicInitiate[list];
    const cantripIds = new Set(spellsForClass(ctx.spells, list, 0).map((s) => s.id));
    const levelOneIds = new Set(spellsForClass(ctx.spells, list, 1).map((s) => s.id));
    const label = `Magic Initiate (${list})`;
    if (!choice?.ability || !MENTAL_ABILITIES.includes(choice.ability)) {
      errors.push(`${label}: choose Intelligence, Wisdom or Charisma as its spellcasting ability.`);
    }
    const cantrips = (choice?.cantrips ?? []).filter((id) => cantripIds.has(id));
    if (cantrips.length !== Math.min(2, cantripIds.size)) errors.push(`${label}: choose two cantrips.`);
    if (levelOneIds.size && !(choice?.spell && levelOneIds.has(choice.spell))) errors.push(`${label}: choose a level 1 spell.`);
  }
  return errors;
}

/** Everything that blocks a step, as player-facing sentences (empty = done). */
export function validateStep(step: BuilderStep, draft: BuilderDraft, ctx: BuilderContext): string[] {
  const { data } = ctx;
  switch (step) {
    case 'class':
      return validateClass(draft, data);
    case 'background':
      return picks(draft, data).background ? [] : ['Choose a background.'];
    case 'species':
      return validateSpecies(draft, data);
    case 'abilities':
      return validateAbilities(draft, picks(draft, data).background);
    case 'skills':
      return [...validateSkills(draft, data), ...validateLanguages(draft, data)];
    case 'equipment':
      return validateEquipment(draft, data);
    case 'spells':
      return activeSteps(draft, data).includes('spells') ? validateSpells(draft, ctx) : [];
    case 'details':
      return draft.name.trim() ? [] : ['Give your character a name.'];
    case 'review':
      return activeSteps(draft, data)
        .filter((s) => s !== 'review')
        .flatMap((s) => validateStep(s, draft, ctx));
  }
}

/** The first step (in order) that still has problems, or null when the draft is complete. */
export function firstIncompleteStep(draft: BuilderDraft, ctx: BuilderContext): BuilderStep | null {
  return activeSteps(draft, ctx.data).find((s) => s !== 'review' && validateStep(s, draft, ctx).length > 0) ?? null;
}

// ---------------------------------------------------------------------------
// Draft updates that keep later choices consistent
// ---------------------------------------------------------------------------

/** Changing class resets class-dependent picks (skills, gear, masteries, spells). */
export function selectClass(draft: BuilderDraft, classId: string): BuilderDraft {
  if (draft.classId === classId) return draft;
  return {
    ...draft,
    classId,
    fightingStyle: null,
    classOptions: {},
    classSkills: [],
    expertise: [],
    classEquipment: null,
    weaponMasteries: [],
    cantrips: [],
    spellbook: [],
    prepared: [],
  };
}

/** Changing background resets its increases and equipment; class skill overlaps are flagged, not dropped. */
export function selectBackground(draft: BuilderDraft, backgroundId: string): BuilderDraft {
  if (draft.backgroundId === backgroundId) return draft;
  return { ...draft, backgroundId, bonusPlus2: null, bonusPlus1: null, backgroundEquipment: null, magicInitiate: {} };
}

export function selectSpecies(draft: BuilderDraft, speciesId: string): BuilderDraft {
  if (draft.speciesId === speciesId) return draft;
  return {
    ...draft,
    speciesId,
    lineage: null,
    lineageAbility: null,
    size: null,
    speciesSkill: null,
    speciesFeat: null,
    speciesFeatList: null,
    featSkills: [],
  };
}

/** Toggle a value in a list, never exceeding `max` entries (the oldest pick is kept). */
export function toggleInList<T>(list: T[], value: T, max: number): T[] {
  if (list.includes(value)) return list.filter((v) => v !== value);
  if (list.length >= max) return max === 1 ? [value] : list;
  return [...list, value];
}
