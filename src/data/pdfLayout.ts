/**
 * PDF text layout to Markdown (pure): groups positioned text runs into lines and paragraphs, and
 * turns lines in a noticeably larger font into headings. When a PDF has no usable font-size
 * structure, each page becomes a "## Page N" section instead.
 */

/** One run of text from a PDF page (pdf.js TextItem, simplified). */
export interface PdfTextRun {
  str: string;
  /** Left edge and baseline, in PDF units (y grows upward). */
  x: number;
  y: number;
  width: number;
  fontSize: number;
  hasEOL: boolean;
}

interface Line {
  text: string;
  y: number;
  fontSize: number;
  page: number;
}

const HEADING_RATIO = 1.15;
const MAX_HEADING_CHARS = 90;
const MAX_HEADING_SHARE = 0.4;

/** Group a page's runs into lines (new line on hasEOL or a baseline jump). */
function pageLines(runs: PdfTextRun[], page: number): Line[] {
  const lines: Line[] = [];
  let current: { parts: string[]; y: number; sizes: Map<number, number>; lastEnd: number } | null = null;
  const flush = () => {
    if (!current) return;
    const text = current.parts.join('').replace(/\s+/g, ' ').trim();
    // The line's size is the size most of its characters use.
    let fontSize = 0;
    let most = -1;
    for (const [size, chars] of current.sizes) if (chars > most) [fontSize, most] = [size, chars];
    if (text) lines.push({ text, y: current.y, fontSize, page });
    current = null;
  };
  for (const run of runs) {
    if (!run.str) {
      if (run.hasEOL) flush();
      continue;
    }
    if (current && Math.abs(run.y - current.y) > Math.max(2, run.fontSize * 0.5)) flush();
    if (!current) current = { parts: [], y: run.y, sizes: new Map(), lastEnd: run.x };
    const gap = run.x - current.lastEnd;
    const last = current.parts[current.parts.length - 1];
    if (last !== undefined && gap > run.fontSize * 0.15 && !/\s$/.test(last) && !/^\s/.test(run.str)) current.parts.push(' ');
    current.parts.push(run.str);
    const size = roundSize(run.fontSize);
    current.sizes.set(size, (current.sizes.get(size) ?? 0) + run.str.trim().length);
    current.lastEnd = run.x + run.width;
    if (run.hasEOL) flush();
  }
  flush();
  return lines;
}

const roundSize = (n: number) => Math.round(n * 2) / 2;

/** The font size most body text uses (weighted by characters). */
function bodySize(lines: Line[]): number {
  const weight = new Map<number, number>();
  for (const l of lines) weight.set(roundSize(l.fontSize), (weight.get(roundSize(l.fontSize)) ?? 0) + l.text.length);
  let best = 0;
  let bestWeight = -1;
  for (const [size, w] of weight) if (w > bestWeight) [best, bestWeight] = [size, w];
  return best;
}

