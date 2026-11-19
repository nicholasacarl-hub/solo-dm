/**
 * "Let the DM decide": sensible defaults for each builder step, so a player can start fast and
 * still change anything afterwards. `fillStep` keeps valid choices and fills the gaps;
 * `letDmDecide` re-decides a whole step. Randomness comes from the engine's Rng.
 */
import { cryptoRng, rollDice, type Rng } from '@/engine';
import { ABILITIES, SKILLS, SKILL_ABILITY, type Ability, type BuilderData, type OptionSource, type Skill } from '@/types';
import { nameKey } from '@/lib/id';
import {
  POINT_BUY_BUDGET,
  abilityPriority,
  baseScores,
  finalAbilityScores,
  pointBuySpent,
  recommendedAssignment,
  recommendedBonuses,
  rollAbilityScores,
  scorePool,
} from './abilities';
import { classChoiceFeatures, featuresAtLevel, findFeatureDef, needsFightingStyle, recommendedNames } from './classFeatures';
import { findEquipment } from './equipment';
import { DM_BACKSTORY, defaultPortrait, pick, suggestAlignment, suggestName, suggestPersonality } from './flavor';
import {
  activeSteps,
  classSpellOptions,
  grantedSpells,
  chosenFightingStyle,
  fightingStyleChoices,
  masteryPlan,
  offeredFightingStyles,
  selectClass,
  selectSpecies,
  spellPlan,
  validateStep,
  type BuilderContext,
} from './logic';
import { backgroundAbilityPool } from './abilities';
import { filtered, subclassesOf, visibleSpells, withoutReplacedSrd } from './sources';
import {
  MAGIC_INITIATE_LISTS,
  STANDARD_LANGUAGES,
  choosesSubclassAtLevel1,
  classSkillOptions,
  grantedSkills,
  isMagicInitiate,
  languagePlan,
  magicInitiateSources,
  originFeatOptions,
  originFeats,
  picks,
  skillPlan,
  skillProficiencies,
  suggestedLanguages,
} from './origin';
import { findSpellByName, spellsForClass, type SpellInfo } from './spells';
import { STANDARD_ARRAY, emptyDraft, type BuilderDraft, type BuilderStep } from './types';

/** Generally useful skills, most useful first (tie-breaker after the class's ability priority). */
const SKILL_UTILITY: Skill[] = [
  'perception',
  'stealth',
  'insight',
  'athletics',
  'persuasion',
  'arcana',
  'survival',
  'investigation',
  'acrobatics',
  'medicine',
  'religion',
  'intimidation',
  'deception',
  'nature',
  'history',
  'sleight-of-hand',
  'animal-handling',
  'performance',
];

const SPECIES_LANGUAGE: Record<string, string> = {
  dragonborn: 'Draconic',
  dwarf: 'Dwarvish',
  elf: 'Elvish',
  gnome: 'Gnomish',
  goliath: 'Giant',
  halfling: 'Halfling',
  orc: 'Orc',
};

function rankSkills(candidates: Skill[], priority: Ability[]): Skill[] {
  const score = (s: Skill) => priority.indexOf(SKILL_ABILITY[s]) * 100 + SKILL_UTILITY.indexOf(s);
  return [...candidates].sort((a, b) => score(a) - score(b));
}

function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * `kept`, then the best of `ranked` up to `count`: never two with the same key (the item itself by default),
 * nor one whose key is `taken` (chosen elsewhere).
 */
function topUp<T>(kept: T[], ranked: T[], count: number, key: (item: T) => unknown = (item) => item, taken: ReadonlySet<unknown> = new Set()): T[] {
  const out = kept.slice(0, count);
  const seen = new Set([...taken, ...out.map(key)]);
  for (const item of ranked) {
    if (out.length >= count) break;
    if (!seen.has(key(item))) {
      out.push(item);
      seen.add(key(item));
    }
  }
  return out;
}

