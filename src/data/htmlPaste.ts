/**
 * Paste with formatting: the HTML a web page, a word processor or a doc editor puts on the clipboard beside its plain
 * text becomes Markdown, so a pasted chapter splits into entries as its source structures it. Headings, paragraphs,
 * lists, tables, bold and italics are kept; a link keeps its text; images, scripts, styles, form controls, hidden
 * elements and a site's navigation go (a whole page copied is read from its main landmark). A line break starts a line
 * of its own (a stat block's "AC 15" and "HP 22" stay apart), and a merged cell keeps the cells after it in their
 * columns.
 *
 * Headings shown only by their look count too. With no heading tags (a word processor's headings set by size alone), a
 * short line set noticeably larger than the body text becomes a heading, its level from its size, as the PDF reader
 * reads them; in a document editor's copy, so do short lines made headings by bolding them. Beside a few tagged
 * headings (a styled title over the rest), larger bold lines (and an editor's bold lines) are headings below them.
 *
 * Pure apart from the browser's DOMParser, which builds an inert document: nothing is fetched, run or rendered.
 */

export interface HtmlConversion {
  markdown: string;
  /** Headings kept: heading tags, or short lines read as headings by their size. */
  headings: number;
  tables: number;
  lists: number;
}

/** A run of text with its emphasis and its font size in px. */
interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  size: number;
}

interface ParaBlock {
  kind: 'para';
  markdown: string;
  plain: string;
  /** The size most of its characters use (px, to 0.5), and their share of its characters. */
  size: number;
  share: number;
  /** All of its text is bold. */
  bold: boolean;
}

interface HeadingBlock {
  kind: 'heading';
  level: number;
  text: string;
}

type Block =
  | ParaBlock
  | HeadingBlock
  /** A list line; `start` on a list's first item (a list's items join a list's lines, a Word list paragraph its neighbours'). */
  | { kind: 'item'; markdown: string; start?: boolean }
  | { kind: 'table'; markdown: string };

interface Ctx {
  bold: boolean;
  italic: boolean;
  size: number;
  depth: number;
}

/** Elements whose content is never text to import. */
const SKIP = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO',
  'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'DATALIST', 'HEAD', 'TITLE', 'META', 'LINK', 'BASE', 'IMG',
  'PICTURE', 'SOURCE', 'TRACK', 'MAP', 'AREA', 'HR', 'WBR',
]);
/** Elements that start and end a block of their own. */
const BLOCK = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CAPTION', 'CENTER', 'DD', 'DETAILS', 'DIALOG', 'DIR', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'HEADER', 'HGROUP', 'LEGEND', 'LI', 'MAIN', 'MENU', 'NAV', 'P',
  'SECTION', 'SUMMARY', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR',
]);
const HEADING_TAG = /^H([1-6])$/;
/** A site's chrome, never its content: its navigation, and a banner, footer or search box marked as one. */
const CHROME_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'search']);
/** Deeper nesting than this is read as plain text (no real page nests this far). */
const MAX_DEPTH = 300;
/** A heading by size: at least this much larger than the body text, as the PDF reader reads them. */
const HEADING_RATIO = 1.15;
const MAX_HEADING_CHARS = 90;
/** The longest line read as a heading made by bolding it. */
const MAX_BOLD_HEADING_CHARS = 70;
const MAX_HEADING_SHARE = 0.4;
/** The default body size (px) when nothing on the page sets one. */
const DEFAULT_SIZE = 16;
const KEYWORD_SIZES: Record<string, number> = {
  'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48,
};
/** <font size="1"> to <font size="7">. */
const FONT_TAG_SIZES = [16, 10, 13, 16, 18, 24, 32, 48];
/** A Word list paragraph's level ("mso-list:l0 level2 lfo1"). */
const WORD_LIST = /mso-list\s*:\s*l\d+\s+level(\d+)/i;
/** The plain text already holds Markdown headings (copied from an editor): it carries its own structure. */
const MARKDOWN_SOURCE = /^ {0,3}#{1,6}[ \t]+\S/m;

const styleOf = (el: Element) => el.getAttribute('style') ?? '';
const roleOf = (el: Element) => (el.getAttribute('role') ?? '').trim().toLowerCase().split(/\s+/)[0];

/** A heading's level: its tag's, or an element marked as one (Word for the web writes <p role="heading" aria-level="3">). */
function headingLevel(el: Element): number | null {
  const tag = HEADING_TAG.exec(el.tagName.toUpperCase());
  if (tag) return Number(tag[1]);
  if (roleOf(el) !== 'heading') return null;
  const level = Number.parseInt(el.getAttribute('aria-level') ?? '', 10);
  return Number.isFinite(level) ? Math.min(6, Math.max(1, level)) : 2;
}

