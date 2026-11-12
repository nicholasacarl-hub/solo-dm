import { describe, expect, it } from 'vitest';
import { chunkDocument } from '@/data/chunk';
import { nameKey } from '@/lib/id';
import {
  GLOAMWOOD_CANDIDATES,
  GLOAMWOOD_MD,
  GLOAMWOOD_RULE_ENTRIES,
  GLOAMWOOD_SPELL_LISTS,
  GLOAMWOOD_TITLE,
  gloamwoodEntries,
  gloamwoodEntryId,
} from '@/test/structuredFixtures';
import type { CompendiumEntry } from '@/types';
import { flatten } from './parse/flatten';
import { candidateFor, markCandidate, readingOrder, segment, type SegmentContext } from './segment';

/** A few SRD spell and class names, as the rules index would supply them (nameKeys). */
const CTX: SegmentContext = {
  knownSpellNames: new Set(
    ['Burning Hands', 'Continual Flame', 'Daylight', 'Detect Magic', 'Faerie Fire', 'Fireball', 'Fire Shield', 'Flaming Sphere', 'Light', 'Mending', 'Sleep', 'Darkness'].map(nameKey),
  ),
  knownClassNames: new Set(['Barbarian', 'Cleric', 'Fighter', 'Sorcerer', 'Wizard'].map(nameKey)),
};

const md = gloamwoodEntries();
const mixed = gloamwoodEntries('gloam', 'mixed');
const nameOf = new Map(md.map((e) => [e.id, e.name]));

/** The fixture's shape of a candidate: kind, name, span and entry names (block titles in order). */
const shape = (entries: readonly CompendiumEntry[]) =>
  segment(entries, CTX).candidates.map((c) => ({ kind: c.kind, name: c.name, span: c.span, entries: c.entryIds.map((id) => nameOf.get(id)) }));

const entry = (n: number, name: string, text: string, path?: string[], kind: CompendiumEntry['kind'] = 'rule'): CompendiumEntry => ({
  id: `lib:t:${n}`,
  sourceId: 't',
  sourceName: 'Test Book',
  kind,
  name,
  text,
  ...(path ? { path } : {}),
});

describe('segment: the Gloamwood Almanac', () => {
  it('detects every candidate with its kind, name, span and entries, in reading order', () => {
    const expected = GLOAMWOOD_CANDIDATES.map((c) => ({ kind: c.kind, name: c.name, span: c.span, entries: [...c.entries] }));
    expect(shape(md)).toEqual(expected);
    expect(shape(mixed)).toEqual(expected);
  });

  it('leaves chapter introductions and lore (The Long Dusk) as rules text', () => {
    const used = new Set(segment(md, CTX).candidates.flatMap((c) => c.entryIds));
    for (const name of GLOAMWOOD_RULE_ENTRIES) expect(used.has(gloamwoodEntryId(name)), name).toBe(false);
  });

  it('finds subclass parents: "Fighter Subclass:", the class chapter, a heading naming a class', () => {
    const { candidates } = segment(md, CTX);
    const parent = (name: string) => candidates.find((c) => c.name === name)?.parentClassName;
    expect(parent('Ember Warden')).toBe('Fighter');
    expect(parent('Order of the Long Wick')).toBe('Wickwright');
    expect(parent('Dusk Domain')).toBe('Cleric');
    const order = candidates.find((c) => c.name === 'Order of the Long Wick')!;
    const wickwright = candidates.find((c) => c.name === 'Wickwright')!;
    expect(wickwright.entryIds).not.toContain(order.entryIds[0]);
  });

  it('makes the gear table one table candidate and the gear entry an entry candidate', () => {
    const items = segment(md, CTX).candidates.filter((c) => c.kind === 'item');
    expect(items.map((c) => [c.name, c.span, c.table])).toEqual([
      ['Gloamwood Arms', 'table', { index: 0, firstRow: 0, rows: 1 }],
      ['Wick Lantern', 'entry', undefined],
    ]);
  });

  it('detects the same kinds in a fully flattened book, except the gear table (PDF tables are lost)', () => {
    const flat = chunkDocument(flatten(GLOAMWOOD_MD), { sourceId: 'gloam', sourceName: GLOAMWOOD_TITLE });
    expect(flat.map((e) => e.name)).toEqual(md.map((e) => e.name));
    const names = (entries: readonly CompendiumEntry[]) => segment(entries, CTX).candidates.map((c) => `${c.kind}:${c.name}`);
    expect(names(flat)).toEqual(names(md).filter((n) => n !== 'item:Gloamwood Arms'));
  });

  it('reads the Wickwright Spell List as a hint, in every dialect', () => {
    const expected = GLOAMWOOD_SPELL_LISTS.map((l) => ({ className: l.className, spellNames: [...l.spellNames], entryId: gloamwoodEntryId(l.entryName) }));
    expect(segment(md, CTX).spellLists).toEqual(expected);
    expect(segment(mixed, CTX).spellLists).toEqual(expected);
  });

  it('gives each candidate numbered blocks, a stable key and the hash of its texts', () => {
    const a = segment(md, CTX).candidates;
    const b = segment([...md].reverse(), CTX).candidates;
    expect(b.map((c) => c.key)).toEqual(a.map((c) => c.key));
    const drake = a.find((c) => c.name === 'Glimmerwing Drake')!;
    expect(drake.key).toBe(`monster:glimmerwing-drake:${gloamwoodEntryId('Glimmerwing Drake')}`);
    const ember = a.find((c) => c.name === 'Ember Warden')!;
    expect(ember.blocks.map((x) => [x.id, x.title])).toEqual([
      ['B1', 'Fighter Subclass: Ember Warden'],
      ['B2', 'Level 3: Ember Ward'],
      ['B3', 'Level 3: Kindled Strikes'],
      ['B4', 'Level 7: Smoke Step'],
    ]);
    expect(ember.blocks[1].paragraphs).toHaveLength(2);
    expect(ember.reason).toBeTruthy();
    expect(new Set(a.map((c) => c.textHash)).size).toBe(a.length);
  });

  it('keeps the document’s headings in block paths (requests leave its top level out: src/dm/extract/blocks.ts)', () => {
    for (const c of segment(md, CTX).candidates) for (const b of c.blocks) expect(b.path, b.title).not.toContain(GLOAMWOOD_TITLE);
    const lore = segment([entry(1, 'Owlbear Den', '**Armor Class** 13\n\n**Hit Points** 59 (7d10 + 21)\n\n**Challenge** 3 (700 XP)', ['Test Book', 'Owlbear Den'])], CTX);
    expect(lore.candidates[0].blocks[0].path).toEqual(['Test Book', 'Owlbear Den']);
  });
});

