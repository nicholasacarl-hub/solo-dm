/**
 * The normalizer (spec §3.9): ONE per kind, shared by the offline parser and Claude. Parses the wire's
 * excerpts into numbers, grounds them, resolves spans, cross-checks, adds adaptations and grades
 * confidence. validateData re-validates edited or pack data without a wire object.
 *
 * CONTRACT (Day 0 stub). Owner: E2 (dispatcher and entity kinds); E4 writes the option kinds' normalizers.
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
import type { CandidateBlock, SpellListHint } from '../segment';
import type { Wire } from '../wire';

export interface NormalizeContext {
  blocks: CandidateBlock[];              // FULL texts (never the abbreviated request texts)
  entriesById: ReadonlyMap<string, CompendiumEntry>;
  origin: RecordOrigin;
  spellLists: readonly SpellListHint[];
  missing?: string[];                    // offline parser only
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

export function normalize<K extends StructuredKind>(kind: K, wire: Wire<K>, ctx: NormalizeContext): Normalized<K> {
  void [kind, wire, ctx];
  throw new Error('data/structured/normalize: normalize not implemented');
}

/** Re-validate edited or pack data (cross-checks, spans, ranges) without a wire object. */
export function validateData<K extends StructuredKind>(
  kind: K,
  data: StructuredDataByKind[K],
  ctx: NormalizeContext,
): Pick<Normalized<K>, 'warnings' | 'adaptations' | 'confidence'> {
  void [kind, data, ctx];
  return { warnings: [], adaptations: [], confidence: 'low' }; // not implemented (Day-0 stub): safe default
}