/** "Defense is recommended." -> "Defense". */
function recommendedPlain(description: string): string | undefined {
  return /([A-Z][\w' -]*?) is recommended/.exec(description)?.[1];
}

// ---------------------------------------------------------------------------
// Per-step fillers (keep what's valid, fill the rest)
// ---------------------------------------------------------------------------

/**
 * The options of a list as its step shows them (autofill picks only among those): the source filter's ("All"
 * without the SRD options a 2024 book's stand in for), and `keep`, the current choice, whatever the filter. A
 * filter that leaves none `usable` falls back to "All", as the Magic Initiate lists do, so the hero ends up complete.
 */
function shown<T extends { id: string; name: string; source?: OptionSource }>(
  list: readonly T[],
  draft: BuilderDraft,
  keep?: string | null,
  usable: (option: T) => boolean = () => true,
): T[] {
  const mine = filtered(list, draft.sourceFilter, keep).filter(usable);
  return mine.length || !draft.sourceFilter ? mine : filtered(list, null, keep).filter(usable);
}

function fillClass(draft: BuilderDraft, data: BuilderData, rng: Rng): BuilderDraft {
  const classes = shown(data.classes, draft);
  const cls = picks(draft, data).cls ?? (classes.length ? pick(classes, rng) : undefined);
  if (!cls) return draft;
  const next = selectClass(draft, cls.id);
  let fightingStyle = next.fightingStyle;
  if (needsFightingStyle(cls) && !chosenFightingStyle(fightingStyleChoices(cls, data), fightingStyle)) {
    const offered = offeredFightingStyles(cls, data, draft.sourceFilter);
    const styles = offered.length ? offered : offeredFightingStyles(cls, data, null);
    const recommended = recommendedPlain(findFeatureDef(cls, 'Fighting Style')?.description ?? '');
    fightingStyle = (styles.find((f) => recommended && nameKey(f.name) === nameKey(recommended)) ?? styles[0])?.id ?? null;
  }
  const classOptions = { ...next.classOptions };
  for (const { feature, options } of classChoiceFeatures(cls)) {
    if (!options.some((o) => o.name === classOptions[feature.name])) classOptions[feature.name] = pick(options, rng).name;
  }
  const subclassId =
    choosesSubclassAtLevel1(cls) && !subclassesOf(cls).some((s) => s.id === next.subclassId) ? pick(withoutReplacedSrd(subclassesOf(cls)), rng).id : next.subclassId;
  return { ...next, fightingStyle, classOptions, subclassId };
}

/** A background that lets the player choose: an Origin feat (and a Magic Initiate list) when it grants none. */
function fillBackgroundFeat(draft: BuilderDraft, data: BuilderData, rng: Rng): BuilderDraft {
  const { background } = picks(draft, data);
  if (!background?.featChoice) return draft;
  const options = shown(originFeatOptions(data), draft, draft.backgroundFeat);
  const current = options.find((f) => f.id === draft.backgroundFeat);
  const feat = current ?? (options.length ? pick(options, rng) : undefined);
  if (!feat) return draft;
  const list = isMagicInitiate(feat.name) ? (draft.backgroundFeatList ?? pick(MAGIC_INITIATE_LISTS, rng)) : null;
  return { ...draft, backgroundFeat: feat.id, backgroundFeatList: list };
}

function fillBackground(draft: BuilderDraft, data: BuilderData, rng: Rng): BuilderDraft {
  const { cls } = picks(draft, data);
  let next = draft;
  const backgrounds = shown(data.backgrounds, draft);
  if (!picks(draft, data).background && backgrounds.length) {
    const priority = abilityPriority(cls);
    // "Any three" backgrounds fit as well as the class's three best abilities.
    const abilitiesOf = (b: (typeof backgrounds)[number]) => (b.abilityChoice === 'any' ? priority.slice(0, 3) : b.abilityScores);
    const fit = (abilities: Ability[]) => abilities.reduce((sum, a) => sum + (ABILITIES.length - priority.indexOf(a)), 0);
    const best = Math.max(...backgrounds.map((b) => fit(abilitiesOf(b))));
    const background = pick(
      backgrounds.filter((b) => fit(abilitiesOf(b)) === best),
      rng,
    );
    next = { ...draft, backgroundId: background.id, bonusPlus2: null, bonusPlus1: null, backgroundAbilities: [], backgroundFeat: null, backgroundFeatList: null, backgroundEquipment: null };
  }
  return fillBackgroundFeat(next, data, rng);
}

function fillSpecies(draft: BuilderDraft, data: BuilderData, rng: Rng): BuilderDraft {
  let next = draft;
  const species = shown(data.species, draft);
  if (!picks(next, data).species && species.length) next = selectSpecies(next, pick(species, rng).id);
  const p = picks(next, data);
  const { choices, cls } = p;
  if (!p.species) return next;
  const patch: Partial<BuilderDraft> = {};
  if (choices.lineages.length && !p.lineage) patch.lineage = pick(choices.lineages, rng).name;
  if (choices.lineageNeedsAbility && !next.lineageAbility) {
    const classAbility = cls?.spellcastingAbility;
    const mental: Ability[] = ['int', 'wis', 'cha'];
    patch.lineageAbility =
      classAbility && mental.includes(classAbility) ? classAbility : abilityPriority(cls).find((a) => mental.includes(a)) ?? 'wis';
  }
  if (choices.sizes.length > 1 && !(next.size && choices.sizes.includes(next.size))) {
    patch.size = choices.sizes.includes('Medium') ? 'Medium' : choices.sizes[0];
  }
  const plan = skillPlan(next, data);
  if (plan.speciesChoice) {
    const granted = grantedSkills(plan);
    const valid = next.speciesSkill && plan.speciesChoice.from.includes(next.speciesSkill) && !granted.has(next.speciesSkill);
    if (!valid) {
      const options = plan.speciesChoice.from.filter((s) => !granted.has(s));
      patch.speciesSkill = rankSkills(options, abilityPriority(cls))[0] ?? null;
    }
  }
  if (choices.originFeat) {
    // By name: the background's feat of any book is the same feat.
    const taken = new Set(originFeats(next, data).filter((f) => f.from === 'background').flatMap((f) => (f.feat ? [nameKey(f.feat.name)] : [])));
    const options = shown(originFeatOptions(data), next, next.speciesFeat, (f) => f.repeatable || !taken.has(nameKey(f.name)));
    const current = options.find((f) => f.id === next.speciesFeat);
    const recommended = recommendedPlain(p.species.traits.find((t) => t.name === choices.originFeat?.trait)?.description ?? '');
    const feat = current ?? options.find((f) => recommended && nameKey(f.name) === nameKey(recommended)) ?? options[0];
    if (feat) {
      patch.speciesFeat = feat.id;
      if (isMagicInitiate(feat.name) && !next.speciesFeatList) {
        const used = originFeats(next, data).filter((f) => f.from === 'background').map((f) => f.option);
        patch.speciesFeatList = MAGIC_INITIATE_LISTS.find((l) => !used.includes(l)) ?? 'Wizard';
      }
    }
  }
  return { ...next, ...patch };
}

function fillAbilities(draft: BuilderDraft, data: BuilderData, rng: Rng): BuilderDraft {
  const { cls, background } = picks(draft, data);
  let next = draft;
  if (next.abilityMethod === 'point-buy') {
    const spent = pointBuySpent(next.pointBuy);
    if (spent === null || spent === 0 || spent > POINT_BUY_BUDGET) {
      // The standard array is also a legal 27-point buy.
      const assignment = recommendedAssignment(cls, [...STANDARD_ARRAY]);
      const pointBuy = { ...next.pointBuy };
      for (const a of ABILITIES) pointBuy[a] = STANDARD_ARRAY[assignment[a] ?? STANDARD_ARRAY.length - 1];
      next = { ...next, pointBuy };
    }
  } else if (!baseScores(next).complete) {
    if (next.abilityMethod === 'roll') {
      const rolls = next.rolls?.length === ABILITIES.length ? next.rolls : rollAbilityScores((e) => rollDice(e, { rng }));
      next = { ...next, rolls, assignment: recommendedAssignment(cls, rolls.map((r) => r.total)) };
    } else {
      next = { ...next, assignment: recommendedAssignment(cls, scorePool(next)) };
    }
  }
  const pool = backgroundAbilityPool(background);
  const anyThreeValid = background?.abilityChoice !== 'any' || new Set(next.backgroundAbilities.filter((a) => ABILITIES.includes(a))).size === 3;
  const bonusValid =
    (next.bonusMode === 'one-one-one' && anyThreeValid) ||
    (background &&
      next.bonusPlus2 &&
      next.bonusPlus1 &&
      next.bonusPlus2 !== next.bonusPlus1 &&
      pool.includes(next.bonusPlus2) &&
      pool.includes(next.bonusPlus1));
  if (!bonusValid) next = { ...next, ...recommendedBonuses(cls, background) };
  return next;
}

function fillSkills(draft: BuilderDraft, data: BuilderData, rng: Rng): BuilderDraft {
  const p = picks(draft, data);
  const priority = abilityPriority(p.cls);
  const plan = skillPlan(draft, data);
  const taken = grantedSkills(plan);
  if (draft.speciesSkill) taken.add(draft.speciesSkill);

  const { options, replacements } = classSkillOptions(draft, plan);
  const validClass = draft.classSkills.filter((s) => !taken.has(s) && (options.includes(s) || replacements > 0));
  const extra = replacements > 0 ? SKILLS.filter((s) => !taken.has(s) && !options.includes(s)) : [];
  const classSkills = topUp(validClass, [...rankSkills(options, priority), ...rankSkills(extra, priority)], plan.classChoice.count);

  const afterClass = new Set([...taken, ...classSkills]);
  const validFeat = draft.featSkills.filter((s) => !afterClass.has(s));
  const featSkills = topUp(
    validFeat,
    rankSkills(SKILLS.filter((s) => !afterClass.has(s)), priority),
    plan.featChoice,
  );

  const proficient = Object.keys(skillProficiencies({ ...draft, classSkills, featSkills, expertise: [] }, data)) as Skill[];
  const expertisePreference: Skill[] = ['stealth', 'sleight-of-hand', 'perception', ...rankSkills(proficient, priority)];
  const expertise = topUp(
    draft.expertise.filter((s) => proficient.includes(s)),
    expertisePreference.filter((s) => proficient.includes(s)),
    plan.expertise,
  );

  const langs = languagePlan(draft, data);
  const required = langs.standard + langs.any;
  const keptLangs = draft.languages.filter((l) => !langs.fixed.includes(l));
  const speciesLang = p.species?.source ? undefined : SPECIES_LANGUAGE[nameKey(p.species?.name ?? '').split('-')[0]];
  // Languages an older species or background prints come first (§5.6: suggested for the two picks).
  const pool = [...suggestedLanguages(draft, data).languages, speciesLang, ...shuffle(STANDARD_LANGUAGES, rng)].filter(
    (l): l is string => l !== undefined && !langs.fixed.includes(l),
  );
  const languages = topUp(keptLangs, pool, required);

  return { ...draft, classSkills, featSkills, expertise, languages };
}

function fillEquipment(draft: BuilderDraft, data: BuilderData): BuilderDraft {
  const { cls, background } = picks(draft, data);
  const classEquipment =
    draft.classEquipment !== null && cls?.startingEquipment[draft.classEquipment] ? draft.classEquipment : cls?.startingEquipment.length ? 0 : null;
  const backgroundEquipment =
    draft.backgroundEquipment !== null && background?.equipment[draft.backgroundEquipment]
      ? draft.backgroundEquipment
      : background?.equipment.length
        ? 0
        : null;
  const next = { ...draft, classEquipment, backgroundEquipment };
  const plan = masteryPlan(next, data);
  if (!plan.count) return { ...next, weaponMasteries: [] };
  // The source filter narrows the picks too (a filter on the SRD never picks a book's weapon); a filter
  // that would leave too few falls back to every candidate.
  const shownCandidates = shown(plan.candidates, next);
  const candidates = shownCandidates.length >= plan.count ? shownCandidates : plan.candidates;
  const count = plan.count;
  const packed = new Set(
    [cls?.startingEquipment[classEquipment ?? -1], background?.equipment[backgroundEquipment ?? -1]]
      .flatMap((pkg) => pkg?.items ?? [])
      .map((i) => findEquipment(i.name, data.equipment)?.option.id)
      .filter(Boolean),
  );
  const dieSize = (damage = '') => Number(/d(\d+)/.exec(damage)?.[1] ?? 0) * Number(/^(\d+)d/.exec(damage)?.[1] ?? 1);
  const ranked = [...candidates].sort((a, b) => Number(packed.has(b.id)) - Number(packed.has(a.id)) || dieSize(b.damage) - dieSize(a.damage));
  const candidateNames = candidates.map((c) => c.name);
  const kept = next.weaponMasteries.filter((m) => candidateNames.includes(m));
  return { ...next, weaponMasteries: topUp(kept, ranked.map((c) => c.name), count) };
}

/** The spells the class's level 1 features recommend ("Light and Sacred Flame are recommended"), as `options` lists them. */
function recommendedSpells(draft: BuilderDraft, ctx: BuilderContext, options: SpellInfo[]): string[] {
  const { cls } = picks(draft, ctx.data);
  const names = cls ? featuresAtLevel(cls, 1).flatMap((f) => recommendedNames(f.description)).flat() : [];
  return names.map((n) => findSpellByName(options, n)?.id).filter((id): id is string => Boolean(id));
}

function fillSpells(draft: BuilderDraft, ctx: BuilderContext, rng: Rng): BuilderDraft {
  if (!ctx.spells.length) return draft;
  const plan = spellPlan(draft, ctx.data);
  const byId = new Map(ctx.spells.map((s) => [s.id, s]));
  // One spell per name: a book's spell and the SRD's of the same name are one choice.
  const nameOf = (id: string) => nameKey(byId.get(id)?.name ?? id);
  let next = draft;
  // Spells the hero already has, by name, from Magic Initiate or granted by the class or species: the class
  // lists don't take them again.
  const granted = new Set(grantedSpells(draft, ctx.data).keys());
  const initiateNames = new Set([
    ...magicInitiateSources(draft, ctx.data)
      .flatMap(({ list }) => [...(draft.magicInitiate[list]?.cantrips ?? []), ...(draft.magicInitiate[list]?.spell ? [draft.magicInitiate[list]?.spell as string] : [])])
      .map(nameOf),
    ...granted,
  ]);
  if (plan.casting) {
    // As the step lists them (spells already chosen stay); a filter that leaves too few names falls back to "All",
    // as Magic Initiate's lists do, so the hero ends up complete.
    const chosen = new Set([...draft.cantrips, ...draft.spellbook, ...draft.prepared]);
    const options = (level: 0 | 1, need: number) => {
      const all = classSpellOptions(draft, ctx, level);
      const mine = visibleSpells(all, draft.sourceFilter, chosen);
      const free = new Set(mine.map((s) => nameKey(s.name)).filter((key) => !initiateNames.has(key)));
      return free.size >= need || !draft.sourceFilter ? mine : visibleSpells(all, null, chosen);
    };
    const cantripOptions = options(0, plan.cantrips);
    const levelOneOptions = options(1, plan.spellbook || plan.prepared);
    const cantripIds = cantripOptions.map((s) => s.id);
    const levelOneIds = levelOneOptions.map((s) => s.id);
    // Valid picks stay, but not one the hero has since been granted (a species chosen after the spells).
    const keeps = (ids: string[], options: string[]) => ids.filter((id) => options.includes(id) && !granted.has(nameOf(id)));
    // At most as many as the list has names (topUp skips the ones the hero already has).
    const countOf = (ids: string[]) => new Set(ids.map(nameOf)).size;
    const cantrips = topUp(
      keeps(draft.cantrips, cantripIds),
      [...recommendedSpells(draft, ctx, cantripOptions), ...shuffle(cantripIds, rng)],
      Math.min(plan.cantrips, countOf(cantripIds)),
      nameOf,
      initiateNames,
    );
    const rankedLevelOne = [...recommendedSpells(draft, ctx, levelOneOptions), ...shuffle(levelOneIds, rng)];
    const levelOneCount = countOf(levelOneIds);
    if (plan.spellbook) {
      const spellbook = topUp(keeps(draft.spellbook, levelOneIds), rankedLevelOne, Math.min(plan.spellbook, levelOneCount), nameOf, initiateNames);
      const prepared = topUp(draft.prepared.filter((id) => spellbook.includes(id)), spellbook, Math.min(plan.prepared, spellbook.length));
      next = { ...next, cantrips, spellbook, prepared };
    } else {
      const prepared = topUp(keeps(draft.prepared, levelOneIds), rankedLevelOne, Math.min(plan.prepared, levelOneCount), nameOf, initiateNames);
      next = { ...next, cantrips, prepared };
    }
  }
  const scores = finalAbilityScores(next, picks(next, ctx.data).background);
  const magicInitiate = { ...next.magicInitiate };
  // Don't spend Magic Initiate picks on spells the character already knows or is granted (by name, of any book).
  const known = new Set([...[...next.cantrips, ...next.spellbook, ...next.prepared].map(nameOf), ...granted]);
  for (const { list } of magicInitiateSources(next, ctx.data)) {
    const current = magicInitiate[list];
    const keep = new Set([...(current?.cantrips ?? []), ...(current?.spell ? [current.spell] : [])]);
    // As the step lists them (the source filter's); a filter that leaves too few falls back to "All". A spell the
    // hero knows otherwise is left out, a current pick too (it was made before that list changed).
    const listed = (level: 0 | 1, need: number, own: (id: string) => boolean = () => false) => {
      const free = (filter: string | null) =>
        visibleSpells(spellsForClass(ctx.spells, list, level), filter, keep)
          .map((s) => s.id)
          .filter((id) => !known.has(nameOf(id)) || own(id));
      const shownIds = free(next.sourceFilter);
      return new Set(shownIds.map(nameOf)).size >= need ? shownIds : free(null);
    };
    // The level 1 spell may be a granted one (it adds a free casting).
    const cantripIds = listed(0, 2);
    const levelOneIds = listed(1, 1, (id) => current?.spell === id && granted.has(nameOf(id)));
    const mental: Ability[] = ['int', 'wis', 'cha'];
    const ability = current?.ability && mental.includes(current.ability) ? current.ability : [...mental].sort((a, b) => scores[b] - scores[a])[0];
    const cantrips = topUp((current?.cantrips ?? []).filter((id) => cantripIds.includes(id)), shuffle(cantripIds, rng), Math.min(2, new Set(cantripIds.map(nameOf)).size), nameOf);
    const spell = current?.spell && levelOneIds.includes(current.spell) ? current.spell : (shuffle(levelOneIds, rng)[0] ?? null);
    magicInitiate[list] = { ability, cantrips, spell };
    cantrips.forEach((id) => known.add(nameOf(id)));
    if (spell) known.add(nameOf(spell));
  }
  return { ...next, magicInitiate };
}

function fillDetails(draft: BuilderDraft, data: BuilderData, rng: Rng): BuilderDraft {
  const { species } = picks(draft, data);
  const suggestion = suggestPersonality(rng);
  return {
    ...draft,
    name: draft.name.trim() ? draft.name : suggestName(species?.name, rng),
    alignment: draft.alignment || suggestAlignment(rng),
    portrait: draft.portrait || defaultPortrait(species?.name),
    personality: {
      ...draft.personality,
      traits: draft.personality.traits?.trim() || suggestion.traits,
      ideals: draft.personality.ideals?.trim() || suggestion.ideals,
      bonds: draft.personality.bonds?.trim() || suggestion.bonds,
      flaws: draft.personality.flaws?.trim() || suggestion.flaws,
      backstory: draft.personality.backstory?.trim() || DM_BACKSTORY,
    },
  };
}

/** Fill the gaps in one step, keeping choices that are still valid. */
export function fillStep(step: BuilderStep, draft: BuilderDraft, ctx: BuilderContext, rng: Rng = cryptoRng): BuilderDraft {
  switch (step) {
    case 'class':
      return fillClass(draft, ctx.data, rng);
    case 'background':
      return fillBackground(draft, ctx.data, rng);
    case 'species':
      return fillSpecies(draft, ctx.data, rng);
    case 'abilities':
      return fillAbilities(draft, ctx.data, rng);
    case 'skills':
      return fillSkills(draft, ctx.data, rng);
    case 'equipment':
      return fillEquipment(draft, ctx.data);
    case 'spells':
      return fillSpells(draft, ctx, rng);
    case 'details':
      return fillDetails(draft, ctx.data, rng);
    case 'review':
      return draft;
  }
}

/** Forget a step's choices so the DM can decide them afresh. Details keep what the player typed. */
export function clearStep(step: BuilderStep, draft: BuilderDraft): BuilderDraft {
  const blank = emptyDraft();
  switch (step) {
    case 'class':
      return { ...selectClass(draft, ''), classId: null };
    case 'background':
      return {
        ...draft,
        backgroundId: null,
        bonusPlus2: null,
        bonusPlus1: null,
        backgroundAbilities: [],
        backgroundFeat: null,
        backgroundFeatList: null,
        backgroundEquipment: null,
        magicInitiate: {},
      };
    case 'species':
      return { ...selectSpecies(draft, ''), speciesId: null };
    case 'abilities':
      return { ...draft, assignment: {}, pointBuy: blank.pointBuy, bonusMode: 'two-one', bonusPlus2: null, bonusPlus1: null, backgroundAbilities: [] };
    case 'skills':
      return { ...draft, classSkills: [], featSkills: [], expertise: [], languages: [] };
    case 'equipment':
      return { ...draft, classEquipment: null, backgroundEquipment: null, weaponMasteries: [] };
    case 'spells':
      return { ...draft, cantrips: [], spellbook: [], prepared: [], magicInitiate: {} };
    case 'details':
    case 'review':
      return draft;
  }
}

/** The per-step "Let the DM decide" button. */
export function letDmDecide(step: BuilderStep, draft: BuilderDraft, ctx: BuilderContext, rng: Rng = cryptoRng): BuilderDraft {
  return fillStep(step, clearStep(step, draft), ctx, rng);
}

/** "Let the DM build it": fill every incomplete step in order (keeping the player's choices) and go to Review. */
export function letDmBuildAll(draft: BuilderDraft, ctx: BuilderContext, rng: Rng = cryptoRng): BuilderDraft {
  let next = draft;
  for (const step of ['class', 'background', 'species', 'abilities', 'skills', 'equipment', 'spells', 'details'] as const) {
    if (!activeSteps(next, ctx.data).includes(step)) continue;
    if (validateStep(step, next, ctx).length || step === 'details') next = fillStep(step, next, ctx, rng);
  }
  return { ...next, step: 'review' };
}
