/**
 * Markdown → the flattened text a PDF's text layer gives after pdfLayout.ts (the "flattened PDF" dialect
 * of spec §3.9): headings kept (levels above 3 become 3, like pdfLayout's three heading sizes), emphasis
 * and list markers gone, every paragraph on one line, and tables reduced to loose lines — each body row
 * one line with its cells joined by single spaces, so columns can't be recovered.
 *
 * Paragraph numbering is preserved on purpose: every Markdown paragraph, list item, heading and table
 * body row becomes exactly one paragraph, and table header and separator rows are dropped (as
 * splitParagraphs drops them in Markdown). So a TextSpan means the same paragraphs in both dialects,
 * and the fixtures' spans hold for GLOAMWOOD_MD and GLOAMWOOD_MIXED alike.
 *
 * Pure. Used by src/test/structuredFixtures.ts and the SRD parity test. Day 0 (written with the
 * fixtures); owner after Day 0: E2.
 */

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

/** Markdown emphasis and inline code marks removed. */
const plain = (text: string) => text.replace(/[*_`]/g, '').replace(/[ \t]+/g, ' ').trim();

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => plain(c))
    .filter(Boolean);

export function flatten(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push(plain(paragraph.join(' ')));
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      out.push(`${'#'.repeat(Math.min(3, heading[1].length))} ${plain(heading[2])}`);
      continue;
    }
    if (TABLE_ROW.test(line)) {
      flush();
      const isHeader = TABLE_SEPARATOR.test(lines[i + 1] ?? '');
      if (!TABLE_SEPARATOR.test(line) && !isHeader) {
        const text = cells(line).join(' ');
        if (text) out.push(text);
      }
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      const text = plain(item[1]);
      if (text) out.push(text);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return out.filter(Boolean).join('\n\n');
}
