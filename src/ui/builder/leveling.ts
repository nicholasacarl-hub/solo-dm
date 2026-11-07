/**
 * Keeping a built character current as it levels, from the builder data (SRD 5.2.1 class tables,
 * species traits, feats). After a level-up every limited-use feature is re-read at its new level:
 * class and subclass features with their class level and table, species traits from the species
 * data (preamble plus the chosen lineage only), feats from their text. Each one also gets `scale`, so
 * later level-ups (including the DM's level_up tool, which has no class tables) grow it too.
 *
 * It also repairs characters made by an older builder: class features it named as a choice
 * ("Rage (Duration)" -> "Rage"), and the Thaumaturge/Magician skill bonus and species Resistances
 * it never recorded.
 */
import { characterLevel, proficiencyBonus } from '@/engine';
import { nameKey } from '@/lib/id';
import type { BuilderData, Character, ClassLevel, ClassOption, Feature, FeatureUses, SkillBonus, SpeciesOption } from '@/types';
import { baseFeatureName, featureChoiceOptions, optionGrants, runInHeadings } from './classFeatures';
import { inferFeatureUses, type UsesContext } from './featureUses';
import { lineageFeatureText, speciesChoices, speciesResistances, type LineageOption } from './species';

export type LevelingData = Pick<BuilderData, 'classes' | 'species'>;

export function classOptionFor(cl: ClassLevel, classes: ClassOption[]): ClassOption | undefined {
  return classes.find((o) => o.id === cl.classId) ?? classes.find((o) => nameKey(o.name) === nameKey(cl.name));
}

/** The "(…)" at the end of a feature name: "Divine Order (Thaumaturge)" -> "Thaumaturge". */
function nameOption(name: string): string | null {
  return /\(([^()]+)\)\s*$/.exec(name)?.[1].trim() ?? null;
}

interface Owner {
  cl: ClassLevel;
  cls?: ClassOption;
}

/** The class a class or subclass feature belongs to, from its source label ("Barbarian 1", "Champion 3"). */
function featureOwner(c: Character, f: Feature, data: LevelingData | null | undefined): Owner | null {
  const owner = nameKey((f.sourceName ?? '').replace(/\s+\d+$/, ''));
  if (!owner) return null;
  for (const cl of c.classes) {
    const cls = data ? classOptionFor(cl, data.classes) : undefined;
    const names = f.source === 'class' ? [cl.name, cls?.name] : [cl.subclass, ...(cls?.subclasses.map((s) => s.name) ?? [])];
    if (names.some((n) => n && nameKey(n) === owner)) return { cl, cls };
  }
  return null;
}

