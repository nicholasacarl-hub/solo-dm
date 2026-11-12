/**
 * The correction of entry kinds the first chunker guessed wrongly (staleKinds.ts), over fake-indexeddb:
 * imported text only, conservative (a real older-style feat stays a feat), idempotent, refreshes the
 * rules index only when something changed, and never throws. Invented content only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSourceEntries, saveLibrarySource } from '@/storage';
import { resetDatabase } from '@/storage/testData';
import type { CompendiumEntry, LibrarySource } from '@/types';
import { renderHook, waitFor } from '@testing-library/react';
import { correctStaleKinds, useCorrectedKindsVersion } from './staleKinds';

const invalidate = vi.hoisted(() => vi.fn());
vi.mock('../rulesIndexStore', () => ({ invalidateRulesIndex: invalidate }));

const source = (id: string, format: LibrarySource['format'], kind: LibrarySource['kind'] = 'import'): LibrarySource => ({
  id, title: 'Lamplight Holdings', kind, format, enabled: true, entryCount: 4, createdAt: 1, updatedAt: 1,
});
const entry = (sourceId: string, n: number, name: string, kind: CompendiumEntry['kind'], text: string, section: string, summary?: string): CompendiumEntry => ({
  id: `lib:${sourceId}:${n}`, sourceId, sourceName: 'Lamplight Holdings', kind, name, text, path: ['Lamplight Holdings', section, name], ...(summary ? { summary } : {}),
});
/** As the first chunker stored them. */
const stored = (sourceId: string) => [
  entry(sourceId, 1, 'Glowworm Gallery', 'feat', '_Level 5 Holding Room_\n\n_Prerequisite: None_\n\nThe keeper raises glowworms.', 'Holding Rooms', 'Prerequisite: None'),
  entry(sourceId, 2, 'Moth Archive', 'feat', `_Level 9 Holding Room_\n\n_Prerequisite: None_\n\n${'Moths copy maps. '.repeat(5)}`, 'Holding Rooms', 'Prerequisite: None'),
  entry(sourceId, 3, 'Moth Archive (part 2)', 'feat', 'The keeper sells the copies.', 'Holding Rooms', 'Prerequisite: None'),
  // A real older-style feat whose Feats heading the import lost: it stays a feat.
  entry(sourceId, 4, 'Night Walker', 'feat', '_Prerequisite: Wisdom 13 or higher_\n\nYou walk the lamp roads at night.', 'Heroic Talents', 'Prerequisite: Wisdom 13 or higher'),
];
const kinds = async (sourceId: string) => Object.fromEntries((await getSourceEntries(sourceId)).map((e) => [e.name, [e.kind, e.summary]]));

beforeEach(async () => {
  await resetDatabase();
  invalidate.mockClear();
});

