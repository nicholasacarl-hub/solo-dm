/**
 * Paragraph numbering (spec §3.3, pure), shared by requests, spans, review and restore: every TextSpan's
 * from/to counts the paragraphs this module produces, so its rules are part of the contract.
 *
 * splitParagraphs: blank-line blocks; each Markdown list item and each table row is its own paragraph
 * (a table's header row and its separator row are dropped); a heading line is its own paragraph;
 * paragraphs are trimmed and empty ones dropped. A plain line directly after a list item or a table row
 * starts a new paragraph (src/test/structuredFixtures.test.ts reads the rule the same way).
 *
 * Owner: E2.
 */
import { nameKey } from '@/lib/id';
import type { CompendiumEntry, TextSpan } from '@/types';

const HEADING = /^ {0,3}#{1,6}\s/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
/** A GFM delimiter row ("|---|:--:|"): every cell hyphens with optional colons, at least one cell longer than "-". */
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
export const isDelimiterRow = (line: string): boolean => TABLE_SEPARATOR.test(line) && /(?:^|\|)\s*(?::-|--|-:)/.test(line);
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;

const isSeparator = (line: string | undefined) => line !== undefined && isDelimiterRow(line);

interface Paragraph {
  text: string;
  /** For a table's first body row: its header and separator lines (requests only). */
  tableHead?: string;
}

function paragraphsOf(text: string): Paragraph[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: Paragraph[] = [];
  let current: string[] = [];
  let pendingHead: string | undefined;
  const flush = () => {
    const joined = current.join('\n').trim();
    if (joined) out.push({ text: joined });
    current = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      flush();
      pendingHead = undefined;
    } else if (HEADING.test(line)) {
      flush();
      pendingHead = undefined;
      out.push({ text: line.trim() });
    } else if (TABLE_ROW.test(line)) {
      flush();
      if (isSeparator(line)) continue;
      if (isSeparator(lines[i + 1])) {
        // A header row: dropped from the numbering, remembered for the request text of the first body row.
        pendingHead = `${line.trim()}\n${lines[i + 1].trim()}`;
        continue;
      }
      out.push({ text: line.trim(), ...(pendingHead ? { tableHead: pendingHead } : {}) });
      pendingHead = undefined;
    } else if (LIST_ITEM.test(line)) {
      flush();
      pendingHead = undefined;
      out.push({ text: line.trim() });
    } else {
      pendingHead = undefined;
      current.push(line);
    }
  }
  flush();
  return out;
}

/** Blank-line blocks; each Markdown list item and each table row (header and separator rows dropped) is its own paragraph; a heading line is its own paragraph. Trimmed; empty ones dropped. */
export function splitParagraphs(text: string): string[] {
  return paragraphsOf(text).map((p) => p.text);
}

/**
 * The paragraphs a request shows Claude: exactly splitParagraphs' numbering, except that a table's first
 * body row carries the table's header and separator lines above it, so the columns can be read. Spans
 * and every other consumer use splitParagraphs.
 */
export function requestParagraphs(text: string): string[] {
  return paragraphsOf(text).map((p) => (p.tableHead ? `${p.tableHead}\n${p.text}` : p.text));
}

/** The texts of a block's entries joined by "\n\n" (null when one is missing). */
export function blockText(entryIds: readonly string[], entriesById: ReadonlyMap<string, CompendiumEntry>): string | null {
  const texts: string[] = [];
  for (const id of entryIds) {
    const entry = entriesById.get(id);
    if (!entry) return null;
    texts.push(entry.text);
  }
  return texts.join('\n\n');
}

/** The paragraphs from..to of a span's block, or null when the span doesn't resolve. */
function spanParagraphs(span: TextSpan, entriesById: ReadonlyMap<string, CompendiumEntry>): string[] | null {
  if (!span.entryIds.length || !Number.isInteger(span.from) || !Number.isInteger(span.to)) return null;
  const text = blockText(span.entryIds, entriesById);
  if (text === null) return null;
  const paragraphs = splitParagraphs(text);
  if (span.from < 1 || span.from > span.to || span.to > paragraphs.length) return null;
  return paragraphs.slice(span.from - 1, span.to);
}

/** The block text for a span: entries joined by "\n\n", paragraphs from..to joined by "\n\n"; null when it doesn't resolve. */
export function resolveSpan(span: TextSpan, entriesById: ReadonlyMap<string, CompendiumEntry>): string | null {
  return spanParagraphs(span, entriesById)?.join('\n\n') ?? null;
}

/** Emphasis and inline-code marks removed, whitespace collapsed. */
const plainLabel = (text: string) => text.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
/** "Level 3: Ember Ward" → "Ember Ward". */
export const withoutLevelPrefix = (name: string) => name.replace(/^\s*Level\s+\d{1,2}\s*:\s*/i, '');

/** The end of a run-in label: ". " / ": " (emphasis may close after it) or emphasis closing before the period. */
const RUN_IN_END = /[.:][*_]*[ \t]+|[*_]+[.:][ \t]+/;

/**
 * A paragraph without its leading run-in label when the label equals `name` (case and punctuation
 * aside, a "Level N:" prefix allowed): "_**Dusk Sight.**_ You…", "***Dusk Sight.*** You…",
 * "**Dusk Sight.** You…" and the flattened "Dusk Sight. You…" all become "You…". Otherwise unchanged.
 */
export function stripRunInLabel(paragraph: string, name: string): string {
  const head = paragraph.slice(0, 200);
  const lead = /^[*_]{0,3}[ \t]*(?:Level[ \t]+\d{1,2}[ \t]*:[ \t]*)?/i.exec(head)?.[0] ?? '';
  const end = RUN_IN_END.exec(head.slice(lead.length));
  if (!end) return paragraph;
  const label = plainLabel(head.slice(lead.length, lead.length + end.index));
  const target = nameKey(withoutLevelPrefix(name));
  if (!label || !target || nameKey(label) !== target) return paragraph;
  return paragraph.slice(lead.length + end.index + end[0].length).trimStart();
}

/** A feature's description: resolveSpan, minus a leading heading paragraph and a leading run-in label equal to `name` ("**Dusk Sight.** You…" → "You…"). */
export function featureText(span: TextSpan, name: string, entriesById: ReadonlyMap<string, CompendiumEntry>): string | null {
  const paragraphs = spanParagraphs(span, entriesById);
  if (!paragraphs) return null;
  const rest = HEADING.test(paragraphs[0] ?? '') ? paragraphs.slice(1) : [...paragraphs];
  if (rest.length) rest[0] = stripRunInLabel(rest[0], name);
  return rest.filter(Boolean).join('\n\n');
}
