import { describe, expect, it } from 'vitest';
import { chunkDocument } from './chunk';
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

  it('keeps a fourth heading size as a fourth level, and puts any smaller heading size there too', () => {
    const page = [
      line('Chapter 2: Lamplit Play', 760, 24),
      line('Wick Tests', 730, 21),
      line('Lighting Checks', 700, 18),
      line('Wick Bonus', 670, 15),
      line('Add your wick bonus to the roll whenever you light a lamp in a draft or in the rain.', 650),
      line('Snuffing Checks', 620, 18),
      line('Wick Bonus', 590, 15),
      line('Add the same bonus when you snuff a lamp quickly, before anyone sees its light go out.', 570),
      line('Sidebar: Old Wicks', 540, 13),
      line('Old wicks burn unevenly, so a lamp with an old wick gives no bonus until it is trimmed.', 520),
    ];
    expect(pdfPagesToMarkdown([page])).toBe(
      [
        '# Chapter 2: Lamplit Play',
        '## Wick Tests',
        '### Lighting Checks',
        '#### Wick Bonus',
        'Add your wick bonus to the roll whenever you light a lamp in a draft or in the rain.',
        '### Snuffing Checks',
        '#### Wick Bonus',
        'Add the same bonus when you snuff a lamp quickly, before anyone sees its light go out.',
        '#### Sidebar: Old Wicks',
        'Old wicks burn unevenly, so a lamp with an old wick gives no bonus until it is trimmed.',
      ].join('\n\n'),
    );
  });

  it('keeps a creature named at the third size an entry among smaller spell names: the spells after it stay entries, its Actions stay its own', () => {
    const page = [
      line('Chapter 9: Lamplight Spells', 760, 24),
      line('Spell Descriptions', 730, 20),
      line('Ember Lash', 700, 14),
      line('Level 1 Evocation (Wizard)', 684),
      line('Casting Time: Action', 672),
      line('A lash of flame cracks at a creature you can see within reach of your outstretched hand.', 660),
      line('Lamp Spirit', 630, 17),
      line('Medium Celestial, Neutral', 612),
      line('AC 11 plus the level of the spell', 600),
      line('HP 30 plus 10 for each spell level above 3', 588),
      line('Str 12 +1 +1 Dex 14 +2 +2 Con 12 +1 +1 Int 10 +0 +0 Wis 12 +1 +1 Cha 14 +2 +2', 576),
      line('Actions', 556, 12),
      line('Radiant Touch. Melee Attack Roll: bonus equals your spell attack modifier, reach 5 ft.', 540),
      line('Sunbeam Thread', 510, 14),
      line('Level 2 Evocation (Wizard)', 494),
      line('Casting Time: Action', 482),
      line('A thread of sunlight stitches across the room, shedding bright light along its whole length.', 470),
      line('Wick Ward', 440, 14),
      line('Level 1 Abjuration (Wizard)', 424),
      line('Casting Time: Reaction', 412),
      line('You shield a lamp flame from wind and water until the end of your next turn, whatever comes.', 400),
    ];
    const markdown = pdfPagesToMarkdown([page]);
    const headings = markdown.split('\n\n').filter((p) => p.startsWith('#'));
    expect(headings).toEqual([
      '# Chapter 9: Lamplight Spells',
      '## Spell Descriptions',
      '#### Ember Lash',
      '### Lamp Spirit',
      '#### Actions',
      '### Sunbeam Thread',
      '### Wick Ward',
    ]);
    const entries = chunkDocument(markdown, { sourceId: 'pdf', sourceName: 'Lamplight Spells' });
    expect(entries.map((e) => [e.name, e.kind])).toEqual([
      ['Ember Lash', 'spell'],
      ['Lamp Spirit', 'monster'],
      ['Sunbeam Thread', 'spell'],
      ['Wick Ward', 'spell'],
    ]);
    expect(entries[1].text).toContain('Radiant Touch');
    expect(entries[1].text).not.toContain('Sunbeam');
  });

  it('keeps the headings after an item or a spell named at the third size its siblings, as it does after a creature', () => {
    const page = [
      line('Appendix: Lamps and Lamp Magic', 760, 24),
      line('Magic Lamps', 730, 20),
      line('Warden’s Lamp', 700, 17),
      line('Wondrous Item, Uncommon', 684),
      line('This brass lamp burns for a week on one filling of oil and never gutters in the wind or rain.', 672),
      line('Lamplight and Shadow', 646, 14),
      line('Bright light and dim light from a magic lamp work as they do for any other lamp in the game.', 630),
      line('Moth Veil', 600, 17),
      line('Level 2 Illusion (Wizard)', 584),
      line('Casting Time: Action', 572),
      line('A cloud of pale moths gathers around you and hides you from the eyes of anyone farther away.', 560),
      line('Optional Rule: Guttering Flames', 534, 14),
      line('A lamp that runs low on oil sheds dim light only, until someone refills it with fresh oil.', 518),
    ];
    const headings = pdfPagesToMarkdown([page]).split('\n\n').filter((p) => p.startsWith('#'));
    expect(headings).toEqual([
      '# Appendix: Lamps and Lamp Magic',
      '## Magic Lamps',
      '### Warden’s Lamp',
      '### Lamplight and Shadow',
      '### Moth Veil',
      '### Optional Rule: Guttering Flames',
    ]);
  });

  it('still nests a section’s fourth-size subsections when its prose only mentions a casting time or a duration', () => {
    const page = [
      line('Chapter 7: Lamp Magic', 760, 24),
      line('Casting Lamp Spells', 730, 20),
      line('Lamp Rituals', 700, 17),
      line('A lamp ritual takes ten minutes longer than the spell’s normal', 684),
      line('casting time, and the lamp must stay lit for the whole of it, or the', 672),
      line('duration of the spell ends early and the ritual has to start over again.', 660),
      line('Shared Rituals', 636, 14),
      line('Two casters can share one ritual if both of them can see the same lamp flame throughout it.', 620),
    ];
    const headings = pdfPagesToMarkdown([page]).split('\n\n').filter((p) => p.startsWith('#'));
    expect(headings).toEqual(['# Chapter 7: Lamp Magic', '## Casting Lamp Spells', '### Lamp Rituals', '#### Shared Rituals']);
  });

  it('keeps a creature’s Traits and Actions set at its own size with it, and the smaller headings after it entries', () => {
    const page = [
      line('Chapter 2: The Candle Works', 760, 24),
      line('Area 1: The Oil Store', 730, 18),
      line('Barrels of lamp oil line the walls, and a newt basks in the warmth of the furnace flue.', 712),
      line('Cinder Newt', 690, 14),
      line('Small Elemental, Neutral', 674),
      line('AC 13', 662),
      line('HP 11 (2d6 + 4)', 650),
      line('Speed 20 ft.', 638),
      line('Str 8 -1 -1 Dex 16 +3 +3 Con 14 +2 +2 Int 3 -4 -4 Wis 10 +0 +0 Cha 5 -3 -3', 626),
      line('CR 1/4 (XP 50; PB +2)', 614),
      line('Traits', 594, 14),
      line('Ember Skin. A creature that touches the newt takes 2 (1d4) Fire damage from its glowing skin.', 578),
      line('Actions', 558, 14),
      line('Bite. Melee Attack Roll: +5, reach 5 ft. Hit: 6 (1d6 + 3) Fire damage, and the target smolders.', 542),
      line('Grinder’s Lens', 520, 12),
      line('Wondrous Item, Uncommon', 504),
      line('This lens of smoked glass lets you see through smoke and steam as if they were clear air, out to 60 feet.', 492),
      line('Developments', 470, 12),
      line('If the newt is slain, the furnace flue cools and the oil in the barrels stops bubbling within an hour.', 454),
      line('Area 2: The Furnace', 430, 18),
      line('The great furnace roars day and night, fed by a chute of coal from the yard outside the works.', 412),
    ];
    const markdown = pdfPagesToMarkdown([page]);
    expect(markdown.split('\n\n').filter((p) => p.startsWith('#'))).toEqual([
      '# Chapter 2: The Candle Works',
      '## Area 1: The Oil Store',
      '### Cinder Newt',
      '### Traits',
      '### Actions',
      '### Grinder’s Lens',
      '### Developments',
      '## Area 2: The Furnace',
    ]);
    const entries = chunkDocument(markdown, { sourceId: 'pdf', sourceName: 'The Candle Works' });
    expect(entries.map((e) => [e.name, e.kind])).toEqual([
      ['Area 1: The Oil Store', 'rule'],
      ['Cinder Newt', 'monster'],
      ['Grinder’s Lens', 'magic-item'],
      ['Developments', 'rule'],
      ['Area 2: The Furnace', 'rule'],
    ]);
    expect(entries[1].text).toContain('Bite.');
  });

  it('reads an entity at the third size as the chunker does: stat lines with colons, on one line or bulleted, an older card, a feat, a labelled type line', () => {
    const openings: [string, string[]][] = [
      ['Bog Lantern', ['Armor Class: 13 (natural armor)', 'Hit Points: 22 (5d8)', 'Str 10 +0 Dex 14 +2 Con 12 +1 Int 6 -2 Wis 10 +0 Cha 8 -1']],
      ['Reed Lurker', ['Medium Monstrosity, Unaligned', 'AC 13 HP 22 (5d8) Speed 30 ft.', 'CR 1 (XP 200; PB +2)']],
      ['Moth Veil', ['2nd-level illusion', 'Casting time: 1 action', 'Range: Self']],
      ['Lamp Tender', ['Origin Feat', 'You can light or snuff any lamp within 30 feet of you without touching it.']],
      ['Warden’s Lamp', ['Type: Wondrous Item, Uncommon', 'This brass lamp burns for a week on one filling of oil.']],
      // A word processor's list bullets before each line.
      ['Brine Crab', ['• Armor Class 12 (natural armor)', '• Hit Points 9 (2d6 + 2)', '• Str 12 +1 Dex 10 +0 Con 13 +1 Int 1 -5 Wis 9 -1 Cha 3 -4']],
      ['Ember Mote', ['1st-level evocation', '● Casting Time: 1 action', '● Range: 60 feet']],
    ];
    for (const [name, own] of openings) {
      const page = [
        line('Appendix: Lamp Things', 760, 24),
        line('Entries', 730, 20),
        line(name, 700, 17),
        ...own.map((text, i) => line(text, 684 - i * 12)),
        line('Lamplight and Shadow', 620, 14),
        line('Bright light and dim light from a magic lamp work as they do for any other lamp in the game.', 604),
        line('A lamp carried in the open hand sheds its light in every direction, as far as its flame allows.', 592),
      ];
      const headings = pdfPagesToMarkdown([page]).split('\n\n').filter((p) => p.startsWith('#'));
      expect([name, headings]).toEqual([name, ['# Appendix: Lamp Things', '## Entries', `### ${name}`, '### Lamplight and Shadow']]);
    }
  });

  it('keeps a rules section’s subsections nested when its first lines only look like a card or a stat block', () => {
    const page = [
      line('Chapter 7: Lamp Magic', 760, 24),
      line('Casting Lamp Spells', 730, 20),
      line('Casting Time', 700, 17),
      line('Lamp spells fall into a few groups by how long they take to cast:', 684),
      line('Casting Time Typical Lamp Spells', 672),
      line('Action Cinder Whip, Glowthread', 660),
      line('Reaction Wax Ward', 648),
      line('Longer Casting Times', 626, 14),
      line('A spell that takes a minute or longer to cast needs your full attention for the whole time.', 610),
      line('Your Defenses', 586, 17),
      line('Your finished lamplighter’s defenses might read like this, once your armor is chosen:', 570),
      line('AC 16 (chain shirt and shield)', 558),
      line('HP 12 (1d10 + 2)', 546),
      line('Hit Point Dice', 524, 14),
      line('You have one Hit Point Die for each level, and you spend them to heal during a Short Rest.', 508),
    ];
    const headings = pdfPagesToMarkdown([page]).split('\n\n').filter((p) => p.startsWith('#'));
    expect(headings).toEqual([
      '# Chapter 7: Lamp Magic',
      '## Casting Lamp Spells',
      '### Casting Time',
      '#### Longer Casting Times',
      '### Your Defenses',
      '#### Hit Point Dice',
    ]);
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

  it('starts a new line at a stat line after a list bullet, or with a colon after its label, even after a long line', () => {
    const lead = 'When the spirit appears, it takes the statistics the spell gives it in the short list that follows:';
    const stats = ['• AC 12 + the spell’s level', '\uf0b7 HP 20 + 5 for each spell level above 3', '– Speed 30 ft., Fly 30 ft.', 'AC: 15', 'o Hit Points: 40', '\uf0a7 Speed: 25 ft.', '➢ CR 1'];
    const page = [line(lead, 700), ...stats.flatMap((stat, i) => [line(stat, 688 - i * 24), line(lead, 676 - i * 24)])];
    const paragraphs = pdfPagesToMarkdown([page]).split('\n\n');
    for (const stat of stats) expect(paragraphs.some((p) => p.startsWith(stat)), stat).toBe(true);
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
