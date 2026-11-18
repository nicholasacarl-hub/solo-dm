import { describe, expect, it } from 'vitest';
import { chunkDocument } from './chunk';
import { formattedPaste, htmlToMarkdown } from './htmlPaste';

const opts = { sourceId: 'paste', sourceName: 'Pasted' };

describe('htmlToMarkdown', () => {
  it('keeps a web page’s headings, paragraphs, lists, tables, bold and italics; links keep their text; images and scripts go', () => {
    const html = `<meta charset="utf-8"><h2 style="font-size: 24px">Chapter 4: Lamplit Play</h2>
      <p>Every evening at the lamp table follows a few <strong>habits</strong> and <em>customs</em>.
      See <a href="https://example.com/wicks">the wick rules</a>.<img src="art.png" alt="A lamp"></p>
      <h3>Actions</h3><p>On your turn you choose one main deed.</p>
      <ul><li>Light a wick</li><li>Trim a wick<ul><li>with scissors</li></ul></li></ul>
      <ol start="3"><li>Third</li><li>Fourth</li></ol>
      <table><caption>Table: Wick Lengths</caption><thead><tr><th>Length</th><th>Burn Time</th></tr></thead>
      <tbody><tr><td>Short</td><td>1 hour</td></tr><tr><td>Long | waxed</td><td><b>8</b> hours</td></tr></tbody></table>
      <script>alert('no')</script><style>p { color: red }</style>`;
    const conversion = htmlToMarkdown(html);
    expect(conversion.markdown).toBe(
      [
        '## Chapter 4: Lamplit Play',
        'Every evening at the lamp table follows a few **habits** and _customs_. See the wick rules.',
        '### Actions',
        'On your turn you choose one main deed.',
        '- Light a wick\n- Trim a wick\n  - with scissors',
        '3. Third\n4. Fourth',
        'Table: Wick Lengths',
        '| Length | Burn Time |\n| --- | --- |\n| Short | 1 hour |\n| Long \\| waxed | **8** hours |',
      ].join('\n\n'),
    );
    expect(conversion).toMatchObject({ headings: 2, tables: 1, lists: 2 });
  });

  it('puts each line of a line-broken paragraph on its own, and a description list’s term and value on one line', () => {
    const html = `<h3>Reed Lurker</h3><p><em>Medium Monstrosity, Unaligned</em></p>
      <p><strong>AC</strong> 13 <strong>Initiative</strong> +2 (12)<br><strong>HP</strong> 22 (5d8)<br>Speed 30 ft.<br></p>
      <dl><dt>Challenge</dt><dd>1 (XP 200; PB +2)</dd></dl>
      <p><strong><em>Bite.</em></strong> <em>Melee Attack Roll:</em> +4, reach 5 ft. <em>Hit:</em> 6 (1d8 + 2) Piercing damage.</p>`;
    expect(htmlToMarkdown(html).markdown).toBe(
      [
        '### Reed Lurker',
        '_Medium Monstrosity, Unaligned_',
        '**AC** 13 **Initiative** +2 (12)',
        '**HP** 22 (5d8)',
        'Speed 30 ft.',
        '**Challenge** 1 (XP 200; PB +2)',
        '**_Bite._** _Melee Attack Roll:_ +4, reach 5 ft. _Hit:_ 6 (1d8 + 2) Piercing damage.',
      ].join('\n\n'),
    );
  });

  it('reads a Google Docs copy: its normal-weight wrapper isn’t bold, its styled spans are, and list items hold paragraphs', () => {
    const html = `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1">
      <h1 dir="ltr"><span style="font-size:20pt;font-weight:400">Lamp Spells</span></h1>
      <p dir="ltr"><span style="font-size:11pt;font-weight:400">Spells of the </span><span style="font-size:11pt;font-weight:700">lamp</span><span style="font-size:11pt;font-weight:400"> and its </span><span style="font-size:11pt;font-weight:400;font-style:italic">wardens</span><span style="font-size:11pt;font-weight:400">.</span></p>
      <h2 dir="ltr"><span style="font-size:16pt;font-weight:400">Ember Lash</span></h2>
      <p dir="ltr"><span style="font-size:11pt;font-style:italic">Level 1 Evocation (Wizard)</span></p>
      <p dir="ltr"><span style="font-size:11pt;font-weight:700">Casting Time:</span><span style="font-size:11pt;font-weight:400"> Action</span></p>
      <ul><li dir="ltr" aria-level="1"><p dir="ltr" role="presentation"><span style="font-size:11pt">first point</span></p></li>
      <li dir="ltr" aria-level="1"><p dir="ltr" role="presentation"><span style="font-size:11pt">second point</span></p></li></ul>
      </b><br class="Apple-interchange-newline">`;
    expect(htmlToMarkdown(html).markdown).toBe(
      [
        '# Lamp Spells',
        'Spells of the **lamp** and its _wardens_.',
        '## Ember Lash',
        '_Level 1 Evocation (Wizard)_',
        '**Casting Time:** Action',
        '- first point\n- second point',
      ].join('\n\n'),
    );
  });

  it('reads headings from font sizes when nothing is tagged as one (Word headings set by size alone), and Word’s list paragraphs as a list', () => {
    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style><!--
      p.MsoNormal, li.MsoNormal, div.MsoNormal {margin:0in; font-size:11.0pt; font-family:"Calibri",sans-serif;} --></style></head>
      <body><!--StartFragment-->
      <p class=MsoNormal><b><span style='font-size:24.0pt'>Chapter 2: Making a Lamplighter<o:p></o:p></span></b></p>
      <p class=MsoNormal>Every lamplighter starts the same way, with a wick and a flame and a long night ahead of them.<o:p></o:p></p>
      <p class=MsoNormal><b><span style='font-size:18.0pt'>Step 1: Choose a Wick<o:p></o:p></span></b></p>
      <p class=MsoNormal>Pick the wick that suits the lamps you will tend, short or long, waxed or plain.<o:p></o:p></p>
      <p class=MsoListParagraphCxSpFirst style='text-indent:-.25in;mso-list:l0 level1 lfo1'><![if !supportLists]><span style='font-family:Symbol;mso-list:Ignore'>·<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;</span></span><![endif]>A short wick burns fast.<o:p></o:p></p>
      <p class=MsoListParagraphCxSpLast style='text-indent:-.25in;mso-list:l0 level2 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>a.<span>&nbsp;</span></span><![endif]>Waxed or plain.<o:p></o:p></p>
      <p class=MsoNormal><b><span style='font-size:15.0pt'>Proficiency Bonus<o:p></o:p></span></b></p>
      <p class=MsoNormal>Your bonus grows as you light more lamps across the long dark of the year.<o:p></o:p></p>
      <!--EndFragment--></body></html>`;
    const conversion = htmlToMarkdown(html);
    expect(conversion.markdown).toBe(
      [
        '# Chapter 2: Making a Lamplighter',
        'Every lamplighter starts the same way, with a wick and a flame and a long night ahead of them.',
        '## Step 1: Choose a Wick',
        'Pick the wick that suits the lamps you will tend, short or long, waxed or plain.',
        '- A short wick burns fast.\n  - Waxed or plain.',
        '### Proficiency Bonus',
        'Your bonus grows as you light more lamps across the long dark of the year.',
      ].join('\n\n'),
    );
    expect(chunkDocument(conversion.markdown, opts).map((e) => e.path ?? [e.name])).toEqual([
      ['Chapter 2: Making a Lamplighter'],
      ['Chapter 2: Making a Lamplighter', 'Step 1: Choose a Wick'],
      ['Chapter 2: Making a Lamplighter', 'Step 1: Choose a Wick', 'Proficiency Bonus'],
    ]);
  });

  it('reads no headings from sizes when larger text is most of it', () => {
    const html = '<p><span style="font-size:24px">A banner of large text that runs on and on</span></p><p><span style="font-size:24px">and on again</span></p><p>small print</p>';
    expect(htmlToMarkdown(html).headings).toBe(0);
  });

  it('prints text that would otherwise turn into Markdown structure as itself', () => {
    const html = '<p># not a heading</p><p>- not a list</p><p>1. not a list either</p><p>&gt; not a quote</p><p>5 * 3 = 15 and snake_case `x`</p><p>---</p>';
    expect(htmlToMarkdown(html).markdown).toBe(
      ['\\# not a heading', '\\- not a list', '1\\. not a list either', '\\> not a quote', '5 \\* 3 = 15 and snake\\_case \\`x\\`', '\\---'].join('\n\n'),
    );
  });

  it('reads a layout table’s cells as blocks, and a data table’s spans and missing cells as a table', () => {
    const box = '<table><tr><td><h3>Sidebar: Old Wicks</h3><p>Old wicks burn unevenly.</p></td></tr></table>';
    expect(htmlToMarkdown(box).markdown).toBe('### Sidebar: Old Wicks\n\nOld wicks burn unevenly.');
    const data = '<table><tr><th colspan="2">Wick</th><th>Cost</th></tr><tr><td>Short</td><td>Plain</td><td>1 cp</td></tr><tr><td>Long</td></tr></table>';
    expect(htmlToMarkdown(data).markdown).toBe('| Wick |  | Cost |\n| --- | --- | --- |\n| Short | Plain | 1 cp |\n| Long |  |  |');
  });

  it('leaves out hidden text', () => {
    const html = '<h2>Lamps</h2><p>Seen<span style="display:none"> hidden</span><span aria-hidden="true"> icon</span><span hidden> gone</span>.</p>';
    expect(htmlToMarkdown(html).markdown).toBe('## Lamps\n\nSeen.');
  });

  it("leaves out a picture with its caption and the artist's credit, and reads a figure that holds more", () => {
    const art = (inner: string) =>
      `<h3>Lantern Call</h3><p>You call a lantern spirit.</p><figure class="compendium-art"><span class="artist-credit">Ada Quill</span>` +
      `<a href="art.png"><img src="art.png" alt="A spirit"></a>${inner}</figure><p>It obeys you.</p>`;
    expect(htmlToMarkdown(art('<figcaption>A lantern spirit drifts over the marsh at dusk, its light pale and cold</figcaption>')).markdown).toBe(
      '### Lantern Call\n\nYou call a lantern spirit.\n\nIt obeys you.',
    );
    const table = '<figure><img src="w.png"><table><tr><th>Wick</th><th>Hours</th></tr><tr><td>Long</td><td>8</td></tr></table><figcaption>Table: Wicks</figcaption></figure>';
    expect(htmlToMarkdown(table).markdown).toBe('| Wick | Hours |\n| --- | --- |\n| Long | 8 |\n\nTable: Wicks');
    const prose = art('<p>Lantern spirits glow brighter near the dead, and dim when their caller lies.</p><figcaption>Lore</figcaption>');
    expect(htmlToMarkdown(prose).markdown).toContain('Lantern spirits glow brighter near the dead');
    expect(htmlToMarkdown('<figure><p>Light the way.</p><figcaption>An old saying</figcaption></figure>').markdown).toBe('Light the way.\n\nAn old saying');
  });

  it('reads a whole page copied (select-all) from its main landmark, and leaves out navigation wherever it is', () => {
    const page = `<header><nav><ul><li><a href="/">Games</a></li><li><a href="/sources">Sources</a></li></ul></nav><div>Sign In</div></header>
      <main><h1>Chapter 3: Lamplighting</h1>
      <div role="navigation"><h2>Contents</h2><ul><li>Wicks</li><li>Oils</li></ul></div>
      <p>Lamplighters tend the roads at dusk, one lamp at a time.</p>
      <h2>Wicks</h2><p>A wick is trimmed before it is lit, and again at midnight.</p>
      <nav><a href="/ch2">Previous</a> <a href="/ch4">Next</a></nav></main>
      <footer><h3>Help</h3><ul><li>Privacy</li><li>Terms</li></ul><p>© 2026 Rules Site.</p></footer>`;
    expect(htmlToMarkdown(page).markdown).toBe(
      '# Chapter 3: Lamplighting\n\nLamplighters tend the roads at dusk, one lamp at a time.\n\n## Wicks\n\nA wick is trimmed before it is lit, and again at midnight.',
    );
    // A selection without the page around it: an article's own header and footer (no landmark role) stay.
    const article = `<header><h2>Ember Lash</h2><p><em>Level 1 Evocation (Wizard)</em></p></header><p>A whip of embers.</p>
      <footer><p>Found in the lamp chapter.</p></footer><div role="contentinfo">© Rules Site</div>`;
    expect(htmlToMarkdown(article).markdown).toBe('## Ember Lash\n\n_Level 1 Evocation (Wizard)_\n\nA whip of embers.\n\nFound in the lamp chapter.');
    // A main landmark that holds less than half the text isn't the whole of the content.
    const aside = '<main><p>Short.</p></main><h2>Wick Lore</h2><p>Long after the lamps go out, the lore of the wick lives on in the guild.</p>';
    expect(htmlToMarkdown(aside).markdown).toBe('Short.\n\n## Wick Lore\n\nLong after the lamps go out, the lore of the wick lives on in the guild.');
  });

  it('keeps the cells after a merged cell (rowspan) in their columns', () => {
    const classTable = `<table><tr><th rowspan="2">Level</th><th rowspan="2">Features</th><th colspan="2">Wicks per Night</th></tr>
      <tr><th>Short</th><th>Long</th></tr><tr><td>1</td><td>Lamplight</td><td>2</td><td>1</td></tr></table>`;
    expect(htmlToMarkdown(classTable).markdown).toBe(
      '| Level | Features | Wicks per Night |  |\n| --- | --- | --- | --- |\n|  |  | Short | Long |\n| 1 | Lamplight | 2 | 1 |',
    );
    const roads = `<table><tr><th>Season</th><th>Road</th><th>DC</th><th>Hazard</th></tr>
      <tr><td rowspan="2">Autumn</td><td>Wet</td><td>12</td><td rowspan="2">Leaves</td></tr><tr><td>Dry</td><td>10</td></tr>
      <tr><td>Winter</td><td>Icy</td><td>15</td><td>Frost</td></tr></table>`;
    expect(htmlToMarkdown(roads).markdown).toBe(
      '| Season | Road | DC | Hazard |\n| --- | --- | --- | --- |\n| Autumn | Wet | 12 | Leaves |\n|  | Dry | 10 |  |\n| Winter | Icy | 15 | Frost |',
    );
    // A short row under a merged cell further right: the merge still ends there.
    const short = `<table><tr><th>A</th><th>B</th><th>C</th><th>D</th></tr><tr><td>1</td><td>2</td><td>3</td><td rowspan="2">4</td></tr>
      <tr><td>5</td><td>6</td></tr><tr><td>7</td><td>8</td><td>9</td><td>10</td></tr></table>`;
    expect(htmlToMarkdown(short).markdown).toBe('| A | B | C | D |\n| --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 |\n| 5 | 6 |  |  |\n| 7 | 8 | 9 | 10 |');
  });

  it('reads elements marked as headings (Word for the web), and a list item that is only a heading (numbered headings) as that heading', () => {
    const wordOnline = `<div class="OutlineElement Ltr"><p class="Paragraph" role="heading" aria-level="1"><span>Lamp Rules</span></p></div>
      <div class="OutlineElement Ltr"><p class="Paragraph"><span>Lamps are lit at dusk.</span></p></div>
      <div class="OutlineElement Ltr"><p class="Paragraph" role="heading" aria-level="3"><span>Trimming</span></p></div>
      <div class="OutlineElement Ltr"><p class="Paragraph"><span>Trim before lighting.</span></p></div><div role="heading">Unnumbered</div>`;
    expect(htmlToMarkdown(wordOnline).markdown).toBe('# Lamp Rules\n\nLamps are lit at dusk.\n\n### Trimming\n\nTrim before lighting.\n\n## Unnumbered');
    const numbered = `<b style="font-weight:normal;" id="docs-internal-guid-2">
      <ol><li dir="ltr" aria-level="1"><h2 dir="ltr" role="presentation"><span>Ember Lash</span></h2></li></ol>
      <p dir="ltr"><span style="font-style:italic">Level 1 Evocation (Wizard)</span></p>
      <ol start="2"><li dir="ltr" aria-level="1"><h2 dir="ltr" role="presentation"><span>Glow Mote</span></h2></li></ol>
      <p dir="ltr"><span>A mote of light.</span></p></b>`;
    expect(htmlToMarkdown(numbered).markdown).toBe('## Ember Lash\n\n_Level 1 Evocation (Wizard)_\n\n## Glow Mote\n\nA mote of light.');
    // A question and its answer in one item stay an item.
    expect(htmlToMarkdown('<ul><li><h3>Can a wick be relit?</h3><p>Yes, once.</p></li></ul>').markdown).toBe('- Can a wick be relit? Yes, once.');
  });

  it('reads short bold lines as headings in a document editor’s copy, below a title set by size', () => {
    const lines = `<p dir="ltr"><span style="font-size:11pt;font-weight:700">Tower Spells</span></p>
      <p dir="ltr"><span style="font-size:11pt;font-weight:400">Spells the bell ringers teach.</span></p>
      <p dir="ltr"><span style="font-size:11pt;font-weight:700">Toll of Dawn</span></p>
      <p dir="ltr"><span style="font-size:11pt;font-style:italic">Level 1 Evocation (Bard)</span></p>
      <p dir="ltr"><span style="font-size:11pt;font-weight:700">Casting Time:</span><span style="font-size:11pt;font-weight:400"> Action</span></p>
      <ul><li dir="ltr"><p dir="ltr" role="presentation"><span style="font-size:11pt">rings once</span></p></li></ul>
      <p dir="ltr"><span style="font-size:11pt;font-weight:700">Quiet Hour</span></p>
      <p dir="ltr"><span style="font-size:11pt;font-style:italic">Level 2 Enchantment (Bard)</span></p>
      <p dir="ltr"><span style="font-size:11pt;font-weight:700">Note:</span></p>`;
    const docs = (body: string) => `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-3">${body}</b>`;
    const conversion = htmlToMarkdown(docs(lines));
    expect(conversion.markdown).toBe(
      [
        '# Tower Spells',
        'Spells the bell ringers teach.',
        '# Toll of Dawn',
        '_Level 1 Evocation (Bard)_',
        '**Casting Time:** Action',
        '- rings once',
        '# Quiet Hour',
        '_Level 2 Enchantment (Bard)_',
        '**Note:**',
      ].join('\n\n'),
    );
    expect(chunkDocument(conversion.markdown, opts).map((e) => [e.name, e.kind])).toEqual([
      ['Tower Spells', 'rule'],
      ['Toll of Dawn', 'spell'],
      ['Quiet Hour', 'spell'],
    ]);
    const titled = htmlToMarkdown(docs(`<p dir="ltr"><span style="font-size:26pt">Bell Notes</span></p>${lines}`)).markdown;
    expect(titled.startsWith('# Bell Notes\n\n## Tower Spells\n\nSpells the bell ringers teach.\n\n## Toll of Dawn')).toBe(true);
    // Not from a web page, where bold lines are labels; not one bold line alone.
    expect(htmlToMarkdown(lines).headings).toBe(0);
    expect(htmlToMarkdown(docs('<p><b>Tower Spells</b></p><p>Spells the bell ringers teach.</p><ul><li>one</li></ul>')).headings).toBe(0);
  });

  it('reads no bold lines as headings when headings by size come after them (they are labels)', () => {
    const word = `<html><head><style>p.MsoNormal {font-size:11.0pt;}</style></head><body>
      <p class=MsoNormal><b><span style='font-size:20.0pt'>Lamp Oils</span></b></p>
      <p class=MsoNormal><b>Whale Oil</b></p><p class=MsoNormal>Burns bright and long, but smells of the sea for days.</p>
      <p class=MsoNormal><b><span style='font-size:20.0pt'>Wicks</span></b></p>
      <p class=MsoNormal><b>Cotton</b></p><p class=MsoNormal>Cheap, and easy to trim with a lamplighter's shears.</p></body></html>`;
    expect(htmlToMarkdown(word).markdown).toBe(
      [
        '# Lamp Oils',
        '**Whale Oil**',
        'Burns bright and long, but smells of the sea for days.',
        '# Wicks',
        '**Cotton**',
        "Cheap, and easy to trim with a lamplighter's shears.",
      ].join('\n\n'),
    );
  });

  it('reads larger bold lines beside a few tagged headings as headings below them, but not larger lines that aren’t bold', () => {
    const word = `<html><head><style>p.MsoNormal {font-size:11.0pt;}</style></head><body><h1>Bell Notes</h1>
      <p class=MsoNormal><b><span style='font-size:18.0pt'>Tower Spells</span></b></p>
      <p class=MsoNormal>Spells the bell ringers teach to their apprentices over a long winter.</p>
      <p class=MsoNormal><b><span style='font-size:14.0pt'>Toll of Dawn</span></b></p><p class=MsoNormal><i>Level 1 Evocation (Bard)</i></p>
      <p class=MsoNormal><b><span style='font-size:14.0pt'>Quiet Hour</span></b></p><p class=MsoNormal><i>Level 2 Enchantment (Bard)</i></p></body></html>`;
    expect(htmlToMarkdown(word).markdown).toBe(
      [
        '# Bell Notes',
        '## Tower Spells',
        'Spells the bell ringers teach to their apprentices over a long winter.',
        '### Toll of Dawn',
        '_Level 1 Evocation (Bard)_',
        '### Quiet Hour',
        '_Level 2 Enchantment (Bard)_',
      ].join('\n\n'),
    );
    const article = `<h1>The Lamplighters' Guild</h1><p>The guild was founded in a hard winter, when the roads were dark and long.</p>
      <p style="font-size:24px"><em>“Every lamp a promise.”</em></p><p>Its members swore to light every lamp on every road.</p>
      <p style="font-size:24px"><em>“No road left dark.”</em></p><p>They kept that oath for a hundred years and more.</p>`;
    expect(htmlToMarkdown(article).headings).toBe(1);
  });

  describe('a creature, a species or a spell typed in a document, its name and parts bold', () => {
    const span = (text: string, style = '') => `<span style="font-size:11pt;${style}">${text}</span>`;
    const p = (...spans: string[]) => `<p dir="ltr">${spans.join('')}</p>`;
    const bold = (text: string) => p(span(text, 'font-weight:700'));
    const runIn = (label: string, text: string) => p(span(label, 'font-weight:700;font-style:italic'), span(` ${text}`, 'font-weight:400'));
    const docs = (body: string) => `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-7">${body}</b>`;
    const cells = (row: string[]) => `<tr>${row.map((c) => `<td>${p(span(c))}</td>`).join('')}</tr>`;
    const creature = (name: string, scores: string[], parts: string) =>
      [
        bold(name),
        p(span('Tiny Fey, Neutral', 'font-style:italic')),
        p(span('Armor Class', 'font-weight:700'), span(' 13')),
        p(span('Hit Points', 'font-weight:700'), span(' 10 (4d4)')),
        p(span('Speed', 'font-weight:700'), span(' 10 ft., Fly 40 ft.')),
        `<table><tbody>${cells(['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'])}${cells(scores)}</tbody></table>`,
        p(span('Challenge', 'font-weight:700'), span(' 1/4 (XP 50)')),
        parts,
      ].join('');
    const sprite = creature(
      'Rafter Sprite',
      ['3 (−4)', '16 (+3)', '10 (+0)', '8 (−1)', '12 (+1)', '13 (+1)'],
      bold('Actions') +
        runIn('Rafter Kick.', 'Melee Attack Roll: +5, reach 5 ft. Hit: 5 (1d4 + 3) Bludgeoning damage.') +
        bold('Reactions') +
        runIn('Flit.', 'Trigger: A creature the sprite can see hits it with an attack roll. Response: The sprite flies 10 feet.'),
    );
    const wisp = creature(
      'Gutter Wisp',
      ['1 (−5)', '18 (+4)', '10 (+0)', '6 (−2)', '10 (+0)', '9 (−1)'],
      bold('ACTIONS') + runIn('Damp Touch.', 'Melee Attack Roll: +6, reach 5 ft. Hit: 6 (1d4 + 4) Cold damage.'),
    );

    it('keeps a stat block’s bold Actions and Reactions under its bold name, so the creature keeps its actions', () => {
      const conversion = htmlToMarkdown(docs(sprite));
      expect(conversion.markdown.split('\n\n').filter((l) => l.startsWith('#'))).toEqual(['# Rafter Sprite', '## Actions', '## Reactions']);
      const entries = chunkDocument(conversion.markdown, opts);
      expect(entries.map((e) => [e.name, e.kind])).toEqual([['Rafter Sprite', 'monster']]);
      expect(entries[0].text).toContain('Rafter Kick.');
      expect(entries[0].text).toContain('Flit.');
      // Two creatures stay two, each with its own actions (a part's name in capitals too).
      const two = chunkDocument(htmlToMarkdown(docs(sprite + wisp)).markdown, opts);
      expect(two.map((e) => [e.name, e.kind])).toEqual([
        ['Rafter Sprite', 'monster'],
        ['Gutter Wisp', 'monster'],
      ]);
      expect(two[1].text).toContain('Damp Touch.');
      expect(two[0].text).not.toContain('Damp Touch.');
    });

    it('keeps a species’ bold Traits and a spell’s bold At Higher Levels with them', () => {
      const species = (name: string, trait: string) =>
        bold(name) + p(span(`The ${name} keep the old bell towers.`)) + bold('Traits') + runIn(`${trait}.`, 'You can hear a bell ring from a mile away.');
      const both = chunkDocument(htmlToMarkdown(docs(species('Bellfolk', 'Far Hearing') + species('Lanternfolk', 'Steady Light'))).markdown, opts);
      expect(both.map((e) => e.name)).toEqual(['Bellfolk', 'Lanternfolk']);
      expect(both[0].text).toContain('Far Hearing.');
      const spell = [
        bold('Ember Lash'),
        p(span('Level 1 Evocation (Wizard)', 'font-style:italic')),
        p(span('Casting Time:', 'font-weight:700'), span(' Action')),
        p(span('Range:', 'font-weight:700'), span(' 30 feet')),
        p(span('Components:', 'font-weight:700'), span(' V, S')),
        p(span('Duration:', 'font-weight:700'), span(' Instantaneous')),
        p(span('A lash of embers strikes one creature you can see within range.')),
        bold('At Higher Levels'),
        p(span('The lash strikes one more creature for each spell slot level above 1.')),
      ].join('');
      const entries = chunkDocument(htmlToMarkdown(docs(spell)).markdown, opts);
      expect(entries.map((e) => [e.name, e.kind])).toEqual([['Ember Lash', 'spell']]);
      expect(entries[0].text).toContain('for each spell slot level above 1');
    });
  });

  it('reads no bold labels as headings beside a tagged title when a larger line comes after them, bold or not', () => {
    // A creature page pasted into Word (its title a Heading 1), then copied: the ability labels are bold over their
    // values, and "Actions" is larger but not bold.
    const para = (html: string) => `<p class=MsoNormal>${html}<o:p></o:p></p>`;
    const scores = ['STR', '13 (+1)', 'DEX', '15 (+2)', 'CON', '14 (+2)', 'INT', '4 (−3)', 'WIS', '12 (+1)', 'CHA', '7 (−2)'];
    const word = `<html><head><meta name=Generator content="Microsoft Word 15"><style>p.MsoNormal {font-size:11.0pt;}</style></head><body>
      <h1>Cinder Jackal</h1>${para("<b><span style='font-size:25.5pt'>Cinder Jackal</span></b>")}${para('<i>Small Monstrosity, Unaligned</i>')}
      ${para('<b>Armor Class</b> 13')}${para('<b>Hit Points</b> 22 (4d6 + 8)')}${para('<b>Speed</b> 40 ft.')}
      ${scores.map((s, i) => para(i % 2 ? s : `<b>${s}</b>`)).join('')}
      ${para('<b>Senses</b> Darkvision 60 ft., Passive Perception 11')}${para('<b>Challenge</b> 1/2 (XP 100)')}
      ${para("<span style='font-size:18.0pt'>Actions</span>")}
      ${para('<b><i>Ash Bite.</i></b> Melee Attack Roll: +4, reach 5 ft. Hit: 5 (1d6 + 2) Fire damage.')}</body></html>`;
    const conversion = htmlToMarkdown(word);
    expect(conversion.headings).toBe(1);
    expect(conversion.markdown).toContain('**STR**\n\n13 (+1)');
    expect(chunkDocument(conversion.markdown, opts).map((e) => [e.name, e.kind])).toEqual([['Cinder Jackal', 'monster']]);
  });

  it('reads Word’s weight, style and body size, not its complex-script ones (mso-bidi-…)', () => {
    const word = (style: string, body: string) =>
      `<html><head><meta name=Generator content="Microsoft Word 15"><style>p.MsoNormal {${style}}</style></head><body>${body}</body></html>`;
    const bidiBold = (text: string) => `<p class=MsoNormal><b style='mso-bidi-font-weight:normal'>${text}<o:p></o:p></b></p>`;
    const lines = [
      bidiBold('Tower Spells'),
      '<p class=MsoNormal>Spells the bell ringers teach.</p>',
      bidiBold('Toll of Dawn'),
      "<p class=MsoNormal><i style='mso-bidi-font-style:normal'>Level 1 Evocation (Bard)</i></p>",
      bidiBold('Quiet Hour'),
      "<p class=MsoNormal><span style='mso-bidi-font-weight:bold'>Ask the sexton first.</span></p>",
    ].join('');
    expect(htmlToMarkdown(word('font-size:11.0pt;', lines)).markdown).toBe(
      ['# Tower Spells', 'Spells the bell ringers teach.', '# Toll of Dawn', '_Level 1 Evocation (Bard)_', '# Quiet Hour', 'Ask the sexton first.'].join(
        '\n\n',
      ),
    );
    // The body size is font-size's, not a complex-script size written before it: 14pt lines are headings over 11pt text.
    const sized = `<p class=MsoNormal><span style='font-size:14.0pt'>Wick Care</span></p><p class=MsoNormal>Trim the wick before every lighting, and never after.</p>
      <p class=MsoNormal><span style='font-size:14.0pt'>Oil Care</span></p><p class=MsoNormal>Keep the oil sealed and away from the cold cellar wall.</p>`;
    expect(htmlToMarkdown(word('mso-bidi-font-size:20.0pt;\n\tfont-size:11.0pt;', sized)).headings).toBe(2);
  });

  it('reads very deep nesting without running out of stack', () => {
    const depth = 5000;
    const html = `<h2>Deep</h2>${'<div>'.repeat(depth)}bottom text${'</div>'.repeat(depth)}`;
    const conversion = htmlToMarkdown(html);
    expect(conversion.markdown.startsWith('## Deep\n\n')).toBe(true);
    expect(conversion.markdown).toContain('bottom text');
  });
});

describe('formattedPaste', () => {
  it('converts a copy that holds headings, tables or lists', () => {
    expect(formattedPaste('<h2>Fireball</h2><p>A bright streak.</p>', 'Fireball\nA bright streak.')?.markdown).toBe('## Fireball\n\nA bright streak.');
    expect(formattedPaste('<ul><li>one</li></ul>', 'one')?.lists).toBe(1);
  });

  it('leaves a paste as plain text when it has no HTML, only prose, or is Markdown copied from an editor', () => {
    expect(formattedPaste('', 'plain')).toBeNull();
    expect(formattedPaste('<p>Just <b>prose</b>.</p>', 'Just prose.')).toBeNull();
    const editor = '<div style="font-size: 14px; white-space: pre;"><div><span style="font-weight: bold;">## Fireball</span></div><div><span>Level 3 Evocation</span></div></div>';
    expect(formattedPaste(editor, '## Fireball\nLevel 3 Evocation')).toBeNull();
  });
});