describe('segment: structure rules', () => {
  it('reads entries in numeric order (…:10 after …:2) and joins "(part N)" chains into one block', () => {
    const entries = [
      entry(10, 'Last', 'Ten.'),
      entry(2, 'Bramble Shade (part 2)', 'The rest of the stat block.', ['Monsters', 'Bramble Shade (part 2)']),
      entry(1, 'Bramble Shade', '**Armor Class** 13\n\n**Hit Points** 22 (4d8 + 4)\n\n**Challenge** 1 (200 XP)', ['Monsters', 'Bramble Shade'], 'monster'),
    ];
    expect(readingOrder(entries).map((e) => e.id)).toEqual(['lib:t:1', 'lib:t:2', 'lib:t:10']);
    const [shade] = segment(entries, CTX).candidates;
    expect(shade.blocks).toHaveLength(1);
    expect(shade.blocks[0]).toMatchObject({ id: 'B1', title: 'Bramble Shade', entryIds: ['lib:t:1', 'lib:t:2'] });
    expect(shade.blocks[0].paragraphs.at(-1)).toBe('The rest of the stat block.');
  });

  it('does not chain a part under another parent', () => {
    const entries = [
      entry(1, 'Rules', 'A.', ['Chapter', 'Rules']),
      entry(2, 'Rules (part 2)', 'B.', ['Other', 'Rules (part 2)']),
      entry(3, 'Wand of Sparks', '_Wand, Rare_\n\nIt sparks.', ['Other', 'Wand of Sparks'], 'magic-item'),
    ];
    expect(segment(entries, CTX).candidates.map((c) => c.entryIds)).toEqual([['lib:t:3']]);
  });

  it('does not swallow a chapter of classes into one class', () => {
    const traits = (cls: string) => `| Primary Ability | Strength |\n|---|---|\n| Hit Point Die | D10 per ${cls} level |\n| Saving Throw Proficiencies | Strength and Constitution |`;
    const table = '| Level | Proficiency Bonus | Class Features |\n|---|---|---|\n| 1 | +2 | Rage |';
    const entries = [
      entry(1, 'Classes', 'The classes of this book.'),
      entry(2, 'Brawler', 'Brawlers fight.', ['Classes', 'Brawler']),
      entry(3, 'Core Brawler Traits', traits('Brawler'), ['Classes', 'Brawler', 'Core Brawler Traits']),
      entry(4, 'Brawler Class Features', table, ['Classes', 'Brawler', 'Brawler Class Features']),
      entry(5, 'Level 1: Haymaker', 'You punch.', ['Classes', 'Brawler', 'Brawler Class Features', 'Level 1: Haymaker']),
      entry(6, 'Thornwarden', 'Thornwardens guard.', ['Classes', 'Thornwarden']),
      entry(7, 'Core Thornwarden Traits', traits('Thornwarden'), ['Classes', 'Thornwarden', 'Core Thornwarden Traits']),
      entry(8, 'Thornwarden Class Features', table, ['Classes', 'Thornwarden', 'Thornwarden Class Features']),
      entry(9, 'Thornwarden Subclasses', 'Choose one.', ['Classes', 'Thornwarden', 'Thornwarden Subclasses']),
      entry(10, 'Circle of Briars', 'Briar druids.', ['Classes', 'Thornwarden', 'Thornwarden Subclasses', 'Circle of Briars']),
      entry(11, 'Level 3: Thorn Wall', 'Walls.', ['Classes', 'Thornwarden', 'Thornwarden Subclasses', 'Circle of Briars', 'Level 3: Thorn Wall']),
      entry(12, 'Briarward Way', 'Another.', ['Classes', 'Thornwarden', 'Thornwarden Subclasses', 'Briarward Way']),
      entry(13, 'Level 3: Ward', 'Wards.', ['Classes', 'Thornwarden', 'Thornwarden Subclasses', 'Briarward Way', 'Level 3: Ward']),
    ];
    const found = segment(entries, CTX).candidates.map((c) => [c.kind, c.name, c.parentClassName ?? '', c.entryIds.length]);
    expect(found).toEqual([
      ['class', 'Brawler', '', 4],
      ['class', 'Thornwarden', '', 4],
      ['subclass', 'Circle of Briars', 'Thornwarden', 2],
      ['subclass', 'Briarward Way', 'Thornwarden', 2],
    ]);
  });

  it('keeps an entry stored as a spell inside a section its own candidate', () => {
    const entries = [
      entry(1, 'Mosskin', '- **Creature Type:** Humanoid\n- **Size:** Small\n- **Speed:** 30 feet', ['Peoples', 'Mosskin']),
      entry(2, 'Moss Bolt', '_Level 1 Evocation (Wizard)_\n\n- **Casting Time:** Action', ['Peoples', 'Mosskin', 'Moss Bolt'], 'spell'),
      entry(3, 'Mosskin Lore', 'Old tales.', ['Peoples', 'Mosskin', 'Mosskin Lore']),
    ];
    expect(segment(entries, CTX).candidates.map((c) => [c.kind, c.name, c.entryIds])).toEqual([
      ['species', 'Mosskin', ['lib:t:1', 'lib:t:3']],
      ['spell', 'Moss Bolt', ['lib:t:2']],
    ]);
  });

  it('takes the flattened feature siblings of an older-format subclass along', () => {
    const entries = [
      entry(1, 'Druid Circles', 'Circles.', ['Druid Circles']),
      entry(2, 'Circle of Ash', 'Ash druids.', ['Druid Circles', 'Circle of Ash']),
      entry(3, 'Ash Walk', 'At 2nd level, you walk on ash.', ['Druid Circles', 'Ash Walk']),
      entry(4, 'Cinder Heart', 'Starting at 6th level, you burn.', ['Druid Circles', 'Cinder Heart']),
      entry(5, 'Circle of Frost', 'Frost druids.', ['Druid Circles', 'Circle of Frost']),
      entry(6, 'Rime', 'At 2nd level, you freeze.', ['Druid Circles', 'Rime']),
    ];
    const known = { ...CTX, knownClassNames: new Set(['druid']) };
    expect(segment(entries, known).candidates.map((c) => [c.name, c.parentClassName, c.entryIds.length])).toEqual([
      ['Circle of Ash', 'Druid', 3],
      ['Circle of Frost', 'Druid', 2],
    ]);
  });

  it('stops taking siblings at a class option that opens with a Prerequisite line', () => {
    const entries = [
      entry(1, 'Druid Circles', 'Circles.', ['Druid Circles']),
      entry(2, 'Circle of Ash', 'Ash druids.', ['Druid Circles', 'Circle of Ash']),
      entry(3, 'Ash Walk', 'At 2nd level, you walk on ash.', ['Druid Circles', 'Ash Walk']),
      // Class options stored as rules (no longer taken for feats): not part of the circle.
      entry(4, 'Mossy Lantern', 'Prerequisite: Level 5+ Druid\n\nYour lantern grows moss.', ['Druid Circles', 'Mossy Lantern'], 'rule'),
      entry(5, 'Ashen Wick', 'Prerequisite: Level 9+ Druid\n\nYour wick burns grey.', ['Druid Circles', 'Ashen Wick'], 'rule'),
    ];
    const known = { ...CTX, knownClassNames: new Set(['druid']) };
    expect(segment(entries, known).candidates.map((c) => [c.name, c.entryIds.length])).toEqual([['Circle of Ash', 2]]);
  });

  it('splits a gear table over 60 rows into table candidates of at most 60 rows', () => {
    const rows = Array.from({ length: 130 }, (_, i) => `| Blade ${i + 1} | 1d6 Slashing | Light | Nick | 2 lb. | 5 GP |`);
    const text = ['| Martial Melee Weapons | Damage | Properties | Mastery | Weight | Cost |', '|---|---|---|---|---|---|', ...rows].join('\n');
    const tables = segment([entry(1, 'Blades', text, ['Equipment', 'Blades'])], CTX).candidates;
    expect(tables.map((c) => [c.name, c.table])).toEqual([
      ['Blades (rows 1–60)', { index: 0, firstRow: 0, rows: 60 }],
      ['Blades (rows 61–120)', { index: 0, firstRow: 60, rows: 60 }],
      ['Blades (rows 121–130)', { index: 0, firstRow: 120, rows: 10 }],
    ]);
    expect(new Set(tables.map((c) => c.key)).size).toBe(3);
  });
});

