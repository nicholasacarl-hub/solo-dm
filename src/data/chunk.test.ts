import { describe, expect, it } from 'vitest';
import { chunkDocument, guessKind, headingAncestors, inferPlainTextHeadings, misreadBefore, splitIntoChunks, staleEntryKinds, TARGET_CHUNK_CHARS } from './chunk';
import type { CompendiumEntry } from '@/types';

const opts = { sourceId: 'import-abc', sourceName: 'My Notes' };

const FIREBALL = `_Level 3 Evocation (Sorcerer, Wizard)_

- **Casting Time:** Action
- **Range:** 150 feet
- **Components:** V, S, M (a ball of bat guano and sulfur)
- **Duration:** Instantaneous

A bright streak flashes from you to a point you choose within range and then blossoms into a fiery explosion.`;

const GOBLIN = `_Small Fey (Goblinoid), Chaotic Neutral_

- **AC** 15
- **Initiative** +2 (12)
- **HP** 10 (3d6)
- **Speed** 30 ft.
- **CR** 1/4 (XP 50; PB +2)`;

/** A paragraph of roughly `n` characters. */
const paragraph = (n: number, word = 'lorem') => `${`${word} `.repeat(Math.ceil(n / (word.length + 1))).trim().slice(0, n - 1)}.`;

describe('chunkDocument', () => {
  it('splits Markdown at headings and numbers the entries', () => {
    const entries = chunkDocument('# Grappling\nYou can grab a creature.\n\n# Shoving\nYou can push a creature.', opts);
    expect(entries.map((e) => e.name)).toEqual(['Grappling', 'Shoving']);
    expect(entries.map((e) => e.id)).toEqual(['lib:import-abc:1', 'lib:import-abc:2']);
    expect(entries[0]).toMatchObject({ sourceId: 'import-abc', sourceName: 'My Notes', kind: 'rule', text: 'You can grab a creature.' });
    expect(entries[0].path).toBeUndefined();
  });

  it('records nested headings as the path and skips empty container headings', () => {
    const text = [
      '# Chapter 9: Combat',
      '## Actions in Combat',
      'Every turn you can take one action.',
      '### Dash',
      'You gain extra movement.',
      '### Dodge',
      'Attacks against you have disadvantage.',
      '## Cover',
      'Walls and trees can protect you.',
    ].join('\n');
    const entries = chunkDocument(text, opts);
    expect(entries.map((e) => e.name)).toEqual(['Actions in Combat', 'Dash', 'Dodge', 'Cover']);
    expect(entries[1].path).toEqual(['Chapter 9: Combat', 'Actions in Combat', 'Dash']);
    expect(entries[1].summary).toBe('Chapter 9: Combat › Actions in Combat');
    expect(entries[3].path).toEqual(['Chapter 9: Combat', 'Cover']);
  });

  it('names text before the first heading after the source', () => {
    const entries = chunkDocument('Some house rules for my table.\n\n## Critical Hits\nRoll the dice twice.', opts);
    expect(entries.map((e) => e.name)).toEqual(['My Notes', 'Critical Hits']);
  });

  it('cuts text without headings into ~1500-character paragraph chunks', () => {
    // Three 400-character paragraphs fit in one chunk; a fourth would pass 1500.
    const paras = Array.from({ length: 9 }, (_, i) => paragraph(400, `word${i}`));
    const entries = chunkDocument(paras.join('\n\n'), opts);
    expect(entries.length).toBe(3);
    expect(entries.map((e) => e.name)).toEqual(['My Notes (part 1)', 'My Notes (part 2)', 'My Notes (part 3)']);
    for (const e of entries) expect(e.text.length).toBeLessThanOrEqual(TARGET_CHUNK_CHARS + 2);
    // Nothing is lost or reordered.
    expect(entries.map((e) => e.text).join('\n\n')).toBe(paras.join('\n\n'));
  });

  it('keeps a short document without headings as one entry', () => {
    const entries = chunkDocument('Just one note about the campaign.', opts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'My Notes', text: 'Just one note about the campaign.' });
  });

  it('splits very long sections into numbered parts', () => {
    const body = Array.from({ length: 12 }, (_, i) => paragraph(500, `topic${i}`)).join('\n\n');
    const entries = chunkDocument(`## Downtime Activities\n${body}`, opts);
    expect(entries.length).toBeGreaterThan(2);
    expect(entries[0].name).toBe('Downtime Activities');
    expect(entries[1].name).toBe('Downtime Activities (part 2)');
    for (const e of entries) expect(e.text.length).toBeLessThanOrEqual(TARGET_CHUNK_CHARS + 2);
  });

  it('cuts one huge paragraph at sentence ends', () => {
    const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} explains a small rule about the game.`).join(' ');
    const chunks = splitIntoChunks(sentences);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(TARGET_CHUNK_CHARS);
      expect(c.endsWith('.')).toBe(true);
    }
  });

  it('keeps a monster stat block with its subsections as one entry', () => {
    const text = `# Bestiary\n\n## Goblin Warrior\n${GOBLIN}\n\n### Actions\n**Scimitar.** Melee Attack Roll: +4.\n\n### Bonus Actions\n**Nimble Escape.** The goblin takes the Disengage or Hide action.\n\n## Wolf\nAn ordinary wolf.`;
    const entries = chunkDocument(text, opts);
    expect(entries.map((e) => e.name)).toEqual(['Goblin Warrior', 'Wolf']);
    expect(entries[0].kind).toBe('monster');
    expect(entries[0].text).toContain('### Actions');
    expect(entries[0].text).toContain('Nimble Escape');
    expect(entries[0].summary).toBe('CR 1/4 · Small Fey (Goblinoid)');
    expect(entries[0].data).toEqual({ cr: '1/4' });
  });

  it('parses spell level, school and classes for spells', () => {
    const [spell] = chunkDocument(`## Fireball\n${FIREBALL}`, opts);
    expect(spell.kind).toBe('spell');
    expect(spell.summary).toBe('Level 3 Evocation (Sorcerer, Wizard)');
    expect(spell.data).toEqual({ level: 3, school: 'Evocation', classes: ['Sorcerer', 'Wizard'] });
  });

  it('understands setext headings and ignores # lines inside code fences', () => {
    const text = 'Wild Magic\n==========\n\nSurges happen.\n\n```\n# not a heading\n```\n\nVariant Rules\n-------------\n\nOptional rules.';
    const entries = chunkDocument(text, opts);
    expect(entries.map((e) => e.name)).toEqual(['Wild Magic', 'Variant Rules']);
    expect(entries[0].text).toContain('# not a heading');
    expect(entries[1].path).toEqual(['Wild Magic', 'Variant Rules']);
  });

  it('finds headings in pasted plain text (spell names before their stat lines)', () => {
    const text = [
      'Fireball',
      'Level 3 Evocation (Sorcerer, Wizard)',
      'Casting Time: Action',
      'Range: 150 feet',
      '',
      'A bright streak flashes from you to a point you choose within range.',
      '',
      'Fire Bolt',
      'Evocation Cantrip (Sorcerer, Wizard)',
      'Casting Time: Action',
      '',
      'You hurl a mote of fire at a creature or an object within range.',
    ].join('\n');
    const entries = chunkDocument(text, opts);
    expect(entries.map((e) => [e.name, e.kind])).toEqual([
      ['Fireball', 'spell'],
      ['Fire Bolt', 'spell'],
    ]);
    expect(entries[1].data).toMatchObject({ level: 0, school: 'Evocation' });
  });

  it('returns nothing for empty text', () => {
    expect(chunkDocument('  \n\n ', opts)).toEqual([]);
  });

  it("keeps a chapter's spells as entries of their own whatever its own text reads as; other sections stay whole", () => {
    const spells = '### Glow Mote\n\n*Level 1 Evocation (Wizard)*\n\n**Casting Time:** Bonus Action\n\n**Range:** 30 feet\n\nA mote of light.\n\n### Ember Lash\n\n*Evocation Cantrip (Wizard)*\n\n**Casting Time:** Action\n\n**Range:** 60 feet\n\nA lash of embers.';
    const chapter = (intro: string) => chunkDocument(`# Lantern Lore\n\n## Spells\n\n${intro}\n\n${spells}`, opts).map((e) => [e.name, e.kind]);
    // An intro that reads as a spell (run-in labels, a sample card) is an entry of its own, and the spells are theirs.
    expect(chapter("Each spell's description opens with a block of information.\n\n**Casting Time.** How long it takes to cast the spell.\n\n**Range.** How far the spell reaches.")).toEqual([['Spells', 'spell'], ['Glow Mote', 'spell'], ['Ember Lash', 'spell']]);
    expect(chapter('A spell card looks like this:\n\nCasting Time    1 action\nRange    60 feet')).toEqual([['Spells', 'spell'], ['Glow Mote', 'spell'], ['Ember Lash', 'spell']]);
    // What each field of a spell block can be, or the class's list of spells copied from a web grid: a rules text.
    expect(chapter('Each spell opens with a short block:\n\nCasting Time    Action, Bonus Action, Reaction, or longer\nRange    Self, Touch, or a distance')).toEqual([['Spells', 'rule'], ['Glow Mote', 'spell'], ['Ember Lash', 'spell']]);
    expect(chapter(['Level', 'Name', 'Casting Time', 'Range/Area', 'Cantrip', 'Ember Lash', '1 Action', '60 ft.', '1st', 'Glow Mote', '1 Bonus Action', '30 ft.'].join('\n\n'))).toEqual([['Spells', 'rule'], ['Glow Mote', 'spell'], ['Ember Lash', 'spell']]);
    // A list of the casting times spells can have whose first one has a qualifier ("Action (most spells), …").
    expect(chapter('Each spell opens with a short block:\n\n- **Casting Time** Action (most spells), Bonus Action, Reaction, or longer\n- **Range** Self, Touch, or a distance')).toEqual([['Spells', 'rule'], ['Glow Mote', 'spell'], ['Ember Lash', 'spell']]);
    // A summoning spell keeps its creature's section, a creature its variant's.
    const summon = chunkDocument('## Find Lantern Hound\n\n*Level 2 Conjuration (Wizard)*\n\n**Casting Time:** Action\n\nYou summon a hound.\n\n### Lantern Hound\n\n*Medium Celestial, Neutral*\n\n**AC** 12\n\n**HP** 22 (4d8)\n\n**CR** 1 (XP 200; PB +2)', opts);
    expect(summon.map((e) => [e.name, e.kind])).toEqual([['Find Lantern Hound', 'spell']]);
    expect(summon[0].text).toContain('### Lantern Hound');
    const wight = chunkDocument('## Lamp Wight\n\n*Medium Undead, Neutral Evil*\n\n**AC** 13\n\n**HP** 22 (5d8)\n\n**CR** 1 (XP 200; PB +2)\n\n### Variant: Lamp Wight Captain\n\n*Medium Undead, Neutral Evil*\n\n**AC** 15\n\n**HP** 45 (10d8)\n\n**CR** 3 (XP 700; PB +2)', opts);
    expect(wight.map((e) => [e.name, e.kind])).toEqual([['Lamp Wight', 'monster']]);
  });

  it("keeps a rules section's subsections as rule entries when its intro shows a spell block whose first casting time has a qualifier", () => {
    const block = (marks: (label: string) => string, castingTime: string) =>
      `${marks('Casting Time')}${castingTime}\n${marks('Range')}Self, Touch, or a distance in feet\n${marks('Components')}V, S, M\n${marks('Duration')}Instantaneous, or a length of time`;
    const section = (intro: string) =>
      `# Lantern Lore\n\n## Casting Spells\n\nEach spell's description opens with a block like this one:\n\n${intro}\n\nThe sections below explain each entry.\n\n### Casting Time\n\nMost spells take an action to cast.\n\n### Range\n\nA spell's range is how far its effect can start.\n\n### Duration\n\nA spell's duration is how long its effect lasts.`;
    const want = [['Casting Spells', 'rule'], ['Casting Time', 'rule'], ['Range', 'rule'], ['Duration', 'rule']];
    for (const intro of [
      block((l) => `- **${l}** `, 'Action (most spells), Bonus Action, Reaction, or longer'),
      `> [!info] A spell block\n${block((l) => `> - **${l}** `, 'Action (most spells), Bonus Action, Reaction, or longer')}`,
      block((l) => `${l}\t`, 'Action for most spells; some take a Bonus Action, a Reaction, or longer'),
      block((l) => `● ${l} `, '1 action (most spells), 1 bonus action, 1 reaction, or longer'),
    ]) {
      expect([intro.slice(0, 30), chunkDocument(section(intro), opts).map((e) => [e.name, e.kind])]).toEqual([intro.slice(0, 30), want]);
    }
  });
});

