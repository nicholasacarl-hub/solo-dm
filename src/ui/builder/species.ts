/**
 * Species choices (SRD 5.2.1 "Character Origins"): size, lineage/ancestry/legacy, a skill
 * (Human Skillful, Elf Keen Senses) and an extra Origin feat (Human Versatile), read from the
 * species' traits so imported species with the same phrasing work too.
 */
import { SKILLS, SKILL_NAMES, type CreatureSize, type Skill, type SpeciesOption, type SpeciesTrait } from '@/types';

export interface LineageOption {
  name: string;
  description: string;
}

export interface SpeciesChoices {
  /** Sizes to choose from (only a choice when more than one). */
  sizes: CreatureSize[];
  lineages: LineageOption[];
  /** The trait that offers the lineages ("Elven Lineage", "Draconic Ancestry"). */
  lineageTrait: SpeciesTrait | null;
  /** Word used for the choice: "lineage", "ancestry" or "legacy". */
  lineageNoun: string;
  /** Lineage spells use INT, WIS or CHA, chosen with the lineage. */
  lineageNeedsAbility: boolean;
  /** One skill proficiency to choose (null = none; 'any' = any skill). */
  skill: { from: Skill[] | 'any'; trait: string } | null;
  /** Grants an Origin feat of the player's choice. */
  originFeat: { trait: string } | null;
}

const SKILL_BY_NAME = new Map<string, Skill>(SKILLS.map((s) => [SKILL_NAMES[s].toLowerCase(), s]));

/** Skill names mentioned in a piece of text, in order of appearance. */
export function skillsInText(text: string): Skill[] {
  const lower = text.toLowerCase();
  return SKILLS.map((s) => ({ s, at: lower.indexOf(SKILL_NAMES[s].toLowerCase()) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.s);
}

export function skillFromName(name: string): Skill | undefined {
  return SKILL_BY_NAME.get(name.trim().toLowerCase());
}

function nounFor(trait: SpeciesTrait | null): string {
  const name = trait?.name.toLowerCase() ?? '';
  if (name.includes('ancestry')) return 'ancestry';
  if (name.includes('legacy')) return 'legacy';
  return 'lineage';
}

/** Bold run-in options ("**Forest Gnome.** You know…") or two-column table rows ("| Black | Acid |"). */
function parseTraitOptions(description: string): LineageOption[] {
  const bold = [...description.matchAll(/(?:^|\n)\s*_?\*\*([^*\n]+?)\.\*\*_?\s*([^\n]*)/g)].map((m) => ({
    name: m[1].trim(),
    description: m[2].trim(),
  }));
  if (bold.length >= 2) return bold;
  const rows = [...description.matchAll(/^\|\s*([^|\n]+?)\s*\|\s*([^|\n]+?)\s*\|/gm)]
    .map((m) => ({ name: m[1].trim(), description: m[2].trim() }))
    .filter((r) => !/^[-:\s]+$/.test(r.name) && !/^(dragon|lineage|legacy|ancestry)$/i.test(r.name));
  return rows.length >= 2 ? rows : [];
}

function findLineageTrait(species: SpeciesOption): SpeciesTrait | null {
  return (
    species.traits.find((t) => /lineage|ancestry|legacy/i.test(t.name)) ??
    species.traits.find((t) => /choose (?:one|a \w+) (?:of the following|from the table)/i.test(t.description)) ??
    null
  );
}

export function speciesChoices(species: SpeciesOption | undefined): SpeciesChoices {
  if (!species) {
    return { sizes: [], lineages: [], lineageTrait: null, lineageNoun: 'lineage', lineageNeedsAbility: false, skill: null, originFeat: null };
  }
  const lineageTrait = findLineageTrait(species);
  const lineages = species.lineages?.length ? species.lineages : lineageTrait ? parseTraitOptions(lineageTrait.description) : [];
  const allText = species.traits.map((t) => t.description).join('\n');
  let skill: SpeciesChoices['skill'] = null;
  let originFeat: SpeciesChoices['originFeat'] = null;
  for (const trait of species.traits) {
    if (!skill && /proficiency in one skill of your choice/i.test(trait.description)) {
      skill = { from: 'any', trait: trait.name };
    } else if (!skill && /proficiency in the .+ skill/i.test(trait.description)) {
      const from = skillsInText(trait.description);
      if (from.length > 1) skill = { from, trait: trait.name };
    }
    if (!originFeat && /Origin feat of your choice/i.test(trait.description)) originFeat = { trait: trait.name };
  }
  return {
    sizes: species.sizes,
    lineages,
    lineageTrait: lineages.length ? lineageTrait : null,
    lineageNoun: nounFor(lineageTrait),
    lineageNeedsAbility: lineages.length > 0 && /Intelligence, Wisdom, or Charisma is your spellcasting ability/i.test(allText),
    skill,
    originFeat,
  };
}

/** A single fixed skill proficiency granted by a trait (e.g. "You have proficiency in the Perception skill"). */
export function fixedSpeciesSkills(species: SpeciesOption | undefined): Skill[] {
  if (!species) return [];
  return species.traits.flatMap((t) => {
    if (!/proficiency in the .+ skill/i.test(t.description)) return [];
    const found = skillsInText(t.description);
    return found.length === 1 ? found : [];
  });
}

export interface LineageEffects {
  speed?: number;
  darkvision?: number;
  /** Cantrips the lineage grants at level 1. */
  cantrips: string[];
  /** Spells the lineage keeps always prepared from level 1. */
  alwaysPrepared: string[];
}

/** Mechanical effects of a lineage's level 1 benefit. */
export function lineageEffects(description: string): LineageEffects {
  const effects: LineageEffects = { cantrips: [], alwaysPrepared: [] };
  const speed = /Speed increases to (\d+) feet/i.exec(description);
  if (speed) effects.speed = Number(speed[1]);
  const dark = /Darkvision increases to (\d+) feet/i.exec(description);
  if (dark) effects.darkvision = Number(dark[1]);
  effects.cantrips = cantripNames(description);
  for (const m of description.matchAll(/always have (?:the )?_?([A-Z][\w' /-]+?)_? spell prepared/g)) {
    effects.alwaysPrepared.push(m[1].trim());
  }
  return effects;
}

/** "You know the _Mending_ and _Prestidigitation_ cantrips" -> ["Mending", "Prestidigitation"]. */
export function cantripNames(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(/know the (.+?) cantrips?\b/gi)) {
    const list = m[1].replace(/_/g, '').split(/\s*(?:,|\band\b)\s*/);
    for (const raw of list) {
      const name = raw.trim();
      if (name && /^[A-Z]/.test(name)) names.push(name);
    }
  }
  return names;
}

/** Extra HP per character level from traits such as Dwarven Toughness. */
export function hpBonusPerLevel(traits: { description: string }[]): number {
  return traits.filter((t) => /Hit Point maximum increases by 1, and it increases by 1 again whenever you gain a level/i.test(t.description)).length;
}

/** Display string such as "Elf (Wood Elf lineage)" or "Dragonborn (Red ancestry)". */
export function speciesDisplayName(species: SpeciesOption | undefined, lineage: string | null): string {
  if (!species) return '';
  if (!lineage) return species.name;
  return `${species.name} (${lineage} ${speciesChoices(species).lineageNoun})`;
}