describe('segment: entries an older import stored whole', () => {
  const none: SegmentContext = { knownSpellNames: new Set(), knownClassNames: new Set() };
  // An invented room the first chunker stored as one feat entry, its subsections (a creature among them) inside.
  const room: CompendiumEntry = {
    id: 'lib:pad:1', sourceId: 'pad', sourceName: 'Lamplight Holdings', kind: 'rule', name: 'Moth Paddock', path: ['Lamplight Holdings', 'Holding Rooms', 'Moth Paddock'],
    text: '_Level 5 Holding Room_\n\n_Prerequisite: None_\n\n_Room: Roomy_\n\nMoths graze here.\n\n### Paddock Moth\n\n_Tiny Beast, Unaligned_\n\n**AC** 12\n\n**HP** 3 (1d4 + 1)\n\n**CR** 0 (XP 10)\n\n### Paddock Chores\n\nSweep the dust.',
  };

  it("guesses from the entry's own text, so a stat block inside it doesn't make the room a monster", () => {
    expect(segment([room], none).candidates).toEqual([]);
  });

  it('still reads a stored rule whose own text is a stat block as a monster', () => {
    const drake = { ...room, id: 'lib:pad:2', name: 'Lamp Drake', path: ['Lamplight Holdings', 'Lamp Drake'], text: '_Small Dragon_\n\n**AC** 14\n\n**HP** 22 (4d6 + 8)\n\n**CR** 1 (XP 200)\n\n### Actions\n\nBite.' };
    expect(segment([drake], none).candidates.map((c) => [c.kind, c.name])).toEqual([['monster', 'Lamp Drake']]);
  });
});

