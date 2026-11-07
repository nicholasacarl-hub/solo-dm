import { describe, expect, it } from 'vitest';
import { pdfPagesToMarkdown, type PdfTextRun } from './pdfLayout';

/** One full line of text as a single run ending in a line break. */
const line = (str: string, y: number, fontSize = 10, x = 50): PdfTextRun => ({
  str,
  x,
  y,
  width: str.length * fontSize * 0.5,
  fontSize,
  hasEOL: true,
});

describe('pdfPagesToMarkdown', () => {
  it('turns larger fonts into headings and joins wrapped body lines into paragraphs', () => {
    const page = [
      line('Chapter 3: Spells', 760, 24),
      line('Fireball', 720, 14),
      line('A bright streak flashes from you to a point you choose within range and then', 700),
      line('blossoms with a low roar into a fiery explosion.', 688),
      line('Flammable objects in the area start burning.', 660),
      line('Fire Bolt', 630, 14),
      line('You hurl a mote of fire at a creature or object.', 610),
    ];
    expect(pdfPagesToMarkdown([page])).toBe(
      [
        '# Chapter 3: Spells',
        '## Fireball',
        'A bright streak flashes from you to a point you choose within range and then blossoms with a low roar into a fiery explosion.',
        'Flammable objects in the area start burning.',
        '## Fire Bolt',
        'You hurl a mote of fire at a creature or object.',
      ].join('\n\n'),
    );
  });

  it('builds lines from several runs (spaces at gaps) and keeps short stat lines apart', () => {
    const runs: PdfTextRun[] = [
      { str: 'Casting', x: 50, y: 700, width: 35, fontSize: 10, hasEOL: false },
      { str: 'Time:', x: 88, y: 700, width: 25, fontSize: 10, hasEOL: false },
      { str: ' Action', x: 113, y: 700, width: 30, fontSize: 10, hasEOL: true },
      { str: 'Range: 150 feet', x: 50, y: 688, width: 70, fontSize: 10, hasEOL: true },
      line('A bright streak flashes from you to a point you choose within range and then', 676),
      line('blossoms with a low roar into a fiery explosion that fills the whole area.', 664),
    ];
    expect(pdfPagesToMarkdown([runs])).toBe(
      '## Page 1\n\nCasting Time: Action\n\nRange: 150 feet\n\nA bright streak flashes from you to a point you choose within range and then blossoms with a low roar into a fiery explosion that fills the whole area.',
    );
  });

  it('merges a heading that wraps onto two lines and re-joins hyphenated words', () => {
    const page = [
      line('The Very Long Title of a', 760, 18),
      line('Section That Wraps', 740, 18),
      line('Every adventurer who studies magic learns that spell-', 700),
      line('casting is an art as much as a science.', 688),
      line('A second paragraph follows after a gap in the layout.', 660),
    ];
    expect(pdfPagesToMarkdown([page])).toBe(
      '# The Very Long Title of a Section That Wraps\n\nEvery adventurer who studies magic learns that spellcasting is an art as much as a science.\n\nA second paragraph follows after a gap in the layout.',
    );
  });

  it('drops running headers and page numbers', () => {
    const pages = [1, 2, 3, 4].map((n) => [
      line("Player's Notes", 800, 8),
      line(`Section ${n}`, 760, 16),
      line(`Body text of page ${n} goes here.`, 700),
      line(String(n), 40, 8),
    ]);
    const markdown = pdfPagesToMarkdown(pages);
    expect(markdown).not.toContain("Player's Notes");
    expect(markdown).toBe(
      ['# Section 1', 'Body text of page 1 goes here.', '# Section 2', 'Body text of page 2 goes here.', '# Section 3', 'Body text of page 3 goes here.', '# Section 4', 'Body text of page 4 goes here.'].join('\n\n'),
    );
  });

  it('falls back to one section per page without usable font sizes', () => {
    const pages = [[line('First page text.', 700)], [line('Second page text.', 700)]];
    expect(pdfPagesToMarkdown(pages)).toBe('## Page 1\n\nFirst page text.\n\n## Page 2\n\nSecond page text.');
  });

  it('ignores font-size "headings" when they are most of the text', () => {
    const page = [line('Big', 700, 20), line('Bigger', 680, 20), line('small text', 660)];
    expect(pdfPagesToMarkdown([page])).toMatch(/^## Page 1/);
  });

  it('returns an empty string for pages without text', () => {
    expect(pdfPagesToMarkdown([[], []])).toBe('');
  });
});