describe('inferPlainTextHeadings', () => {
  it('needs at least two title-like lines', () => {
    expect(inferPlainTextHeadings('Notes\n\nA long paragraph of prose that is clearly not a heading at all.')).toBeNull();
  });

  it('does not treat prose, list items or stat-block labels as headings', () => {
    const text = 'Overview\n\nThis is prose.\n\n- Bullet Item Here\n\nActions\n\nSecond Section\n\nMore prose here.';
    expect(inferPlainTextHeadings(text)).toBe('## Overview\n\nThis is prose.\n\n- Bullet Item Here\n\nActions\n\n## Second Section\n\nMore prose here.');
  });

  it("keeps a feat's category line with its feat (text copied from a web page)", () => {
    const web = 'Lamp Lifter\n\nOrigin Feat\n\nYou gain the following benefits.\n\nWick Dancer\n\nGeneral Feat (Prerequisite: Level 4+, Dexterity 13+)\n\nYou dance.';
    expect(inferPlainTextHeadings(web)).toBe('## Lamp Lifter\n\nOrigin Feat\n\nYou gain the following benefits.\n\n## Wick Dancer\n\nGeneral Feat (Prerequisite: Level 4+, Dexterity 13+)\n\nYou dance.');
    expect(chunkDocument(web, { sourceId: 's', sourceName: 'S' }).map((e) => [e.name, e.kind])).toEqual([['Lamp Lifter', 'feat'], ['Wick Dancer', 'feat']]);
  });

  it("keeps a spell card's lines with their spell (a label and its value after a blank line aren't a heading)", () => {
    const text = 'Glow Mote\n\nCasting Time\tAction\nRange\tTouch\n\nA mote of light settles on a creature.\n\nEmber Lash\n\nCasting Time — 1 action\nRange — 60 feet\n\nA lash of embers strikes.';
    expect(chunkDocument(text, opts).map((e) => [e.name, e.kind])).toEqual([['Glow Mote', 'spell'], ['Ember Lash', 'spell']]);
    // A rules subhead alone on its line still is one.
    expect(inferPlainTextHeadings('Casting Spells\n\nYou cast spells.\n\nCasting Time\n\nMost spells take an action.')).toBe('## Casting Spells\n\nYou cast spells.\n\n## Casting Time\n\nMost spells take an action.');
  });

  it("never takes a pasted card's table rows, or a label over its value, for a heading", () => {
    const text = 'Ember Lash\n\nCasting Time | Range | Duration\n--- | --- | ---\n1 action | 60 feet | Instantaneous\n\nA lash of embers strikes.\n\nGlow Mote\n\nRange\n30 feet\nCasting Time\nBonus Action\n\nA mote of light settles.\n\nMoth Ward\n\nCasting Time\n1 reaction.\nRange\nSelf.\n\nPale moths swirl around you.';
    expect(chunkDocument(text, opts).map((e) => [e.name, e.kind])).toEqual([['Ember Lash', 'spell'], ['Glow Mote', 'spell'], ['Moth Ward', 'spell']]);
    // A table's row with pipes between its cells, with or without a delimiter row under it.
    expect(inferPlainTextHeadings('Wick Spells\n\nThe wick spells.\n\nSpell | Casting Time | Range\nGlow | 1 action | Touch\n\nLamp Spells\n\nThe lamp spells.')).toBe(
      '## Wick Spells\n\nThe wick spells.\n\nSpell | Casting Time | Range\nGlow | 1 action | Touch\n\n## Lamp Spells\n\nThe lamp spells.',
    );
    // Rules subheads over their paragraphs still are headings.
    expect(inferPlainTextHeadings('Casting Spells\n\nYou cast spells.\n\nRange\nThe target of a spell must be within range.\n\nCasting Time\nAction is how most spells are cast.')).toBe(
      '## Casting Spells\n\nYou cast spells.\n\n## Range\nThe target of a spell must be within range.\n\n## Casting Time\nAction is how most spells are cast.',
    );
  });
});

