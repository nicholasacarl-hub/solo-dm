import { describe, expect, it } from 'vitest';
import { nameKey } from '@/lib/id';
import { importedPlaceholder } from '@/lib/importedContent';
import { sampleCharacter } from '@/test/fixtures';
import {
  EXPECTED_MERGED,
  GLOAMWOOD_SRD_SUBSET,
  GLOAMWOOD_TITLE,
  gloamwoodEntries,
  gloamwoodSource,
} from '@/test/structuredFixtures';
import type { BuilderData, Character, CompendiumEntry, Feature, LibrarySource, SpeciesTrait } from '@/types';
import { restoreImportedText, type LibraryLookup } from './restore';

const placeholder = importedPlaceholder(GLOAMWOOD_TITLE);

function lookupOf(builder: BuilderData, sources: LibrarySource[] = [], entries: CompendiumEntry[] = []): LibraryLookup {
  const byTitle = new Map<string, LibrarySource[]>();
  for (const s of sources) byTitle.set(nameKey(s.title), [...(byTitle.get(nameKey(s.title)) ?? []), s]);
  return {
    entriesById: new Map(entries.map((e) => [e.id, e])),
    sourcesByFingerprint: new Map(sources.filter((s) => s.fingerprint).map((s) => [s.fingerprint as string, s])),
    sourcesByTitle: byTitle,
    builder,
  };
}

// The book's copied texts, as the builder and level-up copy them (EXPECTED_MERGED holds the defs and refs).
const fighter = EXPECTED_MERGED.classes.find((c) => c.id === 'srd:class:fighter');
const ember = fighter?.subclasses.find((s) => s.name === 'Ember Warden');
const mothkin = EXPECTED_MERGED.species.find((s) => s.name === 'Mothkin');
const ferry = EXPECTED_MERGED.backgrounds.find((b) => b.name === 'Ferry Hand');
const mothsGrace = EXPECTED_MERGED.feats.find((f) => f.name === "Moth's Grace");
if (!ember || !mothkin || !ferry || !mothsGrace) throw new Error('fixture changed');
const emberWard = ember.features[0];
const duskSight = mothkin.traits[0];
const ashwing = mothkin.lineages?.[0] as SpeciesTrait & { ref: NonNullable<SpeciesTrait['ref']> };
const ferrymansRight = ferry.legacyFeature as SpeciesTrait;

const copied: Feature[] = [
  { id: 'f1', name: 'Ember Ward', source: 'subclass', sourceName: 'Ember Warden 3', description: emberWard.description, ref: emberWard.ref },
  { id: 'f2', name: 'Dusk Sight', source: 'species', description: duskSight.description, ref: duskSight.ref },
  { id: 'f3', name: 'Ashwing', source: 'species', description: ashwing.description, ref: ashwing.ref },
  { id: 'f4', name: "Moth's Grace", source: 'feat', description: mothsGrace.description, ref: mothsGrace.ref },
  { id: 'f5', name: "Ferryman's Right", source: 'background', description: ferrymansRight.description, ref: ferrymansRight.ref },
];
const originals = new Map(copied.map((f) => [f.id, f.description]));

/** The character as another device has it after a pull: placeholders, refs marked redacted. */
function pulled(): Character {
  const base = sampleCharacter();
  const left = copied.map((f) => ({ ...f, description: placeholder, ref: f.ref ? { ...f.ref, redacted: true as const } : undefined }));
  return { ...base, features: [...base.features, ...left] };
}
const restoredTexts = (c: Character) => c.features.filter((f) => originals.has(f.id)).map((f) => [f.id, f.description]);

