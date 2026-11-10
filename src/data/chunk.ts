/**
 * Splitting imported text into searchable compendium entries, and guessing what each entry is.
 * Pure functions (no I/O): used by the import pipeline, previews and tests.
 *
 * - Markdown headings (ATX "## Name" or setext) start entries; the heading stack becomes `path`.
 * - Spells, monsters, magic items and feats stay whole: their subsections ("Actions"...) belong
 *   to the same entry. Rules sections longer than MAX_RULE_CHARS are split into parts.
 * - Plain text without Markdown headings gets short title-like lines promoted to headings when
 *   there are several of them (pasted book text); otherwise it is cut into ~1500-character chunks
 *   at paragraph boundaries.
 */
import type { CompendiumEntry, ContentKind } from '@/types';
import { stripInlineMarkdown } from './text';

export const MAX_RULE_CHARS = 4000;
const MAX_ENTITY_CHARS = 12000;
export const TARGET_CHUNK_CHARS = 1500;
const MAX_SUMMARY_CHARS = 160;

// ---------------------------------------------------------------------------
// Kind guessing
// ---------------------------------------------------------------------------

const SCHOOLS = 'Abjuration|Conjuration|Divination|Enchantment|Evocation|Illusion|Necromancy|Transmutation';
const SPELL_LINE = new RegExp(
  `\\b(?:Level ([1-9]) (${SCHOOLS})|(${SCHOOLS}) Cantrip|([1-9])(?:st|nd|rd|th)[- ]level (${SCHOOLS}))\\b`,
  'i',
);
const CASTING_TIME = /^[\W_]*Casting Time\b/im;
const ARMOR_CLASS = /\b(?:AC|Armor Class)\b[^\n\d]{0,6}\d+/;
const HIT_POINTS = /\b(?:HP|Hit Points)\b[^\n\d]{0,6}\d+/;
const CHALLENGE = /\b(?:CR|Challenge)\b[^\n\d]{0,6}(\d+(?:\/\d+)?)/;
const RARITY = /\b(very rare|uncommon|common|rare|legendary|artifact|rarity varies)\b/i;
const ITEM_LINE = new RegExp(
  `\\b(?:Wondrous Item|Weapon|Armor|Ring|Rod|Staff|Wand|Potion|Scroll|Shield)\\b[^\\n]{0,80}?${RARITY.source}`,
  'i',
);
/** "Origin Feat" or "General Feat (Prerequisite: Level 4+)" as a line of its own. */
const FEAT_CATEGORY_LINE = /^(?:(?:Origin|General|Fighting Style|Epic Boon)\s+)?Feat\b(?:\s*\(.*\))?$/i;
/** "Prerequisite: ..." as a line of its own. */
const PREREQUISITE_LINE = /^Prerequisites?:/i;
/** Either of them: the line a feat's summary comes from. */
const FEAT_LINE = new RegExp(`${FEAT_CATEGORY_LINE.source}|${PREREQUISITE_LINE.source}`, 'i');
/** "Alert (Origin Feat)" or "Feat: Alert". */
const FEAT_NAME = /\((?:(?:Origin|General|Fighting Style|Epic Boon)\s+)?Feat\)$|^Feat:/i;
/**
 * A heading that names feats: one that ends with the word ("Feats", "Racial Feats", "Chapter 5: Feats",
 * "List of Feats:"), or the word with a qualifier ("Feat Descriptions", "Feats (Optional)"). Not a title
 * that only starts with it ("Feats of the North", "Feats and Fortresses"), and never "Features".
 */
const FEATS_HEADING = /\bFeats?[:.]?$|^Feats?(?: Descriptions?| Lists?)?(?: \([^)]*\))?[:.]?$/i;
const SIZE_LINE = /^(?:Tiny|Small|Medium|Large|Huge|Gargantuan)\b/i;

/*
 * A bare Prerequisite line. Older books print feats with only a "Prerequisite: …" line before their text,
 * and print other things that way too. These signs say an entry is not a feat (headings can't decide it:
 * PDF, photo and pasted-text imports often lose or merge them):
 * - a line before the Prerequisite line (a type line such as "Level 5 Stronghold Room");
 * - "Prerequisite: None" (a feat without one prints none);
 * - a prerequisite that names a class level or a warlock pact, as class options do ("Level 5+ Warlock",
 *   "6th-level artificer", "Pact of the Blade feature");
 * - other labelled lines right after it, as a stat block has ("Item: …", "Space: …", "Order: …").
 * Under a heading that names feats, none of these matter.
 */
