import { describe, expect, it } from 'vitest';
import { chunkDocument, guessKind, inferPlainTextHeadings, splitIntoChunks, staleFeatKinds, TARGET_CHUNK_CHARS } from './chunk';
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
});

describe('inferPlainTextHeadings', () => {
  it('needs at least two title-like lines', () => {
    expect(inferPlainTextHeadings('Notes\n\nA long paragraph of prose that is clearly not a heading at all.')).toBeNull();
  });

  it('does not treat prose, list items or stat-block labels as headings', () => {
    const text = 'Overview\n\nThis is prose.\n\n- Bullet Item Here\n\nActions\n\nSecond Section\n\nMore prose here.';
    expect(inferPlainTextHeadings(text)).toBe('## Overview\n\nThis is prose.\n\n- Bullet Item Here\n\nActions\n\n## Second Section\n\nMore prose here.');
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

  it('recognizes feats by their category line, or by a Prerequisite line under a heading that names feats', () => {
    expect(guessKind('Alert', '_Origin Feat_\n\nYou gain the following benefits.')).toBe('feat');
    expect(guessKind('Grappler', '_General Feat (Prerequisite: Level 4+, Strength or Dexterity 13+)_\n\nBenefits.')).toBe('feat');
    expect(guessKind('Lucky (Origin Feat)', 'You have inexplicable luck.')).toBe('feat');
    const older = '_Prerequisite: Wisdom 13 or higher_\n\nYou can walk the lamp roads at night without a light.';
    expect(guessKind('Night Walker', older, ['Feats'])).toBe('feat');
    expect(guessKind('Night Walker', older, ['Chapter 6: Character Options', 'Feats'])).toBe('feat');
    expect(guessKind('Night Walker', older, ['Racial Feats'])).toBe('feat');
    expect(guessKind('Night Walker', older, ['**Feat Descriptions**'])).toBe('feat');
  });

  it("doesn't take other things that print a Prerequisite line for feats", () => {
    // An invented stronghold room: a type line, then Prerequisite and other labelled lines.
    const room = '_Level 5 Holding Room_\n\n_Prerequisite: None_\n\n_Room: Snug_\n\n_Keepers: 1_\n\nThe keeper raises glowworms in jars of moss.';
    expect(guessKind('Glowworm Gallery', room, ['Lamplight Holdings', 'Holding Rooms'])).toBe('rule');
    expect(guessKind('Glowworm Gallery', room)).toBe('rule');
    // An invented class option that only prints a prerequisite.
    const charm = '_Prerequisite: Level 5+ Wickwright_\n\nYour wick’s flame sheds bright light 10 feet farther.';
    expect(guessKind('Bright Ember', charm, ['Wickwright', 'Wick Charm Options'])).toBe('rule');
    expect(guessKind('Bright Ember', charm, ['Wickwright', 'Class Features'])).toBe('rule'); // "Features" isn't "Feats"
    expect(guessKind('Sharpshooter', 'Prerequisite: Level 4+\nYou can shoot far.')).toBe('rule');
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

describe('feats and Prerequisite lines in a whole book', () => {
  it('keeps stronghold rooms and class options as rules, with their subsections as entries of their own', () => {
    const entries = chunkDocument(HOLDINGS, opts);
    const kinds = Object.fromEntries(entries.map((e) => [e.name, e.kind]));
    expect(kinds).toEqual({ 'Glowworm Gallery': 'rule', 'Gallery Tasks': 'rule', 'Moth Archive': 'rule', 'Bright Ember': 'rule', 'Night Walker': 'feat' });
    expect(entries.find((e) => e.name === 'Night Walker')?.summary).toBe('Prerequisite: Wisdom 13 or higher');
    expect(entries.find((e) => e.name === 'Glowworm Gallery')?.summary).toBe('Lamplight Holdings › Holding Rooms');
  });
});

describe('staleFeatKinds', () => {
  const entry = (n: number, name: string, kind: CompendiumEntry['kind'], text: string, path: string[], summary?: string): CompendiumEntry => ({
    id: `lib:hold:${n}`, sourceId: 'hold', sourceName: 'Lamplight Holdings', kind, name, text, path, ...(summary ? { summary } : {}),
  });
  const room = '_Level 5 Holding Room_\n\n_Prerequisite: None_\n\nThe keeper raises glowworms.\n\n### Gallery Tasks\n\nBrew.';

  it("corrects what an older import stored as feats, with the summary of the kind it is now", () => {
    const fixes = staleFeatKinds([
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

  it('reads only what the entry printed before its subsections, and takes a long entry’s parts along', () => {
    const long = 'x'.repeat(50);
    const path = ['Lamplight Holdings', 'Holding Rooms'];
    const fixes = staleFeatKinds([
      // Its subsection would read as a spell; the import read only the room's own text.
      entry(1, 'Moth Archive', 'feat', `_Level 9 Holding Room_\n\n_Prerequisite: None_\n\n${long}\n\n### Archive Charm\n\nCasting Time: Action`, [...path, 'Moth Archive']),
      entry(2, 'Moth Archive (part 2)', 'feat', long, [...path, 'Moth Archive (part 2)']),
      entry(3, 'Moth Archive (part 3)', 'feat', long, [...path, 'Moth Archive (part 3)']),
      entry(4, 'Night Walker', 'feat', '_Prerequisite: Wisdom 13 or higher_\n\nYou walk at night.', ['Feats', 'Night Walker']),
      entry(5, 'Night Walker (part 2)', 'feat', long, ['Feats', 'Night Walker (part 2)']),
    ]);
    expect(fixes.map((f) => [f.id, f.kind])).toEqual([['lib:hold:1', 'rule'], ['lib:hold:2', 'rule'], ['lib:hold:3', 'rule']]);
  });
});
