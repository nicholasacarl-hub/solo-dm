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
