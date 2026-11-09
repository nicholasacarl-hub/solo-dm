/**
 * The normalizer (spec §3.9): ONE per kind, shared by the offline parser and Claude. Parses the wire's
 * excerpts into numbers, grounds them, resolves spans, cross-checks, adds adaptations and grades
 * confidence. validateData re-validates edited or pack data without a wire object: the kind's own
 * checks plus DATA_SCHEMAS (ranges and shapes as `block` warnings).
 *
 * Owner: E2 (dispatcher and the entity kinds monster, spell, magic item, item); E4 writes the option
 * kinds (feat, background, species, class, subclass) in ./feat, ./background, ./species, ./classes and
 * ./subclass, each exporting normalize<Kind>(wire, ctx) and validate<Kind>(data, ctx).
 */
import type {
  Adaptation,
  CompendiumEntry,
  Excerpt,
  RecordConfidence,
  RecordOrigin,
  RecordWarning,
  StructuredDataByKind,
  StructuredKind,
} from '@/types';
import { DATA_SCHEMAS } from '../schemas';
import type { CandidateBlock, SpellListHint } from '../segment';
import type { Wire } from '../wire';
import { normalizeBackground, validateBackground } from './background';
import { normalizeClass, validateClass } from './classes';
import { normalizeFeat, validateFeat } from './feat';
import { normalizeItem, validateItem } from './item';
import { normalizeMagicItem, validateMagicItem } from './magicItem';
import { normalizeMonster, validateMonster } from './monster';
import { normalizeSpecies, validateSpecies } from './species';
import { normalizeSpell, validateSpell } from './spell';
import { normalizeSubclass, validateSubclass } from './subclass';
import { dedupeWarnings, gradeConfidence, warning } from './text';

export interface NormalizeContext {
  blocks: CandidateBlock[];              // FULL texts (never the abbreviated request texts)
  entriesById: ReadonlyMap<string, CompendiumEntry>;
  origin: RecordOrigin;
  spellLists: readonly SpellListHint[];
  missing?: string[];                    // offline parser only
  /** Additive (E2): the candidate's parentClassName (a subclass inside a class chapter, under "X Subclass:"…). */
  parentClassName?: string;
}
export interface Normalized<K extends StructuredKind> {
  data: StructuredDataByKind[K] | null;  // null when a block-severity field is unrecoverable
  name: string;
  warnings: RecordWarning[];
  adaptations: Adaptation[];
  excerpts: Excerpt[];
  confidence: RecordConfidence;
  modelNote?: string;
}

type KindNormalizer<K extends StructuredKind> = (wire: Wire<K>, ctx: NormalizeContext) => Normalized<K>;
type KindValidator<K extends StructuredKind> = (
  data: StructuredDataByKind[K],
  ctx: NormalizeContext,
) => Pick<Normalized<K>, 'warnings' | 'adaptations' | 'confidence'>;
type Handlers = { [K in StructuredKind]: { normalize: KindNormalizer<K>; validate: KindValidator<K> } };

const HANDLERS: Handlers = {
  monster: { normalize: normalizeMonster, validate: validateMonster },
  spell: { normalize: normalizeSpell, validate: validateSpell },
  'magic-item': { normalize: normalizeMagicItem, validate: validateMagicItem },
  item: { normalize: normalizeItem, validate: validateItem },
  feat: { normalize: normalizeFeat, validate: (data, ctx) => validateFeat(data, ctx) },
  background: { normalize: normalizeBackground, validate: (data, ctx) => validateBackground(data, ctx) },
  species: { normalize: normalizeSpecies, validate: (data, ctx) => validateSpecies(data, ctx) },
  class: { normalize: normalizeClass, validate: (data, ctx) => validateClass(data, ctx) },
  subclass: { normalize: normalizeSubclass, validate: (data, ctx) => validateSubclass(data, ctx) },
};

export function normalize<K extends StructuredKind>(kind: K, wire: Wire<K>, ctx: NormalizeContext): Normalized<K> {
  return (HANDLERS[kind].normalize as KindNormalizer<K>)(wire, ctx);
}

/** DATA_SCHEMAS issues as `block` warnings on their fields (ranges, required values, shapes). */
export function schemaWarnings<K extends StructuredKind>(kind: K, data: unknown): RecordWarning[] {
  const result = DATA_SCHEMAS[kind].safeParse(data);
  if (result.success) return [];
  return result.error.issues.slice(0, 20).map((issue) => {
    const field = issue.path.map(String).join('.') || undefined;
    const range = issue.code === 'too_big' || issue.code === 'too_small' || issue.code === 'not_multiple_of';
    return warning(range ? 'out-of-range' : 'missing', 'block', range ? "This value is outside what the app and the DM's tools accept." : "This value is missing or isn't valid here.", field);
  });
}

/** Re-validate edited or pack data (cross-checks, spans, ranges) without a wire object. */
export function validateData<K extends StructuredKind>(
  kind: K,
  data: StructuredDataByKind[K],
  ctx: NormalizeContext,
): Pick<Normalized<K>, 'warnings' | 'adaptations' | 'confidence'> {
  const own = (HANDLERS[kind].validate as KindValidator<K>)(data, ctx);
  const warnings = dedupeWarnings([...schemaWarnings(kind, data), ...own.warnings]);
  return { warnings, adaptations: own.adaptations, confidence: gradeConfidence(kind, warnings, { matchesKind: true, missingKey: false }) };
}

export { MONSTER_FIELDS } from './monster';
export { SPELL_FIELDS } from './spell';
export { MAGIC_ITEM_FIELDS } from './magicItem';
export { ITEM_FIELDS, normalizeItemRows } from './item';
