/**
 * Grounding and span helpers shared by every normalizer (spec §3.9.2): E2 writes them, E4's option
 * normalizers use them.
 *
 * CONTRACT (Day 0 stub). Owner: E2. Signatures defined from §3.9.2's prose.
 */
import type { RecordWarning, TextSpan } from '@/types';
import type { CandidateBlock } from '../segment';

/**
 * The comparison form of a text: NFKC-normalized (ligatures), soft hyphens removed, NBSP → space,
 * Markdown emphasis and heading marks removed, curly quotes straightened, − – — → "-", whitespace
 * collapsed, lowercased.
 */
export function groundingForm(text: string): string {
  void text;
  throw new Error('data/structured/normalize/text: groundingForm not implemented');
}

/** True when the excerpt's grounding form is a substring of the full text's. */
export function grounded(excerpt: string, fullText: string): boolean {
  void [excerpt, fullText];
  throw new Error('data/structured/normalize/text: grounded not implemented');
}

/**
 * A wire span `{ block, from, to }` → a TextSpan on the block's entries. `{ block: "", from: 0, to: 0 }`
 * → span null, no warning. Unknown block or a range outside 1 ≤ from ≤ to ≤ paragraphs → span null and
 * a `block` `unresolved-text` warning; a span whose first paragraph (heading marks, emphasis and a
 * "Level N:" prefix removed) doesn't start with `name` under nameKey, in a block not titled `name`
 * → the span and a `warn` `unresolved-text` warning. `field` names the wire field for the warning.
 */
export function spanFromWire(
  wire: { block: string; from: number; to: number },
  name: string,
  blocks: readonly CandidateBlock[],
  field: string,
): { span: TextSpan | null; warning?: RecordWarning } {
  void [wire, name, blocks, field];
  throw new Error('data/structured/normalize/text: spanFromWire not implemented');
}
