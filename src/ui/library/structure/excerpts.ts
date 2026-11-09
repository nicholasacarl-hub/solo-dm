/**
 * Excerpt highlighting for the review's source pane (spec §2.8, §3.9.2, §4.4): find each excerpt a field
 * used in the book's text and cut the text into plain slices, some of them marked. Rendering builds
 * <mark> elements from these slices — never raw HTML.
 *
 * Matching follows the normalizer's grounding rules (NFKC, soft hyphens dropped, NBSP → space, Markdown
 * emphasis and heading marks dropped, curly quotes straightened, −–— → -, whitespace collapsed,
 * lowercased), with a map back to the displayed text so the marks land on the original characters.
 */
import type { Excerpt } from '@/types';

/** A source paragraph as the review shows it: heading marks, list bullets, emphasis and table pipes removed. */
export function plainParagraph(paragraph: string): string {
  let text = paragraph.trim();
  if (/^\|.*\|$/.test(text)) {
    text = text
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(' · ');
  }
  return text
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_](?=\S)(.+?)(?<=\S)[*_](?![\w*])/g, '$1$2')
    .replace(/\*{2,}/g, '');
}

const QUOTES: Readonly<Record<string, string>> = { '‘': "'", '’': "'", '‚': "'", '‛': "'", '“': '"', '”': '"', '„': '"', '‟': '"' };
const DASHES = new Set(['−', '–', '—', '‒', '‐', '‑']);
const SKIP = new Set(['­', '*', '_', '#']);

interface Normalized {
  text: string;
  /** For each character of `text`, the index in the source string it came from. */
  map: number[];
}

/** Normalize for matching, remembering where each character came from. */
function normalizeWithMap(source: string): Normalized {
  let text = '';
  const map: number[] = [];
  const push = (ch: string, at: number) => {
    if (ch === ' ') {
      if (text === '' || text.endsWith(' ')) return;
    }
    text += ch;
    map.push(at);
  };
  for (let i = 0; i < source.length; i += 1) {
    const raw = source[i];
    if (SKIP.has(raw)) continue;
    if (/\s/.test(raw) || raw === ' ') {
      push(' ', i);
      continue;
    }
    if (DASHES.has(raw)) {
      push('-', i);
      continue;
    }
    const quoted = QUOTES[raw];
    if (quoted) {
      push(quoted, i);
      continue;
    }
    for (const ch of raw.normalize('NFKC').toLowerCase()) push(ch, i);
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    map.pop();
  }
  return { text, map };
}

/** Where an excerpt sits in a text (start inclusive, end exclusive), or null. */
export function findExcerpt(text: string, excerpt: string): { start: number; end: number } | null {
  const needle = normalizeWithMap(excerpt).text;
  if (!needle) return null;
  const hay = normalizeWithMap(text);
  const at = hay.text.indexOf(needle);
  if (at < 0) return null;
  return { start: hay.map[at], end: hay.map[at + needle.length - 1] + 1 };
}

export interface Highlight {
  start: number;
  end: number;
  /** The wire fields that used these words. */
  fields: string[];
}

/** Every excerpt found in a text, overlapping ones merged. */
export function highlightsIn(text: string, excerpts: readonly Excerpt[]): Highlight[] {
  const found: Highlight[] = [];
  for (const e of excerpts) {
    if (!e.text.trim()) continue;
    const at = findExcerpt(text, e.text);
    if (at) found.push({ ...at, fields: [e.field] });
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Highlight[] = [];
  for (const h of found) {
    const last = merged[merged.length - 1];
    if (last && h.start < last.end) {
      last.end = Math.max(last.end, h.end);
      for (const f of h.fields) if (!last.fields.includes(f)) last.fields.push(f);
    } else merged.push({ ...h, fields: [...h.fields] });
  }
  return merged;
}

export interface Slice {
  text: string;
  highlight?: Highlight;
}

/** The text cut at the highlights: plain slices and marked ones, in order. */
export function slicesOf(text: string, highlights: readonly Highlight[]): Slice[] {
  const out: Slice[] = [];
  let at = 0;
  for (const h of highlights) {
    if (h.start < at) continue;
    if (h.start > at) out.push({ text: text.slice(at, h.start) });
    out.push({ text: text.slice(h.start, h.end), highlight: h });
    at = h.end;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** Excerpts no paragraph contains: listed under the text, so a misread is still visible. */
export function unplacedExcerpts(paragraphs: readonly string[], excerpts: readonly Excerpt[]): Excerpt[] {
  return excerpts.filter((e) => e.text.trim() && !paragraphs.some((p) => findExcerpt(p, e.text)));
}