describe('guessKind', () => {
  it('recognizes spells by "Casting Time" or a level-and-school line', () => {
    expect(guessKind('Fireball', FIREBALL)).toBe('spell');
    expect(guessKind('Fire Bolt', '_Evocation Cantrip (Sorcerer, Wizard)_\n\nYou hurl a mote of fire.')).toBe('spell');
    expect(guessKind('Shield', '1st-level abjuration\n\nAn invisible barrier of magical force appears.')).toBe('spell');
    expect(guessKind('Odd Spell', 'Casting Time: 1 reaction\nRange: Self')).toBe('spell');
  });

  it('recognizes monsters by AC, HP and CR', () => {
    expect(guessKind('Goblin Warrior', GOBLIN)).toBe('monster');
    expect(guessKind('Orc', 'Medium humanoid\nArmor Class 13 (hide armor)\nHit Points 15 (2d8 + 6)\nChallenge 1/2 (100 XP)')).toBe('monster');
    expect(guessKind('Guard Post', 'The guards have AC 16 armor and 11 HP each.')).toBe('rule');
  });

  it('recognizes magic items by category and rarity', () => {
    expect(guessKind('Bag of Holding', '_Wondrous Item, Uncommon_\n\nThis bag has an interior space.')).toBe('magic-item');
    expect(guessKind('Sentinel Shield', 'Armor (Shield), uncommon (requires attunement)\n\nWhile holding this shield...')).toBe('magic-item');
    expect(guessKind('Potion of Healing', 'Potion, common\nYou regain 2d4 + 2 Hit Points.')).toBe('magic-item');
  });

  it('recognizes feats by their category line, or by a Prerequisite line before their text', () => {
    expect(guessKind('Alert', '_Origin Feat_\n\nYou gain the following benefits.')).toBe('feat');
    expect(guessKind('Grappler', '_General Feat (Prerequisite: Level 4+, Strength or Dexterity 13+)_\n\nBenefits.')).toBe('feat');
    expect(guessKind('Lucky (Origin Feat)', 'You have inexplicable luck.')).toBe('feat');
    const older = '_Prerequisite: Wisdom 13 or higher_\n\nYou can walk the lamp roads at night without a light.';
    // Wherever the headings put it: PDF, photo and pasted-text imports often lose or flatten the Feats heading.
    expect(guessKind('Night Walker', older)).toBe('feat');
    expect(guessKind('Night Walker', older, ['Lantern Folk', 'Chapter 6: Character Options'])).toBe('feat');
    expect(guessKind('Night Walker', older, ['Feats'])).toBe('feat');
    expect(guessKind('Sharpshooter', 'Prerequisite: Level 4+\nYou can shoot far.')).toBe('feat');
    expect(guessKind('Spell Ward', 'Prerequisite: Spellcasting or Pact Magic feature\n\nYou ward yourself.')).toBe('feat');
    expect(guessKind('Quick Hands', 'Prerequisite: Proficiency with a martial weapon\n\nYou draw in a blink.')).toBe('feat');
    expect(guessKind('Lantern Born', '- *Prerequisite: Lampkin*\n\nYour light never gutters.')).toBe('feat');
    // A level alone, "None", a feat's own labels, a tagline: feats print these too.
    expect(guessKind('Lantern Knight', 'Prerequisite: 4th Level, Lantern Squire Feat\n\nYou lead the watch.')).toBe('feat');
    expect(guessKind('Wick Veteran', 'Prerequisite: 4th level\n\nYou endure.')).toBe('feat');
    expect(guessKind('Wick Veteran', 'Prerequisite: 8th-level character\n\nYou endure.')).toBe('feat');
    expect(guessKind('Wick Veteran', 'Prerequisite: 4th-level Fighter\n\nYou endure.')).toBe('feat');
    expect(guessKind('Quick Feet', 'Prerequisite: Level 4+ and Dexterity 13+\n\nYou dodge.')).toBe('feat');
    expect(guessKind('Quick Feet', 'Prerequisite: Level 4+ You dodge every blow.')).toBe('feat');
    expect(guessKind('Lamp Friend', 'Prerequisite: None\n\nYou befriend lamps.')).toBe('feat');
    expect(guessKind('Quick Wick', 'Prerequisite: Dexterity 13\n\nQuick Draw: You can light a wick as a free action.')).toBe('feat');
    expect(guessKind('Quick Wick', 'Prerequisite: Dexterity 13 Benefit: You light wicks fast.')).toBe('feat');
    expect(guessKind('Quick Wick', 'Prerequisite: Dexterity 13\n\nYou gain two benefits: light and warmth.')).toBe('feat');
    expect(guessKind('Quick Wick', 'Prerequisite: Dexterity 13\n\nAbility Score Improvement: +1 Dexterity')).toBe('feat');
    expect(guessKind('Night Walker', '*Some walk where light fails.*\n\nPrerequisite: Wisdom 13 or higher\n\nYou walk at night.')).toBe('feat');
    expect(guessKind('Night Walker', 'Night Walker\n\nPrerequisite: Wisdom 13 or higher\n\nYou walk at night.')).toBe('feat');
    expect(guessKind('Spark Adept', 'Prerequisite: The ability to cast at least one cantrip\n\nYou spark.')).toBe('feat');
  });

  it('reads only the prerequisite itself: never a web copy\'s "Source:" line, a page header, a tag line, or the text a PDF joined to it', () => {
    const feat = (text: string) => [guessKind('Lamp Grip', text), misreadBefore('feat', 'Lamp Grip', text, [])];
    expect(feat('Source: Lantern Folk Handbook\nPrerequisite: Strength 13 or higher\nYou grip lamps.')).toEqual(['feat', false]);
    expect(feat('Prerequisite: Strength 13 or higher\nSource: Lantern Folk Handbook\nYou grip lamps.')).toEqual(['feat', false]);
    expect(feat('Prerequisite: Strength 13 or higher Source: Lantern Folk Handbook\n\nYou grip lamps.')).toEqual(['feat', false]);
    expect(feat('CHAPTER 6 | CHARACTER OPTIONS\nPrerequisite: Strength 13 or higher\nYou grip lamps.')).toEqual(['feat', false]);
    expect(feat('Combat\nPrerequisite: Strength 13 or higher\nYou grip lamps.')).toEqual(['feat', false]);
    expect(feat('*Hold fast*\n\nPrerequisite: Strength 13 or higher\n\nYou grip lamps.')).toEqual(['feat', false]);
    // A PDF joined the feat's first sentence to its Prerequisite line: "patron", "cantrip" and "Word:" there are the feat's.
    expect(feat('Prerequisite: Elf (moth elf) or half-elf You learn the old magic of the moth groves, and one druid cantrip\nof your choice.')).toEqual(['feat', false]);
    expect(feat('Prerequisite: Wisdom 13 or higher, and the ability to see in dim light. Your patron spirit whispers.')).toEqual(['feat', false]);
    expect(feat('Prerequisite: Proficiency with a martial weapon You guard the flame. Lantern Feint: when you hit, you glow.')).toEqual(['feat', false]);
    // The signs still read what they are meant to.
    expect(guessKind('Bright Ember', 'Source: Lantern Lore\nPrerequisite: Level 5+ Wickwright\nYour flame.')).toBe('rule');
    expect(guessKind('Hall', '_5th-level Stronghold Room (Basic)_\n\n_Prerequisite: None_\n\nA hall.')).toBe('rule');
    expect(guessKind('Gallery', 'Prerequisite: None\nSource: Holdings Book\nRoom: Snug\n\nText.')).toBe('rule');
    // A prerequisite that opens with "The" or "A" keeps its signs.
    expect(guessKind('Moth Sight', 'Prerequisite: The Moth Queen patron\n\nYou see.')).toBe('rule');
    expect(guessKind('Searing Volley', 'Prerequisite: The ember dart cantrip\n\nYou sear.')).toBe('rule');
    expect(guessKind('Gallery', "Prerequisite: A lantern-maker's tools Room: Snug Keepers: 1\n\nText.")).toBe('rule');
    expect(guessKind('Spark Adept', 'Prerequisite: The ability to cast at least one spell\n\nYou cast.')).toBe('feat');
    // Type lines with a non-breaking space or a qualifier, and a class option's type line.
    expect(guessKind('Hall', 'Level\u00a05 Stronghold\u00a0Room\nPrerequisite: None\n\nText.')).toBe('rule');
    expect(guessKind('Hall', 'Level 5 Stronghold Room — Basic\nPrerequisite: None\n\nText.')).toBe('rule');
    expect(guessKind('Hall', 'Level 5 Stronghold Room, Basic\nPrerequisite: None\n\nText.')).toBe('rule');
    expect(guessKind('Moth Sight', 'Eldritch Invocation\nPrerequisite: 5th level\n\nText.')).toBe('rule');
    expect(guessKind('Lantern Boots', 'Wickwright Infusion\nPrerequisite: 6th-level wickwright\n\nText.')).toBe('rule');
    expect(chunkDocument('Lamp Grip\n\nSource: Lantern Folk Handbook\n\nPrerequisite: Strength 13 or higher\n\nYou grip lamps.\n\nMoth Sight\n\nSource: Lantern Folk Handbook\n\nPrerequisite: Wisdom 13 or higher\n\nYou see moths.', { sourceId: 's', sourceName: 'S' }).map((e) => e.kind)).toEqual(['feat', 'feat']);
  });

  it('finds a spell card as a web page or table prints it, without the label colons (not an index or a rules section)', () => {
    const spell = (text: string) => [guessKind('Ember Lash', text), misreadBefore('spell', 'Ember Lash', text, [])];
    expect(spell('Level\n3rd\nCasting Time\n1 Action\nRange/Area\n60 ft.\nComponents\nV, S\nDuration\nInstantaneous\n\nA lash of embers strikes.')).toEqual(['spell', false]);
    expect(spell('| Casting Time | Range | Components | Duration |\n|---|---|---|---|\n| 1 action | 60 feet | V, S | Instantaneous |\n\nA lash.')).toEqual(['spell', false]);
    expect(spell('Casting Time    1 action\nRange    60 feet\n\nA lash.')).toEqual(['spell', false]);
    expect(spell('Casting Time — 1 action\nRange — 60 feet\n\nA lash.')).toEqual(['spell', false]);
    expect(guessKind('Index', 'casting time, 215\ncomponents, 216\nduration, 217\nrange, 220')).toBe('rule');
    // A creature or a feat that prints a table of its spells stays what it is (and isn't taken for a misreading).
    const table = '| Spell | Casting Time | Range |\n|---|---|---|\n| Glow | 1 action | Touch |\n| Spark | 1 action | 60 feet |';
    const mage = `Medium Humanoid, Neutral\n\nAC 14\nHP 33 (6d8 + 6)\nCR 2 (XP 450; PB +2)\n\n${table}`;
    const adept = `Prerequisite: Intelligence 13 or higher\n\n${table}\n\nYou learn moth magic.`;
    expect([guessKind('Moth Mage', mage), misreadBefore('monster', 'Moth Mage', mage, [])]).toEqual(['monster', false]);
    expect([guessKind('Moth Adept', adept, ['Mothfolk Feats']), misreadBefore('feat', 'Moth Adept', adept, ['Mothfolk Feats'])]).toEqual(['feat', false]);
    // A spell list, or a list of what the labels mean, isn't one spell.
    expect(guessKind('Wick Spells', '| Spell | Casting Time | Range | Duration |\n|---|---|---|---|\n| Glow | 1 action | Touch | 1 hour |\n| Spark | 1 action | 60 feet | Instant |')).toBe('rule');
    expect(guessKind('Spell Fields', '- Casting Time — the action it takes to cast.\n- Range — how far it reaches.\n- Duration — how long it lasts.')).toBe('rule');
    expect(guessKind('Casting a Spell', 'Casting Time\n\nMost spells require a single action to cast, but some take longer.\n\nRange\n\nThe target of a spell must be within range.')).toBe('rule');
  });

  it('finds a card printed as a table: labels over a row of values, or two columns of labels and values, perhaps after a caption or Source line', () => {
    const spell = (text: string) => [guessKind('Ember Lash', text), misreadBefore('spell', 'Ember Lash', text, [])];
    const lash = '\n\nA lash of embers strikes one creature you can see within range.';
    // Two columns, under an empty header or one of its own rows, perhaps with rows of the card's other labels.
    expect(spell(`| | |\n|---|---|\n| Casting Time | 1 action |\n| Range | 60 feet |\n| Components | V, S |${lash}`)).toEqual(['spell', false]);
    expect(spell(`| Casting Time | 1 reaction |\n|---|---|\n| Range | Self |\n| Duration | 1 round |${lash}`)).toEqual(['spell', false]);
    expect(spell(`| Level | 1st |\n|:--|:--|\n| School | Evocation |\n| **Casting Time** | 1 action |\n| **Range** | 60 ft. |${lash}`)).toEqual(['spell', false]);
    // After a Source line or a caption.
    expect(spell(`*Source: Lantern Lore, p. 12*\n\n| Casting Time | Range | Components | Duration |\n|---|---|---|---|\n| Bonus Action | 30 feet | V | 1 minute |${lash}`)).toEqual(['spell', false]);
    expect(spell(`Ember-bound spell\n| | |\n|---|---|\n| Casting Time | 1 action |\n| Range | 60 feet |${lash}`)).toEqual(['spell', false]);
    // GFM without the outer pipes, a table pasted as text (tabs between its cells), a web page's grid.
    expect(spell(`Casting Time | Range | Components | Duration\n--- | --- | --- | ---\n1 action | 60 feet | V, S | Instantaneous${lash}`)).toEqual(['spell', false]);
    expect(spell(`Casting Time\tRange\tDuration\n1 action\t60 feet\tInstantaneous${lash}`)).toEqual(['spell', false]);
    expect(guessKind('Ember Lash', `| Level | Casting Time | Range/Area | Components |\n|---|---|---|---|\n| 1st | 1 Action | 60 ft. | V, S |\n| Duration | School | Attack/Save | Damage/Effect |\n| Instantaneous | Evocation | Ranged | Fire |${lash}`)).toBe('spell');
    // Not a list of spells (with or without its pipes, or pasted), what the labels mean, prices, or a feat's table after its Prerequisite.
    expect(guessKind('Wick Spells', 'Spell | Casting Time | Range\n--- | --- | ---\nGlow | 1 action | Touch\nSpark | 1 action | 60 feet')).toBe('rule');
    expect(guessKind('Wick Spells', 'Casting Time | Range | Duration\n--- | --- | ---\n1 action | Touch | 1 hour\n1 action | 60 feet | Instantaneous')).toBe('rule');
    expect(guessKind('Wick Spells', 'Casting Time\tSpell\tRange\n1 action\tGlow\tTouch\n1 action\tSpark\t60 feet')).toBe('rule');
    expect(guessKind('Spell Terms', '| Casting Time | The action it takes to cast. |\n|---|---|\n| Range | How far the spell reaches. |')).toBe('rule');
    expect(guessKind('Spell Terms', '| Term | Meaning |\n|---|---|\n| Casting Time | The action it takes to cast a spell. |\n| Range | How far away the spell reaches. |')).toBe('rule');
    expect(guessKind('Lamp Prices', '| Item | Cost |\n|---|---|\n| Lamp | 5 sp |\n| Oil | 1 sp |')).toBe('rule');
    expect(guessKind('Moth Adept', 'Prerequisite: Intelligence 13 or higher\n\n| Spell | Casting Time | Range |\n|---|---|---|\n| Glow | 1 action | Touch |\n\nYou learn moth magic.')).toBe('feat');
  });

  it("reads a casting time however long its trigger (SRD 5.2.1 Shield's), in each shape of card", () => {
    const shield = 'Reaction, which you take when you are hit by an attack roll or targeted by the Magic Missile spell';
    const spell = (text: string) => [guessKind('Shield', text), misreadBefore('spell', 'Shield', text, [])];
    const barrier = '\n\nAn imperceptible barrier of magical force protects you.';
    expect(spell(`Casting Time\n${shield}\nRange\nSelf${barrier}`)).toEqual(['spell', false]);
    expect(spell(`Casting Time\t${shield}\nRange\tSelf${barrier}`)).toEqual(['spell', false]);
    expect(spell(`Casting Time — ${shield}.\nRange — Self${barrier}`)).toEqual(['spell', false]);
    expect(spell(`| Casting Time | ${shield} |\n|---|---|\n| Range | Self |${barrier}`)).toEqual(['spell', false]);
    expect(spell(`- **Casting Time** ${shield}\n- **Range** Self${barrier}`)).toEqual(['spell', false]);
    expect(spell(`Casting Time\tAction (Overgrowth) or 8 hours (Enrichment)\nRange\t150 feet${barrier}`)).toEqual(['spell', false]);
    // Only Casting Time's value may run on, and only when it starts with a casting time.
    expect(guessKind('Spell Fields', `Casting Time — ${shield}.\nRange — The distance from you at which the spell can take effect.`)).toBe('rule');
    expect(guessKind('Spell Fields', 'Casting Time — The time it takes to cast a spell, from an action to hours.\nRange — Self')).toBe('rule');
  });

  it('finds a card with one space between each label and its value: bold labels without colons, a PDF that printed them side by side', () => {
    const spell = (text: string) => [guessKind('Glow Mote', text), misreadBefore('spell', 'Glow Mote', text, [])];
    const mote = '\n\nA mote of light settles on a creature you can see.';
    expect(spell(`- **Casting Time** 1 action\n- **Range** 60 feet\n- **Components** V, S\n- **Duration** Instantaneous${mote}`)).toEqual(['spell', false]);
    expect(spell(`**Casting Time** Bonus Action\n**Duration** 1 minute${mote}`)).toEqual(['spell', false]);
    expect(spell(`Casting Time Bonus Action Range 30 feet\n\nComponents V\n\nDuration 1 minute${mote}`)).toEqual(['spell', false]);
    expect(spell(`Casting Time 1 minute or Ritual Range 30 feet Components V, S Duration 8 hours${mote}`)).toEqual(['spell', false]);
    // Not a rules subhead, an index line, prose after the label, or a casting time with no other label.
    expect(guessKind('Index', 'Casting Time, 202\nComponents, 203\nDuration, 203\nRange, 204')).toBe('rule');
    expect(guessKind('Spell Terms', 'Casting Time The time it takes to cast the spell.\nRange The distance the spell reaches.\nDuration How long it lasts.')).toBe('rule');
    expect(guessKind('Spell Terms', 'Casting Time 1 minute or more is rare.\nDuration tells how long a spell lasts.')).toBe('rule');
    expect(guessKind('Spell Terms', 'Casting Time Action is how most spells are cast. Range and Duration follow.')).toBe('rule');
    expect(guessKind('Casting Notes', 'Casting Time 1 action\n\nWhen you cast it, nothing else happens.')).toBe('rule');
  });

  it('reads a summoning spell as a spell before the stat block it prints', () => {
    const hound = '**Casting Time** 1 Action\n**Range** 30 feet\n\nYou summon a lantern hound in an unoccupied space you can see.\n\n**Lantern Hound**\n\n*Medium Celestial, Neutral*\n\n**AC** 10 + 1 per spell level\n\n**HP** 5 + 10 per spell level\n\n| STR | DEX | CON | INT | WIS | CHA |\n|---|---|---|---|---|---|\n| 14 (+2) | 12 (+1) | 12 (+1) | 6 (−2) | 12 (+1) | 8 (−1) |';
    expect([guessKind('Summon Lantern Hound', hound), misreadBefore('spell', 'Summon Lantern Hound', hound, [])]).toEqual(['spell', false]);
    const [entry] = chunkDocument(`## Summon Lantern Hound\n\n${hound}`, opts);
    expect(entry.kind).toBe('spell');
  });

  it("keeps a spell an earlier import stored whose card today's rules can't read whole, and still knows its misreadings", () => {
    // An import whose heading guesses left the entry only its Casting Time line; a card's table after a name and a Source line.
    expect(misreadBefore('spell', 'Lamp Wake', 'Casting Time    8 hours', [])).toBe(false);
    expect(misreadBefore('spell', 'Ember Lash', '| Casting Time | 1 action |\n\nA lash of embers.', [])).toBe(false);
    expect(misreadBefore('spell', 'Ember Lash', 'Ember Lash\nSource: Lantern Lore\n| Casting Time | Range |\n|---|---|\n| 1 action | 60 feet |\n\nA lash.', [])).toBe(false);
    // The label alone, then its casting time on the first line with text below it: a PDF prints each of a card's
    // lines as a paragraph. A rules subhead whose paragraph is a casting time is kept the same way.
    expect(misreadBefore('spell', 'Lamp Wake', 'Casting Time\n\n8 hours\n\nThe lamps wake.', [])).toBe(false);
    expect(misreadBefore('spell', 'Casting a Spell', 'Casting Time\n\nBonus Action\n\nA spell cast with a Bonus Action is swift.', [])).toBe(false);
    // Still misreadings: an index, rules subheads, a list of spells, an item that prints a casting time.
    expect(misreadBefore('spell', 'Index', 'casting time, 215\ncomponents, 216', [])).toBe(true);
    expect(misreadBefore('spell', 'Casting a Spell', 'Casting Time\n\nMost spells require a single action to cast, but some take longer.', [])).toBe(true);
    expect(misreadBefore('spell', 'Wick Spells', '| Casting Time | Spell | Range |\n|---|---|---|\n| 1 action | Glow | Touch |\n| 1 action | Spark | 60 feet |', [])).toBe(true);
    expect(misreadBefore('spell', 'Glimmer Wand', '_Wand, Rare_\n\nCasting Time    1 action\nRange    60 feet\n\nThe wand casts a lash.', [])).toBe(true);
  });

  it('reads a card as converters write it: hard line breaks, <br>, no-break spaces, bullets, full stops and ritual tags', () => {
    const spell = (text: string) => [guessKind('Glow Mote', text), misreadBefore('spell', 'Glow Mote', text, [])];
    const mote = '\n\nA mote of light settles on a creature you can see.';
    const nb = String.fromCharCode(160);
    // pandoc's Markdown: a backslash ends each soft-returned line, two no-break spaces follow a bold label.
    expect(spell(`**Casting Time** Bonus Action\\\n**Range** 30 feet\\\n**Duration** 1 minute${mote}`)).toEqual(['spell', false]);
    expect(spell(`**Casting Time**${nb}${nb}1 reaction\n\n**Range**${nb}${nb}Self${mote}`)).toEqual(['spell', false]);
    expect(spell(`**Casting Time**\\ 1 action\\\n**Range**\\ 60 feet${mote}`)).toEqual(['spell', false]);
    // An HTML line break at the end of each line, or between the fields of one line.
    expect(spell(`**Casting Time** 1 action<br>\n**Range** 60 feet<br>\n**Duration** Instantaneous${mote}`)).toEqual(['spell', false]);
    expect(spell(`**Casting Time** 1 action<br>**Range** 60 feet<br>**Duration** Instantaneous${mote}`)).toEqual(['spell', false]);
    // Bullets other than "-", dashes among them.
    for (const bullet of ['•', '·', '▪', '–', '—']) expect(spell(`${bullet} Casting Time 1 action\n${bullet} Range 60 feet${mote}`)).toEqual(['spell', false]);
    // A full stop after each value, a ritual tag without "or", "Magic action".
    expect(spell(`**Casting Time** 1 action.\n**Range** 60 feet.${mote}`)).toEqual(['spell', false]);
    expect(spell(`Casting Time    1 action.\nRange    60 feet.\nDuration    Instantaneous.${mote}`)).toEqual(['spell', false]);
    expect(spell(`Casting Time\n1 action.\nRange\n60 feet.${mote}`)).toEqual(['spell', false]);
    expect(spell(`- **Casting Time** 1 minute ritual\n- **Range** 30 feet${mote}`)).toEqual(['spell', false]);
    expect(spell(`- **Casting Time** 10 minutes (ritual)\n- **Range** Touch${mote}`)).toEqual(['spell', false]);
    expect(spell(`Casting Time Magic action\nRange 60 feet${mote}`)).toEqual(['spell', false]);
    // A dash with no spaces around it, two hyphens.
    expect(spell(`Casting Time—1 action\nRange—60 feet${mote}`)).toEqual(['spell', false]);
    expect(spell(`Casting Time -- 1 action\nRange -- 60 feet${mote}`)).toEqual(['spell', false]);
    // A web page's grid copied as text: its labels, then their values.
    expect(spell(`Casting Time\nRange\nComponents\nDuration\n1 action\n60 feet\nV, S\nInstantaneous${mote}`)).toEqual(['spell', false]);
    expect(spell(`Level\nCasting Time\nRange/Area\nComponents\n1st\n1 Action\n60 ft.\nV, S${mote}`)).toEqual(['spell', false]);
    // A full stop ends a value only where the card's casting time ends with one; a contents page has no casting time.
    expect(guessKind('Spell Basics', 'Casting Time\nAction is how most spells are cast.\nDuration\nIt varies.')).toBe('rule');
    expect(guessKind('Contents', 'Casting Time\nRange\nComponents\nDuration\n202\n204\n205\n206')).toBe('rule');
  });

  it('reads a card in a callout or a quoted list, after any run of quote marks and bullet glyphs, and with no-break-space entities', () => {
    const spell = (text: string) => [guessKind('Glow Mote', text), misreadBefore('spell', 'Glow Mote', text, [])];
    const mote = '\n\nA mote of light settles on a creature you can see.';
    const card = (marks: string) => `${marks}Casting Time 1 action\n${marks}Range 60 feet\n${marks}Duration Instantaneous${mote}`;
    // An Obsidian callout of bold labels, quoted lists, nested quotes.
    expect(spell(`> [!spell] Evocation\n> - **Casting Time** Bonus Action\n> - **Range** 30 feet\n> - **Duration** 1 minute${mote}`)).toEqual(['spell', false]);
    for (const marks of ['> - ', '> + ', '>- ', '> > ']) expect([marks, ...spell(card(marks))]).toEqual([marks, 'spell', false]);
    // A word processor's or a symbol font's bullet glyphs, "•" with no space after it, and a PDF's bulleted lines
    // joined in pairs.
    for (const marks of ['● ', `${String.fromCharCode(0xf0b7)} `, '■ ', '◆ ', '► ', '•']) expect([marks, ...spell(card(marks))]).toEqual([marks, 'spell', false]);
    expect(spell(`● Casting Time Action ● Range 90 feet\n\n● Components V, S ● Duration Instantaneous${mote}`)).toEqual(['spell', false]);
    // A no-break space written as its HTML entity.
    for (const nb of ['&nbsp;', '&#160;', '&#xa0;']) expect([nb, ...spell(`**Casting Time**${nb}1 action\n**Range**${nb}60 feet${mote}`)]).toEqual([nb, 'spell', false]);
  });

  it("reads a grid card, a row of its labels over a row of their values, as a PDF prints a card's boxes", () => {
    const spell = (text: string) => [guessKind('Moth Ward', text), misreadBefore('spell', 'Moth Ward', text, [])];
    const ward = '\n\nPale moths swirl around you.';
    expect(spell(`Casting Time Range Components Duration\n1 Action Self V, S 1 round${ward}`)).toEqual(['spell', false]);
    expect(spell(`CASTING TIME RANGE\nReaction, which you take when you are hit Self\nCOMPONENTS DURATION\nV, S 1 round${ward}`)).toEqual(['spell', false]);
    // The app's PDF import makes each of its rows a paragraph; a reader's copy puts the name straight above it.
    expect(spell(`Casting Time Range\n\nBonus Action Self\n\nComponents Duration\n\nV, S 1 round${ward}`)).toEqual(['spell', false]);
    expect(chunkDocument(`Moth Ward\nCASTING TIME RANGE\n1 Action Self\nCOMPONENTS DURATION\nV, S 1 round${ward}\n\nGlow Mote\nCASTING TIME RANGE\nBonus Action 30 feet\nCOMPONENTS DURATION\nV 1 minute\n\nA mote of light.`, opts).map((e) => [e.name, e.kind])).toEqual([['Moth Ward', 'spell'], ['Glow Mote', 'spell']]);
    // Not a contents page's labels over page numbers, nor what each field can be.
    expect(guessKind('Contents', 'Casting Time Range Components Duration\n202 204 205 206')).toBe('rule');
    expect(guessKind('Spell Fields', 'CASTING TIME RANGE\nAction, Bonus Action or Reaction Self or a distance')).toBe('rule');
  });

  it("doesn't take the casting times spells can have, as a glossary of a card's fields lists them, for one spell's", () => {
    expect(guessKind('Reading a Spell', 'Casting Time    Action, Bonus Action, Reaction, or longer\nRange    Self, Touch, or a distance\nDuration    Instantaneous or longer')).toBe('rule');
    expect(guessKind('Reading a Spell', 'Casting Time\nAction or longer\nRange\nSelf, Touch, or a distance')).toBe('rule');
    expect(guessKind('Reading a Spell', '**Casting Time** 1 minute or more\n**Range** Self or a distance')).toBe('rule');
    expect(guessKind('Reading a Spell', '| | |\n|---|---|\n| Casting Time | Action, Bonus Action, Reaction or longer |\n| Range | Self, Touch or a distance |')).toBe('rule');
    expect(guessKind('Reading a Spell', 'Each spell opens with a short block:\n\n| Casting Time | Range | Duration |\n|---|---|---|\n| Action or longer | Self, Touch or a distance | Instantaneous or longer |')).toBe('rule');
    // One spell's, however it goes on: SRD 5.2.1 Plant Growth's two casting times, a ritual, a trigger.
    expect(guessKind('Plant Growth', 'Casting Time    Action (Overgrowth) or 8 hours (Enrichment)\nRange    150 feet')).toBe('spell');
    expect(guessKind('Glow Mote', '- **Casting Time** 1 minute or Ritual\n- **Range** 30 feet')).toBe('spell');
    expect(guessKind('Glow Mote', 'Casting Time\nAction or 8 hours\nRange\nTouch')).toBe('spell');
    expect(guessKind('Moth Ward', 'Casting Time    Reaction, which you take when you take 10 or more damage\nRange    Self')).toBe('spell');
  });

  it('takes two casting times with a comma between them, or "or longer", anywhere in the value\'s own words for a list of them', () => {
    const fields = (marks: (label: string) => string, castingTime: string) =>
      `${marks('Casting Time')}${castingTime}\n${marks('Range')}Self, Touch, or a distance in feet\n${marks('Components')}V, S, M\n${marks('Duration')}Instantaneous, or a length of time\n\nEach spell's description begins with this block.`;
    const shapes: ((v: string) => string)[] = [
      (v) => fields((l) => `- **${l}** `, v),
      (v) => fields((l) => `**${l}** `, v),
      (v) => `> [!info] Reading a spell\n${fields((l) => `> - **${l}** `, v)}`,
      (v) => fields((l) => `● ${l} `, v),
      (v) => fields((l) => `${l}\t`, v),
      (v) => `Casting Time\n${v}\nRange\nSelf, Touch, or a distance in feet\nDuration\nInstantaneous, or a length of time`,
      (v) => `CASTING TIME RANGE\n${v} Self, Touch, or a distance\nCOMPONENTS DURATION\nV, S, M Instantaneous, or a length of time`,
      (v) => `Each spell opens with a short block:\n\n| Casting Time | Range | Duration |\n|---|---|---|\n| ${v} | Self, Touch, or a distance | Instantaneous, or a length of time |`,
      (v) => `| | |\n|---|---|\n| Casting Time | ${v} |\n| Range | Self, Touch, or a distance |\n| Duration | Instantaneous, or a length of time |`,
      (v) => `Casting Time\tRange\tDuration\n${v}\tSelf, Touch, or a distance\tInstantaneous, or a length of time`,
    ];
    for (const value of [
      'Action (most spells), Bonus Action, Reaction, or longer',
      '1 action (most spells), 1 bonus action, 1 reaction, or longer',
      'Action for most spells; some take a Bonus Action, a Reaction, or longer',
    ]) {
      for (const [i, make] of shapes.entries()) expect([value, i, guessKind('Reading a Spell', make(value))]).toEqual([value, i, 'rule']);
    }
    // One spell's casting time, however it goes on: "or more" counts only right after the casting times, a trigger is the spell's own.
    for (const value of [
      'Reaction, which you take when you take 10 or more damage',
      '1 reaction, which you take when you take acid, cold, fire, lightning, or thunder damage',
      'Bonus Action, which you take immediately after hitting a target with a Melee weapon or an Unarmed Strike',
      'Action (Overgrowth) or 8 hours (Enrichment)',
      '1 minute or Ritual',
      'Action or 8 hours',
      '1 action, or 1 minute as a ritual',
    ]) {
      for (const [i, make] of shapes.slice(0, 7).entries()) expect([value, i, guessKind('Moth Ward', make(value).replace("Each spell's description begins with this block.", 'Pale moths swirl.'))]).toEqual([value, i, 'spell']);
    }
  });

  it('reads a card whose label and value any space a converter writes sets apart (no-break, em, en, thin, hair, figure…, or its HTML reference), or pandoc\'s em dash', () => {
    const spell = (text: string) => [guessKind('Glow Mote', text), misreadBefore('spell', 'Glow Mote', text, [])];
    const mote = '\n\nA mote of light settles on a creature you can see.';
    const card = (gap: string) => `**Casting Time**${gap}1 action\n**Range**${gap}60 feet\n**Duration**${gap}Instantaneous${mote}`;
    const chars = [0x2002, 0x2003, 0x2007, 0x2009, 0x200a, 0x202f].map((c) => String.fromCharCode(c));
    for (const gap of ['&emsp;', '&ensp;', '&thinsp;', '&hairsp;', '&#8194;', '&#8199;', '&#8202;', '&#x2009;', '&#x200A;', '&#8239;', '&#x202f;', ...chars]) {
      expect([JSON.stringify(gap), ...spell(card(gap))]).toEqual([JSON.stringify(gap), 'spell', false]);
    }
    // A zero-width space (or its reference) shows nothing: dropped.
    for (const gap of ['&#8203; ', '&#x200b; ', `${String.fromCharCode(0x200b)} `]) expect([JSON.stringify(gap), ...spell(card(gap))]).toEqual([JSON.stringify(gap), 'spell', false]);
    // pandoc writes Word's em dash as "---".
    expect(spell(`**Casting Time** --- 1 action\n\n**Range** --- 60 feet\n\n**Duration** --- Instantaneous${mote}`)).toEqual(['spell', false]);
    expect(guessKind('Spell Fields', '**Casting Time** --- How long it takes to cast the spell.\n\n**Range** --- How far it reaches.')).toBe('rule');
  });

  it("reads a card printed as one of pandoc's own tables (simple or multiline) as a Markdown table's, and not a list of spells", () => {
    const spell = (text: string, name = 'Ember Lash') => [guessKind(name, text), misreadBefore('spell', name, text, [])];
    const lash = '\n\nA lash of embers strikes one creature you can see within range.';
    // A simple table: the header line (the entry's first, its indent trimmed), a rule of column dashes, a row.
    expect(spell(`Casting Time   Range     Components   Duration\n  -------------- --------- ------------ ---------------\n  1 action       60 feet   V, S         Instantaneous${lash}`)).toEqual(['spell', false]);
    // A multiline table: rules across above and below, a wrapped cell, a School column, the level line at its foot.
    const multiline = (header: string, rule: string, rows: string) => `-----------------------------------------------------------------\n${header}\n${rule}\n${rows}\n\n  -----------------------------------------------------------------${lash}\n\n*Level 1 Evocation (Wizard)*`;
    expect(spell(multiline('  Casting Time   Range     Components     Duration        School', '  -------------- --------- -------------- --------------- ----------', '  1 action       60 feet   V, S, M (a     Instantaneous   Evocation\n                           pinch of\n                           soot)'))).toEqual(['spell', false]);
    // A 2x2 grid: each row of labels over its row of values; a merged title row over the labels.
    expect(spell(multiline('  Casting Time                        Range', '  ----------------------------------- -----------------------------', '  1 action                            60 feet\n\n  Components                          Duration\n\n  V, S                                Instantaneous'))).toEqual(['spell', false]);
    expect(spell(multiline('  Ember Lash', '  -------------- --------- -------------- ---------------', '  Casting Time   Range     Components     Duration\n\n  1 action       60 feet   V, S           Instantaneous'))).toEqual(['spell', false]);
    // Not one spell's card: two rows of values, a column of other spells' names, what the labels mean, page numbers.
    const simple = (header: string, rule: string, rows: string[]) => `Each wick spell:\n\n  ${header}\n  ${rule}\n${rows.map((r) => `  ${r}`).join('\n')}\n\nThe list goes on.`;
    expect(guessKind('Wick Spells', simple('Casting Time   Range     Duration', '-------------- --------- ---------------', ['1 action       Touch     1 hour', '1 action       60 feet   Instantaneous']))).toBe('rule');
    expect(guessKind('Wick Spells', `-----------------------------------------------\n  Casting Time   Range     Duration\n  -------------- --------- ---------------\n  1 action       Touch     1 hour\n\n  1 action       60 feet   Instantaneous\n  -----------------------------------------------`)).toBe('rule');
    expect(guessKind('Wick Spells', simple('Spell        Casting Time   Range', '------------ -------------- ---------', ['Glow Mote    1 action       Touch']))).toBe('rule');
    expect(guessKind('Spell Terms', simple('Casting Time   What it tells you', '-------------- ----------------------------', ['Range          How far the spell reaches']))).toBe('rule');
    expect(guessKind('Index', simple('Casting Time   Range', '-------------- ---------', ['202            204']))).toBe('rule');
  });

  it("keeps a spell the first release stored whose card pandoc printed with a rule, a border, a fence or a span between its labels and values, or with more of the card's fields on its label row", () => {
    const kept = (text: string, name = 'Ember Lash') => !misreadBefore('spell', name, text, []);
    const lash = '\n\nA lash of embers strikes.';
    for (const card of [
      // pandoc's grid table: a border of "=" under the label row, "+---+" around it.
      '+--------------+---------+------------+\n| Casting Time | Range   | Duration   |\n+==============+=========+============+\n| 1 action     | 60 feet | Instantaneous |\n+--------------+---------+------------+',
      // A web page's label spans ("[Casting Time]{.label} [1 action]{.value}") and its label div over its value div.
      '-   [Casting Time]{.label} [1 action]{.value}\n-   [Range]{.label} [60 feet]{.value}',
      '::: grid\n::: labels\nCasting Time Range Components Duration\n:::\n\n::: values\n1 action 60 feet V, S Instantaneous\n:::\n:::',
      // An Org table's rule, an empty spacer row, a thematic break between the labels and their values.
      '| Casting Time | Range |\n|--------------+---------|\n| 1 action | 60 feet |',
      '| Casting Time | Range |\n|---|---|\n| | |\n| 1 action | 60 feet |',
      'Casting Time Range Components Duration\n\n---\n\n1 action 60 feet V, S Instantaneous',
      // More of the card's fields on its label row: a title row over it, a wrapped value row, a reader's copy of a grid.
      '| Ember Lash | | | | |\n| :---- | :---- | :---- | :---- | :---- |\n| Casting Time | Range | Components | Duration | School |\n| 1 action | 60 feet | V, S | Instantaneous | Evocation |',
      '| Ember Lash | | | | |\n|---|---|---|---|---|\n| Casting Time | Range | Components | Duration | Level |\n| 1 action | 60 feet | V, S | Instantaneous | 1st |',
      '| Ember Lash | | | | | |\n|---|---|---|---|---|---|\n| Casting Time | Range | Components | Duration | Concentration | Ritual |\n| 1 action | 60 feet | V, S | Instantaneous | No | No |',
      '| Casting Time | Range | Components | Duration | School |\n|---|---|---|---|---|\n| 1 action | 60 feet | V, S, M | Instantaneous | Evocation |\n| | | (a pinch of soot) | | |',
      'CASTING TIME RANGE SCHOOL\n1 action 60 feet Evocation\nCOMPONENTS DURATION\nV, S Instantaneous',
      'CASTING TIME RANGE / AREA\n1 action 60 feet\nCOMPONENTS DURATION\nV, S Instantaneous',
      'CASTING TIME RANGE SCHOOL 1 action 60 feet Evocation COMPONENTS DURATION V, S Instantaneous',
    ]) {
      expect([card, guessKind('Ember Lash', `${card}${lash}`), kept(`${card}${lash}`)]).toEqual([card, 'rule', true]);
    }
    // Still corrected: a column of other spells' names on the label row, labels over page numbers.
    expect(kept('| Casting Time | Spell | Range |\n|---|---|---|\n| 1 action | Glow | Touch |\n| 1 action | Spark | 60 feet |', 'Wick Spells')).toBe(false);
    expect(kept('+--------------+-------+\n| Casting Time | Range |\n+==============+=======+\n| 202          | 204   |\n+--------------+-------+', 'Index')).toBe(false);
    expect(kept('::: labels\nCasting Time Range\n:::\n\n::: values\n202 204\n:::', 'Contents')).toBe(false);
  });

  it('keeps a spell the first release stored whose value a tag, a space reference or a zero-width one stands before, or whose value stands above its label or ended up in a heading', () => {
    const kept = (text: string, name = 'Ember Lash') => !misreadBefore('spell', name, text, []);
    const lash = '\n\nA lash of embers strikes.';
    for (const card of [
      // A short tag in parentheses between the label and its value.
      '**Casting Time** (R) 1 minute\n**Range** 60 feet', '**Casting Time** (ritual) 1 minute\n**Range** 60 feet', '**Casting Time** (C) 1 action\n**Range** 60 feet',
      '| Casting Time (R) | Range |\n|---|---|\n| 1 minute | 60 feet |',
      // A zero-width space (its reference or the character) with no space after it: the label never runs into its value.
      '**Casting Time**&#8203;1 action\n**Range**&#8203;60 feet', `**Casting Time**${String.fromCharCode(0x200b)}1 action\n**Range**${String.fromCharCode(0x200b)}60 feet`,
      // The value printed on the line above its label, a grid's row of values over its row of labels.
      '1 action\nCasting Time\n60 feet\nRange', '1 action\n\nCasting Time\n\n60 feet\n\nRange', '1 ACTION 60 FEET\nCASTING TIME RANGE\nV, S INSTANTANEOUS\nCOMPONENTS DURATION',
    ]) {
      expect([card, guessKind('Ember Lash', `${card}${lash}`), kept(`${card}${lash}`)]).toEqual([card, 'rule', true]);
    }
    // Pasted text's heading guesses made the value the entry's name, the label opening its text.
    expect(kept('Casting Time\n60 feet\nRange\nV, S\nComponents', 'Action')).toBe(true);
    // The label row ends the entry's own text: pandoc's rule under a one-line value row made that row a heading.
    expect(kept('------------------------------------------\nEmber Lash\n-------------- --------- ---------\nCasting Time   Range     Duration')).toBe(true);
    expect(kept('Casting Time Range Components Duration\n\n### 1 action 60 feet V, S Instantaneous\n\nA lash.')).toBe(true);
    // Still corrected: page numbers above or below the labels, a prose paragraph, "Varies" in a tag's place.
    expect(kept('202\nCasting Time\n204\nRange', 'Index')).toBe(false);
    expect(kept('Casting Time (Varies)\nRange (Varies)\nDuration (Varies)', 'Spell Summary')).toBe(false);
    expect(kept('Casting Time\n\nMost spells require a single action to cast, but some take longer.', 'Casting a Spell')).toBe(false);
  });

  it("keeps a spell the first release stored from a web page's divs (pandoc's gfm, commonmark and markdown_mmd keep their tags), or a PDF reader's copy of a card table's label column", () => {
    const kept = (text: string, name = 'Ember Lash') => !misreadBefore('spell', name, text, []);
    const lash = '\n\nA lash of embers strikes.';
    // Each label and value in its own div, one tag to a line, inside wrapper divs that push Casting Time past 16 lines.
    const field = (label: string, value: string) =>
      `<div class="statblock-item">\n\n<div class="statblock-item-label">\n\n${label}\n\n</div>\n\n<div class="statblock-item-value">\n\n${value}\n\n</div>\n\n</div>`;
    const fields = [['Level', '1st'], ['Casting Time', 'Action'], ['Range', '60 feet'], ['Components', 'V, S'], ['Duration', 'Instantaneous']];
    const divs = `<div class="spell-page">\n\n<div class="statblock">\n\n${fields.map(([l, v]) => field(l, v)).join('\n\n')}\n\n</div>\n\n</div>`;
    expect(kept(`${divs}${lash}`)).toBe(true);
    // The value in a classed span.
    expect(kept(`<div class="label">\n\nCasting Time\n\n</div>\n\n<span class="value">Action</span>\n\nRange 60 feet${lash}`)).toBe(true);
    // poppler (pdftotext, Evince, Okular) copied the label column, and the value column's first line became the next
    // entry's name: the stored spell holds only its labels.
    for (const labels of ['Casting Time\nRange\nComponents\nDuration', 'Casting Time\nRange\nDuration', 'Casting Time\nRange']) {
      expect([labels, kept(labels, 'Wick Whisper')]).toEqual([labels, true]);
    }
    // Under the spell's name or its level line too, and whatever else stands above the labels: a Source, Classes or school
    // line, a level line with a separator, a page header, a tagline (poppler copies the label column first where a value
    // wraps, so the stored spell is that line over its labels).
    expect(kept('Wick Whisper\nLevel 1 Illusion (Bard, Wizard)\nCasting Time\nRange\nComponents\nDuration', 'Wick Whisper')).toBe(true);
    expect(kept('1st-level illusion\nCasting Time\nRange\nDuration', 'Wick Whisper')).toBe(true);
    for (const above of ['Source: Lantern Lore, p. 12', 'Classes: Bard, Wizard', 'Illusion', 'Level 1 · Illusion', 'LANTERN LORE 47', 'A whisper only the target hears.']) {
      expect([above, kept(`${above}\nCasting Time\nRange\nComponents`, 'Wick Whisper')]).toEqual([above, true]);
    }
    // In a copy without headings, the next spell's label column under the previous spell's prose.
    expect(kept(`Casting Time\nRange\nComponents\nDuration\n${'A whisper only the target hears.\n'.repeat(8)}Glow Mote\nCasting Time\nRange\nComponents\nDuration`, 'Wick Whisper')).toBe(true);
    // So a section's prose over a list of the labels, at the end of its text, stays a stored spell (the lesser harm).
    expect(kept("Every spell's description opens with a block of fields:\n\n- Casting Time\n- Range\n- Components\n- Duration", 'Reading a Spell')).toBe(true);
    // Still corrected: labels over prose, labels over page numbers, divs around a contents page's numbers.
    expect(kept('Casting Time\nRange\nComponents\nDuration\n\nEvery spell card lists these, in this order.', 'Spell Basics')).toBe(false);
    expect(kept('202\nCasting Time\n204\nRange', 'Index')).toBe(false);
    expect(kept('<div class="label">\n\nCasting Time\n\n</div>\n\n<div class="page">\n\n202\n\n</div>', 'Contents')).toBe(false);
  });

  it('keeps a spell the first release stored whose label and value stand in adjacent spans or tags, with nothing between them', () => {
    const kept = (text: string) => !misreadBefore('spell', 'Ember Lash', text, []);
    const lash = '\n\nA lash of embers strikes one creature you can see within range.';
    const fields = [['Casting Time', 'Action'], ['Range', '60 feet'], ['Components', 'V, S'], ['Duration', 'Instantaneous']];
    // pandoc's own Markdown writer: a bold label right before its value's classed span, or a pair of spans in a div.
    expect(kept(`${fields.map(([l, v]) => `**${l}**[${v}]{.value}`).join('\n\n')}${lash}`)).toBe(true);
    expect(kept(`*1st Evocation*\n\n::: card\n${fields.map(([l, v]) => `::: row\n[${l}]{.k}[${v}]{.v}\n:::`).join('\n\n')}\n:::${lash}`)).toBe(true);
    // gfm, commonmark and markdown_mmd keep the tags.
    expect(kept(`${fields.map(([l, v]) => `**${l}**<span class="value">${v}</span>`).join('\n\n')}${lash}`)).toBe(true);
    expect(kept(`${fields.map(([l, v]) => `<span class="name">${l}</span><span class="value">${v}</span>`).join('\n\n')}${lash}`)).toBe(true);
    // A grid of linked labels, each with its colon outside the link, over a grid of their values (gfm keeps the divs).
    const cell = (s: string) => `<div>\n\n${s}\n\n</div>`;
    const grid = (labels: string[]) =>
      `<div class="labels">\n\n${labels.map(cell).join('\n\n')}\n\n</div>\n\n<div class="values">\n\n${fields.map(([, v]) => cell(v)).join('\n\n')}\n\n</div>`;
    expect(kept(`${grid(fields.map(([l]) => `[${l}](/glossary#${l.toLowerCase().replace(' ', '-')}):`))}${lash}`)).toBe(true);
    expect(kept(`${grid(fields.map(([l]) => `[${l}]{.label}:`))}${lash}`)).toBe(true);
    // Still corrected: a glossary whose term and definition stand that way.
    expect(misreadBefore('spell', 'Spell Terms', '**Casting Time**[How long casting takes.]{.def}\n\n**Range**[How far it reaches.]{.def}', [])).toBe(true);
  });

  it("keeps an item the first release stored whose labelled type line pandoc wrote with its ASCII dashes", () => {
    // Word turns a typed " - " into an en dash; pandoc's own Markdown writes an en dash as "--" and an em dash as "---".
    for (const typeLine of [
      'Item Type: Wondrous Item -- Uncommon',
      'Item Type: Armor (Plate) --- Rarity: Rare',
      'Source: Lantern Lore, p. 20 -- Ring -- Uncommon',
      'Owl Lantern -- Wondrous Item -- Uncommon',
    ]) {
      expect([typeLine, misreadBefore('magic-item', 'Owl Lantern', `${typeLine}\n\nIt hoots.`, [])]).toEqual([typeLine, false]);
    }
    expect(misreadBefore('magic-item', 'Buying and Selling', 'A magic weapon or armor of rare quality is never for sale.', [])).toBe(true);
  });

  it("reads a spell card pandoc printed as a two-column simple table of fields, whatever its header and other rows", () => {
    const table = (header: string, rows: string[]) => {
      const width = Math.max(...[header, ...rows].map((r) => r.length));
      return `${header}\n  -------------- ${'-'.repeat(Math.max(4, width - 15))}\n${rows.map((r) => `  ${r}`).join('\n')}\n\nA lash of embers strikes one creature you can see within range.`;
    };
    const card = ['Casting Time   1 action', 'Range          30 feet', 'Components     V, S', 'Duration       Instantaneous'];
    for (const [header, rows] of [
      ['Property       Value', ['Spell Level    1st', ...card]],
      ['Property       Value', ['Spell Level    1st', ...card, 'Notes          None']],
      ['Attribute      Info', card],
      ['Ember Lash     Level 1 Evocation (Wizard)', card],
    ] as const) {
      const text = table(header, [...rows]);
      expect([header, rows.length, guessKind('Ember Lash', text)]).toEqual([header, rows.length, 'spell']);
    }
    // Through a whole document, as pandoc -f html -t markdown writes it.
    const doc = `# Lantern Lore Spells\n\n## Ember Lash\n\n  Property       Value\n  -------------- ---------------\n  Spell Level    1st\n  Casting Time   1 action\n  Range          30 feet\n  Components     V, S\n  Duration       Instantaneous\n\nA lash of embers strikes one creature you can see within range.\n\n## Glow Mote\n\n  Property       Value\n  -------------- ----------------\n  Spell Level    Cantrip\n  Casting Time   1 bonus action\n  Range          60 feet\n  Components     V\n  Duration       1 minute\n\nA mote of light hovers at a point you choose within range.`;
    expect(chunkDocument(doc, opts).filter((e) => e.kind === 'spell').map((e) => e.name)).toEqual(['Ember Lash', 'Glow Mote']);
    // Still not a card: a table of several spells' fields.
    expect(guessKind('Wick Spells', table('Spell          Casting Time', ['Glow Mote      1 action', 'Spark          1 bonus action']))).toBe('rule');
  });

  it("reads a pandoc table that compares spells, a ritual's casting, or what a card's fields mean, hold or default to, as a rule; a key/value card under its own header still reads", () => {
    const simple = (header: string, rule: string, rows: string[]) => `${header}\n  ${rule}\n${rows.map((r) => `  ${r}`).join('\n')}\n\nThe sections below explain each field.`;
    for (const [name, text] of [
      ['Wick Spells at a Glance', simple('               Ember Lash      Glow Mote', '-------------- --------------- ----------------', ['Casting Time   1 action        1 bonus action', 'Range          60 feet         Self'])],
      ['Ritual Casting', simple('               Normal casting   As a ritual', '-------------- ---------------- -------------------------', ['Casting Time   1 action         10 minutes and 1 action', 'Components     As the spell     As the spell'])],
      ['Spell Card Fields', simple('Field          Meaning', '-------------- ------------------------------------------', ['Casting Time   An action, unless the spell says otherwise', 'Range          Self, Touch, or a distance in feet'])],
      ['Reading a Spell', simple('Field          Example', '-------------- ---------------', ['Casting Time   1 action', 'Range          60 feet'])],
      ['Wick Magic', simple('Field          Default', '-------------- ---------------', ['Casting Time   1 action', 'Range          30 feet'])],
    ] as const) {
      expect([name, guessKind(name, text)]).toEqual([name, 'rule']);
    }
    // A rules section that opens with one keeps its subsections as entries of their own.
    const doc = `# Lantern Lore\n\n## Ritual Casting\n\nCasting a spell as a ritual changes it as follows.\n\n                 Normal casting   As a ritual\n  -------------- ---------------- -------------------------\n  Casting Time   1 action         10 minutes and 1 action\n  Spell Slot     Expended         None\n  Components     As the spell     As the spell\n\nYou cast a ritual only outside combat.\n\n### Ritual Books\n\nA ritual caster keeps a book.`;
    expect(chunkDocument(doc, opts).map((e) => `${e.name}:${e.kind}`)).toEqual(['Ritual Casting:rule', 'Ritual Books:rule']);
    // Still a card: two columns under its values' header, its own name or one of its rows, with a row outside the fields.
    const card = ['Spell Level    1st', 'Casting Time   1 action', 'Range          30 feet', 'Components     V, S', 'Duration       Instantaneous'];
    for (const header of ['Property       Value', 'Attribute      Info', 'Ember Lash     Level 1 Evocation (Wizard)', 'Spell          Ember Lash']) {
      expect([header, guessKind('Ember Lash', simple(header, '-------------- ---------------', card))]).toEqual([header, 'spell']);
    }
    // Its header or its label column in bold: pandoc -f html on a page's <th><b>…</b></th> cells, and pandoc -f docx on a
    // Word table whose first row (Word's header row) and label column are bold.
    const bold = ['**Spell Level**    1st', '**Casting Time**   1 action', '**Range**          30 feet', '**Components**     V, S', '**Duration**       Instantaneous'];
    for (const header of ['**Property**       **Value**', '*Attribute*        *Details*']) {
      expect([header, guessKind('Ember Lash', simple(header, '------------------ ---------------', bold))]).toEqual([header, 'spell']);
    }
    const word = `  -----------------------------------------------------------------------\n  **Spell Level**                     1st\n  ----------------------------------- -----------------------------------\n  **Casting Time**                    1 action\n\n  **Range**                           30 feet\n\n  **Duration**                        Instantaneous\n\n  **Components**                      V, S, M (a pinch of ash from a\n                                      hearth that has burned for a full\n                                      year)\n  -----------------------------------------------------------------------\n\nA lash of embers strikes one creature you can see within range.`;
    expect(guessKind('Ember Lash', word)).toBe('spell');
    // Still a rule in bold: a glossary of what each field means.
    expect(guessKind('Spell Card Fields', simple('**Field**          **Meaning**', '------------------ ------------------------------------------', ['**Casting Time**   An action, unless the spell says otherwise', '**Range**          Self, Touch, or a distance in feet']))).toBe('rule');
  });

  it('reads a long chain of casting times joined by "or" without slowing down', () => {
    for (const n of [20, 40, 84]) {
      const text = `Casting Time ${'1 action  or  '.repeat(n)}x\nRange 60 feet\n\nText.`;
      const started = performance.now();
      guessKind('Wick Spells', text);
      misreadBefore('spell', 'Wick Spells', text, []);
      expect(performance.now() - started).toBeLessThan(100);
    }
    // A glossary's list of casting times, spaced or tight around its commas, is still a list.
    for (const value of ['Action, Bonus Action, Reaction, or longer', '1 action  or  1 minute  or longer', '1 action,or longer']) {
      expect([value, guessKind('Spell Fields', `Casting Time    ${value}\nRange    How far it reaches.`)]).toEqual([value, 'rule']);
    }
  });

  it("doesn't take a list of spells copied from a web grid (its labels, then one cell to a line) for one spell's card", () => {
    const header = ['Level', 'Name', 'Casting Time', 'Duration', 'Range/Area'];
    const rows = [['Cantrip', 'Ember Lash', '1 Action', 'Instantaneous', '60 ft.'], ['1st', 'Glow Mote', '1 Bonus Action', '1 Minute', '30 ft.']];
    const list = [...header, ...rows.flat()];
    expect(guessKind('Wickwright Spells', list.join('\n'))).toBe('rule');
    expect(guessKind('Wickwright Spells', list.map((cell) => cell.toUpperCase()).join('\n'))).toBe('rule');
    expect(guessKind('Wickwright Spells', list.join('\n\n'))).toBe('rule');
    expect(guessKind('Wickwright Spells', ['Spell', 'Casting Time', 'Range', 'Ember Lash', '1 Action', '60 ft.', 'Glow Mote', '1 Bonus Action', '30 ft.'].join('\n'))).toBe('rule');
    // What the first release stored for it is corrected.
    expect(misreadBefore('spell', 'Wickwright Spells', list.join('\n'), [])).toBe(true);
    // One spell's own grid, with its name in the Name place, still reads.
    expect(guessKind('Ember Lash', [...header, ...rows[0]].join('\n'))).toBe('spell');
  });

  it('reads a table as a card only with a casting time under Casting Time and a spell card’s field in every row (not an index or a glossary)', () => {
    const lash = '\n\nA lash of embers strikes one creature you can see within range.';
    // A web page's grid of label/value pairs, padding cells, the spell's name over its fields.
    expect(guessKind('Ember Lash', `| Casting Time | 1 Action | Range | 30 feet |\n|---|---|---|---|\n| Components | V, S | Duration | Instantaneous |${lash}`)).toBe('spell');
    expect(guessKind('Ember Lash', `| Casting Time | 1 action | |\n|---|---|---|\n| Range | 60 feet | |\n| Duration | Instantaneous | |${lash}`)).toBe('spell');
    expect(guessKind('Ember Lash', `| Ember Lash | |\n|---|---|\n| Casting Time | 1 action |\n| Range | 60 feet |${lash}`)).toBe('spell');
    // An index's letter, with or without its header or pasted, a glossary of a spell's entries, a summary, a price list.
    expect(guessKind('C', '| Term | Page |\n|---|---|\n| Cantrip | 201 |\n| Casting Time | 202 |\n| Components | 203 |')).toBe('rule');
    expect(guessKind('C', '| Cantrip | 201 |\n|---|---|\n| Casting Time | 202 |\n| Components | 203 |\n| Concentration | 203 |')).toBe('rule');
    expect(guessKind('C', '| Casting Time | 202 |\n| Components | 203 |\n| Concentration | 203 |')).toBe('rule');
    expect(guessKind('C', 'Cantrip    201\nCasting Time    202\nComponents    203\nConcentration    203')).toBe('rule');
    expect(guessKind('Reading a Spell', "Each spell's entry opens with a short block:\n\n| Entry | What it tells you |\n|---|---|\n| Casting Time | How long casting takes |\n| Range | How far the spell reaches |\n| Duration | How long the effect lasts |")).toBe('rule');
    expect(guessKind('Spell Terms', '| Term | Meaning |\n|---|---|\n| Casting Time | How long casting takes |\n| Range | How far the spell reaches |')).toBe('rule');
    expect(guessKind('Spell Summary', '| Casting Time | Range | Components | Duration |\n|---|---|---|---|\n| Varies | Varies | Varies | Varies |\n\nEvery spell lists these.')).toBe('rule');
    expect(guessKind('Spellcasting Services', '| Service | Cost |\n|---|---|\n| Casting Time | 1 action |\n| Range | Touch |\n| Cost | 10 GP |')).toBe('rule');
  });

  it('reads a summoning spell as a spell before the stat block in its own text, under its name and a Source line too', () => {
    const hound = '\n\nYou summon a lantern hound in an unoccupied space you can see.\n\n**Lantern Hound**\n\n*Medium Celestial, Neutral*\n\n**AC** 12\n\n**HP** 22\n\n| STR | DEX | CON | INT | WIS | CHA |\n|---|---|---|---|---|---|\n| 14 (+2) | 12 (+1) | 12 (+1) | 6 (−2) | 12 (+1) | 8 (−1) |';
    const spell = (text: string) => [guessKind('Summon Lantern Hound', text), misreadBefore('spell', 'Summon Lantern Hound', text, [])];
    expect(spell(`| Casting Time | 1 Action | Range | 30 feet |\n|---|---|---|---|\n| Components | V, S | Duration | 1 hour |${hound}`)).toEqual(['spell', false]);
    expect(spell(`Summon Lantern Hound\n*Source: Lantern Lore, p. 30*\n| Casting Time | Range | Duration |\n|---|---|---|\n| 1 Action | 30 feet | 1 hour |${hound}`)).toEqual(['spell', false]);
    // A card today's rules can't read: the stat block makes it a monster, and the spell an earlier import stored stays one.
    expect(spell(`Casting Time | 1 Action\nRange | 30 feet${hound}`)).toEqual(['monster', false]);
  });

  it('keeps a spell an earlier import stored whenever a line of its card prints Casting Time and a casting time, and still corrects an index, a glossary or a creature', () => {
    const kept = (text: string, name = 'Ember Lash') => !misreadBefore('spell', name, text, []);
    const lash = '\n\nA lash of embers strikes.';
    // Whatever stands between the label and the casting time, and whatever else the line says.
    for (const card of ['Casting Time\\1 action', 'Casting Time | 1 action', 'Casting Time (1 action)', '– **Casting Time** 1 action', 'Casting Time 1 reaction which you take when you are hit', '| Casting Time | 1 hour |']) {
      expect(kept(`${card}${lash}`)).toBe(true);
    }
    // Even in a table that today's card test doesn't read as a card.
    expect(guessKind('Lantern Keep', '| Size | Roomy |\n|---|---|\n| Hirelings | 1 |\n| Casting Time | 1 hour |')).toBe('rule');
    expect(kept('| Size | Roomy |\n|---|---|\n| Hirelings | 1 |\n| Casting Time | 1 hour |', 'Lantern Keep')).toBe(true);
    // No casting time after the label: an index (as a table, pasted), a glossary, a summary, a contents page.
    expect(kept('| Term | Page |\n|---|---|\n| Cantrip | 201 |\n| Casting Time | 202 |\n| Components | 203 |', 'C')).toBe(false);
    expect(kept('Cantrip    201\nCasting Time    202\nComponents    203', 'C')).toBe(false);
    expect(kept("Each spell's entry opens with a short block:\n\n| Entry | What it tells you |\n|---|---|\n| Casting Time | How long casting takes |\n| Range | How far the spell reaches |", 'Reading a Spell')).toBe(false);
    expect(kept('Casting Time    Varies\nRange    Varies\nDuration    Varies', 'Spell Summary')).toBe(false);
    expect(kept('Casting Time\nRange\nComponents\nDuration\n202\n204\n205\n206', 'Contents')).toBe(false);
    // A creature, whatever today reads it as.
    expect(kept('Moth Mage\nMedium Humanoid, Neutral\n\nCasting Time 1 action\n\nThe mage flutters.', 'Moth Mage')).toBe(false);
    expect(kept('Medium Humanoid, Neutral\n\nCasting Time | 1 action\n\nAC 14\nHP 33 (6d8 + 6)\nCR 2 (XP 450; PB +2)', 'Moth Mage')).toBe(false);
  });

  it('keeps whatever line the first release read as "Casting Time" after any marks, when a casting time is in its value\'s place', () => {
    const kept = (text: string, name = 'Ember Lash') => !misreadBefore('spell', name, text, []);
    const lash = '\n\nA lash of embers strikes.';
    const [pua, zwsp] = [String.fromCharCode(0xf0b7), String.fromCharCode(0x200b)];
    // Whatever marks open the line and stand between the label and the casting time: quote marks and bullets, an
    // entity, a separator, an invisible space, a link or an emoji on the label.
    for (const card of [
      '> - **Casting Time** 1 action', '> + Casting Time 1 action', '> > Casting Time 1 action', `${pua} Casting Time 1 action`,
      '► Casting Time 1 action', '-Casting Time 1 action', '**Casting Time**&nbsp;1 action', '**Casting Time**&#160;1 action',
      'Casting Time · 1 action', 'Casting Time / 1 action', 'Casting Time = 1 action', 'Casting Time » 1 action',
      'Casting Time → 1 action', 'Casting Time…1 action', `Casting Time${zwsp} 1 action`, '[Casting Time](https://example.com/casting-time) 1 action',
      '⏱️ Casting Time 1 action', '[Casting Time] 1 action',
      // A grid's row of labels a PDF joined to its row of values.
      'CASTING TIME RANGE 1 action 60 feet COMPONENTS DURATION V, S Instantaneous',
    ]) {
      expect([card, kept(`${card}${lash}`)]).toEqual([card, true]);
    }
    // When the rest of the line holds only the card's other labels (or nothing), the first line with text below it
    // that isn't a table's delimiter row: a grid's row of labels, a table's header with a title row above it, a
    // cell wrapped onto a second row or an icon in the value, a callout's quoted table, the label alone.
    for (const card of [
      'CASTING TIME RANGE\n1 action 60 feet',
      'Casting Time Range\n\n1 action 60 feet',
      '| Ember Lash | | |\n|---|---|---|\n| Casting Time | Range | Duration |\n| 1 action | 60 feet | Instantaneous |',
      '| Casting Time | Range | Components |\n|---|---|---|\n| 1 action | 60 feet | V, S, M (a pinch of |\n| | | soot) |',
      '| Casting Time | Range |\n|---|---|\n| ⚡ 1 action | 60 feet |',
      '> | Casting Time | Range |\n> |---|---|\n> | 1 action | 60 feet |',
      '**Casting Time**\n\n1 action',
    ]) {
      expect([card, kept(`${card}${lash}`)]).toEqual([card, true]);
    }
    // Still corrected: labels over page numbers, a list of spells copied from a web grid (its Name column names
    // other spells), a casting time that isn't the label's value.
    expect(kept('Casting Time Range Components Duration\n202 204 205 206', 'Contents')).toBe(false);
    expect(kept('| Casting Time | Range |\n|---|---|\n| 202 | 204 |', 'Index')).toBe(false);
    expect(kept(['Level', 'Name', 'Casting Time', 'Duration', 'Cantrip', 'Ember Lash', '1 Action', 'Instantaneous', '1st', 'Glow Mote', '1 Bonus Action', '1 Minute'].join('\n'), 'Wickwright Spells')).toBe(false);
    expect(kept('Casting Time Points\n1 action costs one point.', 'Casting Points')).toBe(false);
  });

  it("doesn't take the card of a spell a feat grants or an item casts for a spell, wherever its category or type line stands above it", () => {
    const card = '\n\nYou learn the Glow Mote spell:\n\nCasting Time    Bonus Action\nRange    30 feet\nDuration    1 minute';
    const initiate = `Lantern Initiate\n*Source: Lantern Lore, p. 9*\nOrigin Feat${card}`;
    expect(guessKind('Lantern Initiate', initiate)).toBe('feat');
    expect(guessKind('Lantern Initiate', `*Source: Lantern Lore, p. 9*\n\n*Some walk in light.*\n\nGeneral Feat (Prerequisite: Level 4+)${card}`)).toBe('feat');
    const wand = 'Glimmer Wand\n*Source: Lantern Lore, p. 40*\n*Wand, rare (requires attunement)*\n\nWhile holding it, you can cast Ember Lash from it:\n\nCasting Time    1 action\nRange    60 feet';
    expect(guessKind('Glimmer Wand', wand)).toBe('magic-item');
    expect(guessKind('Moth Adept', `Moth Adept\n*Source: Lantern Lore*\nPrerequisite: Intelligence 13 or higher${card}`)).not.toBe('spell');
    // The first release took them for spells: corrected to what they are.
    expect(misreadBefore('spell', 'Lantern Initiate', initiate, [])).toBe(true);
    expect(misreadBefore('spell', 'Glimmer Wand', wand, [])).toBe(true);
    // A spell under its own name and a Source line is still one.
    expect(guessKind('Glow Mote', 'Glow Mote\n*Source: Lantern Lore, p. 9*\n\nCasting Time    Bonus Action\nRange    30 feet\n\nA mote of light.')).toBe('spell');
  });

  it('finds a 2024 feat whose category line a PDF joined to its text, or wrapped', () => {
    expect(guessKind('Lamp Lifter', 'General Feat (Prerequisite: Level 4+) You gain the following benefits.\n\nYou lift lamps.')).toBe('feat');
    expect(guessKind('Wick Dancer', 'General Feat (Prerequisite: Level 4+, Strength or\nDexterity 13+)\nYou move.')).toBe('feat');
    expect(guessKind('Wick Dancer', '*General Feat (Prerequisite: Level 4+, Strength or\nDexterity 13+)*\n\nYou move.')).toBe('feat');
    expect(guessKind('Lamp Lifter', 'Origin Feat You gain the following benefits.')).toBe('feat');
    // Not rules text about feats.
    expect(guessKind('Feat Categories', 'Origin feats are listed below.')).toBe('rule');
    expect(guessKind('Feat Categories', 'Origin Feat categories: each background gives one.')).toBe('rule');
    const [entry] = chunkDocument('## Lamp Lifter\n\nGeneral Feat (Prerequisite: Level 4+) You gain the following benefits.', { sourceId: 's', sourceName: 'S' });
    expect(entry).toMatchObject({ kind: 'feat', summary: 'General Feat (Prerequisite: Level 4+)' });
  });

  it("doesn't take other things that print a Prerequisite line for feats", () => {
    // An invented stronghold room: a type line, then Prerequisite and other labelled lines.
    const room = '_Level 5 Holding Room_\n\n_Prerequisite: None_\n\n_Room: Snug_\n\n_Keepers: 1_\n\nThe keeper raises glowworms in jars of moss.';
    expect(guessKind('Glowworm Gallery', room, ['Lamplight Holdings', 'Holding Rooms'])).toBe('rule');
    expect(guessKind('Glowworm Gallery', room)).toBe('rule');
    // A PDF that lost the type line, or joined the labelled lines: the labels still tell.
    expect(guessKind('Glowworm Gallery', "_Prerequisite: A lantern-maker's tools_\n\n_Room: Snug_\n\n_Keepers: 1_\n\nThe keeper sells light.")).toBe('rule');
    expect(guessKind('Glowworm Gallery', 'Prerequisite: Lantern tools Room: Snug Keepers: 1\n\nThe keeper sells light.')).toBe('rule');
    expect(guessKind('Glowworm Gallery', 'Prerequisite: None\n\nRoom: Snug Keepers: 1 Order: Craft. The keeper sells light.')).toBe('rule');
    // Invented class options that name a class at a level, a pact, a cantrip or a patron.
    expect(guessKind('Bright Ember', '_Prerequisite: Level 5+ Wickwright_\n\nYour flame burns brighter.', ['Wickwright', 'Wick Charm Options'])).toBe('rule');
    expect(guessKind('Bright Ember', 'Prerequisite: Level 5+ Warlock You can use a Bonus Action to glow.')).toBe('rule');
    expect(guessKind('Bright Ember', 'Prerequisite: Level 9+ Wickwright, Pact of the Tome Invocation\n\nYour flame burns brighter.')).toBe('rule');
    expect(guessKind('Lantern Boots', 'Prerequisite: 6th-level wickwright\nItem: A pair of boots\n\nWhile you wear them, you glow.')).toBe('rule');
    expect(guessKind('Thread Bond', 'Prerequisite: Pact of the Thread feature\n\nYour pact holds.')).toBe('rule');
    expect(guessKind('Searing Volley', 'Prerequisite: *ember dart* cantrip\n\nWhen you cast ember dart, add your Charisma modifier.')).toBe('rule');
    expect(guessKind('Moth Sight', 'Prerequisite: Moth Queen patron\n\nYou see in the dark.')).toBe('rule');
    expect(guessKind('Moth Sight', 'Prerequisite: 15th level, Pact of the Thread feature\n\nYou see in the dark.')).toBe('rule');
    // A level alone counts only under a heading that names class options.
    expect(guessKind('Bright Ember', 'Prerequisite: 5th level\n\nYour flame burns brighter.', ['Wickwright', 'Wick Invocations'])).toBe('rule');
    expect(guessKind('Lantern Boots', 'Prerequisite: 6th-level wickwright\n\nYou glow.', ['Wickwright Infusions'])).toBe('rule');
    expect(guessKind('Bright Ember', 'Prerequisite: 5th level\n\nYour flame burns brighter.')).toBe('feat');
  });

  it('counts a Prerequisite line under a heading that names feats, whatever else the entry prints', () => {
    const typed = '_Lamp Talent_\n\n_Prerequisite: Level 5+ Wickwright_\n\nYour flame burns brighter.';
    expect(guessKind('Bright Ember', typed)).toBe('rule');
    expect(guessKind('Bright Ember', typed, ['Feats'])).toBe('feat');
    expect(guessKind('Bright Ember', typed, ['Chapter 6: Character Options', 'Racial Feats'])).toBe('feat');
    expect(guessKind('Bright Ember', typed, ['**Feat Descriptions**'])).toBe('feat');
    expect(guessKind('Bright Ember', typed, ['Feats (Optional Rule)'])).toBe('feat');
    expect(guessKind('Bright Ember', typed, ['List of Feats:'])).toBe('feat');
    // Not a title that only starts with the word, and never "Features".
    expect(guessKind('Bright Ember', typed, ['Feats and Fortresses'])).toBe('rule');
    expect(guessKind('Bright Ember', typed, ['Feats of Strength'])).toBe('rule');
    expect(guessKind('Bright Ember', typed, ['Wickwright', 'Class Features'])).toBe('rule');
  });

  it('knows what the first version took for a feat that today’s rules read as something else', () => {
    const room = '_Level 5 Holding Room_\n\n_Prerequisite: None_\n\nThe keeper raises glowworms.';
    expect(misreadBefore('feat', 'Glowworm Gallery', room, ['Holding Rooms'])).toBe(true);
    expect(misreadBefore('feat', 'Bright Ember', 'Prerequisite: Level 5+ Wickwright\n\nYour flame burns brighter.', [])).toBe(true);
    expect(misreadBefore('feat', 'Night Walker', 'Prerequisite: Wisdom 13 or higher\n\nYou walk at night.', [])).toBe(false);
    expect(misreadBefore('feat', 'Lantern Bearer', '_General Feat_\n\nYou carry the light.', [])).toBe(false);
    expect(misreadBefore('feat', 'Lamp Oil', 'Lamp oil burns for six hours.', [])).toBe(false);
    // Its own text only: a subsection's Prerequisite line never made it a feat.
    expect(misreadBefore('feat', 'Lamp Oil', 'Lamp oil burns.\n\n### Oil Lore\n\nPrerequisite: None', [])).toBe(false);
  });

  it('never takes a demoted kind for a misreading when the entry shows the real thing', () => {
    // A real item whose type line follows a label, a table cell or its name and a dash.
    expect(misreadBefore('magic-item', 'Glimmer Cloak', 'Type: Wondrous Item, Rare (Requires Attunement)\n\nYou glimmer.', [])).toBe(false);
    expect(misreadBefore('magic-item', 'Owl Lantern', 'Owl Lantern — Wondrous Item, Uncommon\n\nIt hoots.', [])).toBe(false);
    expect(misreadBefore('magic-item', 'Moth Brooch', '| Type | Wondrous Item, Uncommon |\n|---|---|\n\nIt flutters.', [])).toBe(false);
    // A web database's labelled type line: the rarity after a separator, a "Rarity:" label or in parentheses.
    for (const typeLine of [
      'Item Type: Wondrous Item / Rarity: Rare (Requires Attunement)',
      'Item Type: Armor (Chain Mail); Rarity: Uncommon',
      'Item Type: Wondrous Item Rarity: Rare',
      'Magic Item: Armor (Plate) (Uncommon)',
      'Source: Lantern Lore p. 20 · Wondrous Item (Rare)',
    ]) {
      expect([typeLine, guessKind('Glimmer Cloak', `${typeLine}\n\nYou glimmer.`), misreadBefore('magic-item', 'Glimmer Cloak', `${typeLine}\n\nYou glimmer.`, [])]).toEqual([typeLine, 'rule', false]);
    }
    expect(guessKind('Owl Lantern', 'Owl Lantern — Wondrous Item, Uncommon\n\nIt hoots.')).toBe('magic-item');
    expect(guessKind('Owl Lantern', 'Owl Lantern - Wondrous item, uncommon\n\nIt hoots.')).toBe('magic-item');
    expect(guessKind('Owl Lantern', 'Owl Lantern (wondrous item, uncommon)\n\nIt hoots.')).toBe('magic-item');
    expect(guessKind('Vault', 'The vault (where armor and rare treasures wait) is locked.')).toBe('rule');
    expect(guessKind('Vault', 'The vault — armor, weapons and rare treasures lie within.')).toBe('rule');
    // A stat block that prints ability scores but no XP.
    const wolf = 'Medium Beast, Unaligned\n\nAC 13\nHP 11\n\n| STR | DEX | CON | INT | WIS | CHA |\n|---|---|---|---|---|---|\n| 12 | 15 | 12 | 3 | 12 | 6 |';
    expect(guessKind('Lamp Wolf', wolf)).toBe('monster');
    expect(misreadBefore('monster', 'Lamp Wolf', wolf, [])).toBe(false);
  });

  it('knows what an earlier version took for a spell, a monster or a magic item', () => {
    expect(misreadBefore('monster', 'Building a Creature', 'As a rule of thumb, a CR 3 creature has AC 13 and HP 65.', [])).toBe(true);
    expect(misreadBefore('magic-item', 'Buying and Selling', 'A magic weapon or armor of rare quality is never for sale.', [])).toBe(true);
    expect(misreadBefore('spell', 'Wand of Little Sparks', '_Wand, Common_\n\nYou can cast an Evocation cantrip you know.', [])).toBe(true);
    expect(misreadBefore('magic-item', 'Mothsilk Cloak', '_Wondrous Item, Uncommon_\n\nIt flutters.', [])).toBe(false);
  });

  it('takes the headings above an entry from its path, with or without its own name last', () => {
    expect(headingAncestors(['Feats', 'Night Walker'], 'Night Walker')).toEqual(['Feats']);
    expect(headingAncestors(['Feats'], 'Night Walker')).toEqual(['Feats']);
    expect(headingAncestors(['Feats', '**Night Walker**'], 'Night Walker')).toEqual(['Feats']);
    expect(headingAncestors(undefined, 'Night Walker')).toEqual([]);
  });

  it('finds spells, monsters and magic items by their own lines, not by a mention in prose', () => {
    // Advice that names AC, HP and CR is not a stat block; one a PDF joined to its type line is.
    expect(guessKind('Building a Creature', 'Start with a challenge rating. As a rule of thumb, a CR 3 creature has AC 13 and HP 65, and its attacks deal about 20 damage.')).toBe('rule');
    expect(guessKind('Elder Thornback', 'Large Monstrosity, Unaligned AC 17\n\nHP 150 (12d10 + 84)\n\nSpeed 40 ft.\n\nCR 9 (XP 5,000; PB +4)')).toBe('monster');
    expect(guessKind('Orc', 'Medium humanoid, Armor Class 13 (hide armor), Hit Points 15 (2d8 + 6), Challenge 1/2 (100 XP)')).toBe('monster');
    // A paragraph about rare armor is not a type line.
    expect(guessKind('Buying and Selling Wonders', 'Most towns sell only common potions. A magic weapon or armor of rare quality is almost never for sale.')).toBe('rule');
    // An item that names a cantrip stays an item.
    expect(guessKind('Wand of Little Sparks', '_Wand, Common_\n\nThis wand has 5 charges. While holding it, you can expend 1 charge to cast an Evocation cantrip you know.')).toBe('magic-item');
    // An index line is not a Casting Time label.
    expect(guessKind('C', 'campaign, 5\ncantrip, 214\ncasting time, 215\nChallenge Rating (CR), 40')).toBe('rule');
    // A type line a PDF joined to the first paragraph still reads as one.
    expect(guessKind('Whisperedge', 'Weapon (Longsword), Legendary (Requires Attunement) You gain a +2 bonus to attack rolls and damage rolls made with this magic weapon.')).toBe('magic-item');
    expect(guessKind('Bright Ward', '**Casting Time.** Action\n\nA ward of light surrounds you.')).toBe('spell');
  });

  it('defaults to rule, even for prose that mentions feats or rarity', () => {
    expect(guessKind('Feats', 'A feat represents a talent or an area of expertise.')).toBe('rule');
    expect(guessKind('Magic Item Rarity', 'Each magic item has a rarity: common, uncommon, rare, very rare or legendary.')).toBe('rule');
    expect(guessKind('Opportunity Attacks', 'You can make an Opportunity Attack when a creature leaves your reach.')).toBe('rule');
  });
});

// An invented book: stronghold rooms and a class option print Prerequisite lines; only the Feats section holds feats.
const HOLDINGS = `# Lamplight Holdings

## Holding Rooms

### Glowworm Gallery

_Level 5 Holding Room_

_Prerequisite: None_

_Room: Snug_

_Keepers: 1_

The keeper raises glowworms in jars of moss and sells their light by the hour.

#### Gallery Tasks

Brew. The keeper fills a jar with light that lasts one night.

### Moth Archive

_Level 9 Holding Room_

_Prerequisite: Proficiency with a lantern-maker's tools_

Moths copy every map left on the archive's tables.

## Wick Charm Options

### Bright Ember

_Prerequisite: Level 5+ Wickwright_

Your wick's flame sheds bright light 10 feet farther.

## Feats

### Night Walker

_Prerequisite: Wisdom 13 or higher_

You can walk the lamp roads at night without a light.
`;

describe('stat blocks whose sections a PDF put at the creature’s own heading level', () => {
  const BESTIARY = `# Lantern Beasts

## Thornbacks

Thornbacks nest in old lamp towers.

### Elder Thornback

_Large Monstrosity, Unaligned_

**AC** 17

**HP** 150 (12d10 + 84)

**CR** 9 (XP 5,000; PB +4)

### Actions

Tail. Melee Attack Roll: +12, reach 15 ft. Hit: 20 (3d8 + 7) Piercing damage.

### Legendary Actions

Lash. The thornback makes one Tail attack.

### Thornback Lairs

Lairs smell of lamp oil.
`;

  it('gives the creature its Actions and Legendary Actions, and leaves the lore section its own text', () => {
    const entries = chunkDocument(BESTIARY, opts);
    const elder = entries.find((e) => e.name === 'Elder Thornback')!;
    expect(elder.kind).toBe('monster');
    expect(elder.text).toContain('### Actions');
    expect(elder.text).toContain('reach 15 ft.');
    expect(elder.text).toContain('### Legendary Actions');
    expect(entries.find((e) => e.name === 'Thornbacks')?.text).toBe('Thornbacks nest in old lamp towers.');
    // Another subsection ends the creature's run.
    expect(entries.find((e) => e.name === 'Thornback Lairs')?.kind).toBe('rule');
  });
});

describe('feats and Prerequisite lines in a whole book', () => {
  it('keeps stronghold rooms and class options as rules, with their subsections as entries of their own', () => {
    const entries = chunkDocument(HOLDINGS, opts);
    const kinds = Object.fromEntries(entries.map((e) => [e.name, e.kind]));
    expect(kinds).toEqual({ 'Glowworm Gallery': 'rule', 'Gallery Tasks': 'rule', 'Moth Archive': 'rule', 'Bright Ember': 'rule', 'Night Walker': 'feat' });
    expect(entries.find((e) => e.name === 'Night Walker')?.summary).toBe('Prerequisite: Wisdom 13 or higher');
    expect(entries.find((e) => e.name === 'Glowworm Gallery')?.summary).toBe('Lamplight Holdings › Holding Rooms');
  });
});

describe('staleEntryKinds', () => {
  const entry = (n: number, name: string, kind: CompendiumEntry['kind'], text: string, path: string[], summary?: string): CompendiumEntry => ({
    id: `lib:hold:${n}`, sourceId: 'hold', sourceName: 'Lamplight Holdings', kind, name, text, path, ...(summary ? { summary } : {}),
  });
  const room = '_Level 5 Holding Room_\n\n_Prerequisite: None_\n\nThe keeper raises glowworms.\n\n### Gallery Tasks\n\nBrew.';

  it("corrects what an older import stored as feats, with the summary of the kind it is now", () => {
    const fixes = staleEntryKinds([
      entry(1, 'Glowworm Gallery', 'feat', room, ['Lamplight Holdings', 'Holding Rooms', 'Glowworm Gallery'], 'Prerequisite: None'),
      entry(2, 'Bright Ember', 'feat', '_Prerequisite: Level 5+ Wickwright_\n\nYour flame burns brighter.', ['Bright Ember']),
      entry(3, 'Night Walker', 'feat', '_Prerequisite: Wisdom 13 or higher_\n\nYou walk at night.', ['Lamplight Holdings', 'Feats', 'Night Walker']),
      entry(4, 'Lantern Bearer', 'feat', '_General Feat (Prerequisite: Level 4+)_\n\nYou carry the light.', ['Lantern Bearer']),
      entry(5, 'Lamp Oil', 'rule', 'Prerequisite: none. Lamp oil burns for six hours.', ['Lamp Oil']),
    ]);
    expect(fixes).toEqual([
      { id: 'lib:hold:1', kind: 'rule', summary: 'Lamplight Holdings › Holding Rooms' },
      { id: 'lib:hold:2', kind: 'rule' },
    ]);
  });

  it('reads only what the entry printed before its subsections, and takes a long entry’s parts along (in any order given)', () => {
    const long = 'x'.repeat(50);
    const path = ['Lamplight Holdings', 'Holding Rooms'];
    const fixes = staleEntryKinds([
      entry(3, 'Moth Archive (part 3)', 'feat', long, [...path, 'Moth Archive (part 3)']),
      entry(5, 'Night Walker (part 2)', 'feat', long, ['Feats', 'Night Walker (part 2)']),
      // Its subsection would read as a spell; the import read only the room's own text.
      entry(1, 'Moth Archive', 'feat', `_Level 9 Holding Room_\n\n_Prerequisite: None_\n\n${long}\n\n### Archive Charm\n\nCasting Time: Action`, [...path, 'Moth Archive']),
      entry(4, 'Night Walker', 'feat', '_Prerequisite: Wisdom 13 or higher_\n\nYou walk at night.', ['Feats', 'Night Walker']),
      entry(2, 'Moth Archive (part 2)', 'feat', long, [...path, 'Moth Archive (part 2)']),
    ]);
    expect(fixes.map((f) => [f.id, f.kind])).toEqual([['lib:hold:1', 'rule'], ['lib:hold:2', 'rule'], ['lib:hold:3', 'rule']]);
  });

  it('corrects what an earlier version took for a spell, a monster or a magic item', () => {
    expect(staleEntryKinds([
      entry(1, 'Wand of Little Sparks', 'spell', '_Wand, Common_\n\nYou can cast an Evocation cantrip you know.', ['Treasure', 'Wand of Little Sparks']),
      entry(2, 'Buying and Selling', 'magic-item', 'A magic weapon or armor of rare quality is never for sale.', ['Treasure', 'Buying and Selling']),
      entry(3, 'Building a Creature', 'monster', 'A CR 3 creature has AC 13 and HP 65.', ['Monsters', 'Building a Creature']),
      entry(4, 'Lamp Drake', 'monster', '**AC** 14\n\n**HP** 22 (4d6 + 8)\n\n**CR** 1 (XP 200)', ['Monsters', 'Lamp Drake']),
      entry(5, 'Moth Drake', 'monster', 'Small Dragon, Unaligned AC 13\n\nHP 9 (2d6 + 2)\n\nChallenge 1/2 (100 XP)', ['Monsters', 'Moth Drake']),
    ]).map((f) => [f.id, f.kind])).toEqual([['lib:hold:1', 'magic-item'], ['lib:hold:2', 'rule'], ['lib:hold:3', 'rule']]);
  });

  it('leaves alone the spells an earlier import stored from cards without colons, whatever their shape', () => {
    const cards = [
      '| | |\n|---|---|\n| Casting Time | 1 action |\n| Range | 60 feet |\n\nA lash of embers.',
      '*Source: Lantern Lore, p. 12*\n\n| Casting Time | Range | Duration |\n|---|---|---|\n| Bonus Action | 30 feet | 1 minute |\n\nA mote of light.',
      '- **Casting Time** 1 reaction\n- **Range** Self\n\nPale moths swirl around you.',
      'Casting Time Bonus Action Range 30 feet\n\nComponents V\n\nDuration 1 minute\n\nA mote of light.',
      'Casting Time\tReaction, which you take when a creature you can see within 60 feet of you casts a spell\nRange\t60 feet\n\nYou unravel it.',
      'Casting Time | Range | Duration\n--- | --- | ---\n1 action | Touch | 1 hour\n\nAn object you touch glows.',
      '**Casting Time** 1 Action\n**Range** 30 feet\n\nYou summon a hound.\n\n**AC** 12\n\n**HP** 22\n\n| STR | DEX | CON | INT | WIS | CHA |\n|---|---|---|---|---|---|\n| 14 | 12 | 12 | 6 | 12 | 8 |',
    ];
    const stored = cards.map((text, i) => entry(i + 1, `Lantern Spell ${i + 1}`, 'spell', text, ['Lantern Lore', 'Spells', `Lantern Spell ${i + 1}`]));
    expect(staleEntryKinds(stored)).toEqual([]);
    // An index line the same import took for a spell is still corrected.
    expect(staleEntryKinds([...stored, entry(9, 'Index', 'spell', 'Casting Time, 202\nRange, 204', ['Lantern Lore', 'Index'])])).toEqual([{ id: 'lib:hold:9', kind: 'rule', summary: 'Lantern Lore' }]);
  });

  it("leaves alone the spells an earlier import stored from converters' cards, and corrects the feats, items, indexes and glossaries it took for spells", () => {
    const spell = (n: number, name: string, text: string) => entry(n, name, 'spell', text, ['Lantern Lore', 'Spells', name]);
    const stored = [
      spell(1, 'Glow Mote', '**Casting Time** Bonus Action\\\n**Range** 30 feet\\\n**Duration** 1 minute\n\nA mote of light.'),
      spell(2, 'Ember Lash', '- **Casting Time** 1 minute ritual\n- **Range** 60 feet\n\nA lash of embers.'),
      spell(3, 'Moth Ward', '• Casting Time 1 reaction\n• Range Self\n\nPale moths swirl around you.'),
      spell(4, 'Summon Lantern Hound', 'Casting Time | 1 Action\nRange | 30 feet\n\nYou summon a hound.\n\n**AC** 12\n\n**HP** 22\n\n| STR | DEX | CON | INT | WIS | CHA |\n|---|---|---|---|---|---|\n| 14 | 12 | 12 | 6 | 12 | 8 |'),
      spell(5, 'Lantern Initiate', 'Lantern Initiate\n*Source: Lantern Lore, p. 9*\nOrigin Feat\n\nYou learn Glow Mote:\n\nCasting Time    Bonus Action\nRange    30 feet'),
      spell(6, 'Glimmer Wand', 'Glimmer Wand\n*Source: Lantern Lore, p. 40*\n*Wand, rare (requires attunement)*\n\nCasting Time    1 action\nRange    60 feet'),
      spell(7, 'C', '| Term | Page |\n|---|---|\n| Cantrip | 201 |\n| Casting Time | 202 |\n| Components | 203 |'),
      spell(8, 'Reading a Spell', "Each spell's entry opens with a short block:\n\n| Entry | What it tells you |\n|---|---|\n| Casting Time | How long casting takes |\n| Range | How far the spell reaches |"),
    ];
    expect(staleEntryKinds(stored).map((c) => [c.id, c.kind])).toEqual([
      ['lib:hold:5', 'feat'],
      ['lib:hold:6', 'magic-item'],
      ['lib:hold:7', 'rule'],
      ['lib:hold:8', 'rule'],
    ]);
  });

  it('leaves alone the spells an earlier import stored from callouts, bullet glyphs, grids, title rows and separators, and corrects a web grid list', () => {
    const spell = (n: number, name: string, text: string) => entry(n, name, 'spell', text, ['Lantern Lore', 'Spells', name]);
    const pua = String.fromCharCode(0xf0b7);
    const stored = [
      spell(1, 'Glow Mote', '> [!spell] Evocation\n> - **Casting Time** Bonus Action\n> - **Range** 30 feet\n\nA mote of light.'),
      spell(2, 'Ember Lash', `${pua} Casting Time 1 action\n${pua} Range 60 feet\n\nA lash of embers.`),
      spell(3, 'Moth Ward', 'CASTING TIME RANGE\nReaction, which you take when you are hit Self\nCOMPONENTS DURATION\nV, S 1 round\n\nPale moths swirl.'),
      spell(4, 'Lamp Wake', '| Lamp Wake | | |\n|---|---|---|\n| Casting Time | Range | Duration |\n| 8 hours | Touch | Until dispelled |\n\nThe lamps wake.'),
      spell(5, 'Wick Ward', 'Casting Time · 1 action\nRange · Self\n\nA ward of wicks.'),
      spell(6, 'Wickwright Spells', ['Level', 'Name', 'Casting Time', 'Duration', 'Cantrip', 'Ember Lash', '1 Action', 'Instantaneous', '1st', 'Glow Mote', '1 Bonus Action', '1 Minute'].join('\n')),
    ];
    expect(staleEntryKinds(stored)).toEqual([{ id: 'lib:hold:6', kind: 'rule', summary: 'Lantern Lore › Spells' }]);
  });

  it("leaves alone the spells an earlier import stored from pandoc's tables, spans and fences, fuller label rows, space references, tags and values above their labels, and the items from labelled type lines", () => {
    const spell = (n: number, name: string, text: string) => entry(n, name, 'spell', text, ['Lantern Lore', 'Spells', name]);
    const item = (n: number, name: string, text: string) => entry(n, name, 'magic-item', text, ['Lantern Lore', 'Treasures', name]);
    const stored = [
      spell(1, 'Ember Lash', '-------------------------------------------------\n  Casting Time   Range     Duration\n  -------------- --------- ---------------\n  1 action       60 feet   Instantaneous\n\n  -------------------------------------------------\n\nA lash of embers.'),
      spell(2, 'Glow Mote', '+--------------+---------+\n| Casting Time | Range   |\n+==============+=========+\n| Bonus Action | 30 feet |\n+--------------+---------+\n\nA mote of light.'),
      spell(3, 'Moth Ward', '-   [Casting Time]{.label} [1 reaction]{.value}\n-   [Range]{.label} [Self]{.value}\n\nPale moths swirl around you.'),
      spell(4, 'Lamp Wake', '| Lamp Wake | | | | |\n|---|---|---|---|---|\n| Casting Time | Range | Components | Duration | School |\n| 8 hours | Touch | V, S | Until dispelled | Abjuration |\n\nThe lamps wake.'),
      spell(5, 'Wick Ward', '**Casting Time**&emsp;1 action\n**Range**&emsp;Self\n\nA ward of wicks.'),
      spell(6, 'Spark Veil', '**Casting Time** (R) 10 minutes\n**Range** Touch\n\nA veil of sparks.'),
      spell(7, 'Ash Step', 'Bonus Action\nCasting Time\nSelf\nRange\n\nYou step through ash.'),
      spell(8, 'Index', '202\nCasting Time\n204\nRange'),
      item(9, 'Glimmer Cloak', 'Item Type: Wondrous Item / Rarity: Rare (Requires Attunement)\n\nYou glimmer.'),
      item(10, 'Lantern Plate', 'Magic Item: Armor (Plate) (Uncommon)\n\nIt glows.'),
      item(11, 'Buying and Selling', 'A magic weapon or armor of rare quality is never for sale.'),
    ];
    expect(staleEntryKinds(stored).map((c) => [c.id, c.kind])).toEqual([['lib:hold:8', 'rule'], ['lib:hold:11', 'rule']]);
  });

  it('keeps an older-style feat whose import lost the Feats heading (a PDF that flattened it)', () => {
    expect(staleEntryKinds([
      entry(1, 'Feats', 'rule', 'A feat is a talent.', ['Lantern Folk', 'Feats']),
      entry(2, 'Night Walker', 'feat', 'Prerequisite: Wisdom 13 or higher\n\nYou walk at night.', ['Lantern Folk', 'Night Walker']),
      entry(3, 'Wick Guard', 'feat', 'Prerequisite: Proficiency with shields\n\nYou guard the flame.', ['Lantern Folk', 'Wick Guard']),
    ])).toEqual([]);
  });
});
