/**
 * Segmentation and detection (spec §3.2, pure): a source's entries in reading order → the things the
 * app can structure ("candidates"), each with its blocks (one entry or a "(part N)" chain, paragraphs
 * numbered by splitParagraphs), plus the book's class spell lists.
 *
 * CONTRACT (Day 0 stub). Owner: E2.
 */
import type { CompendiumEntry, RecordSpan, StructuredKind } from '@/types';

export interface CandidateBlock {
  id: string;                    // "B1", "B2"… — what the request and the wire's spans use
  entryIds: string[];            // one entry, or a "(part N)" chain
  title: string;                 // the first entry's name without " (part N)"
  path: string[];
  paragraphs: string[];          // splitParagraphs(joined full texts)
}
export interface Candidate {
  key: string;                   // candidateKey (§2.6)
  kind: StructuredKind;
  name: string;
  span: RecordSpan;
  entryIds: string[];
  rowIndex?: number;
  parentClassName?: string;      // a subclass found inside a class chapter
  blocks: CandidateBlock[];
  textHash: string;              // textFingerprint(full texts joined by "\n\n")
  reason: string;                // app-written: "Has Armor Class, Hit Points and Challenge lines"
}
export interface SpellListHint { className: string; spellNames: string[]; entryId: string }
/** nameKey()s of the spells and classes already known (SRD, and this book's class candidates). */
export interface SegmentContext { knownSpellNames: ReadonlySet<string>; knownClassNames: ReadonlySet<string> }

export function segment(entries: readonly CompendiumEntry[], ctx: SegmentContext): { candidates: Candidate[]; spellLists: SpellListHint[] } {
  void [entries, ctx];
  throw new Error('data/structured/segment: segment not implemented');
}
