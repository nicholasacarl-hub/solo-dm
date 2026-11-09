/**
 * Species choices (SRD 5.2.1 "Character Origins"): size, lineage/ancestry/legacy, a skill
 * (Human Skillful, Elf Keen Senses) and an extra Origin feat (Human Versatile), read from the
 * species' traits so imported species with the same phrasing work too.
 */
import { SKILLS, SKILL_NAMES, type CreatureSize, type ImportedRef, type Skill, type SpeciesOption, type SpeciesTrait } from '@/types';

export interface LineageOption {
  name: string;
  description: string;
  /** A book's lineage (from its record's `lineages`): where its words come from. */
  ref?: ImportedRef;
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
  // An imported species names its lineage trait (it wins over the name rule: "Lamp-Drawn" offers lineages too).
  const named = species.lineageTrait ? species.traits.find((t) => t.name === species.lineageTrait) : undefined;
  return (
    named ??
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
  // A book's species offers the lineages its record lists, never options read out of a trait's text: its
  // "Choose one of the following gifts each time you finish a Long Rest" is a choice made in play, and the
  // trait stays whole, with its ref, like any other trait.
  const lineages = species.lineages?.length ? species.lineages : lineageTrait && !species.source ? parseTraitOptions(lineageTrait.description) : [];
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

/**
 * The part of a trait that applies whichever option is chosen: the text before its first bold
 * option or table row ("Choose one of the following benefits …; you can use the chosen benefit a
 * number of times equal to your Proficiency Bonus …").
 */
export function traitPreamble(description: string): string {
  const cut = description.search(/\n\s*(?:_?\*\*[^*\n]+?\.\*\*|\|)/);
  return (cut >= 0 ? description.slice(0, cut) : description).trim();
}

/** The lineage trait as it applies to the chosen lineage: its preamble plus that lineage's text only. */
export function lineageFeatureText(trait: SpeciesTrait, lineage: LineageOption): string {
  return `${traitPreamble(trait.description)}\n\n**${lineage.name}.** ${lineage.description}`;
}

const DAMAGE_TYPES = ['acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder'];

/** Damage types named in a text, lowercase, in the order they appear ("Acid damage" -> ["acid"]). */
export function damageTypesIn(text: string): string[] {
  const lower = text.toLowerCase();
  return DAMAGE_TYPES.map((t) => ({ t, at: lower.search(new RegExp(`\\b${t}\\b`)) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.t);
}

/** SRD 5.2.1 states a species' Resistance at a sentence start: "You have Resistance to Poison damage." */
const SRD_RESISTANCE = /(?:^|[.!?]\s+|\n\s*|\*\*_?\s*)You have Resistance to ([^.;\n]+)/g;

/** Words that make a resistance last only a while or hold only sometimes: "For 1 minute, …", "While you are Bloodied, …". */
const CONDITION =
  /\b(?:while|when(?:ever)?|if|unless|until|after|during|as long as|for the duration|for (?:\d+|one|a|an|the next)\b[^,.]*?\b(?:minute|hour|round|turn)s?|as an? (?:[\w-]+ )?(?:action|reaction))\b/i;

/** "…fire damage while you are in sunlight", "…cold damage until the end of your next turn". */
const TRAILING_CONDITION = new RegExp(
  String.raw`\b(?:${DAMAGE_TYPES.join('|')})(?:\s+damage)?\s*,?\s+(?:while|when(?:ever)?|if|unless|until|during|as long as|for the duration|for (?:\d+|one|a|an|the next)\b)`,
  'i',
);

/**
 * What an imported trait's "you have resistance to …" clauses resist, as written (older books also put it
 * mid-sentence and in lower case: "…, and you have resistance to poison damage"). A clause with a
 * condition before it in its sentence, or right after its damage type, is left to the DM: the app records
 * only resistances the hero always has (B7).
 */
function lastingResistanceClauses(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    for (const m of sentence.matchAll(/\byou have resistance to ([^.;\n]+)/gi)) {
      if (!CONDITION.test(sentence.slice(0, m.index ?? 0)) && !TRAILING_CONDITION.test(m[1])) out.push(m[1]);
    }
  }
  return out;
}

/**
 * Damage Resistances a species gives (SRD 5.2.1 Dwarven Resilience, Dragonborn Damage Resistance,
 * Tiefling legacies): sentences starting "You have Resistance to …" in its traits and the chosen
 * lineage. "…the damage type determined by your Draconic Ancestry trait" reads the lineage's type.
 */
export function speciesResistances(species: SpeciesOption | undefined, lineage: LineageOption | undefined): string[] {
  if (!species) return [];
  const lineageTrait = speciesChoices(species).lineageTrait;
  const texts = species.traits.map((t) => (t === lineageTrait ? traitPreamble(t.description) : t.description));
  if (lineage) texts.push(lineage.description);
  const out: string[] = [];
  for (const text of texts) {
    const clauses = species.source ? lastingResistanceClauses(text) : [...text.matchAll(SRD_RESISTANCE)].map((m) => m[1]);
    for (const clause of clauses) {
      const named = damageTypesIn(clause);
      const types = named.length ? named : lineage && /determined by/i.test(clause) ? damageTypesIn(lineage.description) : [];
      for (const t of types) if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}

/** Extra HP per character level from traits such as Dwarven Toughness (older books: "…by 1 every time you gain a level"). */
export function hpBonusPerLevel(traits: { description: string }[]): number {
  return traits.filter((t) => /Hit Point maximum increases by 1,? and it increases by 1 (?:again )?(?:whenever|every time|each time) you gain a level/i.test(t.description)).length;
}

/** Display string such as "Elf (Wood Elf lineage)" or "Dragonborn (Red ancestry)". */
export function speciesDisplayName(species: SpeciesOption | undefined, lineage: string | null): string {
  if (!species) return '';
  if (!lineage) return species.name;
  return `${species.name} (${lineage} ${speciesChoices(species).lineageNoun})`;
}
