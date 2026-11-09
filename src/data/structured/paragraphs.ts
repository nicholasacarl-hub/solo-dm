/**
 * Paragraph numbering (spec §3.3, pure), shared by requests, spans, review and restore: every TextSpan's
 * from/to counts the paragraphs this module produces, so its rules are part of the contract.
 *
 * CONTRACT (Day 0 stub). Owner: E2. Until implemented these return safe defaults (no paragraphs, no
 * text) so UI that renders through them doesn't crash; src/test/structuredFixtures.ts documents the
 * numbering its spans assume.
 */
import type { CompendiumEntry, TextSpan } from '@/types';

/** Blank-line blocks; each Markdown list item and each table row (header and separator rows dropped) is its own paragraph; a heading line is its own paragraph. Trimmed; empty ones dropped. */
export function splitParagraphs(text: string): string[] {
  void text;
  return []; // not implemented (Day-0 stub): safe default
}

/** The block text for a span: entries joined by "\n\n", paragraphs from..to joined by "\n\n"; null when it doesn't resolve. */
export function resolveSpan(span: TextSpan, entriesById: ReadonlyMap<string, CompendiumEntry>): string | null {
  void [span, entriesById];
  return null; // not implemented (Day-0 stub): safe default
}

/** A feature's description: resolveSpan, minus a leading heading paragraph and a leading run-in label equal to `name` ("**Dusk Sight.** You…" → "You…"). */
export function featureText(span: TextSpan, name: string, entriesById: ReadonlyMap<string, CompendiumEntry>): string | null {
  void [span, name, entriesById];
  return null; // not implemented (Day-0 stub): safe default
}