/** A stat block's labelled line ("Speed 30 ft.", "Languages None", "AC 15"): never a running header. */
const STAT_LINE = /^(?:AC|HP|CR|Speed|Senses|Languages|Skills|Saving Throws|Immunities|Resistances|Initiative)\b/;
/** An item's type line ("Wondrous Item, Uncommon"): one item to a page repeats it at the top of each. */
const ITEM_TYPE_LINE = /^(?:Wondrous Item|Weapon|Armor|Ring|Rod|Staff|Wand|Potion|Scroll|Shield|Ammunition)\b.{0,80}?\b(?:very rare|uncommon|common|rare|legendary|artifact|rarity varies)\b/i;
/** A labelled line a book repeats in its spells or stronghold rooms ("Casting Time: Action", "Hirelings: 1"). */
const LABEL_LINE = /^[\p{Lu}][\p{L}' ]{1,24}[:.]\s/u;
/**
 * A line that starts with a spell card's label: beside its value (two runs on one baseline: "Casting Time Action",
 * "Casting Time: Action"), alone above it or in a grid's row of labels ("CASTING TIME RANGE"), in any case (small
 * capitals), perhaps after the bullet a list puts before it ("● Casting Time Action", "– Range: 60 feet").
 */
const CARD_LABEL_LINE = /^(?:[•◦▪‣·●○■□◆◇►▸▶\uf0b7]\s*|[-+–—]\s+)*(?:Casting Time|Range(?:\/Area)?|Components|Duration)(?=[:.]?(?:\s|$))/i;
/** How much smaller than the body text a card's labels may be set (capitals or small capitals a size or two down). */
const CARD_LABEL_MIN_SIZE = 0.7;
/** A running header's shape, even with a colon ("Appendix B: Magic Items", "Chapter 8: Strongholds"). */
const HEADER_WORDS = /^(?:Chapter|Appendix|Part|Book|Section|Volume)\b/i;

/**
 * Short lines repeated on many pages (running headers/footers): only lines at the top or bottom of their
 * page (the first or last two) count, and only those copies are dropped. Never a stat block's line, an
 * item's type line, a feat's category line or a line that starts with a spell card's label (in any case, at
 * any size from 70% of the body text's, perhaps after a list's bullet), nor a labelled line in body text (unless
 * it reads like a chapter header), so a book that is mostly spells, stat blocks, items or feats (one to a page)
 * keeps its "Casting Time:" (or "Casting Time Action", "CASTING TIME RANGE", "● Casting Time Action"), "Speed",
 * type and category lines.
 */
function boilerplate(lines: Line[], pageCount: number): { texts: Set<string>; atEdge: Set<Line> } {
  const byPage = new Map<number, Line[]>();
  for (const l of lines) {
    const page = byPage.get(l.page) ?? [];
    page.push(l);
    byPage.set(l.page, page);
  }
  const atEdge = new Set<Line>();
  for (const page of byPage.values()) {
    const sorted = [...page].sort((a, b) => b.y - a.y);
    for (const l of [...sorted.slice(0, 2), ...sorted.slice(-2)]) atEdge.add(l);
  }
  const body = bodySize(lines);
  const kept = (l: Line) =>
    STAT_LINE.test(l.text) ||
    ITEM_TYPE_LINE.test(l.text) ||
    FEAT_CATEGORY_PARAGRAPH.test(l.text) ||
    (CARD_LABEL_LINE.test(l.text) && l.fontSize >= body * CARD_LABEL_MIN_SIZE) ||
    (LABEL_LINE.test(l.text) && !HEADER_WORDS.test(l.text) && roundSize(l.fontSize) === body);
  const pagesWith = new Map<string, Set<number>>();
  for (const l of lines) {
    if (l.text.length > 60 || !atEdge.has(l) || kept(l)) continue;
    const set = pagesWith.get(l.text) ?? new Set<number>();
    set.add(l.page);
    pagesWith.set(l.text, set);
  }
  const texts = new Set<string>();
  for (const [text, pages] of pagesWith) {
    if (pageCount >= 3 && pages.size >= 3 && pages.size >= pageCount * 0.3) texts.add(text);
  }
  return { texts, atEdge };
}

function joinLines(a: string, b: string): string {
  // Re-join words hyphenated across a line break ("spell-" + "casting").
  if (/[a-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b;
  return `${a} ${b}`;
}

/** A line that starts a stat-block or spell label ("AC 17", "HP 150 (12d10 + 84)", "Speed 40 ft.", "Casting Time: Action"). */
const STAT_LABEL_START =
  /^(?:(?:AC|HP|CR)\s+\d|Speed\s+\d|Initiative\s+[+\u2212-]?\d|(?:Armor Class|Hit Points|Challenge)\s+\d|(?:Casting Time|Range|Components|Duration|Prerequisites?)\s*:)/;

/** A spell card's labels alone on their line: one above its value, or a grid's row of them ("Casting Time", "RANGE", "CASTING TIME RANGE"). */
const CARD_LABELS_ALONE = /^(?:Casting Time|Range(?:\/Area)?|Components|Duration)(?:\s+(?:Casting Time|Range(?:\/Area)?|Components|Duration))*$/i;
/** A line of a card's labels alone (not a wrapped "range"): a line of its own, and its values start the next. */
const cardLabelAlone = (text: string) => /^\p{Lu}/u.test(text) && CARD_LABELS_ALONE.test(text);

/** A paragraph so far that is exactly a feat category line, possibly wrapped ("General Feat (Prerequisite: Level 4+)"). */
const FEAT_CATEGORY_PARAGRAPH = /^(?:Origin|General|Fighting Style|Epic Boon) Feat(?:\s*\([^)]*\))?$/i;

/** Convert extracted PDF pages to Markdown with inferred headings. */
export function pdfPagesToMarkdown(pages: PdfTextRun[][]): string {
  const all = pages.flatMap((runs, i) => pageLines(runs, i + 1));
  const skip = boilerplate(all, pages.length);
  const lines = all.filter((l) => !(skip.texts.has(l.text) && skip.atEdge.has(l)) && !/^\d{1,4}$/.test(l.text));
  if (!lines.length) return '';
  const body = bodySize(lines);
  const isHeadingLine = (l: Line) =>
    l.fontSize >= body * HEADING_RATIO && l.text.length <= MAX_HEADING_CHARS && /\p{L}/u.test(l.text);
  const headingLines = lines.filter(isHeadingLine);
  const chars = (ls: Line[]) => ls.reduce((n, l) => n + l.text.length, 0);
  // Headings are a small share of the text; when "large" text dominates, sizes carry no structure.
  const useHeadings = headingLines.length > 0 && chars(headingLines) <= chars(lines) * MAX_HEADING_SHARE;
  // Largest heading size = level 1, next = level 2, the rest = level 3.
  const sizes = [...new Set(headingLines.map((l) => roundSize(l.fontSize)))].sort((a, b) => b - a);
  const levelOf = (l: Line) => Math.min(3, sizes.indexOf(roundSize(l.fontSize)) + 1);

  // A line much shorter than usual ends its paragraph (or is a stat line such as "Range: 60 feet").
  const bodyLengths = lines.filter((l) => !useHeadings || !isHeadingLine(l)).map((l) => l.text.length).sort((a, b) => a - b);
  const shortLine = (bodyLengths[Math.floor(bodyLengths.length / 2)] ?? 0) * 0.6;

  const out: string[] = [];
  let paragraph = '';
  let lastBodyLength = 0;
  let heading: { level: number; text: string } | null = null;
  let prev: Line | null = null;
  const flushParagraph = () => {
    if (paragraph) out.push(paragraph);
    paragraph = '';
  };
  const flushHeading = () => {
    if (heading) out.push(`${'#'.repeat(heading.level)} ${heading.text}`);
    heading = null;
  };
  for (const line of lines) {
    const newPage = prev !== null && line.page !== prev.page;
    if (!useHeadings && (prev === null || newPage)) {
      flushParagraph();
      out.push(`## Page ${line.page}`);
    }
    if (useHeadings && isHeadingLine(line)) {
      flushParagraph();
      const level = levelOf(line);
      // Consecutive lines of the same heading size are one wrapped heading.
      if (heading && heading.level === level && prev && !newPage && prev.page === line.page) heading.text += ` ${line.text}`;
      else {
        flushHeading();
        heading = { level, text: line.text };
      }
    } else {
      flushHeading();
      const gap = prev && !newPage ? prev.y - line.y : 0;
      // A feat's category line ("General Feat (Prerequisite: Level 4+)") stands on its own, as print shows it,
      // and so does each stat or spell label line ("AC 17", "Casting Time: Action", "Casting Time" above its value, a
      // grid's "CASTING TIME RANGE" above its row of values).
      const afterCategory = FEAT_CATEGORY_PARAGRAPH.test(paragraph);
      const paragraphBreak =
        !paragraph ||
        newPage ||
        gap > line.fontSize * 1.9 ||
        gap < 0 ||
        lastBodyLength < shortLine ||
        afterCategory ||
        STAT_LABEL_START.test(line.text) ||
        cardLabelAlone(line.text) ||
        cardLabelAlone(paragraph);
      if (paragraphBreak) {
        flushParagraph();
        paragraph = line.text;
      } else paragraph = joinLines(paragraph, line.text);
      lastBodyLength = line.text.length;
    }
    prev = line;
  }
  flushHeading();
  flushParagraph();
  return out.join('\n\n');
}
