/**
 * Provenance for copies (spec §7.1): the one helper that builds an ImportedRef from a merged option.
 *
 * CONTRACT (Day 0 stub). Owner: E4 (the only caller: merge, builder, level-up, DM character tools).
 * Signature defined from §7.1's prose `refFor(option, kind, part?, level?, span?)`; E4 may refine it.
 */
import type { ImportedRef, OptionSource, StructuredKind } from '@/types';

/** What refFor reads from a merged option (its id is the publicId; SRD options have no source). */
export interface RefOption { id: string; name: string; source?: OptionSource }

/** The copied text and where it sits in the book (absent: nothing copied, textCopied false, textHash ''). */
export interface RefText {
  text: string;
  at?: ImportedRef['at'];
  bookFingerprint?: string;
}

/** The ref for copying an imported option (or one part of it) onto a character; undefined for SRD options. */
export function refFor(option: RefOption, kind: StructuredKind, part?: string, level?: number, span?: RefText): ImportedRef | undefined {
  void [option, kind, part, level, span];
  throw new Error('data/options/refs: refFor not implemented');
}