const PREREQUISITE_NONE = /^Prerequisites?:\s*(?:None|—|-|n\/a)\.?$/i;
const CLASS_OPTION_PREREQUISITE = /\bLevel \d{1,2}\+ [A-Z][a-z]+|\b\d{1,2}(?:st|nd|rd|th)[- ]level\b|\bPact of the\b/i;
/** "Item: A pair of boots", "Space: Roomy": a short label, a colon and a value. */
const LABEL_LINE = /^[\p{Lu}][\p{L}' ]{1,24}:\s*\S/u;
/** Labels a feat's own text may start with (not signs of a stat block). */
const FEAT_LABELS = /^(?:Repeatable|Benefits?|Ability Score Increase|Special|Normal)\b/i;
/** A label inside the Prerequisite line itself, when a PDF joined two labelled lines ("Prerequisite: None Space: Roomy"). */
const JOINED_LABEL = /\s[\p{Lu}][\p{L}']{1,24}:\s/u;

/** Whether one of the headings above an entry names feats (where older books print feats with only a Prerequisite line). */
export function underFeatsHeading(ancestors: readonly string[]): boolean {
  return ancestors.some((title) => FEATS_HEADING.test(stripInlineMarkdown(title).trim()));
}

/**
 * The headings above an entry from its stored path. Imports store the entry's own name last
 * (["Feats", "Night Walker"]); a JSON file may list only the headings above it, which are kept whole.
 */
export function headingAncestors(path: readonly string[] | undefined, name: string): string[] {
  if (!path?.length) return [];
  const last = stripInlineMarkdown(path[path.length - 1]).trim().toLowerCase();
  return last === stripInlineMarkdown(name).trim().toLowerCase() ? path.slice(0, -1) : [...path];
}

/** Headings that are part of a stat block, never entries of their own. */
const STAT_BLOCK_SECTIONS = new Set(
  ['traits', 'actions', 'bonus actions', 'reactions', 'legendary actions', 'lair actions', 'mythic actions', 'regional effects'],
);
const isStatBlockSection = (title: string) => STAT_BLOCK_SECTIONS.has(stripInlineMarkdown(title).toLowerCase());

/** The first `n` non-empty lines, without Markdown emphasis or list markers. */
function leadingLines(text: string, n: number): string[] {
  return text
    .split('\n')
    .map((l) => stripInlineMarkdown(l.replace(/^\s*(?:[-*+]\s+|>\s*)/, '')))
    .filter(Boolean)
    .slice(0, n);
}

/** Whether a bare Prerequisite line in the first two lines makes this text a feat (see the signs above). */
function prerequisiteFeat(text: string, ancestors: readonly string[]): boolean {
  const lines = leadingLines(text, 4);
  const at = lines.slice(0, 2).findIndex((l) => PREREQUISITE_LINE.test(l));
  if (at < 0) return false;
  if (underFeatsHeading(ancestors)) return true;
  const line = lines[at];
  if (at > 0 || PREREQUISITE_NONE.test(line) || CLASS_OPTION_PREREQUISITE.test(line)) return false;
  if (JOINED_LABEL.test(line.replace(PREREQUISITE_LINE, ''))) return false;
  return !lines.slice(1, 3).some((l) => LABEL_LINE.test(l) && !FEAT_LABELS.test(l) && !PREREQUISITE_LINE.test(l));
}

/**
 * Guess what a piece of rules text is: a spell ("Casting Time" or "Level 3 Evocation"), a monster
 * (AC, HP and CR/Challenge), a magic item (an item category with a rarity), a feat, or otherwise a rule.
 *
 * A feat has a category line ("Origin Feat", "General Feat (Prerequisite: Level 4+)"), a name that says
 * so ("Alert (Origin Feat)"), or a bare Prerequisite line that nothing marks as something else (see the
 * signs above). `ancestors`: the headings above the entry, outermost first.
 */
export function guessKind(name: string, text: string, ancestors: readonly string[] = []): ContentKind {
  const head = text.slice(0, 2000);
  const lines = leadingLines(text, 2);
  const top = lines.join('\n');
  if (CASTING_TIME.test(head.slice(0, 800)) || SPELL_LINE.test(top)) return 'spell';
  if (ARMOR_CLASS.test(head) && HIT_POINTS.test(head) && CHALLENGE.test(head)) return 'monster';
  if (ITEM_LINE.test(top)) return 'magic-item';
  if (FEAT_NAME.test(name.trim()) || lines.some((l) => FEAT_CATEGORY_LINE.test(l))) return 'feat';
  if (prerequisiteFeat(text, ancestors)) return 'feat';
  return 'rule';
}

/**
 * Whether the first version of guessKind (PARSER_VERSION 1) read this text as a feat that today's
 * rules don't: it took any Prerequisite line in the first two lines for a feat. Only its own text
 * counts (before its first subsection), as at import.
 */
export function misreadAsFeatBefore(name: string, text: string, ancestors: readonly string[]): boolean {
  const body = ownBody(text);
  return guessKind(name, body, ancestors) === 'rule' && leadingLines(body, 2).some((l) => PREREQUISITE_LINE.test(l));
}

function summaryLine(text: string, pattern: RegExp): string | undefined {
  const line = leadingLines(text, 3).find((l) => pattern.test(l));
  return line ? clip(line) : undefined;
}

const clip = (s: string) => (s.length <= MAX_SUMMARY_CHARS ? s : `${s.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…`);

function summarize(kind: ContentKind, text: string, path: string[] | undefined): string | undefined {
  switch (kind) {
    case 'spell':
      return summaryLine(text, SPELL_LINE);
    case 'monster': {
      const cr = CHALLENGE.exec(text)?.[1];
      const descriptor = leadingLines(text, 3).find((l) => SIZE_LINE.test(l))?.split(',')[0];
      return [cr ? `CR ${cr}` : undefined, descriptor].filter(Boolean).join(' · ') || undefined;
    }
    case 'magic-item':
      return summaryLine(text, ITEM_LINE);
    case 'feat':
      return summaryLine(text, FEAT_LINE);
    default:
      return path && path.length > 1 ? clip(path.slice(0, -1).join(' › ')) : undefined;
  }
}

function dataFor(kind: ContentKind, text: string): Record<string, unknown> | undefined {
  if (kind === 'spell') {
    const line = leadingLines(text, 3).find((l) => SPELL_LINE.test(l)) ?? '';
    const m = SPELL_LINE.exec(line);
    if (!m) return undefined;
    const level = Number(m[1] ?? m[4] ?? 0);
    const school = m[2] ?? m[3] ?? m[5];
    const classes = /\(([^)]+)\)\s*$/.exec(line)?.[1].split(/,\s*/).filter(Boolean);
    return { level, school: school.charAt(0).toUpperCase() + school.slice(1).toLowerCase(), ...(classes?.length ? { classes } : {}) };
  }
  if (kind === 'monster') {
    const cr = CHALLENGE.exec(text)?.[1];
    return cr ? { cr } : undefined;
  }
  if (kind === 'magic-item') {
    const rarity = RARITY.exec(leadingLines(text, 2).join(' '))?.[1].toLowerCase();
    return rarity ? { rarity } : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

interface Section {
  level: number;
  title: string;
  lines: string[];
  children: Section[];
}

const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^ {0,3}(```|~~~)/;

function normalize(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
}

/** Parse ATX and setext headings into a tree (root level 0 holds text before the first heading). */
function parseSections(text: string): { root: Section; headings: number } {
  const root: Section = { level: 0, title: '', lines: [], children: [] };
  const stack: Section[] = [root];
  const lines = text.split('\n');
  let inFence = false;
  let headings = 0;
  const open = (level: number, title: string) => {
    const node: Section = { level, title, lines: [], children: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
    headings += 1;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) inFence = !inFence;
    const atx = inFence ? null : ATX_HEADING.exec(line);
    if (atx) {
      open(atx[1].length, atx[2]);
      continue;
    }
    const next = lines[i + 1];
    const prev = i > 0 ? lines[i - 1] : '';
    const setext = !inFence && next !== undefined && /^ {0,3}(=+|-+)\s*$/.test(next) && isSetextTitle(line, prev);
    if (setext) {
      open(next.trim().startsWith('=') ? 1 : 2, line.trim());
      i += 1;
      continue;
    }
    stack[stack.length - 1].lines.push(line);
  }
  return { root, headings };
}

/** A setext heading's text: one non-empty line after a blank line (not a list item or table row). */
function isSetextTitle(line: string, prev: string): boolean {
  const t = line.trim();
  return t !== '' && prev.trim() === '' && !/^(?:[-*+]\s|\d+[.)]\s|\||>)/.test(t);
}

const bodyOf = (node: Section) => node.lines.join('\n').trim();

/** A section's text with its descendants; descendant headings are re-leveled to start at ###. */
function renderSection(node: Section, depth = 0): string {
  const parts: string[] = [];
  if (depth > 0) parts.push(`${'#'.repeat(Math.min(6, depth + 2))} ${node.title}`);
  const body = bodyOf(node);
  if (body) parts.push(body);
  for (const child of node.children) parts.push(renderSection(child, depth + 1));
  return parts.join('\n\n').trim();
}

// ---------------------------------------------------------------------------
// Plain-text heading inference
// ---------------------------------------------------------------------------

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'vs', 'with']);

function looksLikeTitle(line: string, prev: string | undefined): boolean {
  const t = line.trim();
  if (t.length < 3 || t.length > 70) return false;
  if (/[.,;:!?]$/.test(t) || /^(?:[-*+•]\s|\d+[.)]\s|\||>)/.test(t)) return false;
  if (t.includes(':') && !/^(?:chapter|part|appendix|book)\b/i.test(t)) return false;
  if (!/^[\p{Lu}\d]/u.test(t) || isStatBlockSection(t)) return false;
  const words = t.split(/\s+/);
  if (words.length > 9) return false;
  const significant = words.filter((w) => /\p{L}/u.test(w) && !SMALL_WORDS.has(w.toLowerCase()));
  if (!significant.length) return false;
  const capitalized = significant.filter((w) => /^[("'‘“]?[\p{Lu}\d]/u.test(w)).length;
  if (capitalized / significant.length < 0.75) return false;
  const before = prev?.trim() ?? '';
  // A heading follows a blank line, or the end of a paragraph when the text has no blank lines.
  return before === '' || (before.length > 70 && /[.!?)"”]$/.test(before));
}

/** Promote title-like lines of plain text to "## " headings; null when fewer than two are found. */
export function inferPlainTextHeadings(text: string): string | null {
  const lines = text.split('\n');
  const marked = lines.map((line, i) => looksLikeTitle(line, i > 0 ? lines[i - 1] : undefined));
  if (marked.filter(Boolean).length < 2) return null;
  return lines.map((line, i) => (marked[i] ? `## ${line.trim()}` : line)).join('\n');
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/** Split text into parts of about `target` characters at paragraph (then sentence) boundaries. */
export function splitIntoChunks(text: string, target = TARGET_CHUNK_CHARS): string[] {
  const pieces: string[] = [];
  for (const para of text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    if (para.length <= target * 2) {
      pieces.push(para);
      continue;
    }
    // One huge paragraph: cut at sentence ends (or hard, for text without punctuation).
    let rest = para;
    while (rest.length > target) {
      const window = rest.slice(0, target);
      const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
      const at = cut > target * 0.3 ? cut + 1 : Math.max(window.lastIndexOf(' '), Math.floor(target * 0.5));
      pieces.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) pieces.push(rest);
  }
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > target) {
      chunks.push(current);
      current = piece;
    } else current = current ? `${current}\n\n${piece}` : piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

interface ChunkOptions {
  sourceId: string;
  sourceName: string;
}

class EntryBuilder {
  readonly entries: CompendiumEntry[] = [];
  constructor(private readonly opts: ChunkOptions) {}

  /** Add an entry (split into numbered parts when too long). */
  add(name: string, text: string, ancestors: string[], kind = guessKind(name, text, ancestors)): void {
    const max = kind === 'rule' ? MAX_RULE_CHARS : MAX_ENTITY_CHARS;
    const parts = text.length > max ? splitIntoChunks(text) : [text];
    parts.forEach((part, i) => {
      const partName = i === 0 ? name : `${name} (part ${i + 1})`;
      const path = ancestors.length ? [...ancestors, partName] : undefined;
      const summary = summarize(kind, part, path);
      const data = dataFor(kind, part);
      this.entries.push({
        id: `lib:${this.opts.sourceId}:${this.entries.length + 1}`,
        sourceId: this.opts.sourceId,
        sourceName: this.opts.sourceName,
        kind,
        name: partName,
        ...(summary ? { summary } : {}),
        text: part,
        ...(path ? { path } : {}),
        ...(data ? { data } : {}),
      });
    });
  }
}

/** Entries for a heading subtree. Entities keep their subsections; rules sections recurse. */
function addSection(node: Section, ancestors: string[], out: EntryBuilder): void {
  const title = stripInlineMarkdown(node.title) || 'Untitled';
  const body = bodyOf(node);
  const kind = guessKind(title, body, ancestors);
  if (kind !== 'rule') {
    out.add(title, renderSection(node), ancestors, kind);
    return;
  }
  const statBlockParts = node.children.filter((c) => isStatBlockSection(c.title));
  const ownText = renderSection({ ...node, children: statBlockParts });
  if (ownText) out.add(title, ownText, ancestors);
  for (const child of node.children) {
    if (!statBlockParts.includes(child)) addSection(child, [...ancestors, title], out);
  }
}

/** Split Markdown or plain text into compendium entries (ids "lib:<sourceId>:<n>"). */
export function chunkDocument(text: string, opts: ChunkOptions): CompendiumEntry[] {
  const out = new EntryBuilder(opts);
  const normalized = normalize(text).trim();
  if (!normalized) return out.entries;
  let parsed = parseSections(normalized);
  if (parsed.headings === 0) {
    const inferred = inferPlainTextHeadings(normalized);
    if (inferred) parsed = parseSections(inferred);
  }
  const { root, headings } = parsed;
  if (headings === 0) {
    const chunks = splitIntoChunks(normalized);
    chunks.forEach((chunk, i) => {
      out.add(chunks.length === 1 ? opts.sourceName : `${opts.sourceName} (part ${i + 1})`, chunk, []);
    });
    return out.entries;
  }
  const preamble = bodyOf(root);
  if (preamble) out.add(opts.sourceName, preamble, []);
  for (const child of root.children) addSection(child, [], out);
  return out.entries;
}

// ---------------------------------------------------------------------------
// Kinds an older version guessed
// ---------------------------------------------------------------------------

const PART_NAME = /^(.*) \(part (\d+)\)$/;

/** An entity entry's own text: what its stored text holds before its first subsection (renderSection re-levels those to ### and deeper). */
export function ownBody(text: string): string {
  return text.split(/\n(?=#{3,6}[ \t])/)[0];
}

/** A corrected kind for a stored entry, with the summary that kind gives (none = no summary). */
export interface KindCorrection {
  id: string;
  kind: ContentKind;
  summary?: string;
}

/** The n of "lib:<sourceId>:<n>" (Infinity for any other id). */
function ordinal(id: string): number {
  const n = Number(id.slice(id.lastIndexOf(':') + 1));
  return Number.isInteger(n) && n >= 0 ? n : Number.POSITIVE_INFINITY;
}

/**
 * Corrections for kinds the first version of guessKind stored (kinds are guessed once, at import;
 * src/data/structured/staleKinds.ts applies these): an entry stored as a feat only because of a bare
 * Prerequisite line that today's rules read as something else (misreadAsFeatBefore) gets the kind and
 * summary guessKind gives now. A long entry's "(part N)" continuations follow their first part. Pure.
 * `entries`: one source's entries (all of them, or only those stored as feats), in any order.
 */
export function staleFeatKinds(entries: readonly CompendiumEntry[]): KindCorrection[] {
  const out: KindCorrection[] = [];
  let head: { name: string; parent: string; kind: ContentKind | null } | null = null;
  const correction = (entry: CompendiumEntry, kind: ContentKind): KindCorrection => {
    const summary = summarize(kind, entry.text, entry.path);
    return { id: entry.id, kind, ...(summary ? { summary } : {}) };
  };
  const ordered = entries.map((entry, index) => ({ entry, index })).sort((a, b) => ordinal(a.entry.id) - ordinal(b.entry.id) || a.index - b.index);
  for (const { entry } of ordered) {
    const ancestors = (entry.path ?? []).slice(0, -1);
    const parent = ancestors.join('\u0000');
    const part = PART_NAME.exec(entry.name);
    if (part && head && part[1] === head.name && parent === head.parent) {
      if (head.kind && entry.kind === 'feat') out.push(correction(entry, head.kind));
      continue;
    }
    head = { name: entry.name, parent, kind: null };
    if (entry.kind !== 'feat' || !misreadAsFeatBefore(entry.name, entry.text, ancestors)) continue;
    const kind = guessKind(entry.name, ownBody(entry.text), ancestors);
    head.kind = kind;
    out.push(correction(entry, kind));
  }
  return out;
}