describe('markCandidate and candidateFor', () => {
  it('marks entries as a kind ("Structure as…"), taking a section’s subtree along', () => {
    const marked = markCandidate(md, [gloamwoodEntryId('Mothkin')], 'species')!;
    expect(marked).toMatchObject({ kind: 'species', name: 'Mothkin', span: 'section', reason: 'Marked by you' });
    expect(marked.entryIds).toEqual([gloamwoodEntryId('Mothkin'), gloamwoodEntryId('Mothkin Lineages')]);
    const lore = markCandidate(md, [gloamwoodEntryId('The Long Dusk')], 'feat')!;
    expect(lore).toMatchObject({ kind: 'feat', span: 'entry', entryIds: [gloamwoodEntryId('The Long Dusk')] });
    expect(markCandidate(md, ['lib:gloam:999'], 'feat')).toBeNull();
  });

  it('rebuilds the candidate behind a record, a gear table and its rows included', () => {
    const byId = new Map(md.map((e) => [e.id, e]));
    const { candidates } = segment(md, CTX);
    const ember = candidates.find((c) => c.name === 'Ember Warden')!;
    const rebuilt = candidateFor({ ...ember, candidateKey: ember.key }, byId, { parentClassName: 'Fighter' })!;
    expect(rebuilt.blocks).toEqual(ember.blocks);
    expect(rebuilt.key).toBe(ember.key);
    const arms = candidates.find((c) => c.name === 'Gloamwood Arms')!;
    expect(candidateFor({ ...arms, candidateKey: arms.key }, byId)?.table).toEqual(arms.table);
    const row = candidateFor({ kind: 'item', name: 'Hookstaff', span: 'row', rowIndex: 0, entryIds: arms.entryIds, candidateKey: 'item:hookstaff:x:r0' }, byId, { tableName: 'Gloamwood Arms' });
    expect(row).toMatchObject({ span: 'row', rowIndex: 0, name: 'Hookstaff', table: arms.table });
    expect(candidateFor({ ...ember, entryIds: ['lib:gloam:999'], candidateKey: ember.key }, byId)).toBeNull();
  });
});