function hidden(el: Element): boolean {
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
  const style = styleOf(el);
  // Word's list bullet ("mso-list:Ignore") is read by wordListItem.
  return !!style && /display\s*:\s*none|visibility\s*:\s*hidden|mso-list\s*:\s*ignore/i.test(style);
}

/** The font size an element sets (px), or undefined when it sets none. */
function ownSize(el: Element, inherited: number): number | undefined {
  const m = /(?:^|;)\s*font-size\s*:\s*([^;!]+)/i.exec(styleOf(el));
  if (m) {
    const value = m[1].trim().toLowerCase();
    const num = /^([\d.]+)\s*(px|pt|em|rem|%)?$/.exec(value);
    if (num) {
      const n = Number.parseFloat(num[1]);
      if (Number.isFinite(n) && n > 0) {
        if (num[2] === 'pt') return (n * 4) / 3;
        if (num[2] === 'em') return n * inherited;
        if (num[2] === 'rem') return n * DEFAULT_SIZE;
        if (num[2] === '%') return (n / 100) * inherited;
        return n;
      }
    }
    if (KEYWORD_SIZES[value]) return KEYWORD_SIZES[value];
    if (value === 'larger') return inherited * 1.2;
    if (value === 'smaller') return inherited / 1.2;
  }
  if (el.tagName === 'FONT') {
    const size = Number(el.getAttribute('size'));
    if (Number.isInteger(size) && size >= 1 && size <= 7) return FONT_TAG_SIZES[size];
  }
  return undefined;
}

/** The emphasis an element gives its text: its tag, or its style (Google Docs wraps a whole copy in a normal-weight <b>). */
function emphasisOf(el: Element, ctx: Ctx): { bold: boolean; italic: boolean } {
  let { bold, italic } = ctx;
  const tag = el.tagName;
  if (tag === 'B' || tag === 'STRONG') bold = true;
  if (tag === 'I' || tag === 'EM' || tag === 'CITE' || tag === 'DFN' || tag === 'VAR') italic = true;
  const style = styleOf(el);
  const weight = /font-weight\s*:\s*([a-z0-9]+)/i.exec(style)?.[1].toLowerCase();
  if (weight) bold = /^(?:bold|bolder|[6-9]00)$/.test(weight) ? true : /^(?:normal|lighter|[1-5]00)$/.test(weight) ? false : bold;
  const fontStyle = /font-style\s*:\s*([a-z]+)/i.exec(style)?.[1].toLowerCase();
  if (fontStyle) italic = fontStyle === 'italic' || fontStyle === 'oblique' ? true : fontStyle === 'normal' ? false : italic;
  return { bold, italic };
}