describe('restoreImportedText (spec §7.4)', () => {
  it('restores by option id from this device’s merged data, and drops `redacted`', () => {
    const { character, report } = restoreImportedText(pulled(), lookupOf(EXPECTED_MERGED));
    expect(report).toEqual({ restored: 5, differs: 0, missing: [] });
    expect(restoredTexts(character)).toEqual([...originals]);
    for (const f of character.features.filter((x) => originals.has(x.id))) expect(f.ref?.redacted).toBeUndefined();
  });

  it('restores by fingerprint and location from a book imported but never structured', () => {
    // Imported again under a new source id: same entries, same fingerprint, no records (the SRD alone in the builder).
    const copy = gloamwoodSource('copy');
    expect(copy.fingerprint).toBe(gloamwoodSource().fingerprint);
    const { character, report } = restoreImportedText(pulled(), lookupOf(GLOAMWOOD_SRD_SUBSET, [copy], gloamwoodEntries('copy')));
    expect(report).toEqual({ restored: 5, differs: 0, missing: [] });
    // The table-row lineage too: its text is rebuilt from the row's cells, as the merge builds it.
    expect(restoredTexts(character)).toEqual([...originals]);
  });

  it('never restores at a location whose words changed (the fingerprint must match)', () => {
    const copy = gloamwoodSource('copy');
    const entries = gloamwoodEntries('copy').map((e) => ({ ...e, text: e.text.replace('banked heat', 'banked warmth') }));
    const { report } = restoreImportedText(pulled(), lookupOf(GLOAMWOOD_SRD_SUBSET, [copy], entries));
    expect(report.restored).toBe(4);
    expect(report.missing).toEqual([{ book: GLOAMWOOD_TITLE, entryName: 'Ember Warden', part: 'Ember Ward' }]);
  });

  it('restores by title, kind, name and part from another copy of the book, counting differences', () => {
    const other = { ...gloamwoodSource('other'), fingerprint: 'not-the-same-book' };
    const builder = structuredClone(EXPECTED_MERGED) as BuilderData;
    for (const cls of builder.classes) {
      for (const sub of cls.subclasses) {
        if (sub.source) sub.source = { ...sub.source, sourceId: 'other' };
        if (sub.name === 'Ember Warden') {
          sub.id = 'lib:other:subclass:ember-warden';
          sub.features[0] = { ...sub.features[0], description: `${sub.features[0].description} (Second printing.)` };
        }
      }
    }
    const pulledEmber = { ...pulled(), features: pulled().features.filter((f) => f.id === 'f1') };
    const { character, report } = restoreImportedText(pulledEmber, lookupOf(builder, [other]));
    expect(report).toEqual({ restored: 1, differs: 1, missing: [] });
    expect(character.features[0].description).toBe(`${emberWard.description} (Second printing.)`);
    // Ids in refs are never rewritten.
    expect(character.features[0].ref).toMatchObject({ sourceId: 'gloam', entryId: 'lib:gloam:subclass:ember-warden' });
  });

  it('restores by a unique text match anywhere, and not when two options share it', () => {
    const builder = structuredClone(EXPECTED_MERGED) as BuilderData;
    const feat = builder.feats.find((f) => f.name === "Moth's Grace");
    if (!feat?.source) throw new Error('fixture changed');
    feat.id = 'lib:renamed:35';
    feat.source = { ...feat.source, sourceId: 'renamed', title: 'Gloamwood (old copy)' };
    const one = { ...pulled(), features: pulled().features.filter((f) => f.id === 'f4') };
    expect(restoreImportedText(one, lookupOf(builder)).report).toEqual({ restored: 1, differs: 0, missing: [] });
    builder.feats.push({ ...feat, id: 'lib:third:35', source: { ...feat.source, sourceId: 'third' } });
    expect(restoreImportedText(one, lookupOf(builder)).report.missing).toHaveLength(1);
  });

  it('lists what it could not restore and keeps the placeholder', () => {
    const c = pulled();
    const { character, report } = restoreImportedText(c, lookupOf(GLOAMWOOD_SRD_SUBSET));
    expect(character).toBe(c);
    expect(report.restored).toBe(0);
    expect(report.missing).toEqual([
      { book: GLOAMWOOD_TITLE, entryName: 'Ember Warden', part: 'Ember Ward' },
      { book: GLOAMWOOD_TITLE, entryName: 'Mothkin', part: 'Dusk Sight' },
      { book: GLOAMWOOD_TITLE, entryName: 'Mothkin', part: 'Ashwing' },
      { book: GLOAMWOOD_TITLE, entryName: "Moth's Grace" },
      { book: GLOAMWOOD_TITLE, entryName: 'Ferry Hand', part: "Ferryman's Right" },
    ]);
  });

  it('never overwrites text the player or DM wrote, and leaves SRD features alone', () => {
    const base = sampleCharacter();
    const written: Feature = { ...copied[0], description: 'My own notes on Ember Ward.' };
    const c = { ...base, features: [...base.features, written] };
    const { character, report } = restoreImportedText(c, lookupOf(EXPECTED_MERGED));
    expect(character).toBe(c);
    expect(report).toEqual({ restored: 0, differs: 0, missing: [] });
    // An empty description with copied text comes back too.
    const empty = { ...base, features: [{ ...copied[1], description: '' }] };
    expect(restoreImportedText(empty, lookupOf(EXPECTED_MERGED)).character.features[0].description).toBe(duskSight.description);
  });
});
