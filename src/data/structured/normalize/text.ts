/**
 * Grounding, span and grading helpers shared by every normalizer (spec §3.9.2): E2 writes them, E4's
 * option normalizers use them. Pure.
 *
 * - groundingForm / grounded: is an excerpt really in the source text (OCR and PDF noise aside)?
 * - spanFromWire / checkSpan: a wire span or a stored TextSpan, resolved and checked against its block.
 * - excerptsOf: every non-empty "…Text" field of a wire object, grounded or not.
 * - gradeConfidence: high / medium / low from the warnings (§3.9.2's rule).
 * - warning helpers with app-written messages (never book text).
 *
 * Owner: E2.
 */
import { nameKey } from '@/lib/id';
import type {
  CompendiumEntry,
  Excerpt,
  RecordConfidence,
  RecordWarning,
  StructuredKind,
  TextSpan,
  WarningCode,
} from '@/types';
import type { CandidateBlock } from '../segment';
import { blockText, splitParagraphs, withoutLevelPrefix } from '../paragraphs';
import type { NormalizeContext, Normalized } from './index';

// ---------------------------------------------------------------------------
// Grounding
// ---------------------------------------------------------------------------

/**
 * The comparison form of a text: NFKC-normalized (ligatures), soft hyphens removed, NBSP → space,
 * Markdown emphasis and heading marks removed, curly quotes straightened, − – — → "-", whitespace
 * collapsed, lowercased.
 */
export function groundingForm(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/­/g, '')
    .replace(/[   ]/g, ' ')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

let lastFull: { text: string; form: string } | null = null;
/** groundingForm of the full text, remembered for the next call (a normalizer grounds many excerpts against one text). */
function fullForm(fullText: string): string {
  if (lastFull?.text !== fullText) lastFull = { text: fullText, form: groundingForm(fullText) };
  return lastFull.form;
}

/** True when the excerpt's grounding form is a substring of the full text's. An empty excerpt is trivially grounded. */
export function grounded(excerpt: string, fullText: string): boolean {
  const needle = groundingForm(excerpt);
  return !needle || fullForm(fullText).includes(needle);
}

/** True when `n` appears in the text as a number of its own ("16", not "160" or "1/16"). */
export function numberInText(n: number, fullText: string): boolean {
  if (!Number.isFinite(n)) return false;
  return new RegExp(`(^|[^\\d/.])${String(n)}(?![\\d/]|\\.\\d)`).test(fullForm(fullText));
}

/** The candidate's full text (all blocks; table header rows included when the block carries its text), the text excerpts are grounded against. */
export function fullTextOf(blocks: readonly CandidateBlock[]): string {
  return blocks.map((b) => b.text ?? b.paragraphs.join('\n\n')).join('\n\n');
}

/** A block's full text (its `text`, or its paragraphs joined when a caller built the block by hand). */
export const blockFullText = (block: CandidateBlock): string => block.text ?? block.paragraphs.join('\n\n');

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

export function warning(code: WarningCode, severity: RecordWarning['severity'], message: string, field?: string): RecordWarning {
  return { code, severity, message, ...(field ? { field } : {}) };
}

/** Quote an app-side value in a message (names and short excerpts only), trimmed. */
export const quote = (text: string, max = 60): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return `“${t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t}”`;
};

/** A "…Text" excerpt that isn't in the source text: `warn` `ungrounded` on the data field it fills. */
export function ungrounded(excerpt: string, dataField: string): RecordWarning {
  return warning('ungrounded', 'warn', `${quote(excerpt)} isn't in the entry's text: check this value.`, dataField);
}

/** "The size" → "The size wasn't found."; a whole sentence (ending in ".") is used as it is. */
export function missing(dataField: string, what: string, severity: RecordWarning['severity'] = 'block'): RecordWarning {
  return warning('missing', severity, what.endsWith('.') ? what : `${what} wasn't found.`, dataField);
}

/** Trim a string to `max` characters; a cut adds a `warn` (spec §2.7). */
export function limitText(text: string, max: number, field: string, warnings: RecordWarning[]): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  warnings.push(warning('cross-check', 'warn', `This was longer than ${max} characters and was shortened.`, field));
  return t.slice(0, max).trimEnd();
}