/** Word's body size from the style block it copies ("p.MsoNormal {font-size:11.0pt}"), in px. */
function wordBodySize(doc: Document): number | null {
  for (const style of Array.from(doc.querySelectorAll('style'))) {
    const m = /MsoNormal\b[^{]*\{[^}]*?font-size\s*:\s*([\d.]+)pt/i.exec(style.textContent ?? '');
    if (m) return (Number.parseFloat(m[1]) * 4) / 3;
  }
  return null;
}

/** Markdown's own characters in text, escaped so they print as themselves. */
const escapeText = (text: string) => text.replace(/[\\`*_]/g, '\\$&');

/** A line that would otherwise start a heading, a quote, a list or a rule prints as text. */
function escapeLineStart(line: string): string {
  return line
    .replace(/^(#{1,6})(?=\s|$)/, '\\$1')
    .replace(/^>/, '\\>')
    .replace(/^([-+])(?=\s|$)/, '\\$1')
    .replace(/^(\d{1,9})([.)])(?=\s|$)/, '$1\\$2')
    .replace(/^(?:=+|-+)\s*$/, (m) => `\\${m}`);
}

/** A heading's text as written: the reader takes a heading's title without its emphasis marks or escapes. */
const headingText = (text: string) => text.replace(/\s+/g, ' ').trim();

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** A line's runs as Markdown: emphasis around the text (never its edge spaces), * for italics inside a word. */
function serialize(runs: Run[]): string {
  const merged: { text: string; bold: boolean; italic: boolean }[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && last.bold === r.bold && last.italic === r.italic) last.text += r.text;
    else merged.push({ text: r.text, bold: r.bold, italic: r.italic });
  }
  let out = '';
  merged.forEach((r, i) => {
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(r.text) as RegExpExecArray;
    if (!core || (!r.bold && !r.italic)) {
      out += escapeText(r.text);
      return;
    }
    const before = (out + lead).slice(-1);
    const after = trail ? ' ' : (merged[i + 1]?.text.charAt(0) ?? '');
    const em = r.italic ? (WORD_CHAR.test(before) || WORD_CHAR.test(after) ? '*' : '_') : '';
    const strong = r.bold ? '**' : '';
    out += `${lead}${strong}${em}${escapeText(core)}${em}${strong}${trail}`;
  });
  return out.trim();
}

function dominantSize(runs: Run[]): { size: number; share: number } {
  const weight = new Map<number, number>();
  let total = 0;
  for (const r of runs) {
    const n = r.text.replace(/\s+/g, '').length;
    if (!n) continue;
    const key = Math.round(r.size * 2) / 2;
    weight.set(key, (weight.get(key) ?? 0) + n);
    total += n;
  }
  let size = DEFAULT_SIZE;
  let best = -1;
  for (const [key, n] of weight) if (n > best) [size, best] = [key, n];
  return { size, share: total ? best / total : 0 };
}

/** A block's text inline (a list item's or a table cell's): its Markdown without line breaks. */
function inlineOf(block: Block): string {
  if (block.kind === 'heading') return block.text;
  if (block.kind === 'item') return block.markdown.replace(/^\s*(?:[-+*]|\d+[.)])\s+/, '');
  if (block.kind === 'table') return '';
  return block.markdown;
}

class Collector {
  readonly blocks: Block[] = [];
  private lines: Run[][] = [[]];
  /** While reading a list item's own text: the lists nested in it, read after it. */
  deferredLists: Element[] | null = null;

  text(data: string, ctx: Ctx): void {
    let text = data.replace(/\s+/g, ' ');
    const line = this.lines[this.lines.length - 1];
    const prev = line[line.length - 1];
    if (!prev || prev.text.endsWith(' ')) text = text.replace(/^ /, '');
    if (!text) return;
    if (prev && prev.bold === ctx.bold && prev.italic === ctx.italic && prev.size === ctx.size) prev.text += text;
    else line.push({ text, bold: ctx.bold, italic: ctx.italic, size: ctx.size });
  }

  lineBreak(): void {
    this.lines.push([]);
  }

  /** The text so far, one paragraph per line. */
  flush(): void {
    for (const runs of this.lines) {
      const plain = runs.map((r) => r.text).join('').trim();
      if (!plain) continue;
      const bold = runs.every((r) => r.bold || !r.text.trim());
      this.blocks.push({ kind: 'para', markdown: escapeLineStart(serialize(runs)), plain, ...dominantSize(runs), bold });
    }
    this.lines = [[]];
  }

  push(block: Block): void {
    this.flush();
    this.blocks.push(block);
  }

  /** An element's content read on its own (a heading's, a list item's, a table cell's), as one line of Markdown. */
  static inline(el: Element, ctx: Ctx, deferLists = false): { text: string; plain: string; collector: Collector } {
    const sub = new Collector();
    if (deferLists) sub.deferredLists = [];
    walk(el, { ...ctx, depth: ctx.depth + 1 }, sub);
    sub.flush();
    const inline = sub.blocks.filter((b) => b.kind !== 'table');
    return {
      text: inline.map(inlineOf).filter(Boolean).join(' '),
      plain: inline.map((b) => (b.kind === 'para' ? b.plain : inlineOf(b))).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
      collector: sub,
    };
  }
}

function heading(el: Element, level: number, ctx: Ctx, out: Collector): void {
  const { plain } = Collector.inline(el, { ...ctx, bold: false, italic: false });
  if (plain) out.push({ kind: 'heading', level, text: headingText(plain) });
  else out.flush();
}

function list(el: Element, ctx: Ctx, out: Collector, indent = ''): void {
  out.flush();
  const ordered = el.tagName === 'OL';
  const start = Number.parseInt(el.getAttribute('start') ?? '', 10);
  let n = Number.isFinite(start) ? start : 1;
  let first = indent === '';
  for (const child of Array.from(el.children)) {
    if (hidden(child)) continue;
    if (child.tagName === 'UL' || child.tagName === 'OL') {
      list(child, ctx, out, `${indent}  `);
      continue;
    }
    if (child.tagName !== 'LI') continue;
    const marker = ordered ? `${n++}.` : '-';
    const itemCtx: Ctx = { ...ctx, ...emphasisOf(child, ctx), size: ownSize(child, ctx.size) ?? ctx.size };
    // An item that is only a heading is that heading (Google Docs and Word for the web number headings with a list).
    const only = child.children.length === 1 ? child.firstElementChild : null;
    if (only && headingLevel(only) !== null && (only.textContent ?? '').trim() === (child.textContent ?? '').trim()) {
      walk(child, { ...itemCtx, depth: ctx.depth + 1 }, out);
      first = indent === '';
      continue;
    }
    const { text, collector } = Collector.inline(child, itemCtx, true);
    if (text) {
      out.push({ kind: 'item', markdown: `${indent}${marker} ${escapeLineStart(text)}`, ...(first ? { start: true } : {}) });
      first = false;
    }
    for (const table of collector.blocks.filter((b) => b.kind === 'table')) out.push(table);
    for (const nested of collector.deferredLists ?? []) list(nested, ctx, out, `${indent}${' '.repeat(marker.length + 1)}`);
  }
}

/** A Word list paragraph ("MsoListParagraph", "mso-list:l0 level2"): an item at its level, its bullet or number kept. */
function wordListItem(el: Element, ctx: Ctx, out: Collector): boolean {
  const level = WORD_LIST.exec(styleOf(el));
  if (!level && !/MsoListParagraph/i.test(el.getAttribute('class') ?? '')) return false;
  const depth = Math.max(0, Number(level?.[1] ?? 1) - 1);
  let marker = '-';
  for (const span of Array.from(el.querySelectorAll('[style]'))) {
    if (!/mso-list\s*:\s*ignore/i.test(styleOf(span))) continue;
    const number = /^\(?(\d{1,9})[.)]$/.exec((span.textContent ?? '').replace(/\s+/g, ''));
    if (number) marker = `${number[1]}.`;
    break;
  }
  const { text } = Collector.inline(el, ctx);
  if (text) out.push({ kind: 'item', markdown: `${'  '.repeat(depth)}${marker} ${escapeLineStart(text)}` });
  else out.flush();
  return true;
}

/**
 * A table used for layout rather than data: a box (one cell to a row), or cells that hold headings, tables or long
 * text (a page's columns, a stat block or sidebar boxed in a word processor). Its cells are read as blocks.
 */
function layoutTable(rows: HTMLTableRowElement[]): boolean {
  if (rows.every((r) => r.cells.length <= 1)) return true;
  return rows.some((r) => Array.from(r.cells).some((c) => (c.textContent ?? '').length > 600 || c.querySelector('h1,h2,h3,h4,h5,h6,table') !== null));
}

function table(el: HTMLTableElement, ctx: Ctx, out: Collector): void {
  out.flush();
  const rows = Array.from(el.rows).filter((r) => !hidden(r));
  const inner = { ...ctx, depth: ctx.depth + 1 };
  if (layoutTable(rows)) {
    for (const row of rows) {
      for (const cell of Array.from(row.cells)) {
        walk(cell, inner, out);
        out.flush();
      }
    }
    return;
  }
  const grid: string[][] = [];
  // Per column, how many more rows a merged cell above (rowspan) covers: those rows leave the column empty.
  const covered: number[] = [];
  for (const row of rows) {
    const cells: string[] = [];
    const skipCovered = () => {
      while ((covered[cells.length] ?? 0) > 0) {
        covered[cells.length] -= 1;
        cells.push('');
      }
    };
    for (const cell of Array.from(row.cells)) {
      if (hidden(cell)) continue;
      skipCovered();
      const col = cells.length;
      cells.push(Collector.inline(cell, inner).text.replace(/\|/g, '\\|'));
      const span = Math.min(Math.max(Number(cell.getAttribute('colspan')) || 1, 1), 50);
      for (let k = 1; k < span; k++) cells.push('');
      const down = Math.min(Math.max(Number(cell.getAttribute('rowspan')) || 1, 1), rows.length) - 1;
      for (let k = col; k < col + span; k++) covered[k] = down;
    }
    skipCovered();
    // A covered column past the row's own cells counts this row too.
    for (let k = cells.length; k < covered.length; k++) if (covered[k] > 0) covered[k] -= 1;
    if (cells.some(Boolean)) grid.push(cells);
  }
  if (!grid.length) return;
  const caption = el.caption ? Collector.inline(el.caption, inner).text : '';
  if (caption) out.push({ kind: 'para', markdown: escapeLineStart(caption), plain: caption, size: ctx.size, share: 1, bold: false });
  const width = Math.max(...grid.map((r) => r.length));
  const row = (cells: string[]) => `| ${[...cells, ...Array<string>(width - cells.length).fill('')].join(' | ')} |`;
  out.push({ kind: 'table', markdown: [row(grid[0]), `| ${Array<string>(width).fill('---').join(' | ')} |`, ...grid.slice(1).map(row)].join('\n') });
}

/** Read an element's children into the collector. */
function walk(parent: Node, ctx: Ctx, out: Collector): void {
  read(Array.from(parent.childNodes), ctx, out);
}

function read(nodes: Node[], ctx: Ctx, out: Collector): void {
  for (const node of nodes) {
    if (node.nodeType === 3) {
      out.text((node as Text).data, ctx);
      continue;
    }
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag) || tag.startsWith('O:') || tag.startsWith('V:') || hidden(el)) continue;
    if (tag === 'NAV' || CHROME_ROLES.has(roleOf(el))) continue;
    if (ctx.depth > MAX_DEPTH) {
      out.text(` ${el.textContent ?? ''} `, ctx);
      continue;
    }
    const inherited = ctx.size;
    const next: Ctx = { ...ctx, ...emphasisOf(el, ctx), size: ownSize(el, inherited) ?? inherited, depth: ctx.depth + 1 };
    const level = headingLevel(el);
    if (tag === 'BR') out.lineBreak();
    else if (level !== null) heading(el, level, next, out);
    else if (tag === 'UL' || tag === 'OL') {
      if (out.deferredLists) out.deferredLists.push(el);
      else list(el, next, out);
    } else if (tag === 'TABLE') table(el as HTMLTableElement, next, out);
    else if (tag === 'PRE') {
      out.flush();
      for (const line of (el.textContent ?? '').split(/\r?\n/)) {
        out.text(line, next);
        out.lineBreak();
      }
      out.flush();
    } else if (tag === 'DT') {
      // "Armor Class" and its value on one line, as a stat block prints them.
      out.flush();
      walk(el, { ...next, bold: true }, out);
      out.text(' ', next);
    } else if (tag === 'DD') {
      walk(el, next, out);
      out.flush();
    } else if (tag === 'P' && wordListItem(el, next, out)) continue;
    else if (BLOCK.has(tag)) {
      out.flush();
      walk(el, next, out);
      out.flush();
    } else walk(el, next, out);
  }
}

interface Inference {
  /** Levels start below this one (the deepest tagged heading's). */
  below: number;
  /** Only bold lines are headings by size (beside tagged headings, a larger line that isn't bold is a pull quote). */
  boldOnly: boolean;
  /** Short bold lines at the body size are headings too, a level below those by size (a document editor's copy). */
  bolded: boolean;
}

/**
 * Lines that are headings by their look: short lines set noticeably larger than the body text, their levels by size
 * (at most 4 levels), and with `bolded` short bold lines at the body size. Bold lines count only when there are two or
 * more and no heading by size comes after the first of them: a copy that sets its headings by size (a title above them
 * aside) bolds its labels and captions, not its headings ("STR" over "14 (+2)", a table's title).
 */
function inferHeadings(blocks: Block[], { below, boldOnly, bolded }: Inference): { blocks: Block[]; found: number } {
  const paras = blocks.filter((b): b is ParaBlock => b.kind === 'para');
  const weight = new Map<number, number>();
  let total = 0;
  for (const p of paras) {
    weight.set(p.size, (weight.get(p.size) ?? 0) + p.plain.length);
    total += p.plain.length;
  }
  let body = DEFAULT_SIZE;
  let best = -1;
  for (const [size, n] of weight) if (n > best) [body, best] = [size, n];
  const chars = (ps: ParaBlock[]) => ps.reduce((n, p) => n + p.plain.length, 0);
  let sized = paras.filter(
    (p) => p.size >= body * HEADING_RATIO && p.share >= 0.8 && p.plain.length <= MAX_HEADING_CHARS && /\p{L}/u.test(p.plain) && (p.bold || !boldOnly),
  );
  if (chars(sized) > total * MAX_HEADING_SHARE) sized = [];
  let bold = bolded
    ? paras.filter(
        (p) =>
          p.bold && p.size >= body * 0.95 && p.size < body * HEADING_RATIO && p.plain.length <= MAX_BOLD_HEADING_CHARS && /\p{L}/u.test(p.plain) && !/[:.,;]$/.test(p.plain),
      )
    : [];
  const bySize = new Set(sized);
  if (bold.length < 2 || paras.slice(paras.indexOf(bold[0])).some((p) => bySize.has(p)) || chars(sized) + chars(bold) > total * MAX_HEADING_SHARE) bold = [];
  const byBold = new Set(bold);
  const sizes = [...new Set(sized.map((p) => p.size))].sort((a, b) => b - a);
  const boldLevel = Math.min(6, below + Math.min(4, sizes.length) + 1);
  const level = (p: ParaBlock) => (bySize.has(p) ? Math.min(6, below + Math.min(4, sizes.indexOf(p.size) + 1)) : boldLevel);
  return {
    blocks: blocks.map((b) => (b.kind === 'para' && (bySize.has(b) || byBold.has(b)) ? { kind: 'heading', level: level(b), text: headingText(b.plain) } : b)),
    found: sized.length + bold.length,
  };
}

/** A copy from a document editor (Google Docs, Word, Word for the web, LibreOffice, Pages, TextEdit): its writers often make a heading by bolding a line. */
function fromDocEditor(doc: Document): boolean {
  if (doc.querySelector('[id^="docs-internal-guid"], [class*="Mso"], .OutlineElement')) return true;
  return Array.from(doc.querySelectorAll('meta[name]')).some(
    (m) => /^generator$/i.test(m.getAttribute('name') ?? '') && /Microsoft Word|LibreOffice|OpenOffice|Cocoa HTML Writer/i.test(m.getAttribute('content') ?? ''),
  );
}

/**
 * Headings the copy shows only by their look. With no heading tags, all of them; beside a few tagged headings (a styled
 * title over headings that are only larger bold text, or an editor's bold lines), those below the tagged ones, when
 * they are two or more and outnumber the tagged ones.
 */
function withLookedHeadings(blocks: Block[], docEditor: boolean): Block[] {
  const tagged = blocks.filter((b): b is HeadingBlock => b.kind === 'heading');
  if (!tagged.length) return inferHeadings(blocks, { below: 0, boldOnly: false, bolded: docEditor }).blocks;
  const inferred = inferHeadings(blocks, { below: tagged.reduce((n, b) => Math.max(n, b.level), 0), boldOnly: true, bolded: docEditor });
  return inferred.found >= 2 && inferred.found > tagged.length ? inferred.blocks : blocks;
}

/** What to read: a whole page copied (select-all) holds a site's chrome around its main landmark; when that holds most of the text, only it. */
function contentOf(doc: Document): Node[] {
  const length = (el: Element) => (el.textContent ?? '').replace(/\s+/g, '').length;
  const total = length(doc.body);
  const main = Array.from(doc.querySelectorAll('main, [role="main"]')).find((m) => !hidden(m) && length(m) * 2 >= total);
  return main ? [main] : Array.from(doc.body.childNodes);
}

/** Clipboard HTML as Markdown, with what it kept. */
export function htmlToMarkdown(html: string): HtmlConversion {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = new Collector();
  read(contentOf(doc), { bold: false, italic: false, size: wordBodySize(doc) ?? DEFAULT_SIZE, depth: 0 }, out);
  out.flush();
  const blocks = withLookedHeadings(out.blocks, fromDocEditor(doc));
  const parts: string[] = [];
  let lists = 0;
  blocks.forEach((b, i) => {
    const text = b.kind === 'heading' ? `${'#'.repeat(b.level)} ${b.text}` : b.markdown;
    if (b.kind === 'item') {
      if (blocks[i - 1]?.kind === 'item' && !b.start) {
        parts[parts.length - 1] += `\n${text}`;
        return;
      }
      lists += 1;
    }
    parts.push(text);
  });
  return {
    markdown: parts.join('\n\n'),
    headings: blocks.filter((b) => b.kind === 'heading').length,
    tables: blocks.filter((b) => b.kind === 'table').length,
    lists,
  };
}

/**
 * What a paste into the import box should insert: the clipboard's HTML as Markdown when it holds structure the plain
 * text lacks (headings, tables or lists), or null to paste the plain text as it is (no HTML, plain prose, or text that
 * is Markdown already, copied from an editor).
 */
export function formattedPaste(html: string, plain: string): HtmlConversion | null {
  if (!html.trim() || MARKDOWN_SOURCE.test(plain)) return null;
  const conversion = htmlToMarkdown(html);
  if (!conversion.markdown.trim() || conversion.headings + conversion.tables + conversion.lists === 0) return null;
  return conversion;
}