describe('correctStaleKinds', () => {
  it('corrects imported text, keeps real feats, and leaves JSON files and built-in sources alone', async () => {
    await saveLibrarySource(source('pdf', 'pdf'), stored('pdf'));
    await saveLibrarySource(source('notes', undefined), stored('notes'));
    await saveLibrarySource(source('file', 'json'), stored('file'));
    await saveLibrarySource(source('builtin', 'markdown', 'builtin'), stored('builtin'));

    expect(await correctStaleKinds()).toBe(6);
    const fixed = {
      'Glowworm Gallery': ['rule', 'Lamplight Holdings › Holding Rooms'],
      'Moth Archive': ['rule', 'Lamplight Holdings › Holding Rooms'],
      'Moth Archive (part 2)': ['rule', 'Lamplight Holdings › Holding Rooms'],
      'Night Walker': ['feat', 'Prerequisite: Wisdom 13 or higher'],
    };
    expect(await kinds('pdf')).toEqual(fixed);
    expect(await kinds('notes')).toEqual(fixed); // an import from before formats were recorded
    const untouched = Object.fromEntries(stored('file').map((e) => [e.name, [e.kind, e.summary]]));
    expect(await kinds('file')).toEqual(untouched);
    expect(await kinds('builtin')).toEqual(untouched);
    expect(invalidate).toHaveBeenCalledTimes(1);

    // Once corrected, nothing more to do (and the index is left alone).
    expect(await correctStaleKinds()).toBe(0);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('corrects what an earlier version took for a magic item, a monster or a spell', async () => {
    const e = (n: number, name: string, kind: CompendiumEntry['kind'], text: string) => entry('dm', n, name, kind, text, 'Treasure');
    await saveLibrarySource(source('dm', 'pdf'), [
      e(1, 'Buying and Selling', 'magic-item', 'A magic weapon or armor of rare quality is almost never for sale.'),
      e(2, 'Building a Creature', 'monster', 'A CR 3 creature has AC 13 and HP 65.'),
      e(3, 'Wand of Little Sparks', 'spell', '_Wand, Common_\n\nYou can cast an Evocation cantrip you know.'),
      e(4, 'Mothsilk Cloak', 'magic-item', '_Wondrous Item, Uncommon_\n\nIt flutters.'),
    ]);
    expect(await correctStaleKinds('dm')).toBe(3);
    expect(Object.fromEntries((await getSourceEntries('dm')).map((x) => [x.name, x.kind]))).toEqual({
      'Buying and Selling': 'rule', 'Building a Creature': 'rule', 'Wand of Little Sparks': 'magic-item', 'Mothsilk Cloak': 'magic-item',
    });
  });

  it('leaves the spells the first release stored from cards without colons alone, and still corrects its index line', async () => {
    const e = (n: number, name: string, text: string) => entry('cards', n, name, 'spell', text, 'Spells');
    await saveLibrarySource(source('cards', 'markdown'), [
      e(1, 'Ember Lash', '| | |\n|---|---|\n| Casting Time | 1 action |\n| Range | 60 feet |\n\nA lash of embers strikes.'),
      e(2, 'Moth Ward', '- **Casting Time** 1 reaction\n- **Range** Self\n\nPale moths swirl around you.'),
      e(3, 'Glow Mote', '*Source: Lantern Lore, p. 12*\n\n| Casting Time | Range | Duration |\n|---|---|---|\n| Bonus Action | 30 feet | 1 minute |\n\nA mote of light.'),
      e(4, 'Spell Index', 'casting time, 215\ncomponents, 216\nduration, 217'),
    ]);
    expect(await correctStaleKinds()).toBe(1);
    expect(Object.fromEntries((await getSourceEntries('cards')).map((x) => [x.name, x.kind]))).toEqual({
      'Ember Lash': 'spell', 'Moth Ward': 'spell', 'Glow Mote': 'spell', 'Spell Index': 'rule',
    });
  });

  it("leaves the spells the first release stored from converters' cards alone, and corrects the index, the glossary, the feat and the item it took for spells", async () => {
    const e = (n: number, name: string, text: string) => entry('conv', n, name, 'spell', text, 'Spells');
    const nb = String.fromCharCode(160);
    await saveLibrarySource(source('conv', 'markdown'), [
      e(1, 'Glow Mote', '**Casting Time** Bonus Action\\\n**Range** 30 feet\\\n**Duration** 1 minute\n\nA mote of light.'),
      e(2, 'Ember Lash', '**Casting Time** 1 action<br>\n**Range** 60 feet<br>\n**Duration** Instantaneous\n\nA lash of embers.'),
      e(3, 'Moth Ward', `**Casting Time**${nb}${nb}1 reaction\n\n**Range**${nb}${nb}Self\n\nPale moths swirl around you.`),
      e(4, 'Spell Index', '| Term | Page |\n|---|---|\n| Cantrip | 201 |\n| Casting Time | 202 |\n| Components | 203 |'),
      e(5, 'Reading a Spell', '| Entry | What it tells you |\n|---|---|\n| Casting Time | How long casting takes |\n| Range | How far the spell reaches |'),
      e(6, 'Lantern Initiate', 'Lantern Initiate\n*Source: Lantern Lore, p. 9*\nOrigin Feat\n\nYou learn Glow Mote:\n\nCasting Time    Bonus Action\nRange    30 feet'),
      e(7, 'Glimmer Wand', 'Glimmer Wand\n*Source: Lantern Lore, p. 40*\n*Wand, rare (requires attunement)*\n\nCasting Time    1 action\nRange    60 feet'),
    ]);
    expect(await correctStaleKinds()).toBe(4);
    expect(Object.fromEntries((await getSourceEntries('conv')).map((x) => [x.name, x.kind]))).toEqual({
      'Glow Mote': 'spell', 'Ember Lash': 'spell', 'Moth Ward': 'spell', 'Spell Index': 'rule', 'Reading a Spell': 'rule', 'Lantern Initiate': 'feat', 'Glimmer Wand': 'magic-item',
    });
  });

  it("leaves alone the spells the first release stored from callouts, bullet glyphs, grids, title rows and separators, and corrects a web grid's list of spells", async () => {
    const e = (n: number, name: string, text: string) => entry('vault', n, name, 'spell', text, 'Spells');
    const pua = String.fromCharCode(0xf0b7);
    await saveLibrarySource(source('vault', 'markdown'), [
      e(1, 'Glow Mote', '> [!spell] Evocation\n> - **Casting Time** Bonus Action\n> - **Range** 30 feet\n\nA mote of light.'),
      e(2, 'Ember Lash', `${pua} Casting Time 1 action\n${pua} Range 60 feet\n\nA lash of embers.`),
      e(3, 'Moth Ward', 'CASTING TIME RANGE\nReaction, which you take when you are hit Self\n\nPale moths swirl around you.'),
      e(4, 'Lamp Wake', '| Lamp Wake | | |\n|---|---|---|\n| Casting Time | Range | Duration |\n| 8 hours | Touch | Until dispelled |\n\nThe lamps wake.'),
      e(5, 'Wick Ward', 'Casting Time · 1 action\nRange · Self\n\nA ward of wicks.'),
      e(6, 'Wickwright Spells', ['Level', 'Name', 'Casting Time', 'Duration', 'Cantrip', 'Ember Lash', '1 Action', 'Instantaneous', '1st', 'Glow Mote', '1 Bonus Action', '1 Minute'].join('\n')),
    ]);
    expect(await correctStaleKinds()).toBe(1);
    expect(Object.fromEntries((await getSourceEntries('vault')).map((x) => [x.name, x.kind]))).toEqual({
      'Glow Mote': 'spell', 'Ember Lash': 'spell', 'Moth Ward': 'spell', 'Lamp Wake': 'spell', 'Wick Ward': 'spell', 'Wickwright Spells': 'rule',
    });
  });

  it("leaves alone what the first release stored from pandoc's tables and spans, fuller label rows, space references, tags, values above labels and labelled item type lines, and still corrects an index", async () => {
    const e = (n: number, name: string, kind: CompendiumEntry['kind'], text: string) => entry('word', n, name, kind, text, 'Spells');
    await saveLibrarySource(source('word', 'markdown'), [
      // `pandoc lantern.docx -o lantern.md`: a card table as a multiline table, and as a grid table.
      e(1, 'Ember Lash', 'spell', '-------------------------------------------------\n  Casting Time   Range     Duration\n  -------------- --------- ---------------\n  1 action       60 feet   Instantaneous\n\n  -------------------------------------------------\n\nA lash of embers.'),
      e(2, 'Glow Mote', 'spell', '+--------------+---------+\n| Casting Time | Range   |\n+==============+=========+\n| Bonus Action | 30 feet |\n+--------------+---------+\n\nA mote of light.'),
      // A notebook's Markdown export: a title row over a label row with a School column.
      e(3, 'Moth Ward', 'spell', '| Moth Ward | | | | |\n| :---- | :---- | :---- | :---- | :---- |\n| Casting Time | Range | Components | Duration | School |\n| Reaction, which you take when a creature hits you | Self | V, S | 1 round | Abjuration |\n\nPale moths swirl around you.'),
      e(4, 'Wick Ward', 'spell', '**Casting Time**&thinsp;1 action\n**Range**&thinsp;Self\n\nA ward of wicks.'),
      e(5, 'Spark Veil', 'spell', '**Casting Time** (R) 10 minutes\n**Range** Touch\n\nA veil of sparks.'),
      e(6, 'Ash Step', 'spell', 'Bonus Action\nCasting Time\nSelf\nRange\n\nYou step through ash.'),
      e(7, 'Glimmer Cloak', 'magic-item', 'Item Type: Wondrous Item / Rarity: Rare (Requires Attunement)\n\nYou glimmer.'),
      e(8, 'Spell Index', 'spell', '202\nCasting Time\n204\nRange'),
    ]);
    expect(await correctStaleKinds()).toBe(1);
    expect(Object.fromEntries((await getSourceEntries('word')).map((x) => [x.name, x.kind]))).toEqual({
      'Ember Lash': 'spell', 'Glow Mote': 'spell', 'Moth Ward': 'spell', 'Wick Ward': 'spell', 'Spark Veil': 'spell', 'Ash Step': 'spell', 'Glimmer Cloak': 'magic-item', 'Spell Index': 'rule',
    });
  });

  it('tells an open book page when it corrected kinds (it reads its entries again), and only then', async () => {
    await saveLibrarySource(source('hold', 'pdf'), stored('hold'));
    const { result } = renderHook(() => useCorrectedKindsVersion());
    const before = result.current;
    await correctStaleKinds();
    await waitFor(() => expect(result.current).toBe(before + 1));
    await correctStaleKinds();
    expect(result.current).toBe(before + 1);
  });

  it('corrects one book when asked to', async () => {
    await saveLibrarySource(source('pdf', 'pdf'), stored('pdf'));
    await saveLibrarySource(source('other', 'pdf'), stored('other'));
    expect(await correctStaleKinds('pdf')).toBe(3);
    expect((await kinds('other'))['Glowworm Gallery']).toEqual(['feat', 'Prerequisite: None']);
  });

  it('keeps the kinds of a book whose old entries it cannot read, and never throws', async () => {
    const broken = { ...stored('odd')[0], text: null } as unknown as CompendiumEntry;
    await saveLibrarySource(source('odd', 'pdf'), [broken]);
    await saveLibrarySource(source('pdf', 'pdf'), stored('pdf'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await correctStaleKinds()).toBe(3);
    expect((await getSourceEntries('odd'))[0].kind).toBe('feat');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
