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

  it("keeps a feat's category line apart from the sentence after it, even when it is as long as a body line", () => {
    const page = [
      line('Lamp Lifter', 760, 14),
      line('General Feat (Prerequisite: Level 4+)', 740),
      line('You gain the following benefits while you carry a lit lantern.', 728),
      line('Your light spreads 10 feet farther and you can raise it high.', 716),
      line('Wick Dancer', 690, 14),
      line('General Feat (Prerequisite: Level 4+, Strength or', 670),
      line('Dexterity 13+)', 658),
      line('You move between flames without catching fire, and you can', 646),
      line('step through a burning doorway as if it were open ground.', 634),
    ];
    expect(pdfPagesToMarkdown([page])).toBe(
      [
        '# Lamp Lifter',
        'General Feat (Prerequisite: Level 4+)',
        'You gain the following benefits while you carry a lit lantern. Your light spreads 10 feet farther and you can raise it high.',
        '# Wick Dancer',
        'General Feat (Prerequisite: Level 4+, Strength or Dexterity 13+)',
        'You move between flames without catching fire, and you can step through a burning doorway as if it were open ground.',
      ].join('\n\n'),
    );
  });

  it('starts a new line at each stat or spell label, even after a line as long as body text', () => {
    const page = [
      line('Elder Thornback', 760, 14),
      line('Large Monstrosity, Unaligned, often met near the old lamps', 740),
      line('AC 17', 728),
      line('HP 150 (12d10 + 84)', 716),
      line('Speed 40 ft.', 704),
      line('CR 9 (XP 5,000; PB +4)', 692),
      line('Glow Mote', 660, 14),
      line('Level 1 Abjuration (Cleric, Paladin, Wizard, Wickwright, and Lampkin)', 640),
      line('Casting Time: Action', 628),
      line('A small light gathers into a mote that drifts wherever you point it, and it lingers.', 616),
      line('It lingers until the spell ends, and it sheds Dim Light in a 10-foot radius around it.', 604),
    ];
    const paragraphs = pdfPagesToMarkdown([page]).split('\n\n');
    for (const label of ['AC 17', 'HP 150 (12d10 + 84)', 'Speed 40 ft.', 'CR 9 (XP 5,000; PB +4)']) expect(paragraphs).toContain(label);
    // The level line no longer swallows the Casting Time label (the description may still follow it, as before).
    expect(paragraphs).toContain('Level 1 Abjuration (Cleric, Paladin, Wizard, Wickwright, and Lampkin)');
    expect(paragraphs.some((p) => p.startsWith('Casting Time: Action'))).toBe(true);
    expect(paragraphs).toContain('Large Monstrosity, Unaligned, often met near the old lamps');
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

  it("keeps the labelled lines a book of spells repeats on every page (they aren't running headers)", () => {
    const spells = ['Glow Mote', 'Wick Ward', 'Ember Thread', 'Moth Wing'];
    const pages = spells.map((name, i) => [
      line('Lantern Lore', 800, 8),
      line(name, 760, 16),
      line('Level 1 Evocation (Wizard)', 740),
      line('Casting Time: Action', 728),
      line('Range: 60 feet', 716),
      line(`A small light gathers into a mote that drifts where you point it on page ${i + 1}.`, 690),
      line(String(i + 1), 40, 8),
    ]);
    const markdown = pdfPagesToMarkdown(pages);
    expect(markdown).not.toContain('Lantern Lore');
    expect(markdown.match(/Casting Time: Action/g)).toHaveLength(4);
    expect(markdown.match(/Range: 60 feet/g)).toHaveLength(4);
    expect(markdown.match(/Level 1 Evocation \(Wizard\)/g)).toHaveLength(4);
  });

  it("keeps a spell card's labels printed beside their values on every page (no colons: two runs on one baseline)", () => {
    const run = (str: string, x: number, y: number, hasEOL: boolean): PdfTextRun => ({ str, x, y, width: str.length * 5, fontSize: 10, hasEOL });
    const spells = ['Glow Mote', 'Wick Ward', 'Ember Thread', 'Moth Wing'];
    const pages = spells.map((name, i) => [
      line(name, 760, 16),
      run('Casting Time', 50, 740, false),
      run('Action', 150, 740, true),
      run('Range', 50, 728, false),
      run('60 feet', 150, 728, true),
      line(`A small light gathers into a mote that drifts where you point it on page ${i + 1}.`, 700),
      line('Lantern Lore', 60, 8),
    ]);
    const markdown = pdfPagesToMarkdown(pages);
    expect(markdown.match(/Casting Time Action/g)).toHaveLength(4);
    expect(markdown).not.toContain('Lantern Lore');
  });

  it("keeps a card's labels set in capitals or smaller than the text on every page, beside or above their values", () => {
    const run = (str: string, x: number, y: number, hasEOL: boolean, fontSize = 10): PdfTextRun => ({ str, x, y, width: str.length * fontSize * 0.5, fontSize, hasEOL });
    const spells = ['Glow Mote', 'Wick Ward', 'Ember Thread', 'Moth Wing'];
    const text = (i: number) => [
      line(`A small light gathers into a mote that drifts where you point it on page ${i + 1} and stays`, 690),
      line(`there until the spell ends, or until you dismiss it as a Bonus Action (page ${i + 1}).`, 676),
    ];
    // Beside the value: capitals at the text's size, small capitals a size or two down (70% of the text's, and up).
    for (const [castingTime, range, size] of [['CASTING TIME', 'RANGE', 10], ['Casting Time', 'Range', 8.5], ['CASTING TIME', 'RANGE', 7]] as const) {
      const pages = spells.map((name, i) => [
        line(name, 760, 16),
        run(castingTime, 50, 740, false, size),
        run('Action', 150, 740, true),
        run(range, 50, 728, false, size),
        run('60 feet', 150, 728, true),
        ...text(i),
      ]);
      expect(pdfPagesToMarkdown(pages).match(/casting time action/gi)).toHaveLength(4);
    }
    // Above the value, each label a line of its own; a running header that starts with a label's word, set much
    // smaller, still goes.
    const above = spells.map((name, i) => [
      line('Range of Spells', 790, 6),
      line(name, 760, 16),
      line('CASTING TIME', 740, 8.5),
      line('Action', 728),
      line('RANGE', 712, 8.5),
      line('60 feet', 700),
      ...text(i),
    ]);
    const markdown = pdfPagesToMarkdown(above);
    expect(markdown.match(/^CASTING TIME$/gm)).toHaveLength(4);
    expect(markdown).toContain('# Glow Mote\n\nCASTING TIME\n\nAction\n\nRANGE\n\n60 feet');
    expect(markdown).not.toContain('Range of Spells');
  });

  it("keeps a card's lines on every page when a list's bullet comes before each label, and a grid's rows of labels", () => {
    const run = (str: string, x: number, y: number, hasEOL: boolean, fontSize = 10): PdfTextRun => ({ str, x, y, width: str.length * fontSize * 0.5, fontSize, hasEOL });
    const spells = ['Glow Mote', 'Wick Ward', 'Ember Thread', 'Moth Wing'];
    const text = (i: number) => [
      line(`A small light gathers into a mote that drifts where you point it on page ${i + 1} and stays`, 690),
      line(`there until the spell ends, or until you dismiss it as a Bonus Action (page ${i + 1}).`, 676),
    ];
    // A bullet glyph as a run of its own before each label (a word processor's "●", a symbol font's U+F0B7, "•",
    // "▪", "–"), with or without a colon after the label.
    for (const bullet of ['●', String.fromCharCode(0xf0b7), '•', '▪', '–']) {
      for (const colon of ['', ':']) {
        const pages = spells.map((name, i) => [
          line(name, 760, 16),
          run(bullet, 40, 740, false), run(`Casting Time${colon}`, 52, 740, false), run('Action', 150, 740, true),
          run(bullet, 40, 728, false), run(`Range${colon}`, 52, 728, false), run('60 feet', 150, 728, true),
          ...text(i),
        ]);
        expect([bullet, colon, pdfPagesToMarkdown(pages).match(new RegExp(`Casting Time${colon} Action`, 'g'))?.length]).toEqual([bullet, colon, 4]);
      }
    }
    // A grid's rows of labels over its rows of values, in capitals a size down.
    const grid = spells.map((name, i) => [
      line(name, 760, 16),
      run('CASTING TIME', 50, 740, false, 9), run('RANGE', 210, 740, true, 9),
      run('Action', 50, 728, false), run('60 feet', 210, 728, true),
      run('COMPONENTS', 50, 712, false, 9), run('DURATION', 210, 712, true, 9),
      run('V, S', 50, 700, false), run('Instantaneous', 210, 700, true),
      ...text(i),
    ]);
    const markdown = pdfPagesToMarkdown(grid);
    expect(markdown.match(/^CASTING TIME RANGE$/gm)).toHaveLength(4);
    expect(markdown).toContain('# Glow Mote\n\nCASTING TIME RANGE\n\nAction 60 feet\n\nCOMPONENTS DURATION\n\nV, S Instantaneous');
  });

  it("keeps an item's type line on every page of a book that prints one item to a page", () => {
    const items = ['Glow Ring', 'Wick Cloak', 'Ember Boots', 'Moth Lamp'];
    const pages = items.map((name, i) => [
      line(name, 760, 16),
      line('Wondrous Item, Uncommon', 740),
      line(`This item glows softly in the dark and never needs oil, as page ${i + 1} explains.`, 720),
      line(String(i + 1), 40, 8),
    ]);
    expect(pdfPagesToMarkdown(pages).match(/Wondrous Item, Uncommon/g)).toHaveLength(4);
  });

  it("keeps a feat's category line on every page of a book that prints one feat to a page", () => {
    const feats = ['Lamp Lifter', 'Wick Dancer', 'Moth Friend', 'Ember Heart'];
    const pages = feats.map((name, i) => [
      line(name, 760, 16),
      line(i % 2 ? 'General Feat (Prerequisite: Level 4+)' : 'Origin Feat', 740),
      line(`You gain the following benefits, which page ${i + 1} explains in a sentence or two.`, 720),
      line(String(i + 1), 40, 8),
    ]);
    const markdown = pdfPagesToMarkdown(pages);
    expect(markdown.match(/Origin Feat/g)).toHaveLength(2);
    expect(markdown.match(/General Feat \(Prerequisite: Level 4\+\)/g)).toHaveLength(2);
  });

  it('drops only the copies of a running header at the top or bottom of a page, even one with a colon', () => {
    const pages = [1, 2, 3, 4].map((n) => [
      line('Appendix B: Lantern Lore', 800, 8),
      line(`Section ${n}`, 760, 16),
      line(n === 2 ? 'Appendix B: Lantern Lore' : `Body text of page ${n} goes here.`, 700),
      line(`More body text of page ${n} goes here, with enough words to be body text.`, 680),
      line('Hirelings: 1', 660),
      line(String(n), 40, 8),
    ]);
    const markdown = pdfPagesToMarkdown(pages);
    // The mid-page copy on page 2 stays; the header copies go.
    expect(markdown.match(/Appendix B: Lantern Lore/g)).toHaveLength(1);
    // A labelled line in body text at the bottom of each page stays.
    expect(markdown.match(/Hirelings: 1/g)).toHaveLength(4);
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
