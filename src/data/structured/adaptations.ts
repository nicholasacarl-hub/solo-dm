/**
 * Older-format (2014) adaptations (spec §5.6): the app-written note for each code, generated from the
 * option's fields (it names the option; no book text is quoted). Applied by the normalizers (and, for
 * subclass placement, by the merge); stored on records and OptionSource.adaptations; shown in review,
 * on builder cards, on the builder's Review step, in the DM's stats line and in a character's
 * `adaptationNotes`. The DM keeps latitude: these are defaults for the app's bookkeeping.
 *
 * Owner: E4.
 */
import type { Adaptation, AdaptationCode } from '@/types';

export interface AdaptationFields {
  /** The option the note is about: the species, background, feat, class or subclass name. */
  name: string;
  /** subclass-early-features, subclass-overlap: the parent class's name. */
  className?: string;
  /** subclass-early-features: the parent class's subclass level. */
  level?: number;
  /** background-feature-kept: the background feature's name. */
  feature?: string;
  /** prepared-2024-column: which 2024 column the class follows. */
  caster?: 'full' | 'half';
}

const NOTES: Readonly<Record<AdaptationCode, (f: AdaptationFields) => string>> = {
  'species-asi-not-applied': (f) =>
    `Older edition: ${f.name}'s ability score increases aren't used. In the 2024 rules your background sets your ability scores.`,
  'species-languages-suggested': (f) => `Older edition: the languages ${f.name} lists are suggested for your two language choices.`,
  'background-any-three': (f) => `Older edition: ${f.name} doesn't list ability scores, so you choose any three to increase.`,
  'background-feat-choice': (f) => `Older edition: ${f.name} doesn't grant an Origin feat, so you choose one.`,
  'background-feature-kept': (f) => `Older edition: its feature “${f.feature ?? f.name}” is kept on your sheet as a background feature.`,
  'background-languages-suggested': (f) => `Older edition: the languages ${f.name} grants are suggested for your two language choices.`,
  'feat-general': (f) => `No feat category is printed, so ${f.name} is treated as a General feat.`,
  'fighting-style-inline': (f) => `${f.name} lists its own fighting styles; they're offered alongside the Fighting Style feats.`,
  'subclass-early-features': (f) =>
    `Older edition: you choose ${f.name} at ${f.className ?? 'its class'} level ${f.level ?? 3} here; features it gives earlier arrive then.`,
  'subclass-overlap': (f) =>
    `Written for the older rules: some of ${f.name}'s features may overlap the 2024 ${f.className ?? 'class'}'s own. Ask your DM which to keep.`,
  'subclass-at-level-1': (f) => `${f.name} chooses its subclass at level 1: pick it in the builder.`,
  'prepared-2024-column': (f) => `Prepared spells follow the 2024 progression for a ${f.caster ?? 'full'} caster.`,
  'half-caster-slots-2024': () => 'Spell slots follow the 2024 table, which gives half casters slots from level 1.',
  'monster-2014-statblock': () => 'Older stat block: its initiative is its Dexterity modifier and its proficiency bonus comes from its CR.',
};

/** The exact note of §5.6 for a code, filled from the fields. */
export function adaptationNote(code: AdaptationCode, fields: AdaptationFields): string {
  return NOTES[code](fields);
}

/** { code, note: adaptationNote(code, fields) }. */
export function adaptation(code: AdaptationCode, fields: AdaptationFields): Adaptation {
  return { code, note: adaptationNote(code, fields) };
}

/** `list` plus `more`, keeping the first of each code (a pack or a re-run may repeat one). */
export function withAdaptations(list: readonly Adaptation[], more: readonly Adaptation[]): Adaptation[] {
  const out = [...list];
  for (const a of more) if (!out.some((b) => b.code === a.code)) out.push(a);
  return out;
}
