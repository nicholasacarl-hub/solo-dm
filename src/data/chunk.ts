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
/** "Origin Feat", "General Feat (Prerequisite: Level 4+)" or "Prerequisite: ..." as a line of its own. */
const FEAT_LINE = /^(?:(?:Origin|General|Fighting Style|Epic Boon)\s+)?Feat\b(?:\s*\(.*\))?$|^Prerequisites?:/i;
/** "Alert (Origin Feat)" or "Feat: Alert". */
const FEAT_NAME = /\((?:(?:Origin|General|Fighting Style|Epic Boon)\s+)?Feat\)$|^Feat:/i;
const SIZE_LINE = /^(?:Tiny|Small|Medium|Large|Huge|Gargantuan)\b/i;

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

/**
 * Guess what a piece of rules text is: a spell ("Casting Time" or "Level 3 Evocation"), a monster
 * (AC, HP and CR/Challenge), a magic item (an item category with a rarity), a feat ("Origin Feat",
 * a prerequisite), or otherwise a rule.
 */
export function guessKind(name: string, text: string): ContentKind {
  const head = text.slice(0, 2000);
  const top = leadingLines(text, 2).join('\n');
  if (CASTING_TIME.test(head.slice(0, 800)) || SPELL_LINE.test(top)) return 'spell';
  if (ARMOR_CLASS.test(head) && HIT_POINTS.test(head) && CHALLENGE.test(head)) return 'monster';
  if (ITEM_LINE.test(top)) return 'magic-item';
  if (FEAT_NAME.test(name.trim()) || leadingLines(text, 2).some((l) => FEAT_LINE.test(l))) return 'feat';
  return 'rule';
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
  add(name: string, text: string, ancestors: string[], kind = guessKind(name, text)): void {
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
  const kind = guessKind(title, body);
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
