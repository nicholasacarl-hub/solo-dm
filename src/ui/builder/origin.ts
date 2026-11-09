/**
 * Origin choices: Origin feats (background + Human Versatile), skill proficiencies from every
 * source, and languages (SRD 5.2.1 "Step 2: Character Origin").
 */
import {
  SKILLS,
  SKILL_NAMES,
  type BackgroundOption,
  type BuilderData,
  type ClassOption,
  type FeatOption,
  type ProficiencyLevel,
  type Skill,
  type SpeciesOption,
  type SubclassOption,
} from '@/types';
import { findFeat as findFeatOption } from '@/data/options/resolve';
import { nameKey } from '@/lib/id';
import { classLanguages, expertiseCount } from './classFeatures';
import { fixedSpeciesSkills, speciesChoices, type LineageOption, type SpeciesChoices } from './species';
import type { BuilderDraft } from './types';

export interface Picks {
  cls?: ClassOption;
  /** The subclass of a class that chooses it at level 1. */
  subclass?: SubclassOption;
  background?: BackgroundOption;
  species?: SpeciesOption;
  lineage?: LineageOption;
  choices: SpeciesChoices;
}

/** Does the class choose its subclass at level 1 (some older imported classes)? */
export function choosesSubclassAtLevel1(cls: ClassOption | undefined): boolean {
  return Boolean(cls && cls.subclassLevel === 1 && cls.subclasses.length);
}

export function picks(draft: BuilderDraft, data: BuilderData): Picks {
  const species = data.species.find((s) => s.id === draft.speciesId);
  const choices = speciesChoices(species);
  const cls = data.classes.find((c) => c.id === draft.classId);
  const subclass = choosesSubclassAtLevel1(cls) ? cls?.subclasses.find((s) => s.id === draft.subclassId) : undefined;
  return {
    cls,
    ...(subclass ? { subclass } : {}),
    background: data.backgrounds.find((b) => b.id === draft.backgroundId),
    species,
    lineage: choices.lineages.find((l) => l.name === draft.lineage),
    choices,
  };
}

// ---------------------------------------------------------------------------
// Feats
// ---------------------------------------------------------------------------

export const MAGIC_INITIATE_LISTS = ['Cleric', 'Druid', 'Wizard'] as const;

/** "Magic Initiate (Cleric)" -> { base: "Magic Initiate", option: "Cleric" }. */
export function splitFeatName(name: string): { base: string; option: string | null } {
  const match = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(name);
  return match ? { base: match[1].trim(), option: match[2].trim() } : { base: name.trim(), option: null };
}

/** Exact name, then the name before "(…)"; the given book's feat first, then the SRD's, then other books'. */
export function findFeat(feats: readonly FeatOption[], name: string, preferSourceId?: string): FeatOption | undefined {
  return findFeatOption(feats, name, preferSourceId);
}

export function isMagicInitiate(name: string): boolean {
  return /^magic initiate\b/i.test(name.trim());
}

export function originFeatOptions(data: BuilderData): FeatOption[] {
  return data.feats.filter((f) => f.category === 'origin');
}

export interface OriginFeat {
  /** Display name, e.g. "Magic Initiate (Cleric)". */
  name: string;
  feat?: FeatOption;
  /** Where it comes from: "Sage (Origin feat)", "Human (Versatile)". */
  source: string;
  /** Parenthetical option such as the Magic Initiate spell list. */
  option: string | null;
  from: 'background' | 'species';
}

export function originFeats(draft: BuilderDraft, data: BuilderData): OriginFeat[] {
  const { background, species, choices } = picks(draft, data);
  const out: OriginFeat[] = [];
  if (background?.featChoice) {
    // Older backgrounds grant no feat: the player picks an Origin feat (§5.6 background-feat-choice).
    const feat = data.feats.find((f) => f.id === draft.backgroundFeat);
    if (feat) {
      const list = isMagicInitiate(feat.name) ? draft.backgroundFeatList : null;
      out.push({ name: list ? `${feat.name} (${list})` : feat.name, feat, source: `${background.name} (Origin feat)`, option: list, from: 'background' });
    }
  } else if (background?.feat) {
    out.push({
      name: background.feat,
      feat: findFeat(data.feats, background.feat, background.source?.sourceId),
      source: `${background.name} (Origin feat)`,
      option: splitFeatName(background.feat).option,
      from: 'background',
    });
  }
  if (species && choices.originFeat && draft.speciesFeat) {
    const feat = data.feats.find((f) => f.id === draft.speciesFeat);
    if (feat) {
      const list = isMagicInitiate(feat.name) ? draft.speciesFeatList : null;
      out.push({
        name: list ? `${feat.name} (${list})` : feat.name,
        feat,
        source: `${species.name} (${choices.originFeat.trait})`,
        option: list,
        from: 'species',
      });
    }
  }
  return out;
}