function findSpecies(c: Character, data: LevelingData | null | undefined): SpeciesOption | undefined {
  if (!data) return undefined;
  const name = nameKey(c.species.replace(/\s*\(.*$/, ''));
  return data.species.find((s) => s.id === c.speciesId) ?? data.species.find((s) => nameKey(s.name) === name);
}

/** The chosen lineage, read from the lineage trait's feature ("Giant Ancestry (Stone Giant)"). */
function chosenLineage(c: Character, species: SpeciesOption | undefined): LineageOption | undefined {
  const choices = speciesChoices(species);
  if (!choices.lineageTrait) return undefined;
  const key = nameKey(choices.lineageTrait.name);
  const feature = c.features.find((f) => f.source === 'species' && nameKey(baseFeatureName(f.name)) === key);
  const option = feature && nameOption(feature.name);
  return option ? choices.lineages.find((l) => nameKey(l.name) === nameKey(option)) : undefined;
}

/** The text a species trait's uses come from: its own, or (lineage trait) the preamble + chosen lineage. */
function speciesTraitText(species: SpeciesOption, f: Feature, lineage: LineageOption | undefined): string | null {
  const key = nameKey(baseFeatureName(f.name));
  const trait = species.traits.find((t) => nameKey(t.name) === key);
  if (!trait) return null;
  if (trait !== speciesChoices(species).lineageTrait) return trait.description;
  return lineage ? lineageFeatureText(trait, lineage) : null;
}

const sameScale = (a: FeatureUses['scale'], b: FeatureUses['scale']) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** New max (used kept ≤ max) and scale; recharge stays as it was. Unchanged features keep their identity. */
function withUses(f: Feature, fresh: FeatureUses | undefined): Feature {
  if (!fresh) return f;
  const old = f.uses;
  if (!old) return { ...f, uses: fresh };
  if (old.max === fresh.max && sameScale(old.scale, fresh.scale)) return f;
  const uses: FeatureUses = { ...old, max: fresh.max, used: Math.min(old.used, fresh.max) };
  if (fresh.scale) uses.scale = fresh.scale;
  else delete uses.scale;
  return { ...f, uses };
}

interface Refreshed {
  feature: Feature;
  /** Skill bonus of the chosen option of a class choice feature (Divine Order (Thaumaturge)). */
  skillBonus?: SkillBonus;
}

function refreshClassFeature(f: Feature, owner: Owner, ctx: UsesContext): Refreshed {
  const cls = owner.cls;
  const exact = cls?.features.find((d) => nameKey(d.name) === nameKey(f.name));
  const def = exact ?? cls?.features.find((d) => nameKey(d.name) === nameKey(baseFeatureName(f.name)));
  if (f.source !== 'class' || !def) return { feature: withUses(f, inferFeatureUses(f.name, f.description, ctx)) };
  const option = exact ? null : nameOption(f.name);
  const choices = featureChoiceOptions(def.description);
  // An older builder decorated Rage with one of its rules headings as if it were a choice.
  const rename = option !== null && !choices && runInHeadings(def.description).some((h) => nameKey(h) === nameKey(option));
  const name = rename ? def.name : f.name;
  const feature = withUses(name === f.name ? f : { ...f, name }, inferFeatureUses(name, def.description, ctx));
  const chosen = option ? choices?.find((o) => nameKey(o.name) === nameKey(option)) : undefined;
  const bonus = chosen && optionGrants(chosen.description).skillBonus;
  return { feature, ...(bonus && chosen ? { skillBonus: { ...bonus, source: `${chosen.name} (${def.name})` } } : {}) };
}

function addMissing<T>(list: readonly T[] | undefined, items: T[], same: (a: T, b: T) => boolean): T[] | undefined {
  const missing = items.filter((item) => !(list ?? []).some((have) => same(have, item)));
  return missing.length ? [...(list ?? []), ...missing] : undefined;
}

/**
 * Re-read the uses of every feature at the character's current levels (call it after levelUp), with
 * the repairs described above. Returns the same object when nothing changed. Without builder data,
 * features are re-read from their own text (no class tables, no species data).
 */
export function refreshFeatureUses(c: Character, data: LevelingData | null | undefined): Character {
  const level = characterLevel(c);
  const base = { level, proficiencyBonus: proficiencyBonus(level), scores: c.abilityScores };
  const species = findSpecies(c, data);
  const lineage = chosenLineage(c, species);
  const skillBonuses: SkillBonus[] = [];
  let changed = false;
  const features = c.features.map((f) => {
    let next = f;
    if (f.source === 'class' || f.source === 'subclass') {
      const owner = featureOwner(c, f, data);
      if (owner) {
        const refreshed = refreshClassFeature(f, owner, { ...base, level: owner.cl.level, cls: owner.cls });
        next = refreshed.feature;
        if (refreshed.skillBonus) skillBonuses.push(refreshed.skillBonus);
      }
    } else if (f.source === 'species') {
      const text = species ? speciesTraitText(species, f, lineage) : null;
      if (text !== null) next = withUses(f, inferFeatureUses(baseFeatureName(f.name), text, base));
    } else if (f.source === 'feat') {
      next = withUses(f, inferFeatureUses(f.name, f.description, base));
    }
    if (next !== f) changed = true;
    return next;
  });
  const bonuses = addMissing(c.skillBonuses, skillBonuses, (a, b) => nameKey(a.source) === nameKey(b.source));
  const resistances = addMissing(c.damageResistances, speciesResistances(species, lineage), (a, b) => a.trim().toLowerCase() === b);
  if (!changed && !bonuses && !resistances) return c;
  return {
    ...c,
    features: changed ? features : c.features,
    ...(bonuses ? { skillBonuses: bonuses } : {}),
    ...(resistances ? { damageResistances: resistances } : {}),
  };
}

/** Uses a level-up changed, for the DM notice and the summary: "Rage 2 → 3", "Draconic Flight 1". */
export function featureUseChanges(before: Character, after: Character): string[] {
  const old = new Map(before.features.map((f) => [f.id, f]));
  return after.features.flatMap((f) => {
    const prev = old.get(f.id);
    if (!prev || !f.uses) return [];
    if (!prev.uses) return [`${f.name} ${f.uses.max}`];
    return prev.uses.max === f.uses.max ? [] : [`${f.name} ${prev.uses.max} → ${f.uses.max}`];
  });
}
