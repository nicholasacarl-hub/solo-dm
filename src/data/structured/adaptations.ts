/**
 * Older-format (2014) adaptations (spec §5.6): the app-written note for each code, generated from the
 * option's fields (it names the option; no book text is quoted). Applied by the normalizers (and, for
 * subclass placement, by the merge); stored on records and OptionSource.adaptations.
 *
 * CONTRACT (Day 0 stub). Owner: E4. Signature defined from §5.6's table: the placeholders it fills are
 * <Species>, <Background>, <Feat>, <Class>, <Subclass> (all `name`), <Feature>, <Class> of a subclass,
 * <N> and <full/half>.
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

/** The exact note of §5.6 for a code, filled from the fields. */
export function adaptationNote(code: AdaptationCode, fields: AdaptationFields): string {
  void [code, fields];
  throw new Error('data/structured/adaptations: adaptationNote not implemented');
}

/** { code, note: adaptationNote(code, fields) }. */
export function adaptation(code: AdaptationCode, fields: AdaptationFields): Adaptation {
  return { code, note: adaptationNote(code, fields) };
}
