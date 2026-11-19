/**
 * One option per name, end to end: the real @/data and @/storage over fake-indexeddb and the real SRD
 * JSON (a stubbed fetch). The invented Gloamwood Almanac (a 2024 book) is saved with two of its accepted
 * records renamed to SRD names: its class as "Fighter" and a spell as "Light". The builder's lists offer
 * the book's alone; the SRD's are still there by id and under the SRD filter. Function level, no clicking.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import builderRaw from '../../../public/srd/builder.json?raw';
import compendiumRaw from '../../../public/srd/compendium.json?raw';
import { getRulesIndex, loadBuilderData } from '@/data';
import { rulesClassFor } from '@/engine/classData';
import { resetRulesIndex } from '@/data/rulesIndexStore';
import { resetSrdCache } from '@/data/srd';
import { saveLibrarySourceWithRecords } from '@/storage';
import { resetDatabase } from '@/storage/testData';
import { GLOAMWOOD_SOURCE_ID, gloamwoodEntries, gloamwoodRecords, gloamwoodSource } from '@/test/structuredFixtures';
import { SRD_SOURCE_ID, type SpellData, type StructuredRecord } from '@/types';
import { fillStep, letDmBuildAll } from '@/ui/builder/autofill';
import { buildCharacter, emptyDraft, filtered, firstIncompleteStep, spellInfo, spellsForClass, subclassesOf, visibleSpells, withoutReplacedSrd } from '@/ui/builder/logic';

const BOOK_FIGHTER = 'lib:gloam:class:wickwright';
/** A fixed sequence per seed (Park–Miller, past its first few values, which stay near 0 for small seeds). */
function seeded(seed: number) {
  let state = seed;
  const next = () => (state = (state * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 4; i++) next();
  return { next };
}

beforeAll(async () => {
  await resetDatabase();
  resetSrdCache();
  resetRulesIndex();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => new Response(String(url).endsWith('compendium.json') ? compendiumRaw : builderRaw, { status: 200 })),
  );
  const rename = (r: StructuredRecord): StructuredRecord => {
    if (r.name === 'Wickwright') return { ...r, name: 'Fighter' };
    if (r.name === 'Cinder Mote') return { ...r, name: 'Light', data: { ...(r.data as SpellData), classes: ['Wizard', 'Wickwright'] } };
    return r;
  };
  const records = gloamwoodRecords(GLOAMWOOD_SOURCE_ID, { status: 'accepted' }).map(rename);
  await saveLibrarySourceWithRecords(gloamwoodSource(), gloamwoodEntries(), records);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('a 2024 book’s options in place of the SRD’s of their names (end to end)', () => {
  it('lists the book’s Fighter alone under All; the SRD Fighter stays by id and under the SRD filter', async () => {
    const data = await loadBuilderData();
    const fighters = (list: readonly { id: string; name: string }[]) => list.filter((c) => c.name === 'Fighter').map((c) => c.id);
    expect(fighters(data.classes)).toEqual(['srd:class:fighter', BOOK_FIGHTER]);
    expect(fighters(filtered(data.classes, null))).toEqual([BOOK_FIGHTER]);
    expect(fighters(filtered(data.classes, null, 'srd:class:fighter'))).toEqual(['srd:class:fighter', BOOK_FIGHTER]);
    expect(fighters(filtered(data.classes, SRD_SOURCE_ID))).toEqual(['srd:class:fighter']);
    // The book's Fighter offers its own subclass, then the SRD Fighter's (the SRD's and the one attached to it).
    const book = data.classes.find((c) => c.id === BOOK_FIGHTER)!;
    expect(withoutReplacedSrd(subclassesOf(book)).map((s) => s.name)).toEqual(['Order of the Long Wick', 'Champion', 'Ember Warden']);
    // A hero who kept the SRD Fighter (made before the book) meets the book's subclasses at level-up too.
    const srd = data.classes.find((c) => c.id === 'srd:class:fighter')!;
    expect(withoutReplacedSrd(subclassesOf(srd)).map((s) => s.name)).toEqual(['Champion', 'Ember Warden', 'Order of the Long Wick']);
    // Each class keeps its own: a name lookup prefers them (options/resolve.ts).
    expect([book.subclasses.map((s) => s.name), srd.subclasses.map((s) => s.name)]).toEqual([['Order of the Long Wick'], ['Champion', 'Ember Warden']]);
  });

  it("a hero built on the book's 2024 Fighter records its edition, and plays by the SRD Fighter's rules", async () => {
    const data = await loadBuilderData();
    const index = await getRulesIndex();
    const ctx = { data, spells: index.list({ kind: 'spell' }).map(spellInfo) };
    const draft = letDmBuildAll({ ...emptyDraft(), classId: BOOK_FIGHTER }, ctx, seeded(5));
    const hero = buildCharacter(draft, ctx, { campaignId: 'c' });
    expect(hero.classes[0]).toMatchObject({ classId: BOOK_FIGHTER, name: 'Fighter', ref: { entryId: BOOK_FIGHTER, kind: 'class', format: '2024' } });
    expect(rulesClassFor(hero.classes[0])?.id).toBe('srd:class:fighter');
  });

  it('"Let the DM build the rest" completes a hero of every class with the filter on the book (too few there: from All)', async () => {
    const data = await loadBuilderData();
    const index = await getRulesIndex();
    const ctx = { data, spells: index.list({ kind: 'spell' }).map(spellInfo) };
    for (const cls of data.classes) {
      // A Human too: Versatile's Origin feat can't be the background's, and the book has one Origin feat.
      for (const [seed, speciesId] of [[1, null], [7, null], [42, 'srd:species:human']] as const) {
        const draft = letDmBuildAll({ ...emptyDraft(), classId: cls.id, speciesId, sourceFilter: GLOAMWOOD_SOURCE_ID }, ctx, seeded(seed));
        expect({ cls: cls.name, seed, step: firstIncompleteStep(draft, ctx) }).toEqual({ cls: cls.name, seed, step: null });
      }
    }
    // A filter with nothing to choose from: a hero of any class still gets everything (a Fighting Style too).
    for (const cls of [undefined, ...data.classes]) {
      const draft = letDmBuildAll({ ...emptyDraft(), classId: cls?.id ?? null, sourceFilter: 'a-book-with-no-options' }, ctx, seeded(3));
      expect({ cls: cls?.name, step: firstIncompleteStep(draft, ctx) }).toEqual({ cls: cls?.name, step: null });
    }
  });

  it("gives a background's Magic Initiate a list other than the species' (SRD 5.2.1: another list each time)", async () => {
    const data = await loadBuilderData();
    const index = await getRulesIndex();
    const ctx = { data, spells: index.list({ kind: 'spell' }).map(spellInfo) };
    const ferry = data.backgrounds.find((b) => b.name === 'Ferry Hand' && b.featChoice);
    const human = { ...emptyDraft(), speciesId: 'srd:species:human', speciesFeat: 'srd:feat:magic-initiate', speciesFeatList: 'Wizard' };
    for (const value of [0, 0.4, 0.8, 0.99]) {
      const draft = fillStep('background', { ...human, backgroundId: ferry?.id ?? null, backgroundFeat: 'srd:feat:magic-initiate' }, ctx, { next: () => value });
      expect(draft.backgroundFeatList).toMatch(/^(Cleric|Druid)$/);
    }
  });

  it('lists the book’s accepted Light alone on the Wizard’s list; the SRD filter lists the SRD’s', async () => {
    const index = await getRulesIndex();
    const wizard = spellsForClass(index.list({ kind: 'spell' }).map(spellInfo), 'Wizard', 0);
    const lights = (list: readonly { name: string; entry: { sourceId: string } }[]) => list.filter((s) => s.name === 'Light').map((s) => s.entry.sourceId);
    expect(lights(wizard)).toEqual([SRD_SOURCE_ID, GLOAMWOOD_SOURCE_ID]);
    expect(lights(visibleSpells(wizard, null))).toEqual([GLOAMWOOD_SOURCE_ID]);
    expect(lights(visibleSpells(wizard, SRD_SOURCE_ID))).toEqual([SRD_SOURCE_ID]);
    // Every SRD Wizard cantrip is still listed, once (Light as the book's).
    const names = visibleSpells(wizard, null).map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual([...new Set(wizard.map((s) => s.name))].sort());
  });
});