// ---------------------------------------------------------------------------
// Excerpts
// ---------------------------------------------------------------------------

/**
 * Every non-empty "…Text" string of a wire object (nested lists included, as "items[0].costText"),
 * with whether it is grounded in the full text.
 */
export function excerptsOf(wire: unknown, fullText: string): Excerpt[] {
  const out: Excerpt[] = [];
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) value.forEach((v, i) => visit(v, `${path}[${i}]`));
    else if (value && typeof value === 'object') {
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        const p = path ? `${path}.${key}` : key;
        if (typeof v === 'string') {
          if (key.endsWith('Text') && v.trim()) out.push({ field: p, text: v.trim(), grounded: grounded(v, fullText) });
        } else visit(v, p);
      }
    }
  };
  visit(wire, '');
  return out;
}

// ---------------------------------------------------------------------------
// Spans
// ---------------------------------------------------------------------------

const EMPHASIS_AND_HEADING = (text: string) => text.replace(/^\s*#{1,6}\s+/, '').replace(/[*_`]/g, '').trim();

/** True when `text` starts with `name` under nameKey (a "Level N:" prefix on either removed). */
function startsWithName(text: string, name: string): boolean {
  const target = nameKey(withoutLevelPrefix(name));
  if (!target) return true;
  const head = nameKey(withoutLevelPrefix(EMPHASIS_AND_HEADING(text)).slice(0, name.length + 40));
  return head === target || head.startsWith(`${target}-`);
}

function startWarning(name: string, field: string): RecordWarning {
  return warning('unresolved-text', 'warn', `The text attached to ${quote(name)} doesn't start at its name: check it.`, field);
}

function unresolved(name: string, field: string): RecordWarning {
  return warning('unresolved-text', 'block', `The text attached to ${quote(name)} doesn't point at paragraphs of this entry. Choose its text.`, field);
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
  const id = wire.block.trim();
  if (!id) return { span: null };
  const block = blocks.find((b) => b.id.toLowerCase() === id.toLowerCase());
  const { from, to } = wire;
  if (!block || !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || from > to || to > block.paragraphs.length) {
    return { span: null, warning: unresolved(name, field) };
  }
  const span: TextSpan = { entryIds: [...block.entryIds], from, to };
  const titled = nameKey(withoutLevelPrefix(block.title)) === nameKey(withoutLevelPrefix(name));
  if (!titled && !startsWithName(block.paragraphs[from - 1], name)) return { span, warning: startWarning(name, field) };
  return { span };
}

/**
 * A stored TextSpan checked against the entries (review edits, packs, records read back): `block`
 * `unresolved-text` when it doesn't resolve, `warn` when it doesn't start at `name` (the first entry's
 * title equal to the name counts as a start). Undefined when it is fine.
 */
export function checkSpan(
  span: TextSpan,
  name: string,
  entriesById: ReadonlyMap<string, CompendiumEntry>,
  field: string,
): RecordWarning | undefined {
  const text = span.entryIds.length ? blockText(span.entryIds, entriesById) : null;
  const paragraphs = text === null ? [] : splitParagraphs(text);
  if (text === null || span.from < 1 || span.from > span.to || span.to > paragraphs.length) return unresolved(name, field);
  const title = entriesById.get(span.entryIds[0])?.name.replace(/\s+\(part \d+\)$/, '') ?? '';
  if (nameKey(withoutLevelPrefix(title)) === nameKey(withoutLevelPrefix(name))) return undefined;
  return startsWithName(paragraphs[span.from - 1], name) ? undefined : startWarning(name, field);
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

/**
 * §3.9.2: `high` = matches its kind, no `warn` or `block`, no missing key field, and not a class or
 * subclass; `low` = any `block`, three or more `ungrounded`, or a missing key field; `medium` otherwise.
 * `info` warnings (adaptations, rule defaults, Claude's notes) never lower it.
 */
export function gradeConfidence(
  kind: StructuredKind,
  warnings: readonly RecordWarning[],
  opts: { matchesKind: boolean; missingKey: boolean },
): RecordConfidence {
  const ungroundedCount = warnings.filter((w) => w.code === 'ungrounded').length;
  if (opts.missingKey || !opts.matchesKind || ungroundedCount >= 3 || warnings.some((w) => w.severity === 'block')) return 'low';
  if (warnings.some((w) => w.severity === 'warn') || kind === 'class' || kind === 'subclass') return 'medium';
  return 'high';
}

// ---------------------------------------------------------------------------
// The common start and end of a normalizer (entity kinds; the option kinds have the same in feat.ts)
// ---------------------------------------------------------------------------

export interface NormalizeBase {
  name: string;
  warnings: RecordWarning[];
  excerpts: Excerpt[];
  modelNote?: string;
  fullText: string;
}

/**
 * Name, excerpts grounded against the candidate's full text (an `ungrounded` warning on the data field
 * each one fills, from `fields`), Claude's note, and "not this kind" (`block`).
 */
export function beginNormalize<W extends { matchesKind: boolean; name: string; notes: string }>(
  noun: string,
  wire: W,
  ctx: NormalizeContext,
  fields: Readonly<Record<string, string>>,
): NormalizeBase {
  const warnings: RecordWarning[] = [];
  const fullText = fullTextOf(ctx.blocks);
  const fallback = ctx.blocks[0]?.title ?? '';
  const name = limitText(wire.name.trim() || fallback, 120, 'name', warnings) || fallback;
  const excerpts = excerptsOf(wire, fullText);
  for (const e of excerpts) {
    if (!e.grounded) warnings.push(ungrounded(e.text, fields[e.field.replace(/^items\[\d+\]\./, '')] ?? fields[e.field.split(/[.[]/)[0]] ?? e.field));
  }
  if (!wire.matchesKind) warnings.push(warning('not-this-kind', 'block', `Claude says this isn't ${noun}. Keep it as text, or change what it is.`, 'kind'));
  const modelNote = modelNoteOf(wire.notes);
  if (modelNote) warnings.push(warning('model-note', 'info', 'Claude left a note about this entry.'));
  return { name, warnings, excerpts, ...(modelNote ? { modelNote } : {}), fullText };
}

/** Same code, field and message once. */
export function dedupeWarnings(warnings: readonly RecordWarning[]): RecordWarning[] {
  const seen = new Set<string>();
  return warnings.filter((w) => {
    const key = `${w.code}\u0000${w.field ?? ''}\u0000${w.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The finished result: confidence from the warnings (§3.9.2); a missing key field (offline, or data null) grades low. */
export function finishNormalize<K extends StructuredKind>(
  kind: K,
  base: NormalizeBase,
  data: Normalized<K>['data'],
  adaptations: Normalized<K>['adaptations'],
  opts: { matchesKind: boolean; keyFields: readonly string[]; ctx: NormalizeContext; extra?: readonly RecordWarning[] },
): Normalized<K> {
  const warnings = dedupeWarnings([...base.warnings, ...(opts.extra ?? [])]);
  const missingKey = data === null || (opts.ctx.missing ?? []).some((f) => opts.keyFields.includes(f.replace(/^items\[\d+\]\./, 'items.')) || opts.keyFields.includes(f));
  return {
    data,
    name: base.name,
    warnings,
    adaptations,
    excerpts: base.excerpts,
    confidence: gradeConfidence(kind, warnings, { matchesKind: opts.matchesKind, missingKey }),
    ...(base.modelNote ? { modelNote: base.modelNote } : {}),
  };
}

/** Claude's `notes`, kept as an `info` `model-note` and as the record's modelNote (≤ 300 chars). */
export function modelNoteOf(notes: string): string | undefined {
  const t = notes.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 300) : undefined;
}

/** "monstrosity" → "Monstrosity", "chaotic neutral" → "Chaotic Neutral" (small words lowercase after the first). */
export function titleCase(text: string): string {
  const small = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
  return text
    .trim()
    .split(/\s+/)
    .map((word, i) => (i > 0 && small.has(word.toLowerCase()) ? word.toLowerCase() : word.replace(/(^|[-(])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase())))
    .join(' ');
}
