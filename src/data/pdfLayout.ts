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

/** Short lines repeated on many pages (running headers/footers) and bare page numbers. */
function boilerplate(lines: Line[], pageCount: number): Set<string> {
  const pagesWith = new Map<string, Set<number>>();
  for (const l of lines) {
    if (l.text.length > 60) continue;
    const set = pagesWith.get(l.text) ?? new Set<number>();
    set.add(l.page);
    pagesWith.set(l.text, set);
  }
  const out = new Set<string>();
  for (const [text, pages] of pagesWith) {
    if (pageCount >= 3 && pages.size >= 3 && pages.size >= pageCount * 0.3) out.add(text);
  }
  return out;
}

function joinLines(a: string, b: string): string {
  // Re-join words hyphenated across a line break ("spell-" + "casting").
  if (/[a-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b;
  return `${a} ${b}`;
}

/** Convert extracted PDF pages to Markdown with inferred headings. */
export function pdfPagesToMarkdown(pages: PdfTextRun[][]): string {
  const all = pages.flatMap((runs, i) => pageLines(runs, i + 1));
  const skip = boilerplate(all, pages.length);
  const lines = all.filter((l) => !skip.has(l.text) && !/^\d{1,4}$/.test(l.text));
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
      const paragraphBreak = !paragraph || newPage || gap > line.fontSize * 1.9 || gap < 0 || lastBodyLength < shortLine;
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
