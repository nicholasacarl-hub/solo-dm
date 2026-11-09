/**
 * Provenance for copies (spec §7.1): the one helper that builds an ImportedRef from a merged option.
 * Every copy of an imported option onto a character (builder, level-up, the DM's character tools) gets
 * its ref here; SRD options (no `source`) get none.
 *
 * Owner: E4.
 */
import { textFingerprint } from '@/lib/importedContent';
import { STRUCTURED_KINDS, type ImportedRef, type OptionSource, type StructuredKind, type TextSpan } from '@/types';

/** What refFor reads from a merged option (its id is the publicId; SRD options have no source). */
export interface RefOption { id: string; name: string; source?: OptionSource }

/** The copied text and where it sits in the book (absent: nothing copied, textCopied false, textHash ''). */
export interface RefText {
  text: string;
  at?: ImportedRef['at'];
  bookFingerprint?: string;
}

/**
 * The ref for copying an imported option (or one part of it) onto a character; undefined for SRD
 * options. With `span.text` the copy holds the book's words (textCopied, textHash of the text); a span
 * without text only carries where the book is (bookFingerprint) for an option-level ref.
 */
export function refFor(option: RefOption, kind: StructuredKind, part?: string, level?: number, span?: RefText): ImportedRef | undefined {
  const source = option.source;
  if (!source) return undefined;
  const copied = Boolean(span?.text);
  return {
    sourceId: source.sourceId,
    sourceTitle: source.title,
    ...(span?.bookFingerprint ? { bookFingerprint: span.bookFingerprint } : {}),
    entryId: option.id,
    kind,
    entryName: option.name,
    ...(part !== undefined ? { part } : {}),
    ...(level !== undefined ? { level } : {}),
    ...(span?.at ? { at: span.at } : {}),
    textHash: copied && span ? textFingerprint(span.text) : '',
    textCopied: copied,
  };
}

/** The n of a chunk id "lib:<sourceId>:<n>" (NaN for other ids). */
export function entryOrdinal(entryId: string): number {
  const last = entryId.slice(entryId.lastIndexOf(':') + 1);
  return /^\d+$/.test(last) ? Number(last) : Number.NaN;
}

/** A TextSpan as a ref's `at`: the block's entry ordinals and its paragraphs. */
export function spanLocation(span: TextSpan): ImportedRef['at'] {
  return { ordinals: span.entryIds.map(entryOrdinal), from: span.from, to: span.to };
}

/** The record kind of an imported option, from its record id "rec:<sourceId>:<kind>:<slug>". */
export function optionKind(option: { source?: OptionSource }, fallback: StructuredKind): StructuredKind {
  const parts = option.source?.recordId.split(':') ?? [];
  const kind = parts[parts.length - 2];
  return (STRUCTURED_KINDS as readonly string[]).includes(kind) ? (kind as StructuredKind) : fallback;
}

/**
 * The book fingerprint a copied part of an imported option carries (its features, traits, lineages or
 * legacy feature, from the option's own book), for option-level refs, which copy no text.
 */
export function optionFingerprint(option: RefOption & object): string | undefined {
  const sourceId = option.source?.sourceId;
  if (!sourceId) return undefined;
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): string | undefined => {
    if (!value || typeof value !== 'object' || depth > 4 || seen.has(value)) return undefined;
    seen.add(value);
    const ref = (value as { ref?: ImportedRef }).ref;
    if (ref?.bookFingerprint && ref.sourceId === sourceId) return ref.bookFingerprint;
    for (const child of Object.values(value)) {
      const found = visit(child, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return visit(option, 0);
}

/** An option-level ref (no text): ClassLevel.ref, subclassRef, speciesRef, backgroundRef. */
export function optionRef(option: RefOption, kind: StructuredKind): ImportedRef | undefined {
  const bookFingerprint = optionFingerprint(option);
  return refFor(option, kind, undefined, undefined, bookFingerprint ? { text: '', bookFingerprint } : undefined);
}