/** Magic Initiate spell lists the character gets to pick from, with their source. */
export function magicInitiateSources(draft: BuilderDraft, data: BuilderData): { list: string; source: string }[] {
  return originFeats(draft, data)
    .filter((f) => isMagicInitiate(f.name) && f.option)
    .map((f) => ({ list: f.option as string, source: f.source }));
}

/** Skill picks granted by Skilled-style feats ("proficiency in any combination of three skills"). */
export function featSkillCount(draft: BuilderDraft, data: BuilderData): number {
  return originFeats(draft, data).reduce((n, f) => {
    const text = f.feat?.description ?? '';
    const match = /proficiency in any combination of (\w+) skills/i.exec(text);
    if (match) return n + (({ one: 1, two: 2, three: 3, four: 4 } as Record<string, number>)[match[1].toLowerCase()] ?? 3);
    return n + (nameKey(f.name) === 'skilled' ? 3 : 0);
  }, 0);
}

/** Alert-style feats add the Proficiency Bonus to Initiative. */
export function grantsInitiativeProficiency(feat: OriginFeat): boolean {
  return nameKey(splitFeatName(feat.name).base) === 'alert' || /add your Proficiency Bonus to the roll/i.test(feat.feat?.description ?? '');
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export interface SkillPlan {
  background: Skill[];
  /** Fixed skills from species traits. */
  species: Skill[];
  classChoice: { count: number; from: Skill[] };
  /** A species skill choice (Skillful / Keen Senses). */
  speciesChoice: { from: Skill[]; trait: string } | null;
  featChoice: number;
  expertise: number;
}

export function skillPlan(draft: BuilderDraft, data: BuilderData): SkillPlan {
  const { cls, background, species, choices } = picks(draft, data);
  const from = cls?.skillChoices.from.length ? cls.skillChoices.from : [...SKILLS];
  return {
    background: background?.skills ?? [],
    species: fixedSpeciesSkills(species),
    classChoice: { count: cls?.skillChoices.count ?? 0, from },
    speciesChoice: choices.skill
      ? { from: choices.skill.from === 'any' ? [...SKILLS] : choices.skill.from, trait: choices.skill.trait }
      : null,
    featChoice: featSkillCount(draft, data),
    expertise: expertiseCount(cls),
  };
}

/** Skills granted without a choice (background + fixed species skills). */
export function grantedSkills(plan: SkillPlan): Set<Skill> {
  return new Set([...plan.background, ...plan.species]);
}

/** Class-list skills still open, and how many picks may come from outside the list as replacements. */
export function classSkillOptions(draft: BuilderDraft, plan: SkillPlan): { options: Skill[]; replacements: number } {
  const taken = grantedSkills(plan);
  if (draft.speciesSkill) taken.add(draft.speciesSkill);
  const options = plan.classChoice.from.filter((s) => !taken.has(s));
  return { options, replacements: Math.max(0, plan.classChoice.count - options.length) };
}

/** Every skill the draft is proficient in (expertise = 2). */
export function skillProficiencies(draft: BuilderDraft, data: BuilderData): Partial<Record<Skill, ProficiencyLevel>> {
  const plan = skillPlan(draft, data);
  const out: Partial<Record<Skill, ProficiencyLevel>> = {};
  const add = (s: Skill | null) => {
    if (s) out[s] = 1;
  };
  [...plan.background, ...plan.species, draft.speciesSkill, ...draft.classSkills, ...draft.featSkills].forEach(add);
  for (const s of draft.expertise) if (out[s]) out[s] = 2;
  return out;
}

function skillName(s: Skill): string {
  return SKILL_NAMES[s];
}

/** The species skill must not duplicate a background/species skill. */
export function validateSpeciesSkill(draft: BuilderDraft, data: BuilderData): string[] {
  const plan = skillPlan(draft, data);
  if (!plan.speciesChoice) return [];
  if (!draft.speciesSkill) return [`Choose a skill for ${plan.speciesChoice.trait}.`];
  if (!plan.speciesChoice.from.includes(draft.speciesSkill)) return [`${skillName(draft.speciesSkill)} isn't an option for ${plan.speciesChoice.trait}.`];
  if (grantedSkills(plan).has(draft.speciesSkill)) {
    return [`${skillName(draft.speciesSkill)} is already granted by your background — choose another skill for ${plan.speciesChoice.trait}.`];
  }
  return [];
}

export function validateSkills(draft: BuilderDraft, data: BuilderData): string[] {
  const plan = skillPlan(draft, data);
  const errors: string[] = [];
  const taken = grantedSkills(plan);
  if (draft.speciesSkill) taken.add(draft.speciesSkill);

  for (const s of draft.classSkills) {
    if (taken.has(s)) errors.push(`${skillName(s)} is already granted by your origin — choose a replacement.`);
  }
  if (new Set(draft.classSkills).size !== draft.classSkills.length) errors.push('Each class skill can be picked only once.');
  const { replacements } = classSkillOptions(draft, plan);
  const outside = draft.classSkills.filter((s) => !plan.classChoice.from.includes(s));
  if (outside.length > replacements) {
    errors.push(`${outside.map(skillName).join(', ')} ${outside.length > 1 ? "aren't" : "isn't"} on your class skill list.`);
  }
  if (draft.classSkills.length !== plan.classChoice.count) {
    errors.push(`Choose ${plan.classChoice.count} class skills (${draft.classSkills.length} chosen).`);
  }

  if (plan.featChoice) {
    const before = new Set([...taken, ...draft.classSkills]);
    const dupes = draft.featSkills.filter((s) => before.has(s));
    if (dupes.length) errors.push(`${dupes.map(skillName).join(', ')} you already have — pick different feat skills.`);
    if (draft.featSkills.length !== plan.featChoice) errors.push(`Choose ${plan.featChoice} skills for your feat (${draft.featSkills.length} chosen).`);
  }

  if (plan.expertise) {
    const proficient = skillProficiencies({ ...draft, expertise: [] }, data);
    const invalid = draft.expertise.filter((s) => !proficient[s]);
    if (invalid.length) errors.push(`Expertise needs a skill you're proficient in (${invalid.map(skillName).join(', ')}).`);
    if (draft.expertise.length !== plan.expertise) errors.push(`Choose ${plan.expertise} skills for Expertise (${draft.expertise.length} chosen).`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Languages (SRD 5.2.1: Common plus two from the Standard Languages table)
// ---------------------------------------------------------------------------

export const STANDARD_LANGUAGES = [
  'Common Sign Language',
  'Draconic',
  'Dwarvish',
  'Elvish',
  'Giant',
  'Gnomish',
  'Goblin',
  'Halfling',
  'Orc',
] as const;

export const RARE_LANGUAGES = [
  'Abyssal',
  'Celestial',
  'Deep Speech',
  'Druidic',
  'Infernal',
  'Primordial',
  'Sylvan',
  "Thieves' Cant",
  'Undercommon',
] as const;

export interface LanguagePlan {
  /** Known automatically: Common plus class languages (Thieves' Cant, Druidic). */
  fixed: string[];
  /** Picks from the standard table. */
  standard: number;
  /** Extra picks from any table (e.g. the Rogue's Thieves' Cant feature). */
  any: number;
}

export function languagePlan(draft: BuilderDraft, data: BuilderData): LanguagePlan {
  const { cls } = picks(draft, data);
  const fromClass = classLanguages(cls);
  return { fixed: ['Common', ...fromClass.fixed], standard: 2, any: fromClass.extraChoices };
}

/**
 * Standard languages an older species or background prints (§5.6: suggested for the two picks, never added):
 * the ones the player hasn't already got.
 */
export function suggestedLanguages(draft: BuilderDraft, data: BuilderData): { languages: string[]; from: string[] } {
  const { background, species } = picks(draft, data);
  const standard = new Set<string>(STANDARD_LANGUAGES);
  const fixed = languagePlan(draft, data).fixed;
  const languages: string[] = [];
  const from: string[] = [];
  for (const option of [species, background]) {
    const printed = (option?.languages ?? []).filter((l) => standard.has(l) && !fixed.includes(l));
    if (!option || !printed.length) continue;
    from.push(option.name);
    for (const l of printed) if (!languages.includes(l)) languages.push(l);
  }
  return { languages, from };
}

export function allLanguages(draft: BuilderDraft, data: BuilderData): string[] {
  const plan = languagePlan(draft, data);
  return [...new Set([...plan.fixed, ...draft.languages])];
}

export function validateLanguages(draft: BuilderDraft, data: BuilderData): string[] {
  const plan = languagePlan(draft, data);
  const chosen = [...new Set(draft.languages)].filter((l) => !plan.fixed.includes(l));
  const required = plan.standard + plan.any;
  const errors: string[] = [];
  const standard = new Set<string>(STANDARD_LANGUAGES);
  const nonStandard = chosen.filter((l) => !standard.has(l));
  if (nonStandard.length > plan.any) {
    errors.push(`${nonStandard.join(', ')} ${nonStandard.length > 1 ? 'are rare languages' : 'is a rare language'} — pick from the standard languages.`);
  }
  if (chosen.length !== required) errors.push(`Choose ${required} languages besides Common (${chosen.length} chosen).`);
  return errors;
}
